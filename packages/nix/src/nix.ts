import { realpathSync } from 'node:fs';
import pathModule from 'node:path';

import {
	Derivation,
	type DerivationBuildRequirements
} from '@cupboard/nix-store/derivation';
import {
	type StoreDirectory,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';

import { type NixDaemonSession, NixDaemonStoreClient } from './nix-daemon.ts';
import {
	type NixBuildResult,
	type NixDaemonTrust,
	type NixDerivedPathString,
	type NixMissingPartition,
	type NixStoreClient,
	type NixSubstitutablePathInfo,
	type NixValidPathInfo,
	NotInNixStoreError,
	type UnreachableSubstituter,
	UnsupportedNixStoreOperationError
} from './nix-store.ts';
import {
	createAvailabilityStoreClient,
	defaultStoreClientEnvironment,
	type NixDaemonClientOptions,
	type NixStoreKind,
	resolveStoreBackend,
	type StoreClientEnvironment,
	storeClientForBackend,
	storeDirectoriesOf,
	storeKindOf,
	substituterClientOver
} from './store-client.ts';
import { discoverNixStoreConfig } from './store-config.ts';
import {
	type QuerySubstitutablePathInfos,
	resolveSubstitutableClosure,
	type SubstitutableClosureOptions,
	type SubstitutableClosureVerdict
} from './substitutable-closure.ts';

/**
 * Reports whether availability reflects the requested substituter settings. A
 * negative result identifies the transport or trust boundary that prevents a
 * guarantee.
 */
export type SubstituterSettingsOutcome =
	| { readonly isHonoured: true }
	| {
			readonly isHonoured: false;
			readonly reason: 'daemon-options-preserved';
			readonly trust: 'unknown';
	  }
	| {
			readonly isHonoured: false;
			readonly reason?: 'daemon-trust';
			readonly trust: NixDaemonTrust;
	  };

export type RealPath = (path: string) => string;

export interface NixDependencies extends StoreClientEnvironment {
	readonly realpath?: RealPath;
}

const defaultRealPath: RealPath = (path) => realpathSync(path);

const noSubstituters: QuerySubstitutablePathInfos = () =>
	Promise.reject(
		new UnsupportedNixStoreOperationError('substitutable-path-info queries')
	);

/**
 * A client for the Nix store on the system. {@link Nix.open} discovers the
 * running configuration and applies Nix's normal choice between the daemon and
 * local store. Callers query path information and closures without depending
 * on the selected backend.
 */
export class Nix {
	static open(
		dependencies: NixDependencies = defaultStoreClientEnvironment
	): Nix {
		const config = discoverNixStoreConfig(dependencies);
		const backend = resolveStoreBackend(config, dependencies);
		const directories = storeDirectoriesOf(backend, config);
		const substituters = substituterClientOver(
			directories,
			config.substitution,
			config.fileTransfer,
			dependencies
		);

		return new Nix(
			storeClientForBackend(backend, config, substituters),
			(storePaths) => substituters.querySubstitutablePathInfos(storePaths),
			directories.storeDirectory,
			directories.stateDirectory,
			directories.realStoreDirectory ?? directories.storeDirectory,
			dependencies.realpath ?? defaultRealPath,
			storeKindOf(backend),
			config.unknownSettings
		);
	}

	/**
	 * Opens a store that can report external availability. {@link Nix.open}
	 * does not guarantee that: it prefers the local reader whenever the state
	 * directory is writable, and a local reader with no substituters cannot
	 * report external paths.
	 *
	 * A daemon provides these queries whenever its socket is available. Without
	 * an available daemon, this process queries the substituters directly. Options
	 * passed to this method override the discovered value for the same setting.
	 * `storeUri` selects the store, an `ssh-ng` URI reaches that remote's daemon
	 * over SSH, and a `substituters` override selects which substituters are
	 * queried in either case.
	 */
	static openForAvailability(
		dependencies: NixDependencies = defaultStoreClientEnvironment,
		options: NixDaemonClientOptions = {}
	): Nix {
		const config = discoverNixStoreConfig(dependencies);
		const {
			client,
			kind,
			realStoreDirectory,
			stateDirectory,
			storeDirectory,
			substituters
		} = createAvailabilityStoreClient(dependencies, config, options);

		return new Nix(
			client,
			(storePaths) => substituters.querySubstitutablePathInfos(storePaths),
			storeDirectory,
			stateDirectory,
			realStoreDirectory ?? storeDirectory,
			dependencies.realpath ?? defaultRealPath,
			kind,
			config.unknownSettings
		);
	}

	/**
	 * Creates a client over an explicit backend, store directory and path
	 * resolver. The store kind defaults to `local-filesystem`, which reads NAR
	 * contents from this machine's filesystem.
	 */
	static forStore(
		store: NixStoreClient,
		options: {
			readonly storeDirectory: StoreDirectory;
			readonly stateDirectory?: string;
			readonly realStoreDirectory?: string;
			readonly realpath?: RealPath;
			readonly storeKind?: NixStoreKind;
			/**
			 * Queries substituter offers for closure walks. A client without this
			 * dependency cannot perform the query.
			 */
			readonly offers?: QuerySubstitutablePathInfos;
		}
	): Nix {
		return new Nix(
			store,
			options.offers ?? noSubstituters,
			options.storeDirectory,
			options.stateDirectory,
			options.realStoreDirectory ?? options.storeDirectory,
			options.realpath ?? defaultRealPath,
			options.storeKind ?? 'local-filesystem'
		);
	}

	private constructor(
		private readonly store: NixStoreClient,
		private readonly offers: QuerySubstitutablePathInfos,
		public readonly storeDirectory: StoreDirectory,
		public readonly stateDirectory: string | undefined,
		private readonly realStoreDirectory: string,
		private readonly realpath: RealPath,
		public readonly storeKind: NixStoreKind,
		/**
		 * Unrecognised setting names from the source configuration. The client
		 * ignores their values, matching Nix, and exposes the names for callers to
		 * report.
		 */
		public readonly unknownSettings: readonly string[] = []
	) {}

	private resolveRealPath(path: string): string {
		try {
			return this.realpath(path);
		} catch {
			return path;
		}
	}

	private storePathContaining(path: string): StorePathString | undefined {
		const prefix = `${this.storeDirectory}/`;

		if (!path.startsWith(prefix)) {
			return undefined;
		}

		const [entry] = path.slice(prefix.length).split('/', 1);
		const storePath = storePathSchema.safeParse(`${prefix}${entry ?? ''}`);

		return storePath.success ? storePath.data : undefined;
	}

	async queryPathInfo(path: string): Promise<NixValidPathInfo> {
		return this.store.queryPathInfo(this.toStorePath(path));
	}

	/**
	 * Path information for every argument, in argument order. A missing argument
	 * fails the whole query.
	 */
	async queryPathsInfo(
		paths: readonly string[]
	): Promise<readonly NixValidPathInfo[]> {
		return this.store.queryPathsInfo(
			paths.map((path) => this.toStorePath(path))
		);
	}

	/**
	 * Copy activity visible to the selected backend while serving this client.
	 * Daemon clients observe `actCopyPath` events on their own connections.
	 * Backends without copy events return an empty map, as do paths that were
	 * already present and copies requested through another client.
	 */
	observedCopies(): ReadonlyMap<StorePathString, readonly string[]> {
		return this.store.observedCopies?.() ?? new Map();
	}

	/**
	 * Path information for valid arguments, in argument order. Invalid paths are
	 * omitted.
	 */
	async queryValidPathsInfo(
		paths: readonly string[]
	): Promise<readonly NixValidPathInfo[]> {
		return this.store.queryValidPathsInfo(
			paths.map((path) => this.toStorePath(path))
		);
	}

	/**
	 * Returns the arguments that are valid in this store, deduplicated and sorted.
	 */
	async queryValidPaths(paths: readonly string[]): Promise<readonly string[]> {
		return this.store.queryValidPaths(
			paths.map((path) => this.toStorePath(path))
		);
	}

	/**
	 * Returns the arguments available from the store's configured substituters,
	 * deduplicated and sorted.
	 */
	async querySubstitutablePaths(
		paths: readonly string[]
	): Promise<readonly string[]> {
		return this.store.querySubstitutablePaths(
			paths.map((path) => this.toStorePath(path))
		);
	}

	/**
	 * Returns the external offers visible through the selected backend and omits
	 * paths without an offer. A daemon reports transfer sizes and references. A
	 * process-driven store reads narinfo directly and also reports its NAR hash
	 * and signatures.
	 *
	 * The client uses its configured settings and narinfo-cache policy for this
	 * operation.
	 */
	async querySubstitutablePathInfos(
		paths: readonly string[]
	): Promise<readonly NixSubstitutablePathInfo[]> {
		return this.store.querySubstitutablePathInfos(
			paths.map((path) => this.toStorePath(path))
		);
	}

	/**
	 * Checks whether every path in the locally recorded closure has an acceptable
	 * offer from this client's substituters. The operation uses the substituters
	 * configured when the client was opened, so a caller that needs a particular
	 * set opens a client configured with them.
	 *
	 * Each substituter is queried for the path's narinfo, so every offer includes
	 * the NAR hash and signatures over it. An offer is proof only if a consumer
	 * would accept it, so a caller with a signing policy passes that policy in
	 * `options.accepts`.
	 */
	async resolveSubstitutableClosure(
		path: string,
		options: SubstitutableClosureOptions = {}
	): Promise<SubstitutableClosureVerdict> {
		return resolveSubstitutableClosure(
			this.toStorePath(path),
			{
				heldLocally: (storePaths) => this.store.queryValidPathsInfo(storePaths),
				offered: (storePaths) => this.offers(storePaths)
			},
			options
		);
	}

	/**
	 * Computes the work required to realise the given targets. Targets pass
	 * through unchanged. A derived path identifies a derivation and its outputs
	 * rather than a filesystem location, so it does not require canonicalisation.
	 */
	async queryMissing(
		targets: readonly NixDerivedPathString[]
	): Promise<NixMissingPartition> {
		return this.store.queryMissing(targets);
	}

	/**
	 * Whether this client's daemon connection is trusted. Only a
	 * daemon-backed store has a connection to query; any other backend reports
	 * `unknown`, as does an unset handshake flag.
	 */
	async daemonTrust(): Promise<NixDaemonTrust> {
		return (await this.store.daemonTrust?.()) ?? 'unknown';
	}

	/**
	 * Configured substituters that could not be queried. This distinguishes a
	 * confirmed absence from an incomplete query. A daemon manages its own
	 * substituters and does not identify individual reachability failures, so a
	 * daemon-backed store returns an empty list here.
	 */
	async unreachableSubstituters(): Promise<readonly UnreachableSubstituter[]> {
		return (await this.store.unreachableSubstituters?.()) ?? [];
	}

	/**
	 * Whether availability may reflect the daemon's narinfo cache. A daemon can
	 * repeat an earlier negative result without contacting a substituter. A store
	 * driven by this process queries its configured substituters for each
	 * operation.
	 */
	get cachesSubstituterQueries(): boolean {
		return this.storeKind !== 'local-filesystem';
	}

	get preservesDaemonOptions(): boolean {
		return this.store.preservesDaemonOptions ?? false;
	}

	/**
	 * Reports whether availability uses the substituter settings supplied when
	 * this client was opened. A process-driven store applies them directly. A
	 * local daemon can silently drop overrides from an untrusted connection, so
	 * only a trusted handshake confirms their use. An SSH store leaves its remote
	 * daemon's options unchanged and cannot provide this guarantee.
	 */
	async honoursSubstituterSettings(): Promise<SubstituterSettingsOutcome> {
		if (!this.cachesSubstituterQueries) {
			return { isHonoured: true };
		}

		if (this.preservesDaemonOptions) {
			return {
				isHonoured: false,
				reason: 'daemon-options-preserved',
				trust: 'unknown'
			};
		}

		const trust = await this.daemonTrust();

		return trust === 'trusted'
			? { isHonoured: true }
			: { isHonoured: false, reason: 'daemon-trust', trust };
	}

	narFromPath(path: string): AsyncIterable<Uint8Array> {
		return this.store.narFromPath(this.toStorePath(path));
	}

	/**
	 * Build the given targets and report each result. Targets pass through
	 * unchanged, as they do in {@link queryMissing}.
	 */
	async buildPathsWithResults(
		targets: readonly NixDerivedPathString[]
	): Promise<readonly NixBuildResult[]> {
		return this.store.buildPathsWithResults(targets);
	}

	/**
	 * Run operations on one daemon connection. Temporary roots added through
	 * the session remain live until the callback completes and the connection is
	 * closed. A backend without a daemon connection cannot provide a session.
	 */
	async withConnection<T>(
		use: (session: NixDaemonSession) => Promise<T>
	): Promise<T> {
		if (!(this.store instanceof NixDaemonStoreClient)) {
			throw new UnsupportedNixStoreOperationError(
				'connection-scoped operations'
			);
		}

		return this.store.withConnection(use);
	}

	/**
	 * Whether the specified derivation's own `allowSubstitutes` option lets Nix
	 * fetch its outputs rather than build them.
	 */
	async canSubstituteDerivation(drvPath: string): Promise<boolean> {
		const derivation = await this.readDerivation(drvPath);

		return derivation.allowsSubstitutes;
	}

	async derivationBuildRequirements(
		drvPath: string
	): Promise<DerivationBuildRequirements> {
		const derivation = await this.readDerivation(drvPath);

		return derivation.buildRequirements;
	}

	/**
	 * Reads the derivation at the specified store path.
	 *
	 * No store operation reports a derivation's contents. The derivation is a
	 * regular file whose serialisation contains all required metadata, so this
	 * operation reads that file without reading its outputs.
	 */
	async readDerivation(drvPath: string): Promise<Derivation> {
		const contents = await this.store.readDerivation(this.toStorePath(drvPath));

		return Derivation.parse(contents);
	}

	async queryDerivationOutputPaths(
		drvPaths: readonly string[]
	): Promise<readonly string[]> {
		return this.store.queryDerivationOutputPaths(
			drvPaths.map((drvPath) => this.toStorePath(drvPath))
		);
	}

	async resolveClosure(
		paths: readonly string[]
	): Promise<readonly NixValidPathInfo[]> {
		return this.store.resolveClosure(
			paths.map((path) => this.toStorePath(path))
		);
	}

	/**
	 * Resolves an argument to a store path with the same semantics as `nix
	 * path-info`. For an argument inside the store, this method normalises dot
	 * segments but does not resolve symlinks. This preserves the identity of the
	 * top-level store path. For any other argument, it resolves symlinks before
	 * selecting the store path. As a result, a `result` symlink refers to its
	 * target in the store.
	 *
	 * The entry directly below the store directory must itself be a valid store
	 * path, so a loose file beside the store's paths is rejected with
	 * {@link NotInNixStoreError}.
	 */
	toStorePath(path: string): StorePathString {
		const direct = this.storePathContaining(pathModule.normalize(path));

		if (direct !== undefined) {
			return direct;
		}

		const resolved = pathModule.normalize(this.resolveRealPath(path));
		const storePath = this.storePathContaining(resolved);

		if (storePath === undefined) {
			throw new NotInNixStoreError(resolved, this.storeDirectory);
		}

		return storePath;
	}

	/**
	 * Resolves a logical store path to its filesystem location. A rooted local
	 * store keeps the same logical paths but places their contents beneath another
	 * directory.
	 */
	storePathOnDisk(path: string): string {
		return pathModule.join(
			this.realStoreDirectory,
			pathModule.basename(this.toStorePath(path))
		);
	}
}
