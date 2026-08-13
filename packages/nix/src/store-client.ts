import { accessSync, constants, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { geteuid } from 'node:process';

import {
	type StoreDirectory,
	storeDirectorySchema
} from '@cupboard/nix-store/scalars';

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
	isEnabledSettingValue,
	listOf,
	type NixConfigEnvironment,
	type NixDaemonOverrides,
	type NixDaemonSetOptions,
	type NixFileTransferSettings,
	type NixStoreConfig,
	type NixSubstitutionSettings
} from './store-config.ts';
import { openSubstituters, SubstituterClient } from './substituter.ts';

/** Probes Nix uses to resolve an `auto` store, injected so selection is testable. */
export interface StoreClientEnvironment extends NixConfigEnvironment {
	/** Whether the state directory is readable and writable by this process. */
	canWriteStateDirectory(stateDirectory: string): boolean;
	socketExists(socketPath: string): boolean;
	directoryExists(directoryPath: string): boolean;
	/** Whether this process runs as the superuser, which owns `/nix`. */
	isSuperuser(): boolean;
	/** Creates the directory and every parent of it, reporting whether it now exists. */
	createDirectory(directoryPath: string): boolean;
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
	socketExists: (socketPath) => existsSync(socketPath),
	directoryExists: (directoryPath) => existsSync(directoryPath),
	isSuperuser: () => geteuid?.() === 0,
	createDirectory: (directoryPath) => {
		try {
			mkdirSync(directoryPath, { recursive: true });

			return true;
		} catch {
			return false;
		}
	}
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
		config,
		substituterClientOver(
			config.storeDirectory,
			config.substitution,
			config.fileTransfer
		)
	);
}

/**
 * The store client a resolved backend opens, asking `substituters` whatever it
 * answers for itself about what is available elsewhere.
 */
export function storeClientForBackend(
	backend: StoreBackend,
	config: NixStoreConfig,
	substituters: SubstituterClient
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

	return localStoreOver(
		backend.stateDirectory,
		backend.storeDirectory,
		substituters,
		config.substitution
	);
}

/**
 * The client that asks a store's substituters what they hold, opening them
 * when it is first asked something. Every answer is read from the substituter
 * itself, narinfo and all, so an offer it reports names the NAR hash and the
 * signatures a consumer would check.
 *
 * The caller's signal reaches every request the client makes, so abandoning
 * the work abandons all of it.
 */
export function substituterClientOver(
	storeDirectory: StoreDirectory,
	substitution: NixSubstitutionSettings,
	transfer: NixFileTransferSettings,
	signal?: AbortSignal
): SubstituterClient {
	const reach = {
		storeDirectory,
		transfer,
		...(signal !== undefined && { signal })
	};

	return new SubstituterClient(
		() => openSubstituters(substitution.substituters, reach),
		{
			...reach,
			substitute: substitution.substitute,
			fallback: substitution.fallback
		}
	);
}

/** A local store reading the given directories, asking the given substituters. */
function localStoreOver(
	stateDirectory: string,
	storeDirectory: StoreDirectory,
	substituters: SubstituterClient,
	substitution: NixSubstitutionSettings,
	signal?: AbortSignal
): NixLocalStoreClient {
	return new NixLocalStoreClient(() => openLocalStoreDatabase(stateDirectory), {
		...(signal !== undefined && { signal }),
		storeDirectory,
		substituters,
		substitution: {
			substitute: substitution.substitute,
			alwaysAllowSubstitutes: substitution.alwaysAllowSubstitutes
		}
	});
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
	/** Abandons the work this client is doing, raising the signal's reason. */
	readonly signal?: AbortSignal;
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

/** A store opened to answer what is available elsewhere. */
export interface AvailabilityStore {
	readonly client: NixStoreClient;
	readonly kind: NixStoreKind;
	/**
	 * The substituters the settings this store was opened with name, asked
	 * directly whatever backend the store itself reads through.
	 */
	readonly substituters: SubstituterClient;
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
 * The substituters come back alongside the store, opened over the settings the
 * overrides settle, so a caller needing a full offer (its NAR hash and its
 * signatures) asks them itself.
 *
 * An `ssh-ng` store names a remote daemon, which answers for the remote store.
 * A store URI naming a daemon that is not running is refused with
 * {@link NixDaemonUnavailableError}.
 */
export function createAvailabilityStoreClient(
	dependencies: StoreClientEnvironment = defaultStoreClientEnvironment,
	config: NixStoreConfig = discoverNixStoreConfig(dependencies),
	options: NixDaemonClientOptions = {}
): AvailabilityStore {
	const storeUri = options.storeUri ?? config.storeUri;
	const substitution = overriddenSubstitution(config.substitution, {
		...config.daemonOverrides,
		...options.overrides
	});
	const substituters = substituterClientOver(
		config.storeDirectory,
		substitution,
		config.fileTransfer,
		options.signal
	);
	const sshRemote = parseSshNgStoreUri(storeUri);

	if (sshRemote !== undefined) {
		return {
			client: createNixDaemonStoreClient(dependencies, config, options),
			kind: 'ssh-ng',
			substituters
		};
	}

	const socketPath = configuredDaemonSocketPath(config, storeUri);

	if (dependencies.socketExists(socketPath)) {
		return {
			client: createNixDaemonStoreClient(dependencies, config, options),
			kind: 'daemon',
			substituters
		};
	}

	// A store URI naming the daemon asked for that daemon, so a missing socket
	// is the answer to the caller's question.
	if (isDaemonStoreUri(storeUri)) {
		throw new NixDaemonUnavailableError(socketPath);
	}

	return {
		client: localStoreOver(
			config.stateDirectory,
			config.storeDirectory,
			substituters,
			substitution,
			options.signal
		),
		kind: 'local-filesystem',
		substituters
	};
}

/**
 * The substitution settings an override settles, over the ones discovery
 * found. A daemon takes these from the frame its client sends it, and here the
 * client is the store, so the same overrides settle the same settings: a plain
 * `substituters` assignment replaces the discovered list, an
 * `extra-substituters` one appends to whatever it holds, and each boolean is
 * read the one way the configuration layer reads it.
 */
export function overriddenSubstitution(
	discovered: NixSubstitutionSettings,
	overrides: NixDaemonOverrides
): NixSubstitutionSettings {
	const assigned = overrides.substituters;
	const appended = overrides['extra-substituters'];

	return {
		substitute: isSettingEnabled(
			overrides,
			'substitute',
			discovered.substitute
		),
		alwaysAllowSubstitutes: isSettingEnabled(
			overrides,
			'always-allow-substitutes',
			discovered.alwaysAllowSubstitutes
		),
		fallback: isSettingEnabled(overrides, 'fallback', discovered.fallback),
		substituters: [
			...new Set([
				...(assigned === undefined
					? discovered.substituters
					: listOf(assigned)),
				...(appended === undefined ? [] : listOf(appended))
			])
		]
	};
}

// A setting an override names is read the way the configuration layer reads
// it; one it leaves alone keeps the value discovery settled.
function isSettingEnabled(
	overrides: NixDaemonOverrides,
	name: string,
	isEnabledByDefault: boolean
): boolean {
	const value = overrides[name];

	return value === undefined
		? isEnabledByDefault
		: isEnabledSettingValue(name, value);
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

export function resolveStoreBackend(
	config: NixStoreConfig,
	environment: StoreClientEnvironment
): StoreBackend {
	const uri = config.storeUri;

	if (uri === 'daemon') {
		return { backend: 'daemon', socketPath: config.daemonSocketPath };
	}

	if (uri === 'local') {
		return {
			backend: 'local',
			stateDirectory: config.stateDirectory,
			storeDirectory: config.storeDirectory
		};
	}

	// Nix reads an empty store reference as the automatic store, the same as
	// `auto`: a `store =` line naming nothing names no store in particular.
	if (uri === 'auto' || uri === '') {
		return resolveAuto(config, environment);
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

// The `auto` store: the local store when this process can read and write the
// state directory, else the daemon when its socket is present, else a chroot
// store where one is called for, else the local store as configured.
function resolveAuto(
	config: NixStoreConfig,
	environment: StoreClientEnvironment
): StoreBackend {
	const configured: StoreBackend = {
		backend: 'local',
		stateDirectory: config.stateDirectory,
		storeDirectory: config.storeDirectory
	};

	if (environment.canWriteStateDirectory(config.stateDirectory)) {
		return configured;
	}

	if (environment.socketExists(config.daemonSocketPath)) {
		return { backend: 'daemon', socketPath: config.daemonSocketPath };
	}

	return chrootStore(config, environment) ?? configured;
}

/**
 * The store Nix sets up for a Linux machine with no `/nix` and no daemon: a
 * store of this user's own under the data directory. Nix offers it only when
 * nothing else could have been meant, so an ordinary user who has never
 * installed Nix gets a working store while an install that names its
 * directories keeps them.
 *
 * Absent on any other platform, and absent whenever the state directory
 * exists, this process is the superuser, or the environment names a store or
 * state directory of its own.
 */
function chrootStore(
	config: NixStoreConfig,
	environment: StoreClientEnvironment
): StoreBackend | undefined {
	if (
		!isLinuxMachine(environment) ||
		environment.directoryExists(config.stateDirectory) ||
		environment.isSuperuser() ||
		environment.env.NIX_STORE_DIR !== undefined ||
		environment.env.NIX_STATE_DIR !== undefined
	) {
		return;
	}

	const root = chrootStoreRoot(environment);

	if (root === undefined || !environment.createDirectory(root)) {
		return;
	}

	return {
		backend: 'local',
		stateDirectory: path.join(root, 'nix', 'var', 'nix'),
		storeDirectory: storeDirectorySchema.parse(path.join(root, 'nix', 'store'))
	};
}

// Nix compiles the chroot fallback in for Linux alone, so the kernel this
// machine reports is what decides whether it applies.
function isLinuxMachine(environment: StoreClientEnvironment): boolean {
	return environment.currentSystem()?.endsWith('-linux') === true;
}

// Nix roots the chroot store at `root` under its data directory, which
// `NIX_DATA_HOME` names outright and `XDG_DATA_HOME` names `nix` under.
function chrootStoreRoot(
	environment: StoreClientEnvironment
): string | undefined {
	const named = environment.env.NIX_DATA_HOME;

	if (named !== undefined) {
		return path.join(named, 'root');
	}

	const dataHome =
		environment.env.XDG_DATA_HOME ?? defaultDataHome(environment);

	return dataHome === undefined
		? undefined
		: path.join(dataHome, 'nix', 'root');
}

function defaultDataHome(
	environment: StoreClientEnvironment
): string | undefined {
	const home = environment.homeDirectory();

	return home === undefined ? undefined : path.join(home, '.local', 'share');
}

function unixSocketPath(uri: string): string | undefined {
	const [socket] = uri.slice(unixScheme.length).split('?', 1);

	return socket === undefined || socket === '' ? undefined : socket;
}
