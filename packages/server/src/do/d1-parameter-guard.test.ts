// Guards Cloudflare SQLite's 100-bound-parameter cap for selected statements
// that use production chunk limits. Local SQLite in workerd and
// vitest-pool-workers allows 32,766 variables, so worker tests do not expose an
// overrun. This Node test inspects `.toSQL().params` before execution.
//
// Each case builds one selected statement at its maximum production chunk
// width. Widening that chunk or adding a bound parameter must keep the statement
// at or below the Cloudflare limit.
import {
	cacheNameSchema,
	narInfoGenerationSchema,
	nixSha256HashSchema,
	type NixSha256HashString,
	predicateTypeSchema,
	rootNameSchema,
	type Sha256HexDigest,
	sha256HexDigestSchema,
	storePathHashSchema,
	storePathSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { buildStampMaintainedStatement } from '../routing/scheduled.ts';

import {
	buildBlobCollection,
	buildCasCollection,
	maxCollectionChunk
} from './blob-reaper-service.ts';
import { maxInClauseValues } from './bulk.ts';
import {
	maxTeardownPresenceChunk,
	teardownPresenceBatch
} from './deletion-queue-service.ts';
import {
	attestationReferenceDeleteChunk,
	type AttestationReferenceKey,
	attestationReferenceMatch,
	blobReferenceDeleteChunk,
	type BlobReferenceKey,
	blobReferenceMatch,
	buildTenantBlobDeleteStatement,
	buildTenantCasBlobDeleteStatement
} from './offboarding-service.ts';
import { maxRootTargetInsertRows } from './roots-service.ts';

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
const tenant = tenantIdSchema.parse('fixture-tenant');
const cache = cacheNameSchema.parse('builds');
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

function narHashes(count: number): NixSha256HashString[] {
	return Array.from({ length: count }, () => testNarHash);
}

function digests(count: number): Sha256HexDigest[] {
	return Array.from({ length: count }, () =>
		sha256HexDigestSchema.parse('0'.repeat(64))
	);
}

function fencedEdgeFilter(count: number) {
	return and(
		eq(d1Schema.blobReference.tenant, tenant),
		eq(d1Schema.blobReference.cache, cache),
		or(
			...Array.from({ length: count }, () =>
				and(
					eq(d1Schema.blobReference.storePathHash, testStorePathHash),
					eq(
						d1Schema.blobReference.generation,
						narInfoGenerationSchema.parse(0)
					)
				)
			)
		)
	);
}

describe('selected D1 statements', () => {
	describe('retention-root target writes (roots-service)', () => {
		it('target INSERT stays within 100 params at maxRootTargetInsertRows', () => {
			const query = database.insert(schema.retentionRootTargets).values(
				Array.from({ length: maxRootTargetInsertRows }, () => ({
					cache,
					rootName: testRootName,
					storePathHash: testStorePathHash,
					storePath: testStorePath
				}))
			);

			expect(query.toSQL().params.length).toBeLessThanOrEqual(100);
		});
	});

	describe('teardown presence delete (deletion-queue-service)', () => {
		it('credit UPDATE stays within 100 params at maxTeardownPresenceChunk', () => {
			const { update } = teardownPresenceBatch(
				database,
				tenant,
				narHashes(maxTeardownPresenceChunk),
				now
			);

			expect(update.toSQL().params.length).toBeLessThanOrEqual(100);
		});

		it('presence DELETE stays within 100 params at maxTeardownPresenceChunk', () => {
			const { presenceDelete } = teardownPresenceBatch(
				database,
				tenant,
				narHashes(maxTeardownPresenceChunk),
				now
			);

			expect(presenceDelete.toSQL().params.length).toBeLessThanOrEqual(100);
		});
	});

	describe('fenced edge retirement (deletion-queue-service)', () => {
		// The fenced edge retirement batches entries with maxFencedRetireRows =
		// Math.floor(maxInClauseValues / 2) = 45 entries per chunk. Each entry
		// contributes two parameters (storePathHash, generation) to the OR list, plus
		// tenant(1) and cache(1) on the outer filter, and the subquery repeats those
		// 2N+2 params. The UPDATE total is 2N+4, the DELETE total is 2N+2.
		const maxFencedRetireRows = Math.floor(maxInClauseValues / 2);

		it('narinfos credit UPDATE stays within 100 params at maxFencedRetireRows', () => {
			const edgeFilter = fencedEdgeFilter(maxFencedRetireRows);
			const edgeCount = database
				.select({ count: sql<number>`count(*)` })
				.from(d1Schema.blobReference)
				.where(edgeFilter);

			const update = database
				.update(d1Schema.tenantUsage)
				.set({
					narinfos: sql`${d1Schema.tenantUsage.narinfos} - (${edgeCount})`,
					updatedAt: now
				})
				.where(eq(d1Schema.tenantUsage.tenant, tenant));

			expect(update.toSQL().params.length).toBeLessThanOrEqual(100);
		});

		it('edge DELETE stays within 100 params at maxFencedRetireRows', () => {
			const edgeFilter = fencedEdgeFilter(maxFencedRetireRows);
			const del = database.delete(d1Schema.blobReference).where(edgeFilter);

			expect(del.toSQL().params.length).toBeLessThanOrEqual(100);
		});
	});

	describe('offboarding reference deletes (offboarding-service)', () => {
		it('blob-reference DELETE stays within 100 params at blobReferenceDeleteChunk', () => {
			const rows: BlobReferenceKey[] = Array.from(
				{ length: blobReferenceDeleteChunk },
				() => ({
					cache,
					storePathHash: testStorePathHash,
					generation: narInfoGenerationSchema.parse(0)
				})
			);
			const inBatch = or(...rows.map((row) => blobReferenceMatch(row)));
			const del = database
				.delete(d1Schema.blobReference)
				.where(and(eq(d1Schema.blobReference.tenant, tenant), inBatch));

			expect(del.toSQL().params.length).toBeLessThanOrEqual(100);
		});

		it('attestation-reference DELETE stays within 100 params at attestationReferenceDeleteChunk', () => {
			const rows: AttestationReferenceKey[] = Array.from(
				{ length: attestationReferenceDeleteChunk },
				() => ({
					cache,
					storePathHash: testStorePathHash,
					generation: narInfoGenerationSchema.parse(0),
					predicateType: predicateTypeSchema.parse(
						'https://slsa.dev/provenance/v1'
					),
					digest: sha256HexDigestSchema.parse('0'.repeat(64))
				})
			);
			const inBatch = or(...rows.map((row) => attestationReferenceMatch(row)));
			const del = database
				.delete(d1Schema.attestationReference)
				.where(and(eq(d1Schema.attestationReference.tenant, tenant), inBatch));

			expect(del.toSQL().params.length).toBeLessThanOrEqual(100);
		});
	});

	describe('reaper fenced deletes (blob-reaper-service)', () => {
		// blob-reaper-service.ts uses maxFencedDeleteRows = Math.floor(90 / 2) = 45.
		// Each row contributes two parameters (narHash, verifiedAt) to the OR list,
		// with no outer tenant/cache filter, so the DELETE binds 2 * 45 = 90 params.
		const maxFencedDeleteRows = Math.floor(maxInClauseValues / 2);

		it('blob_state DELETE stays within 100 params at maxFencedDeleteRows', () => {
			const blobStatePair = and(
				eq(d1Schema.blobState.narHash, testNarHash),
				eq(d1Schema.blobState.verifiedAt, now)
			);
			const match = or(
				...Array.from({ length: maxFencedDeleteRows }, () => blobStatePair)
			);
			const del = database
				.delete(d1Schema.blobState)
				.where(match)
				.returning({ narHash: d1Schema.blobState.narHash });

			expect(del.toSQL().params.length).toBeLessThanOrEqual(100);
		});

		it('cas_object DELETE stays within 100 params at maxFencedDeleteRows', () => {
			const testDigest = sha256HexDigestSchema.parse('0'.repeat(64));
			const casObjectPair = and(
				eq(d1Schema.casObject.digest, testDigest),
				eq(d1Schema.casObject.storedAt, now)
			);
			const match = or(
				...Array.from({ length: maxFencedDeleteRows }, () => casObjectPair)
			);
			const del = database
				.delete(d1Schema.casObject)
				.where(match)
				.returning({ digest: d1Schema.casObject.digest });

			expect(del.toSQL().params.length).toBeLessThanOrEqual(100);
		});
	});

	describe('negotiate hint reads (routing/negotiate-hints)', () => {
		// computeNegotiateHints in routing/negotiate-hints.ts issues three sets of
		// chunked queries against D1, each chunk at most maxInClauseValues = 90 wide.
		// The blobState query binds N params, the owned query binds N+1 (tenant), and
		// the edge query binds N+2 (tenant + cache).

		it('blob_state SELECT stays within 100 params at maxInClauseValues', () => {
			const query = database
				.select({
					narHash: d1Schema.blobState.narHash,
					fileHash: d1Schema.blobState.fileHash,
					fileSize: d1Schema.blobState.fileSize,
					compression: d1Schema.blobState.compression,
					narSize: d1Schema.blobState.narSize,
					deleteAfter: d1Schema.blobState.deleteAfter
				})
				.from(d1Schema.blobState)
				.where(
					inArray(d1Schema.blobState.narHash, narHashes(maxInClauseValues))
				);

			expect(query.toSQL().params.length).toBeLessThanOrEqual(100);
		});

		it('owned-blobs SELECT stays within 100 params at maxInClauseValues', () => {
			const ownedHashes = narHashes(maxInClauseValues);
			const query = database
				.select({ narHash: d1Schema.tenantBlob.narHash })
				.from(d1Schema.tenantBlob)
				.where(
					and(
						eq(d1Schema.tenantBlob.tenant, tenant),
						inArray(d1Schema.tenantBlob.narHash, ownedHashes)
					)
				);

			expect(query.toSQL().params.length).toBeLessThanOrEqual(100);
		});

		it('committed-edge SELECT stays within 100 params at maxInClauseValues', () => {
			const storePaths = Array.from(
				{ length: maxInClauseValues },
				() => testStorePathHash
			);
			const query = database
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
						inArray(d1Schema.blobReference.storePathHash, storePaths)
					)
				);

			expect(query.toSQL().params.length).toBeLessThanOrEqual(100);
		});
	});

	describe('maintenance stamp UPDATE (routing/scheduled)', () => {
		it('stampMaintained UPDATE stays within 100 params at maxInClauseValues', () => {
			const tenantIds = Array.from({ length: maxInClauseValues }, (_, index) =>
				tenantIdSchema.parse(`tenant-${String(index)}`)
			);
			const update = buildStampMaintainedStatement(database, tenantIds, now);

			expect(update.toSQL().params.length).toBeLessThanOrEqual(100);
		});
	});

	describe('offboarding presence deletes (offboarding-service)', () => {
		it('tenant_blob DELETE stays within 100 params at maxInClauseValues', () => {
			const narHashList = narHashes(maxInClauseValues);
			const del = buildTenantBlobDeleteStatement(database, tenant, narHashList);

			expect(del.toSQL().params.length).toBeLessThanOrEqual(100);
		});

		it('tenant_cas_blob DELETE stays within 100 params at maxInClauseValues', () => {
			const digests = Array.from({ length: maxInClauseValues }, () =>
				sha256HexDigestSchema.parse('0'.repeat(64))
			);
			const del = buildTenantCasBlobDeleteStatement(database, tenant, digests);

			expect(del.toSQL().params.length).toBeLessThanOrEqual(100);
		});
	});
	// The registry update binds the object-id list twice, so it reaches the cap
	// at half the width the other two statements manage. Each case builds the
	// widest chunk the reaper produces.
	describe('expired object collection (blob-reaper-service)', () => {
		it('registry UPDATE stays within 100 params at maxCollectionChunk', () => {
			const { retire } = buildBlobCollection(
				database,
				narHashes(maxCollectionChunk),
				now
			);

			expect(retire.toSQL().params.length).toBeLessThanOrEqual(100);
		});

		it('deletion-queue INSERT stays within 100 params at maxCollectionChunk', () => {
			const { queueDeletion } = buildBlobCollection(
				database,
				narHashes(maxCollectionChunk),
				now
			);

			expect(queueDeletion.toSQL().params.length).toBeLessThanOrEqual(100);
		});

		it('fenced DELETE stays within 100 params at maxCollectionChunk', () => {
			const { remove } = buildBlobCollection(
				database,
				narHashes(maxCollectionChunk),
				now
			);

			expect(remove.toSQL().params.length).toBeLessThanOrEqual(100);
		});

		it('CAS registry UPDATE stays within 100 params at maxCollectionChunk', () => {
			const { retire } = buildCasCollection(
				database,
				digests(maxCollectionChunk),
				now
			);

			expect(retire.toSQL().params.length).toBeLessThanOrEqual(100);
		});
	});
});
