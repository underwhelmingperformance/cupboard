import {
	authorizationDetailsSchema,
	storedPermittedGrantsSchema
} from '@cupboard/protocol/grants';
import { runInDurableObject } from 'cloudflare:test';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { grantContractionBatchSize } from '../migration/cache-grants.ts';
import {
	bootstrap,
	currentServer,
	recordTransition,
	resetTestServer
} from '../test-support.ts';

import { StoredGrantSpelling } from './stored-grant-spelling.ts';

const selectorGrant = JSON.stringify([
	{
		type: 'cupboard_cache',
		actions: ['upload:commit'],
		resources: { cache: { exact: '_private-ci', validate: 'cacheName' } }
	}
]);
const scopeGrant = JSON.stringify([
	{
		type: 'cupboard_cache',
		actions: ['upload:commit'],
		resources: { cache: { kind: 'named', exact: 'ci', validate: 'cacheName' } }
	}
]);

describe('local grant contraction', () => {
	beforeEach(resetTestServer);
	it('keeps selector grants through expansion and rewrites them once contracted', async () => {
		await recordTransition('cache-identity', 'expanded');
		await bootstrap();
		const before = await runInDurableObject(
			currentServer(),
			async (instance) => {
				instance.context.db.run(
					sql`INSERT INTO oidc_trust (id, issuer, audience, permitted_grants_json, created_at) VALUES ('legacy', 'https://issuer.example', 'https://cache.example', ${selectorGrant}, '2026-01-01T00:00:00.000Z')`
				);
				const progress = await instance.reportLocalStep();
				return {
					progress,
					grants: instance.context.db.get<{ grants: string }>(
						sql`SELECT permitted_grants_json AS grants FROM oidc_trust WHERE id = 'legacy'`
					).grants
				};
			}
		);
		await recordTransition('cache-identity', 'complete');
		const after = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const progress = await instance.reportLocalStep();
				return {
					progress,
					grants: instance.context.db.get<{ grants: string }>(
						sql`SELECT permitted_grants_json AS grants FROM oidc_trust WHERE id = 'legacy'`
					).grants
				};
			}
		);
		expect({ before, after }).toStrictEqual({
			before: {
				progress: { kind: 'recorded', step: 4, progressed: true },
				grants: selectorGrant
			},
			after: {
				progress: { kind: 'recorded', step: 5, progressed: true },
				grants: scopeGrant
			}
		});
	});
});

describe('writes across local grant contraction', () => {
	beforeEach(resetTestServer);
	it('canonicalises a prepared rule and refresh family at the write after contraction', async () => {
		await recordTransition('cache-identity', 'expanded');
		await bootstrap();
		const result = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const spelling = new StoredGrantSpelling(instance.context);
				const rule = await spelling.permittedGrantsJson(
					storedPermittedGrantsSchema.parse(JSON.parse(selectorGrant))
				);
				const grants = authorizationDetailsSchema.parse([
					{
						type: 'cupboard_cache',
						actions: ['upload:commit'],
						cache: { kind: 'named', name: 'ci' }
					}
				]);
				const family = await spelling.authorizationDetailsJson(grants);
				await recordTransition('cache-identity', 'complete');
				await instance.reportLocalStep();
				const writtenRule: unknown = JSON.parse(
					spelling.permittedGrantsForWrite(rule)
				);
				const writtenFamily: unknown = JSON.parse(
					spelling.authorizationDetailsForWrite(family)
				);
				return { rule: writtenRule, family: writtenFamily };
			}
		);
		expect(result).toStrictEqual({
			rule: storedPermittedGrantsSchema.parse(JSON.parse(scopeGrant)),
			family: [
				{
					type: 'cupboard_cache',
					actions: ['upload:commit'],
					cache: { kind: 'named', name: 'ci' }
				}
			]
		});
	});
	it.each(['insert', 'update'] as const)(
		'rejects a selector-shaped %s after contraction',
		async (operation) => {
			await recordTransition('cache-identity', 'complete');
			await bootstrap();
			await runInDurableObject(currentServer(), async (instance, state) => {
				await instance.reportLocalStep();
				const insert =
					"INSERT INTO oidc_trust (id, issuer, audience, permitted_grants_json, created_at) VALUES ('late', 'https://issuer.example', 'https://cache.example', ?, '2026-01-01T00:00:00.000Z')";
				if (operation === 'update') {
					state.storage.sql.exec(insert, scopeGrant);
				}
				const statement =
					operation === 'insert'
						? insert
						: "UPDATE oidc_trust SET permitted_grants_json = ? WHERE id = 'late'";
				expect(() => state.storage.sql.exec(statement, selectorGrant)).toThrow(
					'scope spelling'
				);
			});
		}
	);
	it('continues the rewrite over bounded batches before recording completion', async () => {
		await recordTransition('cache-identity', 'expanded');
		await bootstrap();
		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const insert =
					"INSERT INTO oidc_trust (id, issuer, audience, permitted_grants_json, created_at) VALUES (?, 'https://issuer.example', 'https://cache.example', ?, '2026-01-01T00:00:00.000Z')";
				for (let index = 0; index <= grantContractionBatchSize; index += 1) {
					state.storage.sql.exec(
						insert,
						`legacy-${String(index)}`,
						selectorGrant
					);
				}
				await recordTransition('cache-identity', 'complete');
				const first = await instance.reportLocalStep();
				const afterFirst = state.storage.sql
					.exec('SELECT complete FROM grant_contraction')
					.one();
				const second = await instance.reportLocalStep();
				const afterSecond = state.storage.sql
					.exec('SELECT complete FROM grant_contraction')
					.one();
				return { first, afterFirst, second, afterSecond };
			}
		);
		expect(result).toStrictEqual({
			first: {
				kind: 'incomplete',
				projected: grantContractionBatchSize,
				progressed: true
			},
			afterFirst: { complete: 0 },
			second: { kind: 'recorded', step: 5, progressed: true },
			afterSecond: { complete: 1 }
		});
	});
});
