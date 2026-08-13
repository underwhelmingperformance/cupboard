import { realpathSync } from 'node:fs';

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
 * Whether availability results reflect the substituter settings used to open
 * the store. A negative result identifies the transport or trust restriction.
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

/** Resolves a path's real location, injected so canonicalisation is testable. */
export type RealPath = (path: string) => string;

export interface NixDependencies extends StoreClientEnvironment {
	readonly realpath?: RealPath;
}

const defaultRealPath: RealPath = (path) => realpathSync(path);

// A client built over a bare backend has no substituter queries.
const noSubstituters: QuerySubstitutablePathInfos = () =>
	Promise.reject(
		new UnsupportedNixStoreOperationError('substitutable-path-info queries')
	);

/**
 * A client for the Nix store on the system. {@link Nix.open} discovers the
 * running configuration and reads through the daemon or the local store,
 * whichever Nix itself would use; callers query path information and closures
 * without depending on the selected backend.
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
			dependencies.realpath ?? defaultRealPath,
			storeKindOf(backend),
			config.unknownSettings
		);
	}

	/**
	 * Opens a store that can report external availability, which
	 * automatic selection does not guarantee: it prefers the local reader
	 * whenever the state directory is writable, and a local reader with no
	 * substituters cannot report external paths.
	 *
	 * A daemon provides these queries whenever its socket is available. Without
	 * one this process queries the substituters directly. Per-call options
	 * override discovered daemon settings, with the caller winning per key.
	 * `storeUri` selects the store, an `ssh-ng` URI reaches that remote's daemon
	 * over SSH, and a
	 * `substituters` override selects which substituters answer either way.
	 */
	static openForAvailability(
		dependencies: NixDependencies = defaultStoreClientEnvironment,
		options: NixDaemonClientOptions = {}
	): Nix {
		const config = discoverNixStoreConfig(dependencies);
		const { client, kind, storeDirectory, substituters } =
			createAvailabilityStoreClient(dependencies, config, options);

		return new Nix(
			client,
			(storePaths) => substituters.querySubstitutablePathInfos(storePaths),
			storeDirectory,
			dependencies.realpath ?? defaultRealPath,
			kind,
			config.unknownSettings
		);
	}

	/**
	 * Build a client over an explicit backend, store directory and path
	 * resolver. The store kind defaults to `local-filesystem`, the kind whose
	 * paths sit on this machine's filesystem.
	 */
	static forStore(
		store: NixStoreClient,
		options: {
			readonly storeDirectory: StoreDirectory;
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
			options.realpath ?? defaultRealPath,
			options.storeKind ?? 'local-filesystem'
		);
	}

	private constructor(
		private readonly store: NixStoreClient,
		/**
		 * Direct substituter queries, independent of the selected store backend.
		 */
		private readonly offers: QuerySubstitutablePathInfos,
		private readonly storeDirectory: StoreDirectory,
		private readonly realpath: RealPath,
		/** The kind of store backend this client reads through. */
		public readonly storeKind: NixStoreKind,
		/**
		 * Setting names from the source configuration that this client does not
		 * recognise. The client ignores their values, matching Nix, and exposes
		 * the names for callers to report.
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

	/** Path information for the store path the argument names. */
	async queryPathInfo(path: string): Promise<NixValidPathInfo> {
		return this.store.queryPathInfo(this.toStorePath(path));
	}

	/**
	 * Path information for every argument, in argument order. An argument the
	 * store does not hold fails the whole query.
	 */
	async queryPathsInfo(
		paths: readonly string[]
	): Promise<readonly NixValidPathInfo[]> {
		return this.store.queryPathsInfo(
			paths.map((path) => this.toStorePath(path))
		);
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

	/** The arguments this store holds as valid, deduplicated and sorted. */
	async queryValidPaths(paths: readonly string[]): Promise<readonly string[]> {
		return this.store.queryValidPaths(
			paths.map((path) => this.toStorePath(path))
		);
	}

	/**
	 * The arguments available from the store's configured substituters,
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
	 * The substituter offer for each path: transfer size, references and, from a
	 * substituter's own narinfo, the NAR hash and signatures it would serve
	 * the path under. Paths without an offer are omitted.
	 *
	 * Results use the settings of the opened store. A client configured to bypass
	 * a narinfo cache also bypasses it for this operation.
	 */
	async querySubstitutablePathInfos(
		paths: readonly string[]
	): Promise<readonly NixSubstitutablePathInfo[]> {
		return this.store.querySubstitutablePathInfos(
			paths.map((path) => this.toStorePath(path))
		);
	}

	/**
	 * Whether everything in this store's closure of the argument is offered by
	 * this client's substituters, proven by walking the closure the store
	 * contains and querying every path. The operation uses the substituters
	 * configured when the client was opened, so a caller that needs a
	 * particular set of them opens a client carrying that set.
	 *
	 * Each substituter is queried for the path's narinfo, so every offer includes
	 * the NAR hash and signatures
	 * over it. An offer is proof only if a consumer would take it, so a caller
	 * with a signing policy passes it in `options.accepts`.
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
	 * Computes the work required to realise the given targets. Targets pass through
	 * unchanged: a derived path names a derivation and its outputs, not a
	 * filesystem location, so there is nothing to canonicalise.
	 */
	async queryMissing(
		targets: readonly NixDerivedPathString[]
	): Promise<NixMissingPartition> {
		return this.store.queryMissing(targets);
	}

	/**
	 * Whether the daemon connection this client uses is trusted. Only a
	 * daemon-backed store has a connection to query; any other backend reports
	 * `unknown`, as does an unset handshake flag.
	 */
	async daemonTrust(): Promise<NixDaemonTrust> {
		return (await this.store.daemonTrust?.()) ?? 'unknown';
	}

	/**
	 * Configured substituters that could not be queried. This distinguishes a
	 * confirmed absence from an incomplete query. A daemon manages its own
	 * substituters and reports what it
	 * reached to its own log, so a daemon-backed store names none here.
	 */
	async unreachableSubstituters(): Promise<readonly UnreachableSubstituter[]> {
		return (await this.store.unreachableSubstituters?.()) ?? [];
	}

	/**
	 * Whether substituter availability may have come from a
	 * cache. A daemon keeps one, so an absence it reports may be an absence it
	 * recorded earlier; a store driven by this process queries the substituters
	 * directly, so its results are current.
	 */
	get cachesSubstituterAnswers(): boolean {
		return this.storeKind !== 'local-filesystem';
	}

	/** Whether this transport leaves the remote daemon's options untouched. */
	get preservesDaemonOptions(): boolean {
		return this.store.preservesDaemonOptions ?? false;
	}

	/**
	 * Whether the substituter settings this client was opened with are the
	 * ones reflected by its results.
	 *
	 * An SSH store preserves the remote daemon's settings rather than sending
	 * these options. Other daemons apply an untrusted client's settings
	 * selectively without reporting which were dropped, so only a trusted
	 * connection can confirm the settings it was sent. A store driven by this
	 * process applies the settings directly.
	 */
	async honoursSubstituterSettings(): Promise<SubstituterSettingsOutcome> {
		if (!this.cachesSubstituterAnswers) {
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

	/** The NAR serialisation of the store path the argument names. */
	narFromPath(path: string): AsyncIterable<Uint8Array> {
		return this.store.narFromPath(this.toStorePath(path));
	}

	/**
	 * Build the given targets and report each result. Targets pass
	 * through unchanged, the way {@link queryMissing}'s do.
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
	 * Whether the named derivation's own `allowSubstitutes` option lets Nix
	 * fetch its outputs rather than build them.
	 */
	async canSubstituteDerivation(drvPath: string): Promise<boolean> {
		const derivation = await this.readDerivation(drvPath);

		return derivation.allowsSubstitutes;
	}

	/**
	 * The system and system features required to build the derivation.
	 */
	async derivationBuildRequirements(
		drvPath: string
	): Promise<DerivationBuildRequirements> {
		const derivation = await this.readDerivation(drvPath);

		return derivation.buildRequirements;
	}

	/**
	 * Reads the named derivation from the store.
	 *
	 * No store operation reports a derivation's contents, so the derivation
	 * itself is read: a derivation is one regular file in the store, and its
	 * serialisation contains all required metadata. This reads only the
	 * derivation file, not its outputs.
	 */
	async readDerivation(drvPath: string): Promise<Derivation> {
		const contents = await this.store.readDerivation(this.toStorePath(drvPath));

		return Derivation.parse(contents);
	}

	/** The registered output paths of the given derivations, sorted. */
	async queryDerivationOutputPaths(
		drvPaths: readonly string[]
	): Promise<readonly string[]> {
		return this.store.queryDerivationOutputPaths(
			drvPaths.map((drvPath) => this.toStorePath(drvPath))
		);
	}

	/** The closure of the given paths, sorted by store path. */
	async resolveClosure(
		paths: readonly string[]
	): Promise<readonly NixValidPathInfo[]> {
		return this.store.resolveClosure(
			paths.map((path) => this.toStorePath(path))
		);
	}

	/**
	 * The store path an argument names, the way `nix path-info` does: resolve
	 * symlinks, then take the store path containing the result. A `result`
	 * symlink and a file inside a store path both resolve to the store path.
	 *
	 * The entry directly under the store directory has to name a store path for
	 * the result to be one, so a loose file sitting beside the store's paths is
	 * refused here as not being in the store.
	 */
	toStorePath(path: string): StorePathString {
		const resolved = this.resolveRealPath(path);
		const prefix = `${this.storeDirectory}/`;

		if (!resolved.startsWith(prefix)) {
			throw new NotInNixStoreError(resolved, this.storeDirectory);
		}

		const [entry] = resolved.slice(prefix.length).split('/', 1);
		const storePath = storePathSchema.safeParse(`${prefix}${entry ?? ''}`);

		if (!storePath.success) {
			throw new NotInNixStoreError(resolved, this.storeDirectory);
		}

		return storePath.data;
	}
}
