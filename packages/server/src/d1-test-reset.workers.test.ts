import { env } from 'cloudflare:workers';
import { getTableName, is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { expect, it, vi } from 'vitest';

import { resetD1TestState } from './d1-test-reset.ts';
import * as schema from './db/d1-schema.ts';

it('clears shared D1 facts and restores the completed transition in one batch', async () => {
	await env.CUPBOARD_DB.batch([
		env.CUPBOARD_DB.prepare(
			"INSERT INTO tenant (id, status, owner_issuer, owner_subject, owner_audience, config_version, created_at) VALUES ('reset-tenant', 'active', 'issuer', 'subject', 'audience', 1, '2025-01-01T00:00:00.000Z')"
		),
		env.CUPBOARD_DB.prepare(
			"INSERT INTO tenant_usage (tenant, bytes, narinfos, blobs, updated_at) VALUES ('reset-tenant', 100, 2, 1, '2025-01-01T00:00:00.000Z')"
		),
		env.CUPBOARD_DB.prepare(
			"INSERT INTO local_step_wake_cursor (id, after_tenant) VALUES (1, 'reset-tenant')"
		),
		env.CUPBOARD_DB.prepare(
			"INSERT INTO object_incarnation (kind, object_id, incarnation, state) VALUES ('nar', 'reset-object', 1, 'absent')"
		),
		env.CUPBOARD_DB.prepare(
			"UPDATE deployment_transition SET state = 'pending', updated_at = '2025-01-01T00:00:00.000Z'"
		),
		env.CUPBOARD_DB.prepare(
			"INSERT OR REPLACE INTO instance_config (id, name, created_at) VALUES ('singleton', 'cupboard', '2025-01-01T00:00:00.000Z')"
		)
	]);

	const batch = vi.spyOn(env.CUPBOARD_DB, 'batch');
	try {
		await resetD1TestState(env.CUPBOARD_DB);
		expect(batch).toHaveBeenCalledTimes(1);
	} finally {
		batch.mockRestore();
	}

	const tables = Object.values(schema).filter((value) =>
		is(value, SQLiteTable)
	);
	const counts = await Promise.all(
		tables.map(async (table) => {
			const name = getTableName(table);
			const count = await env.CUPBOARD_DB.prepare(
				`SELECT count(*) AS count FROM "${name}"`
			).first<number>('count');
			return [name, count] as const;
		})
	);
	expect(Object.fromEntries(counts)).toStrictEqual({
		instance_config: 1,
		object_incarnation: 0,
		object_deletion: 0,
		blob_state: 0,
		blob_ref_storage: 0,
		path_read_revocation: 0,
		publication: 0,
		cache_lifecycle_storage: 0,
		control_auth_key: 0,
		control_trust: 0,
		tenant: 0,
		tenant_cache_read_credential: 0,
		tenant_maintenance_failure: 0,
		tenant_maintenance_eligibility: 0,
		deployment_transition: 1,
		deployment_phase: 0,
		manifest_state: 0,
		global_admin: 0,
		tenant_blob: 0,
		cas_object: 0,
		attestation_ref_storage: 0,
		tenant_cas_blob: 0,
		tenant_usage: 0,
		local_step_wake_cursor: 0
	});
	const transition = await env.CUPBOARD_DB.prepare(
		'SELECT id, state, updated_at, contracted_at IS NULL AS uncontracted FROM deployment_transition'
	).all();
	expect(transition.results).toStrictEqual([
		{
			id: 'blob-reference-read-authority',
			state: 'complete',
			updated_at: '2026-01-01T00:00:00.000Z',
			uncontracted: 1
		}
	]);
});
