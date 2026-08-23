import {
	narInfoGenerationSchema,
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

export const blobStateHintSchema = z.object({
	narHash: nixSha256HashSchema,
	fileHash: nixSha256HashSchema,
	fileSize: z.number().int().nonnegative(),
	compression: z.literal('zstd'),
	narSize: z.number().int().nonnegative(),
	deleteAfter: z.string().nullable()
});
export type BlobStateHint = z.infer<typeof blobStateHintSchema>;

// The Durable Object compares the hinted generation with its current narinfo
// row. A hint read before a recommit therefore fails as uncommitted.
export const committedEdgeHintSchema = z.object({
	storePathHash: storePathHashSchema,
	generation: narInfoGenerationSchema,
	narHash: nixSha256HashSchema
});
export type CommittedEdgeHint = z.infer<typeof committedEdgeHintSchema>;

/**
 * Shared facts prefetched by the front Worker for one negotiation. The Worker
 * reads every NAR hash in the request, so absence from a list means that no row
 * existed at the time of the read. Reuse still requires this tenant's ownership
 * row; global blob state alone never proves availability.
 */
export const negotiateHintsSchema = z.object({
	blobStates: z.array(blobStateHintSchema),
	ownedNarHashes: z.array(nixSha256HashSchema),
	// An older Worker, or a request with no resolved cache, can omit this field.
	// The Durable Object must then read the edges itself.
	committedEdges: z.array(committedEdgeHintSchema).optional()
});
export type NegotiateHints = z.infer<typeof negotiateHintsSchema>;

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

export const hintTtlMs = 30_000;
export const hintCapacity = 64;

/**
 * Stores prefetched negotiation facts until the following dispatch consumes
 * them. Only RPC can stage a value, and the random token is accepted once. If
 * an instance loses or evicts the value, negotiation reads the facts itself.
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
