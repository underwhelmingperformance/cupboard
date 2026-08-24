import { storePathHashSchema } from '@cupboard/nix-store/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema.ts';
import { SubrequestTimeoutError } from '../errors.ts';
import { narInfoObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	commitPath,
	currentServer,
	initialise,
	resetTestServer,
	uploadMetadata,
	verifiableNar
} from '../test-support.ts';

import { boundedBlobs } from './bounded-io.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';

const cache = '';

async function settled(pending: Promise<unknown>): Promise<void> {
	await pending;
}

function stallingBucket(
	target: R2Bucket,
	stalledKey: string
): { bucket: R2Bucket; release: () => void; landed: Promise<void> } {
	const released = Promise.withResolvers<string>();
	const landed = Promise.withResolvers<string>();
	let hasStalled = false;

	const bucket = new Proxy(target, {
		get(bucketTarget, property) {
			if (property === 'delete') {
				return async (keys: string | string[]) => {
					if (!hasStalled && keys === stalledKey) {
						hasStalled = true;
						await released.promise;
						await bucketTarget.delete(keys);
						landed.resolve('landed');
						return;
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
		landed: settled(landed.promise)
	};
}

async function narInfoObjectText(
	storePathHash: string
): Promise<string | undefined> {
	const object = await env.BLOBS.get(
		narInfoObjectKey(
			fixtureTenant,
			storePathHashSchema.parse(storePathHash),
			cache
		)
	);

	return object === null ? undefined : object.text();
}

// A timed-out R2 delete continues after the critical section releases. A later
// put to the same path-keyed object must wait for that delete to finish, or the
// late delete could remove the newly published narinfo.
describe('path-keyed object write ordering', () => {
	beforeEach(resetTestServer);

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
			const storePathHash = storePathHashSchema.parse(metadata.storePathHash);
			const key = narInfoObjectKey(fixtureTenant, storePathHash, cache);
			const { bucket, release, landed } = stallingBucket(
				context.env.BLOBS,
				key
			);

			context.env = { ...context.env, BLOBS: boundedBlobs(bucket) };
			context.gateBudgetMs = 50;

			const service = new NarInfoObjectsService(context);

			let error: unknown;

			try {
				await context.criticalSection(() =>
					service.deleteNarInfoObject(cache, storePathHash)
				);
			} catch (error_) {
				error = error_;
			}

			expect(error).toBeInstanceOf(SubrequestTimeoutError);

			const row = context.db
				.select()
				.from(schema.narInfos)
				.where(
					and(
						eq(schema.narInfos.cache, cache),
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

			let didPutSettle = false;
			const put = (async () => {
				await service.putNarInfoObject(
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
				didPutSettle = true;
			})();

			await new Promise((resolve) => {
				setTimeout(resolve, 25);
			});
			expect(didPutSettle).toBe(false);

			release();
			await landed;
			await put;
		});

		expect(await narInfoObjectText(metadata.storePathHash)).toBe(committed);
	});
});
