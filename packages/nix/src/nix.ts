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

import {
	type NixBuildResult,
	type NixDaemonTrust,
	type NixDerivedPathString,
	type NixMissingPartition,
	type NixStoreClient,
	type NixValidPathInfo,
	NotInNixStoreError
} from './nix-store.ts';
import {
	createAvailabilityStoreClient,
	defaultStoreClientEnvironment,
	type NixDaemonClientOptions,
	type NixStoreKind,
	resolveStoreBackend,
	type StoreClientEnvironment,
	storeClientForBackend,
	storeKindOf
} from './store-client.ts';
import { discoverNixStoreConfig } from './store-config.ts';
import {
	resolveSubstitutableClosure,
	type SubstitutableClosureOptions,
	type SubstitutableClosureVerdict
} from './substitutable-closure.ts';

/** Resolves a path's real location, injected so canonicalisation is testable. */
export type RealPath = (path: string) => string;

export interface NixDependencies extends StoreClientEnvironment {
	readonly realpath?: RealPath;
}

const defaultRealPath: RealPath = (path) => realpathSync(path);

/**
 * A client for the Nix store on the system. {@link Nix.open} discovers the
 * running configuration and reads through the daemon or the local store,
 * whichever Nix itself would use; callers query path information and closures
 * without caring which backend answered.
 */
export class Nix {
	static open(
		dependencies: NixDependencies = defaultStoreClientEnvironment
	): Nix {
		const config = discoverNixStoreConfig(dependencies);
		const backend = resolveStoreBackend(config, dependencies);

		return new Nix(
			storeClientForBackend(backend, config),
			config.storeDirectory,
			dependencies.realpath ?? defaultRealPath,
			storeKindOf(backend)
		);
	}

	/**
	 * Open a store that can answer what is available elsewhere, which the
	 * automatic selection does not guarantee: it prefers the local reader
	 * whenever the state directory is writable, and a local reader with no
	 * substituters cannot say what they hold.
	 *
	 * A daemon answers whenever its socket is there. Without one this process
	 * asks the substituters itself. Per-call options merge over the discovered
	 * daemon settings, the caller winning per key: `storeUri` selects the
	 * store, an `ssh-ng` URI reaching that remote's daemon over ssh, and a
	 * `substituters` override selects which substituters answer either way.
	 */
	static openForAvailability(
		dependencies: NixDependencies = defaultStoreClientEnvironment,
		options: NixDaemonClientOptions = {}
	): Nix {
		const config = discoverNixStoreConfig(dependencies);
		const { client, kind } = createAvailabilityStoreClient(
			dependencies,
			config,
			options
		);

		return new Nix(
			client,
			config.storeDirectory,
			dependencies.realpath ?? defaultRealPath,
			kind
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
		}
	): Nix {
		return new Nix(
			store,
			options.storeDirectory,
			options.realpath ?? defaultRealPath,
			options.storeKind ?? 'local-filesystem'
		);
	}

	private constructor(
		private readonly store: NixStoreClient,
		private readonly storeDirectory: StoreDirectory,
		private readonly realpath: RealPath,
		/** The kind of store backend this client reads through. */
		public readonly storeKind: NixStoreKind
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
	 * Path information for the arguments the store holds, in argument order;
	 * one it does not hold is left out.
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
	 * Whether everything reachable from the argument is offered by this
	 * client's substituters, proven by walking the references they report.
	 * The substituters that answer are the ones this client's connection was
	 * opened with, so a caller that needs a particular set of them opens a
	 * client carrying that set.
	 */
	async resolveSubstitutableClosure(
		path: string,
		options: SubstitutableClosureOptions = {}
	): Promise<SubstitutableClosureVerdict> {
		return resolveSubstitutableClosure(
			this.toStorePath(path),
			(storePaths) => this.store.querySubstitutablePathInfos(storePaths),
			options
		);
	}

	/**
	 * What realising the given targets would require. Targets pass through
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
	 * daemon-backed store has a connection to ask; any other backend reports
	 * `unknown`, the same answer an unset handshake flag gives.
	 */
	async daemonTrust(): Promise<NixDaemonTrust> {
		return (await this.store.daemonTrust?.()) ?? 'unknown';
	}

	/** The NAR serialisation of the store path the argument names. */
	narFromPath(path: string): AsyncIterable<Uint8Array> {
		return this.store.narFromPath(this.toStorePath(path));
	}

	/**
	 * Build the given targets and report how each settled. Targets pass
	 * through unchanged, the way {@link queryMissing}'s do.
	 */
	async buildPathsWithResults(
		targets: readonly NixDerivedPathString[]
	): Promise<readonly NixBuildResult[]> {
		return this.store.buildPathsWithResults(targets);
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
	 * What the named derivation asks of the machine that builds it: the system
	 * it builds for and the system features it requires.
	 */
	async derivationBuildRequirements(
		drvPath: string
	): Promise<DerivationBuildRequirements> {
		const derivation = await this.readDerivation(drvPath);

		return derivation.buildRequirements;
	}

	/**
	 * The named derivation, read from the store that holds it.
	 *
	 * No store operation reports a derivation's contents, so the derivation
	 * itself is read: a derivation is one regular file in the store, and its
	 * serialisation carries everything below. Reading it costs the
	 * derivation's own bytes and nothing of its outputs.
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
