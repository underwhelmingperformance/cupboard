import type { StorePathString } from '@cupboard/nix-store/scalars';

import {
	claimUnseen,
	type NixSubstituterOffer,
	type NixValidPathInfo
} from './nix-store.ts';

/**
 * The maximum number of distinct closure paths that may be queried. If one
 * round discovers enough references to exceed the limit, the next round
 * returns `over-cap` without querying them.
 */
export const defaultSubstitutableClosureCap = 10_000;

export interface SubstitutableClosureOptions {
	/**
	 * Limits the number of distinct closure paths that may be queried. Defaults
	 * to {@link defaultSubstitutableClosureCap}.
	 */
	readonly maxPaths?: number;
	/**
	 * Abandons the walk between rounds using the signal's reason. In-flight
	 * store and substituter queries finish before the current round stops.
	 */
	readonly signal?: AbortSignal;
	/**
	 * Applies the consumer's pre-fetch policy to each offer. The caller supplies
	 * this policy because store availability alone does not establish that a
	 * consumer will accept the NAR.
	 */
	readonly accepts?: AcceptsOffer;
}

/**
 * The result of checking a substitutable closure. `served` means every path in
 * the locally recorded closure has an acceptable offer with the same NAR hash.
 * The path-specific failures identify the first path that prevents that
 * result; `over-cap` reports the traversal limit.
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
	 * A substituter offers the path under a different NAR hash. The offered
	 * contents therefore differ from the local store's metadata for the path.
	 */
	| {
			readonly kind: 'divergent';
			readonly storePath: StorePathString;
			readonly held: string;
			readonly offered: string;
	  }
	/**
	 * The consumer's pre-fetch policy rejects the offer. The caller defines the
	 * policy checked here.
	 */
	| { readonly kind: 'refused'; readonly storePath: StorePathString }
	| { readonly kind: 'over-cap'; readonly maxPaths: number };

export type QuerySubstitutablePathInfos = (
	storePaths: readonly StorePathString[]
) => Promise<readonly NixSubstituterOffer[]>;

export type QueryHeldPathInfos = (
	storePaths: readonly StorePathString[]
) => Promise<readonly NixValidPathInfo[]>;

export type AcceptsOffer = (offer: NixSubstituterOffer) => Promise<boolean>;

export interface SubstitutableClosureQueries {
	readonly heldLocally: QueryHeldPathInfos;
	readonly offered: QuerySubstitutablePathInfos;
}

/**
 * Checks every path in the closure recorded by the local store. References
 * advertised by substituters are not authoritative and cannot reduce the
 * required closure. Each frontier is queried once from the local store and
 * once from the selected substituters.
 *
 * Paths are checked in frontier order. Local absence takes precedence over a
 * missing offer, a NAR hash mismatch, and consumer-policy rejection. The first
 * failure stops the walk. A `served` result counts every accepted offer once
 * and sums its download and NAR sizes.
 *
 * The walk reads metadata only and never fetches a NAR. It observes aborts
 * between frontiers; in-flight queries finish before the current frontier
 * stops. The caller selects both the substituters and the offer-acceptance
 * policy.
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

			if (!(await (options.accepts ?? willAcceptEveryOffer)(offer))) {
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

const willAcceptEveryOffer: AcceptsOffer = () => Promise.resolve(true);

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
