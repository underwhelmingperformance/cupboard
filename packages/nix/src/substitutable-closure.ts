import type { StorePathString } from '@cupboard/nix-store/scalars';

import {
	claimUnseen,
	type NixSubstituterOffer,
	type NixValidPathInfo
} from './nix-store.ts';

/**
 * How many paths a substitutable-closure walk visits before it gives up. A
 * closure this large is beyond what the walk is for, and the cap keeps a
 * mistaken root from asking about the whole store.
 */
export const defaultSubstitutableClosureCap = 10_000;

export interface SubstitutableClosureOptions {
	/** Paths the walk may visit (default: {@link defaultSubstitutableClosureCap}). */
	readonly maxPaths?: number;
	/**
	 * Abandons the walk between rounds using the signal's reason. In-flight
	 * store and substituter queries finish before the current round stops.
	 */
	readonly signal?: AbortSignal;
	/**
	 * Whether a consumer would accept a substituter offer. The caller supplies
	 * any signing policy because the store has none of its own.
	 */
	readonly accepts?: AcceptsOffer;
}

/**
 * The result of checking a substitutable closure. `served` means the
 * substituters offer every path in the local closure with matching NAR hashes.
 * Every other verdict identifies the first path that prevents that result.
 */
export type SubstitutableClosureVerdict =
	| {
			readonly kind: 'served';
			readonly pathCount: number;
			readonly downloadSize: number;
			readonly narSize: number;
	  }
	| { readonly kind: 'not-served'; readonly storePath: StorePathString }
	/**
	 * A reachable path that is absent from the local store. The walk cannot
	 * continue through its references or compare an offer with local metadata.
	 */
	| { readonly kind: 'not-held-locally'; readonly storePath: StorePathString }
	/**
	 * A substituter offers the path under a different NAR hash, so what a
	 * consumer would fetch is not what this store holds.
	 */
	| {
			readonly kind: 'divergent';
			readonly storePath: StorePathString;
			readonly held: string;
			readonly offered: string;
	  }
	/**
	 * The consumer's pre-fetch check rejects the offer, so a
	 * consumer would not take the path however well the substituter serves it.
	 * The caller defines the policy checked here.
	 */
	| { readonly kind: 'refused'; readonly storePath: StorePathString }
	| { readonly kind: 'over-cap'; readonly maxPaths: number };

/**
 * Queries a set of substituters for offers on a batch of paths.
 */
export type QuerySubstitutablePathInfos = (
	storePaths: readonly StorePathString[]
) => Promise<readonly NixSubstituterOffer[]>;

/** Reads validity and metadata for a batch of local store paths. */
export type QueryHeldPathInfos = (
	storePaths: readonly StorePathString[]
) => Promise<readonly NixValidPathInfo[]>;

/** Whether a consumer would accept what a substituter offers for a path. */
export type AcceptsOffer = (offer: NixSubstituterOffer) => Promise<boolean>;

export interface SubstitutableClosureQueries {
	readonly heldLocally: QueryHeldPathInfos;
	readonly offered: QuerySubstitutablePathInfos;
}

/**
 * Proves, or fails to prove, that everything reachable from `root` is offered
 * by the substituters queried through `queries.offered`. The walk uses the
 * local store's closure rather than
 * the substituters' account of it, and a substituter advertising fewer
 * references than the path really has cannot shrink the required set. The walk
 * stops at the first path that disproves full coverage.
 *
 * The NAR hash advertised by a substituter must match the local store's hash: a path
 * offered under a different hash is a different path by the same name.
 *
 * Every offer must also be one a consumer would accept, which `accepts`
 * decides. A consumer refuses a path it cannot verify however well a
 * substituter serves it, so an offer that would be refused counts against full
 * coverage in the same way as a missing offer.
 *
 * Only metadata crosses the wire. The walk reads what the substituters
 * advertise and never fetches a NAR, so proving a large closure costs one
 * query per level.
 *
 * The caller selects the substituters when constructing `queries.offered`.
 */
export async function resolveSubstitutableClosure(
	root: StorePathString,
	queries: SubstitutableClosureQueries,
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

		const [heldInfos, offeredInfos] = await Promise.all([
			queries.heldLocally(frontier),
			queries.offered(frontier)
		]);
		const held = new Map(heldInfos.map((info) => [info.storePath, info]));
		const offered = new Map(offeredInfos.map((info) => [info.storePath, info]));
		const references: StorePathString[] = [];

		for (const storePath of frontier) {
			const local = held.get(storePath);

			if (local === undefined) {
				return { kind: 'not-held-locally', storePath };
			}

			const offer = offered.get(storePath);

			if (offer === undefined) {
				return { kind: 'not-served', storePath };
			}

			const divergent = narHashMismatch(storePath, local, offer);

			if (divergent !== undefined) {
				return divergent;
			}

			if (!(await (options.accepts ?? acceptsEveryOffer)(offer))) {
				return { kind: 'refused', storePath };
			}

			downloadSize += offer.downloadSize;
			narSize += offer.narSize;
			references.push(...local.references);
		}

		frontier = claimUnseen(references, claimed);
	}

	return { kind: 'served', pathCount: claimed.size, downloadSize, narSize };
}

const acceptsEveryOffer: AcceptsOffer = () => Promise.resolve(true);

function narHashMismatch(
	storePath: StorePathString,
	local: NixValidPathInfo,
	offer: NixSubstituterOffer
): SubstitutableClosureVerdict | undefined {
	const held = local.narHash.toString();
	const offered = offer.narHash.toString();

	return held === offered
		? undefined
		: { kind: 'divergent', storePath, held, offered };
}
