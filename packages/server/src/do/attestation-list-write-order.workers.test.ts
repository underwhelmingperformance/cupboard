import {
	narInfoGenerationSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { bestEffort } from '@cupboard/shared/cleanup';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SubrequestTimeoutError } from '../errors.ts';
import { attestationListObjectKey, type R2ObjectKey } from '../http/http.ts';
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
import { CacheRegistrationService } from './cache-registration-service.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';

const storePathHash = storePathHashSchema.parse('a'.repeat(32));
const retiredGeneration = narInfoGenerationSchema.parse(0);
const currentGeneration = narInfoGenerationSchema.parse(1);
const listKey = attestationListObjectKey(
	fixtureTenant,
	storePathHash,
	defaultCache()
);

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
): {
	bucket: R2Bucket;
	release: () => void;
	landed: Promise<void>;
	heads: () => number;
} {
	const released = Promise.withResolvers<string>();
	const landed = Promise.withResolvers<string>();
	let heads = 0;
	let hasStalled = false;

	const bucket = new Proxy(target, {
		get(bucketTarget, property) {
			if (property === 'head') {
				return (key: string) => {
					if (key === stalledKey) {
						heads++;
					}

					return bucketTarget.head(key);
				};
			}

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
					const abandoned = (async () => {
						await released.promise;
						await bucketTarget.put(key, value, options);
						landed.resolve('landed');
					})();

					throw new SubrequestTimeoutError(
						'r2.put',
						bestEffort(() => abandoned)
					);
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
		landed: settled(landed.promise),
		heads: () => heads
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
	afterEach(() => {
		vi.restoreAllMocks();
	});

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
				const { bucket, release, landed, heads } = stallingBucket(
					context.env.BLOBS,
					listKey
				);

				context.env = { ...context.env, BLOBS: boundedBlobs(bucket) };

				const attestations = new AttestationsService(
					context,
					new CacheRegistrationService(context),
					new AttestationCasService(context),
					new NarInfoObjectsService(context)
				);
				const cache = resolvedCache(context);

				const publication = expect(
					context.criticalSection(() =>
						attestations.materialiseList(
							cache,
							storePathHash,
							currentGeneration
						)
					)
				).rejects.toBeInstanceOf(SubrequestTimeoutError);
				await publication;

				const writeStarted = Promise.withResolvers<undefined>();
				const write = context.objectWrites.write.bind(context.objectWrites);
				vi.spyOn(context.objectWrites, 'write').mockImplementation(
					<T>(
						keys: readonly R2ObjectKey[],
						mutate: () => Promise<T>
					): Promise<T> => {
						const pending = write(keys, mutate);
						writeStarted.resolve(undefined);

						return pending;
					}
				);
				const retirement = attestations.discardListOfGeneration(
					cache,
					storePathHash,
					retiredGeneration
				);

				await writeStarted.promise;
				const prematureHeads = heads();

				release();
				await landed;
				await retirement;

				return {
					prematureHeads,
					generation: await publishedListGeneration()
				};
			}
		);

		expect(survived).toStrictEqual({
			prematureHeads: 0,
			generation: String(currentGeneration)
		});
	});
});
