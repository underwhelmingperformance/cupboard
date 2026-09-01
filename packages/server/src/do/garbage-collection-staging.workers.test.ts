import { rootLogger } from '@cupboard/logger';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { uploadIdSchema } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { pendingAttestations, pendingUploads } from '../db/schema.ts';
import { stagingObjectKey } from '../http/http.ts';
import {
	clearBlobStorage,
	currentServer,
	initialise,
	resetTestServer,
	resolvedCache,
	syntheticNarHash,
	testPushId
} from '../test-support.ts';

import { AttestationCasService } from './attestation-cas-service.ts';
import { AttestationsService } from './attestations-service.ts';
import { DeletionQueueService } from './deletion-queue-service.ts';
import {
	GarbageCollectionService,
	maxPendingRowsDeletedPerRun
} from './garbage-collection-service.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';
import { RetentionService } from './retention-service.ts';

const uploadGraceMs = 15 * 60 * 1000;

// R2 uses the real clock for `uploaded`, while this harness can replace `Date`.
// Read an R2 timestamp before moving the fake clock past the grace period.
async function realUploadInstant(): Promise<number> {
	await env.BLOBS.put('probe/now', new Uint8Array([0]));
	const head = await env.BLOBS.head('probe/now');
	await env.BLOBS.delete('probe/now');

	if (head === null) {
		throw new Error('probe object vanished');
	}

	return head.uploaded.getTime();
}

function stagingDeleteFailingBucket(
	target: R2Bucket,
	failKey: string,
	onFail: () => void
): R2Bucket {
	return new Proxy(target, {
		get(bucketTarget, property) {
			if (property === 'delete') {
				return async (keys: string | string[]) => {
					const batch = Array.isArray(keys) ? keys : [keys];

					if (batch.includes(failKey)) {
						onFail();
						throw new Error('staging delete did not land');
					}

					await bucketTarget.delete(keys);
				};
			}

			const value: unknown = Reflect.get(bucketTarget, property, bucketTarget);

			if (typeof value !== 'function') {
				return value;
			}

			const bound: unknown = value.bind(bucketTarget);

			return bound;
		}
	});
}

describe('garbage collection best-effort staging deletes', () => {
	beforeEach(async () => {
		await resetTestServer();
		await clearBlobStorage();
	});

	it('reports the expired upload and still deletes orphan staging when one R2 delete fails', async () => {
		const realNow = await realUploadInstant();
		await initialise();

		const reapedKey = stagingObjectKey(
			testPushId,
			uploadIdSchema.parse('reaped-upload')
		);
		const orphanKey = 'staging/orphan-push/orphan.nar.zst';
		await env.BLOBS.put(orphanKey, new Uint8Array([1, 2, 3]));

		// Advance from R2's timestamp so the orphan is older than the upload grace.
		vi.setSystemTime(new Date(realNow + uploadGraceMs + 5 * 60 * 1000));

		const { outcome, failedDeletes } = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const cacheId = resolvedCache(instance.context).id;

				drizzle(state.storage, { schema: { pendingUploads } })
					.insert(pendingUploads)
					.values({
						id: uploadIdSchema.parse('reaped-upload'),
						cacheId,
						narHash: syntheticNarHash(1),
						r2Key: reapedKey,
						metadataJson: '{}',
						createdAt: isoTimestampSchema.parse('1970-01-01T00:00:00.000Z'),
						expiresAt: isoTimestampSchema.parse('1970-01-01T00:00:00.000Z')
					})
					.run();

				let failedDeletes = 0;
				instance.context.env = {
					...instance.context.env,
					BLOBS: stagingDeleteFailingBucket(
						instance.context.env.BLOBS,
						reapedKey,
						() => {
							failedDeletes += 1;
						}
					)
				};

				const narInfoObjects = new NarInfoObjectsService(instance.context);
				const attestationCas = new AttestationCasService(instance.context);
				const attestations = new AttestationsService(
					instance.context,
					attestationCas,
					narInfoObjects
				);
				const deletionQueue = new DeletionQueueService(
					instance.context,
					attestationCas,
					attestations,
					narInfoObjects
				);
				const garbageCollection = new GarbageCollectionService(
					instance.context,
					deletionQueue,
					new RetentionService(instance.context)
				);

				return {
					outcome: await garbageCollection.collectGarbage(rootLogger(), {
						scope: 'tenant'
					}),
					failedDeletes
				};
			}
		);

		expect({
			outcome,
			failedDeletes,
			orphanPresent: (await env.BLOBS.head(orphanKey)) !== null
		}).toStrictEqual({
			outcome: {
				pendingUploadsDeleted: 1,
				pendingAttestationsDeleted: 0,
				rootsExpired: 0,
				pathsCollected: 0,
				hasMoreExpiredRoots: false,
				hasMoreWork: false,
				narInfosDeleted: 0,
				orphanStagingDeleted: 1
			},
			failedDeletes: 1,
			orphanPresent: false
		});
	});

	it('drains expired pending rows across bounded collection passes', async () => {
		await initialise();
		const expired = isoTimestampSchema.parse('1970-01-01T00:00:00.000Z');
		const backlogSize = maxPendingRowsDeletedPerRun + 1;

		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const cache = resolvedCache(instance.context);
				state.storage.sql.exec(
					`WITH digits(digit) AS (VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)),
					 rows(value) AS (
					   SELECT ones.digit + tens.digit * 10 + hundreds.digit * 100 + thousands.digit * 1000
					   FROM digits AS ones
					   CROSS JOIN digits AS tens
					   CROSS JOIN digits AS hundreds
					   CROSS JOIN digits AS thousands
					 )
					 INSERT INTO pending_upload
					   (id, cache_id, nar_hash, r2_key, metadata_json, created_at, expires_at)
					 SELECT printf('expired-upload-%d', value), ?, ?,
					        printf('staging/expired/upload-%d', value), '{}', ?, ?
					 FROM rows WHERE value < ?`,
					cache.id,
					syntheticNarHash(1),
					expired,
					expired,
					backlogSize
				);
				state.storage.sql.exec(
					`WITH digits(digit) AS (VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)),
					 rows(value) AS (
					   SELECT ones.digit + tens.digit * 10 + hundreds.digit * 100 + thousands.digit * 1000
					   FROM digits AS ones
					   CROSS JOIN digits AS tens
					   CROSS JOIN digits AS hundreds
					   CROSS JOIN digits AS thousands
					 )
					 INSERT INTO pending_attestation
					   (id, cache_id, store_path_hash, digest, r2_key, created_at, expires_at)
					 SELECT printf('expired-attestation-%d', value), ?, ?, ?,
					        printf('staging/expired/attestation-%d', value), ?, ?
					 FROM rows WHERE value < ?`,
					cache.id,
					'a'.repeat(32),
					'b'.repeat(64),
					expired,
					expired,
					backlogSize
				);

				const narInfoObjects = new NarInfoObjectsService(instance.context);
				const attestationCas = new AttestationCasService(instance.context);
				const attestations = new AttestationsService(
					instance.context,
					attestationCas,
					narInfoObjects
				);
				const deletionQueue = new DeletionQueueService(
					instance.context,
					attestationCas,
					attestations,
					narInfoObjects
				);
				const garbageCollection = new GarbageCollectionService(
					instance.context,
					deletionQueue,
					new RetentionService(instance.context)
				);
				const first = await garbageCollection.collectGarbage(rootLogger(), {
					scope: 'tenant'
				});
				const remainingAfterFirst = {
					uploads: drizzle(state.storage, { schema: { pendingUploads } })
						.select({ id: pendingUploads.id })
						.from(pendingUploads)
						.all().length,
					attestations: drizzle(state.storage, {
						schema: { pendingAttestations }
					})
						.select({ id: pendingAttestations.id })
						.from(pendingAttestations)
						.all().length
				};
				const second = await garbageCollection.collectGarbage(rootLogger(), {
					scope: 'tenant'
				});

				return {
					first: {
						pendingUploadsDeleted: first.pendingUploadsDeleted,
						pendingAttestationsDeleted: first.pendingAttestationsDeleted,
						hasMoreWork: first.hasMoreWork
					},
					remainingAfterFirst,
					second: {
						pendingUploadsDeleted: second.pendingUploadsDeleted,
						pendingAttestationsDeleted: second.pendingAttestationsDeleted,
						hasMoreWork: second.hasMoreWork
					}
				};
			}
		);

		expect(result).toStrictEqual({
			first: {
				pendingUploadsDeleted: maxPendingRowsDeletedPerRun,
				pendingAttestationsDeleted: maxPendingRowsDeletedPerRun,
				hasMoreWork: true
			},
			remainingAfterFirst: { uploads: 1, attestations: 1 },
			second: {
				pendingUploadsDeleted: 1,
				pendingAttestationsDeleted: 1,
				hasMoreWork: false
			}
		});
	});
});
