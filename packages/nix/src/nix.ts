import { realpathSync } from 'node:fs';

import type { StoreDirectory } from '@cupboard/nix-store/scalars';

import {
	type NixStoreClient,
	type NixValidPathInfo,
	NotInNixStoreError
} from './nix-store.ts';
import {
	createNixStoreClient,
	defaultStoreClientEnvironment,
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
	 */
	toStorePath(path: string): string {
		const resolved = this.resolveRealPath(path);
		const prefix = `${this.storeDirectory}/`;

		if (!resolved.startsWith(prefix)) {
			throw new NotInNixStoreError(resolved, this.storeDirectory);
		}

		const [name] = resolved.slice(prefix.length).split('/', 1);

		if (name === undefined || name === '') {
			throw new NotInNixStoreError(resolved, this.storeDirectory);
		}

		return `${this.storeDirectory}/${name}`;
	}
}
