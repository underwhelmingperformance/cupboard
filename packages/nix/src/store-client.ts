import { accessSync, constants, existsSync } from 'node:fs';

import { type NixDaemonConnector, NixDaemonStoreClient } from './nix-daemon.ts';
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
	| { readonly backend: 'local'; readonly stateDirectory: string };

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
	const backend = resolveStoreBackend(config, dependencies);

	if (backend.backend === 'daemon') {
		return new NixDaemonStoreClient({
			socketPath: backend.socketPath,
			setOptions: config.daemonSetOptions,
			overrides: config.daemonOverrides
		});
	}

	return new NixLocalStoreClient(() =>
		openLocalStoreDatabase(backend.stateDirectory)
	);
}

/** Per-call adjustments for an explicitly daemon-backed client. */
export interface NixDaemonClientOptions {
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
	const socketPath = configuredDaemonSocketPath(config);

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

// A `unix://` store URI names the daemon socket directly; every other
// configuration reaches the daemon through the state directory's socket.
function configuredDaemonSocketPath(config: NixStoreConfig): string {
	if (config.storeUri.startsWith(unixScheme)) {
		return unixSocketPath(config.storeUri) ?? config.daemonSocketPath;
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
		return { backend: 'local', stateDirectory: config.stateDirectory };
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
		return { backend: 'local', stateDirectory: config.stateDirectory };
	}

	if (probes.socketExists(config.daemonSocketPath)) {
		return { backend: 'daemon', socketPath: config.daemonSocketPath };
	}

	return { backend: 'local', stateDirectory: config.stateDirectory };
}

function unixSocketPath(uri: string): string | undefined {
	const [socket] = uri.slice(unixScheme.length).split('?', 1);

	return socket === undefined || socket === '' ? undefined : socket;
}
