import { cacheSummarySchema } from '@cupboard/protocol/caches';
import { runInDurableObject } from 'cloudflare:test';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema.ts';
import {
	authorisedFetch,
	bootstrap,
	currentServer,
	resetTestServer,
	useTestServer
} from '../test-support.ts';

import {
	advanceCacheRetentionMigration,
	CacheRetentionMigrationError,
	maximumLegacyRetentionRules,
	retentionMigrationBatchSize
} from './cache-retention.ts';

// One more prefix rule than the migration will import. Every row carries a
// distinct prefix that the new representation can hold, so none is discarded
// and the seeded count is the count that reaches the bound.
const seededRuleCount = maximumLegacyRetentionRules + 1;

const seedLegacyRules = `
	WITH RECURSIVE counter(n) AS (
		SELECT 1 UNION ALL SELECT n + 1 FROM counter WHERE n < ${seededRuleCount.toString()}
	)
	INSERT INTO retention_policy (
		id, scope, pattern, kind, cache_id, root_name_prefix,
		default_ttl_seconds, created_at
	)
	SELECT
		printf('rule-%06d', n),
		'root-name-prefix',
		printf('p%06d/', n),
		'root-name-prefix',
		NULL,
		printf('p%06d/', n),
		60,
		'2026-01-01T00:00:00.000Z'
	FROM counter`;

// The migration stages one batch of rules per call, so the refusal arrives
// several calls in. Two spare batches stop a broken bound from looping instead
// of failing the assertion.
const maximumBatches =
	Math.ceil(seededRuleCount / retentionMigrationBatchSize) + 2;

describe('the legacy retention migration bound', () => {
	beforeEach(resetTestServer);

	it('refuses a tenant holding more legacy prefix rules than it will import', async () => {
		await useTestServer('cache-retention-rule-bound');
		await bootstrap();

		const outcome = await runInDurableObject(
			currentServer(),
			async (instance) => {
				instance.context.db.run(sql.raw(seedLegacyRules));

				const refusal = await (async (): Promise<unknown> => {
					for (let batch = 0; batch < maximumBatches; batch += 1) {
						try {
							const advanced = await advanceCacheRetentionMigration(
								instance.context.db
							);

							if (advanced.status === 'complete') {
								return { completed: advanced };
							}
						} catch (error) {
							return error;
						}
					}

					return { batchesWithoutOutcome: maximumBatches };
				})();

				return {
					refusal,
					// The bound is a preflight: it stops the import before any cache
					// takes retention from it.
					caches: instance.context.db
						.select({
							defaultRootTtlSeconds:
								schema.cacheIdentities.defaultRootTtlSeconds,
							rootRetentionRuleSetId:
								schema.cacheIdentities.rootRetentionRuleSetId
						})
						.from(schema.cacheIdentities)
						.all()
						.map((row) => ({
							defaultRootTtlSeconds: row.defaultRootTtlSeconds ?? undefined,
							rootRetentionRuleSetId: row.rootRetentionRuleSetId
						})),
					ruleSets: await instance.context.db.$count(
						schema.rootRetentionRuleSets
					)
				};
			}
		);

		expect(outcome.refusal).toBeInstanceOf(CacheRetentionMigrationError);
		expect({
			caches: outcome.caches,
			ruleSets: outcome.ruleSets
		}).toStrictEqual({
			caches: [{ defaultRootTtlSeconds: undefined, rootRetentionRuleSetId: 1 }],
			ruleSets: 1
		});
	});
});

describe('retention settings during migration', () => {
	beforeEach(resetTestServer);
	it.each([
		{
			method: 'PATCH',
			path: '/cache',
			body: { kind: 'set-default-root-ttl', retention: { kind: 'permanent' } }
		},
		{
			method: 'PATCH',
			path: '/cache',
			body: {
				kind: 'set-root-ttl-override',
				rootPrefix: 'ci/',
				retention: { kind: 'duration', seconds: 60 }
			}
		},
		{
			method: 'PATCH',
			path: '/cache',
			body: { kind: 'clear-root-ttl-override', rootPrefix: 'ci/' }
		},
		{ method: 'PATCH', path: '/cache', body: { kind: 'clear-grace' } },
		{
			method: 'PUT',
			path: '/caches/builds',
			body: {
				access: 'public',
				priority: 40,
				defaultRootRetention: { kind: 'duration', seconds: 60 }
			}
		},
		{
			method: 'PUT',
			path: '/caches/builds',
			body: {
				access: 'public',
				priority: 40,
				grace: { kind: 'duration', graceSeconds: 60 }
			}
		}
	])(
		'refuses $method $path with $body during import',
		async ({ method, path, body }) => {
			const { token } = await bootstrap();
			await runInDurableObject(currentServer(), (instance) => {
				instance.context.db.run(
					sql`INSERT INTO retention_grace_policy (id, cache_prefix, grace_seconds, created_at) VALUES ('legacy-grace', '', 3600, '2026-01-01T00:00:00.000Z')`
				);
			});
			const response = await authorisedFetch(path, token, {
				method,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({
				code: 'CACHE_RETENTION_MIGRATION_PENDING'
			});
		}
	);

	it.each([true, false])(
		'preserves a new grace setting with legacy policies=%s',
		async (hasLegacyPolicies) => {
			const { token } = await bootstrap();
			if (hasLegacyPolicies) {
				await runInDurableObject(currentServer(), (instance) => {
					instance.context.db.run(
						sql`INSERT INTO retention_grace_policy (id, cache_prefix, grace_seconds, created_at) VALUES ('legacy-grace', '', 3600, '2026-01-01T00:00:00.000Z')`
					);
				});
			}
			const beforeResponse = await authorisedFetch('/cache', token);
			const before = cacheSummarySchema.parse(await beforeResponse.json());
			const setGrace = () =>
				authorisedFetch('/cache', token, {
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ kind: 'set-grace', graceSeconds: 60 })
				});
			const first = await setGrace();
			expect(first.status).toBe(hasLegacyPolicies ? 409 : 200);
			await runInDurableObject(currentServer(), async (instance) => {
				const result = await advanceCacheRetentionMigration(
					instance.context.db
				);
				expect(result).toStrictEqual({
					status: 'complete',
					discardedRuleCount: 0
				});
			});
			if (hasLegacyPolicies) {
				const retried = await setGrace();
				expect(retried.status).toBe(200);
			}
			const afterResponse = await authorisedFetch('/cache', token);
			const after = cacheSummarySchema.parse(await afterResponse.json());
			expect(after).toStrictEqual({
				...before,
				grace: { kind: 'duration', graceSeconds: 60 }
			});
		}
	);
});

describe('legacy retention migration recovery', () => {
	beforeEach(resetTestServer);
	it('removes an imported grace setting when the last legacy policy is removed before completion', async () => {
		const { token } = await bootstrap();
		await runInDurableObject(currentServer(), async (instance) => {
			instance.context.db.run(
				sql`INSERT INTO retention_grace_policy (id, cache_prefix, grace_seconds, created_at) VALUES ('legacy-grace', '', 3600, '2026-01-01T00:00:00.000Z')`
			);
			expect(
				await advanceCacheRetentionMigration(instance.context.db, 1)
			).toStrictEqual({ status: 'pending' });
		});
		const response = await authorisedFetch(
			'/policies/grace/legacy-grace',
			token,
			{ method: 'DELETE' }
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toStrictEqual({
			id: 'legacy-grace',
			removed: true
		});
		const edit = await authorisedFetch('/cache', token, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ kind: 'set-grace', graceSeconds: 60 })
		});
		expect(edit.status).toBe(409);
		await runInDurableObject(currentServer(), async (instance) => {
			expect(
				await advanceCacheRetentionMigration(instance.context.db)
			).toStrictEqual({ status: 'complete', discardedRuleCount: 0 });
		});
		const cacheResponse = await authorisedFetch('/cache', token);
		const cache = cacheSummarySchema.parse(await cacheResponse.json());
		expect(cache.grace).toStrictEqual({ kind: 'none' });
		const list = await authorisedFetch('/policies/grace', token);
		expect(await list.json()).toStrictEqual({ policies: [] });
		const repeated = await authorisedFetch(
			'/policies/grace/legacy-grace',
			token,
			{ method: 'DELETE' }
		);
		expect(await repeated.json()).toStrictEqual({
			id: 'legacy-grace',
			removed: false
		});
	});

	it('restarts an over-limit import after removing a legacy policy', async () => {
		const { token } = await bootstrap();
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db.run(sql.raw(seedLegacyRules));
		});
		const advanceToCompletion = () =>
			runInDurableObject(currentServer(), async (instance) => {
				for (let batch = 0; batch < maximumBatches; batch += 1) {
					const result = await advanceCacheRetentionMigration(
						instance.context.db
					);
					if (result.status === 'complete') {
						return result;
					}
				}
				throw new Error(
					'The retention migration did not complete within the expected number of batches'
				);
			});
		await expect(advanceToCompletion()).rejects.toBeInstanceOf(
			CacheRetentionMigrationError
		);
		const response = await authorisedFetch('/policies/rule-000001', token, {
			method: 'DELETE'
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toStrictEqual({
			id: 'rule-000001',
			removed: true
		});
		await expect(advanceToCompletion()).resolves.toStrictEqual({
			status: 'complete',
			discardedRuleCount: 0
		});
		const counts = await runInDurableObject(
			currentServer(),
			async (instance) => ({
				legacy: await instance.context.db.$count(
					schema.legacyRetentionPolicies
				),
				staged: await instance.context.db.$count(
					schema.retentionMigrationRules
				),
				imported: await instance.context.db.$count(schema.rootRetentionRules)
			})
		);
		expect(counts).toStrictEqual({
			legacy: maximumLegacyRetentionRules,
			staged: 0,
			imported: maximumLegacyRetentionRules
		});
	});
});
