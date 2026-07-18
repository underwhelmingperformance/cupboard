import { type Logger } from '@cupboard/logger';
import {
	type NixSha256HashString,
	type Sha256HexDigest,
	type StorePathHash
} from '@cupboard/nix-store/scalars';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import {
	and,
	asc,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	lte,
	notInArray,
	or,
	sql
} from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from '../db/d1-schema.ts';
import { blobReaperGraceMs, casObjectKey, narObjectKey } from '../http/http.ts';

import {
	batchNonEmpty,
	chunk,
	deleteObjects,
	maxInClauseValues,
	maxOutgoingConnections,
	presentNarObjects
} from './bulk.ts';

// One narinfo whose object the demote pass must take down: a tenant, the cache it
// lives in, and its store-path hash. The reaper groups these by tenant and routes
// them to the owning tenant's Durable Object, the single writer of that tenant's
// objects.
export interface DemoteTarget {
	readonly cache: string;
	readonly storePathHash: StorePathHash;
}

// One hash whose shared object is gone, paired with the narinfos referencing it
// in a single tenant. A demote routes one of these batches to each owning tenant,
// so a tenant referencing many reaped hashes is told about them in one call.
export interface NarInfoDemotion {
	readonly narHash: NixSha256HashString;
	readonly targets: readonly DemoteTarget[];
}

// The port the demote pass reaches a tenant's Durable Object through. The reaper
// itself never touches a tenant's objects; it asks the owning tenant to
// de-materialise the narinfos referencing hashes whose shared objects are gone, so
// the per-tenant single-writer rule holds.
export interface NarInfoDemoter {
	demote(tenant: string, demotions: readonly NarInfoDemotion[]): Promise<void>;
}

// One attestation digest whose CAS object is gone, with the `stored_at` the delete
// is fenced on so a re-stored object is left intact.
export interface CasReferenceDemotion {
	readonly digest: Sha256HexDigest;
	readonly fenceStoredAt: string;
}

export interface CasReferenceDemoter {
	demote(
		tenant: string,
		demotions: readonly CasReferenceDemotion[]
	): Promise<void>;
}

// A fenced batch delete binds two parameters per row (the key and its fence), so
// the OR-of-AND list is chunked to stay within D1's bound-parameter limit.
const maxFencedDeleteRows = Math.floor(maxInClauseValues / 2);

// The demote scan's resume position across cron ticks. It is the last `nar_hash`
// reached, an exclusive lower bound for the next keyset page, with '' meaning start
// from the beginning (and written back to wrap). It is pure cron bookkeeping, so
// the Worker backs it with a single KV value (not a relational row); the eventual consistency is harmless because the scan is idempotent
// and the position only ever resumes a window it would otherwise cover anyway.
export interface DemoteCursor {
	read(): Promise<string>;
	advance(position: string): Promise<void>;
}

// The global blob reaper. It is the only actor that sees every tenant's reference
// edges, so it runs Worker-side over the shared D1 facts, driven by the cron
// and not inside any one tenant's Durable Object. It works `blob_state` in two
// bounded passes: arm every blob no live `blob_ref` references with a grace timer,
// then collect those whose grace has elapsed and that are still unreferenced. Its
// safety rests on the atomic compare-and-delete that re-checks the predicate, not
// on a critical section, so it is correct while tenant objects commit and promote
// concurrently.
export class BlobReaperService {
	constructor(
		private readonly d1: DrizzleD1Database<typeof d1Schema>,
		private readonly blobs: R2Bucket,
		private readonly demoter: NarInfoDemoter,
		private readonly casDemoter: CasReferenceDemoter
	) {}

	// Arms unreferenced shared blobs with a grace timer. The cross-tenant
	// "referenced anywhere" probe is on `blob_ref.nar_hash` (its dedicated index),
	// not any one tenant's narinfos. Bounded: only a batch is armed per pass, and a
	// commit that re-references a hash clears the timer it set.
	private async armUnreferencedBlobs(now: Date, limit: number): Promise<void> {
		const graceDeadline = new Date(now.getTime() + blobReaperGraceMs);
		const deletionTime = graceDeadline.toISOString();
		const referencedHashes = this.d1
			.select({ narHash: d1Schema.blobReference.narHash })
			.from(d1Schema.blobReference);
		const candidates = await this.d1
			.select({ narHash: d1Schema.blobState.narHash })
			.from(d1Schema.blobState)
			.where(
				and(
					isNull(d1Schema.blobState.deleteAfter),
					notInArray(d1Schema.blobState.narHash, referencedHashes)
				)
			)
			.limit(limit)
			.all();

		if (candidates.length === 0) {
			return;
		}

		const candidateHashes = candidates.map((candidate) => candidate.narHash);

		// The candidate batch can exceed D1's bound-parameter limit, so the arm
		// update runs per chunk. Each chunk re-checks the timer is still unset, so
		// a commit clearing it between chunks wins. The chunks go in one D1 batch,
		// so all chunks cost a single round-trip.
		const chunks = chunk(candidateHashes, maxInClauseValues);
		const queries = chunks.map((hashes) => {
			const fence = and(
				inArray(d1Schema.blobState.narHash, hashes),
				isNull(d1Schema.blobState.deleteAfter)
			);

			return this.d1
				.update(d1Schema.blobState)
				.set({ deleteAfter: deletionTime })
				.where(fence);
		});

		await batchNonEmpty(this.d1, queries);
	}

	// Collects armed shared blobs whose grace has elapsed. Each is removed by a
	// single compare-and-delete that re-checks armed, elapsed and unreferenced
	// atomically, so a blob re-referenced or re-armed since the scan is never taken;
	// the D1 fact is deleted before the R2 object (D1-first/R2-last), so a crash
	// between them leaves only a harmless orphan object the next promote adopts.
	private async collectExpiredBlobs(now: Date, limit: number): Promise<number> {
		const nowIso = now.toISOString();
		const expired = await this.d1
			.select({ narHash: d1Schema.blobState.narHash })
			.from(d1Schema.blobState)
			.where(
				and(
					isNotNull(d1Schema.blobState.deleteAfter),
					lte(d1Schema.blobState.deleteAfter, nowIso)
				)
			)
			.limit(limit)
			.all();
		const removedKeys: string[] = [];
		const referencedHashes = this.d1
			.select({ narHash: d1Schema.blobReference.narHash })
			.from(d1Schema.blobReference);

		// One compare-and-delete per chunk; the fence still re-checks armed,
		// elapsed and unreferenced atomically for each row, so a blob
		// re-referenced or re-armed since the scan is never taken, and
		// `RETURNING` reports exactly which rows the fence let go.
		const hashChunks = chunk(
			expired.map((blob) => blob.narHash),
			maxInClauseValues
		);

		for (const hashes of hashChunks) {
			const fence = and(
				inArray(d1Schema.blobState.narHash, hashes),
				isNotNull(d1Schema.blobState.deleteAfter),
				lte(d1Schema.blobState.deleteAfter, nowIso),
				notInArray(d1Schema.blobState.narHash, referencedHashes)
			);
			const removed = await this.d1
				.delete(d1Schema.blobState)
				.where(fence)
				.returning({ narHash: d1Schema.blobState.narHash })
				.all();

			for (const row of removed) {
				removedKeys.push(narObjectKey(row.narHash));
			}
		}

		// Every fenced D1 delete has run, so the R2 objects go in one bulk delete,
		// keeping the D1-first/R2-last order a crash relies on.
		await deleteObjects(this.blobs, removedKeys);

		return removedKeys.length;
	}

	private async armUnreferencedCasObjects(
		now: Date,
		limit: number
	): Promise<void> {
		const graceDeadline = new Date(now.getTime() + blobReaperGraceMs);
		const deletionTime = graceDeadline.toISOString();
		const referencedDigests = this.d1
			.select({ digest: d1Schema.attestationReference.digest })
			.from(d1Schema.attestationReference);
		const candidates = await this.d1
			.select({ digest: d1Schema.casObject.digest })
			.from(d1Schema.casObject)
			.where(
				and(
					isNull(d1Schema.casObject.deleteAfter),
					notInArray(d1Schema.casObject.digest, referencedDigests)
				)
			)
			.limit(limit)
			.all();

		if (candidates.length === 0) {
			return;
		}

		const candidateDigests = candidates.map((candidate) => candidate.digest);

		// The candidate batch can exceed D1's bound-parameter limit, so the arm
		// update runs per chunk. Each chunk re-checks the timer is still unset, so
		// an attach clearing it between chunks wins. The chunks go in one D1 batch,
		// so all chunks cost a single round-trip.
		const chunks = chunk(candidateDigests, maxInClauseValues);
		const queries = chunks.map((digests) => {
			const fence = and(
				inArray(d1Schema.casObject.digest, digests),
				isNull(d1Schema.casObject.deleteAfter)
			);

			return this.d1
				.update(d1Schema.casObject)
				.set({ deleteAfter: deletionTime })
				.where(fence);
		});

		await batchNonEmpty(this.d1, queries);
	}

	private async collectExpiredCasObjects(
		now: Date,
		limit: number
	): Promise<number> {
		const nowIso = now.toISOString();
		const expired = await this.d1
			.select({ digest: d1Schema.casObject.digest })
			.from(d1Schema.casObject)
			.where(
				and(
					isNotNull(d1Schema.casObject.deleteAfter),
					lte(d1Schema.casObject.deleteAfter, nowIso)
				)
			)
			.limit(limit)
			.all();
		const removedKeys: string[] = [];
		const referencedDigests = this.d1
			.select({ digest: d1Schema.attestationReference.digest })
			.from(d1Schema.attestationReference);

		// One compare-and-delete per chunk; the fence still re-checks each row's
		// armed, elapsed and unreferenced state, and `RETURNING` reports exactly
		// which rows it let go.
		const digestChunks = chunk(
			expired.map((object) => object.digest),
			maxInClauseValues
		);

		for (const digests of digestChunks) {
			const fence = and(
				inArray(d1Schema.casObject.digest, digests),
				isNotNull(d1Schema.casObject.deleteAfter),
				lte(d1Schema.casObject.deleteAfter, nowIso),
				notInArray(d1Schema.casObject.digest, referencedDigests)
			);
			const removed = await this.d1
				.delete(d1Schema.casObject)
				.where(fence)
				.returning({ digest: d1Schema.casObject.digest })
				.all();

			for (const row of removed) {
				removedKeys.push(casObjectKey(row.digest));
			}
		}

		await deleteObjects(this.blobs, removedKeys);

		return removedKeys.length;
	}

	// The narinfos referencing each of a batch of hashes, grouped by owning tenant
	// then by hash, in one bulk read per chunk. Each
	// tenant's entry is the set of demotions to route to it in a single call.
	private async referencingDemotions(
		narHashes: readonly NixSha256HashString[]
	): Promise<Map<string, NarInfoDemotion[]>> {
		const pages = await mapWithConcurrency(
			chunk(narHashes, maxInClauseValues),
			maxOutgoingConnections,
			(batch) =>
				this.d1
					.selectDistinct({
						tenant: d1Schema.blobReference.tenant,
						narHash: d1Schema.blobReference.narHash,
						cache: d1Schema.blobReference.cache,
						storePathHash: d1Schema.blobReference.storePathHash
					})
					.from(d1Schema.blobReference)
					.where(inArray(d1Schema.blobReference.narHash, batch))
					.all()
		);

		const edgesByTenant = Map.groupBy(pages.flat(), (edge) => edge.tenant);
		const demotionsByTenant = new Map<string, NarInfoDemotion[]>();

		for (const [tenant, edges] of edgesByTenant) {
			const edgesByHash = Map.groupBy(edges, (edge) => edge.narHash);
			demotionsByTenant.set(
				tenant,
				[...edgesByHash].map(([narHash, group]) => ({
					narHash,
					targets: group.map((edge) => ({
						cache: edge.cache,
						storePathHash: edge.storePathHash
					}))
				}))
			);
		}

		return demotionsByTenant;
	}

	// The digests whose CAS object is present, the attestation counterpart of
	// {@link presentNarObjects}.
	private async presentCasObjects(
		digests: readonly Sha256HexDigest[]
	): Promise<ReadonlySet<Sha256HexDigest>> {
		const present = await mapWithConcurrency(
			digests,
			maxOutgoingConnections,
			async (digest) =>
				(await this.blobs.head(casObjectKey(digest))) === null
					? undefined
					: digest
		);

		return new Set(
			present.filter(
				(digest): digest is Sha256HexDigest => digest !== undefined
			)
		);
	}

	// Routes each tenant's demotions to its Durable Object, bounded and caught per
	// tenant, and returns the tenants whose routing failed. A failed tenant leaves
	// its hashes' facts in place so the next pass re-drives them.
	private async routeByTenant<T>(
		log: Logger,
		byTenant: ReadonlyMap<string, readonly T[]>,
		send: (tenant: string, items: readonly T[]) => Promise<void>
	): Promise<ReadonlySet<string>> {
		const failed = new Set<string>();

		await mapWithConcurrency(
			[...byTenant],
			maxOutgoingConnections,
			async ([tenant, items]) => {
				try {
					await send(tenant, items);
				} catch (error) {
					// Keep the per-tenant isolation (the others still demote and the
					// failed tenant's facts are left for the next pass), but surface the
					// failure: a tenant whose demote routing keeps failing must not be
					// silently swallowed.
					failed.add(tenant);
					log.error('reaper demote routing failed', {
						tenant,
						count: items.length,
						error
					});
				}
			}
		);

		return failed;
	}

	// Deletes the `blob_state` rows for the given hashes, each fenced on the
	// `verified_at` captured at scan so a row deleted and re-promoted in the window
	// is left intact. The fence is an OR of per-row (hash, verified_at) pairs,
	// chunked to stay within D1's bound-parameter limit. Returns how many were
	// deleted.
	private async deleteFencedBlobStates(
		rows: readonly { narHash: NixSha256HashString; verifiedAt: string }[]
	): Promise<number> {
		// The chunks go in one D1 batch, so all chunks cost a single round-trip.
		const chunks = chunk(rows, maxFencedDeleteRows);
		const queries = chunks.map((batch) => {
			const match = or(
				...batch.map((row) =>
					and(
						eq(d1Schema.blobState.narHash, row.narHash),
						eq(d1Schema.blobState.verifiedAt, row.verifiedAt)
					)
				)
			);

			return this.d1
				.delete(d1Schema.blobState)
				.where(match)
				.returning({ narHash: d1Schema.blobState.narHash });
		});

		const results = await batchNonEmpty(this.d1, queries);

		return results.reduce((demoted, removed) => demoted + removed.length, 0);
	}

	// One keyset page of `blob_state` after the cursor, the Drizzle cursor-pagination
	// pattern on the `nar_hash` primary key.
	private demoteBatch(
		after: string,
		limit: number
	): Promise<{ narHash: NixSha256HashString; verifiedAt: string }[]> {
		return this.d1
			.select({
				narHash: d1Schema.blobState.narHash,
				verifiedAt: d1Schema.blobState.verifiedAt
			})
			.from(d1Schema.blobState)
			.where(gt(d1Schema.blobState.narHash, sql`${after}`))
			.orderBy(asc(d1Schema.blobState.narHash))
			.limit(limit)
			.all();
	}

	// Deletes the `cas_object` rows for the given digests, each fenced on the
	// `stored_at` captured at scan, the CAS counterpart of
	// {@link deleteFencedBlobStates}. Returns how many were deleted.
	private async deleteFencedCasObjects(
		rows: readonly { digest: Sha256HexDigest; storedAt: string }[]
	): Promise<number> {
		// The chunks go in one D1 batch, so all chunks cost a single round-trip.
		const chunks = chunk(rows, maxFencedDeleteRows);
		const queries = chunks.map((batch) => {
			const match = or(
				...batch.map((row) =>
					and(
						eq(d1Schema.casObject.digest, row.digest),
						eq(d1Schema.casObject.storedAt, row.storedAt)
					)
				)
			);

			return this.d1
				.delete(d1Schema.casObject)
				.where(match)
				.returning({ digest: d1Schema.casObject.digest });
		});

		const results = await batchNonEmpty(this.d1, queries);

		return results.reduce((demoted, removed) => demoted + removed.length, 0);
	}

	private demoteCasBatch(
		after: string,
		limit: number
	): Promise<{ digest: Sha256HexDigest; storedAt: string }[]> {
		return this.d1
			.select({
				digest: d1Schema.casObject.digest,
				storedAt: d1Schema.casObject.storedAt
			})
			.from(d1Schema.casObject)
			.where(gt(d1Schema.casObject.digest, sql`${after}`))
			.orderBy(asc(d1Schema.casObject.digest))
			.limit(limit)
			.all();
	}

	// The tenants referencing each of a batch of digests, grouped by tenant, in one
	// bulk read per chunk. Each tenant's entry is the demotions to route to it in a
	// single call, carrying the per-digest `stored_at` fence.
	private async casReferencingDemotions(
		objects: readonly { digest: Sha256HexDigest; storedAt: string }[]
	): Promise<Map<string, CasReferenceDemotion[]>> {
		const storedAtByDigest = new Map(
			objects.map((object) => [object.digest, object.storedAt])
		);
		const pages = await mapWithConcurrency(
			chunk(
				objects.map((object) => object.digest),
				maxInClauseValues
			),
			maxOutgoingConnections,
			(batch) =>
				this.d1
					.selectDistinct({
						tenant: d1Schema.attestationReference.tenant,
						digest: d1Schema.attestationReference.digest
					})
					.from(d1Schema.attestationReference)
					.where(inArray(d1Schema.attestationReference.digest, batch))
					.all()
		);

		const rowsByTenant = Map.groupBy(pages.flat(), (row) => row.tenant);
		const demotionsByTenant = new Map<string, CasReferenceDemotion[]>();

		for (const [tenant, rows] of rowsByTenant) {
			demotionsByTenant.set(
				tenant,
				rows.flatMap((row) => {
					const fenceStoredAt = storedAtByDigest.get(row.digest);

					return fenceStoredAt === undefined
						? []
						: [{ digest: row.digest, fenceStoredAt }];
				})
			);
		}

		return demotionsByTenant;
	}

	// Returns how many shared blobs it collected.
	async reapBlobs(now: Date, limit: number): Promise<number> {
		await this.armUnreferencedBlobs(now, limit);

		return this.collectExpiredBlobs(now, limit);
	}

	async reapCasObjects(now: Date, limit: number): Promise<number> {
		await this.armUnreferencedCasObjects(now, limit);

		return this.collectExpiredCasObjects(now, limit);
	}

	// Walks a bounded batch of `blob_state` from the persisted cursor, removing the
	// fact and de-materialising the referencing narinfos of any shared blob whose
	// canonical object is gone (an "available but no object" gap a crash can leave).
	// Reads serve from a tenant's narinfo object, never `blob_state`, so clearing the
	// fact alone would stop no read; the narinfos are de-materialised first, through
	// each owning tenant's Durable Object, and the `blob_state` row is deleted last so
	// it stays the durable marker that re-drives an interrupted demote on the next
	// pass. Returns how many shared facts it demoted.
	async demoteMissingBlobs(
		logger: Logger,
		limit: number,
		cursor: DemoteCursor
	): Promise<number> {
		const log = logger.with({ job: 'blob-reaper' });
		const after = await cursor.read();
		const batch = await this.demoteBatch(after, limit);

		// A short page means the scan reached the end of the hash order, so wrap to the
		// start; otherwise resume after the last hash scanned. Advanced before
		// processing, so a failure does not wedge the scan.
		const next = batch.length < limit ? '' : (batch.at(-1)?.narHash ?? '');
		await cursor.advance(next);

		if (batch.length === 0) {
			return 0;
		}

		const present = await presentNarObjects(
			this.blobs,
			batch.map((blob) => blob.narHash)
		);
		const missing = batch.filter((blob) => !present.has(blob.narHash));

		if (missing.length === 0) {
			return 0;
		}

		// De-materialise the referencing narinfos first (one call per tenant), then
		// delete the facts. A hash whose tenant routing failed keeps its fact for the
		// next pass; one referenced by no tenant is eligible immediately.
		const demotionsByTenant = await this.referencingDemotions(
			missing.map((blob) => blob.narHash)
		);
		const failedTenants = await this.routeByTenant(
			log,
			demotionsByTenant,
			(tenant, demotions) => this.demoter.demote(tenant, demotions)
		);
		const blocked = new Set<NixSha256HashString>();

		for (const [tenant, demotions] of demotionsByTenant) {
			if (!failedTenants.has(tenant)) {
				continue;
			}

			for (const demotion of demotions) {
				blocked.add(demotion.narHash);
			}
		}

		return this.deleteFencedBlobStates(
			missing.filter((blob) => !blocked.has(blob.narHash))
		);
	}

	async demoteMissingCasObjects(
		logger: Logger,
		limit: number,
		cursor: DemoteCursor
	): Promise<number> {
		const log = logger.with({ job: 'blob-reaper' });
		const after = await cursor.read();
		const batch = await this.demoteCasBatch(after, limit);
		const next = batch.length < limit ? '' : (batch.at(-1)?.digest ?? '');
		await cursor.advance(next);

		if (batch.length === 0) {
			return 0;
		}

		const present = await this.presentCasObjects(
			batch.map((object) => object.digest)
		);
		const missing = batch.filter((object) => !present.has(object.digest));

		if (missing.length === 0) {
			return 0;
		}

		const demotionsByTenant = await this.casReferencingDemotions(missing);
		const failedTenants = await this.routeByTenant(
			log,
			demotionsByTenant,
			(tenant, demotions) => this.casDemoter.demote(tenant, demotions)
		);
		const blocked = new Set<Sha256HexDigest>();

		for (const [tenant, demotions] of demotionsByTenant) {
			if (!failedTenants.has(tenant)) {
				continue;
			}

			for (const demotion of demotions) {
				blocked.add(demotion.digest);
			}
		}

		return this.deleteFencedCasObjects(
			missing.filter((object) => !blocked.has(object.digest))
		);
	}
}
