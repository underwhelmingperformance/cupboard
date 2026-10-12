import {
	narInfoGenerationSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import {
	attestationListLocalStep,
	casStorageLocalStep
} from '@cupboard/protocol/deployment';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it } from 'vitest';

import { AttestationListRevisionRepository } from '../db/attestation-list-revision.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	commitPath,
	currentServer,
	defaultCache,
	initialise,
	narInfoGeneration,
	recordTransition,
	resetTestServer,
	uploadMetadata,
	verifiableNar,
	withoutAlarmArming
} from '../test-support.ts';

import { AttestationListInitialisationService } from './attestation-list-initialisation-service.ts';
import { ServerContext } from './context.ts';
import { recordLocalStep } from './local-step.ts';

const hash = storePathHashSchema.parse('a'.repeat(32));

async function publish() {
	const token = await initialise();
	const nar = await verifiableNar('revision-initialisation');
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
	return {
		identity: { cache: defaultCache(), storePathHash: hash, generation },
		narHash: nar.narHash
	};
}

describe('attestation list initialisation', () => {
	beforeEach(resetTestServer);

	it('captures a newly published NAR with no attestation references', async () => {
		const { identity } = await publish();
		const repository = new AttestationListRevisionRepository(
			drizzleD1(env.CUPBOARD_DB, { schema: d1Schema }),
			fixtureTenant
		);
		const row = await repository.get(identity);
		expect(
			row === undefined
				? undefined
				: {
						revision: row.revision,
						publishedRevision: row.publishedRevision ?? undefined
					}
		).toStrictEqual({ revision: 1, publishedRevision: undefined });
	});

	it('resumes bounded historical pages and skips older generations of one path', async () => {
		const { narHash } = await publish();
		await env.CUPBOARD_DB.batch([
			env.CUPBOARD_DB.prepare(
				`WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM rows WHERE n < 25000)
   INSERT INTO blob_ref_storage (tenant, cache_kind, store_path_hash, generation, nar_hash, cache_generation)
   SELECT ?, 'default', '00000000000000000000000000000000', n, ?, 1 FROM rows`
			).bind(fixtureTenant, narHash),
			env.CUPBOARD_DB.prepare(
				`WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM rows WHERE n < 80)
   INSERT INTO blob_ref_storage (tenant, cache_kind, store_path_hash, generation, nar_hash, cache_generation)
   SELECT ?, 'default', printf('%032d',n), 0, ?, 1 FROM rows`
			).bind(fixtureTenant, narHash),
			env.CUPBOARD_DB.prepare(
				'DELETE FROM attestation_list_revision WHERE tenant = ?'
			).bind(fixtureTenant)
		]);

		const reads: number[] = [];
		const statement = (
			inner: D1PreparedStatement,
			query: string
		): D1PreparedStatement =>
			new Proxy(inner, {
				get(target, property) {
					if (property === 'bind') {
						return (...values: unknown[]) =>
							statement(target.bind(...values), query);
					}
					if (property === 'all') {
						return async () => {
							const result = await target.all();
							if (query.includes('WITH RECURSIVE cache_paths')) {
								reads.push(result.meta.rows_read);
							}
							return result;
						};
					}
					const value: unknown = Reflect.get(target, property, target);
					return typeof value === 'function'
						? (...values: unknown[]): unknown =>
								Reflect.apply(value, target, values)
						: value;
				}
			});
		const binding = new Proxy(env.CUPBOARD_DB, {
			get(target, property) {
				if (property === 'prepare') {
					return (query: string) => statement(target.prepare(query), query);
				}
				const value: unknown = Reflect.get(target, property, target);
				return typeof value === 'function'
					? (...values: unknown[]): unknown =>
							Reflect.apply(value, target, values)
					: value;
			}
		});
		const outcome = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const context = new ServerContext(state, {
					...instance.context.env,
					CUPBOARD_DB: binding
				});
				const pages = [];
				for (let pass = 0; pass < 10; pass++) {
					const page = await new AttestationListInitialisationService(
						context
					).advance();
					pages.push(page);
					if (page.status === 'complete') {
						break;
					}
				}
				return pages;
			}
		);
		expect({
			pages: outcome,
			isBounded: Math.max(...reads) < 256
		}).toStrictEqual({
			pages: [
				{ status: 'pending', visited: 32, created: 32 },
				{ status: 'pending', visited: 32, created: 32 },
				{ status: 'pending', visited: 18, created: 18 },
				{ status: 'complete', visited: 0, created: 0 }
			],
			isBounded: true
		});

		const oldest = await env.CUPBOARD_DB.prepare(
			'SELECT generation FROM attestation_list_revision WHERE tenant = ? AND store_path_hash = ?'
		)
			.bind(fixtureTenant, '0'.repeat(32))
			.all();
		expect(oldest.results).toStrictEqual([{ generation: 25_000 }]);
	});
	it('records step 6 before the new transition and step 7 only after historical initialisation', async () => {
		await withoutAlarmArming(async () => {
			await publish();
			await recordTransition('cache-identity', 'complete');
			await recordTransition('cas-storage', 'expanded');
			const before = await runInDurableObject(currentServer(), (instance) =>
				recordLocalStep(
					instance.context,
					[],
					isoTimestamp(new Date()),
					casStorageLocalStep
				)
			);
			expect(before).toStrictEqual({
				kind: 'recorded',
				step: casStorageLocalStep,
				progressed: true
			});
			await recordTransition('attestation-list-revision', 'expanded');
			await env.CUPBOARD_DB.prepare(
				'DELETE FROM attestation_list_revision WHERE tenant = ?'
			)
				.bind(fixtureTenant)
				.run();
			const first = await runInDurableObject(currentServer(), (instance) =>
				recordLocalStep(
					instance.context,
					[],
					isoTimestamp(new Date()),
					attestationListLocalStep
				)
			);
			const pending = await env.CUPBOARD_DB.prepare(
				'SELECT local_step AS step FROM tenant WHERE id = ?'
			)
				.bind(fixtureTenant)
				.first<{ step: number }>();
			expect({ first, pending }).toStrictEqual({
				first: { kind: 'incomplete', projected: 1, progressed: true },
				pending: { step: 6 }
			});
			const second = await runInDurableObject(currentServer(), (instance) =>
				recordLocalStep(
					instance.context,
					[],
					isoTimestamp(new Date()),
					attestationListLocalStep
				)
			);
			expect(second).toStrictEqual({
				kind: 'recorded',
				step: attestationListLocalStep,
				progressed: true
			});
		});
	});

	it('refuses reader activation while an active tenant is below step 7', async () => {
		await publish();
		const migration = env.TEST_MIGRATIONS.find(
			(item) => item.name === '0050_attestation_list_revision_contract.sql'
		);
		if (migration === undefined) {
			throw new Error('The reader activation migration is missing');
		}
		await expect(
			env.CUPBOARD_DB.batch(
				migration.queries.map((query) => env.CUPBOARD_DB.prepare(query))
			)
		).rejects.toThrow('CHECK constraint failed');
		await env.CUPBOARD_DB.prepare(
			'UPDATE tenant SET local_step = 7 WHERE id = ?'
		)
			.bind(fixtureTenant)
			.run();
		await env.CUPBOARD_DB.batch(
			migration.queries.map((query) => env.CUPBOARD_DB.prepare(query))
		);
	});
});
