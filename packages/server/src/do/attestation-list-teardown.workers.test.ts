import {
	narInfoGenerationSchema,
	nixSha256HashSchema,
	storePathHashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { lateWriteTombstoneHorizonMs } from '../blob/object-incarnation.ts';
import * as schema from '../db/schema.ts';
import { r2ObjectKeySchema } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	currentServer,
	defaultCache,
	initialise,
	recordTransition,
	resetTestServer,
	withoutAlarmArming
} from '../test-support.ts';

import { AttestationListTeardownService } from './attestation-list-teardown-service.ts';

const hash = storePathHashSchema.parse('a'.repeat(32));
const narHash = nixSha256HashSchema.parse(`sha256:${'0'.repeat(52)}`);

async function beginOffboarding() {
	await recordTransition('attestation-list-revision', 'complete');
	await env.CUPBOARD_DB.prepare(
		"UPDATE tenant SET status = 'offboarding' WHERE id = ?"
	)
		.bind(fixtureTenant)
		.run();
}

async function revisions() {
	const result = await env.CUPBOARD_DB.prepare(
		'SELECT generation FROM attestation_list_revision WHERE tenant = ? ORDER BY generation'
	)
		.bind(fixtureTenant)
		.all();
	return result.results;
}

describe('attestation list tenant teardown', () => {
	beforeEach(resetTestServer);

	it('retires published revision keys in bounded pages before reporting the tenant drained', () =>
		withoutAlarmArming(async () => {
			await initialise();
			for (const generation of [0, 1]) {
				const key = `t/${fixtureTenant}/attestation-index/retire-${String(generation)}`;
				await env.BLOBS.put(key, 'published');
				await env.CUPBOARD_DB.prepare(
					"INSERT INTO attestation_list_revision (tenant,cache_kind,store_path_hash,generation,revision,published_revision,published_cache_generation,published_nar_hash,published_key,updated_at) VALUES (?,'default',?,?,1,1,1,?,?,'2026-10-12T00:00:00.000Z')"
				)
					.bind(fixtureTenant, hash, generation, narHash, key)
					.run();
			}
			await beginOffboarding();
			const first = await currentServer().runOffboard(1);
			const firstObject = await env.BLOBS.head(
				`t/${fixtureTenant}/attestation-index/retire-0`
			);
			const secondObject = await env.BLOBS.head(
				`t/${fixtureTenant}/attestation-index/retire-1`
			);
			expect({
				first,
				remaining: await revisions(),
				objects: [firstObject !== null, secondObject !== null]
			}).toStrictEqual({
				first: { drained: false },
				remaining: [{ generation: 1 }],
				objects: [false, true]
			});
			const second = await currentServer().runOffboard(1);
			expect({
				second,
				remaining: await revisions(),
				objectPresent:
					(await env.BLOBS.head(
						`t/${fixtureTenant}/attestation-index/retire-1`
					)) !== null
			}).toStrictEqual({
				second: { drained: true },
				remaining: [],
				objectPresent: false
			});
		}));

	it('drains chunks, parts, retries and wake state while preserving an uncertain completion deadline', () =>
		withoutAlarmArming(async () => {
			await initialise();
			const key = r2ObjectKeySchema.parse(
				`t/${fixtureTenant}/attestation-index/uncertain`
			);
			await env.BLOBS.put(key, 'uncertain');
			const cleanupAfter = Date.now() + lateWriteTombstoneHorizonMs;
			await runInDurableObject(currentServer(), (instance, state) => {
				const cache = instance.context.cacheRepository.require(defaultCache());
				instance.context.db
					.insert(schema.attestationListRefreshJobs)
					.values({
						id: 'uncertain',
						cacheId: cache.id,
						source: {
							captured: { id: 1, revision: 1 },
							identity: {
								cache: cache.scope,
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
				for (let index = 0; index < 3; index++) {
					instance.context.db
						.insert(schema.attestationListRefreshChunks)
						.values({
							jobId: 'uncertain',
							sequence: index,
							body: '{}',
							bytes: 2
						})
						.run();
					instance.context.db
						.insert(schema.attestationListRefreshParts)
						.values({ jobId: 'uncertain', partNumber: index + 1, etag: 'part' })
						.run();
					instance.context.db
						.insert(schema.attestationListRefreshRetries)
						.values({
							revisionId: index + 1,
							revision: 1,
							cacheId: cache.id,
							notBefore: cleanupAfter,
							failure: { reason: 'staging-invalid', detail: 'missing-chunk' }
						})
						.run();
				}
				instance.context.db
					.insert(schema.attestationListRefreshWake)
					.values({ id: 1, token: 'wake' })
					.run();
				instance.context.db
					.insert(schema.attestationListRefreshLease)
					.values({ id: 1, owner: 'previous', expiresAt: cleanupAfter })
					.run();
				return state.storage.put('attestation-list:refresh-after', 1);
			});
			await beginOffboarding();
			const first = await currentServer().runOffboard(1);
			const state = await runInDurableObject(
				currentServer(),
				async (instance, storage) => ({
					jobs: instance.context.db
						.select({
							phase: schema.attestationListRefreshJobs.phase,
							cleanupAt: schema.attestationListRefreshJobs.cleanupAt
						})
						.from(schema.attestationListRefreshJobs)
						.all(),
					chunks: instance.context.db
						.select()
						.from(schema.attestationListRefreshChunks)
						.all().length,
					parts: instance.context.db
						.select()
						.from(schema.attestationListRefreshParts)
						.all().length,
					retries: instance.context.db
						.select()
						.from(schema.attestationListRefreshRetries)
						.all().length,
					wakes: instance.context.db
						.select()
						.from(schema.attestationListRefreshWake)
						.all(),
					leases: instance.context.db
						.select()
						.from(schema.attestationListRefreshLease)
						.all(),
					cursor: await storage.storage.get('attestation-list:refresh-after')
				})
			);
			expect({ first, state }).toStrictEqual({
				first: { drained: false },
				state: {
					jobs: [{ phase: 'cleanup', cleanupAt: cleanupAfter }],
					chunks: 2,
					parts: 2,
					retries: 2,
					wakes: [],
					leases: [],
					cursor: undefined
				}
			});
			for (let pass = 0; pass < 3; pass++) {
				await currentServer().runOffboard(1);
			}
			expect(await env.BLOBS.head(key)).not.toBeNull();
			vi.useFakeTimers({ toFake: ['Date'] });
			vi.setSystemTime(cleanupAfter + 1);
			const finished = await currentServer().runOffboard(1);
			const object = await env.BLOBS.head(key);
			expect({ finished, objectPresent: object !== null }).toStrictEqual({
				finished: { drained: true },
				objectPresent: false
			});
		}));

	it('refuses a recovery tenant that differs from the stored identity', async () => {
		await initialise();
		await runInDurableObject(currentServer(), async (instance) => {
			await expect(
				instance.runOffboard(1, tenantIdSchema.parse('wrong-tenant'))
			).rejects.toThrow(
				'Offboarding recovery must target the tenant assigned to this Durable Object'
			);
			expect(instance.context.offboarding).toBe(false);
		});
	});

	it('recovers revision cleanup after an earlier controller purged local storage', async () => {
		await initialise();
		await env.CUPBOARD_DB.prepare(
			"INSERT INTO attestation_list_revision (tenant,cache_kind,store_path_hash,generation,updated_at) VALUES (?,'default',?,0,'2026-10-12T00:00:00.000Z')"
		)
			.bind(fixtureTenant, hash)
			.run();
		await beginOffboarding();
		await currentServer().purgeStorage();
		expect(await currentServer().runOffboard(1, fixtureTenant)).toStrictEqual({
			drained: true
		});
		expect(await revisions()).toStrictEqual([]);
	});

	it('preserves the cleanup key when revision deletion fails and retries without duplicating jobs', () =>
		withoutAlarmArming(async () => {
			await initialise();
			const key = `t/${fixtureTenant}/attestation-index/delete-retry`;
			await env.BLOBS.put(key, 'published');
			await env.CUPBOARD_DB.prepare(
				"INSERT INTO attestation_list_revision (tenant,cache_kind,store_path_hash,generation,revision,published_revision,published_cache_generation,published_nar_hash,published_key,updated_at) VALUES (?,'default',?,0,1,1,1,?,?,'2026-10-12T00:00:00.000Z')"
			)
				.bind(fixtureTenant, hash, narHash, key)
				.run();
			await beginOffboarding();
			await env.CUPBOARD_DB.prepare(
				"CREATE TRIGGER test_refuse_revision_delete BEFORE DELETE ON attestation_list_revision BEGIN SELECT RAISE(ABORT, 'injected revision deletion failure'); END"
			).run();
			try {
				await runInDurableObject(currentServer(), async (instance) => {
					await expect(instance.runOffboard(1)).rejects.toSatisfy(
						(error: unknown) =>
							error instanceof Error &&
							error.cause instanceof Error &&
							error.cause.message.includes('injected revision deletion failure')
					);
					expect(
						instance.context.db
							.select({
								key: schema.attestationListRefreshJobs.key,
								phase: schema.attestationListRefreshJobs.phase
							})
							.from(schema.attestationListRefreshJobs)
							.all()
					).toStrictEqual([{ key, phase: 'cleanup' }]);
				});
				expect({
					revisions: await revisions(),
					objectPresent: (await env.BLOBS.head(key)) !== null
				}).toStrictEqual({
					revisions: [{ generation: 0 }],
					objectPresent: true
				});
			} finally {
				await env.CUPBOARD_DB.prepare(
					'DROP TRIGGER test_refuse_revision_delete'
				).run();
			}
			expect(await currentServer().runOffboard(1)).toStrictEqual({
				drained: true
			});
			expect({
				revisions: await revisions(),
				objectPresent: (await env.BLOBS.head(key)) !== null
			}).toStrictEqual({ revisions: [], objectPresent: false });
		}));

	it('refuses an older controller finalisation while revision rows remain', async () => {
		await initialise();
		await env.CUPBOARD_DB.prepare(
			"INSERT INTO attestation_list_revision (tenant,cache_kind,store_path_hash,generation,updated_at) VALUES (?,'default',?,0,'2026-10-12T00:00:00.000Z')"
		)
			.bind(fixtureTenant, hash)
			.run();
		await env.CUPBOARD_DB.prepare(
			"UPDATE tenant SET status = 'offboarding' WHERE id = ?"
		)
			.bind(fixtureTenant)
			.run();
		await expect(
			env.CUPBOARD_DB.prepare(
				"UPDATE tenant SET status = 'offboarded' WHERE id = ?"
			)
				.bind(fixtureTenant)
				.run()
		).rejects.toThrow('Tenant attestation-list cleanup is still pending');
	});

	it.each(['default', 'named'] as const)(
		'bounds %s revision cleanup beside 25,000 unrelated ready revisions',
		async (kind) => {
			await initialise();
			await env.CUPBOARD_DB.prepare(
				"WITH RECURSIVE numbered(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM numbered WHERE value < 25000) INSERT INTO attestation_list_revision (tenant,cache_kind,cache_name,store_path_hash,generation,published_revision,published_cache_generation,published_nar_hash,updated_at) SELECT 'unrelated', ?, CASE WHEN ? = 'named' THEN 'other-cache' ELSE NULL END, ?, value, 1, 1, ?, '2026-10-12T00:00:00.000Z' FROM numbered"
			)
				.bind(kind, kind, hash, narHash)
				.run();
			await env.CUPBOARD_DB.prepare(
				"INSERT INTO attestation_list_revision (tenant,cache_kind,cache_name,store_path_hash,generation,updated_at) VALUES (?,?,CASE WHEN ? = 'named' THEN 'our-cache' ELSE NULL END,?,0,'2026-10-12T00:00:00.000Z')"
			)
				.bind(fixtureTenant, kind, kind, hash)
				.run();
			await beginOffboarding();
			const reads: number[] = [];
			const observe = (statement: D1PreparedStatement): D1PreparedStatement =>
				new Proxy(statement, {
					get(target, field) {
						if (field === 'bind') {
							return (...values: unknown[]) => observe(target.bind(...values));
						}
						if (field === 'raw') {
							return async () => {
								const result = await target.all();
								reads.push(result.meta.rows_read);
								return result.results.map((row) => Object.values(row));
							};
						}
						if (field === 'run' || field === 'all') {
							return async () => {
								const result = await target[field]();
								reads.push(result.meta.rows_read);
								return result;
							};
						}
						const value: unknown = Reflect.get(target, field, target);
						return typeof value === 'function'
							? (...parameters: unknown[]): unknown =>
									Reflect.apply(value, target, parameters)
							: value;
					}
				});
			const prepare = env.CUPBOARD_DB.prepare.bind(env.CUPBOARD_DB);
			const spy = vi
				.spyOn(env.CUPBOARD_DB, 'prepare')
				.mockImplementation((query) =>
					query.includes('attestation_list_revision')
						? observe(prepare(query))
						: prepare(query)
				);
			try {
				const isDrained = await runInDurableObject(
					currentServer(),
					(instance) =>
						instance.context.criticalSection(() =>
							new AttestationListTeardownService(
								instance.context,
								fixtureTenant
							).advance(1)
						)
				);
				expect(isDrained).toBe(true);
				expect(reads.length).toBeGreaterThan(0);
				expect(
					reads.reduce((total, count) => total + count, 0)
				).toBeLessThanOrEqual(64);
			} finally {
				spy.mockRestore();
			}
			expect(await revisions()).toStrictEqual([]);
		}
	);

	it('does not recreate a retired revision when later reference deletion invalidates the path', async () => {
		await initialise();
		await env.CUPBOARD_DB.prepare(
			"INSERT INTO blob_ref_storage (tenant,cache_kind,store_path_hash,generation,nar_hash,cache_generation,readable) VALUES (?,'default',?,0,?,1,1)"
		)
			.bind(fixtureTenant, hash, narHash)
			.run();
		await beginOffboarding();
		await env.CUPBOARD_DB.prepare(
			'DELETE FROM attestation_list_revision WHERE tenant = ?'
		)
			.bind(fixtureTenant)
			.run();
		await env.CUPBOARD_DB.prepare(
			'DELETE FROM blob_ref_storage WHERE tenant = ?'
		)
			.bind(fixtureTenant)
			.run();
		expect(await revisions()).toStrictEqual([]);
	});
});
