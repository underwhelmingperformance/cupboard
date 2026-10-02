import {
	type NarInfoGeneration,
	type NixSha256HashString,
	type StorePathHash
} from '@cupboard/nix-store/scalars';
import { type IsoTimestamp } from '@cupboard/protocol/scalars';
import { type UploadId } from '@cupboard/protocol/upload';
import { and, desc, eq, type SQL, sql } from 'drizzle-orm';

import { cacheScopeFromRow, type ResolvedCache } from '../db/cache.ts';
import * as schema from '../db/schema.ts';

import { type SchemaWriter, type ServerContext } from './context.ts';
import { WorkSequenceService } from './work-sequence-service.ts';

export const protectedSourcePageSize = 100;

export function pendingAcceptedBeforeDeletion(): SQL {
	const pending = schema.pendingUploads;
	const deletion = schema.narInfoDeletions;
	return sql`${pending.acceptedSequence} <= ${deletion.protectionCutoff} and (coalesce(${pending.acceptedExpiresAt}, ${pending.expiresAt}) > ${deletion.protectionCapturedAt} or ${pending.commitStartedSequence} <= ${deletion.protectionCutoff})`;
}

export function inheritanceAcceptedBeforeDeletion(): SQL {
	const queue = schema.attestationInheritances;
	const deletion = schema.narInfoDeletions;
	return sql`${queue.acceptedSequence} <= ${deletion.protectionCutoff} and (${queue.queuedSequence} <= ${deletion.protectionCutoff} or ${queue.acceptedExpiresAt} > ${deletion.protectionCapturedAt} or ${queue.commitStartedSequence} <= ${deletion.protectionCutoff})`;
}

export class ProtectedInheritanceService {
	constructor(private readonly context: ServerContext) {}

	private queueFilter(
		cache: ResolvedCache,
		storePathHash: StorePathHash,
		generation: NarInfoGeneration
	): SQL {
		const table = schema.attestationInheritances;
		return (
			and(
				eq(table.cacheId, cache.id),
				eq(table.storePathHash, storePathHash),
				eq(table.generation, generation)
			) ?? sql`false`
		);
	}

	private cohortRows(
		storePathHash: StorePathHash,
		narHash: NixSha256HashString,
		cursor: { readonly cacheId: number; readonly generation: number },
		options: {
			readonly upper?: {
				readonly cacheId: number;
				readonly generation: number;
			};
			readonly isReverse?: boolean;
			readonly cacheId?: number;
		} = {}
	) {
		const { upper, isReverse = false, cacheId } = options;
		const identity = schema.cacheIdentities;
		const select = (
			table: typeof schema.narInfos | typeof schema.narInfoDeletions
		) =>
			this.context.db
				.select({ cacheId: table.cacheId, generation: table.generation })
				.from(table)
				.where(
					and(
						eq(table.storePathHash, storePathHash),
						eq(table.narHash, narHash),
						cacheId === undefined
							? undefined
							: eq(table.cacheId, sql`${cacheId}`),
						sql`(${table.cacheId}, ${table.generation}) > (${cursor.cacheId}, ${cursor.generation})`,
						upper === undefined
							? undefined
							: sql`(${table.cacheId}, ${table.generation}) <= (${upper.cacheId}, ${upper.generation})`
					)
				)
				.orderBy(
					isReverse ? desc(table.cacheId) : table.cacheId,
					isReverse ? desc(table.generation) : table.generation
				)
				.limit(1)
				.all();
		const rows = [
			...select(schema.narInfos),
			...select(schema.narInfoDeletions)
		].toSorted(
			(left, right) =>
				left.cacheId - right.cacheId || left.generation - right.generation
		);
		const row = isReverse ? rows.at(-1) : rows[0];
		if (row === undefined) {
			return;
		}
		const cache = this.context.db
			.select()
			.from(identity)
			.where(eq(identity.id, row.cacheId))
			.get();
		return { ...row, cache };
	}

	private sourceAfterCursor(
		cache: ResolvedCache,
		storePathHash: StorePathHash,
		narHash: NixSha256HashString,
		generation: NarInfoGeneration
	) {
		const table = schema.attestationInheritances;
		const filter = this.queueFilter(cache, storePathHash, generation);
		let queue = this.context.db.select().from(table).where(filter).get();
		if (queue === undefined) {
			return;
		}
		if (queue.sourceEndCacheId === null || queue.sourceEndGeneration === null) {
			const end = this.cohortRows(
				storePathHash,
				narHash,
				{ cacheId: 0, generation: -1 },
				{ isReverse: true }
			);
			if (end === undefined) {
				return;
			}
			this.context.db
				.update(table)
				.set({
					sourceEndCacheId: end.cacheId,
					sourceEndGeneration: end.generation
				})
				.where(filter)
				.run();
			queue = {
				...queue,
				sourceEndCacheId: end.cacheId,
				sourceEndGeneration: end.generation
			};
		}
		if (queue.sourceEndCacheId === null || queue.sourceEndGeneration === null) {
			return;
		}
		const upper = {
			cacheId: queue.sourceEndCacheId,
			generation: queue.sourceEndGeneration
		};
		let source = this.cohortRows(
			storePathHash,
			narHash,
			{ cacheId: queue.sourceCacheId, generation: queue.sourceGeneration },
			{ upper }
		);
		if (source === undefined) {
			return;
		}
		if (
			source.cacheId === queue.sourceReferenceCacheId &&
			queue.sourceReferenceEndGeneration !== null &&
			source.generation > queue.sourceReferenceEndGeneration
		) {
			this.context.db
				.update(table)
				.set({
					sourceCacheId: source.cacheId,
					sourceGeneration: Number.MAX_SAFE_INTEGER
				})
				.where(filter)
				.run();
			source = this.cohortRows(
				storePathHash,
				narHash,
				{ cacheId: source.cacheId, generation: Number.MAX_SAFE_INTEGER },
				{ upper }
			);
			if (source === undefined) {
				return;
			}
		}
		if (
			source.cacheId !== queue.sourceReferenceCacheId ||
			queue.sourceReferenceEndGeneration === null
		) {
			const end = this.cohortRows(
				storePathHash,
				narHash,
				{ cacheId: 0, generation: -1 },
				{ upper, cacheId: source.cacheId, isReverse: true }
			);
			if (end === undefined) {
				return;
			}
			const [reset] = this.context.db
				.update(table)
				.set({
					sourceReferenceCacheId: source.cacheId,
					sourceReferenceEndGeneration: end.generation,
					sourceReferenceGeneration: -1,
					sourceReferenceComplete: false,
					sourcePredicateType: sql`null`,
					sourceDigest: sql`null`
				})
				.where(filter)
				.returning()
				.all();
			if (reset === undefined) {
				return;
			}
			queue = reset;
		}

		const identity = source.cache;
		if (
			identity?.deletedAt !== null ||
			(source.cacheId === cache.id
				? generation <= 0
				: identity.access !== 'public')
		) {
			return { ...source, scope: undefined, queue };
		}
		return { ...source, scope: cacheScopeFromRow(identity), queue };
	}

	nextSource(
		cache: ResolvedCache,
		storePathHash: StorePathHash,
		narHash: NixSha256HashString,
		generation: NarInfoGeneration
	) {
		return this.sourceAfterCursor(cache, storePathHash, narHash, generation);
	}

	nextSourceWithReferences(
		cache: ResolvedCache,
		storePathHash: StorePathHash,
		narHash: NixSha256HashString,
		generation: NarInfoGeneration
	) {
		for (let visited = 0; visited < protectedSourcePageSize; visited += 1) {
			const source = this.nextSource(cache, storePathHash, narHash, generation);
			if (source === undefined) {
				return;
			}
			const upper =
				source.cacheId === cache.id
					? Math.min(source.generation, generation - 1)
					: source.generation;
			if (
				source.scope !== undefined &&
				(!source.queue.sourceReferenceComplete ||
					source.queue.sourceReferenceGeneration < upper)
			) {
				return source;
			}
			this.advanceSource(cache, storePathHash, generation, source);
		}
		return this.nextSource(cache, storePathHash, narHash, generation);
	}

	isReferenceProtected(
		cache: ResolvedCache,
		storePathHash: StorePathHash,
		generation: NarInfoGeneration,
		sourceCacheId: number,
		referenceGeneration: NarInfoGeneration
	): boolean {
		const table = schema.narInfoDeletions;
		const filter = and(
			eq(table.storePathHash, storePathHash),
			eq(table.cacheId, sql`${sourceCacheId}`),
			eq(table.explicit, true),
			sql`${table.generation} >= ${referenceGeneration}`
		);
		const marker = this.context.db
			.select()
			.from(table)
			.where(filter)
			.orderBy(table.generation)
			.limit(1)
			.get();
		const cutoff = marker?.protectionCutoff ?? undefined;
		const capturedAt = marker?.protectionCapturedAt ?? undefined;
		if (cutoff === undefined || capturedAt === undefined) {
			return false;
		}

		const queue = this.context.db
			.select()
			.from(schema.attestationInheritances)
			.where(this.queueFilter(cache, storePathHash, generation))
			.get();
		return (
			queue?.acceptedSequence !== undefined &&
			queue.acceptedSequence <= cutoff &&
			(queue.queuedSequence <= cutoff ||
				(queue.acceptedExpiresAt !== null &&
					queue.acceptedExpiresAt > capturedAt) ||
				(queue.commitStartedSequence !== null &&
					queue.commitStartedSequence <= cutoff))
		);
	}

	advanceSource(
		cache: ResolvedCache,
		storePathHash: StorePathHash,
		generation: NarInfoGeneration,
		source: { readonly cacheId: number; readonly generation: number }
	): void {
		this.context.db
			.update(schema.attestationInheritances)
			.set({
				sourceCacheId: source.cacheId,
				sourceGeneration: source.generation,
				sourceReferenceComplete: true,
				sourcePredicateType: sql`null`,
				sourceDigest: sql`null`
			})
			.where(this.queueFilter(cache, storePathHash, generation))
			.run();
	}

	firstReadableSource(
		storePathHash: StorePathHash,
		narHash: NixSha256HashString
	) {
		const row = this.cohortRows(storePathHash, narHash, {
			cacheId: 0,
			generation: -1
		});
		if (row === undefined || row.cache?.deletedAt !== null) {
			return;
		}
		return { ...row, scope: cacheScopeFromRow(row.cache) };
	}

	capture(
		handle: SchemaWriter,
		source: ResolvedCache,
		entry: {
			readonly storePathHash: StorePathHash;
			readonly generation: NarInfoGeneration;
		},
		now: IsoTimestamp
	): void {
		const table = schema.narInfoDeletions;
		handle
			.update(table)
			.set({
				explicit: true,
				protectionCutoff: new WorkSequenceService(handle).current(),
				protectionCapturedAt: now
			})
			.where(
				and(
					eq(table.cacheId, source.id),
					eq(table.storePathHash, entry.storePathHash),
					eq(table.generation, entry.generation),
					eq(table.explicit, false)
				)
			)
			.run();
	}

	workFacts(handle: SchemaWriter, uploadId?: UploadId) {
		const pending =
			uploadId === undefined
				? undefined
				: handle
						.select()
						.from(schema.pendingUploads)
						.where(eq(schema.pendingUploads.id, uploadId))
						.get();
		return {
			acceptedUploadId: uploadId,
			acceptedSequence: pending?.acceptedSequence ?? 0,
			acceptedExpiresAt: pending?.acceptedExpiresAt ?? pending?.expiresAt,
			commitStartedSequence: pending?.commitStartedSequence,
			queuedSequence: new WorkSequenceService(handle).allocate()
		};
	}

	/**
	 * Removes one destination's durable eligibility for every protected source.
	 */
	releaseDestination(
		cacheId: ResolvedCache['id'],
		storePathHash: StorePathHash,
		generation: NarInfoGeneration
	): void {
		const table = schema.attestationInheritances;
		this.context.db
			.delete(table)
			.where(
				and(
					eq(table.cacheId, cacheId),
					eq(table.storePathHash, storePathHash),
					eq(table.generation, generation)
				)
			)
			.run();
	}
}
