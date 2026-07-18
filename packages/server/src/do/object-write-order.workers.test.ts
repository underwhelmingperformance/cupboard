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

// Resolves once the resolver-backed promise settles, the shape awaited on.
async function settled(pending: Promise<unknown>): Promise<void> {
	await pending;
}

// A bucket whose first delete of `stalledKey` parks until `release` is called,
// then performs the real delete: the shape of a gated delete that outlasts its
// deadline, is abandoned, and lands later as a zombie.
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

// A gated narinfo-object delete that outlasts its deadline is abandoned, not
// cancelled, and the object is path-keyed with no heal on read: without
// ordering, the zombie delete would land after a later put at the same key and
// destroy a live object. Every mutation orders behind the abandoned call's
// settled-signal, so the put waits the zombie out and the object survives.
describe('path-keyed object write ordering', () => {
	beforeEach(resetTestServer);

	it('holds a later put back until an abandoned delete has landed', async () => {
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

			// The gated delete outlasts the shortened budget: the section unwinds
			// retryably and the delete is left running as a zombie.
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

			// The re-commit's put arrives while the zombie is still in flight; it
			// must not land first.
			let didPutSettle = false;
			const put = (async () => {
				await service.putNarInfoObject(
					cache,
					storePathHash,
					row.generation,
					row.narHash,
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

		// The put landed after the zombie delete, so the object survives and
		// matches the committed row.
		expect(await narInfoObjectText(metadata.storePathHash)).toBe(committed);
	});
});
