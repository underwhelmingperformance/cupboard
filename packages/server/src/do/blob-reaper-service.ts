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
	exists,
	gt,
	inArray,
	isNotNull,
	isNull,
	lte,
	notInArray,
	sql
} from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import {
	registerLegacyObjectIncarnations,
	type SharedObjectKind
} from '../blob/object-incarnation.ts';
import {
	drainObjectDeletions,
	recoverAbandonedIncarnations
} from '../blob/object-incarnation-recovery.ts';
import * as d1Schema from '../db/d1-schema.ts';
import {
	blobReaperGraceMs,
	casObjectKey,
	narObjectKey,
	objectDeletionBatchSize,
	objectRecoveryBatchSize,
	type R2ObjectKey
} from '../http/http.ts';

import {
	batchNonEmpty,
	maxOutgoingConnections,
	presentNarObjects
} from './bulk.ts';
import {
	type JsonRowList,
	jsonRowLists,
	type JsonValueList,
	jsonValueLists
} from './json-list.ts';

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

// Identifies a missing CAS object and the object version that fences deletion of
// its reference.
export interface CasReferenceDemotion {
	readonly digest: Sha256HexDigest;
	readonly fenceIncarnation: number;
}

export interface CasReferenceDemoter {
	demote(
		tenant: string,
		demotions: readonly CasReferenceDemotion[]
	): Promise<void>;
}

export type ObjectReaperPhase =
	'delete-existing' | 'recover' | 'arm' | 'collect' | 'delete-collected';

export interface ObjectReaperOutcome {
	readonly continuation: ObjectReaperPhase | undefined;
	readonly deleted: number;
}

interface ReapObjectsOptions {
	readonly arm: (now: Date, limit: number) => Promise<boolean>;
	readonly collect: (
		now: Date,
		limit: number
	) => Promise<{ readonly deleted: number; readonly hasMoreWork: boolean }>;
	readonly kind: SharedObjectKind;
	readonly limit: number;
	readonly logger: Logger;
	readonly now: Date;
	readonly phase: ObjectReaperPhase;
}

// Persist the last key scanned. An empty position wraps to the start. Eventual
// consistency can repeat an idempotent page but cannot skip beyond the stored
// cursor.
export interface DemoteCursor {
	read(): Promise<string>;
	advance(position: string): Promise<void>;
}

/**
 * Builds the registry update, deletion-queue insert, and object-state delete
 * for one chunk of expired NAR objects. The delete returns the rows that still
 * satisfied the fence when it ran.
 */
export function buildBlobCollection(
	d1: DrizzleD1Database<typeof d1Schema>,
	narHashes: JsonValueList<NixSha256HashString>,
	nowIso: IsoTimestamp
) {
	const referencedHashes = d1
		.select({ narHash: d1Schema.blobReference.narHash })
		.from(d1Schema.blobReference);
	const fence = and(
		inArray(d1Schema.blobState.narHash, narHashes),
		isNotNull(d1Schema.blobState.deleteAfter),
		lte(d1Schema.blobState.deleteAfter, nowIso),
		notInArray(d1Schema.blobState.narHash, referencedHashes)
	);
	const sameObjectId = eq(
		d1Schema.blobState.narHash,
		d1Schema.objectIncarnation.objectId
	);
	const sameIncarnation = eq(
		d1Schema.blobState.incarnation,
		d1Schema.objectIncarnation.incarnation
	);
	const collectableState = and(fence, sameObjectId, sameIncarnation);
	const collectable = exists(
		d1
			.select({ one: sql`1` })
			.from(d1Schema.blobState)
			.where(collectableState)
	);
	const registryFilter = and(
		eq(d1Schema.objectIncarnation.kind, 'nar'),
		inArray(d1Schema.objectIncarnation.objectId, narHashes),
		eq(d1Schema.objectIncarnation.state, 'live'),
		collectable
	);
	const narRegistry = eq(d1Schema.objectIncarnation.kind, 'nar');
	const retiredState = eq(d1Schema.objectIncarnation.state, 'absent');
	const retiredFilter = and(
		narRegistry,
		sameObjectId,
		sameIncarnation,
		retiredState
	);
	const retired = exists(
		d1
			.select({ one: sql`1` })
			.from(d1Schema.objectIncarnation)
			.where(retiredFilter)
	);

	return {
		retire: d1
			.update(d1Schema.objectIncarnation)
			.set({ state: 'absent', reservationOwner: sql`null` })
			.where(registryFilter),
		queueDeletion: d1
			.insert(d1Schema.objectDeletion)
			.select(
				d1
					.select({
						kind: sql<SharedObjectKind>`'nar'`.as('kind'),
						objectId: d1Schema.blobState.narHash,
						incarnation: d1Schema.blobState.incarnation,
						removeAfter: sql<IsoTimestamp>`${nowIso}`.as('remove_after')
					})
					.from(d1Schema.blobState)
					.where(and(fence, retired))
			)
			.onConflictDoNothing(),
		remove: d1.delete(d1Schema.blobState).where(and(fence, retired)).returning({
			narHash: d1Schema.blobState.narHash,
			incarnation: d1Schema.blobState.incarnation
		})
	};
}

/**
 * Builds the registry update, deletion-queue insert, and object-state delete
 * for one chunk of expired content-addressed objects.
 */
export function buildCasCollection(
	d1: DrizzleD1Database<typeof d1Schema>,
	digests: JsonValueList<Sha256HexDigest>,
	nowIso: IsoTimestamp
) {
	const referencedDigests = d1
		.select({ digest: d1Schema.attestationReference.digest })
		.from(d1Schema.attestationReference);
	const fence = and(
		inArray(d1Schema.casObject.digest, digests),
		isNotNull(d1Schema.casObject.deleteAfter),
		lte(d1Schema.casObject.deleteAfter, nowIso),
		notInArray(d1Schema.casObject.digest, referencedDigests)
	);
	const sameObjectId = eq(
		d1Schema.casObject.digest,
		d1Schema.objectIncarnation.objectId
	);
	const sameIncarnation = eq(
		d1Schema.casObject.incarnation,
		d1Schema.objectIncarnation.incarnation
	);
	const collectableState = and(fence, sameObjectId, sameIncarnation);
	const collectable = exists(
		d1
			.select({ one: sql`1` })
			.from(d1Schema.casObject)
			.where(collectableState)
	);
	const registryFilter = and(
		eq(d1Schema.objectIncarnation.kind, 'cas'),
		inArray(d1Schema.objectIncarnation.objectId, digests),
		eq(d1Schema.objectIncarnation.state, 'live'),
		collectable
	);
	const casRegistry = eq(d1Schema.objectIncarnation.kind, 'cas');
	const retiredState = eq(d1Schema.objectIncarnation.state, 'absent');
	const retiredFilter = and(
		casRegistry,
		sameObjectId,
		sameIncarnation,
		retiredState
	);
	const retired = exists(
		d1
			.select({ one: sql`1` })
			.from(d1Schema.objectIncarnation)
			.where(retiredFilter)
	);

	return {
		retire: d1
			.update(d1Schema.objectIncarnation)
			.set({ state: 'absent', reservationOwner: sql`null` })
			.where(registryFilter),
		queueDeletion: d1
			.insert(d1Schema.objectDeletion)
			.select(
				d1
					.select({
						kind: sql<SharedObjectKind>`'cas'`.as('kind'),
						objectId: d1Schema.casObject.digest,
						incarnation: d1Schema.casObject.incarnation,
						removeAfter: sql<IsoTimestamp>`${nowIso}`.as('remove_after')
					})
					.from(d1Schema.casObject)
					.where(and(fence, retired))
			)
			.onConflictDoNothing(),
		remove: d1.delete(d1Schema.casObject).where(and(fence, retired)).returning({
			digest: d1Schema.casObject.digest,
			incarnation: d1Schema.casObject.incarnation
		})
	};
}

/**
One version of a NAR object, as the demote scan captured it.
*/
export interface BlobStateVersion {
	readonly narHash: NixSha256HashString;
	readonly incarnation: number;
}

/**
One version of a content-addressed object, as the demote scan captured it.
*/
export interface CasObjectVersion {
	readonly digest: Sha256HexDigest;
	readonly incarnation: number;
}

/**
 * Builds the registry retirement and the object-state delete for the NAR object
 * versions a demote scan captured. A later promotion writes a different version
 * and therefore survives both statements.
 *
 * The parameter test imports this builder so it inspects the production
 * statements.
 */
export function fencedBlobStateDeletion(
	d1: DrizzleD1Database<typeof d1Schema>,
	rows: JsonRowList<BlobStateVersion>
) {
	return {
		retire: d1
			.update(d1Schema.objectIncarnation)
			.set({ state: 'absent', reservationOwner: sql`null` })
			.where(
				and(
					eq(d1Schema.objectIncarnation.kind, 'nar'),
					eq(d1Schema.objectIncarnation.state, 'live'),
					rows.matches({
						narHash: d1Schema.objectIncarnation.objectId,
						incarnation: d1Schema.objectIncarnation.incarnation
					})
				)
			),
		remove: d1
			.delete(d1Schema.blobState)
			.where(
				rows.matches({
					narHash: d1Schema.blobState.narHash,
					incarnation: d1Schema.blobState.incarnation
				})
			)
			.returning({ narHash: d1Schema.blobState.narHash })
	};
}

/**
 * Builds the registry retirement and the object delete for the CAS object
 * versions a demote scan captured.
 */
export function fencedCasObjectDeletion(
	d1: DrizzleD1Database<typeof d1Schema>,
	rows: JsonRowList<CasObjectVersion>
) {
	return {
		retire: d1
			.update(d1Schema.objectIncarnation)
			.set({ state: 'absent', reservationOwner: sql`null` })
			.where(
				and(
					eq(d1Schema.objectIncarnation.kind, 'cas'),
					eq(d1Schema.objectIncarnation.state, 'live'),
					rows.matches({
						digest: d1Schema.objectIncarnation.objectId,
						incarnation: d1Schema.objectIncarnation.incarnation
					})
				)
			),
		remove: d1
			.delete(d1Schema.casObject)
			.where(
				rows.matches({
					digest: d1Schema.casObject.digest,
					incarnation: d1Schema.casObject.incarnation
				})
			)
			.returning({ digest: d1Schema.casObject.digest })
	};
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
	private async armUnreferencedBlobs(
		now: Date,
		limit: number
	): Promise<boolean> {
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
			.limit(limit + 1)
			.all();
		const batch = candidates.slice(0, limit);

		if (batch.length === 0) {
			return false;
		}

		const candidateHashes = batch.map((candidate) => candidate.narHash);

		// The update arms only rows whose timer is still unset, so a concurrent
		// reference wins.
		const queries = jsonValueLists(candidateHashes).map((hashes) => {
			const fence = and(
				inArray(d1Schema.blobState.narHash, hashes),
				isNull(d1Schema.blobState.deleteAfter),
				notInArray(d1Schema.blobState.narHash, referencedHashes)
			);

			return this.d1
				.update(d1Schema.blobState)
				.set({ deleteAfter: deletionTime })
				.where(fence);
		});

		await batchNonEmpty(this.d1, queries);

		return candidates.length > batch.length;
	}

	// Recheck the grace deadline and references while deleting the `blob_state`
	// row. The same transaction records the corresponding R2 key so maintenance
	// can retry an interrupted deletion.
	private async collectExpiredBlobs(
		now: Date,
		limit: number
	): Promise<{ readonly deleted: number; readonly hasMoreWork: boolean }> {
		const nowIso = isoTimestamp(now);
		const expired = await this.d1
			.select({
				narHash: d1Schema.blobState.narHash,
				incarnation: d1Schema.blobState.incarnation
			})
			.from(d1Schema.blobState)
			.where(
				and(
					isNotNull(d1Schema.blobState.deleteAfter),
					lte(d1Schema.blobState.deleteAfter, nowIso)
				)
			)
			.limit(limit + 1)
			.all();
		const batch = expired.slice(0, limit);
		const removedKeys: R2ObjectKey[] = [];

		// `RETURNING` identifies only rows that still satisfy the atomic deletion
		// fence.
		const hashLists = jsonValueLists(batch.map((blob) => blob.narHash));

		for (const hashes of hashLists) {
			await registerLegacyObjectIncarnations(
				this.d1,
				{ kind: 'nar', objectIds: hashes },
				nowIso
			);
			const { retire, queueDeletion, remove } = buildBlobCollection(
				this.d1,
				hashes,
				nowIso
			);
			const collection = await this.d1.batch([retire, queueDeletion, remove]);
			const removed = collection[2];

			for (const row of removed) {
				removedKeys.push(narObjectKey(row.narHash, row.incarnation));
			}
		}

		return {
			deleted: removedKeys.length,
			hasMoreWork: expired.length > batch.length
		};
	}

	private async armUnreferencedCasObjects(
		now: Date,
		limit: number
	): Promise<boolean> {
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
			.limit(limit + 1)
			.all();
		const batch = candidates.slice(0, limit);

		if (batch.length === 0) {
			return false;
		}

		const candidateDigests = batch.map((candidate) => candidate.digest);

		// The update arms only rows whose timer is still unset, so a concurrent
		// attestation reference wins.
		const queries = jsonValueLists(candidateDigests).map((digests) => {
			const fence = and(
				inArray(d1Schema.casObject.digest, digests),
				isNull(d1Schema.casObject.deleteAfter),
				notInArray(d1Schema.casObject.digest, referencedDigests)
			);

			return this.d1
				.update(d1Schema.casObject)
				.set({ deleteAfter: deletionTime })
				.where(fence);
		});

		await batchNonEmpty(this.d1, queries);

		return candidates.length > batch.length;
	}

	private async collectExpiredCasObjects(
		now: Date,
		limit: number
	): Promise<{ readonly deleted: number; readonly hasMoreWork: boolean }> {
		const nowIso = isoTimestamp(now);
		const expired = await this.d1
			.select({
				digest: d1Schema.casObject.digest,
				incarnation: d1Schema.casObject.incarnation
			})
			.from(d1Schema.casObject)
			.where(
				and(
					isNotNull(d1Schema.casObject.deleteAfter),
					lte(d1Schema.casObject.deleteAfter, nowIso)
				)
			)
			.limit(limit + 1)
			.all();
		const batch = expired.slice(0, limit);
		const removedKeys: R2ObjectKey[] = [];

		// `RETURNING` identifies only rows that still satisfy the atomic deletion
		// fence.
		const digestLists = jsonValueLists(batch.map((object) => object.digest));

		for (const digests of digestLists) {
			await registerLegacyObjectIncarnations(
				this.d1,
				{ kind: 'cas', objectIds: digests },
				nowIso
			);
			const { retire, queueDeletion, remove } = buildCasCollection(
				this.d1,
				digests,
				nowIso
			);
			const collection = await this.d1.batch([retire, queueDeletion, remove]);
			const removed = collection[2];

			for (const row of removed) {
				removedKeys.push(casObjectKey(row.digest, row.incarnation));
			}
		}

		return {
			deleted: removedKeys.length,
			hasMoreWork: expired.length > batch.length
		};
	}

	private async referencingDemotions(
		narHashes: readonly NixSha256HashString[]
	): Promise<Map<string, NarInfoDemotion[]>> {
		const pages = await mapWithConcurrency(
			jsonValueLists(narHashes),
			maxOutgoingConnections,
			(list) =>
				this.d1
					.selectDistinct({
						tenant: d1Schema.blobReference.tenant,
						narHash: d1Schema.blobReference.narHash,
						cache: d1Schema.blobReference.cache,
						storePathHash: d1Schema.blobReference.storePathHash
					})
					.from(d1Schema.blobReference)
					.where(inArray(d1Schema.blobReference.narHash, list))
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
		objects: readonly {
			readonly digest: Sha256HexDigest;
			readonly incarnation: number;
		}[]
	): Promise<ReadonlySet<Sha256HexDigest>> {
		const present = await mapWithConcurrency(
			objects,
			maxOutgoingConnections,
			async (object) =>
				(await this.blobs.head(
					casObjectKey(object.digest, object.incarnation)
				)) === null
					? undefined
					: object.digest
		);

		return new Set(
			present.filter(
				(digest): digest is Sha256HexDigest => digest !== undefined
			)
		);
	}

	// Route tenants independently with bounded concurrency. Keep the shared object
	// rows for failed tenants so a later pass retries them.
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
					// Continue routing other tenants. The returned failure set keeps the
					// shared object row for a later pass.
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

	// Delete only the object versions captured by the scan. A later promotion
	// uses a different version and therefore survives.
	private async deleteFencedBlobStates(
		rows: readonly BlobStateVersion[]
	): Promise<number> {
		const queries = jsonRowLists(rows).map((batch) => {
			const { retire, remove } = fencedBlobStateDeletion(this.d1, batch);

			return [retire, remove] as const;
		});

		const results = await batchNonEmpty(this.d1, queries.flat());

		let demoted = 0;

		for (const [index, result] of results.entries()) {
			if (index % 2 === 1 && Array.isArray(result)) {
				demoted += result.length;
			}
		}

		return demoted;
	}

	private demoteBatch(
		after: string,
		limit: number
	): Promise<{ narHash: NixSha256HashString; incarnation: number }[]> {
		return this.d1
			.select({
				narHash: d1Schema.blobState.narHash,
				incarnation: d1Schema.blobState.incarnation
			})
			.from(d1Schema.blobState)
			.where(gt(d1Schema.blobState.narHash, sql`${after}`))
			.orderBy(asc(d1Schema.blobState.narHash))
			.limit(limit)
			.all();
	}

	// Delete only the CAS object versions captured by the scan.
	private async deleteFencedCasObjects(
		rows: readonly CasObjectVersion[]
	): Promise<number> {
		const queries = jsonRowLists(rows).map((batch) => {
			const { retire, remove } = fencedCasObjectDeletion(this.d1, batch);

			return [retire, remove] as const;
		});

		const results = await batchNonEmpty(this.d1, queries.flat());

		let demoted = 0;

		for (const [index, result] of results.entries()) {
			if (index % 2 === 1 && Array.isArray(result)) {
				demoted += result.length;
			}
		}

		return demoted;
	}

	private demoteCasBatch(
		after: string,
		limit: number
	): Promise<{ digest: Sha256HexDigest; incarnation: number }[]> {
		return this.d1
			.select({
				digest: d1Schema.casObject.digest,
				incarnation: d1Schema.casObject.incarnation
			})
			.from(d1Schema.casObject)
			.where(gt(d1Schema.casObject.digest, sql`${after}`))
			.orderBy(asc(d1Schema.casObject.digest))
			.limit(limit)
			.all();
	}

	// Group each digest's referencing tenants in bounded reads. Each tenant then
	// receives one demotion call. Each entry includes the object version read here.
	private async casReferencingDemotions(
		objects: readonly { digest: Sha256HexDigest; incarnation: number }[]
	): Promise<Map<string, CasReferenceDemotion[]>> {
		const incarnationByDigest = new Map(
			objects.map((object) => [object.digest, object.incarnation])
		);
		const pages = await mapWithConcurrency(
			jsonValueLists(objects.map((object) => object.digest)),
			maxOutgoingConnections,
			(list) =>
				this.d1
					.selectDistinct({
						tenant: d1Schema.attestationReference.tenant,
						digest: d1Schema.attestationReference.digest
					})
					.from(d1Schema.attestationReference)
					.where(inArray(d1Schema.attestationReference.digest, list))
					.all()
		);

		const rowsByTenant = Map.groupBy(pages.flat(), (row) => row.tenant);
		const demotionsByTenant = new Map<string, CasReferenceDemotion[]>();

		for (const [tenant, rows] of rowsByTenant) {
			demotionsByTenant.set(
				tenant,
				rows.flatMap((row) => {
					const fenceIncarnation = incarnationByDigest.get(row.digest);

					return fenceIncarnation === undefined
						? []
						: [{ digest: row.digest, fenceIncarnation }];
				})
			);
		}

		return demotionsByTenant;
	}

	private async reapObjects({
		arm,
		collect,
		kind,
		limit,
		logger,
		now,
		phase
	}: ReapObjectsOptions): Promise<ObjectReaperOutcome> {
		switch (phase) {
			case 'delete-existing': {
				const result = await drainObjectDeletions(
					this.d1,
					this.blobs,
					kind,
					Math.min(limit, objectDeletionBatchSize)
				);

				return {
					deleted: 0,
					continuation: result.hasMoreWork ? phase : 'recover'
				};
			}
			case 'recover': {
				const result = await recoverAbandonedIncarnations(
					this.d1,
					this.blobs,
					kind,
					now,
					Math.min(limit, objectRecoveryBatchSize),
					logger
				);

				return {
					deleted: 0,
					continuation: result.hasMoreWork ? phase : 'arm'
				};
			}
			case 'arm': {
				return {
					deleted: 0,
					continuation: (await arm(now, limit)) ? phase : 'collect'
				};
			}
			case 'collect': {
				const result = await collect(now, limit);

				return {
					deleted: result.deleted,
					continuation: result.hasMoreWork ? phase : 'delete-collected'
				};
			}
			case 'delete-collected': {
				const result = await drainObjectDeletions(
					this.d1,
					this.blobs,
					kind,
					Math.min(limit, objectDeletionBatchSize)
				);

				return {
					deleted: 0,
					continuation: result.hasMoreWork ? phase : undefined
				};
			}
		}
	}

	async reapBlobs(
		logger: Logger,
		now: Date,
		limit: number,
		phase: ObjectReaperPhase
	): Promise<ObjectReaperOutcome> {
		return this.reapObjects({
			arm: (at, pageSize) => this.armUnreferencedBlobs(at, pageSize),
			collect: (at, pageSize) => this.collectExpiredBlobs(at, pageSize),
			kind: 'nar',
			limit,
			logger,
			now,
			phase
		});
	}

	async reapCasObjects(
		logger: Logger,
		now: Date,
		limit: number,
		phase: ObjectReaperPhase
	): Promise<ObjectReaperOutcome> {
		return this.reapObjects({
			arm: (at, pageSize) => this.armUnreferencedCasObjects(at, pageSize),
			collect: (at, pageSize) => this.collectExpiredCasObjects(at, pageSize),
			kind: 'cas',
			limit,
			logger,
			now,
			phase
		});
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

		const present = await presentNarObjects(this.blobs, batch);
		const missing = batch.filter((blob) => !present.has(blob.narHash));

		if (missing.length === 0) {
			return 0;
		}

		// Delete a shared blob row only after every referencing tenant was updated.
		// A hash with no tenant references is eligible immediately.
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

		const present = await this.presentCasObjects(batch);
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
