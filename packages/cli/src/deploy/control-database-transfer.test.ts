import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { transferControlDatabase } from './control-database-transfer.ts';
import type { D1QueryApi } from './d1-query.ts';
import { databaseIdSchema } from './identifiers.ts';
import { parseD1Migrations } from './migrations.ts';

const source = databaseIdSchema.parse('source');
const target = databaseIdSchema.parse('target');

function fixture() {
	const legacy = new DatabaseSync(':memory:');
	const control = new DatabaseSync(':memory:');
	const directory = new URL('../../../server/drizzle-d1/', import.meta.url);
	const migrations = parseD1Migrations(
		readdirSync(directory)
			.filter((name) => name.endsWith('.sql') && name < '0042')
			.map((name) => ({
				name,
				sql: readFileSync(new URL(name, directory), 'utf8')
			}))
	);
	for (const migration of migrations) {
		for (const statement of migration.statements) {
			legacy.exec(statement);
		}
	}
	const tables = [
		'control_auth_key',
		'control_trust',
		'control_refresh_session_family',
		'control_refresh_session_member',
		'control_consumed_subject_nonce',
		'global_admin',
		'tenant_maintenance_failure'
	];
	for (const table of tables) {
		const row = legacy
			.prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?')
			.get('table', table);
		if (typeof row?.sql !== 'string') {
			throw new TypeError(`Missing ${table}`);
		}
		control.exec(row.sql);
	}
	control.exec(
		'CREATE TABLE control_database_ready (id TEXT PRIMARY KEY, source_database_id TEXT NOT NULL, state TEXT NOT NULL)'
	);
	legacy.exec(
		"INSERT INTO global_admin VALUES ('current','https://idp.example.test','operator','2026-10-09T00:00:00Z','cupboard-client'); INSERT INTO control_consumed_subject_nonce VALUES ('spent',NULL,'2026-11-09T00:00:00Z');"
	);
	const readPlans: string[] = [];
	let batches = 0;
	let interrupt = 0;
	let beforeBatch: ((batch: number) => void) | undefined;
	const api: D1QueryApi = {
		queryRows: (id, sql) => {
			const database = id === source ? legacy : control;
			if (sql.includes(' AS row FROM ')) {
				for (const row of database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all()) {
					if (typeof row.detail === 'string') {
						readPlans.push(row.detail);
					}
				}
			}
			return Promise.resolve(
				database
					.prepare(sql)
					.all()
					.map((row) => Object.values(row)[0])
					.filter((value): value is string => typeof value === 'string')
			);
		},
		queryBatch: (id, statements) => {
			batches += 1;
			if (batches === interrupt) {
				throw new Error('interrupted');
			}
			beforeBatch?.(batches);
			const database = id === source ? legacy : control;
			database.exec('BEGIN');
			try {
				for (const statement of statements) {
					if (
						Buffer.byteLength(
							typeof statement === 'string' ? statement : statement.sql
						) > 100_000
					) {
						throw new Error('D1 SQL statement limit exceeded');
					}
					if (typeof statement === 'string') {
						database.exec(statement);
						continue;
					}
					database.prepare(statement.sql).run(...statement.params);
				}
				database.exec('COMMIT');
			} catch (error) {
				database.exec('ROLLBACK');
				throw error;
			}
			return Promise.resolve();
		}
	};
	return {
		legacy,
		control,
		readPlans,
		api,
		onBatch(callback: (batch: number) => void) {
			beforeBatch = callback;
		},
		interruptAt(batch: number) {
			interrupt = batch;
		},
		transfer(validateKeys = () => Promise.resolve()) {
			return transferControlDatabase({
				api,
				source,
				target,
				validateKeys,
				now: new Date('2026-10-09T00:00:00Z')
			});
		}
	};
}

describe('control database transfer', () => {
	it('reads copy and verification pages without sorting the full table', async () => {
		const world = fixture();
		await world.transfer();
		expect(
			world.readPlans.filter((plan) => plan.includes('TEMP B-TREE'))
		).toStrictEqual([]);
	});
	it('freezes legacy mutations and preserves administrator and consumed nonces', async () => {
		const world = fixture();
		await world.transfer();
		expect({
			admin: world.control
				.prepare('SELECT * FROM global_admin')
				.all()
				.map((row) => ({ ...row })),
			nonce: world.control
				.prepare(
					'SELECT json_array(nonce,family_id,expires_at) AS row FROM control_consumed_subject_nonce'
				)
				.all()
				.map((row) => ({ ...row })),
			marker: world.control
				.prepare('SELECT * FROM control_database_ready')
				.all()
				.map((row) => ({ ...row }))
		}).toStrictEqual({
			admin: [
				{
					id: 'current',
					issuer: 'https://idp.example.test',
					subject: 'operator',
					claimed_at: '2026-10-09T00:00:00Z',
					audience: 'cupboard-client'
				}
			],
			nonce: [{ row: '["spent",null,"2026-11-09T00:00:00Z"]' }],
			marker: [{ id: 'current', source_database_id: 'source', state: 'ready' }]
		});
		expect(() => {
			world.legacy.exec('DELETE FROM control_consumed_subject_nonce');
		}).toThrow('control database migration pending');
	});

	it.each([1, 2, 3, 4, 5, 6])(
		'resumes after interruption at batch %s without overwriting target contents',
		async (batch) => {
			const world = fixture();
			world.interruptAt(batch);
			await expect(world.transfer()).rejects.toThrow('interrupted');
			await world.transfer();
			expect(
				world.control
					.prepare('SELECT nonce FROM control_consumed_subject_nonce')
					.all()
					.map((row) => ({ ...row }))
			).toStrictEqual([{ nonce: 'spent' }]);
		}
	);

	it.each(['extra', 'different'])(
		'refuses %s target authority before readiness',
		async (kind) => {
			const world = fixture();
			world.control.exec(
				`INSERT INTO control_consumed_subject_nonce VALUES ('${kind === 'extra' ? 'extra' : 'spent'}',NULL,'2027-01-01T00:00:00Z')`
			);
			await expect(world.transfer()).rejects.toThrow('do not match');
			expect(
				world.control
					.prepare('SELECT state FROM control_database_ready')
					.all()
					.map((row) => ({ ...row }))
			).toStrictEqual([{ state: 'copying' }]);
		}
	);

	it('does not restore a nonce removed after the target becomes authoritative', async () => {
		const world = fixture();
		await world.transfer();
		world.control.exec('DELETE FROM control_consumed_subject_nonce');
		await world.transfer();
		expect(
			world.control
				.prepare('SELECT * FROM control_consumed_subject_nonce')
				.all()
				.map((row) => ({ ...row }))
		).toStrictEqual([]);
	});

	it('leaves the source frozen and target unavailable when key validation fails', async () => {
		const world = fixture();
		await expect(
			world.transfer(() => Promise.reject(new Error('invalid key')))
		).rejects.toThrow('invalid key');
		expect(
			world.control
				.prepare('SELECT state FROM control_database_ready')
				.all()
				.map((row) => ({ ...row }))
		).toStrictEqual([{ state: 'copying' }]);
		expect(() => {
			world.legacy.exec('DELETE FROM global_admin');
		}).toThrow('control database migration pending');
	});

	it('refuses a target that was copied from another source', async () => {
		const world = fixture();
		world.control.exec(
			"INSERT INTO control_database_ready VALUES ('current','other-source','ready')"
		);
		await expect(world.transfer()).rejects.toThrow('another database');
		expect(
			world.legacy
				.prepare('SELECT * FROM control_database_split')
				.all()
				.map((row) => ({ ...row }))
		).toStrictEqual([]);
	});
});

it('does not import stale rows when another deploy finishes during an insert', async () => {
	const world = fixture();
	world.onBatch((batch) => {
		if (batch !== 3) {
			return;
		}
		world.control.exec(
			"UPDATE control_database_ready SET state='ready'; DELETE FROM control_consumed_subject_nonce;"
		);
	});
	await world.transfer();
	expect(
		world.control.prepare('SELECT * FROM control_consumed_subject_nonce').all()
	).toStrictEqual([]);
	expect(
		world.legacy
			.prepare('SELECT copied_at FROM control_database_split')
			.all()
			.map((row) => ({ ...row }))
	).toStrictEqual([{ copied_at: '2026-10-09T00:00:00.000Z' }]);
});

it('copies more than one page with exact row values', async () => {
	const world = fixture();
	for (let index = 0; index < 45; index += 1) {
		world.legacy
			.prepare('INSERT INTO control_consumed_subject_nonce VALUES (?,NULL,?)')
			.run(`nonce-${String(index)}`, '2026-11-09T00:00:00Z');
	}
	const expected = world.legacy
		.prepare('SELECT * FROM control_consumed_subject_nonce ORDER BY nonce')
		.all()
		.map((row) => ({ ...row }));
	await world.transfer();
	expect(
		world.control
			.prepare('SELECT * FROM control_consumed_subject_nonce ORDER BY nonce')
			.all()
			.map((row) => ({ ...row }))
	).toStrictEqual(expected);
});

it('copies columns by identity when the new schema declares them in another order', async () => {
	const world = fixture();
	world.control.exec(
		"DROP TABLE global_admin; CREATE TABLE global_admin (id TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL, audience TEXT NOT NULL DEFAULT '', claimed_at TEXT NOT NULL)"
	);
	await world.transfer();
	expect(
		world.control
			.prepare('SELECT issuer,subject,audience,claimed_at FROM global_admin')
			.all()
			.map((row) => ({ ...row }))
	).toStrictEqual([
		{
			issuer: 'https://idp.example.test',
			subject: 'operator',
			audience: 'cupboard-client',
			claimed_at: '2026-10-09T00:00:00Z'
		}
	]);
});

it('continues through compound primary keys across page boundaries', async () => {
	const world = fixture();
	for (let index = 0; index < 45; index += 1) {
		world.legacy
			.prepare(
				'INSERT INTO tenant_maintenance_failure (tenant, pass, consecutive_failures) VALUES (?, ?, ?)'
			)
			.run(
				`tenant-${String(Math.floor(index / 3))}`,
				`pass-${String(index % 3)}`,
				index
			);
	}
	const expected = world.legacy
		.prepare('SELECT * FROM tenant_maintenance_failure ORDER BY tenant, pass')
		.all()
		.map((row) => ({ ...row }));
	await world.transfer();
	expect(
		world.control
			.prepare('SELECT * FROM tenant_maintenance_failure ORDER BY tenant, pass')
			.all()
			.map((row) => ({ ...row }))
	).toStrictEqual(expected);
});

it('copies a large accepted trust rule without exceeding the SQL statement limit', async () => {
	const world = fixture();
	const audience = 'a'.repeat(150_000);
	world.legacy
		.prepare(
			"INSERT INTO control_trust (id,issuer,audience,created_at) VALUES ('large','https://idp.example.test',?,'2026-10-09T00:00:00Z')"
		)
		.run(audience);
	await world.transfer();
	expect({
		...world.control
			.prepare("SELECT audience FROM control_trust WHERE id='large'")
			.get()
	}).toStrictEqual({ audience });
});
