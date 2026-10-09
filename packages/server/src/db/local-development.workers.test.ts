import {
	cacheGenerationSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { schemaTransitions } from '@cupboard/protocol/deployment';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { testControlDatabase } from '../control-database.test-support.ts';
import { PathReadAuthorityMigrationPendingError } from '../errors.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';

import {
	type CacheLifecycleWriteTable,
	writeCacheLifecycle
} from './cache-lifecycle-write.ts';
import * as schema from './d1-schema.ts';
import {
	bootstrapLocalDevelopment,
	bootstrapLocalDevelopmentDatabases,
	LocalDevelopmentBootstrapRefusedError,
	type LocalDevelopmentDatabase
} from './local-development.ts';

const database: LocalDevelopmentDatabase = {
	async query(sql) {
		const result = await env.CUPBOARD_DB.prepare(sql).all();
		return result.results;
	},
	async execute(sql) {
		await env.CUPBOARD_DB.exec(sql);
	}
};
const now = '2026-01-01T00:00:00.000Z';
const transitionIds = schemaTransitions
	.filter(
		(transition) => (transition.database ?? 'CUPBOARD_DB') === 'CUPBOARD_DB'
	)
	.map(({ id }) => id);

function applyMigrations(): Promise<void> {
	return applyD1Migrations(env.CUPBOARD_DB, env.TEST_MIGRATIONS);
}

function transitions(): Promise<readonly unknown[]> {
	return database.query(
		'SELECT id, state, updated_at, contracted_at FROM deployment_transition ORDER BY id'
	);
}

describe('local development bootstrap', () => {
	beforeEach(async () => {
		await env.CUPBOARD_DB.prepare('DELETE FROM deployment_transition').run();
	});

	it('completes the migrated empty database before allowing lifecycle writes', async () => {
		const lifecycleDatabase = drizzle(env.CUPBOARD_DB, { schema });
		const operation = vi.fn((table: CacheLifecycleWriteTable) =>
			lifecycleDatabase
				.insert(table)
				.values({
					tenant: tenantIdSchema.parse(fixtureTenant),
					cacheKind: 'default',
					access: 'public',
					generation: cacheGenerationSchema.parse(1),
					updatedAt: isoTimestamp(new Date())
				})
				.run()
		);
		const schemaBefore = await database.query(
			"SELECT type FROM sqlite_master WHERE name = 'cache_lifecycle'"
		);
		expect({
			schema: schemaBefore,
			transitions: await transitions()
		}).toStrictEqual({
			schema: [{ type: 'view' }],
			transitions: []
		});
		await expect(
			writeCacheLifecycle(lifecycleDatabase, operation)
		).rejects.toBeInstanceOf(PathReadAuthorityMigrationPendingError);
		expect(operation).not.toHaveBeenCalled();

		await bootstrapLocalDevelopment(database, applyMigrations);
		await database.execute(
			`INSERT INTO tenant (id, status, owner_issuer, owner_subject, owner_audience, config_version, created_at) VALUES ('${fixtureTenant}', 'active', 'issuer', 'subject', 'audience', 1, '${now}')`
		);
		await writeCacheLifecycle(lifecycleDatabase, operation);
		expect({
			transitions: await transitions(),
			cache: await database.query(
				'SELECT tenant, cache_kind, access, generation FROM cache_lifecycle_storage'
			)
		}).toStrictEqual({
			transitions: transitionIds.toSorted(byCodeUnit).map((id) => ({
				id,
				state: 'complete',
				updated_at: now,
				contracted_at: now
			})),
			cache: [
				{
					tenant: fixtureTenant,
					cache_kind: 'default',
					access: 'public',
					generation: 1
				}
			]
		});
	});

	it('refuses populated control state before either database applies migrations', async () => {
		const binding = testControlDatabase();
		const control: LocalDevelopmentDatabase = {
			binding: 'CONTROL_DB',
			async query(sql) {
				const result = await binding.prepare(sql).all();
				return result.results;
			},
			async execute(sql) {
				await binding.exec(sql);
			}
		};
		await control.execute(
			"INSERT INTO global_admin (id, issuer, subject, audience, claimed_at) VALUES ('singleton', 'issuer', 'subject', 'audience', '2026-01-01T00:00:00.000Z')"
		);
		const sharedMigrate = vi.fn(applyMigrations);
		const controlMigrate = vi.fn();
		await expect(
			bootstrapLocalDevelopmentDatabases([
				{ database, applyMigrations: sharedMigrate },
				{ database: control, applyMigrations: controlMigrate }
			])
		).rejects.toStrictEqual(new LocalDevelopmentBootstrapRefusedError());
		expect({
			sharedMigrationCalls: sharedMigrate.mock.calls,
			controlMigrationCalls: controlMigrate.mock.calls,
			sharedTransitions: await transitions(),
			controlAdmin: await control.query(
				'SELECT id, issuer, subject, audience FROM global_admin'
			)
		}).toStrictEqual({
			sharedMigrationCalls: [],
			controlMigrationCalls: [],
			sharedTransitions: [],
			controlAdmin: [
				{
					id: 'singleton',
					issuer: 'issuer',
					subject: 'subject',
					audience: 'audience'
				}
			]
		});
	});

	it('preserves a completed local deployment and its timestamps on repeated setup', async () => {
		await bootstrapLocalDevelopment(database, applyMigrations);
		await database.execute(
			`INSERT INTO tenant (id, status, owner_issuer, owner_subject, owner_audience, config_version, created_at) VALUES ('${fixtureTenant}', 'active', 'issuer', 'subject', 'audience', 1, '${now}')`
		);
		const before = await transitions();
		expect(before).toStrictEqual(
			transitionIds.toSorted(byCodeUnit).map((id) => ({
				id,
				state: 'complete',
				updated_at: now,
				contracted_at: now
			}))
		);
		vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));
		await bootstrapLocalDevelopment(database, applyMigrations);
		expect({
			transitions: await transitions(),
			tenants: await database.query('SELECT id FROM tenant')
		}).toStrictEqual({ transitions: before, tenants: [{ id: fixtureTenant }] });
	});

	it.each([
		[
			'tenant',
			"INSERT INTO tenant (id, status, owner_issuer, owner_subject, owner_audience, config_version, created_at) VALUES ('existing', 'active', 'issuer', 'subject', 'audience', 1, '2026-01-01T00:00:00.000Z')"
		],
		[
			'global_admin',
			"INSERT INTO global_admin (id, issuer, subject, audience, claimed_at) VALUES ('admin', 'issuer', 'subject', 'audience', '2026-01-01T00:00:00.000Z')"
		],
		[
			'control_trust',
			"INSERT INTO control_trust (id, issuer, audience, created_at) VALUES ('trust', 'issuer', 'audience', '2026-01-01T00:00:00.000Z')"
		],
		[
			'control_auth_key',
			"INSERT INTO control_auth_key (id, kid, public_jwk_json, wrapped_private_jwk, created_at) VALUES ('key', 'kid', '{}', 'wrapped', '2026-01-01T00:00:00.000Z')"
		]
	])(
		'refuses populated %s state before migrations or transition updates',
		async (table, insert) => {
			await database.execute(insert);
			const before = await database.query(`SELECT * FROM ${table}`);
			const migrate = vi.fn(applyMigrations);
			await expect(
				bootstrapLocalDevelopment(database, migrate)
			).rejects.toStrictEqual(new LocalDevelopmentBootstrapRefusedError());
			expect(migrate).not.toHaveBeenCalled();
			expect({
				rows: await database.query(`SELECT * FROM ${table}`),
				transitions: await transitions()
			}).toStrictEqual({ rows: before, transitions: [] });
		}
	);

	it.each([
		['blob-reference-read-authority', 'expanded'],
		['blob-reference-read-authority', 'unrecognised'],
		['future-transition', 'complete']
	])(
		'preserves transition %s in state %s before refusing setup',
		async (id, state) => {
			await env.CUPBOARD_DB.prepare(
				'INSERT INTO deployment_transition (id, state, updated_at) VALUES (?, ?, ?)'
			)
				.bind(id, state, now)
				.run();
			const before = await transitions();
			const migrate = vi.fn(applyMigrations);
			await expect(
				bootstrapLocalDevelopment(database, migrate)
			).rejects.toStrictEqual(new LocalDevelopmentBootstrapRefusedError());
			expect(migrate).not.toHaveBeenCalled();
			expect(await transitions()).toStrictEqual(before);
		}
	);

	it('preserves an expanded compatibility phase before refusing setup', async () => {
		await env.CUPBOARD_DB.prepare(
			'INSERT INTO deployment_phase (id, phase, required_local_step, updated_at) VALUES (?, ?, ?, ?)'
		)
			.bind('cache-identity', 'expanded', 4, now)
			.run();
		const before = await database.query('SELECT * FROM deployment_phase');
		const migrate = vi.fn(applyMigrations);
		await expect(
			bootstrapLocalDevelopment(database, migrate)
		).rejects.toStrictEqual(new LocalDevelopmentBootstrapRefusedError());
		expect(migrate).not.toHaveBeenCalled();
		expect({
			rows: await database.query('SELECT * FROM deployment_phase'),
			transitions: await transitions()
		}).toStrictEqual({ rows: before, transitions: [] });
	});
	it('refuses application data introduced during migration before recording completion', async () => {
		const migrate = async () => {
			await applyMigrations();
			await database.execute(
				"INSERT INTO global_admin (id, issuer, subject, audience, claimed_at) VALUES ('admin', 'issuer', 'subject', 'audience', '2026-01-01T00:00:00.000Z')"
			);
		};
		await expect(
			bootstrapLocalDevelopment(database, migrate)
		).rejects.toStrictEqual(new LocalDevelopmentBootstrapRefusedError());
		expect({
			admins: await database.query('SELECT id FROM global_admin'),
			transitions: await transitions()
		}).toStrictEqual({ admins: [{ id: 'admin' }], transitions: [] });
	});
});
