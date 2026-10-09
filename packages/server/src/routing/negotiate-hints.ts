import {
	type CacheScope,
	nixSha256HashSchema,
	type NixSha256HashString,
	type StorePathHash,
	storePathHashSchema,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { pushIdSchema } from '@cupboard/protocol/upload';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { z } from 'zod';

import { pushIdSigningKey } from '../blob/push-credential.ts';
import { isPushIdValid } from '../blob/push-id.ts';
import { cacheIdentityCondition } from '../db/cache.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { batchNonEmpty } from '../do/bulk.ts';
import { type JsonValueList, jsonValueLists } from '../do/json-list.ts';
import { type NegotiateHints } from '../do/negotiate-hints.ts';
import {
	readableReferenceSelect,
	reusableReference
} from '../do/reuse-authority.ts';

import { tenantServer } from './durable-object.ts';

// Larger negotiations proceed without hints and read the facts in the object.
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
 * The Durable Object checks the access token and its cache grant before any
 * shared D1 fact read. Invalid input or credentials disable the optimisation.
 */
export async function computeNegotiateHints(
	request: Request,
	env: Env,
	tenant: TenantId,
	cache: CacheScope
): Promise<NegotiateHints | undefined> {
	const authorization = request.headers.get('authorization');

	if (authorization === null) {
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

	try {
		if (
			!(await tenantServer(env, tenant).authoriseNegotiateHints(
				authorization,
				cache
			))
		) {
			return undefined;
		}
	} catch {
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
		// plainly and the Durable Object reads its own facts.
		return undefined;
	}
}

type HintDatabase = ReturnType<typeof drizzleD1<typeof d1Schema>>;

// The three fact reads a negotiation issues. Each binds its list as one
// parameter. The parameter test imports these builders.
export function blobStateHintSelect(
	database: HintDatabase,
	narHashes: JsonValueList<NixSha256HashString>
) {
	return database
		.select({
			narHash: d1Schema.blobState.narHash,
			fileHash: d1Schema.blobState.fileHash,
			fileSize: d1Schema.blobState.fileSize,
			compression: d1Schema.blobState.compression,
			narSize: d1Schema.blobState.narSize,
			deleteAfter: d1Schema.blobState.deleteAfter
		})
		.from(d1Schema.blobState)
		.where(inArray(d1Schema.blobState.narHash, narHashes));
}

export function committedEdgeHintSelect(
	database: HintDatabase,
	tenant: TenantId,
	cache: CacheScope,
	storePathHashes: JsonValueList<StorePathHash>
) {
	return database
		.select({
			storePathHash: d1Schema.blobReference.storePathHash,
			generation: d1Schema.blobReference.generation,
			narHash: d1Schema.blobReference.narHash
		})
		.from(d1Schema.blobReference)
		.where(
			and(
				eq(d1Schema.blobReference.tenant, tenant),
				cacheIdentityCondition(
					d1Schema.blobReference.cacheKind,
					d1Schema.blobReference.cacheName,
					cache
				),
				inArray(d1Schema.blobReference.storePathHash, storePathHashes)
			)
		);
}

async function readHints(
	database: HintDatabase,
	tenant: TenantId,
	cache: CacheScope,
	narHashes: readonly NixSha256HashString[],
	storePathHashes: readonly StorePathHash[]
): Promise<NegotiateHints> {
	// Each list is bound as one parameter, so a negotiation of any size reads
	// each fact with one statement. The queries still go out as one D1 batch.
	const blobStateQueries = jsonValueLists(narHashes).map((list) =>
		blobStateHintSelect(database, list)
	);
	const referenceQueries = jsonValueLists(narHashes).map((list) =>
		readableReferenceSelect(database, tenant, list)
	);
	const edgeQueries = jsonValueLists(storePathHashes).map((list) =>
		committedEdgeHintSelect(database, tenant, cache, list)
	);

	const [blobStatePages, referencePages, edgePages] = await Promise.all([
		batchNonEmpty(database, blobStateQueries),
		batchNonEmpty(database, referenceQueries),
		batchNonEmpty(database, edgeQueries)
	]);

	return {
		blobStates: blobStatePages.flat(),
		reusableReferences: referencePages
			.flat()
			.map((row) => reusableReference(row)),
		committedEdges: edgePages.flat()
	};
}
