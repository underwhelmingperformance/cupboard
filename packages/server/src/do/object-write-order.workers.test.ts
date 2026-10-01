import { storePathHashSchema } from '@cupboard/nix-store/scalars';
import { bestEffort } from '@cupboard/shared/cleanup';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../db/schema.ts';
import { SubrequestTimeoutError } from '../errors.ts';
import { narInfoObjectKey, type R2ObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	commitPath,
	currentServer,
	defaultCache,
	initialise,
	resetTestServer,
	resolvedCache,
	uploadMetadata,
	verifiableNar
} from '../test-support.ts';

import { boundedBlobs } from './bounded-io.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';

const cacheScope = defaultCache();

async function settled(pending: Promise<unknown>): Promise<void> {
	await pending;
}

function stallingBucket(
	target: R2Bucket,
	stalledKey: string
): {
	bucket: R2Bucket;
	release: () => void;
	landed: Promise<void>;
	puts: () => number;
} {
	const released = Promise.withResolvers<string>();
	const landed = Promise.withResolvers<string>();
	let puts = 0;
	let hasStalled = false;

	const bucket = new Proxy(target, {
		get(bucketTarget, property) {
			if (property === 'put') {
				return (key: string, value: string, options?: R2PutOptions) => {
					puts++;

					return bucketTarget.put(key, value, options);
				};
			}

			if (property === 'delete') {
				return async (keys: string | string[]) => {
					if (!hasStalled && keys === stalledKey) {
						hasStalled = true;
						const abandoned = (async () => {
							await released.promise;
							await bucketTarget.delete(keys);
							landed.resolve('landed');
						})();

						throw new SubrequestTimeoutError(
							'r2.delete',
							bestEffort(() => abandoned)
						);
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

	return {
		bucket,
		release: () => {
			released.resolve('released');
		},
		landed: settled(landed.promise),
		puts: () => puts
	};
}

async function narInfoObjectText(
	storePathHash: string
): Promise<string | undefined> {
	const object = await env.BLOBS.get(
		narInfoObjectKey(
			fixtureTenant,
			storePathHashSchema.parse(storePathHash),
			cacheScope
		)
	);

	return object === null ? undefined : object.text();
}

// A timed-out R2 delete continues after the critical section releases. A later
// put to the same path-keyed object must wait for that delete to finish, or the
// late delete could remove the newly published narinfo.
describe('path-keyed object write ordering', () => {
	beforeEach(resetTestServer);
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('waits for an abandoned delete before issuing a later put', async () => {
		const token = await initialise();
		const nar = await verifiableNar('write-order');
		const metadata = uploadMetadata({
			name: 'ordered',
			storePathHash: 'c'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});

		await commitPath(token, metadata, nar);

		const committed = await narInfoObjectText(metadata.storePathHash);

		expect(committed).toBeDefined();

		await runInDurableObject(currentServer(), async (instance) => {
			const context = instance.context;
			const cache = resolvedCache(context, cacheScope);
			const storePathHash = storePathHashSchema.parse(metadata.storePathHash);
			const key = narInfoObjectKey(fixtureTenant, storePathHash, cache.scope);
			const { bucket, release, landed, puts } = stallingBucket(
				context.env.BLOBS,
				key
			);

			context.env = { ...context.env, BLOBS: boundedBlobs(bucket) };

			const service = new NarInfoObjectsService(context);

			const deletion = expect(
				context.criticalSection(() =>
					service.deleteNarInfoObject(cache, storePathHash)
				)
			).rejects.toBeInstanceOf(SubrequestTimeoutError);
			await deletion;

			const row = context.db
				.select()
				.from(schema.narInfos)
				.where(
					and(
						eq(schema.narInfos.cacheId, cache.id),
						eq(schema.narInfos.storePathHash, storePathHash)
					)
				)
				.get();

			expect(row).toBeDefined();

			if (row === undefined) {
				return;
			}

			const narInfo = await service.narInfoFromRow(row);

			expect(narInfo).toBeDefined();

			if (narInfo === undefined) {
				return;
			}

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
			const put = service.putNarInfoObject(
				cache,
				storePathHash,
				{
					generation: row.generation,
					narHash: row.narHash,
					narUrl: narInfo.url,
					signatureGeneration:
						row.pendingSignatureGeneration ?? row.signatureGeneration
				},
				narInfo
			);

			await writeStarted.promise;
			expect(puts()).toBe(0);

			release();
			await landed;
			await put;
		});

		expect(await narInfoObjectText(metadata.storePathHash)).toBe(committed);
	});
});
