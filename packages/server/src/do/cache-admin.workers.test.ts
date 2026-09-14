import {
	cacheNameSchema,
	cachePrioritySchema,
	type CacheScope,
	type StoredCache,
	storedCacheSchema,
	storePathHashSchema,
	storePathSchema
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
import { narInfoObjectKey, requestOriginSchema } from '../http/http.ts';
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
	narHash,
	negotiateUploads,
	pushPath,
	putNarBytes,
	resetTestServer,
	testPushId,
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

function withId(row: { cache: string; cacheId: CacheId | null }): {
	cache: string;
	cacheId: CacheId | undefined;
} {
	return { cache: row.cache, cacheId: row.cacheId ?? undefined };
}

/**
 * The cache columns of every row a publish writes, in store-path order.
 */
async function publishedRows(): Promise<{
	narInfos: { cache: string; cacheId: CacheId | undefined }[];
	generationSeq: {
		cache: string;
		cacheKind: string | undefined;
		cacheName: string | undefined;
	}[];
	pendingUploads: { cache: string; cacheId: CacheId | undefined }[];
	pendingAttestations: { cache: string; cacheId: CacheId | undefined }[];
}> {
	return runInDurableObject(currentServer(), (instance) => ({
		narInfos: instance.context.db
			.select({
				cache: schema.narInfos.cache,
				cacheId: schema.narInfos.cacheId
			})
			.from(schema.narInfos)
			.orderBy(schema.narInfos.cache, schema.narInfos.storePathHash)
			.all()
			.map((row) => withId(row)),
		generationSeq: instance.context.db
			.select({
				cache: schema.generationSeq.cache,
				cacheKind: schema.generationSeq.cacheKind,
				cacheName: schema.generationSeq.cacheName
			})
			.from(schema.generationSeq)
			.orderBy(schema.generationSeq.cache, schema.generationSeq.storePathHash)
			.all()
			.map((row) => ({
				cache: row.cache,
				cacheKind: row.cacheKind ?? undefined,
				cacheName: row.cacheName ?? undefined
			})),
		pendingUploads: instance.context.db
			.select({
				cache: schema.pendingUploads.cache,
				cacheId: schema.pendingUploads.cacheId
			})
			.from(schema.pendingUploads)
			.orderBy(schema.pendingUploads.cache, schema.pendingUploads.id)
			.all()
			.map((row) => withId(row)),
		pendingAttestations: instance.context.db
			.select({
				cache: schema.pendingAttestations.cache,
				cacheId: schema.pendingAttestations.cacheId
			})
			.from(schema.pendingAttestations)
			.orderBy(
				schema.pendingAttestations.cache,
				schema.pendingAttestations.storePathHash
			)
			.all()
			.map((row) => withId(row))
	}));
}

/**
 * Tears the cache down inside the object and returns the cache columns of
 * every queued narinfo deletion, read before the object takes another
 * event: the teardown's alarm passes would otherwise retire the rows first.
 */
async function tearDownAndReadQueue(
	cache: StoredCache
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

	return rows.map((row) => withId(row));
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

const buildsCache = cacheNameSchema.parse('builds');
const origin = requestOriginSchema.parse('https://cache.example');

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

	it('records the cache identity on the rows a publish writes', async () => {
		await useTestServer('cache-admin-identity-binding');

		const init = await bootstrap();
		const published = uploadMetadata({ fileSize: narBytes.byteLength });
		const digest = 'ab'.repeat(32);

		// Neither negotiation registers its cache, so both rows wait under the
		// legacy name. A commit deletes its pending row, so the upload stays
		// uncommitted to be read back.
		await negotiateUploads(
			init.token,
			[
				uploadMetadata({
					fileSize: narBytes.byteLength,
					storePathHash: repeated('c')
				})
			],
			'docs'
		);
		await authorisedFetch('/cache/builds/attestations', init.token, {
			body: JSON.stringify({
				pushId: testPushId,
				bundles: [{ storePathHash: published.storePathHash, digest }]
			}),
			headers: { 'content-type': 'application/json' },
			method: 'POST'
		});

		const beforeRegistration = await publishedRows();

		await pushPath(init.token, published, 'docs');
		await putCache(init.token, 'builds', 30);

		const identities = await cacheIdentities();

		expect({
			identities: identities.map((identity) => ({
				id: identity.id,
				scope: identity.scope
			})),
			beforeRegistration,
			afterRegistration: await publishedRows()
		}).toStrictEqual({
			identities: [
				{ id: 1, scope: { kind: 'default' } },
				{ id: 2, scope: { kind: 'named', name: 'docs' } },
				{ id: 3, scope: { kind: 'named', name: 'builds' } }
			],
			beforeRegistration: {
				narInfos: [],
				generationSeq: [],
				pendingUploads: [{ cache: 'docs', cacheId: undefined }],
				pendingAttestations: [{ cache: 'builds', cacheId: undefined }]
			},
			afterRegistration: {
				narInfos: [{ cache: 'docs', cacheId: 2 }],
				generationSeq: [
					{ cache: 'docs', cacheKind: 'named', cacheName: 'docs' }
				],
				pendingUploads: [{ cache: 'docs', cacheId: 2 }],
				pendingAttestations: [{ cache: 'builds', cacheId: 3 }]
			}
		});
	});

	it('queues the deletions of a torn-down cache under its deleted identity', async () => {
		await useTestServer('cache-admin-identity-teardown-queue');

		const init = await bootstrap();

		await pushPath(
			init.token,
			uploadMetadata({ fileSize: narBytes.byteLength }),
			'builds'
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
					priority: 40,
					deleted: true
				}
			],
			narInfoDeletions: [{ cache: 'builds', cacheId: 2 }]
		});
	});

	it('binds retention rows to the cache identity', async () => {
		await useTestServer('cache-admin-identity-retention');

		const init = await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		await pushPath(init.token, metadata, 'builds');

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
				.select({
					cache: schema.retentionRoots.cache,
					cacheId: schema.retentionRoots.cacheId
				})
				.from(schema.retentionRoots)
				.all(),
			targets: instance.context.db
				.select({
					cache: schema.retentionRootTargets.cache,
					cacheId: schema.retentionRootTargets.cacheId
				})
				.from(schema.retentionRootTargets)
				.all()
		}));

		expect({ set: set.status, bound }).toStrictEqual({
			set: StatusCodes.OK,
			bound: {
				roots: [{ cache: 'builds', cacheId: 2 }],
				targets: [{ cache: 'builds', cacheId: 2 }]
			}
		});
	});

	it('links a cache-scoped policy when its cache is created', async () => {
		await useTestServer('cache-admin-identity-policy');

		const init = await bootstrap();
		const addPolicy = (body: unknown): Promise<Response> =>
			authorisedFetch('/policies', init.token, {
				body: JSON.stringify(body),
				headers: { 'content-type': 'application/json' },
				method: 'POST'
			});

		// The cache does not exist yet, so this policy has no identity to name.
		await addPolicy({ scope: 'cache', pattern: 'builds', ttlSeconds: 3600 });
		await addPolicy({
			scope: 'root-name-prefix',
			pattern: 'release/',
			ttlSeconds: 7200
		});

		const beforeCache = await policyIdentityRows();

		await pushPath(
			init.token,
			uploadMetadata({ fileSize: narBytes.byteLength }),
			'builds'
		);

		const afterCache = await policyIdentityRows();

		// The other order: this cache exists before its policy is added, so the
		// insert resolves the identity itself.
		await pushPath(
			init.token,
			uploadMetadata({
				fileSize: narBytes.byteLength,
				storePathHash: repeated('d')
			}),
			'docs'
		);
		await addPolicy({ scope: 'cache', pattern: 'docs', ttlSeconds: 3600 });

		const afterSecondCache = await policyIdentityRows();

		// A deleted cache keeps its policy, so registering the name again binds
		// the policy to the new identity.
		await authorisedFetch('/caches/builds?force=true', init.token, {
			method: 'DELETE'
		});
		await pushPath(
			init.token,
			uploadMetadata({
				fileSize: narBytes.byteLength,
				storePathHash: repeated('f')
			}),
			'builds'
		);

		const prefixPolicy = {
			pattern: 'release/',
			kind: 'root-name-prefix',
			cacheId: undefined,
			rootNamePrefix: 'release/'
		};
		const buildsPolicy = (cacheId: number | undefined) => ({
			pattern: 'builds',
			kind: 'cache',
			cacheId,
			rootNamePrefix: undefined
		});
		const secondCachePolicy = {
			pattern: 'docs',
			kind: 'cache',
			cacheId: 3,
			rootNamePrefix: undefined
		};

		expect({
			beforeCache,
			afterCache,
			afterSecondCache,
			afterRegisteredAgain: await policyIdentityRows()
		}).toStrictEqual({
			beforeCache: [buildsPolicy(undefined), prefixPolicy],
			afterCache: [buildsPolicy(2), prefixPolicy],
			afterSecondCache: [buildsPolicy(2), secondCachePolicy, prefixPolicy],
			afterRegisteredAgain: [buildsPolicy(4), secondCachePolicy, prefixPolicy]
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
					outcome: await instance.reportLocalStep(),
					unlinked: state.storage.sql
						.exec<{ count: number }>(
							'SELECT count(*) AS count FROM narinfo WHERE cache_id IS NULL'
						)
						.one().count
				}))
			);
		}
		expect(pages).toStrictEqual([
			{ outcome: { kind: 'incomplete', projected: 36 }, unlinked: 40 },
			{ outcome: { kind: 'incomplete', projected: 36 }, unlinked: 8 },
			{ outcome: { kind: 'incomplete', projected: 36 }, unlinked: 0 },
			{ outcome: { kind: 'recorded', step: 1 }, unlinked: 0 }
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
				const outcome = await instance.reportLocalStep();
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
			outcome: { kind: 'recorded', step: 1 },
			unlinked: 0
		});
	});

	it('creates the identity of a cache registered without one', async () => {
		await useTestServer('cache-admin-identity-reconcile');

		const init = await bootstrap();

		await pushPath(
			init.token,
			uploadMetadata({ fileSize: narBytes.byteLength }),
			'builds'
		);

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

		await runInDurableObject(currentServer(), (instance) =>
			instance.reportLocalStep()
		);

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
			releasesRow: releasesRow === undefined ? undefined : withId(releasesRow)
		}).toStrictEqual({
			identities: [
				defaultIdentity,
				{
					id: 2,
					scope: { kind: 'named', name: 'builds' },
					access: 'public',
					priority: 40,
					deleted: false
				},
				{
					id: 3,
					scope: { kind: 'named', name: 'releases' },
					access: 'private',
					priority: 40,
					deleted: false
				}
			],
			releasesRow: { cache: 'private/releases', cacheId: 3 }
		});
	});

	it('creates no identity for a cache row its deleted identity outlives', async () => {
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
						name: cacheNameSchema.parse('releases'),
						priority,
						createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z')
					},
					{
						name: cacheNameSchema.parse('guides'),
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

		await runInDurableObject(currentServer(), (instance) =>
			instance.reportLocalStep()
		);

		const guidesIdentity = {
			scope: { kind: 'named', name: 'guides' },
			access: 'public',
			priority: 40
		};

		expect(await cacheIdentities()).toStrictEqual([
			defaultIdentity,
			{
				id: 2,
				scope: { kind: 'named', name: 'releases' },
				access: 'public',
				priority: 40,
				deleted: true
			},
			{ ...guidesIdentity, id: 3, deleted: true },
			{ ...guidesIdentity, id: 4, deleted: false }
		]);
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
