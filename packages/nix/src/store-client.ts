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
Probes Nix uses to resolve an `auto` store, injected so selection is testable.
*/
export interface StoreClientEnvironment extends NixConfigEnvironment {
	/**
	Whether the state directory is readable and writable by this process.
	*/
	canWriteStateDirectory(stateDirectory: string): boolean;
	socketExists(socketPath: string): boolean;
	directoryExists(directoryPath: string): boolean;
	/**
	Whether this process runs as the superuser, which owns `/nix`.
	*/
	isSuperuser(): boolean;
	/**
	Creates the directory and every parent of it, reporting whether it now exists.
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
 * The kind of store used by a resolved backend. Callers branch on this
 * discriminant, for example to decide where NAR bytes come from. A
 * `local-filesystem` store and a `daemon` store serve paths on this machine's
 * filesystem; an `ssh-ng` store's paths live on the remote machine.
 */
export type NixStoreKind = 'local-filesystem' | 'daemon' | 'ssh-ng';

/**
The store kind of a resolved backend.
*/
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

/**
The logical store directory and state directory of a resolved store.
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

/**
 * Opens the resolved store client and its configured substituter queries.
 */
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
 * Creates lazy substituter queries for a store. Each result comes directly
 * from the substituter's narinfo and includes the NAR hash and signatures a
 * consumer would verify.
 *
 * A request to a private cache uses the credentials the configured netrc gives
 * for that request's host, and every request goes through whatever proxy the
 * environment's `http_proxy` and `https_proxy` variables specify.
 *
 * The caller's signal is passed to every request the client makes, so aborting
 * the signal cancels all of them.
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

/**
Opens a local store with the given directories and substituter queries.
*/
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
Per-call adjustments for an explicitly daemon-backed client.
*/
export interface NixDaemonClientOptions {
	/**
	The store URI this client opens (default: the discovered `store` setting).
	*/
	readonly storeUri?: string;
	/**
	 * Merged over the discovered SetOptions fields for a local daemon, this value
	 * winning per key. An ssh-ng store preserves its remote daemon's policy.
	 */
	readonly setOptions?: NixDaemonSetOptions;
	/**
	 * Merged over the discovered overrides for a local daemon, this value winning
	 * per key. An ssh-ng store preserves its remote daemon's policy.
	 */
	readonly overrides?: NixDaemonOverrides;
	readonly connect?: NixDaemonConnector;
	/**
	Abandons the work this client is doing, raising the signal's reason.
	*/
	readonly signal?: AbortSignal;
}

/**
 * Opens a daemon-backed store whenever its socket is present, regardless of
 * what automatic selection would pick. A daemon manages the substituter
 * configuration and makes the substituter requests itself, so a caller that
 * wants availability answered that way selects the daemon here. An install
 * with no daemon socket is refused with {@link NixDaemonUnavailableError}
 * naming the probed socket path.
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

/**
A store opened with support for external availability queries.
*/
export interface AvailabilityStore {
	readonly client: NixStoreClient;
	readonly kind: NixStoreKind;
	readonly storeDirectory: LocalStoreDirectories['storeDirectory'];
	readonly stateDirectory: LocalStoreDirectories['stateDirectory'];
	readonly realStoreDirectory?: string;
	/**
	 * Direct queries for the substituters configured when this store was opened.
	 */
	readonly substituters: SubstituterClient;
}

/**
 * A store that can report external availability: which paths the substituters
 * offer, what a substituter offers for a given path, and what realising a
 * target would require.
 *
 * Both backends support these operations. A daemon manages the substituter
 * configuration and requests for its clients. Without a daemon, this process
 * follows libstore's single-user behaviour by reading the store
 * database directly and asking the substituters over HTTP.
 *
 * The result also includes direct substituter queries configured with the
 * effective overrides. Callers use them when they need full offers containing
 * NAR hashes and signatures.
 *
 * An `ssh-ng` store uses a remote daemon to serve the remote store.
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
			stateDirectory: directories.stateDirectory,
			...(directories.realStoreDirectory !== undefined && {
				realStoreDirectory: directories.realStoreDirectory
			}),
			substituters
		};
	}

	// For an automatic store, this function opens the daemon whenever its socket
	// is present, so that substitutability and missing-path queries go through
	// the daemon's own substituter configuration. An explicitly local store URI
	// selects the local store, and this preference must not override it.
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

// Parse explicit overrides through the configuration layer and retain the
// discovered value for omitted settings.
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

// The `auto` store: the local store when this process can read and write the
// state directory, else the daemon when its socket is present, else the
// per-user chroot store when this machine qualifies for it, else the local
// store as configured.
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
 * per-user store below the data directory. Nix uses it only when no existing
 * installation or explicit store configuration applies.
 *
 * Nix does not use this store on any other platform. It also does not use it
 * when the state directory exists, when this process runs as the superuser, or
 * when the environment configures a store or state directory of its own.
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
	// paths retain their configured logical names while the root determines
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
