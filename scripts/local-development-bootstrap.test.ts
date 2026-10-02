import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { transitionIds } from '@cupboard/protocol/deployment';
import { withCleanup } from '@cupboard/shared/cleanup';
import { describe, expect, it } from 'vitest';

import { LocalWranglerDatabase } from './local-development-bootstrap.ts';

describe('local Wrangler development setup', () => {
	it('applies the full local schema and preserves completed data on repeated setup', async () => {
		const directory = await mkdtemp(
			path.join(os.tmpdir(), 'cupboard-local-setup-')
		);
		await withCleanup(
			async () => {
				const database = new LocalWranglerDatabase(directory);
				await database.setup();
				const transitions = await database.query(
					'SELECT id, state, updated_at, contracted_at FROM deployment_transition ORDER BY id'
				);
				expect(
					await database.query(
						'SELECT id, state FROM deployment_transition ORDER BY id'
					)
				).toStrictEqual(
					transitionIds
						.toSorted(byCodeUnit)
						.map((id) => ({ id, state: 'complete' }))
				);
				const migrations = await readdir(
					path.resolve(import.meta.dirname, '../packages/server/drizzle-d1')
				);
				expect(
					await database.query('SELECT name FROM d1_migrations ORDER BY name')
				).toStrictEqual(
					migrations
						.filter((file) => file.endsWith('.sql'))
						.toSorted(byCodeUnit)
						.map((name) => ({ name }))
				);
				await database.execute(
					"INSERT INTO global_admin (id, issuer, subject, audience, claimed_at) VALUES ('admin', 'issuer', 'subject', 'audience', '2026-01-01T00:00:00.000Z')"
				);
				await database.setup();
				expect({
					transitions: await database.query(
						'SELECT id, state, updated_at, contracted_at FROM deployment_transition ORDER BY id'
					),
					admins: await database.query('SELECT id FROM global_admin')
				}).toStrictEqual({ transitions, admins: [{ id: 'admin' }] });
			},
			async () => rm(directory, { recursive: true, force: true })
		);
	}, 120_000);
	it('includes Wrangler diagnostics when a local command fails', async () => {
		const directory = await mkdtemp(
			path.join(os.tmpdir(), 'cupboard-local-setup-')
		);
		await withCleanup(
			async () => {
				await expect(
					new LocalWranglerDatabase(directory).query(
						'SELECT * FROM missing_local_bootstrap_table'
					)
				).rejects.toThrow('no such table: missing_local_bootstrap_table');
			},
			async () => rm(directory, { recursive: true, force: true })
		);
	}, 30_000);
});
