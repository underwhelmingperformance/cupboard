import {
	type CacheAccessMode,
	cacheGenerationSchema,
	cachePrioritySchema,
	cacheReadRevisionSchema,
	type CacheScope,
	cacheScopeSchema,
	rootNameSchema,
	sha256HexDigestSchema,
	storePathHashSchema,
	ttlSecondsSchema
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
	expansionLocalStep,
	type LocalStep
} from '@cupboard/protocol/deployment';
import { isoTimestamp, isoTimestampSchema } from '@cupboard/protocol/scalars';
import { tenantReadCredentialSchema } from '@cupboard/protocol/tenants';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { setCacheReadCredential } from '../control/tenant-registry.ts';
import { type CacheId, cacheScopeFromRow } from '../db/cache.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { narInfoObjectKey, requestOriginSchema } from '../http/http.ts';
import { advanceCacheRetentionMigration } from '../migration/cache-retention.ts';
import { canonicalCacheRequest } from '../routing/cache-request.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	asOneInvocation,
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
	migrateThrough,
	migrateThroughConvertedCatalogue,
	migrationIndexNamed,
	namedCache,
	narBytes,
	narHash,
	negotiateUploads,
	pushPath,
	putNarBytes,
	recordTransition,
	resetTestServer,
	resolvedCache,
	testPushId,
	testServerFor,
	uploadMetadata,
	uploadPathNegotiation,
	useTestServer,
	withoutAlarmArming
} from '../test-support.ts';

import { teardownEntryPrefix } from './cache-admin-service.ts';
import { maxCachesProjectedPerRun } from './cache-lifecycle-projection.ts';
import { type LocalStepOutcome, recordLocalStep } from './local-step.ts';

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
): Promise<{ cacheId: CacheId }[]> {
	return runInDurableObject(currentServer(), async (instance) => {
		await instance.runCacheTeardown(cache, origin);
		return instance.context.db
			.select({ cacheId: schema.narInfoDeletions.cacheId })
			.from(schema.narInfoDeletions)
			.orderBy(
				schema.narInfoDeletions.cacheId,
				schema.narInfoDeletions.storePathHash
			)
			.all();
	});
}

async function policyIdentityRows(): Promise<
	{
		kind: string | undefined;
		cacheId: CacheId | undefined;
		rootNamePrefix: string | undefined;
	}[]
> {
	const rows = await runInDurableObject(currentServer(), (instance) =>
		instance.context.db
			.select({
				kind: schema.legacyRetentionPolicies.kind,
				cacheId: schema.legacyRetentionPolicies.cacheId,
				rootNamePrefix: schema.legacyRetentionPolicies.rootNamePrefix
			})
			.from(schema.legacyRetentionPolicies)
			.orderBy(schema.legacyRetentionPolicies.id)
			.all()
	);

	return rows.map((row) => ({
		kind: row.kind,
		cacheId: row.cacheId ?? undefined,
		rootNamePrefix: row.rootNamePrefix ?? undefined
	}));
}

// The wake's continuation on the alarm is not armed, so each call runs
// exactly one page.
function wake(): Promise<LocalStepOutcome> {
	return withoutAlarmArming(() =>
		runInDurableObject(currentServer(), (instance) =>
			instance.reportLocalStep(expansionLocalStep)
		)
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
const origin = requestOriginSchema.parse('https://cache.example');

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

// With no object families to move, one cycle is a projection page that leaves
// work to do and a page that records the step.
function recordingCycle(isProgressing: boolean, isRaising: boolean) {
	return [
		['incomplete', isProgressing],
		['recorded', isRaising]
	];
}

// Runs pages towards `requested`, with no object families to move, until one
// records a step, and returns each page's kind and whether it progressed.
function recordingPages(requested: LocalStep): Promise<unknown[]> {
	return runInDurableObject(currentServer(), (instance) =>
		asOneInvocation(async () => {
			const outcomes: unknown[] = [];

			for (;;) {
				const outcome = await recordLocalStep(
					instance.context,
					[],
					isoTimestamp(new Date()),
					requested
				);
				outcomes.push([
					outcome.kind,
					'progressed' in outcome ? outcome.progressed : undefined
				]);

				if (outcome.kind !== 'incomplete') {
					return outcomes;
				}
			}
		})
	);
}

describe('cache registry admin', () => {
	beforeEach(resetTestServer);

	it.each([
		{
			mode: 'explicit-none',
			path: '/caches/creation-pending',
			body: { access: 'public', priority: 40, grace: { kind: 'none' } }
		},
		{
			mode: 'omitted',
			path: '/caches/creation-pending',
			body: { access: 'public', priority: 40 }
		},
		{
			mode: 'implicit-root',
			path: '/cache/creation-pending/roots/run',
			body: { targets: [], retention: { kind: 'permanent' } }
		}
	])(
		'defers new $mode caches until legacy grace import finishes',
		async ({ path, body }) => {
			await withoutAlarmArming(async () => {
				const { token } = await bootstrap();
				await runInDurableObject(currentServer(), (instance) => {
					instance.context.db.run(
						sql`INSERT INTO retention_grace_policy (id, cache_prefix, grace_seconds, created_at) VALUES ('legacy-grace', '', 3600, '2026-01-01T00:00:00.000Z')`
					);
				});
				const request = {
					method: 'PUT',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body)
				};
				const refused = await authorisedFetch(path, token, request);
				const cache = await runInDurableObject(currentServer(), (instance) =>
					instance.context.cacheRepository.resolve(
						namedCache('creation-pending')
					)
				);
				expect({
					status: refused.status,
					body: await refused.json(),
					cache
				}).toStrictEqual({
					status: StatusCodes.CONFLICT,
					body: {
						defined: true,
						code: 'CACHE_RETENTION_MIGRATION_PENDING',
						status: StatusCodes.CONFLICT,
						message:
							"The cache's retention is still being migrated; retry after the tenant has completed its local step"
					},
					cache: undefined
				});
				await runInDurableObject(currentServer(), (instance) =>
					advanceCacheRetentionMigration(instance.context.db)
				);
				const retried = await authorisedFetch(path, token, request);
				const after = await authorisedFetch('/caches/creation-pending', token);
				expect({
					status: retried.status,
					grace: cacheSummarySchema.parse(await after.json()).grace
				}).toStrictEqual({ status: StatusCodes.OK, grace: { kind: 'none' } });
			});
		}
	);

	it.each(['/uploads', '/attestations/bundles', '/attestations'])(
		'declares the migration refusal for implicit cache creation through %s',
		async (suffix) => {
			await withoutAlarmArming(async () => {
				const { token } = await bootstrap();
				await runInDurableObject(currentServer(), (instance) => {
					instance.context.db.run(
						sql`INSERT INTO retention_grace_policy (id, cache_prefix, grace_seconds, created_at) VALUES ('legacy-grace', '', 3600, '2026-01-01T00:00:00.000Z')`
					);
				});
				const metadata = uploadMetadata({ fileSize: 128 });
				const digest = 'a'.repeat(64);
				const body =
					suffix === '/uploads'
						? { pushId: testPushId, paths: [uploadPathNegotiation(metadata)] }
						: {
								pushId: testPushId,
								bundles: [
									suffix === '/attestations'
										? { storePathHash: metadata.storePathHash, digest }
										: { digest }
								]
							};
				const scope = namedCache('creation-pending');
				const response = await authorisedFetch(
					`/cache/${scope.name}${suffix}`,
					token,
					{
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(body)
					}
				);
				const cache = await runInDurableObject(currentServer(), (instance) =>
					instance.context.cacheRepository.resolve(scope)
				);
				const expected = {
					status: StatusCodes.CONFLICT,
					body: {
						defined: true,
						code: 'CACHE_RETENTION_MIGRATION_PENDING',
						status: StatusCodes.CONFLICT,
						message:
							"The cache's retention is still being migrated; retry after the tenant has completed its local step"
					},
					cache: undefined
				};
				expect({
					status: response.status,
					body: await response.json(),
					cache
				}).toStrictEqual(expected);
			});
		}
	);

	it.each([0, 86_400])(
		'applies creation grace %s to explicit and implicit new caches only',
		async (graceSeconds) => {
			await useTestServer(`cache-creation-default-${String(graceSeconds)}`);
			const init = await bootstrap();
			const existing = await putCache(init.token, 'existing', 30);
			const updated = await authorisedFetch('/cache-defaults', init.token, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ grace: { kind: 'duration', graceSeconds } })
			});
			expect(updated.status).toBe(StatusCodes.OK);
			const explicit = await putCache(init.token, 'explicit', 30);
			const root = await authorisedFetch('/cache/pr-42/roots/run', init.token, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					targets: [],
					retention: { kind: 'duration', seconds: 60 }
				})
			});
			expect(root.status).toBe(StatusCodes.OK);
			const implicit = await authorisedFetch('/caches/pr-42', init.token);
			const unchanged = await authorisedFetch('/caches/existing', init.token);
			const defaults = await authorisedFetch('/cache-defaults', init.token);
			const caches = await listCaches(init.token);
			expect({
				defaults: await defaults.json(),
				explicit: explicit.grace,
				implicit: cacheSummarySchema.parse(await implicit.json()).grace,
				unchanged: cacheSummarySchema.parse(await unchanged.json()),
				defaultCache: caches.caches[0]?.grace
			}).toStrictEqual({
				defaults: { grace: { kind: 'duration', graceSeconds } },
				explicit: { kind: 'duration', graceSeconds },
				implicit: { kind: 'duration', graceSeconds },
				unchanged: existing,
				defaultCache: { kind: 'none' }
			});
		}
	);

	it.each([
		{ kind: 'none' },
		{ kind: 'duration', graceSeconds: 0 },
		{ kind: 'duration', graceSeconds: 60 }
	])('preserves an explicit creation grace override %j', async (grace) => {
		await useTestServer(
			`cache-creation-override-${grace.kind}-${'graceSeconds' in grace ? String(grace.graceSeconds) : 'none'}`
		);
		const init = await bootstrap();
		const configured = await authorisedFetch('/cache-defaults', init.token, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				grace: { kind: 'duration', graceSeconds: 86_400 }
			})
		});
		expect(configured.status).toBe(StatusCodes.OK);
		const response = await authorisedFetch('/caches/overridden', init.token, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ access: 'public', priority: 40, grace })
		});
		expect({
			status: response.status,
			grace: cacheSummarySchema.parse(await response.json()).grace
		}).toStrictEqual({ status: StatusCodes.OK, grace });
	});

	it('clears creation defaults without rewriting existing caches', async () => {
		await useTestServer('cache-creation-default-clear');
		const init = await bootstrap();
		const set = (grace: object) =>
			authorisedFetch('/cache-defaults', init.token, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ grace })
			});
		const configured = await set({ kind: 'duration', graceSeconds: 3600 });
		expect(configured.status).toBe(StatusCodes.OK);
		const previous = await putCache(init.token, 'previous', 30);
		const cleared = await set({ kind: 'none' });
		const next = await putCache(init.token, 'next', 30);
		const unchanged = await authorisedFetch('/caches/previous', init.token);
		expect({
			cleared: { status: cleared.status, defaults: await cleared.json() },
			next: next.grace,
			previous: cacheSummarySchema.parse(await unchanged.json())
		}).toStrictEqual({
			cleared: {
				status: StatusCodes.OK,
				defaults: { grace: { kind: 'none' } }
			},
			next: { kind: 'none' },
			previous
		});
	});

	it('requires tenant-domain authority for cache creation defaults', async () => {
		await useTestServer('cache-creation-default-authority');
		const init = await bootstrap();
		const scoped = await issueServerSignedToken([
			{
				type: 'cupboard_cache',
				actions: ['cache:read', 'cache:update'],
				cache: namedCache('pr-42')
			}
		]);
		const reader = await issueServerSignedToken([
			{ type: 'cupboard_domain', actions: ['cache:defaults-read'] }
		]);
		const updater = await issueServerSignedToken([
			{ type: 'cupboard_domain', actions: ['cache:defaults-update'] }
		]);
		const update = (token: string) =>
			authorisedFetch('/cache-defaults', token, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					grace: { kind: 'duration', graceSeconds: 3600 }
				})
			});
		const scopedRead = await authorisedFetch('/cache-defaults', scoped);
		const scopedWrite = await update(scoped);
		const allowedRead = await authorisedFetch('/cache-defaults', reader);
		const refusedWrite = await update(reader);
		const allowedWrite = await update(updater);
		const refusedRead = await authorisedFetch('/cache-defaults', updater);
		const final = await authorisedFetch('/cache-defaults', init.token);
		expect({
			scopedRead: scopedRead.status,
			scopedWrite: scopedWrite.status,
			allowedRead: {
				status: allowedRead.status,
				defaults: await allowedRead.json()
			},
			refusedWrite: refusedWrite.status,
			allowedWrite: {
				status: allowedWrite.status,
				defaults: await allowedWrite.json()
			},
			refusedRead: refusedRead.status,
			final: await final.json()
		}).toStrictEqual({
			scopedRead: StatusCodes.FORBIDDEN,
			scopedWrite: StatusCodes.FORBIDDEN,
			allowedRead: {
				status: StatusCodes.OK,
				defaults: { grace: { kind: 'none' } }
			},
			refusedWrite: StatusCodes.FORBIDDEN,
			allowedWrite: {
				status: StatusCodes.OK,
				defaults: { grace: { kind: 'duration', graceSeconds: 3600 } }
			},
			refusedRead: StatusCodes.FORBIDDEN,
			final: { grace: { kind: 'duration', graceSeconds: 3600 } }
		});
	});

	it('checks the current cache after waiting to delete it', async () => {
		await useTestServer('cache-admin-delete-incarnation');
		const init = await bootstrap();
		await putCache(init.token, 'builds', 30);
		await pushPath(
			init.token,
			uploadMetadata({ fileSize: narBytes.byteLength }),
			defaultCache()
		);

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
			const gate = vi.spyOn(instance.context, 'criticalSection');
			gate.mockImplementationOnce(async (run) => {
				gate.mockRestore();
				const previous = instance.context.db
					.select()
					.from(schema.narInfos)
					.get();
				if (previous === undefined) {
					throw new Error('missing source narinfo');
				}
				const removed = await instance.fetch(
					new Request('https://cupboard.test/caches/builds?force=true', {
						method: 'DELETE',
						headers: { authorization: `Bearer ${init.token}` }
					})
				);
				const created = await instance.fetch(
					request('PUT', { access: 'private', priority: 30 })
				);
				const replacement =
					instance.context.cacheRepository.require(buildsCache);
				instance.context.db
					.insert(schema.narInfos)
					.values({ ...previous, cacheId: replacement.id })
					.run();
				expect({
					removed: removed.status,
					created: created.status
				}).toStrictEqual({
					removed: StatusCodes.OK,
					created: StatusCodes.OK
				});
				return enter(run);
			});
			try {
				const response = await instance.fetch(request('DELETE'));
				const current = await instance.fetch(request('GET'));
				expect({
					status: response.status,
					cache: cacheSummarySchema.parse(await current.json())
				}).toStrictEqual({
					status: StatusCodes.CONFLICT,
					cache: {
						scope: buildsCache,
						access: 'private',
						priority: 30,
						storePaths: 1,
						defaultRootRetention: { kind: 'permanent' },
						grace: { kind: 'none' },
						rootRetentionOverrides: [],
						graceManaged: false
					}
				});
			} finally {
				gate.mockRestore();
			}
		});
	});

	it('checks the current incarnation after waiting to update cache access', async () => {
		await useTestServer('cache-admin-access-incarnation');
		await recordTransition('cache-identity', 'expanded');
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
				defaultRootRetention: { kind: 'permanent' },
				grace: { kind: 'none' },
				graceManaged: false
			},
			{
				scope: buildsCache,
				access: 'public',
				priority: 30,
				storePaths: 1,
				defaultRootRetention: { kind: 'permanent' },
				grace: { kind: 'none' },
				graceManaged: false
			}
		]);
	});

	it('pages registered caches and filters named caches by prefix', async () => {
		await useTestServer('cache-admin-list-pages');
		const init = await bootstrap();
		await putCache(init.token, 'pr-1', 30);
		await putCache(init.token, 'builds', 30);
		await putCache(init.token, 'pr-2', 30);

		const first = await authorisedFetch('/caches?limit=2', init.token);
		const firstPage = cacheListResponseSchema.parse(await first.json());
		const second = await authorisedFetch(
			`/caches?limit=2&cursor=${firstPage.cursor ?? ''}`,
			init.token
		);
		const secondPage = cacheListResponseSchema.parse(await second.json());
		const prefixed = await authorisedFetch(
			'/caches?namePrefix=pr-&limit=1',
			init.token
		);
		const firstPrefixPage = cacheListResponseSchema.parse(
			await prefixed.json()
		);
		const continued = await authorisedFetch(
			`/caches?namePrefix=pr-&limit=1&cursor=${firstPrefixPage.cursor ?? ''}`,
			init.token
		);
		const secondPrefixPage = cacheListResponseSchema.parse(
			await continued.json()
		);
		const invalidCursor = await authorisedFetch(
			'/caches?cursor=pr-1',
			init.token
		);

		expect({
			statuses: [
				first.status,
				second.status,
				prefixed.status,
				continued.status,
				invalidCursor.status
			],
			all: [firstPage, secondPage].map((page) =>
				page.caches.map((cache) => cache.scope)
			),
			prefix: [firstPrefixPage, secondPrefixPage].map((page) =>
				page.caches.map((cache) => cache.scope)
			),
			cursors: [
				firstPage.cursor,
				secondPage.cursor,
				firstPrefixPage.cursor,
				secondPrefixPage.cursor
			]
		}).toStrictEqual({
			statuses: [200, 200, 200, 200, 400],
			all: [
				[defaultCache(), namedCache('pr-1')],
				[namedCache('builds'), namedCache('pr-2')]
			],
			prefix: [[namedCache('pr-1')], [namedCache('pr-2')]],
			cursors: ['2', undefined, 'pr-1', undefined]
		});
	});

	it('asks cache-list clients to retry while the listing projection is incomplete', async () => {
		await useTestServer('cache-admin-list-pending');
		const init = await bootstrap();
		await runInDurableObject(currentServer(), (_instance, state) => {
			state.storage.sql.exec(
				'UPDATE cache_listing_projection_migration SET narinfo_complete = 0'
			);
		});

		const response = await authorisedFetch('/caches', init.token);

		const body = z.object({ code: z.string() }).parse(await response.json());

		expect({ status: response.status, body }).toStrictEqual({
			status: StatusCodes.SERVICE_UNAVAILABLE,
			body: { code: 'CACHE_LISTING_PROJECTION_PENDING' }
		});
	});

	it('reports an existing cache when creation specifies different access', async () => {
		await useTestServer('cache-admin-existing-view-access');
		const init = await bootstrap();
		await putCache(init.token, 'existing-pr', 30, 'private');
		await putReuseView(init.token, 'existing-view', 'private', 'existing-');

		const response = await authorisedFetch('/caches/existing-pr', init.token, {
			body: JSON.stringify({ access: 'public', priority: 30 }),
			headers: { 'content-type': 'application/json' },
			method: 'PUT'
		});
		const body = await response.json();
		expect({
			status: response.status,
			body: z
				.object({
					code: z.string(),
					data: z.object({ cache: cacheScopeSchema })
				})
				.parse(body)
		}).toStrictEqual({
			status: StatusCodes.CONFLICT,
			body: {
				code: 'CACHE_ALREADY_EXISTS',
				data: { cache: { kind: 'named', name: 'existing-pr' } }
			}
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
				graceManaged: false
			},
			{
				scope: buildsCache,
				access: 'public',
				priority: 30,
				storePaths: 0,
				defaultRootRetention: { kind: 'permanent' },
				grace: { kind: 'none' },
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
					readonly overrideArrays: number;
				}> => {
					select.mockClear();
					const response = await instance.fetch(cacheListRequest(init.token));
					const body = cacheListResponseSchema.parse(await response.json());

					return {
						calls: select.mock.calls.length,
						caches: body.caches.length,
						overrideArrays: body.caches.filter(
							(cache) => cache.rootRetentionOverrides !== undefined
						).length
					};
				};

				try {
					const one = await measure();

					for (let index = 0; index < 20; index += 1) {
						const ruleSetId = instance.context.db
							.insert(schema.rootRetentionRuleSets)
							.values({
								contentHash: sha256HexDigestSchema.parse('a'.repeat(64))
							})
							.returning({ id: schema.rootRetentionRuleSets.id })
							.get().id;
						instance.context.db
							.insert(schema.rootRetentionRules)
							.values({
								ruleSetId,
								rootPrefix: rootNameSchema.parse(`root-${String(index)}`),
								kind: 'permanent'
							})
							.run();
						instance.context.db
							.insert(schema.cacheIdentities)
							.values({
								kind: 'named',
								name: namedCache(`cache-${String(index).padStart(2, '0')}`)
									.name,
								access: 'public',
								priority: cachePrioritySchema.parse(40),
								rootRetentionRuleSetId: ruleSetId,
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
			one: observed.one,
			many: observed.many
		}).toStrictEqual({
			one: { calls: observed.one.calls, caches: 1, overrideArrays: 0 },
			many: { calls: observed.one.calls, caches: 21, overrideArrays: 0 }
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
			narInfoDeletions: [{ cacheId: 2 }]
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
			identities: await cacheIdentities()
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
				identities: await cacheIdentities()
			}
		}).toStrictEqual({
			failed: StatusCodes.INTERNAL_SERVER_ERROR,
			afterFailure: {
				identities: [defaultIdentity, { ...builds, deleted: false }]
			},
			removed: StatusCodes.OK,
			afterRemoval: {
				identities: [defaultIdentity, { ...builds, deleted: true }]
			}
		});
	});

	it('keeps lifecycle and local identity live when D1 revocation fails', async () => {
		await useTestServer('cache-admin-atomic-revocation-failure');
		const init = await bootstrap();
		await putCache(init.token, 'builds', 30, 'private');
		const before = await cacheVersions();
		const batch = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockRejectedValueOnce(new Error('D1 unavailable'));

		let failed: Response;
		try {
			failed = await authorisedFetch('/caches/builds', init.token, {
				method: 'DELETE'
			});
		} finally {
			batch.mockRestore();
		}

		expect({
			status: failed.status,
			before,
			after: await cacheVersions()
		}).toStrictEqual({
			status: StatusCodes.INTERNAL_SERVER_ERROR,
			before,
			after: before
		});
	});

	it('finishes a committed revocation after its D1 response is lost without deleting a new credential', async () => {
		await useTestServer('cache-admin-lost-revocation-response');
		const init = await bootstrap();
		await putCache(init.token, 'builds', 30, 'private');
		const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
		const credential = tenantReadCredentialSchema.parse({
			user: 'reader',
			password: 'wRt2Qm7kZ9x1Yb4Nc6Vd8Fg0Hj3Kl5Mn7Pq9Rs1Tu23'
		});
		const now = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');
		await setCacheReadCredential(
			database,
			fixtureTenant,
			buildsCache,
			credential,
			now
		);
		const originalBatch = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const batch = vi.spyOn(env.CUPBOARD_DB, 'batch');
		batch.mockImplementationOnce(async (statements) => {
			await originalBatch(statements);
			throw new Error('D1 response lost');
		});

		let failed: Response;
		try {
			failed = await authorisedFetch('/caches/builds', init.token, {
				method: 'DELETE'
			});
		} finally {
			batch.mockRestore();
		}

		const afterLostResponse = await cacheVersions();
		await setCacheReadCredential(
			database,
			fixtureTenant,
			buildsCache,
			credential,
			now
		);
		const replacement = await database
			.select()
			.from(d1Schema.tenantCacheReadCredential)
			.get();
		const retried = await authorisedFetch('/caches/builds', init.token, {
			method: 'DELETE'
		});
		const afterRetry = await cacheVersions();
		const retained = await database
			.select()
			.from(d1Schema.tenantCacheReadCredential)
			.get();

		expect({
			failed: failed.status,
			afterLostResponse,
			retried: retried.status,
			afterRetry,
			retained
		}).toStrictEqual({
			failed: StatusCodes.INTERNAL_SERVER_ERROR,
			afterLostResponse: {
				local: { generation: 1 },
				published: { generation: 2, readRevision: 2 }
			},
			retried: StatusCodes.OK,
			afterRetry: {
				local: undefined,
				published: { generation: 2, readRevision: 2 }
			},
			retained: replacement
		});
	});

	it('removes the policies scoped to a cache it tears down', async () => {
		await useTestServer('cache-admin-teardown-policies');

		const init = await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		await putCache(init.token, 'builds', 40);
		await pushPath(init.token, metadata);
		await runInDurableObject(currentServer(), (instance) => {
			const cache = instance.context.cacheRepository.require(buildsCache);
			const createdAt = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');
			instance.context.db
				.insert(schema.legacyRetentionPolicies)
				.values([
					{
						id: 'cache-policy',

						kind: 'cache',
						cacheId: cache.id,
						defaultTtlSeconds: ttlSecondsSchema.parse(3600),
						createdAt
					},
					{
						id: 'prefix-policy',

						kind: 'root-name-prefix',
						rootNamePrefix: 'release/',
						defaultTtlSeconds: ttlSecondsSchema.parse(7200),
						createdAt
					}
				])
				.run();
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
					kind: 'root-name-prefix',
					cacheId: undefined,
					rootNamePrefix: 'release/'
				}
			],
			set: StatusCodes.OK
		});
	});

	it('creates an identity for a registration made after the expansion', async () => {
		const result = await runInDurableObject(
			testServerFor('contract-late-registration'),
			async (_instance, state) => {
				await migrateThrough(
					state,
					migrationIndexNamed('0050_cache_registration_reconcile') - 1
				);
				state.storage.sql.exec(
					"INSERT INTO cache (name, priority, created_at) VALUES ('private/releases', 40, '2026-01-01T00:00:00.000Z')"
				);
				state.storage.sql.exec(
					"INSERT INTO narinfo (cache, store_path_hash, store_path, nar_hash, nar_size, references_json, created_at) VALUES (?, ?, ?, ?, ?, '[]', '2026-01-01T00:00:00.000Z')",
					'private/releases',
					repeated('b'),
					`/nix/store/${repeated('b')}-old`,
					narHash,
					narBytes.byteLength
				);
				await migrateThroughConvertedCatalogue(state);
				return state.storage.sql
					.exec(
						'SELECT cache_identity.kind, cache_identity.name, cache_identity.access, narinfo.store_path_hash FROM narinfo JOIN cache_identity ON cache_identity.id = narinfo.cache_id'
					)
					.toArray();
			}
		);
		expect(result).toStrictEqual([
			{
				kind: 'named',
				name: 'releases',
				access: 'private',
				store_path_hash: repeated('b')
			}
		]);
	});

	it('distinguishes an old registration from one made after its identity was deleted', async () => {
		const result = await runInDurableObject(
			testServerFor('contract-deleted-registration'),
			async (_instance, state) => {
				await migrateThrough(
					state,
					migrationIndexNamed('0050_cache_registration_reconcile') - 1
				);
				state.storage.sql.exec(
					"INSERT INTO cache (name, priority, created_at) VALUES ('releases', 40, '2026-01-01T00:00:00.000Z'), ('guides', 40, '2026-01-03T00:00:00.000Z')"
				);
				state.storage.sql.exec(
					"INSERT INTO cache_identity (kind, name, access, priority, created_at, deleted_at) VALUES ('named', 'releases', 'public', 40, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'), ('named', 'guides', 'public', 40, '2025-12-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')"
				);
				await migrateThroughConvertedCatalogue(state);
				return state.storage.sql
					.exec(
						"SELECT name, access, deleted_at IS NOT NULL AS deleted FROM cache_identity WHERE kind = 'named' ORDER BY id"
					)
					.toArray();
			}
		);
		expect(result).toStrictEqual([
			{ name: 'releases', access: 'public', deleted: 1 },
			{ name: 'guides', access: 'public', deleted: 1 },
			{ name: 'guides', access: 'public', deleted: 0 }
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
				kind: d1Schema.cacheLifecycle.cacheKind,
				name: d1Schema.cacheLifecycle.cacheName,
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

		expect(row).toStrictEqual({
			kind: 'named',
			name: 'builds',
			access: 'private'
		});
	});

	it('finishes projection and object inspection over bounded wakes', async () => {
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
		for (let index = 0; index < 4; index++) {
			const outcome = await wake();
			outcomes.push({ kind: outcome.kind, projected: await projectedCaches() });
		}
		expect(outcomes).toStrictEqual([
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
		expect(await wake()).toStrictEqual({
			kind: 'incomplete',
			projected: 0,
			progressed: true
		});
	});

	// Every stage starts again after a step is recorded. Once a page records the
	// step that the tenant already had, the restarted stages save their cursors
	// without projecting or moving anything, and those pages are not progress
	// while the requested step is not higher. A wake does not run such pages,
	// because it finds the step recorded, so the test runs the pages directly.
	it('reports no progress from the stages that restart after a repeated recording', async () => {
		await useTestServer('cache-admin-repeated-recording');
		const init = await bootstrap();
		for (let index = 0; index < maxCachesProjectedPerRun + 5; index++) {
			await putCache(init.token, `cache-${String(index).padStart(3, '0')}`, 40);
		}

		// The first recording raises the step, so the cycle after it still
		// counts its cursors. The second recording repeats step 4, so a third
		// cycle towards step 4 is not progress, and a cycle towards step 5 is.
		expect([
			await recordingPages(expansionLocalStep),
			await recordingPages(expansionLocalStep),
			await recordingPages(expansionLocalStep),
			await recordingPages(currentLocalStep)
		]).toStrictEqual([
			recordingCycle(true, true),
			recordingCycle(true, false),
			recordingCycle(false, false),
			recordingCycle(true, false)
		]);
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

	it('bumps the read revision when a cache changes access', async () => {
		await useTestServer('cache-admin-access-revision');
		await recordTransition('cache-identity', 'complete');

		const init = await bootstrap();

		await putCache(init.token, 'builds', 30);

		const before = await cacheVersions();

		await updateCacheAccess(init.token, 'builds', 'private');

		const after = await cacheVersions();
		const narInfo = new Request('https://cache.example/t/acme/abc.narinfo');
		const cacheKey = (version: CacheVersion): string =>
			canonicalCacheRequest(narInfo, {
				generation: cacheGenerationSchema.parse(version.generation),
				readRevision: cacheReadRevisionSchema.parse(version.readRevision)
			}).url;

		expect({
			before,
			after,
			keyMoved:
				before.published === undefined || after.published === undefined
					? 'a version was missing'
					: cacheKey(before.published) !== cacheKey(after.published)
		}).toStrictEqual({
			before: {
				local: { generation: 1 },
				published: { generation: 1, readRevision: 1 }
			},
			after: {
				local: { generation: 1 },
				published: { generation: 1, readRevision: 2 }
			},
			keyMoved: true
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
