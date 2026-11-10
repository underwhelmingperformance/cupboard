import {
	narInfoGenerationSchema,
	signingKeyGenerationSchema,
	storePathHashSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { StatusCodes } from 'http-status-codes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CacheId } from '../db/cache.ts';
import * as schema from '../db/schema.ts';
import { SubrequestTimeoutError } from '../errors.ts';
import { narInfoObjectKey, narObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	commitPath,
	currentNarObjectKey,
	currentServer,
	defaultCache,
	expectSingleCommitDecision,
	initialise,
	negotiateUploads,
	openCommitSession,
	pendingUploadVerdict,
	resetTestServer,
	resolvedCache,
	uploadMetadata,
	verifiableNar,
	verifyCurrentTenant
} from '../test-support.ts';

import {
	criticalSectionBudgetMs,
	perCallCapMs,
	withDeadlineBudget
} from './deadline.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';
import { storedSignaturesSchema } from './signing-keys.ts';

const cacheScope = defaultCache();

function narInfoRowFilter(
	cacheId: CacheId,
	storePathHash: string
): ReturnType<typeof and> {
	return and(
		eq(schema.narInfos.cacheId, cacheId),
		eq(schema.narInfos.storePathHash, storePathHashSchema.parse(storePathHash))
	);
}

async function committedRow(
	storePathHash: string
): Promise<typeof schema.narInfos.$inferSelect> {
	const row = await runInDurableObject(currentServer(), (instance) => {
		const cache = resolvedCache(instance.context, cacheScope);

		return instance.context.db
			.select()
			.from(schema.narInfos)
			.where(narInfoRowFilter(cache.id, storePathHash))
			.get();
	});

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
			cacheScope
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
			const cache = resolvedCache(instance.context, cacheScope);
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

		await runInDurableObject(currentServer(), async (instance) => {
			const cache = resolvedCache(instance.context, cacheScope);

			instance.context.db
				.delete(schema.narInfos)
				.where(narInfoRowFilter(cache.id, metadata.storePathHash))
				.run();

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
			const cache = resolvedCache(instance.context, cacheScope);
			const service = new NarInfoObjectsService(instance.context);
			const staleNarInfo = await service.narInfoFromRow(row);

			expect(staleNarInfo).toBeDefined();

			if (staleNarInfo === undefined) {
				return;
			}

			const key = narInfoObjectKey(
				fixtureTenant,
				storePathHashSchema.parse(metadata.storePathHash),
				cache.scope
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
				.where(narInfoRowFilter(cache.id, metadata.storePathHash))
				.run();
			stalled.release();
			await publish;
		});

		const object = await env.BLOBS.get(
			narInfoObjectKey(
				fixtureTenant,
				storePathHashSchema.parse(metadata.storePathHash),
				cacheScope
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
			cacheScope
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

		await runInDurableObject(currentServer(), (instance) => {
			const cache = resolvedCache(instance.context, cacheScope);

			return new NarInfoObjectsService(instance.context).ensureNarInfoObject(
				cache,
				row.storePathHash
			);
		});

		const repaired = await env.BLOBS.get(key);

		expect({
			body: await repaired?.text(),
			narUrl: repaired?.customMetadata?.narUrl
		}).toStrictEqual({ body: current, narUrl: currentUrl });
	});
});

/**
Replaces the native R2 put of `key` with one that does not return until the
test fails it or lets it write. `reached` resolves when the put starts, and
`landed` resolves when a put that the test let through has written.
*/
function heldPutOf(key: string): {
	readonly reached: Promise<undefined>;
	readonly landed: Promise<undefined>;
	fail(): void;
	land(): void;
	restore(): void;
} {
	const reached = Promise.withResolvers<undefined>();
	const held = Promise.withResolvers<undefined>();
	const landed = Promise.withResolvers<undefined>();
	const original = env.BLOBS.put.bind(env.BLOBS);
	const put = vi
		.spyOn(env.BLOBS, 'put')
		.mockImplementation(async (written, value, options) => {
			if (written !== key) {
				return original(written, value, options);
			}

			reached.resolve(undefined);
			await held.promise;
			const object = await original(written, value, options);
			landed.resolve(undefined);

			return object;
		});

	return {
		reached: reached.promise,
		landed: landed.promise,
		fail: () => {
			held.reject(new Error('put: internal error (10001)'));
		},
		land: () => {
			held.resolve(undefined);
		},
		restore: () => {
			put.mockRestore();
		}
	};
}

describe('narinfo publication whose R2 put does not return', () => {
	beforeEach(resetTestServer);
	afterEach(() => {
		vi.useRealTimers();
	});

	it('refuses the commit retryably at the storage deadline and leaves the upload for verification', async () => {
		const token = await initialise();
		const nar = await verifiableNar('stalled-publish');
		const blob = {
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		};
		await commitPath(
			token,
			uploadMetadata({ name: 'first', storePathHash: 'a'.repeat(32), ...blob }),
			nar
		);
		const reused = uploadMetadata({
			name: 'reused',
			storePathHash: 'b'.repeat(32),
			...blob
		});
		const { uploadId } = expectSingleCommitDecision(
			await negotiateUploads(token, [reused]),
			reused
		);
		const put = heldPutOf(
			narInfoObjectKey(
				fixtureTenant,
				storePathHashSchema.parse(reused.storePathHash),
				cacheScope
			)
		);
		const afterTimeout = await (async () => {
			const session = await openCommitSession(token);
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

			try {
				session.send({
					op: 'commit-batch',
					commits: [
						{
							uploadId,
							storePathHash: reused.storePathHash,
							narHash: reused.narHash
						}
					]
				});
				// A promise continues in the I/O context that resolves it. The object
				// resolves `reached` and owns the put's timer, so wait and advance
				// the clock inside the object.
				await runInDurableObject(currentServer(), async () => {
					await put.reached;
					await vi.advanceTimersByTimeAsync(perCallCapMs);
				});
				const refusal = await session.nextFrame();

				return {
					refusal:
						refusal.ev === 'error'
							? {
									ev: refusal.ev,
									uploadId: refusal.uploadId,
									status: refusal.status
								}
							: refusal,
					verdict: await pendingUploadVerdict(uploadId),
					published: await narInfoObjectText(reused.storePathHash)
				};
			} finally {
				session.socket.close();
				await runInDurableObject(currentServer(), () => {
					put.fail();
				});
				put.restore();
				vi.useRealTimers();
			}
		})();

		await verifyCurrentTenant();

		expect({
			afterTimeout,
			verdict: await pendingUploadVerdict(uploadId),
			isPublished: (await narInfoObjectText(reused.storePathHash)) !== undefined
		}).toStrictEqual({
			afterTimeout: {
				refusal: {
					ev: 'error',
					uploadId,
					status: StatusCodes.SERVICE_UNAVAILABLE
				},
				verdict: 'committing',
				published: undefined
			},
			verdict: undefined,
			isPublished: true
		});
	});

	it('keeps a delete behind a put abandoned inside a longer deadline scope', async () => {
		const token = await initialise();
		const nar = await verifiableNar('abandoned-publish');
		const metadata = uploadMetadata({
			name: 'abandoned',
			storePathHash: 'c'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});
		await commitPath(token, metadata, nar);
		const row = await committedRow(metadata.storePathHash);
		const put = heldPutOf(
			narInfoObjectKey(fixtureTenant, row.storePathHash, cacheScope)
		);

		try {
			const failure = await runInDurableObject(
				currentServer(),
				async (instance) => {
					const cache = resolvedCache(instance.context, cacheScope);
					const service = new NarInfoObjectsService(instance.context);
					const narInfo = await service.narInfoFromRow(row);

					if (narInfo === undefined) {
						return 'no narinfo for the committed row';
					}

					vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
					// The scope is as long as a critical section's budget, so the put
					// times out while the scope still has time left. The test opens the
					// scope without `blockConcurrencyWhile`: the input gate defers the
					// real timer events that advancing the fake clock waits for.
					const publishing = (async (): Promise<unknown> => {
						try {
							await withDeadlineBudget(criticalSectionBudgetMs, () =>
								service.putNarInfoObject(
									cache,
									row.storePathHash,
									{
										generation: row.generation,
										narHash: row.narHash,
										narUrl: narInfo.url,
										signatureGeneration:
											row.pendingSignatureGeneration ?? row.signatureGeneration
									},
									narInfo
								)
							);

							return 'published';
						} catch (error) {
							return error instanceof SubrequestTimeoutError
								? error.subrequest
								: error;
						}
					})();
					await put.reached;
					await vi.advanceTimersByTimeAsync(criticalSectionBudgetMs);
					const outcome = await publishing;
					const deleting = service.deleteNarInfoObject(
						cache,
						row.storePathHash
					);
					put.land();
					await Promise.all([deleting, put.landed]);

					return outcome;
				}
			);

			expect({
				failure,
				object: await narInfoObjectText(metadata.storePathHash)
			}).toStrictEqual({ failure: 'r2.put', object: undefined });
		} finally {
			await runInDurableObject(currentServer(), () => {
				put.fail();
			});
			put.restore();
		}
	});
});
