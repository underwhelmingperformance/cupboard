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

import { ensureRetentionRuleSet } from './retention-rule-service.ts';

describe('retention rule sets', () => {
	beforeEach(resetTestServer);

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
