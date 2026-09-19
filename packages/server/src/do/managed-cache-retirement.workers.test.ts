import { startCapture } from '@cupboard/logger/testing';
import {
	cacheGenerationSchema,
	type CacheScope,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { requestOriginSchema } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	authorisedFetch,
	bootstrap,
	currentServer,
	migrateThroughConvertedCatalogue,
	namedCache,
	narBytes,
	negotiateUploads,
	negotiateViaInstance,
	pushPath,
	resetTestServer,
	uploadMetadata,
	useTestServer,
	withoutAlarmArming
} from '../test-support.ts';

import {
	managedRetirementEntryPrefix,
	teardownEntryPrefix
} from './cache-admin-service.ts';
import { MaintenanceEligibilityService } from './maintenance-eligibility-service.ts';
import { ReconcileQueueService } from './reconcile-queue-service.ts';
import { maintenancePassCursorKey } from './server.ts';
import { UploadStateService } from './upload-state-service.ts';

const managedCache = namedCache('pr-1');
const secondManagedCache = namedCache('pr-2');
const origin = requestOriginSchema.parse('https://cache.example');
const expiredDeadline = '2025-12-31T23:59:59.000Z';
const eligibilityBlockers = [
	{
		name: 'live grace',
		statement: `INSERT INTO retention_grace
			(cache_id, store_path_hash, retain_until)
			VALUES (?, '${'a'.repeat(32)}', '2099-01-01T00:00:00.000Z')`
	},
	{
		name: 'pending attestation',
		statement: `INSERT INTO pending_attestation
			(id, cache_id, store_path_hash, digest, r2_key, created_at, expires_at)
			VALUES ('retirement-attestation', ?, '${'a'.repeat(32)}',
				'${'b'.repeat(64)}', 'staging/retirement-attestation',
				'2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')`
	},
	{
		name: 'verification cursor',
		statement: `INSERT INTO verification_cursor
			(id, cache_id, last_store_path_hash, updated_at)
			VALUES ('retirement-verification', ?, NULL, '2026-01-01T00:00:00.000Z')`
	},
	{
		name: 'deletion queue',
		statement: `INSERT INTO narinfo_deletion
			(cache_id, store_path_hash, nar_hash, generation, created_at)
			VALUES (?, '${'a'.repeat(32)}', 'sha256:${'0'.repeat(52)}', 1,
				'2026-01-01T00:00:00.000Z')`
	},
	{
		name: 'collection scan',
		statement: `INSERT INTO garbage_collection_scan
			(cache_id, phase, cursor, reference_cursor, allow_empty_collection)
			VALUES (?, 'collect', '', -1, 0)`
	},
	{
		name: 'collection frontier',
		statement: `INSERT INTO garbage_collection_frontier
			(cache_id, store_path_hash) VALUES (?, '${'a'.repeat(32)}')`
	},
	{
		name: 'collection mark',
		statement: `INSERT INTO garbage_collection_mark
			(cache_id, store_path_hash) VALUES (?, '${'a'.repeat(32)}')`
	},
	{
		name: 'tenant collection cursor',
		statement: `INSERT INTO garbage_collection_tenant_run (id, cache_id)
			VALUES (1, ?)`
	}
] as const;

function putManagedCache(
	token: string,
	cache: Extract<CacheScope, { kind: 'named' }> = managedCache
): Promise<Response> {
	return authorisedFetch(`/caches/${cache.name}`, token, {
		body: JSON.stringify({
			access: 'public',
			priority: 30,
			defaultRootRetention: { kind: 'duration', seconds: 60 }
		}),
		headers: { 'content-type': 'application/json' },
		method: 'PUT'
	});
}

async function createManagedCache(
	serverName: string,
	shouldMarkForRetirement = true
): Promise<string> {
	await useTestServer(serverName);
	await runInDurableObject(currentServer(), async (_instance, state) => {
		await migrateThroughConvertedCatalogue(state);
	});
	const { token } = await bootstrap();
	const created = await putManagedCache(token);

	expect(created.status).toBe(StatusCodes.OK);

	if (!shouldMarkForRetirement) {
		return token;
	}

	const marked = await authorisedFetch('/caches/pr-1/retirement', token, {
		body: JSON.stringify({ retireWhenEmpty: true }),
		headers: { 'content-type': 'application/json' },
		method: 'PUT'
	});

	expect(marked.status).toBe(StatusCodes.OK);

	return token;
}

async function addManagedCache(
	token: string,
	cache: Extract<CacheScope, { kind: 'named' }>
): Promise<void> {
	const created = await putManagedCache(token, cache);

	expect(created.status).toBe(StatusCodes.OK);

	const marked = await authorisedFetch(
		`/caches/${cache.name}/retirement`,
		token,
		{
			body: JSON.stringify({ retireWhenEmpty: true }),
			headers: { 'content-type': 'application/json' },
			method: 'PUT'
		}
	);

	expect(marked.status).toBe(StatusCodes.OK);
}

async function makeRetirementDue(
	scope: CacheScope = managedCache
): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		const cache = instance.context.cacheRepository.require(scope);

		instance.context.db
			.update(schema.managedCacheRetirements)
			.set({
				eligibleAfter: isoTimestamp(new Date(expiredDeadline)),
				nextCheckAt: isoTimestamp(new Date(expiredDeadline))
			})
			.where(eq(schema.managedCacheRetirements.cacheId, cache.id))
			.run();
	});
}

async function scheduleRetirement(): Promise<void> {
	await withoutAlarmArming(() => currentServer().runGarbageCollection());
}

function runAlarm(): Promise<void> {
	return runInDurableObject(currentServer(), (instance) => instance.alarm());
}

async function driveRetirementPasses(): Promise<void> {
	await withoutAlarmArming(async () => {
		await runAlarm();
		await runAlarm();
	});
}

async function retirementClaims(): Promise<readonly unknown[]> {
	return runInDurableObject(currentServer(), async (_instance, state) => {
		const entries = await state.storage.list({
			prefix: managedRetirementEntryPrefix
		});

		return entries.values().toArray();
	});
}

async function maintenanceWakeAt(): Promise<string | null | undefined> {
	const row = await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
		.select({ nextWakeAt: d1Schema.tenantMaintenanceEligibility.nextWakeAt })
		.from(d1Schema.tenantMaintenanceEligibility)
		.where(eq(d1Schema.tenantMaintenanceEligibility.tenant, fixtureTenant))
		.get();

	return row?.nextWakeAt;
}

async function teardownKeys(): Promise<readonly string[]> {
	return runInDurableObject(currentServer(), async (_instance, state) => {
		const entries = await state.storage.list({ prefix: teardownEntryPrefix });

		return entries.keys().toArray();
	});
}

async function stageRetirementClaim(
	scope: CacheScope = managedCache
): Promise<void> {
	await runInDurableObject(currentServer(), async (instance, state) => {
		const cache = instance.context.cacheRepository.require(scope);

		await state.storage.put(
			`${managedRetirementEntryPrefix}${String(cache.id)}`,
			{
				cacheId: cache.id,
				scope: cache.scope,
				generation: cache.generation
			}
		);
	});
}

async function maintenancePass(): Promise<string | undefined> {
	return runInDurableObject(currentServer(), (_instance, state) =>
		state.storage.get<string>(maintenancePassCursorKey)
	);
}

async function retirementState(): Promise<{
	readonly local: readonly {
		readonly id: number;
		readonly generation: number;
		readonly deleted: boolean;
	}[];
	readonly managedIds: readonly number[];
	readonly lifecycle:
		{ readonly generation: number; readonly deleted: boolean } | undefined;
}> {
	const local = await runInDurableObject(currentServer(), (instance) =>
		instance.context.db
			.select({
				id: schema.cacheIdentities.id,
				generation: schema.cacheIdentities.generation,
				deletedAt: schema.cacheIdentities.deletedAt
			})
			.from(schema.cacheIdentities)
			.where(eq(schema.cacheIdentities.name, managedCache.name))
			.orderBy(schema.cacheIdentities.id)
			.all()
	);
	const managedIds = await runInDurableObject(currentServer(), (instance) =>
		instance.context.db
			.select({ id: schema.managedCacheRetirements.cacheId })
			.from(schema.managedCacheRetirements)
			.orderBy(schema.managedCacheRetirements.cacheId)
			.all()
	);
	const lifecycle = await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
		.select({
			generation: d1Schema.cacheLifecycle.generation,
			deletedAt: d1Schema.cacheLifecycle.deletedAt
		})
		.from(d1Schema.cacheLifecycle)
		.where(
			and(
				eq(d1Schema.cacheLifecycle.tenant, fixtureTenant),
				eq(d1Schema.cacheLifecycle.cacheKind, 'named'),
				eq(d1Schema.cacheLifecycle.cacheName, managedCache.name)
			)
		)
		.get();

	return {
		local: local.map((row) => ({
			id: row.id,
			generation: row.generation,
			deleted: row.deletedAt !== null
		})),
		managedIds: managedIds.map((row) => row.id),
		lifecycle:
			lifecycle === undefined
				? undefined
				: {
						generation: cacheGenerationSchema.parse(lifecycle.generation),
						deleted: lifecycle.deletedAt !== null
					}
	};
}

async function isCacheLive(scope: CacheScope = managedCache): Promise<boolean> {
	return runInDurableObject(
		currentServer(),
		(instance) => instance.context.cacheRepository.resolve(scope) !== undefined
	);
}

async function retainedContentState(): Promise<{
	readonly narInfos: number;
	readonly roots: number;
	readonly targets: number;
}> {
	return runInDurableObject(currentServer(), (instance) => {
		const cache = instance.context.cacheRepository.require(managedCache);
		const count = (
			table:
				| typeof schema.narInfos
				| typeof schema.retentionRoots
				| typeof schema.retentionRootTargets
		): number =>
			instance.context.db
				.select({ cacheId: table.cacheId })
				.from(table)
				.where(eq(table.cacheId, cache.id))
				.all().length;

		return {
			narInfos: count(schema.narInfos),
			roots: count(schema.retentionRoots),
			targets: count(schema.retentionRootTargets)
		};
	});
}

async function pendingWorkState(): Promise<{
	readonly uploads: number;
	readonly attestations: number;
	readonly verificationCursors: number;
	readonly deletions: number;
	readonly scans: number;
}> {
	return runInDurableObject(currentServer(), (instance, state) => {
		const cache = instance.context.cacheRepository.require(managedCache);
		const count = (table: string): number =>
			state.storage.sql
				.exec<{ count: number }>(
					`SELECT COUNT(*) AS count FROM ${table} WHERE cache_id = ?`,
					cache.id
				)
				.one().count;

		return {
			uploads: count('pending_upload'),
			attestations: count('pending_attestation'),
			verificationCursors: count('verification_cursor'),
			deletions: count('narinfo_deletion'),
			scans: count('garbage_collection_scan')
		};
	});
}

async function seedEligibilityBlocker(statement: string): Promise<void> {
	await runInDurableObject(currentServer(), (instance, state) => {
		const cache = instance.context.cacheRepository.require(managedCache);
		state.storage.sql.exec(statement, cache.id);
	});
}

describe('managed cache retirement', () => {
	beforeEach(resetTestServer);

	it('finds upload and attestation blockers by cache ID in a large backlog', async () => {
		await createManagedCache('managed-retirement-blocker-plan');
		const plans = await runInDurableObject(
			currentServer(),
			(_instance, state) => {
				state.storage.sql.exec(`
					WITH RECURSIVE seq(n) AS (
						SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 500
					)
					INSERT INTO pending_upload
						(id, cache_id, nar_hash, r2_key, metadata_json, created_at, expires_at)
					SELECT 'upload-' || n, 2, 'sha256:hash', 'staging/' || n,
						'{}', '2026-01-01T00:00:00.000Z',
						'2099-01-01T00:00:00.000Z' FROM seq
				`);
				state.storage.sql.exec(`
					WITH RECURSIVE seq(n) AS (
						SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 500
					)
					INSERT INTO pending_attestation
						(id, cache_id, store_path_hash, digest, r2_key, created_at, expires_at)
					SELECT 'attestation-' || n, 2, printf('%032d', n),
						'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'staging/attestation-' || n,
						'2026-01-01T00:00:00.000Z',
						'2099-01-01T00:00:00.000Z' FROM seq
				`);

				return {
					upload: Array.from(
						state.storage.sql.exec<{ detail: string }>(
							'EXPLAIN QUERY PLAN SELECT 1 FROM pending_upload WHERE cache_id = ? LIMIT 1',
							3
						),
						(row) => row.detail
					),
					attestation: Array.from(
						state.storage.sql.exec<{ detail: string }>(
							'EXPLAIN QUERY PLAN SELECT 1 FROM pending_attestation WHERE cache_id = ? LIMIT 1',
							3
						),
						(row) => row.detail
					)
				};
			}
		);

		expect(plans).toStrictEqual({
			upload: [
				'SEARCH pending_upload USING COVERING INDEX pending_upload_gc_path_idx (cache_id=?)'
			],
			attestation: [
				'SEARCH pending_attestation USING COVERING INDEX pending_attestation_cache_id_idx (cache_id=?)'
			]
		});
	});

	it('retires an opted-in empty cache after its deadline and complete scan', async () => {
		await createManagedCache('managed-retirement-success');
		await makeRetirementDue();

		await withoutAlarmArming(async () => {
			await scheduleRetirement();

			expect({
				isCacheLive: await isCacheLive(),
				claims: await retirementClaims()
			}).toStrictEqual({ isCacheLive: true, claims: [] });

			await runAlarm();

			expect({
				pass: await maintenancePass(),
				isCacheLive: await isCacheLive(),
				claims: await retirementClaims()
			}).toStrictEqual({
				pass: 'garbage-collection',
				isCacheLive: true,
				claims: [
					{
						cacheId: 2,
						scope: managedCache,
						generation: 1
					}
				]
			});

			await runAlarm();
		});

		expect({
			state: await retirementState(),
			claims: await retirementClaims()
		}).toStrictEqual({
			state: {
				local: [{ id: 2, generation: 1, deleted: true }],
				managedIds: [],
				lifecycle: { generation: 2, deleted: true }
			},
			claims: []
		});
	});

	it('refuses a negotiation when retirement deletes its cache during classification', async () => {
		const token = await createManagedCache('managed-retirement-negotiate-race');
		await makeRetirementDue();
		await stageRetirementClaim();

		const lookupStarted = Promise.withResolvers<undefined>();
		const releaseLookup = Promise.withResolvers<undefined>();
		const lookup = vi
			.spyOn(UploadStateService.prototype, 'findReusableBlobs')
			.mockImplementation(async () => {
				lookupStarted.resolve(undefined);
				await releaseLookup.promise;

				return new Map();
			});

		try {
			const result = await withoutAlarmArming(() =>
				runInDurableObject(currentServer(), async (instance, state) => {
					const cacheId =
						instance.context.cacheRepository.require(managedCache).id;
					const negotiation = negotiateViaInstance(
						instance,
						token,
						'a'.repeat(32),
						managedCache
					);

					await lookupStarted.promise;
					await state.storage.put(maintenancePassCursorKey, 'teardown');
					await instance.alarm();
					releaseLookup.resolve(undefined);

					const response = await negotiation;
					const pending = instance.context.db
						.select({ id: schema.pendingUploads.id })
						.from(schema.pendingUploads)
						.where(eq(schema.pendingUploads.cacheId, cacheId))
						.all();

					return {
						status: response.status,
						cacheLive:
							instance.context.cacheRepository.resolve(managedCache) !==
							undefined,
						pending
					};
				})
			);

			expect(result).toStrictEqual({
				status: StatusCodes.NOT_FOUND,
				cacheLive: false,
				pending: []
			});
		} finally {
			releaseLookup.resolve(undefined);
			lookup.mockRestore();
		}
	});

	it('schedules an empty opted-in cache for its retirement deadline', async () => {
		const token = await createManagedCache(
			'managed-retirement-scheduled-wake',
			false
		);
		const marked = await authorisedFetch('/caches/pr-1/retirement', token, {
			body: JSON.stringify({ retireWhenEmpty: true }),
			headers: { 'content-type': 'application/json' },
			method: 'PUT'
		});

		expect(marked.status).toBe(StatusCodes.OK);
		const summary = await marked.json<{ retirementEligibleAfter: string }>();
		const scheduledWakeAt = await maintenanceWakeAt();
		const plan = await runInDurableObject(currentServer(), (_instance, state) =>
			Array.from(
				state.storage.sql.exec<{ detail: string }>(
					'EXPLAIN QUERY PLAN SELECT next_check_at FROM managed_cache_retirement ORDER BY next_check_at LIMIT 1'
				),
				(row) => row.detail
			)
		);
		await runInDurableObject(currentServer(), (instance) =>
			new MaintenanceEligibilityService(instance.context).reconcile(
				new Date(summary.retirementEligibleAfter)
			)
		);

		expect({
			scheduledWakeAt,
			dueWakeAt: await maintenanceWakeAt(),
			plan
		}).toStrictEqual({
			scheduledWakeAt: summary.retirementEligibleAfter,
			dueWakeAt: summary.retirementEligibleAfter,
			plan: [
				'SCAN managed_cache_retirement USING COVERING INDEX managed_cache_retirement_next_check_at_idx'
			]
		});
	});

	it('bounds rechecks of an overdue cache blocked by a permanent root', async () => {
		const token = await createManagedCache('managed-retirement-permanent-root');
		await makeRetirementDue();
		await seedEligibilityBlocker(`INSERT INTO retention_root
			(cache_id, name, expires_at, created_at, updated_at)
			VALUES (?, 'permanent', NULL, '2026-01-01T00:00:00.000Z',
				'2026-01-01T00:00:00.000Z')`);

		await scheduleRetirement();
		expect(await maintenanceWakeAt()).toBe(expiredDeadline);
		await driveRetirementPasses();
		const capture = startCapture();
		try {
			await scheduleRetirement();
		} finally {
			capture.stop();
		}
		const steadyPassCost = capture.logs
			.filter(
				(entry) =>
					entry.message === 'method finished' &&
					entry.properties.method === 'garbage-collection'
			)
			.map((entry) => entry.properties);

		expect({
			cacheLive: await isCacheLive(),
			wake: await maintenanceWakeAt(),
			steadyPassCost
		}).toStrictEqual({
			cacheLive: true,
			wake: '2026-01-01T06:00:00.000Z',
			steadyPassCost: [
				{ method: 'garbage-collection', rowsRead: 182, rowsWritten: 8 }
			]
		});

		const removed = await authorisedFetch(
			'/cache/pr-1/roots/permanent',
			token,
			{
				method: 'DELETE'
			}
		);

		expect({
			status: removed.status,
			body: await removed.json(),
			wake: await maintenanceWakeAt()
		}).toStrictEqual({
			status: StatusCodes.OK,
			body: { name: 'permanent', removed: true },
			wake: expiredDeadline
		});
	});

	it('does not stage a blocked retirement again before its next check', async () => {
		const token = await createManagedCache('managed-retirement-deferred-claim');
		await makeRetirementDue();
		await seedEligibilityBlocker(`INSERT INTO retention_root
			(cache_id, name, expires_at, created_at, updated_at)
			VALUES (?, 'permanent', NULL, '2026-01-01T00:00:00.000Z',
				'2026-01-01T00:00:00.000Z')`);

		await scheduleRetirement();
		await driveRetirementPasses();
		await scheduleRetirement();
		await withoutAlarmArming(runAlarm);
		await scheduleRetirement();

		expect({
			wake: await maintenanceWakeAt(),
			claims: await retirementClaims()
		}).toStrictEqual({
			wake: '2026-01-01T06:00:00.000Z',
			claims: []
		});

		const removed = await authorisedFetch(
			'/cache/pr-1/roots/permanent',
			token,
			{ method: 'DELETE' }
		);
		await scheduleRetirement();

		expect({
			removed: removed.status,
			wake: await maintenanceWakeAt(),
			claims: await retirementClaims()
		}).toStrictEqual({
			removed: StatusCodes.OK,
			wake: '2026-01-01T06:00:00.000Z',
			claims: [{ cacheId: 2, scope: managedCache, generation: 1 }]
		});
	});

	it('wakes for a later cache before retrying a blocked retirement', async () => {
		const token = await createManagedCache('managed-retirement-later-wake');
		await makeRetirementDue();
		await addManagedCache(token, secondManagedCache);
		const nextDeadline = await runInDurableObject(
			currentServer(),
			(instance) => {
				const cache =
					instance.context.cacheRepository.require(secondManagedCache);

				return instance.context.db
					.select({
						eligibleAfter: schema.managedCacheRetirements.eligibleAfter
					})
					.from(schema.managedCacheRetirements)
					.where(eq(schema.managedCacheRetirements.cacheId, cache.id))
					.get()?.eligibleAfter;
			}
		);
		await seedEligibilityBlocker(`INSERT INTO retention_root
			(cache_id, name, expires_at, created_at, updated_at)
			VALUES (?, 'permanent', NULL, '2026-01-01T00:00:00.000Z',
				'2026-01-01T00:00:00.000Z')`);

		await scheduleRetirement();
		await driveRetirementPasses();
		await scheduleRetirement();
		await scheduleRetirement();
		const wakeBeforeMutation = await maintenanceWakeAt();
		const before = await runInDurableObject(currentServer(), (instance) => {
			const cache = instance.context.cacheRepository.require(managedCache);

			return instance.context.db
				.select({
					revision: schema.managedCacheRetirements.revision,
					nextCheckAt: schema.managedCacheRetirements.nextCheckAt
				})
				.from(schema.managedCacheRetirements)
				.where(eq(schema.managedCacheRetirements.cacheId, cache.id))
				.get();
		});
		const updated = await authorisedFetch('/caches/pr-2/retirement', token, {
			body: JSON.stringify({ retireWhenEmpty: true }),
			headers: { 'content-type': 'application/json' },
			method: 'PUT'
		});
		const updatedSummary = await updated.json<{
			retirementEligibleAfter: string;
		}>();
		const after = await runInDurableObject(currentServer(), (instance) => {
			const cache = instance.context.cacheRepository.require(managedCache);

			return instance.context.db
				.select({
					revision: schema.managedCacheRetirements.revision,
					nextCheckAt: schema.managedCacheRetirements.nextCheckAt
				})
				.from(schema.managedCacheRetirements)
				.where(eq(schema.managedCacheRetirements.cacheId, cache.id))
				.get();
		});

		expect({
			updated: updated.status,
			before,
			after,
			wakeBeforeMutation,
			wakeAfterMutation: await maintenanceWakeAt()
		}).toStrictEqual({
			updated: StatusCodes.OK,
			before: {
				revision: 1,
				nextCheckAt: '2026-01-01T06:00:00.000Z'
			},
			after: before,
			wakeBeforeMutation: nextDeadline,
			wakeAfterMutation: updatedSummary.retirementEligibleAfter
		});
	});

	it('revisits a due cache after a bounded upload expiry spans caches', async () => {
		const token = await createManagedCache('managed-retirement-expiry-backlog');
		await addManagedCache(token, secondManagedCache);
		await makeRetirementDue();
		await runInDurableObject(currentServer(), (instance, state) => {
			const cache = instance.context.cacheRepository.require(managedCache);
			state.storage.sql.exec(
				`INSERT INTO garbage_collection_tenant_run (id, cache_id) VALUES (1, ?)
				ON CONFLICT (id) DO UPDATE SET cache_id = excluded.cache_id`,
				cache.id
			);
			state.storage.sql.exec(
				`WITH RECURSIVE seq(n) AS (
					SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 1001
				)
				INSERT INTO pending_upload
					(id, cache_id, nar_hash, r2_key, metadata_json, created_at, expires_at)
				SELECT 'expired-' || n, ?, 'sha256:hash',
					'nar/sha256:hash.nar.zst', '{}',
					'2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z'
				FROM seq`,
				cache.id
			);
		});

		await scheduleRetirement();
		const afterFirst = await pendingWorkState();
		await scheduleRetirement();
		const afterSecond = await pendingWorkState();
		const dueWake = await maintenanceWakeAt();
		await scheduleRetirement();
		await scheduleRetirement();
		await driveRetirementPasses();

		expect({
			afterFirst: afterFirst.uploads,
			afterSecond: afterSecond.uploads,
			dueWake,
			cacheLive: await isCacheLive()
		}).toStrictEqual({
			afterFirst: 1,
			afterSecond: 0,
			dueWake: expiredDeadline,
			cacheLive: false
		});
	});

	it('keeps a due wake when a mutation overlaps completion of a scan', async () => {
		await createManagedCache('managed-retirement-concurrent-mutation');
		await makeRetirementDue();
		await runInDurableObject(currentServer(), async (instance) => {
			const eligibility = new MaintenanceEligibilityService(instance.context);
			const cache = instance.context.cacheRepository.require(
				namedCache('pr-1')
			);
			const observedRevision = eligibility.retirementRevision(cache.id);
			if (observedRevision === undefined) {
				throw new Error('Expected a due managed retirement.');
			}

			eligibility.invalidateRetirementRecheck(cache.id);
			eligibility.completeRetirementRecheck(cache.id, observedRevision);
			await eligibility.reconcile();
		});

		expect(await maintenanceWakeAt()).toBe(expiredDeadline);
	});

	it('does not defer a new opt-in after an old scan completes', async () => {
		await createManagedCache('managed-retirement-reopt-in');
		await makeRetirementDue();
		const state = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const cache = instance.context.cacheRepository.require(managedCache);
				const eligibility = new MaintenanceEligibilityService(instance.context);
				const observed = eligibility.retirementRevision(cache.id);
				if (observed === undefined) {
					throw new Error('Expected a due managed retirement.');
				}

				const incarnation = crypto.randomUUID();
				instance.context.db
					.delete(schema.managedCacheRetirements)
					.where(eq(schema.managedCacheRetirements.cacheId, cache.id))
					.run();
				instance.context.db
					.insert(schema.managedCacheRetirements)
					.values({
						cacheId: cache.id,
						eligibleAfter: isoTimestamp(new Date(expiredDeadline)),
						nextCheckAt: isoTimestamp(new Date(expiredDeadline)),
						incarnation,
						revision: observed.revision
					})
					.run();
				eligibility.completeRetirementRecheck(cache.id, observed);
				await eligibility.reconcile();

				return {
					retirement: instance.context.db
						.select({
							incarnation: schema.managedCacheRetirements.incarnation,
							revision: schema.managedCacheRetirements.revision,
							nextCheckAt: schema.managedCacheRetirements.nextCheckAt
						})
						.from(schema.managedCacheRetirements)
						.where(eq(schema.managedCacheRetirements.cacheId, cache.id))
						.get(),
					expected: {
						incarnation,
						revision: observed.revision,
						nextCheckAt: expiredDeadline
					}
				};
			}
		);

		expect({
			retirement: state.retirement,
			wake: await maintenanceWakeAt()
		}).toStrictEqual({
			retirement: state.expected,
			wake: expiredDeadline
		});
	});

	it('leaves an ordinary empty cache live', async () => {
		await createManagedCache('managed-retirement-opt-in', false);
		await scheduleRetirement();
		await driveRetirementPasses();

		expect(await isCacheLive()).toBe(true);
	});

	it('leaves a managed cache live before its deadline', async () => {
		await createManagedCache('managed-retirement-deadline');
		await scheduleRetirement();
		await driveRetirementPasses();

		expect(await isCacheLive()).toBe(true);
	});

	it('discards a retirement claim when publication and a root land after the scan', async () => {
		const token = await createManagedCache('managed-retirement-root-race');
		await makeRetirementDue();

		await withoutAlarmArming(async () => {
			await scheduleRetirement();
			await runAlarm();

			const metadata = uploadMetadata({
				fileSize: narBytes.byteLength,
				name: 'late-root'
			});
			await pushPath(token, metadata, managedCache);
			const rooted = await authorisedFetch('/cache/pr-1/roots/active', token, {
				body: JSON.stringify({ targets: [metadata.storePath] }),
				headers: { 'content-type': 'application/json' },
				method: 'PUT'
			});

			expect(rooted.status).toBe(StatusCodes.OK);
			await runAlarm();
		});

		expect({
			state: await retirementState(),
			content: await retainedContentState(),
			claims: await retirementClaims()
		}).toStrictEqual({
			state: {
				local: [{ id: 2, generation: 1, deleted: false }],
				managedIds: [2],
				lifecycle: { generation: 1, deleted: false }
			},
			content: { narInfos: 1, roots: 1, targets: 1 },
			claims: []
		});
	});

	it('discards a retirement claim when an upload starts after the scan', async () => {
		const token = await createManagedCache('managed-retirement-upload-race');
		await makeRetirementDue();

		await withoutAlarmArming(async () => {
			await scheduleRetirement();
			await runAlarm();

			const metadata = uploadMetadata({
				fileSize: narBytes.byteLength,
				name: 'late-upload'
			});
			await negotiateUploads(token, [metadata], managedCache);
			await runAlarm();
		});

		expect({
			state: await retirementState(),
			work: await pendingWorkState(),
			claims: await retirementClaims()
		}).toStrictEqual({
			state: {
				local: [{ id: 2, generation: 1, deleted: false }],
				managedIds: [2],
				lifecycle: { generation: 1, deleted: false }
			},
			work: {
				uploads: 1,
				attestations: 0,
				verificationCursors: 0,
				deletions: 0,
				scans: 0
			},
			claims: []
		});
	});

	it('does not retire a cache recreated under the claimed name', async () => {
		const token = await createManagedCache('managed-retirement-recreation');
		await makeRetirementDue();

		await withoutAlarmArming(async () => {
			await scheduleRetirement();
			await runAlarm();
			await currentServer().runCacheTeardown(managedCache, origin);

			const recreated = await putManagedCache(token);
			expect(recreated.status).toBe(StatusCodes.OK);

			await runInDurableObject(currentServer(), (_instance, state) =>
				state.storage.put(maintenancePassCursorKey, 'teardown')
			);
			await runAlarm();
		});

		expect({
			state: await retirementState(),
			claims: await retirementClaims()
		}).toStrictEqual({
			state: {
				local: [
					{ id: 2, generation: 1, deleted: true },
					{ id: 3, generation: 2, deleted: false }
				],
				managedIds: [],
				lifecycle: { generation: 2, deleted: false }
			},
			claims: []
		});
	});

	it('keeps a cache live while a reconciliation target remains queued', async () => {
		await createManagedCache('managed-retirement-reconcile-queue');
		await makeRetirementDue();
		await stageRetirementClaim();

		await withoutAlarmArming(() =>
			runInDurableObject(currentServer(), async (instance, state) => {
				const cache = instance.context.cacheRepository.require(managedCache);
				const queue = new ReconcileQueueService(instance.context);

				await queue.enqueue(origin, [
					{
						cacheId: cache.id,
						storePathHash: storePathHashSchema.parse('1'.repeat(32))
					}
				]);
				await state.storage.put(maintenancePassCursorKey, 'teardown');
			})
		);

		await withoutAlarmArming(runAlarm);

		expect({
			isCacheLive: await isCacheLive(),
			claims: await retirementClaims(),
			reconcilePending: await runInDurableObject(
				currentServer(),
				(instance) => {
					const cache = instance.context.cacheRepository.require(managedCache);

					return new ReconcileQueueService(instance.context).hasPendingForCache(
						cache.id
					);
				}
			)
		}).toStrictEqual({
			isCacheLive: true,
			claims: [],
			reconcilePending: true
		});
	});

	it('re-arms a deferred cache when reconciliation clears its last target', async () => {
		await createManagedCache('managed-retirement-reconcile-wake');
		await makeRetirementDue();
		await withoutAlarmArming(() =>
			runInDurableObject(currentServer(), async (instance, state) => {
				const cache = instance.context.cacheRepository.require(managedCache);
				const queue = new ReconcileQueueService(instance.context);
				await queue.enqueue(origin, [
					{
						cacheId: cache.id,
						storePathHash: storePathHashSchema.parse('1'.repeat(32))
					}
				]);
				state.storage.sql.exec(
					`INSERT INTO garbage_collection_tenant_run (id, cache_id) VALUES (1, ?)
					ON CONFLICT (id) DO UPDATE SET cache_id = excluded.cache_id`,
					cache.id
				);
			})
		);
		await scheduleRetirement();
		const deferredWake = await maintenanceWakeAt();
		await stageRetirementClaim();
		await runInDurableObject(currentServer(), async (_instance, state) => {
			await state.storage.put(maintenancePassCursorKey, 'teardown');
		});
		await withoutAlarmArming(runAlarm);
		const afterClaim = {
			cacheLive: await isCacheLive(),
			claims: await retirementClaims()
		};
		await withoutAlarmArming(runAlarm);
		const hasPendingReconciliation = await runInDurableObject(
			currentServer(),
			(instance) => {
				const cache = instance.context.cacheRepository.require(managedCache);

				return new ReconcileQueueService(instance.context).hasPendingForCache(
					cache.id
				);
			}
		);

		expect({
			deferredWake,
			afterClaim,
			hasPendingReconciliation,
			wakeAfterReconciliation: await maintenanceWakeAt()
		}).toStrictEqual({
			deferredWake: '2026-01-01T06:00:00.000Z',
			afterClaim: { cacheLive: true, claims: [] },
			hasPendingReconciliation: false,
			wakeAfterReconciliation: expiredDeadline
		});
	});

	it('retires a later cache when the first claim keeps failing', async () => {
		const token = await createManagedCache('managed-retirement-fairness');
		await addManagedCache(token, secondManagedCache);
		await makeRetirementDue();
		await makeRetirementDue(secondManagedCache);
		await stageRetirementClaim();
		await stageRetirementClaim(secondManagedCache);

		const originalBatch = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const batch = vi.spyOn(env.CUPBOARD_DB, 'batch');
		batch.mockImplementationOnce(async (statements) => {
			await originalBatch(statements);
			throw new Error('D1 response lost after cache revocation');
		});
		let attempts: string[];
		try {
			attempts = await withoutAlarmArming(() =>
				runInDurableObject(currentServer(), async (instance) => {
					const results: string[] = [];
					for (let attempt = 0; attempt < 2; attempt += 1) {
						try {
							await instance.alarm();
							results.push('succeeded');
						} catch {
							results.push('failed');
						}
					}
					return results;
				})
			);
		} finally {
			batch.mockRestore();
		}

		expect({
			attempts,
			firstLive: await isCacheLive(),
			secondLive: await isCacheLive(secondManagedCache),
			claims: await retirementClaims()
		}).toStrictEqual({
			attempts: ['failed', 'succeeded'],
			firstLive: true,
			secondLive: false,
			claims: [
				{
					cacheId: 2,
					scope: managedCache,
					generation: 1,
					revocationStarted: true
				}
			]
		});
	});

	it.each(eligibilityBlockers)(
		'keeps a cache with $name live',
		async ({ name, statement }) => {
			await createManagedCache(
				`managed-retirement-${name.replaceAll(' ', '-')}`
			);
			await makeRetirementDue();
			await stageRetirementClaim();
			await seedEligibilityBlocker(statement);

			await withoutAlarmArming(runAlarm);

			expect({
				state: await retirementState(),
				claims: await retirementClaims()
			}).toStrictEqual({
				state: {
					local: [{ id: 2, generation: 1, deleted: false }],
					managedIds: [2],
					lifecycle: { generation: 1, deleted: false }
				},
				claims: []
			});
		}
	);

	it('converges after D1 commits a revocation whose response is lost', async () => {
		await createManagedCache('managed-retirement-d1-retry');
		await makeRetirementDue();
		await stageRetirementClaim();

		const originalBatch = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const batch = vi.spyOn(env.CUPBOARD_DB, 'batch');
		batch.mockImplementationOnce(async (statements) => {
			await originalBatch(statements);
			throw new Error('D1 response lost after cache revocation');
		});
		let firstAttempt: string;
		try {
			firstAttempt = await withoutAlarmArming(() =>
				runInDurableObject(currentServer(), async (instance) => {
					try {
						await instance.alarm();
						return 'succeeded';
					} catch {
						return 'failed';
					}
				})
			);
		} finally {
			batch.mockRestore();
		}

		const interrupted = {
			state: await retirementState(),
			claims: await retirementClaims()
		};

		await withoutAlarmArming(runAlarm);

		expect({
			firstAttempt,
			interrupted,
			settled: {
				state: await retirementState(),
				claims: await retirementClaims()
			}
		}).toStrictEqual({
			firstAttempt: 'failed',
			interrupted: {
				state: {
					local: [{ id: 2, generation: 1, deleted: false }],
					managedIds: [2],
					lifecycle: { generation: 2, deleted: true }
				},
				claims: [
					{
						cacheId: 2,
						scope: managedCache,
						generation: 1,
						revocationStarted: true
					}
				]
			},
			settled: {
				state: {
					local: [{ id: 2, generation: 1, deleted: true }],
					managedIds: [],
					lifecycle: { generation: 2, deleted: true }
				},
				claims: []
			}
		});
	});

	it('honours opt-out after a revocation attempt fails before D1 commits', async () => {
		const token = await createManagedCache('managed-retirement-cancel-retry');
		await makeRetirementDue();
		await stageRetirementClaim();

		const batch = vi.spyOn(env.CUPBOARD_DB, 'batch');
		batch.mockRejectedValueOnce(
			new Error('D1 revocation failed before commit')
		);
		let firstAttempt: string;
		try {
			firstAttempt = await withoutAlarmArming(() =>
				runInDurableObject(currentServer(), async (instance) => {
					try {
						await instance.alarm();
						return 'succeeded';
					} catch {
						return 'failed';
					}
				})
			);
		} finally {
			batch.mockRestore();
		}

		const disabled = await authorisedFetch('/caches/pr-1/retirement', token, {
			body: JSON.stringify({ retireWhenEmpty: false }),
			headers: { 'content-type': 'application/json' },
			method: 'PUT'
		});
		expect(disabled.status).toBe(StatusCodes.OK);

		await withoutAlarmArming(runAlarm);

		expect({
			firstAttempt,
			state: await retirementState(),
			claims: await retirementClaims()
		}).toStrictEqual({
			firstAttempt: 'failed',
			state: {
				local: [{ id: 2, generation: 1, deleted: false }],
				managedIds: [],
				lifecycle: { generation: 1, deleted: false }
			},
			claims: []
		});
	});

	it('resumes after local retirement commits before its teardown marker', async () => {
		await createManagedCache('managed-retirement-marker-retry');
		await makeRetirementDue();
		await stageRetirementClaim();

		const firstAttempt = await withoutAlarmArming(() =>
			runInDurableObject(currentServer(), async (instance, state) => {
				const storagePut = state.storage.put.bind(state.storage);
				let shouldFail = true;

				Object.defineProperty(state.storage, 'put', {
					configurable: true,
					value: async (
						key: string,
						value: unknown,
						options?: DurableObjectPutOptions
					): Promise<void> => {
						if (shouldFail && key.startsWith(teardownEntryPrefix)) {
							shouldFail = false;
							throw new Error('teardown marker unavailable');
						}

						await storagePut(key, value, options);
					}
				});

				try {
					await instance.alarm();
					return 'succeeded';
				} catch {
					return 'failed';
				} finally {
					Object.defineProperty(state.storage, 'put', {
						configurable: true,
						value: storagePut
					});
				}
			})
		);
		const interrupted = {
			state: await retirementState(),
			claims: await retirementClaims(),
			teardown: await teardownKeys()
		};

		await withoutAlarmArming(async () => {
			await runAlarm();
			await currentServer().resumeCacheTeardown();
		});

		expect({
			firstAttempt,
			interrupted,
			settled: {
				state: await retirementState(),
				claims: await retirementClaims(),
				teardown: await teardownKeys()
			}
		}).toStrictEqual({
			firstAttempt: 'failed',
			interrupted: {
				state: {
					local: [{ id: 2, generation: 1, deleted: true }],
					managedIds: [],
					lifecycle: { generation: 2, deleted: true }
				},
				claims: [
					{
						cacheId: 2,
						scope: managedCache,
						generation: 1,
						revocationStarted: true
					}
				],
				teardown: []
			},
			settled: {
				state: {
					local: [{ id: 2, generation: 1, deleted: true }],
					managedIds: [],
					lifecycle: { generation: 2, deleted: true }
				},
				claims: [],
				teardown: []
			}
		});
	});
});
