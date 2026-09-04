import {
	cacheNameSchema,
	cachePrioritySchema,
	type CacheScope,
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

import { type CacheId, cacheScopeFromRow } from '../db/cache.ts';
import * as schema from '../db/schema.ts';
import { narInfoObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	authorisedFetch,
	bootstrap,
	cacheWriteGrants,
	CommitSocketError,
	commitUploadRejection,
	currentServer,
	driveToCompletion,
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

import { teardownEntryPrefix } from './cache-admin-service.ts';

const repeated = (character: string): string => character.repeat(32);

/**
 * Every cache identity in creation order, with the scope read back out of the
 * stored columns.
 */
async function cacheIdentities(): Promise<
	{
		id: CacheId;
		scope: CacheScope | undefined;
		access: string | undefined;
		priority: number;
		deleted: boolean;
	}[]
> {
	const rows = await runInDurableObject(currentServer(), (instance) =>
		instance.context.db
			.select({
				id: schema.cacheIdentities.id,
				kind: schema.cacheIdentities.kind,
				name: schema.cacheIdentities.name,
				access: schema.cacheIdentities.access,
				priority: schema.cacheIdentities.priority,
				deletedAt: schema.cacheIdentities.deletedAt
			})
			.from(schema.cacheIdentities)
			.orderBy(schema.cacheIdentities.id)
			.all()
	);

	return rows.map((row) => ({
		id: row.id,
		scope: cacheScopeFromRow({
			kind: row.kind,
			name: row.name ?? undefined
		}),
		access: row.access ?? undefined,
		priority: row.priority,
		deleted: row.deletedAt !== null
	}));
}

/**
 * The names in the legacy `cache` table, in name order.
 */
async function legacyCacheNames(): Promise<string[]> {
	const rows = await runInDurableObject(currentServer(), (instance) =>
		instance.context.db
			.select({ name: schema.caches.name })
			.from(schema.caches)
			.orderBy(schema.caches.name)
			.all()
	);

	return rows.map((row) => row.name);
}

const defaultIdentity = {
	id: 1,
	scope: { kind: 'default' },
	access: 'public',
	priority: 40,
	deleted: false
};
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

	it('registers the default cache identity at initialise', async () => {
		await useTestServer('cache-admin-identity-default');

		await bootstrap();

		expect(await cacheIdentities()).toStrictEqual([defaultIdentity]);
	});

	it('gives each incarnation of a cache name its own identity', async () => {
		await useTestServer('cache-admin-identity');

		const init = await bootstrap();

		await pushPath(
			init.token,
			uploadMetadata({ fileSize: narBytes.byteLength }),
			'builds'
		);

		const afterPush = await cacheIdentities();

		await authorisedFetch('/caches/builds?force=true', init.token, {
			method: 'DELETE'
		});

		const afterDeletion = await cacheIdentities();

		await pushPath(
			init.token,
			uploadMetadata({
				fileSize: narBytes.byteLength,
				storePathHash: repeated('b')
			}),
			'builds'
		);

		const afterReuse = await cacheIdentities();
		const builds = {
			scope: { kind: 'named', name: 'builds' },
			access: 'public',
			priority: 40
		};

		expect({ afterPush, afterDeletion, afterReuse }).toStrictEqual({
			afterPush: [defaultIdentity, { ...builds, id: 2, deleted: false }],
			afterDeletion: [defaultIdentity, { ...builds, id: 2, deleted: true }],
			afterReuse: [
				defaultIdentity,
				{ ...builds, id: 2, deleted: true },
				{ ...builds, id: 3, deleted: false }
			]
		});
	});

	it('refuses to register a name whose live identity has the other access', async () => {
		await useTestServer('cache-admin-identity-access-conflict');

		const init = await bootstrap();

		await putCache(init.token, 'builds', 30);

		const refused = await authorisedFetch(
			'/caches/_private-builds',
			init.token,
			{
				body: JSON.stringify({ priority: 10 }),
				headers: { 'content-type': 'application/json' },
				method: 'PUT'
			}
		);

		expect({
			refused: refused.status,
			identities: await cacheIdentities(),
			legacyNames: await legacyCacheNames()
		}).toStrictEqual({
			refused: StatusCodes.CONFLICT,
			identities: [
				defaultIdentity,
				{
					id: 2,
					scope: { kind: 'named', name: 'builds' },
					access: 'public',
					priority: 30,
					deleted: false
				}
			],
			legacyNames: ['', 'builds']
		});
	});

	it('keeps the identity live when a teardown fails before its transaction', async () => {
		await useTestServer('cache-admin-identity-teardown-failure');

		const init = await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		await putCache(init.token, 'builds', 30);
		// A fresh upload stages under its own key, so the teardown has an R2
		// object to delete before its local transaction.
		await negotiateUploads(init.token, [metadata], 'builds');

		const deleteSpy = vi
			.spyOn(env.BLOBS, 'delete')
			.mockRejectedValue(new Error('R2 unavailable'));

		let failed: Response;

		try {
			failed = await authorisedFetch('/caches/builds', init.token, {
				method: 'DELETE'
			});
		} finally {
			deleteSpy.mockRestore();
		}

		const afterFailure = {
			identities: await cacheIdentities(),
			legacyNames: await legacyCacheNames()
		};
		const removed = await authorisedFetch('/caches/builds', init.token, {
			method: 'DELETE'
		});
		const builds = {
			id: 2,
			scope: { kind: 'named', name: 'builds' },
			access: 'public',
			priority: 30
		};

		expect({
			failed: failed.status,
			afterFailure,
			removed: removed.status,
			afterRemoval: {
				identities: await cacheIdentities(),
				legacyNames: await legacyCacheNames()
			}
		}).toStrictEqual({
			failed: StatusCodes.INTERNAL_SERVER_ERROR,
			afterFailure: {
				identities: [defaultIdentity, { ...builds, deleted: false }],
				legacyNames: ['', 'builds']
			},
			removed: StatusCodes.OK,
			afterRemoval: {
				identities: [defaultIdentity, { ...builds, deleted: true }],
				legacyNames: ['']
			}
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

		// The deletion leaves the published objects to its alarm passes, so drain
		// them before asking whether the narinfo object has gone.
		await driveToCompletion(
			() => currentServer().resumeCacheTeardown(),
			async () =>
				(await runInDurableObject(currentServer(), (_instance, state) =>
					state.storage.get(`${teardownEntryPrefix}${buildsCache}`)
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
});
