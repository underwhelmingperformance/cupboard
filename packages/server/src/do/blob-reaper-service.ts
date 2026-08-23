import { type Logger } from '@cupboard/logger';
import {
	type NixSha256HashString,
	type Sha256HexDigest,
	type StoredCache,
	type StorePathHash
} from '@cupboard/nix-store/scalars';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
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
import {
	blobReaperGraceMs,
	casObjectKey,
	narObjectKey,
	type R2ObjectKey
} from '../http/http.ts';

import {
	batchNonEmpty,
	chunk,
	deleteObjects,
	maxInClauseValues,
	maxOutgoingConnections,
	presentNarObjects
} from './bulk.ts';

export interface DemoteTarget {
	readonly cache: StoredCache;
	readonly storePathHash: StorePathHash;
}

export interface NarInfoDemotion {
	readonly narHash: NixSha256HashString;
	readonly targets: readonly DemoteTarget[];
}

// Route narinfo changes through the owning tenant Durable Object. The global
// reaper must not write tenant-owned objects directly.
export interface NarInfoDemoter {
	demote(tenant: string, demotions: readonly NarInfoDemotion[]): Promise<void>;
}

export interface CasReferenceDemotion {
	readonly digest: Sha256HexDigest;
	readonly fenceStoredAt: IsoTimestamp;
}

export interface CasReferenceDemoter {
	demote(
		tenant: string,
		demotions: readonly CasReferenceDemotion[]
	): Promise<void>;
}

const maxFencedDeleteRows = Math.floor(maxInClauseValues / 2);

// Persist the last key scanned. An empty position wraps to the start. Eventual
// consistency can repeat an idempotent page but cannot skip beyond the stored
// cursor.
export interface DemoteCursor {
	read(): Promise<string>;
	advance(position: string): Promise<void>;
}

// The Worker runs this reaper because only it can see reference edges for every
// tenant. One bounded pass arms unreferenced objects; a later pass removes rows
// whose grace expired and which remain unreferenced. Atomic compare-and-delete,
// not a Durable Object gate, protects concurrent commits and promotions.
export class BlobReaperService {
	constructor(
		private readonly d1: DrizzleD1Database<typeof d1Schema>,
		private readonly blobs: R2Bucket,
		private readonly demoter: NarInfoDemoter,
		private readonly casDemoter: CasReferenceDemoter
	) {}

	// Determine global reachability from `blob_ref.nar_hash`, not from one
	// tenant's narinfos. A later reference clears the grace timer.
	private async armUnreferencedBlobs(now: Date, limit: number): Promise<void> {
		const deletionTime = isoTimestamp(
			new Date(now.getTime() + blobReaperGraceMs)
		);
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

		// Chunk the update for D1's parameter limit. Each chunk arms only rows whose
		// timer is still unset, so a concurrent reference wins.
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

	// Recheck the grace deadline and global reachability in the delete statement.
	// Delete D1 first so a crash before the R2 delete leaves only an orphaned
	// content-addressed object that a later promotion can adopt.
	private async collectExpiredBlobs(now: Date, limit: number): Promise<number> {
		const nowIso = isoTimestamp(now);
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
		const removedKeys: R2ObjectKey[] = [];
		const referencedHashes = this.d1
			.select({ narHash: d1Schema.blobReference.narHash })
			.from(d1Schema.blobReference);

		// `RETURNING` identifies only rows that still satisfy the atomic deletion
		// fence.
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

		// Preserve D1-first, R2-last ordering across every chunk.
		await deleteObjects(this.blobs, removedKeys);

		return removedKeys.length;
	}

	private async armUnreferencedCasObjects(
		now: Date,
		limit: number
	): Promise<void> {
		const deletionTime = isoTimestamp(
			new Date(now.getTime() + blobReaperGraceMs)
		);
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

		// Chunk the update for D1's parameter limit. Each chunk arms only rows whose
		// timer is still unset, so a concurrent attestation reference wins.
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
		const nowIso = isoTimestamp(now);
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
		const removedKeys: R2ObjectKey[] = [];
		const referencedDigests = this.d1
			.select({ digest: d1Schema.attestationReference.digest })
			.from(d1Schema.attestationReference);

		// `RETURNING` identifies only rows that still satisfy the atomic deletion
		// fence.
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

	// Route tenants independently with bounded concurrency. Keep global facts for
	// failed tenants so a later pass retries them.
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
					// Continue other tenants but report this failure to the cron caller.
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

	// Fence each deletion on the `verified_at` value captured by the scan so a
	// re-promoted row survives. Chunk the predicate for D1's parameter limit.
	private async deleteFencedBlobStates(
		rows: readonly { narHash: NixSha256HashString; verifiedAt: IsoTimestamp }[]
	): Promise<number> {
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

	private demoteBatch(
		after: string,
		limit: number
	): Promise<{ narHash: NixSha256HashString; verifiedAt: IsoTimestamp }[]> {
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

	// Fence each deletion on the `stored_at` value captured by the scan so a
	// re-stored object survives.
	private async deleteFencedCasObjects(
		rows: readonly { digest: Sha256HexDigest; storedAt: IsoTimestamp }[]
	): Promise<number> {
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
	): Promise<{ digest: Sha256HexDigest; storedAt: IsoTimestamp }[]> {
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

	private async casReferencingDemotions(
		objects: readonly { digest: Sha256HexDigest; storedAt: IsoTimestamp }[]
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

	async reapBlobs(now: Date, limit: number): Promise<number> {
		await this.armUnreferencedBlobs(now, limit);

		return this.collectExpiredBlobs(now, limit);
	}

	async reapCasObjects(now: Date, limit: number): Promise<number> {
		await this.armUnreferencedCasObjects(now, limit);

		return this.collectExpiredCasObjects(now, limit);
	}

	// Dematerialise tenant narinfos before deleting the global `blob_state` row.
	// Reads use the tenant narinfo object, so the global row must remain as the
	// durable retry marker until every tenant update succeeds.
	async demoteMissingBlobs(
		logger: Logger,
		limit: number,
		cursor: DemoteCursor
	): Promise<number> {
		const log = logger.with({ job: 'blob-reaper' });
		const after = await cursor.read();
		const batch = await this.demoteBatch(after, limit);

		// Advance before processing so one failing page cannot wedge the cursor. A
		// short page wraps the next pass to the start.
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

		// Delete a global fact only after every referencing tenant was updated. A
		// hash with no tenant references is eligible immediately.
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
