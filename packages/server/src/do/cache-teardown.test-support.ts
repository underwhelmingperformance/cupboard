import { startCapture } from '@cupboard/logger/testing';
import {
	type CacheScope,
	sha256HexDigestSchema
} from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { uploadIdSchema } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { type CacheId, type ResolvedCache } from '../db/cache.ts';
import * as schema from '../db/schema.ts';
import { r2ObjectKeySchema } from '../http/http.ts';
import {
	currentServer,
	narHash,
	syntheticNarHash,
	testPushId,
	uploadMetadata
} from '../test-support.ts';

import { teardownEntryPrefix } from './cache-admin-service.ts';
import { type ServerContext } from './context.ts';

/**
The verdicts of the pending uploads that {@link seedCacheRows} adds to a
cache, one upload for each.
*/
export const seededVerdicts = [
	undefined,
	'pending',
	'committing',
	'servable',
	'mismatch',
	'over-quota'
] as const;

/**
The number of attestation uploads that {@link seedCacheRows} adds to a cache.
*/
export const seededAttestations = 2;

const insertNarInfoRows = `WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < ?2)
	INSERT INTO narinfo (cache_id, store_path_hash, store_path, nar_hash, nar_size, references_json, created_at)
	SELECT ?1, printf('%s%031d', ?3, n), printf('/nix/store/%s%031d-p', ?3, n), ?4, 1, '[]', ?5 FROM sequence`;
const insertRootRow =
	'INSERT INTO retention_root (cache_id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)';
const insertTargetRows = `WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < ?2)
	INSERT INTO retention_root_target (cache_id, root_name, store_path_hash, store_path)
	SELECT ?1, ?3, printf('%s%031d', ?4, n), printf('/nix/store/%s%031d-p', ?4, n) FROM sequence`;
// Half of the deadlines have passed.
const insertGraceRows = `WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < ?2)
	INSERT INTO retention_grace (cache_id, store_path_hash, retain_until)
	SELECT ?1, printf('%s%031d', ?3, n), CASE WHEN n % 2 = 0 THEN '2020-01-01T00:00:00.000Z' ELSE '2099-01-01T00:00:00.000Z' END FROM sequence`;
const insertScanRow =
	"INSERT INTO garbage_collection_scan (cache_id, phase) VALUES (?1, 'mark')";
const insertMarkRows = `WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < ?2)
	INSERT INTO garbage_collection_mark (cache_id, store_path_hash)
	SELECT ?1, printf('%s%031d', ?3, n) FROM sequence`;
const insertFrontierRows = `WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < ?2)
	INSERT INTO garbage_collection_frontier (cache_id, store_path_hash)
	SELECT ?1, printf('%s%031d', ?3, n) FROM sequence`;

const countedTables = {
	narinfo: schema.narInfos,
	narInfoDeletions: schema.narInfoDeletions,
	roots: schema.retentionRoots,
	targets: schema.retentionRootTargets,
	grace: schema.retentionGrace,
	uploads: schema.pendingUploads,
	attestations: schema.pendingAttestations,
	stagingCleanup: schema.stagingCleanup,
	marks: schema.garbageCollectionMarks,
	frontier: schema.garbageCollectionFrontier,
	scans: schema.garbageCollectionScans,
	teardowns: schema.cacheTeardowns
};

/**
What {@link cacheRowCounts} reports for a cache with no rows.
*/
export const noCacheRows: Record<string, number> = Object.fromEntries(
	Object.keys(countedTables).map((name) => [name, 0])
);

function inAnHour(): Date {
	return new Date(Date.now() + 60 * 60 * 1000);
}

function uploadId(cacheId: CacheId, index: number) {
	return uploadIdSchema.parse(
		(cacheId * 16 + index).toString(16).padStart(64, '0')
	);
}

/**
The staged objects of the uploads and attestation uploads that
{@link seedCacheRows} adds to a cache, in that order.
*/
export function seededStagingKeys(cacheId: CacheId) {
	return [
		...seededVerdicts.map((_verdict, index) =>
			r2ObjectKeySchema.parse(`staging/${uploadId(cacheId, index)}`)
		),
		...Array.from({ length: seededAttestations }, (_value, index) =>
			r2ObjectKeySchema.parse(
				`staging/attestations/${String(cacheId)}-${String(index)}`
			)
		)
	];
}

function isAwaitingVerdict(verdict: (typeof seededVerdicts)[number]): boolean {
	return verdict === 'pending' || verdict === 'committing';
}

/**
The canonical incarnations that the seeded uploads awaiting a verdict
reserved, one for each upload. Each upload has a NAR of its own.
*/
export function seededReservations(cacheId: CacheId) {
	return seededVerdicts
		.map((verdict, index) => ({ verdict, index }))
		.filter(({ verdict }) => isAwaitingVerdict(verdict))
		.map(({ index }) => ({
			narHash: syntheticNarHash(cacheId * 16 + index),
			incarnation: 2,
			owner: uploadId(cacheId, index)
		}));
}

function insertUploads(context: ServerContext, cache: ResolvedCache): void {
	const now = isoTimestamp(new Date());
	const expiresAt = isoTimestamp(inAnHour());
	const recoveryDeadline = inAnHour().toISOString();
	const keys = seededStagingKeys(cache.id);

	for (const [index, verdict] of seededVerdicts.entries()) {
		const id = uploadId(cache.id, index);
		const metadata = uploadMetadata({
			fileSize: 1,
			storePathHash: `v${String(index).padStart(31, '0')}`,
			narHash: syntheticNarHash(cache.id * 16 + index)
		});

		context.db
			.insert(schema.pendingUploads)
			.values({
				id,
				cacheId: cache.id,
				narHash: metadata.narHash,
				r2Key: r2ObjectKeySchema.parse(`staging/${id}`),
				metadataJson: JSON.stringify(metadata),
				createdAt: now,
				expiresAt,
				verdict,
				...(isAwaitingVerdict(verdict) && {
					promotionJson: JSON.stringify({
						mode: 'copy',
						reservation: { incarnation: 2, owner: id }
					})
				})
			})
			.run();
		context.db
			.insert(schema.publicationOperations)
			.values({
				id,
				cacheId: cache.id,
				cacheGeneration: cache.generation,
				pushId: testPushId,
				canonicalJson: '[]',
				acceptedAt: now,
				pushExpiresAt: now,
				recoveryDeadline,
				pruneAfter: recoveryDeadline,
				graceDecisionJson: '{"reportsGrace":true}'
			})
			.run();
	}

	for (const [index, r2Key] of keys.slice(seededVerdicts.length).entries()) {
		context.db
			.insert(schema.pendingAttestations)
			.values({
				id: uploadIdSchema.parse(`a-${String(cache.id)}-${String(index)}`),
				cacheId: cache.id,
				digest: sha256HexDigestSchema.parse('b'.repeat(64)),
				r2Key,
				createdAt: now,
				expiresAt
			})
			.run();
	}
}

/**
Adds rows for a cache to every table that a removal empties: `paths` narinfo
rows, a root with a target for each path, a grace deadline for each path
(half of them passed), scan state, an upload of each verdict in
{@link seededVerdicts} with an accepted operation, and attestation uploads.
The cache's store-path hashes start with `prefix`.
*/
export function seedCacheRows(
	context: ServerContext,
	storage: DurableObjectStorage,
	cache: ResolvedCache,
	prefix: string,
	paths: number
): void {
	const now = isoTimestamp(new Date());
	const root = `run-${prefix}`;

	storage.sql.exec(insertNarInfoRows, cache.id, paths, prefix, narHash, now);
	storage.sql.exec(insertRootRow, cache.id, root, now);
	storage.sql.exec(insertTargetRows, cache.id, paths, root, prefix);
	storage.sql.exec(insertGraceRows, cache.id, paths, prefix);
	storage.sql.exec(insertScanRow, cache.id);
	storage.sql.exec(insertMarkRows, cache.id, paths, prefix);
	storage.sql.exec(insertFrontierRows, cache.id, paths, prefix);
	insertUploads(context, cache);
}

/**
Stores an object at each staged key of a cache's seeded uploads.
*/
export async function putSeededStagingObjects(cacheId: CacheId): Promise<void> {
	await Promise.all(
		seededStagingKeys(cacheId).map((key) => env.BLOBS.put(key, 'staged'))
	);
}

/**
Whether each staged object of a cache's seeded uploads is still stored.
*/
export function seededStagingObjects(cacheId: CacheId): Promise<boolean[]> {
	return Promise.all(
		seededStagingKeys(cacheId).map(
			async (key) => (await env.BLOBS.head(key)) !== null
		)
	);
}

/**
The number of a cache's rows in each table that a removal empties.
*/
export function cacheRowCounts(
	context: ServerContext,
	cacheId: CacheId
): Record<string, number> {
	return Object.fromEntries(
		Object.entries(countedTables).map(([name, table]) => [
			name,
			context.db.get<{ count: number }>(
				sql`SELECT count(*) AS count FROM ${table} WHERE cache_id = ${cacheId}`
			).count
		])
	);
}

/**
The state and stored result of each publication operation of a cache.
*/
export function operationOutcomes(context: ServerContext, cacheId: CacheId) {
	return context.db
		.select({
			state: schema.publicationOperations.state,
			resultJson: schema.publicationOperations.resultJson
		})
		.from(schema.publicationOperations)
		.where(eq(schema.publicationOperations.cacheId, cacheId))
		.all();
}

/**
Marks a cache removed the way the gated step of a removal does: the cache is
marked deleted, its teardown is recorded and the teardown marker is
written. Every row of the cache is left for the drain.
*/
export async function markCacheRemoved(
	context: ServerContext,
	storage: DurableObjectStorage,
	scope: CacheScope
): Promise<ResolvedCache> {
	const cache = context.cacheRepository.require(scope);

	context.db
		.update(schema.cacheIdentities)
		.set({ deletedAt: isoTimestamp(new Date()) })
		.where(eq(schema.cacheIdentities.id, cache.id))
		.run();
	context.db.insert(schema.cacheTeardowns).values({ cacheId: cache.id }).run();
	await storage.put(`${teardownEntryPrefix}${String(cache.id)}`, {});

	return cache;
}

const methodLineSchema = z.object({
	method: z.string(),
	rowsRead: z.number(),
	rowsWritten: z.number(),
	d1Calls: z.number(),
	r2Delete: z.number()
});

/**
The cost of one teardown pass, from the tenant object's log.
*/
export type TeardownPassCost = Omit<z.infer<typeof methodLineSchema>, 'method'>;

async function isTeardownPending(cacheId: CacheId): Promise<boolean> {
	return runInDurableObject(
		currentServer(),
		async (_instance, state) =>
			(await state.storage.get(`${teardownEntryPrefix}${String(cacheId)}`)) !==
			undefined
	);
}

async function teardownPassCost(): Promise<TeardownPassCost> {
	const capture = startCapture();

	try {
		await currentServer().resumeCacheTeardown();
	} finally {
		capture.stop();
	}

	const lines = capture.logs
		.filter((entry) => entry.message === 'method finished')
		.map((entry) => methodLineSchema.parse(entry.properties))
		.filter((line) => line.method === 'cache-teardown');

	return {
		rowsRead: lines.reduce((sum, line) => sum + line.rowsRead, 0),
		rowsWritten: lines.reduce((sum, line) => sum + line.rowsWritten, 0),
		d1Calls: lines.reduce((sum, line) => sum + line.d1Calls, 0),
		r2Delete: lines.reduce((sum, line) => sum + line.r2Delete, 0)
	};
}

/**
Runs teardown passes until the cache's teardown marker is gone, and returns
the cost of each pass. Each pass deletes rows or retires queued deletions,
so the passes come to an end.
*/
export async function drainTeardown(
	cacheId: CacheId
): Promise<TeardownPassCost[]> {
	const passes: TeardownPassCost[] = [];

	while (await isTeardownPending(cacheId)) {
		passes.push(await teardownPassCost());
	}

	return passes;
}
