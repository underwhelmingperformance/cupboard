import { runInDurableObject } from 'cloudflare:test';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema.ts';
import {
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
