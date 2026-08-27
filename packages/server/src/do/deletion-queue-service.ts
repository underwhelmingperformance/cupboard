import {
	isPrivateCache,
	type NarInfoGeneration,
	type NixSha256HashString,
	type StoredCache,
	type StorePathHash,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { type DeletePathResponse } from '@cupboard/protocol/upload';
import {
	and,
	eq,
	exists,
	inArray,
	isNotNull,
	notExists,
	or,
	sql
} from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import {
	referencedCacheLifecycle,
	revokedByCacheGeneration,
	secondCacheGeneration
} from '../db/cache-generation.ts';
import { outsidePrivateCaches } from '../db/cache-range.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import {
	d1StatementsPerReaperInvocation,
	type RequestOrigin
} from '../http/http.ts';

import {
	type AttestationCasService,
	type AttestationReference
} from './attestation-cas-service.ts';
import { type AttestationsService } from './attestations-service.ts';
import { chunk, maxInClauseValues } from './bulk.ts';
import { CachePurgeQueueService } from './cache-purge-queue-service.ts';
import { type SchemaWriter, type ServerContext } from './context.ts';
import { type NarInfoObjectsService } from './narinfo-objects-service.ts';
import { StatementBudget } from './statement-budget.ts';

export interface TornDownNarInfo {
	readonly storePathHash: StorePathHash;
	readonly generation: NarInfoGeneration;
	readonly narHash: NixSha256HashString;
}

// Both statements use the same edge filter, which binds 2N + 2 parameters: a
// path and generation for each edge, plus the tenant and cache. The credit
// update embeds that filter in its `count(*)` subquery and also binds `updatedAt`
// and its own tenant predicate. Its 2N + 4 parameters determine the chunk width.
export const maxFencedRetireRows = Math.floor(maxInClauseValues / 2);

// Limit each flush to a few retirement batches. An alarm continues any backlog
// without keeping the critical section open for the entire queue.
const teardownChunksPerFlush = 4;
export const maxNarInfoDeletionsFlushedPerRun =
	teardownChunksPerFlush * maxFencedRetireRows;

// The credit update embeds the tenant and hash filter twice. Together with the
// fixed bindings, a chunk uses 2N + 6 parameters; 45 stays below D1's limit of
// 100.
export const maxTeardownPresenceChunk = 45;

// One query finds the attestation references of every path in a chunk.
const attestationQueryStatementsPerChunk = 1;

// Retiring one attestation reference runs a three-statement batch: the edge
// delete and the two reads that decide whether the tenant still holds the
// digest. The tenant's last reference to a digest runs a further two-statement
// batch for the quota credit and the presence delete. The drain cannot tell the
// two apart until the delete has run, so it reserves the larger cost before
// each reference.
const attestationRetirementStatements = 5;

// Once a chunk holds no attestation reference, retiring its narinfos runs the
// usage credit and edge delete, the presence credit and delete, and the
// public-purge reference query. A chunk of `maxFencedRetireRows` paths names no
// more distinct NAR hashes than one presence batch accepts, so it runs one
// presence batch.
const narInfoRetirementStatementsPerChunk = 5;

// What a chunk costs when none of its paths carries an attestation reference.
export const minimumStatementsPerTeardownChunk =
	attestationQueryStatementsPerChunk + narInfoRetirementStatementsPerChunk;

/**
 * The D1 statements a queue flush may run.
 *
 * Four chunks of unattested paths cost the same as they did before attestation
 * retirement drew on the budget. A queue of attested paths now retires fewer
 * paths per flush instead of running more statements, and the durable queue
 * carries the rest into the next pass.
 */
const narInfoDeletionFlushStatements =
	teardownChunksPerFlush * minimumStatementsPerTeardownChunk;

// What retiring one path costs beside its attestation references: the edge
// credit and delete, the two presence reads, the presence credit and delete,
// the query for the path's attestation references, the unreferenced-hash probe,
// and the two maintenance-eligibility statements around the request.
const statementsPerSinglePathRetirement = 10;

// How many of one path's attestation references a single invocation may retire
// within what is left of its statement limit.
const maxSinglePathAttestationRetirements = Math.floor(
	(d1StatementsPerReaperInvocation - statementsPerSinglePathRetirement) /
		attestationRetirementStatements
);

/**
 * Builds the usage-credit update and edge delete that retire one chunk of
 * narinfo edges. Both statements use the same edge filter. The credit update
 * embeds that filter in its `count(*)` subquery and adds two fixed parameters,
 * so it binds 94 parameters at `maxFencedRetireRows`.
 *
 * The parameter guard imports this builder so it inspects the production
 * statements instead of maintaining a separate filter.
 */
export function fencedEdgeRetirement(
	database: DrizzleD1Database<typeof d1Schema>,
	tenant: TenantId,
	cache: StoredCache,
	batch: readonly TornDownNarInfo[],
	now: IsoTimestamp
) {
	const edgeFilter = and(
		eq(d1Schema.blobReference.tenant, tenant),
		eq(d1Schema.blobReference.cache, cache),
		or(
			...batch.map((entry) =>
				and(
					eq(d1Schema.blobReference.storePathHash, entry.storePathHash),
					eq(d1Schema.blobReference.generation, entry.generation)
				)
			)
		)
	);
	const edgeCount = database
		.select({ count: sql<number>`count(*)` })
		.from(d1Schema.blobReference)
		.where(edgeFilter);

	return {
		creditUpdate: database
			.update(d1Schema.tenantUsage)
			.set({
				narinfos: sql`${d1Schema.tenantUsage.narinfos} - (${edgeCount})`,
				updatedAt: now
			})
			.where(eq(d1Schema.tenantUsage.tenant, tenant)),
		edgeDelete: database.delete(d1Schema.blobReference).where(edgeFilter)
	};
}

// The credit update and presence delete use the same filter in one transaction.
// Keep the update first so its subqueries measure the rows that the delete will
// remove. Exported for the D1 parameter-limit test.
export function teardownPresenceBatch(
	d1: DrizzleD1Database<typeof d1Schema>,
	tenant: TenantId,
	narHashes: readonly NixSha256HashString[],
	now: IsoTimestamp
) {
	const stillReferenced = d1
		.select({ narHash: d1Schema.blobReference.narHash })
		.from(d1Schema.blobReference)
		.where(
			and(
				eq(d1Schema.blobReference.tenant, tenant),
				eq(d1Schema.blobReference.narHash, d1Schema.tenantBlob.narHash)
			)
		);
	const droppableFilter = and(
		eq(d1Schema.tenantBlob.tenant, tenant),
		inArray(d1Schema.tenantBlob.narHash, narHashes),
		notExists(stillReferenced)
	);
	const droppedBytes = sql`coalesce((select sum(${d1Schema.tenantBlob.fileSize}) from ${d1Schema.tenantBlob} where ${droppableFilter}), 0)`;
	const droppedCount = sql`coalesce((select count(*) from ${d1Schema.tenantBlob} where ${droppableFilter}), 0)`;

	return {
		update: d1
			.update(d1Schema.tenantUsage)
			.set({
				bytes: sql`${d1Schema.tenantUsage.bytes} - ${droppedBytes}`,
				blobs: sql`${d1Schema.tenantUsage.blobs} - ${droppedCount}`,
				updatedAt: now
			})
			.where(eq(d1Schema.tenantUsage.tenant, tenant)),
		presenceDelete: d1.delete(d1Schema.tenantBlob).where(droppableFilter)
	};
}

export class DeletionQueueService {
	constructor(
		private readonly context: ServerContext,
		private readonly attestationCas: AttestationCasService,
		private readonly attestations: AttestationsService,
		private readonly narInfoObjects: NarInfoObjectsService,
		private readonly cachePurges: CachePurgeQueueService = new CachePurgeQueueService(
			context
		)
	) {}

	private async retireBlobRefEdge(
		cache: StoredCache,
		storePathHash: StorePathHash,
		generation: NarInfoGeneration,
		narHash: NixSha256HashString
	): Promise<void> {
		const tenant = this.context.requireTenant();
		const now = isoTimestamp(new Date());

		// Credit only while the captured edge still exists, then delete that exact
		// generation in the same transaction. A replay cannot credit it twice or
		// remove a newer edge.
		const edgeFilter = and(
			eq(d1Schema.blobReference.tenant, tenant),
			eq(d1Schema.blobReference.cache, cache),
			eq(d1Schema.blobReference.storePathHash, storePathHash),
			eq(d1Schema.blobReference.generation, generation)
		);
		const edgeExists = exists(
			this.context.d1
				.select({ one: sql`1` })
				.from(d1Schema.blobReference)
				.where(edgeFilter)
		);
		const creditNarInfoFilter = and(
			eq(d1Schema.tenantUsage.tenant, tenant),
			edgeExists
		);

		await this.context.d1.batch([
			this.context.d1
				.update(d1Schema.tenantUsage)
				.set({
					narinfos: sql`${d1Schema.tenantUsage.narinfos} - 1`,
					updatedAt: now
				})
				.where(creditNarInfoFilter),
			this.context.d1.delete(d1Schema.blobReference).where(edgeFilter)
		]);

		const hashReferencedFilter = and(
			eq(d1Schema.blobReference.tenant, tenant),
			eq(d1Schema.blobReference.narHash, narHash)
		);
		const presenceFilter = and(
			eq(d1Schema.tenantBlob.tenant, tenant),
			eq(d1Schema.tenantBlob.narHash, narHash)
		);

		const [stillReferencedRows, presenceRows] = await this.context.d1.batch([
			this.context.d1
				.select({ cache: d1Schema.blobReference.cache })
				.from(d1Schema.blobReference)
				.where(hashReferencedFilter),
			this.context.d1
				.select({ fileSize: d1Schema.tenantBlob.fileSize })
				.from(d1Schema.tenantBlob)
				.where(presenceFilter)
		]);
		// A cached public NAR outlives the edges that authorised it, so invalidate
		// it once no public cache of the tenant references the hash. Only the
		// retirement of a public edge can remove the last such reference.
		const hasPublicReference = stillReferencedRows.some(
			(row) => !isPrivateCache(row.cache)
		);

		if (!hasPublicReference && !isPrivateCache(cache)) {
			await this.cachePurges.enqueueNars([narHash]);
		}

		if (stillReferencedRows[0] !== undefined) {
			return;
		}

		// Credit the blob only while its presence row still exists, and remove that
		// row in the same transaction. A replay cannot credit the last edge twice.
		const presence = presenceRows[0];

		if (presence === undefined) {
			return;
		}

		const presenceExists = exists(
			this.context.d1
				.select({ one: sql`1` })
				.from(d1Schema.tenantBlob)
				.where(presenceFilter)
		);
		const creditBytesFilter = and(
			eq(d1Schema.tenantUsage.tenant, tenant),
			presenceExists
		);

		await this.context.d1.batch([
			this.context.d1
				.update(d1Schema.tenantUsage)
				.set({
					bytes: sql`${d1Schema.tenantUsage.bytes} - ${presence.fileSize}`,
					blobs: sql`${d1Schema.tenantUsage.blobs} - 1`,
					updatedAt: now
				})
				.where(creditBytesFilter),
			this.context.d1.delete(d1Schema.tenantBlob).where(presenceFilter)
		]);
	}

	// Queues a cache-tag purge for each hash the tenant's public caches have
	// stopped referencing. Retiring an edge of a private cache leaves the public
	// references untouched, so only a public cache needs the check.
	private async purgeUnreferencedNars(
		cache: StoredCache,
		narHashes: readonly NixSha256HashString[]
	): Promise<void> {
		if (isPrivateCache(cache) || narHashes.length === 0) {
			return;
		}

		const tenant = this.context.requireTenant();
		const publicRows = await this.context.d1
			.select({ narHash: d1Schema.blobReference.narHash })
			.from(d1Schema.blobReference)
			.where(
				and(
					eq(d1Schema.blobReference.tenant, tenant),
					inArray(d1Schema.blobReference.narHash, narHashes),
					outsidePrivateCaches(d1Schema.blobReference.cache)
				)
			)
			.all();
		const stillPublic = new Set(publicRows.map((row) => row.narHash));

		await this.cachePurges.enqueueNars(
			narHashes.filter((narHash) => !stillPublic.has(narHash))
		);
	}

	// Reports whether the hash has no committed reference in any tenant. The
	// global reaper, not this deletion path, decides when to remove the NAR.
	private async blobHashUnreferenced(
		narHash: NixSha256HashString
	): Promise<boolean> {
		const referenced = await this.context.d1
			.select({ narHash: d1Schema.blobReference.narHash })
			.from(d1Schema.blobReference)
			.where(eq(d1Schema.blobReference.narHash, narHash))
			.get();

		return referenced === undefined;
	}

	private clearQueuedNarInfoDeletion(
		cache: StoredCache,
		storePathHash: StorePathHash,
		generation: NarInfoGeneration
	): void {
		this.context.db
			.delete(schema.narInfoDeletions)
			.where(
				and(
					eq(schema.narInfoDeletions.cache, cache),
					eq(schema.narInfoDeletions.storePathHash, storePathHash),
					eq(schema.narInfoDeletions.generation, generation)
				)
			)
			.run();
	}

	/**
	 * Retires the attestation references of one narinfo generation, as far as one
	 * invocation's share of the D1 budget reaches, and reports whether it retired
	 * them all.
	 *
	 * A path may carry any number of references, so a single request cannot
	 * assume it can retire them all. The caller keeps the queue entry when this
	 * returns false, and garbage collection retires the rest.
	 */
	private async retireAttestationRefs(
		cache: StoredCache,
		storePathHash: StorePathHash,
		generation: NarInfoGeneration
	): Promise<boolean> {
		const tenant = this.context.requireTenant();
		const references = await this.context.d1
			.select({
				cache: d1Schema.attestationReference.cache,
				storePathHash: d1Schema.attestationReference.storePathHash,
				generation: d1Schema.attestationReference.generation,
				predicateType: d1Schema.attestationReference.predicateType,
				digest: d1Schema.attestationReference.digest
			})
			.from(d1Schema.attestationReference)
			.where(
				and(
					eq(d1Schema.attestationReference.tenant, tenant),
					eq(d1Schema.attestationReference.cache, cache),
					eq(d1Schema.attestationReference.storePathHash, storePathHash),
					eq(d1Schema.attestationReference.generation, generation)
				)
			)
			// One reference more than this invocation may retire, so a surplus row
			// reports the path unfinished.
			.limit(maxSinglePathAttestationRetirements + 1)
			.all();

		for (const reference of references.slice(
			0,
			maxSinglePathAttestationRetirements
		)) {
			await this.attestationCas.removeCapturedReference(reference);
		}

		return references.length <= maxSinglePathAttestationRetirements;
	}

	/**
	 * Retires one chunk of queued narinfo deletions and returns the number of
	 * published narinfo objects it removed, or `undefined` when the budget could
	 * not cover the whole chunk.
	 *
	 * Attestation references go first because their unbounded count determines
	 * whether the budget can finish the chunk. The drain reserves the fixed
	 * narinfo-retirement cost and retires only the references the remaining
	 * budget can cover. A surplus reference stops the chunk before it retires the
	 * reference edges or clears the queue entries.
	 *
	 * References already removed remain absent, and the bundle route still
	 * requires both an attestation reference and its matching
	 * generation-authorised reference edge. An interrupted pass can therefore
	 * reduce what is available, but it cannot expose a retired bundle.
	 */
	private async retireTornDownChunk(
		cache: StoredCache,
		tenant: TenantId,
		batch: readonly TornDownNarInfo[],
		now: IsoTimestamp,
		budget: StatementBudget
	): Promise<number | undefined> {
		if (!budget.take(attestationQueryStatementsPerChunk)) {
			return undefined;
		}

		// Keep back what finishing the chunk costs, so a chunk whose references
		// this pass can clear also finishes in this pass. Read one reference more
		// than that leaves room for, so a surplus row reports the chunk unfinished.
		const affordable = budget.operationsLeft(
			attestationRetirementStatements,
			narInfoRetirementStatementsPerChunk
		);
		const references = await this.capturedAttestationReferences(
			tenant,
			cache,
			batch,
			affordable + 1
		);
		const retiring = references.slice(0, affordable);

		if (!budget.take(retiring.length * attestationRetirementStatements)) {
			return undefined;
		}

		for (const reference of retiring) {
			await this.attestationCas.removeCapturedReference(reference);
		}

		if (references.length > affordable) {
			return undefined;
		}

		if (!budget.take(narInfoRetirementStatementsPerChunk)) {
			return undefined;
		}

		const storePathHashes = batch.map((entry) => entry.storePathHash);
		const liveRows = this.context.db
			.select({
				storePathHash: schema.narInfos.storePathHash,
				generation: schema.narInfos.generation
			})
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cache, cache),
					inArray(schema.narInfos.storePathHash, storePathHashes)
				)
			)
			.all();
		const liveGenerations = new Map(
			liveRows.map((row) => [row.storePathHash, row.generation] as const)
		);
		const removable = batch.filter((entry) => {
			const live = liveGenerations.get(entry.storePathHash);

			return live === undefined || live === entry.generation;
		});
		const superseded = batch.filter((entry) => !removable.includes(entry));

		await this.narInfoObjects.deleteNarInfoObjects(
			cache,
			removable.map((entry) => entry.storePathHash)
		);

		await this.cachePurges.enqueueNarInfos(cache, storePathHashes);

		// Compute the credit from edges that still exist, then delete those exact
		// generations in the same transaction. Replays cannot double-credit.
		const { creditUpdate, edgeDelete } = fencedEdgeRetirement(
			this.context.d1,
			tenant,
			cache,
			batch,
			now
		);

		await this.context.d1.batch([creditUpdate, edgeDelete]);

		// A shared hash retains its presence row until its final edge is retired.
		// The caller's critical section makes this Durable Object the sole writer
		// for the tenant's presence rows while the credit and delete run.
		const narHashes = [...new Set(batch.map((entry) => entry.narHash))];

		for (const hashes of chunk(narHashes, maxTeardownPresenceChunk)) {
			const { update, presenceDelete } = teardownPresenceBatch(
				this.context.d1,
				tenant,
				hashes,
				now
			);
			await this.context.d1.batch([update, presenceDelete]);
			await this.purgeUnreferencedNars(cache, hashes);
		}

		await this.discardRetiredLists(cache, removable, superseded);

		// Clear only the retired path and generation pairs. A later generation
		// keeps its queue entry, and clearing each completed chunk preserves
		// progress across a timeout.
		const retiredPairs = batch.map((entry) =>
			and(
				eq(schema.narInfoDeletions.storePathHash, entry.storePathHash),
				eq(schema.narInfoDeletions.generation, entry.generation)
			)
		);

		this.context.db
			.delete(schema.narInfoDeletions)
			.where(and(eq(schema.narInfoDeletions.cache, cache), or(...retiredPairs)))
			.run();

		return removable.length;
	}

	// The attestation references filed against the exact narinfo generations this
	// chunk retires. Fetches at most one reference beyond the number the budget
	// can retire. The surplus row tells the caller to leave the chunk's queue
	// entries in place.
	private capturedAttestationReferences(
		tenant: TenantId,
		cache: StoredCache,
		batch: readonly TornDownNarInfo[],
		limit: number
	): Promise<AttestationReference[]> {
		const pairFilters = batch.map((entry) =>
			and(
				eq(d1Schema.attestationReference.storePathHash, entry.storePathHash),
				eq(d1Schema.attestationReference.generation, entry.generation)
			)
		);

		return this.context.d1
			.select({
				cache: d1Schema.attestationReference.cache,
				storePathHash: d1Schema.attestationReference.storePathHash,
				generation: d1Schema.attestationReference.generation,
				predicateType: d1Schema.attestationReference.predicateType,
				digest: d1Schema.attestationReference.digest
			})
			.from(d1Schema.attestationReference)
			.where(
				and(
					eq(d1Schema.attestationReference.tenant, tenant),
					eq(d1Schema.attestationReference.cache, cache),
					or(...pairFilters)
				)
			)
			.limit(limit)
			.all();
	}

	/**
	 * Removes the attestation list objects a retired chunk leaves behind.
	 *
	 * `removable` names the paths whose retired generation was the last one
	 * committed. Nothing newer owns their lists, so one bulk call removes them.
	 * `superseded` names the paths a later generation recommitted; their list
	 * object goes only while it still records the retired generation, because
	 * the later generation may already own it.
	 *
	 * Neither step reads the reference rows, so a replay after a crash between
	 * reference removal and list removal still discards the stale object.
	 */
	private async discardRetiredLists(
		cache: StoredCache,
		removable: readonly TornDownNarInfo[],
		superseded: readonly TornDownNarInfo[]
	): Promise<void> {
		await this.attestations.discardLists(
			cache,
			removable.map((entry) => entry.storePathHash)
		);

		for (const entry of superseded) {
			await this.attestations.discardListOfGeneration(
				cache,
				entry.storePathHash,
				entry.generation
			);
		}
	}

	enqueueNarInfoDeletion(
		handle: SchemaWriter,
		cache: StoredCache,
		storePathHash: StorePathHash,
		narHash: NixSha256HashString,
		generation: NarInfoGeneration,
		now: IsoTimestamp
	): void {
		handle
			.insert(schema.narInfoDeletions)
			.values({ cache, storePathHash, narHash, generation, createdAt: now })
			.onConflictDoUpdate({
				target: [
					schema.narInfoDeletions.cache,
					schema.narInfoDeletions.storePathHash,
					schema.narInfoDeletions.generation
				],
				set: { narHash, createdAt: now }
			})
			.run();
	}

	// The caller must hold the critical section. The row cap and the statement
	// budget both bound one pass; an alarm resumes the remaining durable queue
	// entries.
	async flushQueuedNarInfoDeletions(
		origin?: RequestOrigin,
		limit: number = maxNarInfoDeletionsFlushedPerRun
	): Promise<number> {
		const queued = this.context.db
			.select()
			.from(schema.narInfoDeletions)
			.orderBy(
				schema.narInfoDeletions.cache,
				schema.narInfoDeletions.storePathHash,
				schema.narInfoDeletions.generation
			)
			.limit(limit)
			.all();

		const byCache = new Map<StoredCache, TornDownNarInfo[]>();

		for (const entry of queued) {
			const entries = byCache.get(entry.cache) ?? [];
			entries.push({
				storePathHash: entry.storePathHash,
				generation: entry.generation,
				narHash: entry.narHash
			});
			byCache.set(entry.cache, entries);
		}

		// Every cache in this flush draws on one budget, because they all run in
		// the same invocation.
		const budget = new StatementBudget(narInfoDeletionFlushStatements);
		let deleted = 0;

		for (const [cache, entries] of byCache) {
			deleted += await this.retireTornDownNarInfos(
				cache,
				entries,
				budget,
				origin
			);
		}

		return deleted;
	}

	// Select a real column because this driver returns undefined for a projected
	// SQL literal even when the query finds a row.
	hasQueuedNarInfoDeletions(): boolean {
		const row = this.context.db
			.select({ storePathHash: schema.narInfoDeletions.storePathHash })
			.from(schema.narInfoDeletions)
			.limit(1)
			.get();

		return row !== undefined;
	}

	/**
	 * Retires the reference edge of one queued narinfo deletion and returns the
	 * queue entry it retired, or `undefined` when the queue holds no such entry.
	 *
	 * The edge is what authorises a NAR read through the cache, so it goes
	 * before the object deletion and the accounting that follow it. A caller
	 * that reports a deletion to a client must let a failure here reach the
	 * client, because a surviving edge keeps the NAR readable.
	 *
	 * The caller must hold the critical section.
	 */
	async retireQueuedNarInfoEdge(
		cache: StoredCache,
		storePathHash: StorePathHash,
		generation: NarInfoGeneration
	): Promise<typeof schema.narInfoDeletions.$inferSelect | undefined> {
		const queued = this.context.db
			.select()
			.from(schema.narInfoDeletions)
			.where(
				and(
					eq(schema.narInfoDeletions.cache, cache),
					eq(schema.narInfoDeletions.storePathHash, storePathHash),
					eq(schema.narInfoDeletions.generation, generation)
				)
			)
			.get();

		if (queued === undefined) {
			return undefined;
		}

		await this.retireBlobRefEdge(
			cache,
			storePathHash,
			queued.generation,
			queued.narHash
		);

		return queued;
	}

	// The caller must hold the critical section because the row check, object
	// deletion, edge retirement, and queue clear span asynchronous operations.
	async deleteQueuedNarInfo(
		cache: StoredCache,
		storePathHash: StorePathHash,
		generation: NarInfoGeneration,
		origin?: RequestOrigin
	): Promise<{ objectDeleted: boolean; narScheduledForDeletion: boolean }> {
		const queued = await this.retireQueuedNarInfoEdge(
			cache,
			storePathHash,
			generation
		);

		if (queued === undefined) {
			return { objectDeleted: false, narScheduledForDeletion: false };
		}

		return this.cleanUpQueuedNarInfo(
			cache,
			storePathHash,
			generation,
			queued,
			origin
		);
	}

	/**
	 * Removes what a retired narinfo leaves behind: its published object, its
	 * cached copies, its attestations and its queue entry. The caller must have
	 * retired the reference edge and must hold the critical section.
	 *
	 * A path carrying more attestation references than one invocation may retire
	 * keeps its queue entry, so garbage collection retires the rest.
	 */
	async cleanUpQueuedNarInfo(
		cache: StoredCache,
		storePathHash: StorePathHash,
		generation: NarInfoGeneration,
		queued: typeof schema.narInfoDeletions.$inferSelect,
		_origin?: RequestOrigin
	): Promise<{ objectDeleted: boolean; narScheduledForDeletion: boolean }> {
		const current = this.context.db
			.select({ generation: schema.narInfos.generation })
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cache, cache),
					eq(schema.narInfos.storePathHash, storePathHash)
				)
			)
			.get();
		const wasNewerCommitted =
			current !== undefined && current.generation !== queued.generation;

		// A newer generation keeps the path-keyed object and the attestation list
		// it owns. The captured generation's attestations still need to be retired.
		if (wasNewerCommitted) {
			await this.cachePurges.enqueueNarInfos(cache, [storePathHash]);

			const hasRetiredEveryReference = await this.retireAttestationRefs(
				cache,
				storePathHash,
				queued.generation
			);
			await this.attestations.discardListOfGeneration(
				cache,
				storePathHash,
				queued.generation
			);

			const isNarScheduledForDeletion = await this.blobHashUnreferenced(
				queued.narHash
			);

			if (hasRetiredEveryReference) {
				this.clearQueuedNarInfoDeletion(cache, storePathHash, generation);
			}

			return {
				objectDeleted: false,
				narScheduledForDeletion: isNarScheduledForDeletion
			};
		}

		await this.narInfoObjects.deleteNarInfoObject(cache, storePathHash);
		await this.cachePurges.enqueueNarInfos(cache, [storePathHash]);

		const hasRetiredEveryReference = await this.retireAttestationRefs(
			cache,
			storePathHash,
			queued.generation
		);
		// Nothing newer owns this path's list, so it goes whatever the reference
		// rows say. A replay after a crash between reference removal and this
		// deletion therefore still discards the stale object.
		await this.attestations.discardLists(cache, [storePathHash]);

		// Re-check the live edges because another path may have committed the same
		// NAR after this row was removed. The global reaper owns NAR deletion.
		const isNarScheduledForDeletion = await this.blobHashUnreferenced(
			queued.narHash
		);

		if (hasRetiredEveryReference) {
			this.clearQueuedNarInfoDeletion(cache, storePathHash, generation);
		}

		return {
			objectDeleted: true,
			narScheduledForDeletion: isNarScheduledForDeletion
		};
	}

	/**
	 * Advances the lifecycle generation and records the cache as deleted. One
	 * statement does both however many edges the cache holds, so a deletion can
	 * revoke a cache of any size and let the physical cleanup drain afterwards.
	 *
	 * The generation mismatch immediately revokes existing reference edges. The
	 * advanced generation also belongs to the next cache created under the same
	 * name, so an edge the drain has not reached yet cannot authorise a read
	 * through that later cache.
	 *
	 * For the private namespace, the deletion timestamp makes content reads
	 * return absent-object results and makes availability report every requested
	 * path as missing while path-keyed objects await teardown.
	 * {@link clearCacheDeletion} removes the timestamp when the cache name is
	 * registered again.
	 */
	async revokeCacheGeneration(cache: StoredCache): Promise<void> {
		const tenant = this.context.requireTenant();
		const now = isoTimestamp(new Date());

		await this.context.d1
			.insert(d1Schema.cacheLifecycle)
			.values({
				tenant,
				cache,
				generation: secondCacheGeneration,
				deletedAt: now,
				updatedAt: now
			})
			.onConflictDoUpdate({
				target: [d1Schema.cacheLifecycle.tenant, d1Schema.cacheLifecycle.cache],
				set: {
					generation: sql`${d1Schema.cacheLifecycle.generation} + 1`,
					deletedAt: now,
					updatedAt: now
				}
			});
	}

	/**
	 * Ends the deleted state a deletion recorded for this cache name. Registering
	 * the name again creates the next cache under it, and that cache has to
	 * answer its readers.
	 *
	 * The generation stays where the deletion left it, so the edges of the
	 * deleted cache remain revoked while the new cache commits its own.
	 *
	 * The filter keeps this to a statement that writes no row unless a deletion
	 * has left a timestamp behind.
	 */
	async clearCacheDeletion(cache: StoredCache): Promise<void> {
		const tenant = this.context.requireTenant();

		await this.context.d1
			.update(d1Schema.cacheLifecycle)
			.set({ deletedAt: sql`null`, updatedAt: isoTimestamp(new Date()) })
			.where(
				and(
					eq(d1Schema.cacheLifecycle.tenant, tenant),
					eq(d1Schema.cacheLifecycle.cache, cache),
					isNotNull(d1Schema.cacheLifecycle.deletedAt)
				)
			);
	}

	/**
	 * Queues one bounded page of reference edges whose cache generation no longer
	 * matches the current lifecycle generation, so the ordinary retirement drain
	 * removes them and credits what they held.
	 *
	 * A commit inserts its edge inside the same critical section that a cache
	 * deletion runs in, and it records its local narinfo before that insert, so
	 * the local transaction that queues every narinfo normally covers every
	 * committed edge. This sweep finds the revoked edges an interrupted earlier
	 * deletion left, which would otherwise hold usage against the tenant for
	 * good.
	 *
	 * The cache-generation predicate excludes the edges of the current cache of
	 * this name. Retirement then matches the exact narinfo generation, which is a
	 * separate number, so a queued deletion cannot remove a newer recommit.
	 *
	 * Returns the number of edges queued. The caller must hold the critical
	 * section.
	 */
	async queueRevokedCacheEdges(
		cache: StoredCache,
		limit: number
	): Promise<number> {
		const tenant = this.context.requireTenant();
		const page = await this.context.d1
			.select({
				storePathHash: d1Schema.blobReference.storePathHash,
				generation: d1Schema.blobReference.generation,
				narHash: d1Schema.blobReference.narHash
			})
			.from(d1Schema.blobReference)
			.leftJoin(d1Schema.cacheLifecycle, referencedCacheLifecycle())
			.where(
				and(
					eq(d1Schema.blobReference.tenant, tenant),
					eq(d1Schema.blobReference.cache, cache),
					revokedByCacheGeneration()
				)
			)
			.limit(limit)
			.all();

		if (page.length === 0) {
			return 0;
		}

		const now = isoTimestamp(new Date());

		this.context.db.transaction((tx) => {
			for (const edge of page) {
				this.enqueueNarInfoDeletion(
					tx,
					cache,
					edge.storePathHash,
					edge.narHash,
					edge.generation,
					now
				);
			}
		});

		return page.length;
	}

	/**
	 * Retires the queued narinfo deletions of one cache, as far as `budget`
	 * reaches, and returns the number of published narinfo objects it removed.
	 *
	 * The caller must hold the critical section. Each chunk completes its
	 * attestation retirement, generation checks, object deletions, edge
	 * retirement, accounting, and queue clears before the next chunk starts, so
	 * a timeout can repeat at most one chunk. Exact generation filters make
	 * replays idempotent and preserve objects from later recommits.
	 *
	 * Whatever the budget stops short of stays in the durable queue for the next
	 * pass.
	 */
	async retireTornDownNarInfos(
		cache: StoredCache,
		entries: readonly TornDownNarInfo[],
		budget: StatementBudget,
		_origin?: RequestOrigin
	): Promise<number> {
		if (entries.length === 0) {
			return 0;
		}

		const tenant = this.context.requireTenant();
		const now = isoTimestamp(new Date());

		let deletedObjects = 0;

		for (const batch of chunk(entries, maxFencedRetireRows)) {
			const retired = await this.retireTornDownChunk(
				cache,
				tenant,
				batch,
				now,
				budget
			);

			if (retired === undefined) {
				break;
			}

			deletedObjects += retired;
		}

		return deletedObjects;
	}

	deleteStorePath(
		cache: StoredCache,
		storePathHash: StorePathHash,
		origin: RequestOrigin
	): Promise<DeletePathResponse> {
		// Keep row removal and opportunistic object cleanup in one critical section
		// so healing cannot recreate the object between them.
		return this.context.criticalSection(async () => {
			const row = this.context.db
				.select()
				.from(schema.narInfos)
				.where(
					and(
						eq(schema.narInfos.cache, cache),
						eq(schema.narInfos.storePathHash, storePathHash)
					)
				)
				.get();

			if (row === undefined) {
				return {
					storePathHash,
					deleted: false,
					narScheduledForDeletion: false
				};
			}

			// Remove the row and enqueue cleanup atomically. The durable queue prevents
			// an interrupted object deletion from restoring the path, and the NAR grace
			// period starts only after cleanup removes the object.
			const now = isoTimestamp(new Date());

			this.context.db.transaction((tx) => {
				tx.delete(schema.narInfos)
					.where(
						and(
							eq(schema.narInfos.cache, row.cache),
							eq(schema.narInfos.storePathHash, storePathHash)
						)
					)
					.run();
				tx.delete(schema.retentionGrace)
					.where(
						and(
							eq(schema.retentionGrace.cache, row.cache),
							eq(schema.retentionGrace.storePathHash, storePathHash)
						)
					)
					.run();
				this.enqueueNarInfoDeletion(
					tx,
					row.cache,
					storePathHash,
					row.narHash,
					row.generation,
					now
				);
			});

			const queued = await this.retireQueuedNarInfoEdge(
				row.cache,
				storePathHash,
				row.generation
			);

			if (queued === undefined) {
				return {
					storePathHash,
					deleted: true,
					narScheduledForDeletion: false
				};
			}

			let isNarScheduledForDeletion = false;

			try {
				({ narScheduledForDeletion: isNarScheduledForDeletion } =
					await this.cleanUpQueuedNarInfo(
						row.cache,
						storePathHash,
						row.generation,
						queued,
						origin
					));
			} catch {
				// The durable queue remains for garbage collection to retry.
			}

			return {
				storePathHash,
				deleted: true,
				narScheduledForDeletion: isNarScheduledForDeletion
			};
		});
	}

	async removeStaleNarInfo(
		row: typeof schema.narInfos.$inferSelect,
		origin: RequestOrigin
	): Promise<void> {
		await this.context.criticalSection(() =>
			this.reconcileMissingNar(row, origin)
		);
	}

	// The caller must hold the critical section. Remove the stale row and enqueue
	// cleanup atomically so an interrupted reconciliation cannot recreate the
	// path. Garbage collection retries any object cleanup left in the queue.
	async reconcileMissingNar(
		row: typeof schema.narInfos.$inferSelect,
		origin?: RequestOrigin
	): Promise<void> {
		const now = isoTimestamp(new Date());
		const wasRemoved = this.context.db.transaction((tx) => {
			const deleted = tx
				.delete(schema.narInfos)
				.where(
					and(
						eq(schema.narInfos.cache, row.cache),
						eq(schema.narInfos.storePathHash, row.storePathHash),
						eq(schema.narInfos.generation, row.generation),
						eq(schema.narInfos.narHash, row.narHash)
					)
				)
				.returning({ storePathHash: schema.narInfos.storePathHash })
				.get();

			if (deleted === undefined) {
				return false;
			}

			tx.delete(schema.retentionGrace)
				.where(
					and(
						eq(schema.retentionGrace.cache, row.cache),
						eq(schema.retentionGrace.storePathHash, row.storePathHash)
					)
				)
				.run();
			this.enqueueNarInfoDeletion(
				tx,
				row.cache,
				row.storePathHash,
				row.narHash,
				row.generation,
				now
			);

			return true;
		});

		if (!wasRemoved) {
			return;
		}

		try {
			await this.deleteQueuedNarInfo(
				row.cache,
				row.storePathHash,
				row.generation,
				origin
			);
		} catch {
			// The durable queue remains for garbage collection to retry.
		}
	}
}
