import { accessSync, constants, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { geteuid } from 'node:process';

import {
	type ConfiguredStoreDirectories,
	type LocalStoreDirectories,
	localStoreOfUri
} from './local-store-uri.ts';
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
import { proxiedFetch } from './proxy.ts';
import { canonicalStoreReference } from './setting-types.ts';
import {
	defaultNixConfigEnvironment,
	discoverNixStoreConfig,
	EffectiveList,
	isEnabledSettingValue,
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
	| ({ readonly backend: 'local' } & LocalStoreDirectories)
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
	const backend = resolveStoreBackend(config, dependencies);
	const directories = storeDirectoriesOf(backend, config);

	return storeClientForBackend(
		backend,
		config,
		substituterClientOver(
			directories,
			config.substitution,
			config.fileTransfer,
			dependencies
		)
	);
}

/** The named and state directories a resolved store reads with. */
export function storeDirectoriesOf(
	backend: StoreBackend,
	configured: ConfiguredStoreDirectories
): ConfiguredStoreDirectories {
	if (backend.backend === 'local') {
		return backend;
	}

	if (
		backend.backend !== 'ssh-ng' ||
		backend.remote.remoteStore === undefined
	) {
		return configured;
	}

	return localStoreOfUri(backend.remote.remoteStore, configured) ?? configured;
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

	return localStoreOver(backend, substituters, config.substitution);
}

/**
 * The client that asks a store's substituters what they hold, opening them
 * when it is first asked something. Every answer is read from the substituter
 * itself, narinfo and all, so an offer it reports names the NAR hash and the
 * signatures a consumer would check.
 *
 * A private cache is asked with the credentials the configured netrc names for
 * its host, and every request takes whatever route the environment's proxy
 * variables put it on.
 *
 * The caller's signal reaches every request the client makes, so abandoning
 * the work abandons all of it.
 */
export function substituterClientOver(
	directories: ConfiguredStoreDirectories,
	substitution: NixSubstitutionSettings,
	transfer: NixFileTransferSettings,
	dependencies: NixConfigEnvironment,
	signal?: AbortSignal
): SubstituterClient {
	const netrc = netrcContents(transfer.netrcFile, dependencies);
	const proxied = proxiedFetch(dependencies.env);
	const reach = {
		storeDirectory: directories.storeDirectory,
		stateDirectory: directories.stateDirectory,
		openStore: openLocalStoreDatabase,
		transfer,
		...(signal !== undefined && { signal }),
		...(netrc !== undefined && { netrc }),
		...(proxied !== undefined && { fetch: proxied })
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

/**
 * The netrc the configuration names, or nothing when no file answers for it.
 * libcurl reads the file when it opens and carries on as though netrc support
 * were off when it cannot, so a path naming no file, and one this process may
 * not read, both leave a request carrying no credentials.
 */
function netrcContents(
	netrcFile: string,
	dependencies: NixConfigEnvironment
): string | undefined {
	try {
		return dependencies.readFile(netrcFile);
	} catch {
		return undefined;
	}
}

/** A local store reading the given directories, asking the given substituters. */
function localStoreOver(
	directories: LocalStoreDirectories,
	substituters: SubstituterClient,
	substitution: NixSubstitutionSettings,
	signal?: AbortSignal
): NixLocalStoreClient {
	const { realStoreDirectory } = directories;

	return new NixLocalStoreClient(
		() => openLocalStoreDatabase(directories.stateDirectory),
		{
			...(signal !== undefined && { signal }),
			...(realStoreDirectory !== undefined && { realStoreDirectory }),
			storeDirectory: directories.storeDirectory,
			substituters,
			substitution: {
				substitute: substitution.substitute,
				alwaysAllowSubstitutes: substitution.alwaysAllowSubstitutes
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
			overrides: { ...config.daemonOverrides, ...options.overrides },
			signal: options.signal
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
		overrides: { ...config.daemonOverrides, ...options.overrides },
		signal: options.signal
	});
}

/** A store opened to answer what is available elsewhere. */
export interface AvailabilityStore {
	readonly client: NixStoreClient;
	readonly kind: NixStoreKind;
	readonly storeDirectory: ConfiguredStoreDirectories['storeDirectory'];
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
 * {@link NixDaemonUnavailableError}. A store URI this client cannot read is
 * refused with {@link UnsupportedNixStoreError}.
 */
export function createAvailabilityStoreClient(
	dependencies: StoreClientEnvironment = defaultStoreClientEnvironment,
	config: NixStoreConfig = discoverNixStoreConfig(dependencies),
	options: NixDaemonClientOptions = {}
): AvailabilityStore {
	const storeUri = canonicalStoreReference(
		options.storeUri ?? config.storeUri,
		dependencies.workingDirectory()
	);
	const substitution = overriddenSubstitution(config.substitution, {
		...config.daemonOverrides,
		...options.overrides
	});
	const backend = resolveStoreBackend({ ...config, storeUri }, dependencies);
	const directories = storeDirectoriesOf(backend, config);
	const substituters = substituterClientOver(
		directories,
		substitution,
		config.fileTransfer,
		dependencies,
		options.signal
	);

	if (backend.backend === 'ssh-ng') {
		return {
			client: createNixDaemonStoreClient(dependencies, config, options),
			kind: 'ssh-ng',
			storeDirectory: directories.storeDirectory,
			substituters
		};
	}

	// Availability opens the daemon for an automatic store whenever it is
	// present, because the daemon can answer substitutability and missing-path
	// queries that the local reader cannot. An explicitly local URI still names
	// the local store and must not be replaced by this availability preference.
	if (
		backend.backend === 'local' &&
		(storeUri === 'auto' || storeUri === '') &&
		dependencies.socketExists(config.daemonSocketPath)
	) {
		return {
			client: createNixDaemonStoreClient(dependencies, config, options),
			kind: 'daemon',
			storeDirectory: directories.storeDirectory,
			substituters
		};
	}

	if (backend.backend === 'daemon') {
		const { socketPath } = backend;

		if (!dependencies.socketExists(socketPath)) {
			throw new NixDaemonUnavailableError(socketPath);
		}

		return {
			client: createNixDaemonStoreClient(dependencies, config, options),
			kind: 'daemon',
			storeDirectory: directories.storeDirectory,
			substituters
		};
	}

	return {
		client: localStoreOver(backend, substituters, substitution, options.signal),
		kind: 'local-filesystem',
		storeDirectory: directories.storeDirectory,
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
	const substituters = new EffectiveList();

	if (assigned !== undefined) {
		substituters.assign(assigned);
	}

	if (appended !== undefined) {
		substituters.append(appended);
	}

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
		substituters: substituters.resolve(discovered.substituters)
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

	const local = localStoreOfUri(uri, config);

	if (local !== undefined) {
		return { backend: 'local', ...local };
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

	// Nix reaches this store the way it reaches any store under a root: the
	// paths keep the names the configuration gives them, and the root is where
	// they sit.
	return {
		backend: 'local',
		stateDirectory: path.join(root, 'nix', 'var', 'nix'),
		storeDirectory: config.storeDirectory,
		realStoreDirectory: path.join(root, 'nix', 'store')
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
