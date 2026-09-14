import { currentLocalStep } from '@cupboard/protocol/deployment';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import {
	bootstrap,
	currentServer,
	narHash,
	useTestServer
} from '../test-support.ts';

async function advance() {
	return runInDurableObject(currentServer(), async (instance, state) => ({
		outcome: await instance.reportLocalStep(),
		pending: state.storage.sql
			.exec<{ unlinked: number }>(
				'SELECT count(*) AS unlinked FROM pending_upload WHERE cache_id IS NULL'
			)
			.one().unlinked,
		deletions: [
			...state.storage.sql.exec<{ cache: string; cache_id: number | null }>(
				'SELECT cache, cache_id FROM narinfo_deletion'
			)
		].map((row) => ({ cache: row.cache, cacheId: row.cache_id ?? undefined }))
	}));
}

describe('legacy identity backfill', () => {
	it.each([1, 2])(
		'revisits valid unlinked rows when registration follows %i sweep pages',
		async (pages) => {
			await useTestServer(`identity-valid-unlinked-${String(pages)}`);
			await bootstrap();
			await runInDurableObject(currentServer(), (_instance, state) => {
				state.storage.sql.exec(
					"INSERT INTO cache_identity (kind, name, access, priority, created_at, deleted_at) VALUES ('named', 'removed', 'public', 40, '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')"
				);
				state.storage.sql.exec(
					"INSERT INTO narinfo_deletion (cache, store_path_hash, nar_hash, generation, created_at) VALUES ('removed', '00000000000000000000000000000000', ?, 1, '2026-02-01T00:00:00.000Z')",
					narHash
				);
				for (let index = 0; index < 40; index++) {
					state.storage.sql.exec(
						"INSERT INTO pending_upload (id, cache, nar_hash, r2_key, metadata_json, created_at, expires_at) VALUES (?, 'future', ?, ?, '{}', '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')",
						`pending-${String(index)}`,
						narHash,
						`staging/pending-${String(index)}`
					);
				}
			});
			const beforeRegistration = [];
			for (let page = 0; page < pages; page++) {
				beforeRegistration.push(await advance());
			}
			await runInDurableObject(currentServer(), (_instance, state) => {
				state.storage.sql.exec(
					"INSERT INTO cache (name, priority, created_at) VALUES ('future', 40, '2026-03-01T00:00:00.000Z')"
				);
			});
			const afterRegistration = [await advance(), await advance()];
			const deletions = [{ cache: 'removed', cacheId: undefined }];
			expect({ beforeRegistration, afterRegistration }).toStrictEqual({
				beforeRegistration: [
					{
						outcome: { kind: 'incomplete', projected: 36 },
						pending: 40,
						deletions
					},
					{
						outcome: { kind: 'recorded', step: currentLocalStep },
						pending: 40,
						deletions
					}
				].slice(0, pages),
				afterRegistration: [
					{
						outcome: { kind: 'incomplete', projected: 36 },
						pending: 5,
						deletions
					},
					{
						outcome: { kind: 'recorded', step: currentLocalStep },
						pending: 0,
						deletions
					}
				]
			});
		}
	);
	it('revisits a completed table after a predecessor reuses its rowid', async () => {
		await useTestServer('identity-reference-after-cursor');
		await bootstrap();
		await runInDurableObject(currentServer(), (_instance, state) => {
			state.storage.sql.exec(
				"INSERT INTO cache (name, priority, created_at) VALUES ('builds', 40, '2026-01-01T00:00:00.000Z')"
			);
			state.storage.sql.exec(
				"INSERT INTO cache_identity (kind, name, access, priority, created_at) VALUES ('named', 'builds', 'public', 40, '2026-01-01T00:00:00.000Z')"
			);
			state.storage.sql.exec(
				"INSERT INTO narinfo (cache, store_path_hash, store_path, nar_hash, nar_size, references_json, created_at) VALUES ('builds', '00000000000000000000000000000000', '/nix/store/00000000000000000000000000000000-old', ?, 1, '[]', '2026-01-01T00:00:00.000Z')",
				narHash
			);
			for (let index = 0; index < 40; index++) {
				state.storage.sql.exec(
					"INSERT INTO pending_upload (id, cache, nar_hash, r2_key, metadata_json, created_at, expires_at) VALUES (?, 'future', ?, ?, '{}', '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')",
					`pending-${String(index)}`,
					narHash,
					`staging/pending-${String(index)}`
				);
			}
		});
		const first = await advance();
		const reused = await runInDurableObject(
			currentServer(),
			(_instance, state) => {
				const before = state.storage.sql
					.exec<{ rowid: number }>('SELECT rowid FROM narinfo')
					.one().rowid;
				state.storage.sql.exec('DELETE FROM narinfo');
				state.storage.sql.exec(
					"INSERT INTO narinfo (cache, store_path_hash, store_path, nar_hash, nar_size, references_json, created_at) VALUES ('builds', '11111111111111111111111111111111', '/nix/store/11111111111111111111111111111111-new', ?, 1, '[]', '2026-02-01T00:00:00.000Z')",
					narHash
				);
				return {
					before,
					after: state.storage.sql
						.exec<{ rowid: number }>('SELECT rowid FROM narinfo')
						.one().rowid
				};
			}
		);
		const second = await advance();
		const published = await runInDurableObject(
			currentServer(),
			(_instance, state) =>
				state.storage.sql
					.exec<{ cache: string; cache_id: number | null }>(
						'SELECT cache, cache_id FROM narinfo'
					)
					.toArray()
		);
		expect({ first, second, reused, published }).toStrictEqual({
			first: {
				outcome: { kind: 'incomplete', projected: 36 },
				pending: 40,
				deletions: []
			},
			second: {
				outcome: { kind: 'recorded', step: currentLocalStep },
				pending: 40,
				deletions: []
			},
			reused: { before: 1, after: 1 },
			published: [{ cache: 'builds', cache_id: 2 }]
		});
	});
});
