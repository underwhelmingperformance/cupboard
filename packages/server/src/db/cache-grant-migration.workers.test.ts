import { trustRuleIdSchema } from '@cupboard/protocol/oidc';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { describe, expect, it } from 'vitest';

import * as d1Schema from './d1-schema.ts';

const migrationName = '0029_cache_grant_contract.sql';
const createdAt = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');

function ruleGrant(cache: unknown): string {
	return JSON.stringify([
		{ type: 'cupboard_cache', actions: ['upload:commit'], resources: { cache } }
	]);
}

// The setup file has already applied the migration to the empty database.
// Running its statements again over seeded rows is the rewrite under test.
describe('D1 migration 0029_cache_grant_contract', () => {
	it('rewrites the cache selectors stored in a control trust rule', async () => {
		const migration = env.TEST_MIGRATIONS.find(
			(candidate) => candidate.name === migrationName
		);

		if (migration === undefined) {
			throw new Error(`${migrationName} is not among the test migrations`);
		}

		const triggers = migration.queries.filter((query) =>
			query.includes('CREATE TRIGGER')
		);
		await env.CUPBOARD_DB.batch(
			['insert', 'update'].map((operation) =>
				env.CUPBOARD_DB.prepare(
					`DROP TRIGGER control_trust_native_grants_${operation}`
				)
			)
		);
		try {
			const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
			const stored: [string, unknown][] = [
				['named', { exact: 'ci', validate: 'cacheName' }],
				['default', { exact: '_default', validate: 'cacheName' }],
				['private', { exact: '_private-ci', validate: 'cacheName' }],
				[
					'templated',
					{
						equalsTemplate: '_private-pr-{n}',
						substitutions: { n: { claim: 'ref' } },
						validate: 'cacheName'
					}
				],
				['uppercase', { exact: '_PRIVATE-ci', validate: 'cacheName' }],
				['native', { kind: 'named', exact: 'ci', validate: 'cacheName' }]
			];

			await database.insert(d1Schema.controlTrust).values([
				...stored.map(([id, cache]) => ({
					id: trustRuleIdSchema.parse(id),
					issuer: 'https://issuer.example',
					audience: 'https://cache.example',
					permittedGrantsJson: ruleGrant(cache),
					createdAt
				})),
				{
					id: trustRuleIdSchema.parse('wildcard-only'),
					issuer: 'https://issuer.example',
					audience: 'https://cache.example',
					createdAt
				}
			]);

			await env.CUPBOARD_DB.batch(
				migration.queries.map((query) => env.CUPBOARD_DB.prepare(query))
			);

			const rows = await database
				.select({
					id: d1Schema.controlTrust.id,
					permittedGrantsJson: d1Schema.controlTrust.permittedGrantsJson
				})
				.from(d1Schema.controlTrust)
				.orderBy(d1Schema.controlTrust.id)
				.all();
			const namedCi = { exact: 'ci', validate: 'cacheName', kind: 'named' };

			expect(rows).toStrictEqual([
				{ id: 'default', permittedGrantsJson: ruleGrant({ kind: 'default' }) },
				{ id: 'named', permittedGrantsJson: ruleGrant(namedCi) },
				{
					id: 'native',
					permittedGrantsJson: ruleGrant({
						kind: 'named',
						exact: 'ci',
						validate: 'cacheName'
					})
				},
				{ id: 'private', permittedGrantsJson: ruleGrant(namedCi) },
				{
					id: 'templated',
					permittedGrantsJson: ruleGrant({
						equalsTemplate: 'pr-{n}',
						substitutions: { n: { claim: 'ref' } },
						validate: 'cacheName',
						kind: 'named'
					})
				},
				{
					id: 'uppercase',
					permittedGrantsJson: ruleGrant({
						exact: '_PRIVATE-ci',
						validate: 'cacheName',
						kind: 'named'
					})
				},
				{
					id: 'wildcard-only',
					permittedGrantsJson: JSON.stringify([{ type: 'cupboard_wildcard' }])
				}
			]);
		} finally {
			await env.CUPBOARD_DB.batch(
				triggers.map((query) =>
					env.CUPBOARD_DB.prepare(
						query.replace('CREATE TRIGGER', 'CREATE TRIGGER IF NOT EXISTS')
					)
				)
			);
		}
	});
});

describe('contracted control-trust writes', () => {
	it.each(['insert', 'update'] as const)(
		'rejects an old-shaped %s',
		async (operation) => {
			const insert =
				"INSERT INTO control_trust (id, issuer, audience, permitted_grants_json, created_at) VALUES ('late', 'https://issuer.example', 'https://cache.example', ?, '2026-01-01T00:00:00.000Z')";
			if (operation === 'update') {
				await env.CUPBOARD_DB.prepare(insert)
					.bind(ruleGrant({ kind: 'default' }))
					.run();
			}
			const statement =
				operation === 'insert'
					? insert
					: "UPDATE control_trust SET permitted_grants_json = ? WHERE id = 'late'";
			await expect(
				env.CUPBOARD_DB.prepare(statement)
					.bind(ruleGrant({ exact: '_default', validate: 'cacheName' }))
					.run()
			).rejects.toThrow('scope spelling');
		}
	);
});
