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
	 * Abandons the walk between rounds, raising the signal's reason. A round
	 * is one question to each side, so a walk under way settles as soon as the
	 * answers it is waiting on arrive.
	 */
	readonly signal?: AbortSignal;
	/**
	 * Whether a consumer would take what a substituter offers (default: every
	 * offer). The store holds no signing policy of its own, so the caller
	 * that has one supplies it.
	 */
	readonly accepts?: AcceptsOffer;
}

/**
 * How a substitutable-closure walk settled. `served` means the substituters
 * the walk asked offer every path in the local closure, byte for byte where
 * they say so. Every other verdict names the path that settled the question,
 * and only `served` says the closure is held elsewhere.
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
	 * A path reachable from the root that this store does not hold, so there
	 * is no local closure to walk past it and nothing to compare an offer
	 * against.
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
	 * The check a consumer applies before fetching turns the offer down, so a
	 * consumer would not take the path however well the substituter serves it.
	 * What the check tests is the caller's to state; this says only that it
	 * said no.
	 */
	| { readonly kind: 'refused'; readonly storePath: StorePathString }
	| { readonly kind: 'over-cap'; readonly maxPaths: number };

/**
 * Asks a set of substituters what they offer for a batch of paths, reading
 * each answer from the substituter that made it.
 */
export type QuerySubstitutablePathInfos = (
	storePaths: readonly StorePathString[]
) => Promise<readonly NixSubstituterOffer[]>;

/** Asks this store which of a batch of paths it holds, and what it holds. */
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
 * by the substituters `queries.offered` asks. The closure walked is the one
 * this store holds, so the reachable set is the store's own record rather than
 * the substituters' account of it, and a substituter advertising fewer
 * references than the path really has cannot shrink what it has to answer for.
 * The walk stops at the first path that settles the question, so the rest of
 * the closure is never asked about.
 *
 * The NAR hash a substituter names must be the one this store holds: a path
 * offered under a different hash is a different path by the same name.
 *
 * Every offer must also be one a consumer would accept, which `accepts`
 * decides. A consumer refuses a path it cannot verify however well a
 * substituter serves it, so an offer that would be refused is a hole in the
 * closure exactly as an absent one is.
 *
 * Only metadata crosses the wire. The walk reads what the substituters
 * advertise and never fetches a NAR, so proving a large closure costs one
 * round of questions per level of it.
 *
 * Which substituters answer is the caller's choice, made when it builds
 * `queries.offered`.
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
