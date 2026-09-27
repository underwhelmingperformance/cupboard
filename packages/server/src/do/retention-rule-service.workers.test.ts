import {
	rootNameSchema,
	sha256HexDigestSchema,
	ttlSecondsSchema
} from '@cupboard/nix-store/scalars';
import type { RootRetentionOverride } from '@cupboard/protocol/caches';
import { runInDurableObject } from 'cloudflare:test';
import { asc, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema.ts';
import { bootstrap, currentServer, resetTestServer } from '../test-support.ts';

import {
	ensureRetentionRuleSet,
	RetentionRuleService
} from './retention-rule-service.ts';

describe('retention rule sets', () => {
	beforeEach(resetTestServer);

	it('refuses a rule set larger than the supported legacy import', async () => {
		await bootstrap();
		const rules: RootRetentionOverride[] = Array.from(
			{ length: 4096 },
			(_, index) => ({
				rootPrefix: rootNameSchema.parse(`root-${String(index)}`),
				retention: { kind: 'permanent' }
			})
		);

		await expect(
			runInDurableObject(currentServer(), async (instance) => {
				const { db, cacheRepository } = instance.context;
				const ruleSetId = await ensureRetentionRuleSet(db, rules);
				const cache = cacheRepository.require({ kind: 'default' });
				db.update(schema.cacheIdentities)
					.set({ rootRetentionRuleSetId: ruleSetId })
					.where(eq(schema.cacheIdentities.id, cache.id))
					.run();
				await new RetentionRuleService(instance.context).setRule(
					cache,
					rootNameSchema.parse('overflow'),
					{ kind: 'permanent' }
				);
			})
		).rejects.toThrow('at most 4096 root retention overrides');
	});

	it('replaces the rule for a prefix that is set again', async () => {
		await bootstrap();
		const rules = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const service = new RetentionRuleService(instance.context);
				const cache = instance.context.cacheRepository.require({
					kind: 'default'
				});
				const prefix = rootNameSchema.parse('ci/');

				await service.setRule(cache, prefix, {
					kind: 'duration',
					seconds: ttlSecondsSchema.parse(3600)
				});
				await service.setRule(cache, prefix, {
					kind: 'duration',
					seconds: ttlSecondsSchema.parse(7200)
				});

				return service.listForCache(cache);
			}
		);

		expect(rules).toStrictEqual([
			{
				rootPrefix: 'ci/',
				retention: { kind: 'duration', seconds: 7200 }
			}
		]);
	});

	it('compares canonical rules before reusing a matching content hash', async () => {
		await bootstrap();
		const result = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const contentHash = sha256HexDigestSchema.parse('a'.repeat(64));
				const digest = () => Promise.resolve(contentHash);
				const firstRules: RootRetentionOverride[] = [
					{
						rootPrefix: rootNameSchema.parse('ci/'),
						retention: {
							kind: 'duration',
							seconds: ttlSecondsSchema.parse(3600)
						}
					}
				];
				const secondRules: RootRetentionOverride[] = [
					{
						rootPrefix: rootNameSchema.parse('release/'),
						retention: { kind: 'permanent' }
					}
				];
				const first = await ensureRetentionRuleSet(
					instance.context.db,
					firstRules,
					digest
				);
				const second = await ensureRetentionRuleSet(
					instance.context.db,
					secondRules,
					digest
				);
				const repeated = await ensureRetentionRuleSet(
					instance.context.db,
					firstRules,
					digest
				);

				return {
					ids: { first, second, repeated },
					sets: instance.context.db
						.select({
							id: schema.rootRetentionRuleSets.id,
							contentHash: schema.rootRetentionRuleSets.contentHash
						})
						.from(schema.rootRetentionRuleSets)
						.where(eq(schema.rootRetentionRuleSets.contentHash, contentHash))
						.orderBy(asc(schema.rootRetentionRuleSets.id))
						.all(),
					rules: instance.context.db
						.select()
						.from(schema.rootRetentionRules)
						.orderBy(
							asc(schema.rootRetentionRules.ruleSetId),
							asc(schema.rootRetentionRules.rootPrefix)
						)
						.all()
				};
			}
		);

		expect({
			...result,
			rules: result.rules.map((rule) => ({
				...rule,
				ttlSeconds: rule.ttlSeconds ?? undefined
			}))
		}).toStrictEqual({
			ids: { first: 2, second: 3, repeated: 2 },
			sets: [
				{ id: 2, contentHash: 'a'.repeat(64) },
				{ id: 3, contentHash: 'a'.repeat(64) }
			],
			rules: [
				{
					ruleSetId: 2,
					rootPrefix: 'ci/',
					kind: 'duration',
					ttlSeconds: 3600
				},
				{
					ruleSetId: 3,
					rootPrefix: 'release/',
					kind: 'permanent',
					ttlSeconds: undefined
				}
			]
		});
	});
});
