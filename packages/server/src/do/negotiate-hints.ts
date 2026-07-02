import {
	nixSha256HashSchema,
	type NixSha256HashString,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

// The header carrying a staged hint set's single-use token from the front
// Worker into the Durable Object's negotiate route. The Worker strips any
// inbound value at its dispatch choke point and sets it only when it staged
// hints itself, so a client can never smuggle one in.
export const negotiateHintsHeader = 'x-cupboard-negotiate-hints';

export const negotiateHintsTokenSchema = z
	.string()
	.min(1)
	.brand('NegotiateHintsToken');
export type NegotiateHintsToken = z.infer<typeof negotiateHintsTokenSchema>;

// One `blob_state` row the Worker found for a requested NAR hash: the
// presence and reuse facts negotiate reads, plus the reaper timer so the
// Worker can clear it for the reuses the response commits to.
export const blobStateHintSchema = z.object({
	narHash: nixSha256HashSchema,
	fileHash: nixSha256HashSchema,
	fileSize: z.number().int().nonnegative(),
	compression: z.literal('zstd'),
	narSize: z.number().int().nonnegative(),
	deleteAfter: z.string().nullable()
});
export type BlobStateHint = z.infer<typeof blobStateHintSchema>;

// One `blob_reference` edge the Worker found for a requested store path in
// the negotiated cache. The Durable Object compares these against its own
// live narinfo rows, so an edge read before a recommit bumped the generation
// simply fails to match: it fails towards "not committed", the safe
// direction.
export const committedEdgeHintSchema = z.object({
	storePathHash: storePathHashSchema,
	generation: z.number().int().nonnegative(),
	narHash: nixSha256HashSchema
});
export type CommittedEdgeHint = z.infer<typeof committedEdgeHintSchema>;

/**
 * The shared-fact reads for one negotiate, computed by the front Worker so
 * the Durable Object thread spends no time on them. Coverage is total: the
 * Worker probed every NAR hash in the request body, so absence from a list is
 * a definitive no-row, not an unknown. The reads preserve negotiate's
 * existence-oracle property, since ownership comes from this tenant's own
 * presence edges, never the global facts alone.
 */
export const negotiateHintsSchema = z.object({
	blobStates: z.array(blobStateHintSchema),
	ownedNarHashes: z.array(nixSha256HashSchema),
	// Absent when the staging Worker did not compute the edge read (an older
	// script, or no cache resolved): the fallback is the object's own edge
	// read, never "no edges".
	committedEdges: z.array(committedEdgeHintSchema).optional()
});
export type NegotiateHints = z.infer<typeof negotiateHintsSchema>;

/** Hint lookups in the shapes negotiate's decisions consume. */
export interface NegotiateFacts {
	readonly backedNarHashes: ReadonlySet<NixSha256HashString>;
	readonly reusableByNarHash: ReadonlyMap<NixSha256HashString, BlobStateHint>;
	readonly committedEdges: readonly CommittedEdgeHint[] | undefined;
}

export function factsFromHints(hints: NegotiateHints): NegotiateFacts {
	const owned = new Set(hints.ownedNarHashes);

	return {
		backedNarHashes: new Set(hints.blobStates.map((state) => state.narHash)),
		reusableByNarHash: new Map(
			hints.blobStates
				.filter((state) => owned.has(state.narHash))
				.map((state) => [state.narHash, state])
		),
		committedEdges: hints.committedEdges
	};
}

// A staged hint set lives just long enough for the dispatch that follows it.
export const hintTtlMs = 30_000;
export const hintCapacity = 64;

/**
 * The in-memory, single-use staging area for negotiate hints: the Worker
 * stages a set over RPC and receives a random token, then dispatches the
 * request with the token in {@link negotiateHintsHeader}; the negotiate route
 * takes the set at most once. Unreachable over HTTP and unguessable, so hints
 * are unforgeable by clients. In-memory is enough: a lost set (eviction, an
 * unknown or expired token) falls back to the Durable Object reading its own
 * facts.
 */
export class NegotiateHintStore {
	private readonly staged = new Map<
		string,
		{ readonly hints: NegotiateHints; readonly expiresAt: number }
	>();

	stage(hints: NegotiateHints, now: number): NegotiateHintsToken {
		for (const [token, entry] of this.staged) {
			if (entry.expiresAt <= now) {
				this.staged.delete(token);
			}
		}

		// Insertion order is age order, so the cap evicts the oldest first.
		while (this.staged.size >= hintCapacity) {
			const oldest = this.staged.keys().next().value;

			if (oldest === undefined) {
				break;
			}

			this.staged.delete(oldest);
		}

		const token = crypto.randomUUID();
		this.staged.set(token, { hints, expiresAt: now + hintTtlMs });

		return negotiateHintsTokenSchema.parse(token);
	}

	take(token: string, now: number): NegotiateHints | undefined {
		const entry = this.staged.get(token);
		this.staged.delete(token);

		if (entry === undefined || entry.expiresAt <= now) {
			return undefined;
		}

		return entry.hints;
	}
}
