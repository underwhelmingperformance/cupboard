import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq, getTableName, is, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { expect, it, vi } from 'vitest';

import { testControlDatabase } from './control-database.test-support.ts';
import { resetControlD1TestState, resetD1TestState } from './d1-test-reset.ts';
import * as schema from './db/d1-schema.ts';
import { fixtureTenant } from './routing/tenant-routing.test-support.ts';
import {
	configureFixtureTenants,
	currentServer,
	provisionFixtureTenant,
	resetTestServer
} from './test-support.ts';

it('clears shared D1 facts and restores the completed transition in one batch', async () => {
	await env.CUPBOARD_DB.batch([
		env.CUPBOARD_DB.prepare(
			'INSERT INTO shared_listing_dispatch_seed (id, is_complete) VALUES (1, 1)'
		),
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
			"INSERT INTO control_refresh_session_family (id, active_member_id, generation, created_at, expires_at, issuer, subject) VALUES ('reset-family', 'reset-member', 0, '2025-01-01T00:00:00.000Z', '2025-01-31T00:00:00.000Z', 'https://issuer.example', 'subject')"
		),
		env.CUPBOARD_DB.prepare(
			"INSERT INTO control_refresh_session_member (id, family_id, generation, credential_hash, created_at) VALUES ('reset-member', 'reset-family', 0, 'hash', '2025-01-01T00:00:00.000Z')"
		),
		env.CUPBOARD_DB.prepare(
			"INSERT INTO control_consumed_subject_nonce (nonce, expires_at) VALUES ('reset-nonce', '2025-01-01T00:05:00.000Z')"
		),
		env.CUPBOARD_DB.prepare(
			"INSERT INTO object_incarnation (kind, object_id, incarnation, state) VALUES ('nar', 'reset-object', 1, 'absent')"
		),
		env.CUPBOARD_DB.prepare(
			"INSERT INTO artifact_ref (tenant, artifact_id, artifact_generation, cache_kind, cache_generation, kind, digest, created_at) VALUES ('reset-tenant', 'reset-artifact', 1, 'default', 1, 'listing', 'reset-digest', '2025-01-01T00:00:00.000Z')"
		),
		env.CUPBOARD_DB.prepare(
			"INSERT INTO listing_fact (nar_hash, generator_revision, format, digest, size, created_at) VALUES ('reset-nar', 'reset-generator', 1, 'reset-digest', 100, '2025-01-01T00:00:00.000Z')"
		),
		env.CUPBOARD_DB.prepare(
			"INSERT INTO listing_generation (nar_hash, generator_revision, source_incarnation, generation, tenant, owner, lease_expires_at, updated_at) VALUES ('reset-nar', 'reset-generator', 1, 1, 'reset-tenant', 'reset-owner', '2025-01-01T00:01:00.000Z', '2025-01-01T00:00:00.000Z')"
		),
		env.CUPBOARD_DB.prepare(
			"INSERT INTO shared_listing_job (id, generator_revision, created_at, updated_at) VALUES ('reset-job', 'reset-generator', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')"
		),
		env.CUPBOARD_DB.prepare(
			"INSERT INTO shared_listing_task (id, job_id, nar_hash, source_incarnation, nar_size, file_size, discovery_page, created_at) VALUES ('reset-task', 'reset-job', 'reset-nar', 1, 100, 50, 'reset-page', '2025-01-01T00:00:00.000Z')"
		),
		env.CUPBOARD_DB.prepare(
			`INSERT INTO shared_listing_task_outcome (task_id, job_id, job_generation, task_generation, owner, claim, completion_id, kind, reason, completed_at) VALUES ('reset-task', 'reset-job', 1, 1, 'reset-owner', '{"id":"reset-task","job":{"id":"reset-job","generation":1},"generation":1,"owner":"reset-owner"}', 'reset-completion', 'skipped', 'source-unavailable', '2025-01-01T00:00:00.000Z')`
		),
		env.CUPBOARD_DB.prepare(
			"INSERT INTO shared_listing_generation (nar_hash, generator_revision, source_incarnation, generation, job_id, job_generation, task_id, task_generation, updated_at) VALUES ('reset-nar', 'reset-generator', 1, 1, 'reset-job', 1, 'reset-task', 1, '2025-01-01T00:00:00.000Z')"
		),
		env.CUPBOARD_DB.prepare(
			"INSERT INTO shared_listing_stage (id, nar_hash, generator_revision, source_incarnation, computation_generation, r2_key, maximum_bytes, state, created_at, expires_at, write_until, cleanup_after, next_cleanup_at) VALUES ('reset-stage', 'reset-nar', 'reset-generator', 1, 1, 'shared-artifact-staging/reset-stage', 67108864, 'pending', '2025-01-01T00:00:00.000Z', '2025-01-01T00:01:00.000Z', '2025-01-01T00:15:00.000Z', '2025-01-01T01:26:00.000Z', '2025-01-01T00:01:00.000Z')"
		),
		env.CUPBOARD_DB.prepare(
			"INSERT INTO shared_listing_output_ref (nar_hash, generator_revision, epoch, source_incarnation, computation_generation, digest, size, created_at) VALUES ('reset-nar', 'reset-generator', '00000000-0000-4000-8000-000000000001', 1, 1, 'reset-digest', 100, '2025-01-01T00:00:00.000Z')"
		),
		env.CUPBOARD_DB.prepare(
			"INSERT INTO shared_listing_output_cleanup (nar_hash) VALUES ('reset-nar')"
		),
		env.CUPBOARD_DB.prepare(
			"INSERT INTO nar_capture_event (nar_hash, source_incarnation) VALUES ('reset-nar', 1)"
		),
		env.CUPBOARD_DB.prepare(
			'UPDATE nar_capture_state SET pruned_through = latest, is_ready = 0 WHERE id = 1'
		),
		env.CUPBOARD_DB.prepare(
			'UPDATE listing_adoption_capture_state SET pruned_through = latest, is_ready = 0 WHERE id = 1'
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
		control_database_split: 0,
		control_consumed_subject_nonce: 0,
		control_trust: 0,
		control_refresh_session_family: 0,
		control_refresh_session_member: 0,
		tenant: 0,
		tenant_cache_read_credential: 0,
		tenant_maintenance_failure: 0,
		tenant_maintenance_eligibility: 0,
		deployment_transition: 1,
		deployment_phase: 0,
		manifest_state: 0,
		global_admin: 0,
		tenant_blob: 0,
		cas_object_storage: 0,
		cas_demotion_progress: 0,
		attestation_ref_storage: 0,
		attestation_list_revision: 0,
		artifact_ref: 0,
		listing_fact: 0,
		listing_adoption_fact: 0,
		listing_adoption_capture_event: 0,
		listing_adoption_capture_state: 1,
		listing_generation: 0,
		shared_listing_generation: 0,
		shared_listing_stage: 0,
		shared_listing_output_ref: 0,
		shared_listing_output_cleanup: 0,
		shared_listing_job: 0,
		shared_listing_job_dispatch: 0,
		shared_listing_dispatch_seed: 0,
		shared_listing_task: 0,
		shared_listing_task_delivery: 0,
		shared_listing_task_outcome: 0,
		nar_capture_event: 0,
		nar_capture_state: 1,
		tenant_cas_blob_storage: 0,
		tenant_usage: 0,
		tenant_namespace_cleanup_guard: 0,
		local_step_wake_cursor: 0
	});
	expect(
		await drizzle(env.CUPBOARD_DB, { schema })
			.select()
			.from(schema.narCaptureState)
	).toStrictEqual([{ id: 1, latest: 0, prunedThrough: 0, isReady: true }]);
	expect(
		await drizzle(env.CUPBOARD_DB, { schema })
			.select()
			.from(schema.listingAdoptionCaptureState)
	).toStrictEqual([{ id: 1, latest: 0, prunedThrough: 0, isReady: true }]);
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

it('resets the isolated control database without changing shared state or exposing its binding to tenant objects', async () => {
	const control = testControlDatabase();
	await control.batch([
		control.prepare(
			"INSERT INTO global_admin (id, issuer, subject, audience, claimed_at) VALUES ('singleton', 'issuer', 'subject', 'audience', '2026-01-01T00:00:00.000Z')"
		),
		control.prepare(
			"INSERT INTO control_database_ready (id, source_database_id, state) VALUES ('current', 'shared-test', 'ready')"
		),
		control.prepare(
			"INSERT INTO control_consumed_subject_nonce (nonce, expires_at) VALUES ('nonce', '2026-01-01T00:05:00.000Z')"
		)
	]);
	await env.CUPBOARD_DB.prepare(
		"INSERT INTO global_admin (id, issuer, subject, audience, claimed_at) VALUES ('singleton', 'legacy-issuer', 'legacy-subject', 'legacy-audience', '2026-01-01T00:00:00.000Z')"
	).run();
	await resetControlD1TestState(control);
	await resetTestServer();
	const tenantBindings = await runInDurableObject(
		currentServer(),
		(instance) => ({
			controlDatabase: Reflect.has(instance.context.env, 'CONTROL_DB'),
			controlDatabaseService: Reflect.has(
				instance.context.env,
				'TEST_CONTROL_DATABASE'
			)
		})
	);
	const targetAdmin = await control
		.prepare('SELECT id FROM global_admin')
		.all();
	const targetReady = await control
		.prepare('SELECT id FROM control_database_ready')
		.all();
	const targetNonces = await control
		.prepare('SELECT nonce FROM control_consumed_subject_nonce')
		.all();
	const sharedAdmin = await env.CUPBOARD_DB.prepare(
		'SELECT issuer FROM global_admin'
	).all();
	expect({
		targetAdmin: targetAdmin.results,
		targetReady: targetReady.results,
		targetNonces: targetNonces.results,
		sharedAdmin: sharedAdmin.results,
		tenantBindings
	}).toStrictEqual({
		targetAdmin: [],
		targetReady: [],
		targetNonces: [],
		sharedAdmin: [{ issuer: 'legacy-issuer' }],
		tenantBindings: { controlDatabase: false, controlDatabaseService: false }
	});
});

it('batches fixture provisioning while preserving usage and updating cache access', async () => {
	await provisionFixtureTenant();
	const database = drizzle(env.CUPBOARD_DB, { schema });
	await database
		.update(schema.tenantUsage)
		.set({ bytes: 7, narinfos: 2, blobs: 1 })
		.where(eq(schema.tenantUsage.tenant, fixtureTenant));
	const batch = vi.spyOn(env.CUPBOARD_DB, 'batch');
	let batchSizes: number[];
	try {
		await provisionFixtureTenant({
			defaultCacheAccess: 'private',
			quotaBytes: 100
		});
		batchSizes = batch.mock.calls.map(([statements]) => statements.length);
	} finally {
		batch.mockRestore();
	}
	const tenant = await database
		.select({
			status: schema.tenant.status,
			configVersion: schema.tenant.configVersion
		})
		.from(schema.tenant)
		.where(eq(schema.tenant.id, fixtureTenant))
		.get();
	const cache = await database
		.select({
			access: schema.cacheLifecycle.access,
			generation: schema.cacheLifecycle.generation,
			isDeleted:
				sql<boolean>`${schema.cacheLifecycle.deletedAt} IS NOT NULL`.mapWith(
					Boolean
				)
		})
		.from(schema.cacheLifecycle)
		.where(eq(schema.cacheLifecycle.tenant, fixtureTenant))
		.get();
	const usage = await database
		.select({
			bytes: schema.tenantUsage.bytes,
			narinfos: schema.tenantUsage.narinfos,
			blobs: schema.tenantUsage.blobs,
			quotaBytes: schema.tenantUsage.quotaBytes
		})
		.from(schema.tenantUsage)
		.where(eq(schema.tenantUsage.tenant, fixtureTenant))
		.get();
	expect({ batchSizes, tenant, cache, usage }).toStrictEqual({
		batchSizes: [3],
		tenant: { status: 'active', configVersion: 1 },
		cache: { access: 'private', generation: 1, isDeleted: false },
		usage: { bytes: 7, narinfos: 2, blobs: 1, quotaBytes: 100 }
	});
});

it('joins both fixture configurations before reporting a failed sibling', async () => {
	const sibling = Promise.withResolvers<undefined>();
	const failed = new Error('fixture configuration failed');
	let hasSiblingStarted = false;
	let isResetSettled = false;
	let failure: unknown;
	const reset = (async () => {
		try {
			await configureFixtureTenants([
				{ configure: () => Promise.reject(failed) },
				{
					configure: () => {
						hasSiblingStarted = true;
						return sibling.promise;
					}
				}
			]);
		} catch (error) {
			failure = error;
		} finally {
			isResetSettled = true;
		}
	})();
	try {
		await scheduler.wait(0);
		const beforeRelease = { hasSiblingStarted, isResetSettled };
		sibling.resolve(undefined);
		await reset;
		expect({ beforeRelease, isResetSettled, failure }).toStrictEqual({
			beforeRelease: { hasSiblingStarted: true, isResetSettled: false },
			isResetSettled: true,
			failure: failed
		});
	} finally {
		sibling.resolve(undefined);
		await reset;
	}
});
