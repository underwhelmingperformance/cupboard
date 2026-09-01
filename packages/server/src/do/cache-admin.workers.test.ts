import {
	cachePrioritySchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import type {
	CacheListResponseInput,
	CacheSummaryInput
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

import * as schema from '../db/schema.ts';
import { narInfoObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	authorisedFetch,
	bootstrap,
	cacheWriteGrants,
	CommitUpgradeError,
	commitUploadRejection,
	currentServer,
	defaultCache,
	driveToCompletion,
	expectSingleUploadDecision,
	issueServerSignedToken,
	namedCache,
	narBytes,
	negotiateUploads,
	pushPath,
	putNarBytes,
	resetTestServer,
	resolvedCache,
	uploadMetadata,
	useTestServer
} from '../test-support.ts';

import { teardownEntryPrefix } from './cache-admin-service.ts';

const repeated = (character: string): string => character.repeat(32);
const buildsCache = namedCache('builds');

// The shared test clock is pinned to 2026-01-01, so these bracket "now".
const earlierLiveDeadline = isoTimestampSchema.parse(
	'2026-03-01T00:00:00.000Z'
);
const laterLiveDeadline = isoTimestampSchema.parse('2026-06-01T00:00:00.000Z');
const expiredDeadline = isoTimestampSchema.parse('2025-12-01T00:00:00.000Z');

function expectCommitUpgradeError(
	error: unknown
): asserts error is CommitUpgradeError {
	expect(error).toBeInstanceOf(CommitUpgradeError);
}

async function putCache(
	token: string,
	name: string,
	priority: number
): Promise<CacheSummaryInput> {
	const response = await authorisedFetch(`/caches/${name}`, token, {
		body: JSON.stringify({ access: 'public', priority }),
		headers: { 'content-type': 'application/json' },
		method: 'PUT'
	});

	expect(response.status).toBe(StatusCodes.OK);

	return cacheSummarySchema.parse(await response.json());
}

async function listCaches(token: string): Promise<CacheListResponseInput> {
	const response = await authorisedFetch('/caches', token);

	expect(response.status).toBe(StatusCodes.OK);

	return cacheListResponseSchema.parse(await response.json());
}

function cacheListRequest(token: string): Request {
	return new Request('https://cupboard.test/caches', {
		headers: { authorization: `Bearer ${token}` }
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
			buildsCache
		);

		const { caches } = await listCaches(init.token);

		expect(caches).toStrictEqual([
			{
				scope: defaultCache(),
				access: 'public',
				priority: 40,
				storePaths: 0,
				defaultRootRetention: { kind: 'permanent' },
				grace: { kind: 'none' },
				rootRetentionOverrides: [],
				graceManaged: false
			},
			{
				scope: buildsCache,
				access: 'public',
				priority: 30,
				storePaths: 1,
				defaultRootRetention: { kind: 'permanent' },
				grace: { kind: 'none' },
				rootRetentionOverrides: [],
				graceManaged: false
			}
		]);
	});

	it('reports grace management and the earliest live deadline per cache', async () => {
		await useTestServer('cache-admin-grace-state');
		const init = await bootstrap();
		await putCache(init.token, 'builds', 30);
		await runInDurableObject(currentServer(), (instance) => {
			const cache = resolvedCache(instance.context, buildsCache);

			instance.context.db
				.update(schema.caches)
				.set({ graceManaged: true })
				.where(eq(schema.caches.id, cache.id))
				.run();
			instance.context.db
				.insert(schema.retentionGrace)
				.values([
					{
						cacheId: cache.id,
						storePathHash: storePathHashSchema.parse(repeated('a')),
						retainUntil: laterLiveDeadline
					},
					{
						cacheId: cache.id,
						storePathHash: storePathHashSchema.parse(repeated('b')),
						retainUntil: earlierLiveDeadline
					},
					{
						cacheId: cache.id,
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
			{
				scope: defaultCache(),
				access: 'public',
				priority: 40,
				storePaths: 0,
				defaultRootRetention: { kind: 'permanent' },
				grace: { kind: 'none' },
				rootRetentionOverrides: [],
				graceManaged: false
			},
			{
				scope: buildsCache,
				access: 'public',
				priority: 30,
				storePaths: 0,
				defaultRootRetention: { kind: 'permanent' },
				grace: { kind: 'none' },
				rootRetentionOverrides: [],
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
								kind: 'named',
								name: namedCache(`cache-${String(index).padStart(2, '0')}`)
									.name,
								access: 'public',
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
		await putCache(init.token, 'builds', 40);
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await pushPath(init.token, metadata, buildsCache);
		const buildsId = await runInDurableObject(
			currentServer(),
			(instance) => resolvedCache(instance.context, buildsCache).id
		);

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

		// The deletion leaves the published objects to its alarm passes, so drain
		// them before asking whether the narinfo object has gone.
		await driveToCompletion(
			() => currentServer().resumeCacheTeardown(),
			async () =>
				(await runInDurableObject(currentServer(), (_instance, state) =>
					state.storage.get(`${teardownEntryPrefix}${String(buildsId)}`)
				)) === undefined,
			3
		);

		const object = await env.BLOBS.head(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash, buildsCache)
		);
		const { caches } = await listCaches(init.token);

		expect({
			refusedStatus: refused.status,
			forcedStatus: forced.status,
			removed,
			objectGone: object === null,
			remainingScopes: caches.map((cache) => cache.scope)
		}).toStrictEqual({
			refusedStatus: StatusCodes.CONFLICT,
			forcedStatus: StatusCodes.OK,
			removed: { scope: buildsCache, removed: true, storePathsRemoved: 1 },
			objectGone: true,
			remainingScopes: [defaultCache()]
		});
	});

	it('requires admin scope for the registry routes', async () => {
		await useTestServer('cache-admin-scope');
		await bootstrap();
		const writeToken = await issueServerSignedToken(cacheWriteGrants());

		const list = await authorisedFetch('/caches', writeToken);
		const put = await authorisedFetch('/caches/builds', writeToken, {
			body: JSON.stringify({ access: 'public', priority: 10 }),
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

	it('lets a cache operation grant inspect only its exact cache', async () => {
		await useTestServer('cache-admin-exact-read');
		const init = await bootstrap();
		await putCache(init.token, 'builds', 30);
		const buildsToken = await issueServerSignedToken(
			cacheWriteGrants([], buildsCache)
		);

		const exact = await authorisedFetch('/caches/builds', buildsToken);
		const other = await authorisedFetch('/cache', buildsToken);
		const list = await authorisedFetch('/caches', buildsToken);
		const missingToken = await issueServerSignedToken(
			cacheWriteGrants([], namedCache('missing'))
		);
		const missing = await authorisedFetch('/caches/missing', missingToken);

		expect({
			exact: {
				status: exact.status,
				body: cacheSummarySchema.parse(await exact.json())
			},
			other: other.status,
			list: list.status,
			missing: missing.status
		}).toStrictEqual({
			exact: {
				status: StatusCodes.OK,
				body: {
					scope: buildsCache,
					access: 'public',
					priority: 30,
					storePaths: 0,
					defaultRootRetention: { kind: 'permanent' },
					grace: { kind: 'none' },
					rootRetentionOverrides: [],
					graceManaged: false
				}
			},
			other: StatusCodes.FORBIDDEN,
			list: StatusCodes.FORBIDDEN,
			missing: StatusCodes.NOT_FOUND
		});
	});

	it('clears in-flight uploads negotiated under a cache it tears down', async () => {
		await useTestServer('cache-admin-teardown-pending');
		const init = await bootstrap();
		await putCache(init.token, 'builds', 40);
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const decision = expectSingleUploadDecision(
			await negotiateUploads(init.token, [metadata], buildsCache),
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
			buildsCache
		);

		expectCommitUpgradeError(commitError);
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
});
