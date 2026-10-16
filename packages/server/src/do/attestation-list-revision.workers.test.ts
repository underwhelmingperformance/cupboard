import {
	cacheGenerationSchema,
	narInfoGenerationSchema,
	predicateTypeSchema,
	type Sha256HexDigest,
	sha256HexDigestSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { env } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it } from 'vitest';

import { AttestationListRevisionRepository } from '../db/attestation-list-revision.ts';
import * as schema from '../db/d1-schema.ts';
import { r2ObjectKeySchema } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	commitPath,
	defaultCache,
	initialise,
	narInfoGeneration,
	recordTransition,
	resetTestServer,
	uploadMetadata,
	verifiableNar
} from '../test-support.ts';

const hash = storePathHashSchema.parse('a'.repeat(32));
const predicate = predicateTypeSchema.parse('https://slsa.dev/provenance/v1');
const first = sha256HexDigestSchema.parse('a'.repeat(64));
const second = sha256HexDigestSchema.parse('b'.repeat(64));

async function insertReference(
	digest: Sha256HexDigest,
	generation = 0
): Promise<void> {
	await env.CUPBOARD_DB.prepare(
		`INSERT INTO attestation_ref_storage
		(tenant, cache_kind, cache_name, store_path_hash, generation, predicate_type, digest)
		VALUES (?, 'default', NULL, ?, ?, ?, ?)`
	)
		.bind(fixtureTenant, hash, generation, predicate, digest)
		.run();
}

async function versions() {
	const result = await env.CUPBOARD_DB.prepare(
		`SELECT cache_kind AS cacheKind,
		coalesce(cache_name, '') AS cacheName, generation, revision,
		CASE WHEN published_revision = revision THEN 'ready' ELSE 'pending' END AS status
		FROM attestation_list_revision WHERE tenant = ?
		ORDER BY cache_kind, cache_name, generation`
	)
		.bind(fixtureTenant)
		.all();
	return result.results;
}

describe('attestation list revisions', () => {
	beforeEach(async () => {
		await resetTestServer();
		await recordTransition('attestation-list-revision', 'complete');
	});

	it.each([
		'unchanged',
		'reference-change',
		'newer-publication',
		'cache-generation',
		'suspended',
		'offboarding',
		'offboarded'
	] as const)('fences completion after %s', async (change) => {
		const token = await initialise();
		const nar = await verifiableNar('list-parent');
		await commitPath(
			token,
			uploadMetadata({
				storePathHash: hash,
				narHash: nar.narHash,
				fileHash: nar.fileHash,
				fileSize: nar.narBytes.byteLength,
				narSize: nar.narSize
			}),
			nar
		);
		const generation = narInfoGenerationSchema.parse(
			await narInfoGeneration(hash)
		);
		await insertReference(first, generation);
		const identity = { cache: defaultCache(), storePathHash: hash, generation };
		const repository = new AttestationListRevisionRepository(
			drizzle(env.CUPBOARD_DB, { schema }),
			fixtureTenant
		);
		const captured = await repository.get(identity);
		if (captured === undefined) {
			throw new Error('The source revision is missing');
		}
		switch (change) {
			case 'reference-change': {
				await insertReference(second, generation);
				break;
			}
			case 'newer-publication': {
				await env.CUPBOARD_DB.prepare(
					`INSERT INTO blob_ref_storage
				(tenant, cache_kind, cache_name, store_path_hash, generation, nar_hash, cache_generation, readable)
				SELECT tenant, cache_kind, cache_name, store_path_hash, generation + 1, nar_hash, cache_generation, readable
				FROM blob_ref_storage WHERE tenant = ? AND store_path_hash = ? AND generation = ?`
				)
					.bind(fixtureTenant, hash, generation)
					.run();

				break;
			}
			case 'cache-generation': {
				await env.CUPBOARD_DB.prepare(
					'UPDATE cache_lifecycle_storage SET generation = generation + 1 WHERE tenant = ?'
				)
					.bind(fixtureTenant)
					.run();

				break;
			}
			case 'suspended':
			case 'offboarding':
			case 'offboarded': {
				if (change === 'offboarded') {
					await env.CUPBOARD_DB.prepare(
						'DELETE FROM attestation_list_revision WHERE tenant = ?'
					)
						.bind(fixtureTenant)
						.run();
				}
				await env.CUPBOARD_DB.prepare(
					'UPDATE tenant SET status = ? WHERE id = ?'
				)
					.bind(change, fixtureTenant)
					.run();

				break;
			}
			// No default
		}
		const canPublish = change === 'unchanged' || change === 'suspended';
		const isCompleted = await repository.publish(
			captured,
			identity,
			{ cacheGeneration: cacheGenerationSchema.parse(1), narHash: nar.narHash },
			r2ObjectKeySchema.parse('completed-list')
		);
		const current = await repository.get(identity);
		expect({
			completed: isCompleted,
			publishedKey: current?.publishedKey ?? undefined
		}).toStrictEqual({
			completed: canPublish,
			publishedKey: canPublish ? 'completed-list' : undefined
		});
	});

	it('keeps publication retries idempotent and rejects another key for the captured revision', async () => {
		const token = await initialise();
		const nar = await verifiableNar('list-publication-retry');
		await commitPath(
			token,
			uploadMetadata({
				storePathHash: hash,
				narHash: nar.narHash,
				fileHash: nar.fileHash,
				fileSize: nar.narBytes.byteLength,
				narSize: nar.narSize
			}),
			nar
		);
		const identity = {
			cache: defaultCache(),
			storePathHash: hash,
			generation: narInfoGenerationSchema.parse(await narInfoGeneration(hash))
		};
		const parent = {
			cacheGeneration: cacheGenerationSchema.parse(1),
			narHash: nar.narHash
		};
		const repository = new AttestationListRevisionRepository(
			drizzle(env.CUPBOARD_DB, { schema }),
			fixtureTenant
		);
		expect(await repository.readState(identity, parent)).toStrictEqual({
			status: 'pending'
		});
		await insertReference(first, identity.generation);
		const captured = await repository.get(identity);
		if (captured === undefined) {
			throw new Error('The source revision is missing');
		}
		const outcomes = [
			await repository.publish(
				captured,
				identity,
				parent,
				r2ObjectKeySchema.parse('first-list')
			),
			await repository.publish(
				captured,
				identity,
				parent,
				r2ObjectKeySchema.parse('first-list')
			),
			await repository.publish(
				captured,
				identity,
				parent,
				r2ObjectKeySchema.parse('conflicting-list')
			)
		];
		expect({
			outcomes,
			state: await repository.readState(identity, parent)
		}).toStrictEqual({
			outcomes: [true, true, false],
			state: { status: 'ready', key: 'first-list' }
		});
		await insertReference(second, identity.generation);
		expect(await repository.readState(identity, parent)).toStrictEqual({
			status: 'pending'
		});
	});

	it.each([
		[
			'missing revision',
			"published_cache_generation = 1, published_nar_hash = 'parent'"
		],
		['missing parent', "published_revision = 1, published_key = 'partial-list'"]
	])(
		'refuses an incomplete publication with %s',
		async (_label, assignment) => {
			await insertReference(first);
			await expect(
				env.CUPBOARD_DB.prepare(
					`UPDATE attestation_list_revision SET ${assignment} WHERE tenant = ?`
				)
					.bind(fixtureTenant)
					.run()
			).rejects.toThrow();
			expect(await versions()).toStrictEqual([
				{
					cacheKind: 'default',
					cacheName: '',
					generation: 0,
					revision: 1,
					status: 'pending'
				}
			]);
		}
	);

	it('invalidates changed identities while leaving a no-op update unchanged', async () => {
		await insertReference(first);
		await env.CUPBOARD_DB.prepare(
			'UPDATE attestation_ref_storage SET readable = readable WHERE tenant = ?'
		)
			.bind(fixtureTenant)
			.run();
		expect(await versions()).toStrictEqual([
			{
				cacheKind: 'default',
				cacheName: '',
				generation: 0,
				revision: 1,
				status: 'pending'
			}
		]);
		await env.CUPBOARD_DB.prepare(
			'UPDATE attestation_ref_storage SET readable = 0 WHERE tenant = ?'
		)
			.bind(fixtureTenant)
			.run();
		await env.CUPBOARD_DB.prepare(
			"UPDATE attestation_ref_storage SET cache_kind = 'named', cache_name = 'builds', generation = 1 WHERE tenant = ?"
		)
			.bind(fixtureTenant)
			.run();
		expect(await versions()).toStrictEqual([
			{
				cacheKind: 'default',
				cacheName: '',
				generation: 0,
				revision: 3,
				status: 'pending'
			},
			{
				cacheKind: 'named',
				cacheName: 'builds',
				generation: 1,
				revision: 1,
				status: 'pending'
			}
		]);
	});

	it('bounds descriptor source reads before joining unavailable CAS metadata', async () => {
		await env.CUPBOARD_DB.prepare(
			`WITH RECURSIVE numbered(value) AS
			(SELECT 1 UNION ALL SELECT value + 1 FROM numbered WHERE value < 25000)
			INSERT INTO attestation_ref_storage (tenant,cache_kind,cache_name,store_path_hash,generation,predicate_type,digest)
			SELECT ?, 'default', NULL, ?, 0, ?, printf('%064x',value) FROM numbered`
		)
			.bind(fixtureTenant, hash, predicate)
			.run();
		const statements: { query: string; parameters: unknown[] }[] = [];
		const database = drizzle(env.CUPBOARD_DB, {
			schema,
			logger: {
				logQuery(query, parameters) {
					statements.push({ query, parameters });
				}
			}
		});
		const repository = new AttestationListRevisionRepository(
			database,
			fixtureTenant
		);
		const page = await repository.descriptorPage({
			cache: defaultCache(),
			storePathHash: hash,
			generation: narInfoGenerationSchema.parse(0)
		});
		expect(page).toStrictEqual({
			entries: Array.from({ length: 128 }, (_, index) => ({
				digest: (index + 1).toString(16).padStart(64, '0'),
				predicateType: predicate,
				size: undefined
			})),
			after: { predicateType: predicate, digest: '80'.padStart(64, '0') },
			hasMore: true
		});
		const statement = statements.at(0);
		if (statement === undefined) {
			throw new Error('The descriptor query was not recorded');
		}
		const measured = await env.CUPBOARD_DB.prepare(statement.query)
			.bind(...statement.parameters)
			.all();
		expect(measured.meta.rows_read).toBeLessThanOrEqual(258);
	});

	it('invalidates a published list atomically when a compatible writer removes a reference', async () => {
		await insertReference(first);
		await env.CUPBOARD_DB.prepare(
			`UPDATE attestation_list_revision SET published_revision = revision, published_cache_generation = 1, published_nar_hash = 'fixture-parent', published_key = ? WHERE tenant = ?`
		)
			.bind('published-list', fixtureTenant)
			.run();
		expect(await versions()).toStrictEqual([
			{
				cacheKind: 'default',
				cacheName: '',
				generation: 0,
				revision: 1,
				status: 'ready'
			}
		]);
		await env.CUPBOARD_DB.prepare(
			'DELETE FROM attestation_ref_storage WHERE tenant = ? AND digest = ?'
		)
			.bind(fixtureTenant, first)
			.run();
		expect(await versions()).toStrictEqual([
			{
				cacheKind: 'default',
				cacheName: '',
				generation: 0,
				revision: 2,
				status: 'pending'
			}
		]);
	});

	it('uses one revision per cache and narinfo generation despite nullable default identities', async () => {
		await insertReference(first);
		await insertReference(second);
		await insertReference(first, 1);
		await env.CUPBOARD_DB.prepare(
			`INSERT INTO attestation_ref_storage
			(tenant, cache_kind, cache_name, store_path_hash, generation, predicate_type, digest)
			VALUES (?, 'named', 'builds', ?, 0, ?, ?)`
		)
			.bind(fixtureTenant, hash, predicate, first)
			.run();
		expect(await versions()).toStrictEqual([
			{
				cacheKind: 'default',
				cacheName: '',
				generation: 0,
				revision: 2,
				status: 'pending'
			},
			{
				cacheKind: 'default',
				cacheName: '',
				generation: 1,
				revision: 1,
				status: 'pending'
			},
			{
				cacheKind: 'named',
				cacheName: 'builds',
				generation: 0,
				revision: 1,
				status: 'pending'
			}
		]);
	});

	it('rolls back reference retirement and invalidation together when the batch fails', async () => {
		await insertReference(first);
		await expect(
			env.CUPBOARD_DB.batch([
				env.CUPBOARD_DB.prepare(
					'DELETE FROM attestation_ref_storage WHERE tenant = ? AND digest = ?'
				).bind(fixtureTenant, first),
				env.CUPBOARD_DB.prepare(
					`INSERT INTO attestation_ref_storage
				(tenant, cache_kind, cache_name, store_path_hash, generation, predicate_type, digest)
				VALUES (?, 'named', NULL, ?, 0, ?, ?)`
				).bind(fixtureTenant, hash, predicate, second)
			])
		).rejects.toThrow();
		const reference = await env.CUPBOARD_DB.prepare(
			'SELECT digest FROM attestation_ref_storage WHERE tenant = ?'
		)
			.bind(fixtureTenant)
			.all();
		expect({
			references: reference.results,
			versions: await versions()
		}).toStrictEqual({
			references: [{ digest: first }],
			versions: [
				{
					cacheKind: 'default',
					cacheName: '',
					generation: 0,
					revision: 1,
					status: 'pending'
				}
			]
		});
	});
});
