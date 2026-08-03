import type { StorePathString } from '@cupboard/nix-store/scalars';

import { claimUnseen, type NixSubstitutablePathInfo } from './nix-store.ts';

/**
 * How many paths a substitutable-closure walk visits before it gives up. A
 * closure this large is beyond what the walk is for, and the cap keeps a
 * mistaken root from asking the daemon about the whole store.
 */
export const defaultSubstitutableClosureCap = 10_000;

export interface SubstitutableClosureOptions {
	/** Paths the walk may visit (default: {@link defaultSubstitutableClosureCap}). */
	readonly maxPaths?: number;
	/**
	 * Abandons the walk between rounds, raising the signal's reason. Each
	 * round is one daemon operation, so a walk under way settles as soon as
	 * the operation it is waiting on returns.
	 */
	readonly signal?: AbortSignal;
}

/**
 * How a substitutable-closure walk settled. `served` means every path
 * reachable from the root is offered by the substituters the walk asked;
 * `not-served` names the first path that is not, and `over-cap` reports that
 * the closure is larger than the walk was allowed to visit. Only `served`
 * says the closure is held elsewhere.
 */
export type SubstitutableClosureVerdict =
	| {
			readonly kind: 'served';
			readonly pathCount: number;
			readonly downloadSize: number;
			readonly narSize: number;
	  }
	| { readonly kind: 'not-served'; readonly storePath: StorePathString }
	| { readonly kind: 'over-cap'; readonly maxPaths: number };

/** Asks a set of substituters what they offer for a batch of paths. */
export type QuerySubstitutablePathInfos = (
	storePaths: readonly StorePathString[]
) => Promise<readonly NixSubstitutablePathInfo[]>;

/**
 * Proves, or fails to prove, that everything reachable from `root` is offered
 * by the substituters `query` asks. The walk follows the references each
 * answer carries, visiting a path once however many edges reach it, and stops
 * at the first path no substituter offers: one hole is enough to settle the
 * question, so the rest of the closure is never asked about.
 *
 * Only metadata crosses the wire. The walk reads what the substituters
 * advertise and never fetches a NAR, so proving a large closure costs one
 * daemon operation per level of it.
 *
 * Which substituters answer is the caller's choice, made when it opens the
 * connection `query` runs on. Whether the answering substituter's signatures
 * would be accepted is not settled here either: the daemon applies its own
 * `trusted-public-keys` policy when a substitution actually runs, and a
 * `served` verdict is no claim about that policy.
 */
export async function resolveSubstitutableClosure(
	root: StorePathString,
	query: QuerySubstitutablePathInfos,
	options: SubstitutableClosureOptions = {}
): Promise<SubstitutableClosureVerdict> {
	const maxPaths = options.maxPaths ?? defaultSubstitutableClosureCap;
	const claimed = new Set<string>();
	let frontier = claimUnseen([root], claimed);
	let downloadSize = 0;
	let narSize = 0;

	while (frontier.length > 0) {
		options.signal?.throwIfAborted();

		if (claimed.size > maxPaths) {
			return { kind: 'over-cap', maxPaths };
		}

		const infos = await query(frontier);
		const offered = new Map(infos.map((info) => [info.storePath, info]));
		const references: StorePathString[] = [];

		for (const storePath of frontier) {
			const info = offered.get(storePath);

			if (info === undefined) {
				return { kind: 'not-served', storePath };
			}

			downloadSize += info.downloadSize;
			narSize += info.narSize;
			references.push(...info.references);
		}

		frontier = claimUnseen(references, claimed);
	}

	return { kind: 'served', pathCount: claimed.size, downloadSize, narSize };
}
