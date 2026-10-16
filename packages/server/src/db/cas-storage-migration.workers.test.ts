import { sha256HexDigestSchema } from '@cupboard/nix-store/scalars';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it } from 'vitest';

import { publishCasObjectState } from '../blob/cas-object-state.ts';

import * as schema from './d1-schema.ts';

const digest = sha256HexDigestSchema.parse('a'.repeat(64));
const storedAt = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');

function migrationQueries(name: string): readonly string[] {
	const migration = env.TEST_MIGRATIONS.find((item) => item.name === name);
	if (migration === undefined) {
		throw new Error(`The test migrations must include ${name}`);
	}
	return migration.queries;
}

async function execute(queries: readonly string[]): Promise<void> {
	await env.CUPBOARD_DB.batch(
		queries.map((query) => env.CUPBOARD_DB.prepare(query))
	);
}

async function withExpandedStorage(
	operation: (contract: () => Promise<void>) => Promise<void>
): Promise<void> {
	const expand = migrationQueries('0043_cas_storage_expand.sql');
	const contraction = migrationQueries('0044_cas_storage_contract.sql');
	await execute([
		'DROP VIEW cas_object',
		'DROP VIEW tenant_cas_blob',
		'ALTER TABLE cas_object_storage RENAME TO cas_object',
		'ALTER TABLE tenant_cas_blob_storage RENAME TO tenant_cas_blob',
		...expand
	]);
	const contract = async (): Promise<void> => {
		await execute(contraction);
	};
	try {
		await operation(contract);
	} finally {
		const type = await env.CUPBOARD_DB.prepare(
			"SELECT type FROM sqlite_master WHERE name = 'cas_object_storage'"
		).first<string>('type');
		if (type === 'view') {
			await contract();
		}
	}
}

async function seedCas(): Promise<void> {
	await env.CUPBOARD_DB.batch([
		env.CUPBOARD_DB.prepare(
			'INSERT INTO cas_object (digest, size, incarnation, stored_at, delete_after) VALUES (?, 12, 2, ?, ?)'
		).bind(digest, storedAt, storedAt),
		env.CUPBOARD_DB.prepare(
			"INSERT INTO object_incarnation (kind, object_id, incarnation, state) VALUES ('cas', ?, 2, 'live')"
		).bind(digest),
		env.CUPBOARD_DB.prepare(
			"INSERT INTO tenant_cas_blob (tenant, digest, size) VALUES ('acme', ?, 12)"
		).bind(digest),
		env.CUPBOARD_DB.prepare(
			"INSERT INTO tenant_usage (tenant, cas_bytes, cas_blobs, updated_at) VALUES ('acme', 12, 1, ?)"
		).bind(storedAt)
	]);
}

async function lifecycleFacts() {
	const results = await env.CUPBOARD_DB.batch<Record<string, unknown>>([
		env.CUPBOARD_DB.prepare('SELECT * FROM cas_object'),
		env.CUPBOARD_DB.prepare(
			'SELECT kind, object_id, incarnation, state FROM object_incarnation'
		),
		env.CUPBOARD_DB.prepare('SELECT * FROM object_deletion'),
		env.CUPBOARD_DB.prepare('SELECT * FROM tenant_cas_blob'),
		env.CUPBOARD_DB.prepare(
			'SELECT tenant, cas_bytes, cas_blobs FROM tenant_usage'
		)
	]);
	return results.map((result) =>
		result.results.map((row) =>
			Object.fromEntries(
				Object.entries(row).map(([key, value]) => [key, value ?? undefined])
			)
		)
	);
}

describe('CAS storage deployment transition', () => {
	it('rolls back an interrupted contraction and permits forward recovery', async () => {
		await withExpandedStorage(async (contract) => {
			await seedCas();
			const before = await lifecycleFacts();
			const queries = migrationQueries('0044_cas_storage_contract.sql');
			await expect(
				execute([
					...queries.slice(0, 4),
					'SELECT * FROM missing_cutover_test_table',
					...queries.slice(4)
				])
			).rejects.toThrow('missing_cutover_test_table');
			expect(await lifecycleFacts()).toStrictEqual(before);
			await contract();
			expect(await lifecycleFacts()).toStrictEqual(before);
		});
	});

	it('accepts legacy UPSERT and modern publication before contraction', async () => {
		await withExpandedStorage(async (contract) => {
			await seedCas();
			await env.CUPBOARD_DB.prepare(
				'INSERT INTO cas_object (digest, size, incarnation, stored_at) VALUES (?, 13, 2, ?) ON CONFLICT (digest) DO UPDATE SET size = excluded.size'
			)
				.bind(digest, storedAt)
				.run();
			await publishCasObjectState(drizzle(env.CUPBOARD_DB, { schema }), {
				digest,
				size: 14,
				incarnation: 2,
				storedAt
			});
			const before = await lifecycleFacts();
			await contract();
			expect({ before, after: await lifecycleFacts() }).toStrictEqual({
				before: [
					[
						{
							digest,
							size: 14,
							incarnation: 2,
							stored_at: storedAt,
							delete_after: undefined
						}
					],
					[{ kind: 'cas', object_id: digest, incarnation: 2, state: 'live' }],
					[],
					[{ tenant: 'acme', digest, size: 12 }],
					[{ tenant: 'acme', cas_bytes: 12, cas_blobs: 1 }]
				],
				after: before
			});
		});
	});

	it('rolls back legacy collection without retiring the object or queuing deletion', async () => {
		await withExpandedStorage(async (contract) => {
			await seedCas();
			await contract();
			const before = await lifecycleFacts();
			await expect(
				env.CUPBOARD_DB.batch([
					env.CUPBOARD_DB.prepare(
						"UPDATE object_incarnation SET state = 'absent' WHERE kind = 'cas' AND object_id = ?"
					).bind(digest),
					env.CUPBOARD_DB.prepare(
						"INSERT INTO object_deletion (kind, object_id, incarnation, remove_after) SELECT 'cas', digest, incarnation, ? FROM cas_object WHERE digest = ?"
					).bind(storedAt, digest),
					env.CUPBOARD_DB.prepare(
						'DELETE FROM cas_object WHERE digest = ?'
					).bind(digest)
				])
			).rejects.toThrow('view');
			expect(await lifecycleFacts()).toStrictEqual(before);
		});
	});

	it('rolls back legacy quota credit when presence deletion is refused', async () => {
		await withExpandedStorage(async (contract) => {
			await seedCas();
			await contract();
			const before = await lifecycleFacts();
			await expect(
				env.CUPBOARD_DB.batch([
					env.CUPBOARD_DB.prepare(
						"UPDATE tenant_usage SET cas_bytes = cas_bytes - 12, cas_blobs = cas_blobs - 1 WHERE tenant = 'acme'"
					),
					env.CUPBOARD_DB.prepare(
						"DELETE FROM tenant_cas_blob WHERE tenant = 'acme' AND digest = ?"
					).bind(digest)
				])
			).rejects.toThrow('view');
			expect(await lifecycleFacts()).toStrictEqual(before);
		});
	});

	it.each(['INSERT', 'UPDATE', 'DELETE'] as const)(
		'refuses a legacy %s after contraction',
		async (operation) => {
			await withExpandedStorage(async (contract) => {
				await seedCas();
				await contract();
				const before = await lifecycleFacts();
				const query =
					operation === 'INSERT'
						? 'INSERT INTO cas_object (digest, size, incarnation, stored_at) VALUES (?, 12, 2, ?)'
						: operation === 'UPDATE'
							? 'UPDATE cas_object SET delete_after = ? WHERE digest = ?'
							: 'DELETE FROM cas_object WHERE digest = ?';
				const statement = env.CUPBOARD_DB.prepare(query);
				const bound =
					operation === 'INSERT'
						? statement.bind(digest, storedAt)
						: operation === 'UPDATE'
							? statement.bind(storedAt, digest)
							: statement.bind(digest);
				await expect(bound.run()).rejects.toThrow('view');
				expect(await lifecycleFacts()).toStrictEqual(before);
			});
		}
	);
});
