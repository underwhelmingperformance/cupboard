import { realpathSync } from 'node:fs';

import {
	type StoreDirectory,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';

import {
	type NixDerivedPathString,
	type NixMissingPartition,
	type NixStoreClient,
	type NixValidPathInfo,
	NotInNixStoreError
} from './nix-store.ts';
import {
	createNixDaemonStoreClient,
	createNixStoreClient,
	defaultStoreClientEnvironment,
	type NixDaemonClientOptions,
	type StoreClientEnvironment
} from './store-client.ts';
import { discoverNixStoreConfig } from './store-config.ts';

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
		const store = createNixStoreClient(dependencies, config);

		return new Nix(
			store,
			config.storeDirectory,
			dependencies.realpath ?? defaultRealPath
		);
	}

	/**
	 * Open the daemon-backed store explicitly. The substitutable and
	 * missing-path queries exist only behind the daemon, and the automatic
	 * backend prefers the local reader whenever the state directory is
	 * writable, so a caller that needs daemon-only operations selects the
	 * daemon here. The daemon socket has to be present; a daemonless install
	 * is refused with a typed error naming the probed socket path. Per-call
	 * options merge over the discovered daemon settings, the caller winning
	 * per key.
	 */
	static openDaemon(
		dependencies: NixDependencies = defaultStoreClientEnvironment,
		options: NixDaemonClientOptions = {}
	): Nix {
		const config = discoverNixStoreConfig(dependencies);
		const store = createNixDaemonStoreClient(dependencies, config, options);

		return new Nix(
			store,
			config.storeDirectory,
			dependencies.realpath ?? defaultRealPath
		);
	}

	/** Build a client over an explicit backend, store directory and path resolver. */
	static forStore(
		store: NixStoreClient,
		options: {
			readonly storeDirectory: StoreDirectory;
			readonly realpath?: RealPath;
		}
	): Nix {
		return new Nix(
			store,
			options.storeDirectory,
			options.realpath ?? defaultRealPath
		);
	}

	private constructor(
		private readonly store: NixStoreClient,
		private readonly storeDirectory: StoreDirectory,
		private readonly realpath: RealPath
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
	 * What realising the given targets would require. Targets pass through
	 * unchanged: a derived path names a derivation and its outputs, not a
	 * filesystem location, so there is nothing to canonicalise.
	 */
	async queryMissing(
		targets: readonly NixDerivedPathString[]
	): Promise<NixMissingPartition> {
		return this.store.queryMissing(targets);
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
