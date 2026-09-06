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

/**
 * Supplies the runtime probes used to resolve an `auto` store.
 */
export interface StoreClientEnvironment extends NixConfigEnvironment {
	/**
	 * Checks whether this process can both read and write the state directory.
	 */
	canWriteStateDirectory(stateDirectory: string): boolean;
	socketExists(socketPath: string): boolean;
	directoryExists(directoryPath: string): boolean;
	isSuperuser(): boolean;
	/**
	 * Creates the directory and any missing parents. Returns false if recursive
	 * creation fails.
	 */
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
 * Identifies where store contents live. Callers use this discriminant to choose
 * the source of NAR bytes. A `local-filesystem` store and a `daemon` store use
 * this machine's filesystem; an `ssh-ng` store uses the remote machine.
 */
export type NixStoreKind = 'local-filesystem' | 'daemon' | 'ssh-ng';

export function storeKindOf(backend: StoreBackend): NixStoreKind {
	return backend.backend === 'local' ? 'local-filesystem' : backend.backend;
}

const unixScheme = 'unix://';

/**
 * Creates a client for the store selected by the running configuration. A
 * `daemon` or `unix://` reference uses the local daemon, `local` uses the local
 * store, and `ssh-ng` uses the remote daemon. For `auto`, Nix first uses the
 * local store when its state directory is readable and writable, then a present
 * daemon socket, then an eligible per-user store on Linux, and otherwise the
 * configured local store.
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

/**
 * Resolves the directories used by a backend. A local backend provides its own
 * directories. An `ssh-ng` `remote-store` reference can override the configured
 * directories; other daemon backends use the configured values.
 */
export function storeDirectoriesOf(
	backend: StoreBackend,
	configured: ConfiguredStoreDirectories
): LocalStoreDirectories {
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

export function storeClientForBackend(
	backend: StoreBackend,
	config: NixStoreConfig,
	substituters: SubstituterClient
): NixStoreClient {
	const { storeDirectory } = storeDirectoriesOf(backend, config);

	if (backend.backend === 'daemon') {
		return new NixDaemonStoreClient({
			socketPath: backend.socketPath,
			storeDirectory,
			setOptions: config.daemonSetOptions,
			overrides: config.daemonOverrides
		});
	}

	if (backend.backend === 'ssh-ng') {
		return new NixDaemonStoreClient({
			connect: createSshNixDaemonConnector(backend.remote),
			storeDirectory,
			maxConnectionAge: backend.remote.maxConnectionAge,
			maxConnections: backend.remote.maxConnections ?? 1,
			shouldPreserveDaemonOptions: true
		});
	}

	return localStoreOver(backend, substituters, config.substitution);
}

/**
 * Creates lazy queries that read narinfos directly from the configured
 * substituters. Each offer includes the NAR hash and signatures needed for
 * consumer policy checks.
 *
 * Requests to private caches use credentials from the configured netrc entry for
 * each host. Every request uses the proxy selected by the environment's
 * `http_proxy` and `https_proxy` variables.
 *
 * Every request receives the caller's signal, so aborting it cancels all
 * outstanding substituter work.
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
 * Reads the configured netrc, or returns `undefined` when the file is absent or
 * unreadable. libcurl treats either case as disabled netrc support, so requests
 * proceed without credentials.
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

/**
 * Controls a daemon-backed store opened for one operation.
 */
export interface NixDaemonClientOptions {
	/**
	 * Selects the store. Defaults to the discovered `store` setting.
	 */
	readonly storeUri?: string;
	/**
	 * Overrides discovered SetOptions fields for a local daemon. The caller wins
	 * per key. An ssh-ng store preserves its remote daemon's policy.
	 */
	readonly setOptions?: NixDaemonSetOptions;
	/**
	 * Overrides discovered daemon settings for a local daemon. The caller wins per
	 * key. An ssh-ng store preserves its remote daemon's policy.
	 */
	readonly overrides?: NixDaemonOverrides;
	readonly connect?: NixDaemonConnector;
	/**
	 * Aborts the client's work with the signal's reason.
	 */
	readonly signal?: AbortSignal;
}

/**
 * Creates a daemon-backed client instead of applying automatic local-store
 * selection. A local daemon must have the configured or `unix://` socket, and
 * per-call settings override discovered daemon settings by key. An `ssh-ng`
 * store opens its remote daemon over SSH and preserves that daemon's policy.
 * A missing local socket throws {@link NixDaemonUnavailableError} with the path
 * that was probed.
 */
export function createNixDaemonStoreClient(
	dependencies: StoreClientEnvironment = defaultStoreClientEnvironment,
	config: NixStoreConfig = discoverNixStoreConfig(dependencies),
	options: NixDaemonClientOptions = {}
): NixDaemonStoreClient {
	const storeUri = options.storeUri ?? config.storeUri;
	// An `ssh-ng` store has no local socket to probe. SSH starts the remote daemon,
	// and any failure to do so is reported when the client connects.
	const sshRemote = parseSshNgStoreUri(storeUri);

	if (sshRemote !== undefined) {
		const { storeDirectory } = storeDirectoriesOf(
			{ backend: 'ssh-ng', remote: sshRemote },
			config
		);

		return new NixDaemonStoreClient({
			connect: options.connect ?? createSshNixDaemonConnector(sshRemote),
			storeDirectory,
			maxConnectionAge: sshRemote.maxConnectionAge,
			maxConnections: sshRemote.maxConnections ?? 1,
			shouldPreserveDaemonOptions: true,
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
		storeDirectory: config.storeDirectory,
		setOptions: { ...config.daemonSetOptions, ...options.setOptions },
		overrides: { ...config.daemonOverrides, ...options.overrides },
		signal: options.signal
	});
}

export interface AvailabilityStore {
	readonly client: NixStoreClient;
	readonly kind: NixStoreKind;
	readonly storeDirectory: LocalStoreDirectories['storeDirectory'];
	readonly stateDirectory: LocalStoreDirectories['stateDirectory'];
	readonly realStoreDirectory?: string;
	/**
	 * Queries the configured substituters directly, independently of the selected
	 * backend, and returns complete narinfo evidence.
	 */
	readonly substituters: SubstituterClient;
}

/**
 * Creates a store for external-availability queries. A path-shaped per-call
 * store reference is resolved against the process working directory before
 * backend selection.
 *
 * For `auto`, a present daemon socket wins even when ordinary selection could
 * read the local store. This lets substitutability and missing-path queries use
 * the daemon's own substituter configuration. An explicit local store remains
 * local, and an `ssh-ng` store uses its remote daemon.
 *
 * The result also provides direct substituter queries with effective overrides
 * for callers that need NAR hashes and signatures. A local backend reads path
 * metadata from the store database and queries substituters from this process.
 *
 * A selected local daemon without a socket throws
 * {@link NixDaemonUnavailableError}. An unsupported store throws
 * {@link UnsupportedNixStoreError}.
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
			stateDirectory: directories.stateDirectory,
			...(directories.realStoreDirectory !== undefined && {
				realStoreDirectory: directories.realStoreDirectory
			}),
			substituters
		};
	}

	if (
		backend.backend === 'local' &&
		(storeUri === 'auto' || storeUri === '') &&
		dependencies.socketExists(config.daemonSocketPath)
	) {
		return {
			client: createNixDaemonStoreClient(dependencies, config, options),
			kind: 'daemon',
			storeDirectory: directories.storeDirectory,
			stateDirectory: directories.stateDirectory,
			...(directories.realStoreDirectory !== undefined && {
				realStoreDirectory: directories.realStoreDirectory
			}),
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
			stateDirectory: directories.stateDirectory,
			...(directories.realStoreDirectory !== undefined && {
				realStoreDirectory: directories.realStoreDirectory
			}),
			substituters
		};
	}

	return {
		client: localStoreOver(backend, substituters, substitution, options.signal),
		kind: 'local-filesystem',
		storeDirectory: directories.storeDirectory,
		stateDirectory: directories.stateDirectory,
		...(directories.realStoreDirectory !== undefined && {
			realStoreDirectory: directories.realStoreDirectory
		}),
		substituters
	};
}

/**
 * Applies substitution overrides to the discovered settings. A daemon reads
 * these values from its client's SetOptions frame. A plain `substituters`
 * assignment replaces the discovered list; an `extra-substituters` assignment
 * appends to it. The configuration layer parses each boolean consistently.
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

// Take the daemon socket path directly from a `unix://` store URI. Every other
// configuration uses the socket below the state directory.
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
	// `auto`: an empty `store =` assignment does not select a specific store.
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

// Resolve `auto` in Nix's order. Use the local store when the state directory is
// readable and writable. Otherwise use a present daemon, then an eligible
// per-user store on Linux, and finally the configured local store.
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
 * Creates Nix's per-user fallback below the data directory on Linux. It applies
 * only when no existing installation or explicit store configuration does.
 *
 * Other platforms, an existing state directory, the superuser, and explicit
 * store or state directories all keep the configured local store. Failure to
 * create the fallback root does the same.
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

	// A rooted store preserves the configured logical paths. The root changes only
	// their physical location.
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

// Nix roots the chroot store at `root` inside its data directory.
// `NIX_DATA_HOME` gives that directory directly; under `XDG_DATA_HOME` the data
// directory is `nix` inside it.
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
