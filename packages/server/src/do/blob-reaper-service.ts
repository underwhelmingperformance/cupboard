import {
	and,
	eq,
	inArray,
	isNotNull,
	isNull,
	lte,
	notInArray
} from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from '../db/d1-schema.ts';
import { blobReaperGraceMs, narObjectKey } from '../http/http.ts';

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
		private readonly blobs: R2Bucket
	) {}

	// Returns how many shared blobs it collected.
	async reapBlobs(now: Date, limit: number): Promise<number> {
		await this.armUnreferencedBlobs(now, limit);

		return this.collectExpiredBlobs(now, limit);
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
}
