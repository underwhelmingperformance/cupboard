import { accessSync, constants, existsSync } from 'node:fs';

import type { StoreDirectory } from '@cupboard/nix-store/scalars';

import { type NixDaemonConnector, NixDaemonStoreClient } from './nix-daemon.ts';
import {
	createSshNixDaemonConnector,
	type NixSshStoreSpec,
	parseSshNgStoreUri
} from './nix-daemon-ssh.ts';
import {
	NixLocalStoreClient,
	openLocalStoreDatabase
} from './nix-local-store.ts';
import {
	NixDaemonUnavailableError,
	type NixStoreClient,
	UnsupportedNixStoreError
} from './nix-store.ts';
import {
	defaultNixConfigEnvironment,
	discoverNixStoreConfig,
	type NixConfigEnvironment,
	type NixDaemonOverrides,
	type NixDaemonSetOptions,
	type NixStoreConfig
} from './store-config.ts';
import { openSubstituters, SubstituterClient } from './substituter.ts';

/** Probes Nix uses to resolve an `auto` store, injected so selection is testable. */
export interface StoreClientEnvironment extends NixConfigEnvironment {
	/** Whether the state directory is readable and writable by this process. */
	canWriteStateDirectory(stateDirectory: string): boolean;
	socketExists(socketPath: string): boolean;
}

export const defaultStoreClientEnvironment: StoreClientEnvironment = {
	...defaultNixConfigEnvironment,
	canWriteStateDirectory: (stateDirectory) => {
		try {
			accessSync(stateDirectory, constants.R_OK | constants.W_OK);

			return true;
		} catch {
			return false;
		}
	},
	socketExists: (socketPath) => existsSync(socketPath)
};

export type StoreBackend =
	| { readonly backend: 'daemon'; readonly socketPath: string }
	| {
			readonly backend: 'local';
			readonly stateDirectory: string;
			readonly storeDirectory: StoreDirectory;
	  }
	| { readonly backend: 'ssh-ng'; readonly remote: NixSshStoreSpec };

/**
 * The kind of store a resolved backend reads through: the discriminant a
 * caller selects behaviour on, such as where NAR bytes come from. A
 * `local-filesystem` store and a `daemon` store serve paths on this machine's
 * filesystem; an `ssh-ng` store's paths live on the remote machine.
 */
export type NixStoreKind = 'local-filesystem' | 'daemon' | 'ssh-ng';

/** The store kind a resolved backend answers as. */
export function storeKindOf(backend: StoreBackend): NixStoreKind {
	return backend.backend === 'local' ? 'local-filesystem' : backend.backend;
}

const unixScheme = 'unix://';

/**
 * Open the Nix store the running configuration points at, the way the C++ client
 * resolves a store reference: the daemon for a `daemon`/`unix://` store, the
 * local store for `local`, and for `auto` the same choice Nix makes, preferring
 * the local store when the state directory is writable and otherwise the daemon.
 */
export function createNixStoreClient(
	dependencies: StoreClientEnvironment = defaultStoreClientEnvironment,
	config: NixStoreConfig = discoverNixStoreConfig(dependencies)
): NixStoreClient {
	return storeClientForBackend(
		resolveStoreBackend(config, dependencies),
		config
	);
}

/** The store client a resolved backend opens. */
export function storeClientForBackend(
	backend: StoreBackend,
	config: NixStoreConfig
): NixStoreClient {
	if (backend.backend === 'daemon') {
		return new NixDaemonStoreClient({
			socketPath: backend.socketPath,
			setOptions: config.daemonSetOptions,
			overrides: config.daemonOverrides
		});
	}

	if (backend.backend === 'ssh-ng') {
		return new NixDaemonStoreClient({
			connect: createSshNixDaemonConnector(backend.remote),
			setOptions: config.daemonSetOptions,
			overrides: config.daemonOverrides
		});
	}

	return new NixLocalStoreClient(
		() => openLocalStoreDatabase(backend.stateDirectory),
		{
			storeDirectory: backend.storeDirectory,
			substituters: new SubstituterClient(
				() => openSubstituters(config.substitution.substituters),
				{
					storeDirectory: backend.storeDirectory,
					substitute: config.substitution.substitute,
					fallback: config.substitution.fallback
				}
			),
			substitution: {
				substitute: config.substitution.substitute,
				alwaysAllowSubstitutes: config.substitution.alwaysAllowSubstitutes
			}
		}
	);
}

/** Per-call adjustments for an explicitly daemon-backed client. */
export interface NixDaemonClientOptions {
	/** The store URI this client opens (default: the discovered `store` setting). */
	readonly storeUri?: string;
	/** Merged over the discovered SetOptions fields, this value winning per key. */
	readonly setOptions?: NixDaemonSetOptions;
	/** Merged over the discovered overrides, this value winning per key. */
	readonly overrides?: NixDaemonOverrides;
	readonly connect?: NixDaemonConnector;
}

/**
 * Open the daemon-backed store whenever its socket is present, whatever the
 * automatic selection would pick. The substitutable and missing-path queries
 * exist only behind the daemon, so a caller that needs them selects the daemon
 * here; an install with no daemon socket is refused with
 * {@link NixDaemonUnavailableError} naming the probed socket path.
 */
export function createNixDaemonStoreClient(
	dependencies: StoreClientEnvironment = defaultStoreClientEnvironment,
	config: NixStoreConfig = discoverNixStoreConfig(dependencies),
	options: NixDaemonClientOptions = {}
): NixDaemonStoreClient {
	const storeUri = options.storeUri ?? config.storeUri;
	// An `ssh-ng` store reaches its daemon over ssh: there is no local socket
	// to probe, and the remote daemon exists whenever ssh can start it.
	const sshRemote = parseSshNgStoreUri(storeUri);

	if (sshRemote !== undefined) {
		return new NixDaemonStoreClient({
			connect: options.connect ?? createSshNixDaemonConnector(sshRemote),
			setOptions: { ...config.daemonSetOptions, ...options.setOptions },
			overrides: { ...config.daemonOverrides, ...options.overrides }
		});
	}

	const socketPath = configuredDaemonSocketPath(config, storeUri);

	if (!dependencies.socketExists(socketPath)) {
		throw new NixDaemonUnavailableError(socketPath);
	}

	return new NixDaemonStoreClient({
		socketPath,
		connect: options.connect,
		setOptions: { ...config.daemonSetOptions, ...options.setOptions },
		overrides: { ...config.daemonOverrides, ...options.overrides }
	});
}

/**
 * A store that can answer what is available elsewhere: which paths the
 * substituters offer, what they offer for one, and what realising a target
 * would require.
 *
 * Both backends answer. A daemon holds the substituter configuration and makes
 * those requests for its clients, so it answers whenever its socket is there.
 * Without one the store is this process's own, and the questions are answered
 * the way libstore answers them in a single-user install: reading the store
 * database directly and asking the substituters over HTTP.
 *
 * An `ssh-ng` store names a remote daemon, which answers for the remote store.
 * A store URI naming a daemon that is not running is refused with
 * {@link NixDaemonUnavailableError}.
 */
export function createAvailabilityStoreClient(
	dependencies: StoreClientEnvironment = defaultStoreClientEnvironment,
	config: NixStoreConfig = discoverNixStoreConfig(dependencies),
	options: NixDaemonClientOptions = {}
): { readonly client: NixStoreClient; readonly kind: NixStoreKind } {
	const storeUri = options.storeUri ?? config.storeUri;
	const sshRemote = parseSshNgStoreUri(storeUri);

	if (sshRemote !== undefined) {
		return {
			client: createNixDaemonStoreClient(dependencies, config, options),
			kind: 'ssh-ng'
		};
	}

	const socketPath = configuredDaemonSocketPath(config, storeUri);

	if (dependencies.socketExists(socketPath)) {
		return {
			client: createNixDaemonStoreClient(dependencies, config, options),
			kind: 'daemon'
		};
	}

	// A store URI naming the daemon asked for that daemon, so a missing socket
	// is the answer to the caller's question.
	if (isDaemonStoreUri(storeUri)) {
		throw new NixDaemonUnavailableError(socketPath);
	}

	const overrides = { ...config.daemonOverrides, ...options.overrides };
	const substitution = {
		...config.substitution,
		...overriddenSubstitution(config, overrides)
	};

	return {
		client: new NixLocalStoreClient(
			() => openLocalStoreDatabase(config.stateDirectory),
			{
				storeDirectory: config.storeDirectory,
				substituters: new SubstituterClient(
					() => openSubstituters(substitution.substituters),
					{
						storeDirectory: config.storeDirectory,
						substitute: substitution.substitute,
						fallback: substitution.fallback
					}
				),
				substitution: {
					substitute: substitution.substitute,
					alwaysAllowSubstitutes: substitution.alwaysAllowSubstitutes
				}
			}
		),
		kind: 'local-filesystem'
	};
}

// A daemon takes its substituter list from the settings a client sends it. The
// list is this client's own, so the same overrides select which substituters
// it opens.
function overriddenSubstitution(
	config: NixStoreConfig,
	overrides: NixDaemonOverrides
): { readonly substitute: boolean; readonly substituters: readonly string[] } {
	const assigned = overrides.substituters;
	const appended = overrides['extra-substituters'];
	const base =
		assigned === undefined
			? config.substitution.substituters
			: listOf(assigned);
	const substitute = overrides.substitute;

	return {
		substitute:
			substitute === undefined
				? config.substitution.substitute
				: substitute !== 'false',
		substituters: [
			...new Set([...base, ...(appended === undefined ? [] : listOf(appended))])
		]
	};
}

function listOf(value: string): readonly string[] {
	return value.split(/\s+/u).filter(Boolean);
}

const daemonStoreUris = new Set(['daemon', 'unix://']);

function isDaemonStoreUri(storeUri: string): boolean {
	return daemonStoreUris.has(storeUri) || storeUri.startsWith(unixScheme);
}

// A `unix://` store URI names the daemon socket directly; every other
// configuration reaches the daemon through the state directory's socket.
function configuredDaemonSocketPath(
	config: NixStoreConfig,
	storeUri: string
): string {
	if (storeUri.startsWith(unixScheme)) {
		return unixSocketPath(storeUri) ?? config.daemonSocketPath;
	}

	return config.daemonSocketPath;
}

interface StoreBackendProbes {
	canWriteStateDirectory(stateDirectory: string): boolean;
	socketExists(socketPath: string): boolean;
}

export function resolveStoreBackend(
	config: NixStoreConfig,
	probes: StoreBackendProbes
): StoreBackend {
	const uri = config.storeUri;

	if (uri === 'daemon') {
		return { backend: 'daemon', socketPath: config.daemonSocketPath };
	}

	if (uri === 'local' || uri === '') {
		return {
			backend: 'local',
			stateDirectory: config.stateDirectory,
			storeDirectory: config.storeDirectory
		};
	}

	if (uri === 'auto') {
		return resolveAuto(config, probes);
	}

	if (uri.startsWith(unixScheme)) {
		return {
			backend: 'daemon',
			socketPath: unixSocketPath(uri) ?? config.daemonSocketPath
		};
	}

	const sshRemote = parseSshNgStoreUri(uri);

	if (sshRemote !== undefined) {
		return { backend: 'ssh-ng', remote: sshRemote };
	}

	throw new UnsupportedNixStoreError(uri);
}

// Nix's `auto`: use the local store when this process can read and write the
// state directory, else the daemon when its socket is present, else fall back to
// the local store.
function resolveAuto(
	config: NixStoreConfig,
	probes: StoreBackendProbes
): StoreBackend {
	if (probes.canWriteStateDirectory(config.stateDirectory)) {
		return {
			backend: 'local',
			stateDirectory: config.stateDirectory,
			storeDirectory: config.storeDirectory
		};
	}

	if (probes.socketExists(config.daemonSocketPath)) {
		return { backend: 'daemon', socketPath: config.daemonSocketPath };
	}

	return {
		backend: 'local',
		stateDirectory: config.stateDirectory,
		storeDirectory: config.storeDirectory
	};
}

function unixSocketPath(uri: string): string | undefined {
	const [socket] = uri.slice(unixScheme.length).split('?', 1);

	return socket === undefined || socket === '' ? undefined : socket;
}
