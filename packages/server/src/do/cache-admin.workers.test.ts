import {
	cacheNameSchema,
	cachePrioritySchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import type {
	CacheListResponse,
	CacheSummary
} from '@cupboard/protocol/caches';
import {
	cacheListResponseSchema,
	cacheRemoveResponseSchema,
	cacheSummarySchema
} from '@cupboard/protocol/caches';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { narInfoObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import { createR2BlobStore } from '../s3/blob-store.ts';
import { S3StagingAccounting } from '../s3/staging-accounting.ts';
import {
	authorisedFetch,
	bootstrap,
	cacheWriteGrants,
	CommitSocketError,
	commitUploadRejection,
	currentServer,
	expectSingleUploadDecision,
	issueServerSignedToken,
	narBytes,
	negotiateUploads,
	pushPath,
	putNarBytes,
	resetTestServer,
	uploadMetadata,
	useTestServer
} from '../test-support.ts';

const repeated = (character: string): string => character.repeat(32);
const buildsCache = cacheNameSchema.parse('builds');

// The shared test clock is pinned to 2026-01-01, so these bracket "now".
const earlierLiveDeadline = isoTimestampSchema.parse(
	'2026-03-01T00:00:00.000Z'
);
const laterLiveDeadline = isoTimestampSchema.parse('2026-06-01T00:00:00.000Z');
const expiredDeadline = isoTimestampSchema.parse('2025-12-01T00:00:00.000Z');

function expectCommitSocketError(
	error: unknown
): asserts error is CommitSocketError {
	expect(error).toBeInstanceOf(CommitSocketError);
}

async function putCache(
	token: string,
	name: string,
	priority: number
): Promise<CacheSummary> {
	const response = await authorisedFetch(`/caches/${name}`, token, {
		body: JSON.stringify({ priority }),
		headers: { 'content-type': 'application/json' },
		method: 'PUT'
	});

	expect(response.status).toBe(StatusCodes.OK);

	return cacheSummarySchema.parse(await response.json());
}

async function listCaches(token: string): Promise<CacheListResponse> {
	const response = await authorisedFetch('/caches', token);

	expect(response.status).toBe(StatusCodes.OK);

	return cacheListResponseSchema.parse(await response.json());
}

function cacheListRequest(token: string): Request {
	return new Request('https://cupboard.test/caches', {
		headers: { authorization: `Bearer ${token}` }
	});
}

function bodyOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		}
	});
}

describe('cache registry admin', () => {
	beforeEach(resetTestServer);

	it('lists registered caches with their priority and store-path count', async () => {
		await useTestServer('cache-admin-list');
		const init = await bootstrap();
		await putCache(init.token, 'builds', 30);
		await pushPath(
			init.token,
			uploadMetadata({ fileSize: narBytes.byteLength }),
			'builds'
		);

		const { caches } = await listCaches(init.token);

		expect(caches).toStrictEqual([
			{ name: '', priority: 40, storePaths: 0, graceManaged: false },
			{ name: 'builds', priority: 30, storePaths: 1, graceManaged: false }
		]);
	});

	it('reports grace management and the earliest live deadline per cache', async () => {
		await useTestServer('cache-admin-grace-state');
		const init = await bootstrap();
		await putCache(init.token, 'builds', 30);
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.update(schema.caches)
				.set({ graceManaged: true })
				.where(eq(schema.caches.name, buildsCache))
				.run();
			instance.context.db
				.insert(schema.retentionGrace)
				.values([
					{
						cache: buildsCache,
						storePathHash: storePathHashSchema.parse(repeated('a')),
						retainUntil: laterLiveDeadline
					},
					{
						cache: buildsCache,
						storePathHash: storePathHashSchema.parse(repeated('b')),
						retainUntil: earlierLiveDeadline
					},
					{
						cache: buildsCache,
						storePathHash: storePathHashSchema.parse(repeated('c')),
						retainUntil: expiredDeadline
					}
				])
				.run();
		});

		const { caches } = await listCaches(init.token);

		// The expired row does not count as the earliest deadline: only live
		// deadlines are reported.
		expect(caches).toStrictEqual([
			{ name: '', priority: 40, storePaths: 0, graceManaged: false },
			{
				name: 'builds',
				priority: 30,
				storePaths: 0,
				graceManaged: true,
				earliestGraceDeadline: earlierLiveDeadline
			}
		]);
	});

	it('lists any number of caches with a constant number of select statements', async () => {
		await useTestServer('cache-admin-list-cost');
		const init = await bootstrap();

		const observed = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const select = vi.spyOn(instance.context.db, 'select');
				const measure = async (): Promise<{
					readonly calls: number;
					readonly caches: number;
				}> => {
					select.mockClear();
					const response = await instance.fetch(cacheListRequest(init.token));
					const body = cacheListResponseSchema.parse(await response.json());

					return {
						calls: select.mock.calls.length,
						caches: body.caches.length
					};
				};

				try {
					const one = await measure();

					for (let index = 0; index < 20; index += 1) {
						instance.context.db
							.insert(schema.caches)
							.values({
								name: cacheNameSchema.parse(
									`cache-${String(index).padStart(2, '0')}`
								),
								priority: cachePrioritySchema.parse(40),
								createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z')
							})
							.run();
					}

					return { one, many: await measure() };
				} finally {
					select.mockRestore();
				}
			}
		);

		expect(observed.one.calls).toBe(observed.many.calls);
		expect({
			one: observed.one.caches,
			many: observed.many.caches
		}).toStrictEqual({
			one: 1,
			many: 21
		});
	});

	it('refuses to delete a non-empty cache without force, then force-tears it down', async () => {
		await useTestServer('cache-admin-delete');
		const init = await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await pushPath(init.token, metadata, 'builds');

		const refused = await authorisedFetch('/caches/builds', init.token, {
			method: 'DELETE'
		});
		const forced = await authorisedFetch(
			'/caches/builds?force=true',
			init.token,
			{
				method: 'DELETE'
			}
		);
		const removed = cacheRemoveResponseSchema.parse(await forced.json());
		const object = await env.BLOBS.head(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash, buildsCache)
		);
		const { caches } = await listCaches(init.token);

		expect({
			refusedStatus: refused.status,
			forcedStatus: forced.status,
			removed,
			objectGone: object === null,
			remainingNames: caches.map((cache) => cache.name)
		}).toStrictEqual({
			refusedStatus: StatusCodes.CONFLICT,
			forcedStatus: StatusCodes.OK,
			removed: { name: 'builds', removed: true, storePathsRemoved: 1 },
			objectGone: true,
			remainingNames: ['']
		});
	});

	it('requires admin scope for the registry routes', async () => {
		await useTestServer('cache-admin-scope');
		await bootstrap();
		const writeToken = await issueServerSignedToken(cacheWriteGrants());

		const list = await authorisedFetch('/caches', writeToken);
		const put = await authorisedFetch('/caches/builds', writeToken, {
			body: JSON.stringify({ priority: 10 }),
			headers: { 'content-type': 'application/json' },
			method: 'PUT'
		});
		const remove = await authorisedFetch('/caches/builds', writeToken, {
			method: 'DELETE'
		});

		expect({
			list: list.status,
			put: put.status,
			remove: remove.status
		}).toStrictEqual({
			list: StatusCodes.FORBIDDEN,
			put: StatusCodes.FORBIDDEN,
			remove: StatusCodes.FORBIDDEN
		});
	});

	it('clears in-flight uploads negotiated under a cache it tears down', async () => {
		await useTestServer('cache-admin-teardown-pending');
		const init = await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const decision = expectSingleUploadDecision(
			await negotiateUploads(init.token, [metadata], 'builds'),
			metadata
		);

		await putNarBytes(decision.r2Key);

		const stagedBefore = await env.BLOBS.head(decision.r2Key);
		const removed = await authorisedFetch('/caches/builds', init.token, {
			method: 'DELETE'
		});
		const stagedAfter = await env.BLOBS.head(decision.r2Key);

		// The pending upload is gone with the cache, so a late commit cannot
		// resurrect it.
		const commitError = await commitUploadRejection(
			init.token,
			decision.uploadId,
			'builds'
		);

		expectCommitSocketError(commitError);
		expect({
			stagedBefore: stagedBefore !== null,
			removed: removed.status,
			stagedAfter: stagedAfter === null,
			commit: commitError.status
		}).toStrictEqual({
			stagedBefore: true,
			removed: StatusCodes.OK,
			stagedAfter: true,
			commit: StatusCodes.NOT_FOUND
		});
	});

	it('removes S3 staging state and releases its quota charges', async () => {
		await useTestServer('cache-admin-teardown-s3-staging');
		const init = await bootstrap();
		await putCache(init.token, 'builds', 30);
		const blobStore = createR2BlobStore(env.BLOBS);
		const stagedKey = 'staging/s3/v1/builds/staged.nar.zst';
		const multipartKey = 'staging/s3/v1/builds/multipart.nar.zst';
		const stagedBytes = new Uint8Array([1, 2, 3, 4]);
		const partBytes = new Uint8Array([5, 6, 7]);
		const expiresAt = isoTimestampSchema.parse('2026-01-08T00:00:00.000Z');
		await env.BLOBS.put(stagedKey, stagedBytes);
		const upload = await blobStore.createMultipartUpload(multipartKey, {
			contentType: undefined,
			contentLength: undefined,
			checksumSha256: undefined
		});

		await runInDurableObject(currentServer(), async (instance) => {
			const accounting = new S3StagingAccounting(
				instance.context.d1,
				fixtureTenant,
				() => new Date('2026-01-01T00:00:00.000Z'),
				() => 'part-reservation'
			);
			await accounting.reserveStagedObject(
				buildsCache,
				stagedKey,
				stagedBytes.byteLength,
				expiresAt
			);
			await accounting.beginMultipart(
				buildsCache,
				multipartKey,
				upload.uploadId,
				expiresAt
			);
			const reservation = await accounting.reserveMultipartPart(
				multipartKey,
				upload.uploadId,
				1,
				partBytes.byteLength
			);
			const part = await blobStore.uploadPart(
				multipartKey,
				upload.uploadId,
				1,
				partBytes.byteLength,
				bodyOf(partBytes)
			);
			await accounting.recordMultipartPart(reservation, part);
		});

		const removed = await authorisedFetch('/caches/builds', init.token, {
			method: 'DELETE'
		});
		const accountingState = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const usage = await instance.context.d1
					.select({
						stagedBytes: d1Schema.tenantUsage.stagedBytes,
						multipartBytes: d1Schema.tenantUsage.multipartBytes
					})
					.from(d1Schema.tenantUsage)
					.where(eq(d1Schema.tenantUsage.tenant, fixtureTenant))
					.get();

				return {
					usage,
					staged: await instance.context.d1
						.select()
						.from(d1Schema.s3StagedObject),
					uploads: await instance.context.d1
						.select()
						.from(d1Schema.s3MultipartUpload),
					parts: await instance.context.d1
						.select()
						.from(d1Schema.s3MultipartPart)
				};
			}
		);

		expect({
			status: removed.status,
			accountingState,
			stagedPresent: (await env.BLOBS.head(stagedKey)) !== null
		}).toStrictEqual({
			status: StatusCodes.OK,
			accountingState: {
				usage: { stagedBytes: 0, multipartBytes: 0 },
				staged: [],
				uploads: [],
				parts: []
			},
			stagedPresent: false
		});
		const retryBody = bodyOf(new Uint8Array([8]));
		await expect(
			blobStore.uploadPart(multipartKey, upload.uploadId, 2, 1, retryBody)
		).rejects.toThrow();
	});
});
