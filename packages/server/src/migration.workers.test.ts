import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import {
	latestMigrationIndex,
	migrateThrough,
	testServerFor
} from './test-support.ts';

const insertSigningKey =
	"INSERT INTO signing_key (id, private_jwk_json, public_key, created_at) VALUES ('active', '{}', 'cupboard-1:cHVi', '2026-01-01T00:00:00.000Z')";

const insertSignedNarInfo =
	"INSERT INTO narinfo (store_path_hash, store_path, nar_hash, nar_size, file_hash, file_size, compression, references_json, sig, created_at) VALUES (?, ?, 'sha256:nar', 10, 'sha256:file', 20, 'zstd', '[]', ?, '2026-01-01T00:00:00.000Z')";

const insertUnsignedNarInfo =
	"INSERT INTO narinfo (store_path_hash, store_path, nar_hash, nar_size, file_hash, file_size, compression, references_json, created_at) VALUES (?, ?, 'sha256:nar', 10, 'sha256:file', 20, 'zstd', '[]', '2026-01-01T00:00:00.000Z')";

describe('migrations', () => {
	describe('0007 signing key set', () => {
		it('backfills the signing key flags and folds sig into a sigs array', async () => {
			const server = testServerFor('migration-0007');
			const signedHash = 'a'.repeat(32);
			const unsignedHash = 'b'.repeat(32);

			const migrated = await runInDurableObject(
				server,
				async (_instance, state) => {
					await migrateThrough(state, 6);

					state.storage.sql.exec(insertSigningKey);
					state.storage.sql.exec(
						insertSignedNarInfo,
						signedHash,
						`/nix/store/${signedHash}-pkg`,
						'cupboard-1:abc'
					);
					state.storage.sql.exec(
						insertUnsignedNarInfo,
						unsignedHash,
						`/nix/store/${unsignedHash}-pkg`
					);

					await migrateThrough(state, latestMigrationIndex);

					return {
						narInfos: state.storage.sql
							.exec(
								'SELECT store_path_hash, sigs_json FROM narinfo ORDER BY store_path_hash'
							)
							.toArray(),
						signingKeys: state.storage.sql
							.exec('SELECT id, signing, published FROM signing_key')
							.toArray()
					};
				}
			);

			expect(migrated).toStrictEqual({
				narInfos: [
					{ store_path_hash: signedHash, sigs_json: '["cupboard-1:abc"]' },
					{ store_path_hash: unsignedHash, sigs_json: '[]' }
				],
				signingKeys: [{ id: 'active', signing: 1, published: 1 }]
			});
		});
	});
});
