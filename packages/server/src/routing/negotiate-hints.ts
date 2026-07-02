import {
	nixSha256HashSchema,
	storePathHashSchema,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { z } from 'zod';

import { pushIdSigningKey } from '../blob/push-credential.ts';
import { verifyPushId } from '../blob/push-id.ts';
import * as d1Schema from '../db/d1-schema.ts';
import {
	chunk,
	mapWithConcurrency,
	maxInClauseValues,
	maxOutgoingConnections
} from '../do/bulk.ts';
import { type NegotiateHints } from '../do/negotiate-hints.ts';

// The most paths a negotiate may carry for the Worker to compute hints. The
// hints are read before the Durable Object authenticates the bearer, so the
// reads are gated on the body's signed push id and bounded here; a larger
// body dispatches plainly and the Durable Object reads its own facts after
// authenticating.
const hintPathCap = 10_000;

// Just the fields the hint reads key on, tolerant of everything else in the
// body: the Durable Object's contract schema stays the authority, and a body
// this parse rejects simply dispatches without hints.
const hintPathSchema = z.object({
	narHash: nixSha256HashSchema,
	storePathHash: storePathHashSchema
});
const lenientNegotiateBodySchema = z.object({
	pushId: z.string(),
	paths: z.array(hintPathSchema).min(1).max(hintPathCap)
});

/**
 * Computes the shared-fact reads for a negotiate in the front Worker: the
 * `blob_state` rows and this tenant's presence edges for the requested NAR
 * hashes. The reads run before the Durable Object authenticates the bearer
 * (only it holds the verification keys), so they are gated on the body's push
 * id instead: it is HMAC-signed under the Worker's own key and only issued to
 * an authenticated push, so one local HMAC bounds the D1 reads an
 * unauthenticated request can cause to none. Anything unexpected (no bearer
 * token, an unverifiable push id, an unparseable body, too many paths)
 * returns undefined and the request dispatches without hints.
 */
export async function computeNegotiateHints(
	request: Request,
	env: Env,
	tenant: TenantId,
	cache: string | undefined
): Promise<NegotiateHints | undefined> {
	if (request.headers.get('authorization') === null) {
		return undefined;
	}

	let body: unknown;

	try {
		body = await request.clone().json();
	} catch {
		return undefined;
	}

	const parsed = lenientNegotiateBodySchema.safeParse(body);

	if (!parsed.success) {
		return undefined;
	}

	try {
		if (!(await verifyPushId(pushIdSigningKey(env), parsed.data.pushId))) {
			return undefined;
		}
	} catch {
		// A missing signing key must not fail the negotiate itself; the request
		// dispatches without hints and the Durable Object answers as it will.
		return undefined;
	}

	const narHashes = [...new Set(parsed.data.paths.map((path) => path.narHash))];
	const storePathHashes = [
		...new Set(parsed.data.paths.map((path) => path.storePathHash))
	];
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
	const [blobStatePages, ownedPages, edgePages] = await Promise.all([
		mapWithConcurrency(
			chunk(narHashes, maxInClauseValues),
			maxOutgoingConnections,
			(batch) =>
				database
					.select({
						narHash: d1Schema.blobState.narHash,
						fileHash: d1Schema.blobState.fileHash,
						fileSize: d1Schema.blobState.fileSize,
						compression: d1Schema.blobState.compression,
						narSize: d1Schema.blobState.narSize,
						deleteAfter: d1Schema.blobState.deleteAfter
					})
					.from(d1Schema.blobState)
					.where(inArray(d1Schema.blobState.narHash, batch))
					.all()
		),
		mapWithConcurrency(
			chunk(narHashes, maxInClauseValues),
			maxOutgoingConnections,
			(batch) =>
				database
					.select({ narHash: d1Schema.tenantBlob.narHash })
					.from(d1Schema.tenantBlob)
					.where(
						and(
							eq(d1Schema.tenantBlob.tenant, tenant),
							inArray(d1Schema.tenantBlob.narHash, batch)
						)
					)
					.all()
		),
		cache === undefined
			? undefined
			: mapWithConcurrency(
					chunk(storePathHashes, maxInClauseValues),
					maxOutgoingConnections,
					(batch) =>
						database
							.select({
								storePathHash: d1Schema.blobReference.storePathHash,
								generation: d1Schema.blobReference.generation,
								narHash: d1Schema.blobReference.narHash
							})
							.from(d1Schema.blobReference)
							.where(
								and(
									eq(d1Schema.blobReference.tenant, tenant),
									eq(d1Schema.blobReference.cache, cache),
									inArray(d1Schema.blobReference.storePathHash, batch)
								)
							)
							.all()
				)
	]);

	return {
		blobStates: blobStatePages.flat(),
		ownedNarHashes: ownedPages.flat().map((row) => row.narHash),
		committedEdges: edgePages?.flat()
	};
}
