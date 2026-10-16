import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import { currentServer, initialise, resetTestServer } from '../test-support.ts';

describe('native artifact storage constraints', () => {
	beforeEach(async () => {
		await resetTestServer();
		await initialise();
	});

	it.each([
		{ kind: 'default', name: 'invalid' },
		{ kind: 'named', name: undefined }
	])('rejects an inconsistent $kind cache identity', async ({ kind, name }) => {
		const nameExpression = name === undefined ? 'NULL' : '?';
		await expect(
			env.CUPBOARD_DB.prepare(
				`INSERT INTO artifact_ref
				 (tenant, artifact_id, artifact_generation, cache_kind, cache_name,
				  cache_generation, kind, digest, created_at)
				 VALUES ('v1', 'artifact', 1, ?, ${nameExpression}, 1, 'listing', 'digest', '2026-01-01T00:00:00.000Z')`
			)
				.bind(kind, ...(name === undefined ? [] : [name]))
				.run()
		).rejects.toThrow('artifact_ref_cache_identity_check');
	});

	it('deletes only the captured artifact projection generation', async () => {
		await env.CUPBOARD_DB.prepare(
			`INSERT INTO artifact_ref
			 (tenant, artifact_id, artifact_generation, cache_kind, cache_generation,
			  kind, digest, created_at)
			 VALUES ('v1', 'artifact', 1, 'default', 1, 'listing', 'old', '2026-01-01T00:00:00.000Z'),
			        ('v1', 'artifact', 2, 'default', 2, 'listing', 'new', '2026-01-01T00:00:00.000Z')`
		).run();
		await env.CUPBOARD_DB.prepare(
			'DELETE FROM artifact_ref WHERE tenant = ? AND artifact_id = ? AND artifact_generation = ?'
		)
			.bind('v1', 'artifact', 1)
			.run();
		const { results } = await env.CUPBOARD_DB.prepare(
			'SELECT artifact_generation AS generation, cache_generation AS cacheGeneration, digest FROM artifact_ref'
		).all();
		expect(results).toStrictEqual([
			{ generation: 2, cacheGeneration: 2, digest: 'new' }
		]);
	});

	it.each([
		{
			kind: 'build-log',
			state: 'pending',
			constraint: 'artifact_log_expiry_check'
		},
		{
			kind: 'listing',
			state: 'live',
			constraint: 'artifact_completion_check'
		}
	])('rejects $constraint', async ({ kind, state, constraint }) => {
		await runInDurableObject(currentServer(), (_instance, durableState) => {
			expect(() =>
				durableState.storage.sql.exec(
					`INSERT INTO artifact
					 (id, cache_id, generation, kind, digest, publication_incarnation,
					  state, created_at)
					 VALUES ('artifact', 1, 1, ?, 'digest', 1, ?, '2026-01-01T00:00:00.000Z')`,
					kind,
					state
				)
			).toThrow(constraint);
		});
	});

	it.each([
		{ kind: 'expiry', expiresAt: undefined },
		{ kind: 'cache-lifetime', expiresAt: '2026-02-01T00:00:00.000Z' }
	])('rejects an inconsistent $kind root', async ({ kind, expiresAt }) => {
		await runInDurableObject(currentServer(), (_instance, durableState) => {
			expect(() =>
				durableState.storage.sql.exec(
					`INSERT INTO artifact_root (artifact_id, artifact_generation, kind, expires_at) VALUES (?, 1, ?, ${expiresAt === undefined ? 'NULL' : '?'})`,
					'artifact',
					kind,
					...(expiresAt === undefined ? [] : [expiresAt])
				)
			).toThrow('artifact_root_expiry_check');
		});
	});
});
