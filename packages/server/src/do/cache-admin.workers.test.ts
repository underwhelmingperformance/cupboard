import {
	type CacheAccessMode,
	cachePrioritySchema,
	type CacheScope,
	storedCacheSchema,
	storePathHashSchema,
	storePathSchema
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
import { and, eq, isNull } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	type CacheId,
	cacheScopeFromRow,
	legacyCacheKey
} from '../db/cache.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { narInfoObjectKey, requestOriginSchema } from '../http/http.ts';
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
	narHash,
	negotiateUploads,
	pushPath,
	putNarBytes,
	recordDeploymentPhase,
	resetTestServer,
	resolvedCache,
	uploadMetadata,
	useTestServer
} from '../test-support.ts';

import { teardownEntryPrefix } from './cache-admin-service.ts';
import { reconcileCacheIdentities } from './cache-identity-reconcile.ts';
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
		access: row.access ?? undefined,
		deleted: row.deletedAt !== null
	}));
}
const defaultIdentity = {
	id: 1,
	scope: { kind: 'default' },
	access: 'public',
	deleted: false
};

/**
 * Tears the cache down and reads the deletion queue in the same object visit.
 * The teardown's alarm passes would otherwise retire the rows first.
 */
async function tearDownAndReadQueue(
	cache: CacheScope
): Promise<{ cache: string; cacheId: CacheId | undefined }[]> {
	const rows = await runInDurableObject(currentServer(), async (instance) => {
		await instance.runCacheTeardown(cache, origin);

		return instance.context.db
			.select({
				cache: schema.narInfoDeletions.cache,
				cacheId: schema.narInfoDeletions.cacheId
			})
			.from(schema.narInfoDeletions)
			.orderBy(
				schema.narInfoDeletions.cache,
				schema.narInfoDeletions.storePathHash
			)
			.all();
	});

	return rows.map((row) => ({
		cache: row.cache,
		cacheId: row.cacheId ?? undefined
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

async function policyIdentityRows(): Promise<
	{
		pattern: string;
		kind: string | undefined;
		cacheId: CacheId | undefined;
		rootNamePrefix: string | undefined;
	}[]
> {
	const rows = await runInDurableObject(currentServer(), (instance) =>
		instance.context.db
			.select({
				pattern: schema.retentionPolicies.pattern,
				kind: schema.retentionPolicies.kind,
				cacheId: schema.retentionPolicies.cacheId,
				rootNamePrefix: schema.retentionPolicies.rootNamePrefix
			})
			.from(schema.retentionPolicies)
			.orderBy(schema.retentionPolicies.pattern)
			.all()
	);

	return rows.map((row) => ({
		pattern: row.pattern,
		kind: row.kind ?? undefined,
		cacheId: row.cacheId ?? undefined,
		rootNamePrefix: row.rootNamePrefix ?? undefined
	}));
}

function wake(): Promise<LocalStepOutcome> {
	return runInDurableObject(currentServer(), (instance) =>
		instance.reportLocalStep()
	);
}

async function projectedCaches(): Promise<number> {
	const rows = await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
		.select({ cache: d1Schema.cacheLifecycle.cache })
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
		.orderBy(d1Schema.cacheLifecycle.cache)
		.all();

	return rows.map((row) => ({
		kind: row.kind ?? undefined,
		name: row.name ?? undefined,
		access: row.access ?? undefined
	}));
}

const buildsCache = namedCache('builds');
const origin = requestOriginSchema.parse('https://cache.example');
// The legacy `cache` column still keys the lifecycle row for this cache.
const buildsLegacyCache = storedCacheSchema.parse(
	legacyCacheKey(buildsCache, 'public')
);

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
		.where(eq(d1Schema.cacheLifecycle.cache, buildsLegacyCache))
		.get();
}

// The version D1 publishes for `builds` and the generation its live local
// identity records. Registration stamps the second from the first, so the two
// agree.
async function cacheVersions(): Promise<{
	local: Pick<CacheVersion, 'generation'> | undefined;
	published: CacheVersion | undefined;
}> {
	const local = await runInDurableObject(currentServer(), (instance) =>
		instance.context.db
			.select({ generation: schema.cacheIdentities.generation })
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

describe('cache registry admin', () => {
	beforeEach(resetTestServer);

	it('checks the current incarnation after waiting to update cache access', async () => {
		await useTestServer('cache-admin-access-incarnation');
		await recordDeploymentPhase('native-reads');
		const init = await bootstrap();
		await putCache(init.token, 'builds', 30);

		const request = (method: string, body?: object): Request =>
			new Request('https://cupboard.test/caches/builds', {
				method,
				headers: {
					authorization: `Bearer ${init.token}`,
					'content-type': 'application/json'
				},
				...(body !== undefined && { body: JSON.stringify(body) })
			});

		await runInDurableObject(currentServer(), async (instance) => {
			const enter = instance.context.criticalSection.bind(instance.context);
			let recreated: CacheSummaryInput | undefined;
			const gate = vi.spyOn(instance.context, 'criticalSection');
			gate.mockImplementationOnce(async (run) => {
				gate.mockRestore();
				const removed = await instance.fetch(request('DELETE'));
				const created = await instance.fetch(
					request('PUT', { access: 'private', priority: 30 })
				);
				expect({
					removed: removed.status,
					created: created.status
				}).toStrictEqual({
					removed: StatusCodes.OK,
					created: StatusCodes.OK
				});
				recreated = cacheSummarySchema.parse(await created.json());
				return enter(run);
			});
			try {
				const response = await instance.fetch(
					request('PATCH', { kind: 'access', access: 'public' })
				);
				const current = await instance.fetch(request('GET'));
				expect({
					status: response.status,
					cache: cacheSummarySchema.parse(await current.json())
				}).toStrictEqual({ status: StatusCodes.CONFLICT, cache: recreated });
			} finally {
				gate.mockRestore();
			}
		});
	});

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
				graceManaged: false
			},
			{
				scope: buildsCache,
				access: 'public',
				priority: 30,
				storePaths: 1,
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
				graceManaged: false
			},
			{
				scope: buildsCache,
				access: 'public',
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

	it('records the identity of the cache a policy names', async () => {
		await useTestServer('cache-admin-identity-policy');

		const init = await bootstrap();
		const addPolicy = (body: unknown): Promise<Response> =>
			authorisedFetch('/policies', init.token, {
				body: JSON.stringify(body),
				headers: { 'content-type': 'application/json' },
				method: 'POST'
			});

		// A cache-scoped policy names a cache, so it can only be added once that
		// cache exists.
		const beforeCache = await addPolicy({
			scope: 'cache',
			cache: buildsCache,
			ttlSeconds: 3600
		});

		await putCache(init.token, 'builds', 40);
		await putCache(init.token, 'guides', 40, 'private');
		await addPolicy({ scope: 'cache', cache: buildsCache, ttlSeconds: 3600 });
		await addPolicy({
			scope: 'cache',
			cache: namedCache('guides'),
			ttlSeconds: 3600
		});
		await addPolicy({
			scope: 'root-name-prefix',
			pattern: 'release/',
			ttlSeconds: 7200
		});

		expect({
			beforeCache: beforeCache.status,
			policies: await policyIdentityRows()
		}).toStrictEqual({
			beforeCache: StatusCodes.NOT_FOUND,
			policies: [
				{
					pattern: 'builds',
					kind: 'cache',
					cacheId: 2,
					rootNamePrefix: undefined
				},
				// The legacy pattern still spells out a private cache's access.
				{
					pattern: 'private/guides',
					kind: 'cache',
					cacheId: 3,
					rootNamePrefix: undefined
				},
				{
					pattern: 'release/',
					kind: 'root-name-prefix',
					cacheId: undefined,
					rootNamePrefix: 'release/'
				}
			]
		});
	});

	it('fills the identity of rows that carry only a legacy cache name', async () => {
		await useTestServer('cache-admin-identity-reconcile');

		const init = await bootstrap();

		await putCache(init.token, 'builds', 40);
		// The state an earlier release left behind: collection rows keyed by the
		// stored cache name alone, with no identity beside them.
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.insert(schema.garbageCollectionRevisions)
				.values([
					{ cache: storedCacheSchema.parse(''), revision: 0 },
					{ cache: buildsLegacyCache, revision: 0 }
				])
				.run();
		});

		const collectionState = (): Promise<
			{ cache: string; cacheId: CacheId | undefined }[]
		> =>
			runInDurableObject(currentServer(), (instance) =>
				instance.context.db
					.select({
						cache: schema.garbageCollectionRevisions.cache,
						cacheId: schema.garbageCollectionRevisions.cacheId
					})
					.from(schema.garbageCollectionRevisions)
					.orderBy(schema.garbageCollectionRevisions.cache)
					.all()
					.map((row) => ({
						cache: row.cache,
						cacheId: row.cacheId ?? undefined
					}))
			);

		const beforeStep = await collectionState();

		await runInDurableObject(currentServer(), (instance) =>
			instance.reportLocalStep()
		);

		const afterStep = await collectionState();
		const identities = await cacheIdentities();

		expect({
			beforeStep,
			afterStep,
			identities: identities.map(({ scope }) => scope)
		}).toStrictEqual({
			beforeStep: [
				{ cache: '', cacheId: undefined },
				{ cache: 'builds', cacheId: undefined }
			],
			afterStep: [
				{ cache: '', cacheId: 1 },
				{ cache: 'builds', cacheId: 2 }
			],
			identities: [{ kind: 'default' }, { kind: 'named', name: 'builds' }]
		});
	});

	it('bounds identity backfill pages and admits later predecessor writes', async () => {
		await useTestServer('cache-admin-bounded-backfill');
		await bootstrap();
		await runInDurableObject(currentServer(), (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE cache SET migration_identity_id = (SELECT id FROM cache_identity WHERE kind = 'default' AND deleted_at IS NULL) WHERE name = ''"
			);
			for (let index = 0; index < 40; index++) {
				const name = `legacy-${String(index).padStart(3, '0')}`;
				const hash = String(index).padStart(32, '0');
				state.storage.sql.exec(
					"INSERT INTO cache (name, priority, created_at) VALUES (?, 40, '2026-01-01T00:00:00.000Z')",
					name
				);
				state.storage.sql.exec(
					"INSERT INTO narinfo (cache, store_path_hash, store_path, nar_hash, nar_size, references_json, created_at) VALUES (?, ?, ?, ?, 1, '[]', '2026-01-01T00:00:00.000Z')",
					name,
					hash,
					`/nix/store/${hash}-old`,
					narHash
				);
			}
		});
		const pages = [];
		for (let index = 0; index < 4; index++) {
			pages.push(
				await runInDurableObject(currentServer(), async (instance, state) => ({
					outcome: await reconcileCacheIdentities(instance.context),
					unlinked: state.storage.sql
						.exec<{ count: number }>(
							'SELECT count(*) AS count FROM narinfo WHERE cache_id IS NULL'
						)
						.one().count
				}))
			);
		}
		expect(pages).toStrictEqual([
			{ outcome: { processed: 36, hasMore: true }, unlinked: 40 },
			{ outcome: { processed: 36, hasMore: true }, unlinked: 8 },
			{ outcome: { processed: 36, hasMore: true }, unlinked: 0 },
			{ outcome: { processed: 12, hasMore: false }, unlinked: 0 }
		]);
		const later = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				state.storage.sql.exec(
					"INSERT INTO cache (name, priority, created_at) VALUES ('aaa-later', 40, '2026-02-01T00:00:00.000Z')"
				);
				state.storage.sql.exec(
					"INSERT INTO narinfo (cache, store_path_hash, store_path, nar_hash, nar_size, references_json, created_at) VALUES ('aaa-later', ?, ?, ?, 1, '[]', '2026-02-01T00:00:00.000Z')",
					repeated('z'),
					`/nix/store/${repeated('z')}-later`,
					narHash
				);
				const outcome = await reconcileCacheIdentities(instance.context);
				return {
					outcome,
					unlinked: state.storage.sql
						.exec<{ count: number }>(
							'SELECT count(*) AS count FROM narinfo WHERE cache_id IS NULL'
						)
						.one().count
				};
			}
		);
		expect(later).toStrictEqual({
			outcome: { processed: 3, hasMore: false },
			unlinked: 0
		});
	});

	it('creates the identity of a cache registered without one', async () => {
		await useTestServer('cache-admin-retained-legacy-backfill');

		const init = await bootstrap();

		await putCache(init.token, 'builds', 40);

		// A build that predates the identity table registers a cache and writes
		// its rows with the stored name alone.
		const releases = storedCacheSchema.parse('private/releases');
		const registeredAt = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');

		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.insert(schema.caches)
				.values({
					name: releases,
					priority: cachePrioritySchema.parse(40),
					createdAt: registeredAt
				})
				.run();
			instance.context.db
				.insert(schema.narInfos)
				.values({
					cache: releases,
					storePathHash: storePathHashSchema.parse(repeated('b')),
					storePath: storePathSchema.parse(`/nix/store/${repeated('b')}-old`),
					narHash,
					narSize: narBytes.byteLength,
					referencesJson: '[]',
					createdAt: registeredAt
				})
				.run();
		});

		await wake();

		const releasesRow = await runInDurableObject(currentServer(), (instance) =>
			instance.context.db
				.select({
					cache: schema.narInfos.cache,
					cacheId: schema.narInfos.cacheId
				})
				.from(schema.narInfos)
				.where(eq(schema.narInfos.cache, releases))
				.get()
		);

		expect({
			identities: await cacheIdentities(),
			releasesRow:
				releasesRow === undefined
					? undefined
					: { cache: releasesRow.cache, cacheId: releasesRow.cacheId }
		}).toStrictEqual({
			identities: [
				defaultIdentity,
				{
					id: 2,
					scope: { kind: 'named', name: 'builds' },
					access: 'public',
					deleted: false
				},
				{
					id: 3,
					scope: { kind: 'named', name: 'releases' },
					access: 'private',
					deleted: false
				}
			],
			releasesRow: { cache: 'private/releases', cacheId: 3 }
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

	it('registers the default cache identity at initialise', async () => {
		await useTestServer('cache-admin-identity-default');

		await bootstrap();

		expect(await cacheIdentities()).toStrictEqual([defaultIdentity]);
	});

	it('queues the deletions of a torn-down cache under its deleted identity', async () => {
		await useTestServer('cache-admin-identity-teardown-queue');

		const init = await bootstrap();

		await putCache(init.token, 'builds', 40);
		await pushPath(
			init.token,
			uploadMetadata({ fileSize: narBytes.byteLength }),
			buildsCache
		);

		const narInfoDeletions = await tearDownAndReadQueue(buildsCache);
		const identities = await cacheIdentities();

		expect({ identities, narInfoDeletions }).toStrictEqual({
			identities: [
				defaultIdentity,
				{
					id: 2,
					scope: { kind: 'named', name: 'builds' },
					access: 'public',
					deleted: true
				}
			],
			narInfoDeletions: [{ cache: 'builds', cacheId: 2 }]
		});
	});

	it('keeps the identity live when a teardown fails before its transaction', async () => {
		await useTestServer('cache-admin-identity-teardown-failure');

		const init = await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		await putCache(init.token, 'builds', 30);
		// A fresh upload stages under its own key, so the teardown has an R2
		// object to delete before its local transaction.
		await negotiateUploads(init.token, [metadata], buildsCache);

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
			access: 'public'
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
				legacyNames: ['builds']
			},
			removed: StatusCodes.OK,
			afterRemoval: {
				identities: [defaultIdentity, { ...builds, deleted: true }],
				legacyNames: []
			}
		});
	});

	// A policy scoped to a cache that has been torn down would refer to a deleted
	// identity; every policy read resolves each policy's cache, so one such
	// policy would fail every root write of the tenant.
	it('removes the policies scoped to a cache it tears down', async () => {
		await useTestServer('cache-admin-teardown-policies');

		const init = await bootstrap();
		const addPolicy = (body: unknown): Promise<Response> =>
			authorisedFetch('/policies', init.token, {
				body: JSON.stringify(body),
				headers: { 'content-type': 'application/json' },
				method: 'POST'
			});
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		await putCache(init.token, 'builds', 40);
		await pushPath(init.token, metadata);
		await addPolicy({ scope: 'cache', cache: buildsCache, ttlSeconds: 3600 });
		await addPolicy({
			scope: 'root-name-prefix',
			pattern: 'release/',
			ttlSeconds: 7200
		});
		await authorisedFetch('/caches/builds?force=true', init.token, {
			method: 'DELETE'
		});
		await driveToCompletion(
			() => currentServer().resumeCacheTeardown(),
			async () => {
				const markers = await runInDurableObject(
					currentServer(),
					(_instance, state) =>
						state.storage.list({ prefix: teardownEntryPrefix, limit: 1 })
				);

				return markers.size === 0;
			},
			3
		);
		const remainingMarkers = await runInDurableObject(
			currentServer(),
			(_instance, state) =>
				state.storage.list({ prefix: teardownEntryPrefix, limit: 1 })
		);
		expect(remainingMarkers.size).toBe(0);

		const listed = await authorisedFetch('/policies', init.token);
		const set = await authorisedFetch('/roots/channel', init.token, {
			body: JSON.stringify({ targets: [metadata.storePath] }),
			headers: { 'content-type': 'application/json' },
			method: 'PUT'
		});

		expect({
			listed: listed.status,
			policies: await policyIdentityRows(),
			set: set.status
		}).toStrictEqual({
			listed: StatusCodes.OK,
			policies: [
				{
					pattern: 'release/',
					kind: 'root-name-prefix',
					cacheId: undefined,
					rootNamePrefix: 'release/'
				}
			],
			set: StatusCodes.OK
		});
	});

	it('creates the identity of a cache registered without one', async () => {
		await useTestServer('cache-admin-identity-reconcile-legacy');

		const init = await bootstrap();

		await putCache(init.token, 'builds', 40);

		// A build that predates the identity table registers a cache and writes
		// its rows with the stored name alone.
		const releases = storedCacheSchema.parse('private/releases');
		const registeredAt = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');

		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.insert(schema.caches)
				.values({
					name: releases,
					priority: cachePrioritySchema.parse(40),
					createdAt: registeredAt
				})
				.run();
			instance.context.db
				.insert(schema.narInfos)
				.values({
					cache: releases,
					storePathHash: storePathHashSchema.parse(repeated('b')),
					storePath: storePathSchema.parse(`/nix/store/${repeated('b')}-old`),
					narHash,
					narSize: narBytes.byteLength,
					referencesJson: '[]',
					createdAt: registeredAt
				})
				.run();
		});

		await wake();

		const releasesRow = await runInDurableObject(currentServer(), (instance) =>
			instance.context.db
				.select({
					cache: schema.narInfos.cache,
					cacheId: schema.narInfos.cacheId
				})
				.from(schema.narInfos)
				.where(eq(schema.narInfos.cache, releases))
				.get()
		);

		expect({
			identities: await cacheIdentities(),
			releasesRow:
				releasesRow === undefined
					? undefined
					: { cache: releasesRow.cache, cacheId: releasesRow.cacheId }
		}).toStrictEqual({
			identities: [
				defaultIdentity,
				{
					id: 2,
					scope: { kind: 'named', name: 'builds' },
					access: 'public',
					deleted: false
				},
				{
					id: 3,
					scope: { kind: 'named', name: 'releases' },
					access: 'private',
					deleted: false
				}
			],
			releasesRow: { cache: 'private/releases', cacheId: 3 }
		});
	});

	it('distinguishes a deleted cache row from a recreated cache row', async () => {
		await useTestServer('cache-admin-identity-reconcile-deleted');

		await bootstrap();

		// `releases` was deleted after its row was registered, so the row is the
		// deleted cache's own. `guides` was registered again after its deletion, so
		// its row is a new cache.
		const deletedAt = isoTimestampSchema.parse('2026-01-02T00:00:00.000Z');
		const priority = cachePrioritySchema.parse(40);

		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.insert(schema.caches)
				.values([
					{
						name: storedCacheSchema.parse('releases'),
						priority,
						createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z')
					},
					{
						name: storedCacheSchema.parse('guides'),
						priority,
						createdAt: isoTimestampSchema.parse('2026-01-03T00:00:00.000Z')
					}
				])
				.run();
			instance.context.db
				.insert(schema.cacheIdentities)
				.values([
					{
						kind: 'named',
						name: 'releases',
						access: 'public',
						priority,
						createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
						deletedAt
					},
					{
						kind: 'named',
						name: 'guides',
						access: 'public',
						priority,
						createdAt: isoTimestampSchema.parse('2025-12-01T00:00:00.000Z'),
						deletedAt
					}
				])
				.run();
		});

		await wake();

		const guidesIdentity = {
			scope: { kind: 'named', name: 'guides' },
			access: 'public'
		};

		expect(await cacheIdentities()).toStrictEqual([
			defaultIdentity,
			{
				id: 2,
				scope: { kind: 'named', name: 'releases' },
				access: 'public',
				deleted: true
			},
			{ ...guidesIdentity, id: 3, deleted: true },
			{ ...guidesIdentity, id: 4, deleted: false }
		]);
	});

	it("records a cache's access as its projected row's access", async () => {
		await useTestServer('cache-admin-identity-projection-access');

		const init = await bootstrap();

		// Registering a cache writes its lifecycle row. Drop it so the projection
		// is the writer of the row under test.
		await putCache(init.token, 'builds', 40, 'private');
		await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
			.delete(d1Schema.cacheLifecycle)
			.run();
		await wake();

		const row = await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
			.select({
				cache: d1Schema.cacheLifecycle.cache,
				access: d1Schema.cacheLifecycle.access
			})
			.from(d1Schema.cacheLifecycle)
			.where(
				and(
					eq(d1Schema.cacheLifecycle.tenant, fixtureTenant),
					eq(d1Schema.cacheLifecycle.cacheName, buildsCache.name)
				)
			)
			.get();

		expect(row).toStrictEqual({ cache: 'private/builds', access: 'private' });
	});

	it('finishes backfill, projection and object inspection over bounded wakes', async () => {
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

		const outcomes = [];
		for (let index = 0; index < 5; index++) {
			const outcome = await wake();
			outcomes.push({ kind: outcome.kind, projected: await projectedCaches() });
		}
		expect(outcomes).toStrictEqual([
			{ kind: 'incomplete', projected: 0 },
			{ kind: 'incomplete', projected: maxCachesProjectedPerRun },
			{ kind: 'incomplete', projected: cacheCount + 1 },
			{ kind: 'incomplete', projected: cacheCount + 1 },
			{ kind: 'recorded', projected: cacheCount + 1 }
		]);
	});

	it('bounds a projection pass even when every lifecycle already exists', async () => {
		await useTestServer('cache-admin-existing-projection');
		const init = await bootstrap();
		for (let index = 0; index < maxCachesProjectedPerRun + 5; index++) {
			await putCache(init.token, `cache-${String(index).padStart(3, '0')}`, 40);
		}
		for (let index = 0; index < 5; index++) {
			await wake();
		}
		expect(await wake()).toStrictEqual({ kind: 'incomplete', projected: 0 });
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
		const teardownMarker = await runInDurableObject(
			currentServer(),
			(_instance, state) =>
				state.storage.get(`${teardownEntryPrefix}${String(buildsId)}`)
		);
		expect(teardownMarker).toBeUndefined();

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
			afterDeletion: [initial, { ...builds, id: 2, deleted: true }],
			afterReuse: [
				initial,
				{ ...builds, id: 2, deleted: true },
				{ ...builds, id: 3, deleted: false }
			]
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
			created: { local: { generation: 1 }, published: first },
			reregistered: { local: { generation: 1 }, published: first },
			deleted: second,
			recreated: { local: { generation: 2 }, published: second }
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
