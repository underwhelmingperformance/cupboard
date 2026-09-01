import {
	narInfoGenerationSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import { SubrequestTimeoutError } from '../errors.ts';
import { attestationListObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	bootstrap,
	currentServer,
	defaultCache,
	fileAttestationReference,
	publishAttestationList,
	pushPath,
	resetTestServer,
	resolvedCache,
	uploadMetadata,
	useTestServer,
	verifiableNar
} from '../test-support.ts';

import { AttestationCasService } from './attestation-cas-service.ts';
import {
	AttestationsService,
	listGenerationMetadataKey
} from './attestations-service.ts';
import { boundedBlobs } from './bounded-io.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';

const storePathHash = storePathHashSchema.parse('a'.repeat(32));
const retiredGeneration = narInfoGenerationSchema.parse(0);
const currentGeneration = narInfoGenerationSchema.parse(1);
const listKey = attestationListObjectKey(
	fixtureTenant,
	storePathHash,
	defaultCache()
);

// Leave enough time for the D1 reads before publication. The deadline must
// expire while the R2 put is waiting.
const gateBudgetMs = 200;

async function settled(pending: Promise<unknown>): Promise<void> {
	await pending;
}

/**
 * An {@link R2Bucket} that pauses the first put of `stalledKey` until the caller
 * invokes `release`. This models a publication that continues after the
 * caller's deadline expires.
 */
function stallingBucket(
	target: R2Bucket,
	stalledKey: string
): { bucket: R2Bucket; release: () => void; landed: Promise<void> } {
	const released = Promise.withResolvers<string>();
	const landed = Promise.withResolvers<string>();
	let hasStalled = false;

	const bucket = new Proxy(target, {
		get(bucketTarget, property) {
			if (property === 'put') {
				return async (
					key: string,
					value: string,
					options?: R2PutOptions
				): Promise<void> => {
					if (hasStalled || key !== stalledKey) {
						await bucketTarget.put(key, value, options);

						return;
					}

					hasStalled = true;
					await released.promise;
					await bucketTarget.put(key, value, options);
					landed.resolve('landed');
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

	return {
		bucket,
		release: () => {
			released.resolve('released');
		},
		landed: settled(landed.promise)
	};
}

async function publishedListGeneration(): Promise<string | undefined> {
	const object = await env.BLOBS.head(listKey);

	return object?.customMetadata?.[listGenerationMetadataKey];
}

// A publication can reach R2 after its caller's deadline expires. A later
// retirement must inspect the object after the pending publication finishes.
describe('attestation list write ordering', () => {
	beforeEach(resetTestServer);

	it('preserves a deferred newer list while retiring an earlier generation', async () => {
		await useTestServer('attestation-list-order');

		const { token } = await bootstrap();
		const nar = await verifiableNar('attestation-list-order');
		const metadata = uploadMetadata({
			storePathHash,
			name: 'ordered',
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});

		await pushPath(token, metadata, defaultCache(), nar);
		await fileAttestationReference({
			uploadId: '00000000-0000-4000-8000-000000000001',
			bytes: new TextEncoder().encode('{"bundle":"current"}'),
			storePathHash,
			generation: currentGeneration
		});

		// Publish the list from the retired generation before starting the delayed
		// publication for the current generation.
		await publishAttestationList({
			storePathHash,
			generation: retiredGeneration
		});

		const survived = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const context = instance.context;
				const { bucket, release, landed } = stallingBucket(
					context.env.BLOBS,
					listKey
				);

				context.env = { ...context.env, BLOBS: boundedBlobs(bucket) };
				context.gateBudgetMs = gateBudgetMs;

				const attestations = new AttestationsService(
					context,
					new AttestationCasService(context),
					new NarInfoObjectsService(context)
				);
				const cache = resolvedCache(context);

				let publishError: unknown;

				try {
					await context.criticalSection(() =>
						attestations.materialiseList(
							cache,
							storePathHash,
							currentGeneration
						)
					);
				} catch (error) {
					publishError = error;
				}

				expect(publishError).toBeInstanceOf(SubrequestTimeoutError);

				let hasRetired = false;
				const retirement = (async () => {
					await attestations.discardListOfGeneration(
						cache,
						storePathHash,
						retiredGeneration
					);
					hasRetired = true;
				})();

				await new Promise((resolve) => {
					setTimeout(resolve, 25);
				});

				const hasWaitedForPublication = !hasRetired;

				release();
				await landed;
				await retirement;

				return {
					hasWaitedForPublication,
					generation: await publishedListGeneration()
				};
			}
		);

		expect(survived).toStrictEqual({
			hasWaitedForPublication: true,
			generation: String(currentGeneration)
		});
	});
});
