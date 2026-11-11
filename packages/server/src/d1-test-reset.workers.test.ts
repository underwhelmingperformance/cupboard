import { cacheListResponseSchema } from '@cupboard/protocol/caches';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { getTableName, is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { StatusCodes } from 'http-status-codes';
import { expect, it, vi } from 'vitest';

import { testControlDatabase } from './control-database.test-support.ts';
import { resetControlD1TestState, resetD1TestState } from './d1-test-reset.ts';
import * as schema from './db/d1-schema.ts';
import {
	authorisedWorkerFetch,
	clearBlobStorage,
	currentServer,
	fixtureWorkerServer,
	initialiseViaWorker,
	recordTransition,
	resetTestServer
} from './test-support.ts';

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

it("empties the Worker's fixture-tenant object at each reset", async () => {
	await resetTestServer();
	await recordTransition('cache-identity', 'complete');
	const created = await authorisedWorkerFetch(
		'/caches/builds',
		await initialiseViaWorker(),
		{
			body: JSON.stringify({ access: 'public', priority: 40 }),
			headers: { 'content-type': 'application/json' },
			method: 'PUT'
		}
	);

	await resetD1TestState(env.CUPBOARD_DB);
	await resetTestServer();
	const listed = await authorisedWorkerFetch(
		'/caches',
		await initialiseViaWorker()
	);

	expect({
		created: created.status,
		caches: cacheListResponseSchema.parse(await listed.json()).caches
	}).toStrictEqual({
		created: StatusCodes.OK,
		caches: [
			{
				scope: { kind: 'default' },
				access: 'public',
				priority: 40,
				storePaths: 0,
				defaultRootRetention: { kind: 'permanent' },
				grace: { kind: 'none' },
				graceManaged: false
			}
		]
	});
});

const blobKeys = async (): Promise<string[]> => {
	const { objects } = await env.BLOBS.list();

	return objects.map((object) => object.key);
};

it("empties the Worker's R2 bucket at each reset", async () => {
	await env.BLOBS.put('t/earlier-test/object', 'bytes');
	const before = await blobKeys();

	await resetTestServer();

	expect({ before, after: await blobKeys() }).toStrictEqual({
		before: ['t/earlier-test/object'],
		after: []
	});
});

const inFlightKey = 't/in-flight/object';

type WriteOutcome = 'aborted' | 'committed';

interface PendingWrite {
	/**
	Completes the write if the object that started it is still the fixture
	tenant's object, and returns `committed` after R2 has stored the object.
	After a reset, the fixture tenant's object is a new instance. The reset
	has cancelled the old instance's put, which neither succeeds nor fails,
	so this method returns `aborted` without waiting.
	*/
	finish: () => Promise<WriteOutcome>;
}

// The body stream stays open until `finish` writes to it. A stream cannot be
// used from a different Durable Object, so the object creates it and `finish`
// writes to it from inside the same object.
async function startPendingWrite(): Promise<PendingWrite> {
	const { starter, writer, committed } = await runInDurableObject(
		fixtureWorkerServer(),
		(instance) => {
			const body = new FixedLengthStream(5);

			return {
				starter: instance,
				writer: body.writable.getWriter(),
				committed: instance.context.env.BLOBS.put(inFlightKey, body.readable)
			};
		}
	);

	return {
		finish: () =>
			runInDurableObject(fixtureWorkerServer(), async (current) => {
				if (current !== starter) {
					return 'aborted';
				}

				await writer.write(new Uint8Array(5));
				await writer.close();
				await committed;

				return 'committed';
			})
	};
}

it("completes the fixture tenant's pending write when nothing resets the server", async () => {
	await resetTestServer();
	const write = await startPendingWrite();
	const before = await blobKeys();

	const outcome = await write.finish();

	expect({ before, outcome, after: await blobKeys() }).toStrictEqual({
		before: [],
		outcome: 'committed',
		after: [inFlightKey]
	});
});

it("leaves no object from the fixture tenant's work in flight at a reset", async () => {
	await resetTestServer();
	const write = await startPendingWrite();
	const before = await blobKeys();
	let outcome: WriteOutcome | undefined;

	// The clear starts by listing the bucket. Complete the write just after
	// that listing. If the object is still alive at that point, the write lands
	// after the listing and the clear misses it.
	const list = env.BLOBS.list.bind(env.BLOBS);
	const listing = vi
		.spyOn(env.BLOBS, 'list')
		.mockImplementationOnce(async (options) => {
			const objects = await list(options);

			outcome = await write.finish();

			return objects;
		});

	try {
		await resetTestServer();
	} finally {
		listing.mockRestore();
	}

	expect({ before, outcome, after: await blobKeys() }).toStrictEqual({
		before: [],
		outcome: 'aborted',
		after: []
	});
});

it('deletes every object when R2 lists more than one page', async () => {
	const keys = Array.from(
		{ length: 1001 },
		(_, index) => `t/earlier-test/${String(index)}`
	);
	await Promise.all(keys.map((key) => env.BLOBS.put(key, 'bytes')));

	await clearBlobStorage();

	expect(await blobKeys()).toStrictEqual([]);
});
