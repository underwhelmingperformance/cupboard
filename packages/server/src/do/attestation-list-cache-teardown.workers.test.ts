import {
	cachePrioritySchema,
	narInfoGenerationSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { lateWriteTombstoneHorizonMs } from '../blob/object-incarnation.ts';
import { cacheIdSchema, type ResolvedCache } from '../db/cache.ts';
import * as schema from '../db/schema.ts';
import { r2ObjectKeySchema, requestOriginSchema } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	bootstrap,
	currentServer,
	namedCache,
	narHash,
	recordTransition,
	resetTestServer,
	withoutAlarmArming
} from '../test-support.ts';

import { teardownEntryPrefix } from './cache-admin-service.ts';
import { CacheRegistrationService } from './cache-registration-service.ts';
import { maintenancePassCursorKey } from './server.ts';

const scope = namedCache('lists');
const origin = requestOriginSchema.parse('https://cache.example');
const hash = storePathHashSchema.parse('a'.repeat(32));
const key = r2ObjectKeySchema.parse(
	`t/${fixtureTenant}/attestation-index/cache-old`
);

async function fixture() {
	await bootstrap({ caches: [{ scope }] });
	await recordTransition('attestation-list-revision', 'complete');
	return runInDurableObject(currentServer(), (instance) =>
		instance.context.cacheRepository.require(scope)
	);
}

async function uncertainCompletion(cache: ResolvedCache): Promise<number> {
	const cleanupAfter = Date.now() + lateWriteTombstoneHorizonMs;
	await env.BLOBS.put(key, 'uncertain');
	await runInDurableObject(currentServer(), (instance) => {
		instance.context.db
			.insert(schema.attestationListRefreshJobs)
			.values({
				id: 'cache-uncertain',
				cacheId: cache.id,
				source: {
					captured: { id: 1, revision: 1 },
					identity: {
						cache: scope,
						storePathHash: hash,
						generation: narInfoGenerationSchema.parse(0)
					},
					parent: { cacheGeneration: cache.generation, narHash }
				},
				key,
				phase: 'completing',
				cleanupNotBefore: cleanupAfter
			})
			.run();
	});
	return cleanupAfter;
}

async function publishRevision(
	generation: number,
	cacheGeneration: number,
	publishedKey: string
) {
	await env.BLOBS.put(publishedKey, '[]');
	await env.CUPBOARD_DB.prepare(
		"INSERT INTO attestation_list_revision (tenant,cache_kind,cache_name,store_path_hash,generation,revision,published_revision,published_cache_generation,published_nar_hash,published_key,updated_at) VALUES (?,'named',?,?,?,1,1,?,?,?,'2026-10-12T00:00:00.000Z')"
	)
		.bind(
			fixtureTenant,
			scope.name,
			hash,
			generation,
			cacheGeneration,
			narHash,
			publishedKey
		)
		.run();
}

async function hasMarker(cacheId: number) {
	return runInDurableObject(currentServer(), async (_instance, state) => {
		const durable = state.storage.sql
			.exec('SELECT cache_id FROM cache_teardown WHERE cache_id = ?', cacheId)
			.toArray();
		return (
			durable.length > 0 ||
			(await state.storage.get(`${teardownEntryPrefix}${String(cacheId)}`)) !==
				undefined
		);
	});
}

async function revisionGenerations() {
	const result = await env.CUPBOARD_DB.prepare(
		"SELECT generation FROM attestation_list_revision WHERE tenant = ? AND cache_kind = 'named' AND cache_name = ? ORDER BY generation"
	)
		.bind(fixtureTenant, scope.name)
		.all();
	return result.results;
}

describe('attestation list cache teardown', () => {
	beforeEach(resetTestServer);

	it('retires published revision keys in bounded pages before removing the cache marker', () =>
		withoutAlarmArming(async () => {
			const cache = await fixture();
			await publishRevision(0, cache.generation, key);
			const secondKey = `${key}-second`;
			await publishRevision(1, cache.generation, secondKey);
			await currentServer().runCacheTeardown(scope, origin);
			await currentServer().resumeCacheTeardown(1);
			expect({
				marker: await hasMarker(cache.id),
				revisions: await revisionGenerations(),
				objects: [
					(await env.BLOBS.head(key)) !== null,
					(await env.BLOBS.head(secondKey)) !== null
				]
			}).toStrictEqual({
				marker: true,
				revisions: [{ generation: 1 }],
				objects: [false, true]
			});
			await currentServer().resumeCacheTeardown(1);
			expect({
				marker: await hasMarker(cache.id),
				revisions: await revisionGenerations(),
				objectPresent: (await env.BLOBS.head(secondKey)) !== null
			}).toStrictEqual({ marker: false, revisions: [], objectPresent: false });
		}));

	it('preserves uncertain completion cleanup until its deadline', () =>
		withoutAlarmArming(async () => {
			const cache = await fixture();
			const cleanupAfter = await uncertainCompletion(cache);
			await currentServer().runCacheTeardown(scope, origin);
			await currentServer().resumeCacheTeardown(1);
			const jobs = await runInDurableObject(currentServer(), (instance) =>
				instance.context.db
					.select({
						phase: schema.attestationListRefreshJobs.phase,
						cleanupAt: schema.attestationListRefreshJobs.cleanupAt
					})
					.from(schema.attestationListRefreshJobs)
					.all()
			);
			expect({
				marker: await hasMarker(cache.id),
				jobs,
				objectPresent: (await env.BLOBS.head(key)) !== null
			}).toStrictEqual({
				marker: true,
				jobs: [{ phase: 'cleanup', cleanupAt: cleanupAfter }],
				objectPresent: true
			});
			vi.useFakeTimers({ toFake: ['Date'] });
			vi.setSystemTime(cleanupAfter + 1);
			await currentServer().resumeCacheTeardown(1);
			expect({
				marker: await hasMarker(cache.id),
				objectPresent: (await env.BLOBS.head(key)) !== null
			}).toStrictEqual({ marker: false, objectPresent: false });
		}));

	it('preserves a recreated cache publication and active job while retiring the previous identity', () =>
		withoutAlarmArming(async () => {
			const old = await fixture();
			await publishRevision(0, old.generation, key);
			await runInDurableObject(currentServer(), (instance) => {
				instance.context.db
					.insert(schema.attestationListRefreshJobs)
					.values({
						id: 'old-key',
						cacheId: old.id,
						source: {
							captured: { id: 1, revision: 1 },
							identity: {
								cache: scope,
								storePathHash: hash,
								generation: narInfoGenerationSchema.parse(0)
							},
							parent: { cacheGeneration: old.generation, narHash }
						},
						key,
						phase: 'cleanup',
						cleanupAt: Date.now()
					})
					.run();
			});
			await currentServer().runCacheTeardown(scope, origin);
			const fresh = await runInDurableObject(currentServer(), (instance) =>
				instance.context.criticalSection(() =>
					new CacheRegistrationService(instance.context).createInSection(
						scope,
						{ access: 'private', priority: cachePrioritySchema.parse(40) }
					)
				)
			);
			const newKey = r2ObjectKeySchema.parse(`${key}-new`);
			await env.BLOBS.put(newKey, 'new');
			await env.CUPBOARD_DB.prepare(
				"UPDATE attestation_list_revision SET published_cache_generation = ?, published_key = ? WHERE tenant = ? AND cache_kind = 'named' AND cache_name = ?"
			)
				.bind(fresh.generation, newKey, fixtureTenant, scope.name)
				.run();
			await runInDurableObject(currentServer(), (instance) => {
				instance.context.db
					.insert(schema.attestationListRefreshJobs)
					.values({
						id: 'new-job',
						cacheId: fresh.id,
						source: {
							captured: { id: 1, revision: 1 },
							identity: {
								cache: scope,
								storePathHash: hash,
								generation: narInfoGenerationSchema.parse(0)
							},
							parent: { cacheGeneration: fresh.generation, narHash }
						},
						key: newKey,
						phase: 'collecting'
					})
					.run();
			});
			await currentServer().resumeCacheTeardown(1);
			const jobs = await runInDurableObject(currentServer(), (instance) =>
				instance.context.db
					.select({
						id: schema.attestationListRefreshJobs.id,
						phase: schema.attestationListRefreshJobs.phase
					})
					.from(schema.attestationListRefreshJobs)
					.orderBy(schema.attestationListRefreshJobs.id)
					.all()
			);
			expect({
				marker: await hasMarker(old.id),
				revisions: await revisionGenerations(),
				objects: [
					(await env.BLOBS.head(key)) !== null,
					(await env.BLOBS.head(newKey)) !== null
				],
				jobs
			}).toStrictEqual({
				marker: false,
				revisions: [{ generation: 0 }],
				objects: [false, true],
				jobs: [{ id: 'new-job', phase: 'collecting' }]
			});
		}));
	it('detaches the old list key while preserving a pending revision for a new cache parent', () =>
		withoutAlarmArming(async () => {
			const old = await fixture();
			await publishRevision(0, old.generation, key);
			await currentServer().runCacheTeardown(scope, origin);
			const fresh = await runInDurableObject(currentServer(), (instance) =>
				instance.context.criticalSection(() =>
					new CacheRegistrationService(instance.context).createInSection(
						scope,
						{ access: 'private', priority: cachePrioritySchema.parse(40) }
					)
				)
			);
			await env.CUPBOARD_DB.prepare(
				"INSERT INTO blob_ref_storage (tenant,cache_kind,cache_name,store_path_hash,generation,nar_hash,cache_generation,readable) VALUES (?,'named',?,?,0,?,?,1)"
			)
				.bind(fixtureTenant, scope.name, hash, narHash, fresh.generation)
				.run();
			await currentServer().resumeCacheTeardown(1);
			const row = await env.CUPBOARD_DB.prepare(
				"SELECT generation, published_key IS NOT NULL AS hasKey FROM attestation_list_revision WHERE tenant = ? AND cache_kind = 'named' AND cache_name = ?"
			)
				.bind(fixtureTenant, scope.name)
				.all();
			expect({
				marker: await hasMarker(old.id),
				revisions: row.results,
				objectPresent: (await env.BLOBS.head(key)) !== null
			}).toStrictEqual({
				marker: false,
				revisions: [{ generation: 0, hasKey: 0 }],
				objectPresent: false
			});
		}));

	it('fences retirement when the recreated cache publishes after the revision snapshot', () =>
		withoutAlarmArming(async () => {
			const old = await fixture();
			await publishRevision(0, old.generation, key);
			await currentServer().runCacheTeardown(scope, origin);
			const fresh = await runInDurableObject(currentServer(), (instance) =>
				instance.context.criticalSection(() =>
					new CacheRegistrationService(instance.context).createInSection(
						scope,
						{ access: 'private', priority: cachePrioritySchema.parse(40) }
					)
				)
			);
			const newKey = r2ObjectKeySchema.parse(`${key}-race`);
			await env.BLOBS.put(newKey, 'new');
			await runInDurableObject(currentServer(), async (instance) => {
				let isInjected = false;
				const nativeBatch = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
				const spy = vi
					.spyOn(env.CUPBOARD_DB, 'batch')
					.mockImplementation(async (statements) => {
						const jobs = instance.context.db
							.select({ key: schema.attestationListRefreshJobs.key })
							.from(schema.attestationListRefreshJobs)
							.all();
						if (!isInjected && jobs.some((job) => job.key === key)) {
							isInjected = true;
							await env.CUPBOARD_DB.prepare(
								"UPDATE attestation_list_revision SET published_cache_generation = ?, published_key = ? WHERE tenant = ? AND cache_kind = 'named' AND cache_name = ?"
							)
								.bind(fresh.generation, newKey, fixtureTenant, scope.name)
								.run();
						}
						return nativeBatch(statements);
					});
				try {
					await instance.resumeCacheTeardown(1);
					expect(isInjected).toBe(true);
				} finally {
					spy.mockRestore();
				}
			});
			const row = await env.CUPBOARD_DB.prepare(
				"SELECT generation,published_key AS key FROM attestation_list_revision WHERE tenant = ? AND cache_kind = 'named' AND cache_name = ?"
			)
				.bind(fixtureTenant, scope.name)
				.all();
			expect({
				marker: await hasMarker(old.id),
				revisions: row.results,
				objects: [
					(await env.BLOBS.head(key)) !== null,
					(await env.BLOBS.head(newKey)) !== null
				]
			}).toStrictEqual({
				marker: false,
				revisions: [{ generation: 0, key: newKey }],
				objects: [false, true]
			});
		}));

	it('bounds retry retirement beside 25,000 unrelated retries', () =>
		withoutAlarmArming(async () => {
			const cache = await fixture();
			await runInDurableObject(currentServer(), (_instance, state) => {
				state.storage.sql.exec(
					`WITH RECURSIVE numbered(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM numbered WHERE value < 25000) INSERT INTO attestation_list_refresh_retry (revision_id,revision,cache_id,not_before,failure) SELECT value,1,999,9999999999999,'{"reason":"staging-invalid","detail":"missing-chunk"}' FROM numbered`
				);
				state.storage.sql.exec(
					`INSERT INTO attestation_list_refresh_retry (revision_id,revision,cache_id,not_before,failure) VALUES (25001,1,?,9999999999999,'{"reason":"staging-invalid","detail":"missing-chunk"}')`,
					cache.id
				);
			});
			await currentServer().runCacheTeardown(scope, origin);
			const reads = await runInDurableObject(
				currentServer(),
				async (instance) => {
					instance.context.dbCost.recordOutstanding();
					const before = instance.context.dbCost.rowsRead;
					await instance.resumeCacheTeardown(1);
					instance.context.dbCost.recordOutstanding();
					return instance.context.dbCost.rowsRead - before;
				}
			);
			expect(reads).toBeLessThanOrEqual(300);
			const retries = await runInDurableObject(
				currentServer(),
				(_instance, state) =>
					state.storage.sql
						.exec(
							'SELECT count(*) AS count FROM attestation_list_refresh_retry'
						)
						.toArray()
			);
			expect({ marker: await hasMarker(cache.id), retries }).toStrictEqual({
				marker: false,
				retries: [{ count: 25_000 }]
			});
		}));
	it('revisits an old revision invalidated after the retirement snapshot', () =>
		withoutAlarmArming(async () => {
			const cache = await fixture();
			await publishRevision(0, cache.generation, key);
			await currentServer().runCacheTeardown(scope, origin);
			await runInDurableObject(currentServer(), async (instance) => {
				const nativeBatch = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
				let isInjected = false;
				const spy = vi
					.spyOn(env.CUPBOARD_DB, 'batch')
					.mockImplementation(async (statements) => {
						const jobs = instance.context.db
							.select({ key: schema.attestationListRefreshJobs.key })
							.from(schema.attestationListRefreshJobs)
							.all();
						if (!isInjected && jobs.some((job) => job.key === key)) {
							isInjected = true;
							await env.CUPBOARD_DB.prepare(
								"UPDATE attestation_list_revision SET revision = revision + 1 WHERE tenant = ? AND cache_kind = 'named' AND cache_name = ?"
							)
								.bind(fixtureTenant, scope.name)
								.run();
						}
						return nativeBatch(statements);
					});
				try {
					await instance.resumeCacheTeardown(1);
					expect(isInjected).toBe(true);
				} finally {
					spy.mockRestore();
				}
			});
			expect({
				marker: await hasMarker(cache.id),
				revisions: await revisionGenerations()
			}).toStrictEqual({ marker: true, revisions: [{ generation: 0 }] });
			await currentServer().resumeCacheTeardown(1);
			expect({
				marker: await hasMarker(cache.id),
				revisions: await revisionGenerations()
			}).toStrictEqual({ marker: false, revisions: [] });
		}));
	it('frees cleanup capacity when sixteen retired jobs occupy every slot', () =>
		withoutAlarmArming(async () => {
			const cache = await fixture();
			await publishRevision(0, cache.generation, key);
			await runInDurableObject(currentServer(), async (instance) => {
				for (let index = 0; index < 16; index++) {
					const jobKey = r2ObjectKeySchema.parse(`${key}-${String(index)}`);
					await env.BLOBS.put(jobKey, 'old');
					instance.context.db
						.insert(schema.attestationListRefreshJobs)
						.values({
							id: `full-${String(index)}`,
							cacheId: cache.id,
							source: {
								captured: { id: 1, revision: 1 },
								identity: {
									cache: scope,
									storePathHash: hash,
									generation: narInfoGenerationSchema.parse(0)
								},
								parent: { cacheGeneration: cache.generation, narHash }
							},
							key: jobKey,
							phase: 'cleanup',
							cleanupAt: Date.now()
						})
						.run();
				}
			});
			await currentServer().runCacheTeardown(scope, origin);
			await currentServer().resumeCacheTeardown(1);
			const jobs = await runInDurableObject(
				currentServer(),
				(_instance, state) =>
					state.storage.sql
						.exec('SELECT count(*) AS count FROM attestation_list_refresh_job')
						.toArray()
			);
			expect({
				marker: await hasMarker(cache.id),
				revisions: await revisionGenerations(),
				jobs
			}).toStrictEqual({
				marker: true,
				revisions: [{ generation: 0 }],
				jobs: [{ count: 15 }]
			});
			for (let pass = 0; pass < 17; pass++) {
				await currentServer().resumeCacheTeardown(1);
			}
			const remainingJobs = await runInDurableObject(
				currentServer(),
				(_instance, state) =>
					state.storage.sql
						.exec('SELECT count(*) AS count FROM attestation_list_refresh_job')
						.toArray()
			);
			expect({
				marker: await hasMarker(cache.id),
				revisions: await revisionGenerations(),
				jobs: remainingJobs,
				objectPresent: (await env.BLOBS.head(key)) !== null
			}).toStrictEqual({
				marker: false,
				revisions: [],
				jobs: [{ count: 0 }],
				objectPresent: false
			});
		}));
	it('completes an empty cache teardown when unrelated jobs occupy every slot', () =>
		withoutAlarmArming(async () => {
			const cache = await fixture();
			await runInDurableObject(currentServer(), (instance) => {
				for (let index = 0; index < 16; index++) {
					instance.context.db
						.insert(schema.attestationListRefreshJobs)
						.values({
							id: `other-${String(index)}`,
							cacheId: cacheIdSchema.parse(999),
							source: {
								captured: { id: 1, revision: 1 },
								identity: {
									cache: namedCache('other'),
									storePathHash: hash,
									generation: narInfoGenerationSchema.parse(0)
								},
								parent: { cacheGeneration: cache.generation, narHash }
							},
							key: r2ObjectKeySchema.parse(`${key}-other-${String(index)}`),
							phase: 'cleanup',
							cleanupAt: Date.now()
						})
						.run();
				}
			});
			await currentServer().runCacheTeardown(scope, origin);
			await currentServer().resumeCacheTeardown(1);
			const jobs = await runInDurableObject(
				currentServer(),
				(_instance, state) =>
					state.storage.sql
						.exec('SELECT count(*) AS count FROM attestation_list_refresh_job')
						.toArray()
			);
			expect({ marker: await hasMarker(cache.id), jobs }).toStrictEqual({
				marker: false,
				jobs: [{ count: 16 }]
			});
		}));
	it.each([false, true])(
		'schedules future cleanup without immediate polling (earlier alarm: %s)',
		(hasEarlierAlarm) =>
			withoutAlarmArming(async () => {
				const cache = await fixture();
				const cleanupAfter = await uncertainCompletion(cache);
				await currentServer().runCacheTeardown(scope, origin);
				await runInDurableObject(currentServer(), async (instance, state) => {
					const expectedAt = hasEarlierAlarm ? Date.now() + 5000 : cleanupAfter;
					let scheduledAt = hasEarlierAlarm ? expectedAt : Infinity;
					const get = vi
						.spyOn(state.storage, 'getAlarm')
						.mockImplementation(() => Promise.resolve(scheduledAt));
					const set = vi
						.spyOn(state.storage, 'setAlarm')
						.mockImplementation((at) => {
							scheduledAt = typeof at === 'number' ? at : at.getTime();
							return Promise.resolve();
						});
					try {
						await instance.resumeCacheTeardown(1);
						expect(scheduledAt).toBe(expectedAt);
					} finally {
						get.mockRestore();
						set.mockRestore();
					}
				});
			})
	);

	it('runs another due cache while an earlier teardown waits for completion', () =>
		withoutAlarmArming(async () => {
			const cache = await fixture();
			const cleanupAfter = await uncertainCompletion(cache);
			const otherScope = namedCache('ready');
			const other = await runInDurableObject(currentServer(), (instance) =>
				instance.context.criticalSection(() =>
					new CacheRegistrationService(instance.context).createInSection(
						otherScope,
						{ access: 'private', priority: cachePrioritySchema.parse(40) }
					)
				)
			);
			await currentServer().runCacheTeardown(scope, origin);
			await currentServer().runCacheTeardown(otherScope, origin);
			await runInDurableObject(currentServer(), async (instance, state) => {
				let scheduledAt = Infinity;
				const get = vi
					.spyOn(state.storage, 'getAlarm')
					.mockImplementation(() => Promise.resolve(scheduledAt));
				const set = vi
					.spyOn(state.storage, 'setAlarm')
					.mockImplementation((at) => {
						scheduledAt = typeof at === 'number' ? at : at.getTime();
						return Promise.resolve();
					});
				try {
					await instance.resumeCacheTeardown(1);
					expect(scheduledAt).toBeLessThan(cleanupAfter);
					scheduledAt = Infinity;
					await instance.resumeCacheTeardown(1);
					expect(scheduledAt).toBe(cleanupAfter);
				} finally {
					get.mockRestore();
					set.mockRestore();
				}
			});
			expect({
				waiting: await hasMarker(cache.id),
				other: await hasMarker(other.id)
			}).toStrictEqual({ waiting: true, other: false });
		}));
	it.each(['modern', 'legacy'] as const)(
		'keeps its deadline after losing the KV hint and skips teardown in an early alarm (%s marker)',
		(markerKind) =>
			withoutAlarmArming(async () => {
				const cache = await fixture();
				const cleanupAfter = await uncertainCompletion(cache);
				await currentServer().runCacheTeardown(scope, origin);
				await runInDurableObject(currentServer(), async (_instance, state) => {
					if (markerKind === 'legacy') {
						await state.storage.delete(
							`${teardownEntryPrefix}${String(cache.id)}`
						);
						await state.storage.put(
							`${teardownEntryPrefix}${scope.name}`,
							origin
						);
					}
					state.storage.sql.exec(
						'UPDATE cache_teardown SET origin = NULL WHERE cache_id = ?',
						cache.id
					);
				});
				await currentServer().resumeCacheTeardown(1);
				await runInDurableObject(currentServer(), async (instance, state) => {
					await state.storage.delete(
						`${teardownEntryPrefix}${String(cache.id)}`
					);
					await state.storage.delete(maintenancePassCursorKey);
					const headers = state.storage.sql
						.exec(
							'SELECT next_work_at AS at, origin FROM cache_teardown WHERE cache_id = ?',
							cache.id
						)
						.toArray();
					expect(headers).toStrictEqual([{ at: cleanupAfter, origin }]);
					let scheduledAt = Infinity;
					const get = vi
						.spyOn(state.storage, 'getAlarm')
						.mockImplementation(() => Promise.resolve(scheduledAt));
					const set = vi
						.spyOn(state.storage, 'setAlarm')
						.mockImplementation((at) => {
							scheduledAt = typeof at === 'number' ? at : at.getTime();
							return Promise.resolve();
						});
					try {
						await instance.resumeCacheTeardown(1);
						expect(scheduledAt).toBe(cleanupAfter);
						await instance.alarm();
						const pass = await state.storage.get(maintenancePassCursorKey);
						expect(pass).not.toBe('teardown');
					} finally {
						get.mockRestore();
						set.mockRestore();
					}
				});
				expect({
					pending: await hasMarker(cache.id),
					objectPresent: (await env.BLOBS.head(key)) !== null
				}).toStrictEqual({ pending: true, objectPresent: true });
			})
	);
	it('selects a persisted deadline without scanning 25,000 later teardowns', () =>
		withoutAlarmArming(async () => {
			const cache = await fixture();
			const cleanupAfter = await uncertainCompletion(cache);
			await currentServer().runCacheTeardown(scope, origin);
			await currentServer().resumeCacheTeardown(1);
			await runInDurableObject(currentServer(), async (instance, state) => {
				state.storage.sql.exec(
					'WITH RECURSIVE numbered(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM numbered WHERE value<25000) INSERT INTO cache_teardown(cache_id,next_work_at) SELECT value+1000, ? FROM numbered',
					cleanupAfter + 86_400_000
				);
				let scheduledAt = Infinity;
				const get = vi
					.spyOn(state.storage, 'getAlarm')
					.mockImplementation(() => Promise.resolve(scheduledAt));
				const set = vi
					.spyOn(state.storage, 'setAlarm')
					.mockImplementation((at) => {
						scheduledAt = typeof at === 'number' ? at : at.getTime();
						return Promise.resolve();
					});
				try {
					instance.context.dbCost.recordOutstanding();
					const before = instance.context.dbCost.rowsRead;
					await instance.resumeCacheTeardown(1);
					instance.context.dbCost.recordOutstanding();
					expect(scheduledAt).toBe(cleanupAfter);
					expect(instance.context.dbCost.rowsRead - before).toBeLessThanOrEqual(
						100
					);
				} finally {
					get.mockRestore();
					set.mockRestore();
				}
			});
		}));
});
