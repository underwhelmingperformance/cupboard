import { rootLogger } from '@cupboard/logger';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { uploadIdSchema } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { pendingUploads } from '../db/schema.ts';
import { stagingObjectKey } from '../http/http.ts';
import {
	clearBlobStorage,
	currentServer,
	initialise,
	resetTestServer,
	syntheticNarHash,
	testPushId
} from '../test-support.ts';

import { AttestationCasService } from './attestation-cas-service.ts';
import { AttestationsService } from './attestations-service.ts';
import { DeletionQueueService } from './deletion-queue-service.ts';
import { GarbageCollectionService } from './garbage-collection-service.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';
import { RetentionService } from './retention-service.ts';

const uploadGraceMs = 15 * 60 * 1000;

// The real wall-clock instant R2 stamps onto an object written now, recovered
// past the harness's faked `Date`, so the collection's clock can be moved
// relative to an object's uploaded time.
async function realUploadInstant(): Promise<number> {
	await env.BLOBS.put('probe/now', new Uint8Array([0]));
	const head = await env.BLOBS.head('probe/now');
	await env.BLOBS.delete('probe/now');

	if (head === null) {
		throw new Error('probe object vanished');
	}

	return head.uploaded.getTime();
}

// A bucket whose delete rejects for `failKey`, counting the rejection, and
// delegates every other operation: the shape of an R2 delete that does not land.
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

	it('keeps the outcome and runs the orphan reclaim when a staging delete fails', async () => {
		const realNow = await realUploadInstant();
		await initialise();

		const reapedKey = stagingObjectKey(
			testPushId,
			uploadIdSchema.parse('reaped-upload')
		);
		const orphanKey = 'staging/orphan-push/orphan.nar.zst';
		await env.BLOBS.put(orphanKey, new Uint8Array([1, 2, 3]));

		// The collection's clock sits past the upload grace so the orphan object ages
		// into reclaimable range.
		vi.setSystemTime(new Date(realNow + uploadGraceMs + 5 * 60 * 1000));

		const { outcome, failedDeletes } = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				drizzle(state.storage, { schema: { pendingUploads } })
					.insert(pendingUploads)
					.values({
						id: uploadIdSchema.parse('reaped-upload'),
						cache: '',
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
					outcome: await garbageCollection.collectGarbage(rootLogger()),
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
});
