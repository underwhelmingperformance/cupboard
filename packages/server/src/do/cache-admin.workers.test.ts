import {
	type CacheAccessMode,
	cachePrioritySchema,
	type CacheScope,
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
import {
	currentLocalStep,
	type DeploymentPhaseName,
	deploymentPhaseRowId
} from '@cupboard/protocol/deployment';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, eq, isNull } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { type CacheId, cacheScopeFromRow } from '../db/cache.ts';
import * as d1Schema from '../db/d1-schema.ts';
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
	readFetch,
	resetTestServer,
	resolvedCache,
	uploadMetadata,
	useTestServer
} from '../test-support.ts';

import { teardownEntryPrefix } from './cache-admin-service.ts';
import { maxCachesProjectedPerRun } from './cache-lifecycle-projection.ts';
import { type LocalStepOutcome } from './local-step.ts';

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
		access: row.access,
		deleted: row.deletedAt !== null
	}));
}
async function recordPhase(phase: DeploymentPhaseName): Promise<void> {
	await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
		.insert(d1Schema.deploymentPhase)
		.values({
			id: deploymentPhaseRowId,
			phase,
			requiredLocalStep: currentLocalStep,
			updatedAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z')
		})
		.onConflictDoUpdate({
			target: d1Schema.deploymentPhase.id,
			set: { phase }
		})
		.run();
}

function wake(): Promise<LocalStepOutcome> {
	return runInDurableObject(currentServer(), (instance) =>
		instance.reportLocalStep()
	);
}

async function projectedCaches(): Promise<number> {
	const rows = await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
		.select({ cacheKind: d1Schema.cacheLifecycle.cacheKind })
		.from(d1Schema.cacheLifecycle)
		.all();

	return rows.length;
}

/**
 * The lifecycle rows a tenant has, by the identity they record.
 */
async function lifecycleIdentities(): Promise<
	{
		kind: string | undefined;
		name: string | undefined;
		access: string | undefined;
	}[]
> {
	const rows = await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
		.select({
			kind: d1Schema.cacheLifecycle.cacheKind,
			name: d1Schema.cacheLifecycle.cacheName,
			access: d1Schema.cacheLifecycle.access
		})
		.from(d1Schema.cacheLifecycle)
		.orderBy(
			d1Schema.cacheLifecycle.cacheKind,
			d1Schema.cacheLifecycle.cacheName
		)
		.all();

	return rows.map((row) => ({
		kind: row.kind,
		name: row.name ?? undefined,
		access: row.access
	}));
}

const buildsCache = namedCache('builds');

interface CacheVersion {
	readonly generation: number;
	readonly readRevision: number;
}

// The version D1 publishes for `builds`, which is what a read consults.
function publishedCacheVersion(): Promise<CacheVersion | undefined> {
	return drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
		.select({
			generation: d1Schema.cacheLifecycle.generation,
			readRevision: d1Schema.cacheLifecycle.readRevision
		})
		.from(d1Schema.cacheLifecycle)
		.where(
			and(
				eq(d1Schema.cacheLifecycle.cacheKind, 'named'),
				eq(d1Schema.cacheLifecycle.cacheName, buildsCache.name)
			)
		)
		.get();
}

// The version D1 publishes for `builds` and the one its live local identity
// records. Registration stamps the second from the first, so the two agree.
async function cacheVersions(): Promise<{
	local: CacheVersion | undefined;
	published: CacheVersion | undefined;
}> {
	const local = await runInDurableObject(currentServer(), (instance) =>
		instance.context.db
			.select({
				generation: schema.cacheIdentities.generation,
				readRevision: schema.cacheIdentities.readRevision
			})
			.from(schema.cacheIdentities)
			.where(
				and(
					eq(schema.cacheIdentities.name, buildsCache.name),
					isNull(schema.cacheIdentities.deletedAt)
				)
			)
			.get()
	);

	return { local, published: await publishedCacheVersion() };
}

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
	priority: number,
	access: CacheAccessMode = 'public'
): Promise<CacheSummaryInput> {
	const response = await authorisedFetch(`/caches/${name}`, token, {
		body: JSON.stringify({ access, priority }),
		headers: { 'content-type': 'application/json' },
		method: 'PUT'
	});

	expect(response.status).toBe(StatusCodes.OK);

	return cacheSummarySchema.parse(await response.json());
}

async function putReuseView(
	token: string,
	name: string,
	access: CacheAccessMode,
	prefix: string
): Promise<void> {
	const response = await authorisedFetch(`/reuse-views/${name}`, token, {
		body: JSON.stringify({
			access,
			priority: 50,
			selectors: [{ kind: 'prefix', prefix }]
		}),
		headers: { 'content-type': 'application/json' },
		method: 'PUT'
	});

	expect(response.status).toBe(StatusCodes.OK);
}

async function getCache(
	token: string,
	name: string
): Promise<CacheSummaryInput> {
	const response = await authorisedFetch(`/caches/${name}`, token);

	expect(response.status).toBe(StatusCodes.OK);

	return cacheSummarySchema.parse(await response.json());
}

async function updateCacheAccess(
	token: string,
	name: string,
	access: CacheAccessMode
): Promise<CacheSummaryInput> {
	const response = await authorisedFetch(`/caches/${name}`, token, {
		body: JSON.stringify({ kind: 'access', access }),
		headers: { 'content-type': 'application/json' },
		method: 'PATCH'
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

const viewMismatchDataSchema = z.object({ views: z.array(z.string()) });
const viewMismatchSchema = z.object({
	code: z.string(),
	data: viewMismatchDataSchema
});

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

	it('refuses a private cache that a public reuse view selects', async () => {
		await useTestServer('cache-admin-view-access');
		const init = await bootstrap();
		await putReuseView(init.token, 'pull-requests-1', 'public', 'vpr-');

		const refused = await authorisedFetch('/caches/vpr-1', init.token, {
			body: JSON.stringify({ access: 'private', priority: 30 }),
			headers: { 'content-type': 'application/json' },
			method: 'PUT'
		});
		const refusal = viewMismatchSchema.safeParse(await refused.json());

		const { caches } = await listCaches(init.token);

		expect({
			status: refused.status,
			code: refusal.data?.code,
			views: refusal.data?.data.views,
			caches: caches.map((summary) => summary.scope)
		}).toStrictEqual({
			status: StatusCodes.CONFLICT,
			code: 'CACHE_VIEW_ACCESS_MISMATCH',
			views: ['pull-requests-1'],
			// The tenant still has only its default cache.
			caches: [defaultCache()]
		});
	});

	it('creates a cache whose access matches the selecting view', async () => {
		await useTestServer('cache-admin-view-access-agrees');
		const init = await bootstrap();
		await putReuseView(init.token, 'pull-requests-2', 'public', 'wpr-');

		const created = await putCache(init.token, 'wpr-1', 30, 'public');

		expect({ scope: created.scope, access: created.access }).toStrictEqual({
			scope: { kind: 'named', name: 'wpr-1' },
			access: 'public'
		});
	});

	it('reports grace management and the earliest live deadline per cache', async () => {
		await useTestServer('cache-admin-grace-state');
		const init = await bootstrap();
		await putCache(init.token, 'builds', 30);
		await runInDurableObject(currentServer(), (instance) => {
			const cache = resolvedCache(instance.context, buildsCache);

			instance.context.db
				.update(schema.cacheIdentities)
				.set({ graceManaged: true })
				.where(eq(schema.cacheIdentities.id, cache.id))
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
							.insert(schema.cacheIdentities)
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

	it('binds a published path to the cache identity', async () => {
		await useTestServer('cache-admin-identity-binding');

		const init = await bootstrap();

		await putCache(init.token, 'builds', 40);
		await pushPath(
			init.token,
			uploadMetadata({ fileSize: narBytes.byteLength }),
			buildsCache
		);

		// A commit deletes the pending row, so negotiate a second path and leave
		// it uncommitted so that a pending row survives to be read.
		await negotiateUploads(
			init.token,
			[
				uploadMetadata({
					fileSize: narBytes.byteLength,
					storePathHash: repeated('c')
				})
			],
			buildsCache
		);

		const identity = await runInDurableObject(currentServer(), (instance) =>
			resolvedCache(instance.context, buildsCache)
		);
		const bound = await runInDurableObject(currentServer(), (instance) => ({
			narInfos: instance.context.db
				.select({ cacheId: schema.narInfos.cacheId })
				.from(schema.narInfos)
				.all(),
			pendingUploads: instance.context.db
				.select({ cacheId: schema.pendingUploads.cacheId })
				.from(schema.pendingUploads)
				.all()
		}));

		expect({ identity: identity.id, bound }).toStrictEqual({
			identity: 2,
			bound: {
				narInfos: [{ cacheId: 2 }],
				pendingUploads: [{ cacheId: 2 }]
			}
		});
	});

	it('binds retention rows to the cache identity', async () => {
		await useTestServer('cache-admin-identity-retention');

		const init = await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		await putCache(init.token, 'builds', 40);
		await pushPath(init.token, metadata, buildsCache);

		const set = await authorisedFetch(
			'/cache/builds/roots/channel',
			init.token,
			{
				body: JSON.stringify({ targets: [metadata.storePath] }),
				headers: { 'content-type': 'application/json' },
				method: 'PUT'
			}
		);
		const bound = await runInDurableObject(currentServer(), (instance) => ({
			roots: instance.context.db
				.select({ cacheId: schema.retentionRoots.cacheId })
				.from(schema.retentionRoots)
				.all(),
			targets: instance.context.db
				.select({ cacheId: schema.retentionRootTargets.cacheId })
				.from(schema.retentionRootTargets)
				.all()
		}));

		expect({ set: set.status, bound }).toStrictEqual({
			set: StatusCodes.OK,
			bound: {
				roots: [{ cacheId: 2 }],
				targets: [{ cacheId: 2 }]
			}
		});
	});

	// A request that names a cache reads this row to learn how the cache reads,
	// so the row has to exist from the cache's first write rather than waiting
	// for the projection.
	it('records how a cache reads when the cache is registered', async () => {
		await useTestServer('cache-admin-lifecycle-on-registration');

		const init = await bootstrap();

		await putCache(init.token, 'builds', 30);
		await putCache(init.token, 'guides', 40, 'private');

		expect(await lifecycleIdentities()).toStrictEqual([
			{ kind: 'default', name: undefined, access: 'public' },
			{ kind: 'named', name: 'builds', access: 'public' },
			{ kind: 'named', name: 'guides', access: 'private' }
		]);
	});

	it('finishes projecting more caches than one invocation allows over two wakes', async () => {
		await useTestServer('cache-admin-identity-projection');

		const init = await bootstrap();
		// More caches than one invocation projects.
		const cacheCount = maxCachesProjectedPerRun + 5;

		for (let index = 0; index < cacheCount; index += 1) {
			await putCache(init.token, `cache-${String(index).padStart(3, '0')}`, 40);
		}

		// Registering a cache writes its lifecycle row, so drop every row to leave
		// the state this projection exists for: caches registered by a release
		// that wrote no row.
		await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
			.delete(d1Schema.cacheLifecycle)
			.run();

		const beforeWake = await projectedCaches();
		const first = await wake();
		const afterFirst = await projectedCaches();
		const second = await wake();
		const afterSecond = await projectedCaches();

		expect({
			first: first.kind,
			projectedByFirst: afterFirst - beforeWake,
			second: second.kind,
			// Every cache the tenant has, plus the default one.
			total: afterSecond
		}).toStrictEqual({
			first: 'incomplete',
			projectedByFirst: maxCachesProjectedPerRun,
			second: 'recorded',
			total: cacheCount + 1
		});
	});

	it('lists the same caches from the identity table as from the legacy one', async () => {
		await useTestServer('cache-admin-native-list');

		const init = await bootstrap();

		await putCache(init.token, 'builds', 30);
		await putCache(init.token, 'docs', 20);
		await pushPath(
			init.token,
			uploadMetadata({ fileSize: narBytes.byteLength }),
			buildsCache
		);

		const reads = async (): Promise<{
			list: CacheListResponseInput;
			cacheInfo: string;
			summary: CacheSummaryInput;
		}> => {
			const info = await readFetch('/cache/builds/nix-cache-info');

			return {
				list: await listCaches(init.token),
				cacheInfo: await info.text(),
				summary: await getCache(init.token, 'builds')
			};
		};

		const legacy = await reads();

		await recordPhase('native-reads');

		expect(await reads()).toStrictEqual(legacy);
	});

	it('gives each incarnation of a cache name its own identity', async () => {
		await useTestServer('cache-admin-identity');

		const init = await bootstrap();

		await putCache(init.token, 'builds', 40);
		await pushPath(
			init.token,
			uploadMetadata({ fileSize: narBytes.byteLength }),
			buildsCache
		);

		const afterPush = await cacheIdentities();
		const buildsId = await runInDurableObject(
			currentServer(),
			(instance) => resolvedCache(instance.context, buildsCache).id
		);

		await authorisedFetch('/caches/builds?force=true', init.token, {
			method: 'DELETE'
		});
		// Teardown retires the identity it deleted, so drive it to completion
		// rather than reading the registry while a pass is still queued.
		await driveToCompletion(
			() => currentServer().resumeCacheTeardown(),
			async () =>
				(await runInDurableObject(currentServer(), (_instance, state) =>
					state.storage.get(`${teardownEntryPrefix}${String(buildsId)}`)
				)) === undefined,
			3
		);

		const afterDeletion = await cacheIdentities();

		await putCache(init.token, 'builds', 40);
		await pushPath(
			init.token,
			uploadMetadata({
				fileSize: narBytes.byteLength,
				storePathHash: repeated('b')
			}),
			buildsCache
		);

		const afterReuse = await cacheIdentities();
		const builds = {
			scope: { kind: 'named', name: 'builds' },
			access: 'public'
		};
		const initial = {
			scope: defaultCache(),
			access: 'public',
			id: 1,
			deleted: false
		};

		expect({ afterPush, afterDeletion, afterReuse }).toStrictEqual({
			afterPush: [initial, { ...builds, id: 2, deleted: false }],
			afterDeletion: [initial],
			afterReuse: [initial, { ...builds, id: 3, deleted: false }]
		});
	});

	it('advances a cache version on deletion and stamps it on the incarnation created next', async () => {
		await useTestServer('cache-admin-version');

		const init = await bootstrap();

		await putCache(init.token, 'builds', 30);

		const created = await cacheVersions();

		// Set the access the cache already has. The read revision must stay where
		// it is, or every such call would evict the cache's public responses from
		// Workers Cache.
		await updateCacheAccess(init.token, 'builds', 'public');

		const reregistered = await cacheVersions();

		await authorisedFetch('/caches/builds?force=true', init.token, {
			method: 'DELETE'
		});

		const deleted = await publishedCacheVersion();

		await putCache(init.token, 'builds', 30);

		const first = { generation: 1, readRevision: 1 };
		const second = { generation: 2, readRevision: 2 };

		expect({
			created,
			reregistered,
			deleted,
			recreated: await cacheVersions()
		}).toStrictEqual({
			created: { local: first, published: first },
			reregistered: { local: first, published: first },
			deleted: second,
			recreated: { local: second, published: second }
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
