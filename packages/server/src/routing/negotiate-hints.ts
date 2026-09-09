import {
	nixSha256HashSchema,
	type NixSha256HashString,
	type StoredCache,
	type StorePathHash,
	storePathHashSchema,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { pushIdSchema } from '@cupboard/protocol/upload';
import { parseAuthenticationHeader } from '@cupboard/shared/http';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { z } from 'zod';

import { pushIdSigningKey } from '../blob/push-credential.ts';
import { isPushIdValid } from '../blob/push-id.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { batchNonEmpty } from '../do/bulk.ts';
import { jsonValueLists } from '../do/json-list.ts';
import { type NegotiateHints } from '../do/negotiate-hints.ts';

// Hint reads happen before the Durable Object authenticates the request. Bound
// their size here; larger negotiations proceed without hints and read the facts
// after authentication.
const hintPathCap = 10_000;

// Parse only the fields needed for the optional hint. The Durable Object still
// validates the complete request against the protocol schema.
const hintPathSchema = z.object({
	narHash: nixSha256HashSchema,
	storePathHash: storePathHashSchema
});
const lenientNegotiateBodySchema = z.object({
	pushId: pushIdSchema,
	paths: z.array(hintPathSchema).min(1).max(hintPathCap)
});

/**
 * Prefetches shared blob and reference facts before dispatching a negotiation.
 * The Durable Object holds the access-token keys, so this Worker authorises the
 * prefetch with the HMAC-signed push ID instead. Missing credentials, invalid
 * input, an invalid push ID, or an oversized request disables the optimisation.
 */
export async function computeNegotiateHints(
	request: Request,
	env: Env,
	tenant: TenantId,
	cache: StoredCache | undefined
): Promise<NegotiateHints | undefined> {
	if (
		parseAuthenticationHeader(
			request.headers.get('authorization') ?? undefined,
			'Bearer'
		) === undefined
	) {
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
		if (
			!(await isPushIdValid(
				pushIdSigningKey(env),
				parsed.data.pushId,
				tenant,
				new Date()
			))
		) {
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

	try {
		return await readHints(database, tenant, cache, narHashes, storePathHashes);
	} catch {
		// The hints are an optimisation: a shared-fact read fault dispatches
		// plainly and the Durable Object reads its own facts after
		// authenticating.
		return undefined;
	}
}

async function readHints(
	database: ReturnType<typeof drizzleD1<typeof d1Schema>>,
	tenant: TenantId,
	cache: StoredCache | undefined,
	narHashes: readonly NixSha256HashString[],
	storePathHashes: readonly StorePathHash[]
): Promise<NegotiateHints> {
	// Each list is bound as one parameter, so a negotiation of any size reads
	// each fact with one statement. The queries still go out as one D1 batch.
	const blobStateQueries = jsonValueLists(narHashes).map((list) =>
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
			.where(inArray(d1Schema.blobState.narHash, list))
	);
	const ownedQueries = jsonValueLists(narHashes).map((list) =>
		database
			.select({ narHash: d1Schema.tenantBlob.narHash })
			.from(d1Schema.tenantBlob)
			.where(
				and(
					eq(d1Schema.tenantBlob.tenant, tenant),
					inArray(d1Schema.tenantBlob.narHash, list)
				)
			)
	);
	const edgeQueries =
		cache === undefined
			? []
			: jsonValueLists(storePathHashes).map((list) =>
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
								inArray(d1Schema.blobReference.storePathHash, list)
							)
						)
				);

	const [blobStatePages, ownedPages, edgePages] = await Promise.all([
		batchNonEmpty(database, blobStateQueries),
		batchNonEmpty(database, ownedQueries),
		cache === undefined
			? Promise.resolve(undefined)
			: batchNonEmpty(database, edgeQueries)
	]);

	return {
		blobStates: blobStatePages.flat(),
		ownedNarHashes: ownedPages.flat().map((row) => row.narHash),
		committedEdges: edgePages?.flat()
	};
}
