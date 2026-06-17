import {
	type NixSha256HashString,
	type StorePathHash
} from '@cupboard/nix/scalars';
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
	sql
} from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from '../db/d1-schema.ts';
import { blobReaperGraceMs, casObjectKey, narObjectKey } from '../http/http.ts';

// One narinfo whose object the demote pass must take down: a tenant, the cache it
// lives in, and its store-path hash. The reaper groups these by tenant and routes
// them to the owning tenant's Durable Object, the single writer of that tenant's
// objects.
export interface DemoteTarget {
	readonly cache: string;
	readonly storePathHash: StorePathHash;
}

// The port the demote pass reaches a tenant's Durable Object through. The reaper
// itself never touches a tenant's objects; it asks the owning tenant to
// de-materialise the narinfos referencing a hash whose shared object is gone, so the
// per-tenant single-writer rule holds.
export interface NarInfoDemoter {
	demote(
		tenant: string,
		narHash: NixSha256HashString,
		targets: readonly DemoteTarget[]
	): Promise<void>;
}

export interface CasReferenceDemoter {
	demote(tenant: string, digest: string, fenceStoredAt: string): Promise<void>;
}

// The demote scan's resume position across cron ticks. It is the last `nar_hash`
// reached, an exclusive lower bound for the next keyset page, with '' meaning start
// from the beginning (and written back to wrap). It is pure cron bookkeeping rather
// than shared-blob data, so the Worker backs it with a single KV value instead of a
// relational row; the eventual consistency is harmless because the scan is idempotent
// and the position only ever resumes a window it would otherwise cover anyway.
export interface DemoteCursor {
	read(): Promise<string>;
	advance(position: string): Promise<void>;
}

// The global blob reaper. It is the only actor that sees every tenant's reference
// edges, so it runs Worker-side over the shared D1 facts rather than inside any one
// tenant's Durable Object, driven by the cron. It works `blob_state` in two
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
		limit: number,
		cursor: DemoteCursor
	): Promise<number> {
		const after = await cursor.read();
		const batch = await this.demoteBatch(after, limit);

		// A short page means the scan reached the end of the hash order, so wrap to the
		// start; otherwise resume after the last hash scanned. Advanced before
		// processing, so a per-blob failure does not wedge the scan.
		const next = batch.length < limit ? '' : (batch.at(-1)?.narHash ?? '');
		await cursor.advance(next);

		let demoted = 0;

		for (const blob of batch) {
			const present =
				(await this.blobs.head(narObjectKey(blob.narHash))) !== null;

			if (present) {
				continue;
			}

			if (await this.demoteBlob(blob.narHash, blob.verifiedAt)) {
				demoted += 1;
			}
		}

		return demoted;
	}

	async demoteMissingCasObjects(
		limit: number,
		cursor: DemoteCursor
	): Promise<number> {
		const after = await cursor.read();
		const batch = await this.demoteCasBatch(after, limit);
		const next = batch.length < limit ? '' : (batch.at(-1)?.digest ?? '');
		await cursor.advance(next);

		let demoted = 0;

		for (const object of batch) {
			const present =
				(await this.blobs.head(casObjectKey(object.digest))) !== null;

			if (present) {
				continue;
			}

			const tenants = await this.casReferencingTenants(object.digest);

			for (const tenant of tenants) {
				await this.casDemoter.demote(tenant, object.digest, object.storedAt);
			}

			if (await this.demoteCasObject(object.digest, object.storedAt)) {
				demoted += 1;
			}
		}

		return demoted;
	}

	// Arms unreferenced shared blobs with a grace timer. The cross-tenant
	// "referenced anywhere" probe is on `blob_ref.nar_hash` (its dedicated index),
	// not any one tenant's narinfos. Bounded: only a batch is armed per pass, and a
	// commit that re-references a hash clears the timer it set.
	private async armUnreferencedBlobs(now: Date, limit: number): Promise<void> {
		const deleteAfter = new Date(
			now.getTime() + blobReaperGraceMs
		).toISOString();
		const candidates = await this.d1
			.select({ narHash: d1Schema.blobState.narHash })
			.from(d1Schema.blobState)
			.where(
				and(
					isNull(d1Schema.blobState.deleteAfter),
					notInArray(
						d1Schema.blobState.narHash,
						this.d1
							.select({ narHash: d1Schema.blobReference.narHash })
							.from(d1Schema.blobReference)
					)
				)
			)
			.limit(limit)
			.all();

		if (candidates.length === 0) {
			return;
		}

		await this.d1
			.update(d1Schema.blobState)
			.set({ deleteAfter })
			.where(
				and(
					inArray(
						d1Schema.blobState.narHash,
						candidates.map((candidate) => candidate.narHash)
					),
					isNull(d1Schema.blobState.deleteAfter)
				)
			)
			.run();
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
		let collected = 0;

		for (const blob of expired) {
			const removed = await this.d1
				.delete(d1Schema.blobState)
				.where(
					and(
						eq(d1Schema.blobState.narHash, blob.narHash),
						isNotNull(d1Schema.blobState.deleteAfter),
						lte(d1Schema.blobState.deleteAfter, nowIso),
						notInArray(
							d1Schema.blobState.narHash,
							this.d1
								.select({ narHash: d1Schema.blobReference.narHash })
								.from(d1Schema.blobReference)
						)
					)
				)
				.returning({ narHash: d1Schema.blobState.narHash })
				.all();

			if (removed.length > 0) {
				await this.blobs.delete(narObjectKey(blob.narHash));
				collected += 1;
			}
		}

		return collected;
	}

	private async armUnreferencedCasObjects(
		now: Date,
		limit: number
	): Promise<void> {
		const deleteAfter = new Date(
			now.getTime() + blobReaperGraceMs
		).toISOString();
		const candidates = await this.d1
			.select({ digest: d1Schema.casObject.digest })
			.from(d1Schema.casObject)
			.where(
				and(
					isNull(d1Schema.casObject.deleteAfter),
					notInArray(
						d1Schema.casObject.digest,
						this.d1
							.select({ digest: d1Schema.attestationReference.digest })
							.from(d1Schema.attestationReference)
					)
				)
			)
			.limit(limit)
			.all();

		if (candidates.length === 0) {
			return;
		}

		await this.d1
			.update(d1Schema.casObject)
			.set({ deleteAfter })
			.where(
				and(
					inArray(
						d1Schema.casObject.digest,
						candidates.map((candidate) => candidate.digest)
					),
					isNull(d1Schema.casObject.deleteAfter)
				)
			)
			.run();
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
		let collected = 0;

		for (const object of expired) {
			const removed = await this.d1
				.delete(d1Schema.casObject)
				.where(
					and(
						eq(d1Schema.casObject.digest, object.digest),
						isNotNull(d1Schema.casObject.deleteAfter),
						lte(d1Schema.casObject.deleteAfter, nowIso),
						notInArray(
							d1Schema.casObject.digest,
							this.d1
								.select({ digest: d1Schema.attestationReference.digest })
								.from(d1Schema.attestationReference)
						)
					)
				)
				.returning({ digest: d1Schema.casObject.digest })
				.all();

			if (removed.length > 0) {
				await this.blobs.delete(casObjectKey(object.digest));
				collected += 1;
			}
		}

		return collected;
	}

	// De-materialises the referencing narinfos for a hash whose object is gone, then
	// deletes the `blob_state` row. The narinfos go first (idempotent in each owning
	// Durable Object), and the fact is deleted last, fenced on the `verified_at`
	// captured at scan so a row deleted and re-promoted in the window is left intact.
	// If routing to any tenant fails, the fact is left in place and the next pass
	// re-drives it. Returns whether the fact was demoted.
	private async demoteBlob(
		narHash: NixSha256HashString,
		verifiedAt: string
	): Promise<boolean> {
		const targetsByTenant = await this.referencingTargets(narHash);

		for (const [tenant, targets] of targetsByTenant) {
			await this.demoter.demote(tenant, narHash, targets);
		}

		const removed = await this.d1
			.delete(d1Schema.blobState)
			.where(
				and(
					eq(d1Schema.blobState.narHash, narHash),
					eq(d1Schema.blobState.verifiedAt, verifiedAt)
				)
			)
			.returning({ narHash: d1Schema.blobState.narHash })
			.all();

		return removed.length > 0;
	}

	private async referencingTargets(
		narHash: NixSha256HashString
	): Promise<Map<string, DemoteTarget[]>> {
		const edges = await this.d1
			.selectDistinct({
				tenant: d1Schema.blobReference.tenant,
				cache: d1Schema.blobReference.cache,
				storePathHash: d1Schema.blobReference.storePathHash
			})
			.from(d1Schema.blobReference)
			.where(eq(d1Schema.blobReference.narHash, narHash))
			.all();

		const byTenant = new Map<string, DemoteTarget[]>();

		for (const edge of edges) {
			const targets = byTenant.get(edge.tenant) ?? [];
			targets.push({ cache: edge.cache, storePathHash: edge.storePathHash });
			byTenant.set(edge.tenant, targets);
		}

		return byTenant;
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

	private async demoteCasObject(
		digest: string,
		storedAt: string
	): Promise<boolean> {
		const removed = await this.d1
			.delete(d1Schema.casObject)
			.where(
				and(
					eq(d1Schema.casObject.digest, digest),
					eq(d1Schema.casObject.storedAt, storedAt)
				)
			)
			.returning({ digest: d1Schema.casObject.digest })
			.all();

		return removed.length > 0;
	}

	private demoteCasBatch(
		after: string,
		limit: number
	): Promise<{ digest: string; storedAt: string }[]> {
		return this.d1
			.select({
				digest: d1Schema.casObject.digest,
				storedAt: d1Schema.casObject.storedAt
			})
			.from(d1Schema.casObject)
			.where(gt(d1Schema.casObject.digest, after))
			.orderBy(asc(d1Schema.casObject.digest))
			.limit(limit)
			.all();
	}

	private async casReferencingTenants(digest: string): Promise<string[]> {
		const rows = await this.d1
			.selectDistinct({ tenant: d1Schema.attestationReference.tenant })
			.from(d1Schema.attestationReference)
			.where(eq(d1Schema.attestationReference.digest, digest))
			.all();

		return rows.map((row) => row.tenant);
	}
}
