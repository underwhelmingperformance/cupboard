import {
	narInfoGenerationSchema,
	signingKeyGenerationSchema,
	storePathHashSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema.ts';
import { narInfoObjectKey, narObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	commitPath,
	currentNarObjectKey,
	currentServer,
	initialise,
	resetTestServer,
	uploadMetadata,
	verifiableNar
} from '../test-support.ts';

import { NarInfoObjectsService } from './narinfo-objects-service.ts';
import { storedSignaturesSchema } from './signing-keys.ts';

const cache = '';

function narInfoRowFilter(storePathHash: string): ReturnType<typeof and> {
	return and(
		eq(schema.narInfos.cache, cache),
		eq(schema.narInfos.storePathHash, storePathHashSchema.parse(storePathHash))
	);
}

async function committedRow(
	storePathHash: string
): Promise<typeof schema.narInfos.$inferSelect> {
	const filter = narInfoRowFilter(storePathHash);
	const row = await runInDurableObject(currentServer(), (instance) =>
		instance.context.db.select().from(schema.narInfos).where(filter).get()
	);

	expect(row).toBeDefined();

	if (row === undefined) {
		throw new Error('missing committed narinfo row');
	}

	return row;
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

function stallingPutBucket(
	target: R2Bucket,
	stalledKey: string
): {
	readonly bucket: R2Bucket;
	readonly started: Promise<void>;
	release(): void;
} {
	const started = Promise.withResolvers<undefined>();
	const released = Promise.withResolvers<undefined>();
	let hasStalled = false;

	return {
		bucket: new Proxy(target, {
			get(bucketTarget, property) {
				if (property === 'put') {
					return async (
						key: string,
						value:
							ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
						options?: R2PutOptions
					) => {
						if (!hasStalled && key === stalledKey) {
							hasStalled = true;
							started.resolve(undefined);
							await released.promise;
						}

						return bucketTarget.put(key, value, options);
					};
				}

				const value: unknown = Reflect.get(
					bucketTarget,
					property,
					bucketTarget
				);

				if (typeof value !== 'function') {
					return value;
				}

				return (...arguments_: unknown[]): unknown => {
					const result: unknown = Reflect.apply(
						value,
						bucketTarget,
						arguments_
					);

					return result;
				};
			}
		}),
		started: started.promise,
		release: () => {
			released.resolve(undefined);
		}
	};
}

// Publication occurs outside the critical section. A delete or recommit can
// therefore change the row before the put finishes. The publisher must re-read
// the row under the gate and remove or rewrite the late object.
describe('narinfo publication after a concurrent row change', () => {
	beforeEach(resetTestServer);

	it('rewrites a late publish when its generation no longer matches the committed row', async () => {
		const token = await initialise();
		const nar = await verifiableNar('publish-fence');
		const metadata = uploadMetadata({
			name: 'fenced',
			storePathHash: 'a'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});

		await commitPath(token, metadata, nar);

		const row = await committedRow(metadata.storePathHash);
		const current = await narInfoObjectText(metadata.storePathHash);

		await runInDurableObject(currentServer(), async (instance) => {
			const service = new NarInfoObjectsService(instance.context);
			const staleNarInfo = await service.narInfoFromRow({
				...row,
				storePath: storePathSchema.parse(
					row.storePath.replace('fenced', 'staler')
				)
			});

			expect(staleNarInfo).toBeDefined();

			if (staleNarInfo === undefined) {
				return;
			}

			await service.publishNarInfoObject(
				cache,
				row.storePathHash,
				narInfoGenerationSchema.parse(row.generation + 1),
				row.narHash,
				staleNarInfo
			);
		});

		expect(await narInfoObjectText(metadata.storePathHash)).toBe(current);
	});

	it('removes a late publish after the committed row has been deleted', async () => {
		const token = await initialise();
		const nar = await verifiableNar('publish-fence-gone');
		const metadata = uploadMetadata({
			name: 'doomed',
			storePathHash: 'b'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});

		await commitPath(token, metadata, nar);

		const row = await committedRow(metadata.storePathHash);

		const filter = narInfoRowFilter(metadata.storePathHash);
		await runInDurableObject(currentServer(), async (instance) => {
			instance.context.db.delete(schema.narInfos).where(filter).run();

			const service = new NarInfoObjectsService(instance.context);
			const narInfo = await service.narInfoFromRow(row);

			expect(narInfo).toBeDefined();

			if (narInfo === undefined) {
				return;
			}

			await service.publishNarInfoObject(
				cache,
				row.storePathHash,
				row.generation,
				row.narHash,
				narInfo
			);
		});

		expect(await narInfoObjectText(metadata.storePathHash)).toBeUndefined();
	});

	it('repairs a stale signature publish that lands during backfill', async () => {
		const token = await initialise();
		const nar = await verifiableNar('publish-signature-fence');
		const metadata = uploadMetadata({
			name: 'signature-fenced',
			storePathHash: 'c'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});

		await commitPath(token, metadata, nar);
		const row = await committedRow(metadata.storePathHash);

		await runInDurableObject(currentServer(), async (instance) => {
			const service = new NarInfoObjectsService(instance.context);
			const staleNarInfo = await service.narInfoFromRow(row);

			expect(staleNarInfo).toBeDefined();

			if (staleNarInfo === undefined) {
				return;
			}

			const key = narInfoObjectKey(
				fixtureTenant,
				storePathHashSchema.parse(metadata.storePathHash),
				cache
			);
			const stalled = stallingPutBucket(instance.context.env.BLOBS, key);
			instance.context.env = {
				...instance.context.env,
				BLOBS: stalled.bucket
			};
			const publish = service.publishNarInfoObject(
				cache,
				row.storePathHash,
				row.generation,
				row.narHash,
				staleNarInfo
			);

			await stalled.started;
			const [signature] = storedSignaturesSchema.parse(
				JSON.parse(row.sigsJson) as unknown
			);

			expect(signature).toBeDefined();

			if (signature === undefined) {
				return;
			}

			instance.context.db
				.update(schema.narInfos)
				.set({
					sigsJson: JSON.stringify([signature, signature]),
					pendingSignatureGeneration: signingKeyGenerationSchema.parse(2)
				})
				.where(narInfoRowFilter(metadata.storePathHash))
				.run();
			stalled.release();
			await publish;
		});

		const object = await env.BLOBS.get(
			narInfoObjectKey(
				fixtureTenant,
				storePathHashSchema.parse(metadata.storePathHash),
				cache
			)
		);
		const body = await object?.text();

		expect({
			signatures: body?.match(/^Sig:/gmu)?.length,
			signatureGeneration: object?.customMetadata?.signatureGeneration
		}).toStrictEqual({ signatures: 2, signatureGeneration: '2' });
	});

	it('rewrites a narinfo published by a preceding Worker after object replacement', async () => {
		const token = await initialise();
		const nar = await verifiableNar('publish-incarnation-fence');
		const metadata = uploadMetadata({
			name: 'incarnation-fenced',
			storePathHash: 'd'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});

		await commitPath(token, metadata, nar);
		const row = await committedRow(metadata.storePathHash);
		const key = narInfoObjectKey(
			fixtureTenant,
			storePathHashSchema.parse(metadata.storePathHash),
			cache
		);
		const current = await narInfoObjectText(metadata.storePathHash);

		expect(current).toBeDefined();

		if (current === undefined) {
			return;
		}

		const currentUrl = await currentNarObjectKey(nar.narHash);
		const legacyUrl = narObjectKey(nar.narHash);
		await env.BLOBS.put(
			key,
			current.replace(currentUrl, () => legacyUrl),
			{
				customMetadata: {
					generation: String(row.generation),
					narHash: row.narHash,
					signatureGeneration: String(row.signatureGeneration)
				}
			}
		);

		await runInDurableObject(currentServer(), (instance) =>
			new NarInfoObjectsService(instance.context).ensureNarInfoObject(
				cache,
				row.storePathHash
			)
		);

		const repaired = await env.BLOBS.get(key);

		expect({
			body: await repaired?.text(),
			narUrl: repaired?.customMetadata?.narUrl
		}).toStrictEqual({ body: current, narUrl: currentUrl });
	});
});
