import type { NixValidPathInfo } from '@cupboard/nix';
import type { StorePathString } from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';

import { BuildOutputDivergedError } from '../errors.ts';
import { type NarDivergence, narDivergence } from '../push/divergence.ts';

/**
What a build-push does with a path that it built when the cache already serves
different bytes for that store path. `concede` keeps the cache's copy and
treats the path as published. `fail` refuses the path with
`BuildOutputDivergedError`.
*/
export type DivergencePolicy = 'concede' | 'fail';

/**
The evidence that a run built a path. A path counts as built when the
post-build hook reported it, when a built subject was recovered for it, or
when the build log shows that its deriver was built.
*/
export class BuiltPaths {
	private readonly paths = new Set<StorePathString>();
	private readonly derivations = new Set<string>();

	addPaths(paths: Iterable<StorePathString>): void {
		for (const path of paths) {
			this.paths.add(path);
		}
	}

	addDerivations(derivations: Iterable<string>): void {
		for (const derivation of derivations) {
			this.derivations.add(derivation);
		}
	}

	has(info: Pick<NixValidPathInfo, 'storePath' | 'deriver'>): boolean {
		return (
			this.paths.has(info.storePath) ||
			(info.deriver !== undefined && this.derivations.has(info.deriver))
		);
	}
}

/**
Compares the local copies of one run's paths with the copies that the cache
serves, and records each path whose NAR hash differs. The cache keeps the copy
that was published first. Publication does not check whether the two copies
are interchangeable.
*/
export class BuildOutputDivergences {
	private readonly recorded = new Map<StorePathString, NarDivergence>();

	/**
	`isBuilt` selects the paths that this run built. The `fail` policy applies
	only to those paths. Every other diverged path is recorded and kept as the
	cache's copy.
	*/
	constructor(
		readonly policy: DivergencePolicy = 'concede',
		private readonly isBuilt: (info: NixValidPathInfo) => boolean = () => true
	) {}

	/**
	Compares the local NAR hash of a path with the cache's NAR hash for the same
	path. Under the `fail` policy a difference for a built path throws
	`BuildOutputDivergedError`. Otherwise the difference is recorded, and a
	matching hash removes an earlier record for the path.
	*/
	compare(info: NixValidPathInfo, cacheNarHash: string): void {
		const divergence = narDivergence(
			info.storePath,
			info.narHash.toString(),
			cacheNarHash
		);

		if (divergence === undefined) {
			this.recorded.delete(info.storePath);
			return;
		}

		if (this.policy === 'fail' && this.isBuilt(info)) {
			throw new BuildOutputDivergedError(
				divergence.storePath,
				divergence.localNarHash,
				divergence.cacheNarHash
			);
		}

		this.recorded.set(info.storePath, divergence);
	}

	has(storePath: StorePathString): boolean {
		return this.recorded.has(storePath);
	}

	/**
	The recorded divergences, ordered by store path.
	*/
	list(): readonly NarDivergence[] {
		return this.recorded
			.values()
			.toArray()
			.toSorted((left, right) => byCodeUnit(left.storePath, right.storePath));
	}
}
