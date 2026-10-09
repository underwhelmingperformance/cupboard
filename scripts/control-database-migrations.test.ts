import { readdir, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { expect, it } from 'vitest';

it('initialises the isolated control database and enforces native cache grants', async () => {
	const database = new DatabaseSync(':memory:');
	try {
		const migration = await readFile(
			new URL(
				'../packages/server/drizzle-control-d1/0000_control_database.sql',
				import.meta.url
			),
			'utf8'
		);
		database.exec(migration);
		expect({
			tables: database
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
				)
				.all()
				.map((row) => ({ ...row })),
			ready: database
				.prepare('SELECT id, state FROM control_database_ready')
				.all()
				.map((row) => ({ ...row }))
		}).toStrictEqual({
			tables: [
				{ name: 'control_auth_key' },
				{ name: 'control_consumed_subject_nonce' },
				{ name: 'control_database_ready' },
				{ name: 'control_refresh_session_family' },
				{ name: 'control_refresh_session_member' },
				{ name: 'control_trust' },
				{ name: 'deployment_transition' },
				{ name: 'global_admin' },
				{ name: 'tenant_maintenance_failure' }
			],
			ready: []
		});
		const insert = database.prepare(
			'INSERT INTO control_trust (id, issuer, audience, created_at, permitted_grants_json) VALUES (?, ?, ?, ?, ?)'
		);
		expect(() =>
			insert.run(
				'legacy',
				'issuer',
				'audience',
				'2026-01-01T00:00:00.000Z',
				'[{"type":"cupboard_cache","resources":{"cache":{"exact":"_default"}}}]'
			)
		).toThrow('cache grants require scope spelling after contraction');
		insert.run(
			'native',
			'issuer',
			'audience',
			'2026-01-01T00:00:00.000Z',
			'[{"type":"cupboard_cache","resources":{"cache":{"kind":"default"}}}]'
		);
		expect(() =>
			database
				.prepare(
					'UPDATE control_trust SET permitted_grants_json = ? WHERE id = ?'
				)
				.run(
					'[{"type":"cupboard_cache","resources":{"cache":{"exact":"_default"}}}]',
					'native'
				)
		).toThrow('cache grants require scope spelling after contraction');
	} finally {
		database.close();
	}
});

it.each(['unfrozen', 'uncopied'] as const)(
	'refuses contract for %s source state and removes only copied control tables',
	async (state) => {
		const shared = new DatabaseSync(':memory:');
		const target = new DatabaseSync(':memory:');
		try {
			const directory = new URL(
				'../packages/server/drizzle-d1/',
				import.meta.url
			);
			const entries = await readdir(directory);
			const files = entries
				.filter(
					(file) =>
						file.endsWith('.sql') &&
						file !== '0042_control_database_contract.sql'
				)
				.toSorted(byCodeUnit);
			for (const file of files) {
				shared.exec(await readFile(new URL(file, directory), 'utf8'));
			}
			target.exec(
				await readFile(
					new URL(
						'../packages/server/drizzle-control-d1/0000_control_database.sql',
						import.meta.url
					),
					'utf8'
				)
			);
			target.exec(
				"INSERT INTO global_admin (id, issuer, subject, audience, claimed_at) VALUES ('singleton', 'issuer', 'subject', 'audience', '2026-01-01T00:00:00.000Z')"
			);
			if (state === 'uncopied') {
				shared.exec(
					"INSERT INTO control_database_split (id, target_database_id, frozen_at) VALUES ('current', 'target', '2026-01-01T00:00:00.000Z')"
				);
			}
			const contract = await readFile(
				new URL('0042_control_database_contract.sql', directory),
				'utf8'
			);
			expect(() => {
				shared.exec(contract);
			}).toThrow('CHECK constraint failed');
			shared.exec('DROP TABLE control_database_contract_assertion');
			shared.exec(
				"INSERT INTO control_database_split (id, target_database_id, frozen_at, copied_at) VALUES ('current', 'target', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z') ON CONFLICT(id) DO UPDATE SET copied_at = excluded.copied_at"
			);
			shared.exec(contract);
			expect({
				sharedControlTables: shared
					.prepare(
						"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('control_auth_key', 'control_trust', 'control_refresh_session_family', 'control_refresh_session_member', 'control_consumed_subject_nonce', 'global_admin', 'tenant_maintenance_failure') ORDER BY name"
					)
					.all()
					.map((row) => ({ ...row })),
				targetAdmin: target
					.prepare(
						'SELECT id, issuer, subject, audience, claimed_at FROM global_admin'
					)
					.all()
					.map((row) => ({ ...row })),
				sharedRegistry: shared
					.prepare(
						"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tenant'"
					)
					.all()
					.map((row) => ({ ...row }))
			}).toStrictEqual({
				sharedControlTables: [],
				targetAdmin: [
					{
						id: 'singleton',
						issuer: 'issuer',
						subject: 'subject',
						audience: 'audience',
						claimed_at: '2026-01-01T00:00:00.000Z'
					}
				],
				sharedRegistry: [{ name: 'tenant' }]
			});
		} finally {
			shared.close();
			target.close();
		}
	}
);
