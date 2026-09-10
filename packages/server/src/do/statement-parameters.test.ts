// Cloudflare's D1 and Durable Object SQLite runtimes accept at most 100 bound
// parameters in one query, and both bindings refuse a statement above that.
// Every statement here works from a list, and binds it as one JSON parameter,
// so its parameter count belongs to the statement rather than to the list.
//
// Each case builds a production statement from a list of one value and from a
// list of 10,000 and compares the two counts. A statement that started binding
// a parameter for each value again would fail the comparison long before it
// reached the limit itself.
import {
	cacheNameSchema,
	type CacheScope,
	narInfoGenerationSchema,
	nixSha256HashSchema,
	type NixSha256HashString,
	predicateTypeSchema,
	rootNameSchema,
	type Sha256HexDigest,
	sha256HexDigestSchema,
	type StorePathHash,
	storePathHashSchema,
	storePathSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { reuseViewNameSchema } from '@cupboard/protocol/reuse-views';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { uploadIdSchema } from '@cupboard/protocol/upload';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { drizzle as drizzleDurable } from 'drizzle-orm/durable-sqlite';
import { describe, expect, it } from 'vitest';

import { cacheIdentityCondition, cacheIdSchema } from '../db/cache.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { narInfoReferenceQuery } from '../read/read.ts';
import { buildStampMaintainedStatement } from '../routing/scheduled.ts';

import {
	buildBlobCollection,
	buildCasCollection,
	fencedBlobStateDeletion,
	fencedCasObjectDeletion
} from './blob-reaper-service.ts';
import {
	cacheReferenceSelect,
	capturedReferenceSelect,
	fencedEdgeRetirement,
	teardownPresenceBatch
} from './deletion-queue-service.ts';
import { expiredRootTargetSelect } from './garbage-collection-service.ts';
import { jsonRowLists, jsonValueLists } from './json-list.ts';
import {
	type AttestationReferenceKey,
	attestationReferenceMatch,
	type BlobReferenceKey,
	blobReferenceMatch,
	buildTenantBlobDeleteStatement,
	buildTenantCasBlobDeleteStatement
} from './offboarding-service.ts';
import {
	reuseViewSelectorInsert,
	type StoredReuseViewSelector
} from './reuse-view-admin-service.ts';
import { reuseEdgeSelect } from './reuse-view-lookup-service.ts';
import { buildLeaseUpdate } from './verification-service.ts';

const throwStub = (): never => {
	throw new Error('D1 stub: not executed');
};

const stubD1 = {
	prepare: throwStub,
	batch: throwStub,
	exec: throwStub,
	withSession: throwStub,
	dump: throwStub
} satisfies D1Database;

const database = drizzle(stubD1, { schema: d1Schema });
// The verification and garbage-collection statements run on Durable Object
// SQLite. Use its Drizzle driver so the generated SQL matches production.
const doDatabase = drizzleDurable({ exec: throwStub } as never, { schema });
const tenant = tenantIdSchema.parse('fixture-tenant');
const cache = cacheNameSchema.parse('builds');
const cacheScope: CacheScope = { kind: 'named', name: cache };
const cacheId = cacheIdSchema.parse(1);
const now = isoTimestampSchema.parse('2024-01-01T00:00:00.000Z');

const testNarHash = nixSha256HashSchema.parse(
	'sha256:0000000000000000000000000000000000000000000000000000'
);

const testStorePathHash = storePathHashSchema.parse(
	'00000000000000000000000000000000'
);
const testStorePath = storePathSchema.parse(
	`/nix/store/${testStorePathHash}-fixture`
);
const testRootName = rootNameSchema.parse('main');
const testDigest = sha256HexDigestSchema.parse('0'.repeat(64));
const testGeneration = narInfoGenerationSchema.parse(0);
const testReuseView = reuseViewNameSchema.parse('shared');
const testUploadId = uploadIdSchema.parse('01J0000000000000000000000A');

function narHashes(count: number): NixSha256HashString[] {
	return Array.from({ length: count }, () => testNarHash);
}

function digests(count: number): Sha256HexDigest[] {
	return Array.from({ length: count }, () => testDigest);
}

function storePathHashes(count: number): StorePathHash[] {
	return Array.from({ length: count }, () => testStorePathHash);
}

function repeated<T>(count: number, row: T): T[] {
	return Array.from({ length: count }, () => row);
}

/**
The first of the lists a set of values produces. A long set can serialise to
more than one bound string, and each list builds the same statement, so the
first one answers the question these cases ask.
*/
function firstList<T>(lists: readonly T[]): T {
	const [list] = lists;

	if (list === undefined) {
		throw new Error('the values produced no bound list');
	}

	return list;
}

function narHashList(count: number) {
	return firstList(jsonValueLists(narHashes(count)));
}

function digestList(count: number) {
	return firstList(jsonValueLists(digests(count)));
}

function storePathList(count: number) {
	return firstList(jsonValueLists(storePathHashes(count)));
}

function rowList<T extends { readonly [K in keyof T]: string | number }>(
	count: number,
	row: T
) {
	return firstList(jsonRowLists(repeated(count, row)));
}

// `readHints` issues one query for each fact a negotiation needs. Each binds its
// list as one parameter, so the count comes from the query and not from the
// closure being negotiated.
function blobStateParameters(hashes: number): number {
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
		.where(inArray(d1Schema.blobState.narHash, narHashList(hashes)))
		.toSQL().params.length;
}

function ownedParameters(hashes: number): number {
	const list = narHashList(hashes);

	return database
		.select({ narHash: d1Schema.tenantBlob.narHash })
		.from(d1Schema.tenantBlob)
		.where(
			and(
				eq(d1Schema.tenantBlob.tenant, tenant),
				inArray(d1Schema.tenantBlob.narHash, list)
			)
		)
		.toSQL().params.length;
}

function edgeParameters(paths: number): number {
	const list = storePathList(paths);

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
					cacheScope
				),
				inArray(d1Schema.blobReference.storePathHash, list)
			)
		)
		.toSQL().params.length;
}

// The filter binds the tenant, the cache, the store path list and the two
// generation literals the lifecycle comparison embeds.
function referenceParameters(paths: number): number {
	return narInfoReferenceQuery(
		database,
		tenant,
		cacheScope,
		storePathList(paths)
	).toSQL().params.length;
}

function stampMaintainedParameters(tenants: number): number {
	const ids = repeated(tenants, tenantIdSchema.parse('fixture-tenant'));
	const list = firstList(jsonValueLists(ids));

	return buildStampMaintainedStatement(database, list, now).toSQL().params
		.length;
}

function presenceCreditParameters(hashes: number): number {
	return teardownPresenceBatch(
		database,
		tenant,
		narHashList(hashes),
		now
	).update.toSQL().params.length;
}

function presenceDeleteParameters(hashes: number): number {
	return teardownPresenceBatch(
		database,
		tenant,
		narHashList(hashes),
		now
	).presenceDelete.toSQL().params.length;
}

function retiredEdges(paths: number) {
	return rowList(paths, {
		storePathHash: testStorePathHash,
		narHash: testNarHash,
		generation: testGeneration
	});
}

function edgeCreditParameters(paths: number): number {
	return fencedEdgeRetirement(
		database,
		tenant,
		cacheScope,
		retiredEdges(paths),
		now
	).creditUpdate.toSQL().params.length;
}

function edgeDeleteParameters(paths: number): number {
	return fencedEdgeRetirement(
		database,
		tenant,
		cacheScope,
		retiredEdges(paths),
		now
	).edgeDelete.toSQL().params.length;
}

function blobReferenceDeleteParameters(edges: number): number {
	const rows = rowList<BlobReferenceKey>(edges, {
		cacheKind: 'named',
		cacheName: cache,
		storePathHash: testStorePathHash,
		generation: testGeneration
	});

	return database
		.delete(d1Schema.blobReference)
		.where(
			and(eq(d1Schema.blobReference.tenant, tenant), blobReferenceMatch(rows))
		)
		.toSQL().params.length;
}

function attestationReferenceDeleteParameters(references: number): number {
	const rows = rowList<AttestationReferenceKey>(references, {
		cacheKind: 'named',
		cacheName: cache,
		storePathHash: testStorePathHash,
		generation: testGeneration,
		predicateType: predicateTypeSchema.parse('https://slsa.dev/provenance/v1'),
		digest: testDigest
	});

	return database
		.delete(d1Schema.attestationReference)
		.where(
			and(
				eq(d1Schema.attestationReference.tenant, tenant),
				attestationReferenceMatch(rows)
			)
		)
		.toSQL().params.length;
}

function blobStateVersions(objects: number) {
	return rowList(objects, { narHash: testNarHash, incarnation: 1 });
}

function casObjectVersions(objects: number) {
	return rowList(objects, { digest: testDigest, incarnation: 1 });
}

function tenantBlobDeleteParameters(hashes: number): number {
	return buildTenantBlobDeleteStatement(
		database,
		tenant,
		narHashList(hashes)
	).toSQL().params.length;
}

function tenantCasBlobDeleteParameters(objects: number): number {
	return buildTenantCasBlobDeleteStatement(
		database,
		tenant,
		digestList(objects)
	).toSQL().params.length;
}

function rootTargetInsertParameters(targets: number): number {
	const rows = rowList(targets, {
		storePathHash: testStorePathHash,
		storePath: testStorePath
	});

	return doDatabase
		.insert(schema.retentionRootTargets)
		.select(
			rows.insertSource([
				sql`${cache}`,
				sql`${testRootName}`,
				rows.column('storePathHash'),
				rows.column('storePath')
			])
		)
		.toSQL().params.length;
}

// Any page size does here: the limit binds one parameter whatever its value,
// so only the root list could grow the parameter count.
const expiredRootTargetPage = 1000;

function expiredRootTargetParameters(roots: number): number {
	const list = firstList(jsonValueLists(repeated(roots, testRootName)));

	return expiredRootTargetSelect(
		doDatabase,
		cacheId,
		list,
		expiredRootTargetPage
	).toSQL().params.length;
}

// The chunk of paths a teardown retires reaches these statements as a list, so
// the count comes from the statement rather than from the chunk size.
function capturedReferenceParameters(paths: number): number {
	return capturedReferenceSelect(
		database,
		tenant,
		cacheScope,
		retiredEdges(paths),
		46
	).toSQL().params.length;
}

function cacheReferenceParameters(hashes: number): number {
	return cacheReferenceSelect(
		database,
		tenant,
		cacheScope,
		narHashList(hashes)
	).toSQL().params.length;
}

// A path one view holds in many caches reaches the edge lookup as one row list,
// so the count comes from the statement rather than from the number of caches.
function reuseEdgeParameters(candidates: number): number {
	const rows = rowList(candidates, {
		cacheKind: 'named' as const,
		cacheName: cache,
		storePathHash: testStorePathHash,
		generation: testGeneration
	});

	return reuseEdgeSelect(database, tenant, 'public', rows).toSQL().params
		.length;
}

function reuseViewSelectorParameters(selectors: number): number {
	const rows = rowList<StoredReuseViewSelector>(selectors, {
		kind: 'prefix',
		cacheName: '',
		prefix: 'builds'
	});

	return reuseViewSelectorInsert(doDatabase, testReuseView, rows).toSQL().params
		.length;
}

function leaseParameters(uploads: number): number {
	const list = firstList(jsonValueLists(repeated(uploads, testUploadId)));

	return buildLeaseUpdate(doDatabase, list, now, 'owner').toSQL().params.length;
}

// Each statement is built from a list of one value and from a list of 10,000.
// The parameter count belongs to the statement, so the two must agree.
const listStatements: readonly {
	readonly statement: string;
	readonly parameters: (values: number) => number;
}[] = [
	{ statement: 'negotiate blob_state SELECT', parameters: blobStateParameters },
	{ statement: 'negotiate owned-blobs SELECT', parameters: ownedParameters },
	{ statement: 'negotiate committed-edge SELECT', parameters: edgeParameters },
	{
		statement: 'private narinfo reference SELECT',
		parameters: referenceParameters
	},
	{
		statement: 'maintenance stamp UPDATE',
		parameters: stampMaintainedParameters
	},
	{
		statement: 'teardown presence credit UPDATE',
		parameters: presenceCreditParameters
	},
	{
		statement: 'teardown presence DELETE',
		parameters: presenceDeleteParameters
	},
	{ statement: 'retirement credit UPDATE', parameters: edgeCreditParameters },
	{ statement: 'retirement edge DELETE', parameters: edgeDeleteParameters },
	{
		statement: 'offboarding blob-reference DELETE',
		parameters: blobReferenceDeleteParameters
	},
	{
		statement: 'offboarding attestation-reference DELETE',
		parameters: attestationReferenceDeleteParameters
	},
	{
		statement: 'offboarding tenant_blob DELETE',
		parameters: tenantBlobDeleteParameters
	},
	{
		statement: 'offboarding tenant_cas_blob DELETE',
		parameters: tenantCasBlobDeleteParameters
	},
	{
		statement: 'reaper registry UPDATE',
		parameters: (objects) =>
			buildBlobCollection(database, narHashList(objects), now).retire.toSQL()
				.params.length
	},
	{
		statement: 'reaper deletion-queue INSERT',
		parameters: (objects) =>
			buildBlobCollection(
				database,
				narHashList(objects),
				now
			).queueDeletion.toSQL().params.length
	},
	{
		statement: 'reaper collection DELETE',
		parameters: (objects) =>
			buildBlobCollection(database, narHashList(objects), now).remove.toSQL()
				.params.length
	},
	{
		statement: 'reaper CAS registry UPDATE',
		parameters: (objects) =>
			buildCasCollection(database, digestList(objects), now).retire.toSQL()
				.params.length
	},
	{
		statement: 'reaper fenced registry UPDATE',
		parameters: (objects) =>
			fencedBlobStateDeletion(
				database,
				blobStateVersions(objects)
			).retire.toSQL().params.length
	},
	{
		statement: 'reaper fenced blob_state DELETE',
		parameters: (objects) =>
			fencedBlobStateDeletion(
				database,
				blobStateVersions(objects)
			).remove.toSQL().params.length
	},
	{
		statement: 'reaper fenced cas_object DELETE',
		parameters: (objects) =>
			fencedCasObjectDeletion(
				database,
				casObjectVersions(objects)
			).remove.toSQL().params.length
	},
	{
		statement: 'teardown attestation-reference SELECT',
		parameters: capturedReferenceParameters
	},
	{
		statement: 'teardown cache-reference SELECT',
		parameters: cacheReferenceParameters
	},
	{
		statement: 'reuse view selector INSERT',
		parameters: reuseViewSelectorParameters
	},
	{ statement: 'reuse view edge SELECT', parameters: reuseEdgeParameters },
	{ statement: 'verification claim lease UPDATE', parameters: leaseParameters },
	{ statement: 'root target INSERT', parameters: rootTargetInsertParameters },
	{
		statement: 'expired root target SELECT',
		parameters: expiredRootTargetParameters
	}
];

describe('statements built from a list', () => {
	it.each(listStatements)(
		'$statement binds the same parameters for 10,000 values as for one',
		({ parameters }) => {
			expect(parameters(10_000)).toStrictEqual(parameters(1));
		}
	);
});
