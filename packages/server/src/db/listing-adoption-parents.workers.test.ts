import {
	cacheGenerationSchema,
	cacheNameSchema,
	type CacheScope,
	narInfoGenerationSchema,
	storePathHashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { and, asc, eq, gt } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
	listingAdoptionCaptureSequenceSchema,
	listingAdoptionCaptureSourceSchema
} from '../blob/listing-adoption-capture.ts';
import {
	type ListingAdoptionParent,
	type ListingAdoptionParentRefresh,
	type ListingAdoptionParentRefreshResult
} from '../blob/listing-adoption-parents.ts';
import { SharedFactsUnavailableError } from '../errors.ts';

import { cacheIdentityColumns } from './cache.ts';
import * as schema from './d1-schema.ts';
import { ListingAdoptionParentStore } from './listing-adoption-parents.ts';
import {
	sharedNarDiscoveryFixture,
	sharedNarSource
} from './shared-nar-discovery.test-support.ts';

const tenant = tenantIdSchema.parse('discovery-first');
const now = isoTimestamp(new Date('2026-01-01T00:00:00.000Z'));
const path = storePathHashSchema.parse('0'.repeat(32));
const missingPath = storePathHashSchema.parse('1'.repeat(32));
const kinds: readonly CacheScope['kind'][] = ['default', 'named'];

async function fixture(kind: CacheScope['kind'] = 'default') {
	const { database } = await sharedNarDiscoveryFixture(0);
	const cache: CacheScope =
		kind === 'default'
			? { kind }
			: { kind, name: cacheNameSchema.parse('private') };
	const columns = {
		cacheKind: kind,
		...(cache.kind === 'named' && { cacheName: cache.name })
	};
	await database.insert(schema.deploymentTransition).values({
		id: 'listing-adoption-parents',
		state: 'complete',
		updatedAt: now
	});
	await database.insert(schema.cacheLifecycle).values({
		tenant,
		...columns,
		generation: cacheGenerationSchema.parse(1),
		access: 'private',
		updatedAt: now
	});
	await database.insert(schema.blobReference).values(
		Array.from({ length: 5 }, (_, index) => ({
			tenant,
			...columns,
			cacheGeneration: cacheGenerationSchema.parse(index === 4 ? 2 : 1),
			storePathHash: path,
			generation: narInfoGenerationSchema.parse(index + 1),
			narHash: sharedNarSource(index + 1).narHash,
			readable: index !== 3
		}))
	);
	await database.insert(schema.pathReadRevocation).values({
		tenant,
		...columns,
		storePathHash: path,
		cacheGeneration: cacheGenerationSchema.parse(1),
		generation: narInfoGenerationSchema.parse(2),
		isPending: false
	});
	return {
		database,
		cache,
		request: { tenant, cache, storePathHashes: [path, missingPath] },
		store: new ListingAdoptionParentStore(database)
	};
}

async function projected(
	store: ListingAdoptionParentStore,
	request: ListingAdoptionParentRefresh
): Promise<ListingAdoptionParent> {
	const result = await store.refresh(request);
	const parent = result.kind === 'ready' ? result.parents[0] : undefined;
	if (parent === undefined) {
		throw new Error('The current readable parent was not projected');
	}
	return parent;
}

describe('listing adoption parent projection', () => {
	it('refuses early activation without querying uninstalled capture storage', async () => {
		const { database, request, store } = await fixture();
		await database
			.delete(schema.deploymentTransition)
			.where(eq(schema.deploymentTransition.id, 'listing-adoption-parents'));
		const original = env.CUPBOARD_DB.prepare.bind(env.CUPBOARD_DB);
		const preceding = vi
			.spyOn(env.CUPBOARD_DB, 'prepare')
			.mockImplementation((query) => {
				if (query.includes('listing_adoption_capture_state')) {
					throw new Error(
						'The preceding storage has no adoption capture table'
					);
				}
				return original(query);
			});
		try {
			await expect(store.refresh(request)).resolves.toStrictEqual({
				kind: 'unavailable'
			});
		} finally {
			preceding.mockRestore();
		}
	});

	it.each(['active', 'suspended', 'offboarding', 'offboarded'] as const)(
		'projects only eligible tenant state %s',
		async (status) => {
			const { database, request, store } = await fixture();
			const before = await projected(store, request);
			if (status === 'offboarded') {
				await database.delete(schema.blobReference);
				await database.delete(schema.pathReadRevocation);
				await database.delete(schema.attestationListRevision);
			}
			await database
				.update(schema.tenant)
				.set({ status })
				.where(eq(schema.tenant.id, tenant));
			const isEligible = status === 'active' || status === 'suspended';
			expect({
				result: await store.refresh(request),
				rows: await database
					.select({ id: schema.listingAdoptionParent.id })
					.from(schema.listingAdoptionParent)
			}).toStrictEqual({
				result: { kind: 'ready', parents: isEligible ? [before] : [] },
				rows: isEligible ? [{ id: before.id }] : []
			});
		}
	);

	it('rechecks source authority inside the batch and rotates the changed parent identity', async () => {
		const { database, request, store } = await fixture();
		const before = await projected(store, request);
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const intercept = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (queries) => {
				await database
					.update(schema.blobReference)
					.set({ readable: true })
					.where(
						eq(
							schema.blobReference.generation,
							narInfoGenerationSchema.parse(4)
						)
					);
				return original(queries);
			});
		let after: ListingAdoptionParent;
		try {
			after = await projected(store, request);
		} finally {
			intercept.mockRestore();
		}
		expect({ after, hasNewIdentity: after.id !== before.id }).toStrictEqual({
			after: {
				...before,
				id: after.id,
				updatedAt: after.updatedAt,
				generation: 4,
				narHash: sharedNarSource(4).narHash
			},
			hasNewIdentity: true
		});
	});

	it('recovers a lost committed reply without changing the stored parent identity', async () => {
		const { database, request, store } = await fixture();
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const reply = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (queries) => {
				await original(queries);
				throw new Error('The parent projection reply was lost');
			});
		try {
			await expect(store.refresh(request)).rejects.toBeInstanceOf(
				SharedFactsUnavailableError
			);
		} finally {
			reply.mockRestore();
		}
		const stored = await database
			.select()
			.from(schema.listingAdoptionParent)
			.get();
		const replayed = await projected(store, request);
		expect(replayed).toStrictEqual({
			id: stored?.id,
			tenant,
			cache: request.cache,
			cacheGeneration: 1,
			storePathHash: path,
			updatedAt: stored?.updatedAt,
			generation: 3,
			narHash: sharedNarSource(3).narHash
		});
	});

	it('rolls back a new parent if retiring an obsolete projection fails', async () => {
		const { database, cache, request, store } = await fixture();
		await database.insert(schema.listingAdoptionParent).values({
			tenant,
			...cacheIdentityColumns(cache),
			cacheGeneration: cacheGenerationSchema.parse(1),
			storePathHash: missingPath,
			generation: narInfoGenerationSchema.parse(1),
			narHash: sharedNarSource(1).narHash
		});
		await env.CUPBOARD_DB.prepare(
			"CREATE TRIGGER test_parent_projection_abort BEFORE DELETE ON listing_adoption_parent BEGIN SELECT RAISE(ABORT,'parent retirement failure'); END"
		).run();
		try {
			await expect(store.refresh(request)).rejects.toBeInstanceOf(
				SharedFactsUnavailableError
			);
		} finally {
			await env.CUPBOARD_DB.prepare(
				'DROP TRIGGER test_parent_projection_abort'
			).run();
		}
		const rows = await database
			.select({ storePathHash: schema.listingAdoptionParent.storePathHash })
			.from(schema.listingAdoptionParent);
		const recovered = await projected(store, request);
		expect({ rows, recoveredGeneration: recovered.generation }).toStrictEqual({
			rows: [{ storePathHash: missingPath }],
			recoveredGeneration: 3
		});
	});

	it('fences readiness lost after the initial check without deleting an existing parent', async () => {
		const { database, request, store } = await fixture();
		const before = await projected(store, request);
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const intercept = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (queries) => {
				await database
					.update(schema.listingAdoptionCaptureState)
					.set({ isReady: false });
				await database
					.update(schema.blobReference)
					.set({ readable: true })
					.where(
						eq(
							schema.blobReference.generation,
							narInfoGenerationSchema.parse(4)
						)
					);
				return original(queries);
			});
		try {
			await expect(store.refresh(request)).resolves.toStrictEqual({
				kind: 'unavailable'
			});
		} finally {
			intercept.mockRestore();
		}
		expect(
			await database
				.select({ id: schema.listingAdoptionParent.id })
				.from(schema.listingAdoptionParent)
		).toStrictEqual([{ id: before.id }]);
	});

	it('rejects an oversized refresh before reading or changing D1', async () => {
		const { request, store } = await fixture();
		const prepared = vi.spyOn(env.CUPBOARD_DB, 'prepare');
		try {
			await expect(
				store.refresh({
					...request,
					storePathHashes: Array.from({ length: 33 }, () => path)
				})
			).rejects.toBeInstanceOf(z.ZodError);
			expect(prepared).not.toHaveBeenCalled();
		} finally {
			prepared.mockRestore();
		}
	});

	it.each(
		kinds.flatMap((kind) =>
			[
				'deleted',
				'unreadable',
				'replaced',
				'revoked-insert',
				'revoked-update'
			].map((change) => ({ kind, change }))
		)
	)(
		'retires the $kind pointer when its source is $change',
		async ({ kind, change }) => {
			const { database, cache, request, store } = await fixture(kind);
			await projected(store, request);
			const clock = await database
				.select()
				.from(schema.listingAdoptionCaptureState)
				.get();
			const source = eq(
				schema.blobReference.generation,
				narInfoGenerationSchema.parse(3)
			);
			switch (change) {
				case 'deleted': {
					await database.delete(schema.blobReference).where(source);
					break;
				}
				case 'unreadable': {
					await database
						.update(schema.blobReference)
						.set({ readable: false })
						.where(source);
					break;
				}
				case 'replaced': {
					await database
						.update(schema.blobReference)
						.set({ narHash: sharedNarSource(99).narHash })
						.where(source);
					break;
				}
				case 'revoked-insert': {
					await database.delete(schema.pathReadRevocation);
					await database.insert(schema.pathReadRevocation).values({
						tenant,
						...cacheIdentityColumns(cache),
						storePathHash: path,
						cacheGeneration: cacheGenerationSchema.parse(1),
						generation: narInfoGenerationSchema.parse(3)
					});
					break;
				}
				case 'revoked-update': {
					await database
						.update(schema.pathReadRevocation)
						.set({ generation: narInfoGenerationSchema.parse(3) });
					break;
				}
			}
			const after =
				clock?.latest ?? listingAdoptionCaptureSequenceSchema.parse(0);
			const rows = await database
				.select({ source: schema.listingAdoptionCaptureEvent.source })
				.from(schema.listingAdoptionCaptureEvent)
				.where(gt(schema.listingAdoptionCaptureEvent.id, after))
				.orderBy(asc(schema.listingAdoptionCaptureEvent.id));
			const events = rows
				.map((row) => listingAdoptionCaptureSourceSchema.parse(row.source))
				.toSorted((left, right) =>
					left.kind === 'parent' && right.kind === 'parent'
						? byCodeUnit(left.narHash, right.narHash)
						: byCodeUnit(left.kind, right.kind)
				);
			expect({
				rows: await database.select().from(schema.listingAdoptionParent),
				events
			}).toStrictEqual({
				rows: [],
				events: (change === 'replaced'
					? [sharedNarSource(3).narHash, sharedNarSource(99).narHash]
					: [sharedNarSource(3).narHash]
				).map((narHash) => ({
					kind: 'parent',
					tenant,
					cache,
					storePathHash: path,
					cacheGeneration: 1,
					generation: 3,
					narHash
				}))
			});
		}
	);

	it.each(kinds)(
		'preserves a newer %s pointer when an older reference is removed',
		async (kind) => {
			const { database, request, store } = await fixture(kind);
			const before = await projected(store, request);
			await database
				.delete(schema.blobReference)
				.where(
					eq(schema.blobReference.generation, narInfoGenerationSchema.parse(1))
				);
			expect(await store.refresh(request)).toStrictEqual({
				kind: 'ready',
				parents: [before]
			});
		}
	);

	it.each(['active', 'suspended'] as const)(
		'refuses tenant retirement while %s',
		async (status) => {
			const { database, request, store } = await fixture();
			const before = await projected(store, request);
			await database
				.update(schema.tenant)
				.set({ status })
				.where(eq(schema.tenant.id, tenant));
			expect({
				retired: await store.retireTenant(tenant, 2),
				result: await store.refresh(request)
			}).toStrictEqual({
				retired: 0,
				result: { kind: 'ready', parents: [before] }
			});
		}
	);

	it('fences a tenant absence check against concurrent storage activation', async () => {
		const { database, store } = await fixture();
		await database
			.delete(schema.deploymentTransition)
			.where(eq(schema.deploymentTransition.id, 'listing-adoption-parents'));
		const absence = await store.tenantAbsence(tenant);
		const eligible = database
			.select({ id: schema.tenant.id })
			.from(schema.tenant)
			.where(and(eq(schema.tenant.id, tenant), absence));
		const before = await eligible;
		await database.insert(schema.deploymentTransition).values({
			id: 'listing-adoption-parents',
			state: 'expanded',
			updatedAt: now
		});
		expect({ before, after: await eligible }).toStrictEqual({
			before: [{ id: tenant }],
			after: []
		});
	});

	it.each(kinds)(
		'preserves a recreated %s cache pointer during old-generation cleanup',
		async (kind) => {
			const { database, request, store } = await fixture(kind);
			const before = await projected(store, request);
			await database
				.update(schema.cacheLifecycle)
				.set({ generation: cacheGenerationSchema.parse(2) });
			const recreated = await projected(store, request);
			await database
				.update(schema.pathReadRevocation)
				.set({ generation: narInfoGenerationSchema.parse(100) });
			await database
				.delete(schema.blobReference)
				.where(
					eq(
						schema.blobReference.cacheGeneration,
						cacheGenerationSchema.parse(1)
					)
				);
			expect({
				recreated,
				hasNewIdentity: recreated.id !== before.id,
				stored: await database
					.select({ id: schema.listingAdoptionParent.id })
					.from(schema.listingAdoptionParent),
				refreshed: await store.refresh(request)
			}).toStrictEqual({
				recreated: {
					...before,
					id: recreated.id,
					updatedAt: recreated.updatedAt,
					cacheGeneration: 2,
					generation: 5,
					narHash: sharedNarSource(5).narHash
				},
				hasNewIdentity: true,
				stored: [{ id: recreated.id }],
				refreshed: { kind: 'ready', parents: [recreated] }
			});
		}
	);

	it('retires orphaned tenant metadata in bounded pages independently of source rows', async () => {
		const { database, cache, store } = await fixture();
		await database.insert(schema.listingAdoptionParent).values(
			Array.from({ length: 3 }, (_, index) => ({
				tenant,
				...cacheIdentityColumns(cache),
				cacheGeneration: cacheGenerationSchema.parse(1),
				storePathHash: storePathHashSchema.parse(
					String(index).padStart(32, '0')
				),
				generation: narInfoGenerationSchema.parse(1),
				narHash: sharedNarSource(index).narHash
			}))
		);
		await database
			.update(schema.tenant)
			.set({ status: 'offboarding' })
			.where(eq(schema.tenant.id, tenant));
		expect({
			first: await store.retireTenant(tenant, 2),
			second: await store.retireTenant(tenant, 2),
			again: await store.retireTenant(tenant, 2),
			rows: await database.select().from(schema.listingAdoptionParent)
		}).toStrictEqual({ first: 2, second: 1, again: 0, rows: [] });
	});

	it.each(kinds)(
		'bounds a full %s refresh across 25,000 unrelated projected paths and old generations',
		async (kind) => {
			const { cache, store } = await fixture(kind);
			await env.CUPBOARD_DB.prepare(
				"WITH RECURSIVE numbered(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM numbered WHERE value<25000) INSERT INTO listing_adoption_parent (id,tenant,cache_kind,cache_name,cache_generation,store_path_hash,generation,nar_hash) SELECT printf('%032x',value),?,?,CASE WHEN ?='named' THEN 'private' ELSE NULL END,1,printf('%032d',value),1,? FROM numbered"
			)
				.bind(tenant, kind, kind, sharedNarSource(0).narHash)
				.run();
			await env.CUPBOARD_DB.prepare(
				"WITH RECURSIVE numbered(value) AS (SELECT 6 UNION ALL SELECT value+1 FROM numbered WHERE value<25005) INSERT INTO blob_ref_storage (tenant,cache_kind,cache_name,cache_generation,store_path_hash,generation,nar_hash,readable) SELECT ?,?,CASE WHEN ?='named' THEN 'private' ELSE NULL END,1,?,value,?,0 FROM numbered"
			)
				.bind(tenant, kind, kind, path, sharedNarSource(0).narHash)
				.run();
			const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
			let rowsRead = 0;
			const measured = vi
				.spyOn(env.CUPBOARD_DB, 'batch')
				.mockImplementationOnce(async (queries) => {
					const rows = await original(queries);
					rowsRead = rows.reduce(
						(total, result) => total + result.meta.rows_read,
						0
					);
					return rows;
				});
			let result: ListingAdoptionParentRefreshResult;
			try {
				result = await store.refresh({
					tenant,
					cache,
					storePathHashes: Array.from({ length: 32 }, (_, index) =>
						storePathHashSchema.parse(String(index).padStart(32, '0'))
					)
				});
			} finally {
				measured.mockRestore();
			}
			expect({
				result:
					result.kind === 'ready'
						? result.parents.map(({ generation, storePathHash, narHash }) => ({
								generation,
								storePathHash,
								narHash
							}))
						: result,
				boundedReads: rowsRead > 0 && rowsRead <= 4096
			}).toStrictEqual({
				result: [
					{
						generation: 3,
						storePathHash: path,
						narHash: sharedNarSource(3).narHash
					}
				],
				boundedReads: true
			});
		}
	);

	it.each(kinds)(
		'projects and replays a full page of 32 eligible %s parents',
		async (kind) => {
			const { cache, store } = await fixture(kind);
			await env.CUPBOARD_DB.prepare(
				"WITH RECURSIVE numbered(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM numbered WHERE value<31) INSERT INTO blob_ref_storage (tenant,cache_kind,cache_name,cache_generation,store_path_hash,generation,nar_hash) SELECT ?,?,CASE WHEN ?='named' THEN 'private' ELSE NULL END,1,printf('%032d',value),3,? FROM numbered"
			)
				.bind(tenant, kind, kind, sharedNarSource(3).narHash)
				.run();
			const request = {
				tenant,
				cache,
				storePathHashes: Array.from({ length: 32 }, (_, index) =>
					storePathHashSchema.parse(String(index).padStart(32, '0'))
				)
			};
			const first = await store.refresh(request);
			const parents = first.kind === 'ready' ? first.parents : [];
			const expected = {
				kind: 'ready',
				parents: request.storePathHashes.map((storePathHash, index) => ({
					id: parents[index]?.id,
					tenant,
					cache,
					cacheGeneration: 1,
					storePathHash,
					generation: 3,
					narHash: sharedNarSource(3).narHash,
					updatedAt: parents[index]?.updatedAt
				}))
			};
			expect({ first, repeated: await store.refresh(request) }).toStrictEqual({
				first: expected,
				repeated: expected
			});
		}
	);

	it.each(kinds)(
		'projects only the current readable %s publication and reuses its identity',
		async (kind) => {
			const { database, cache, request, store } = await fixture(kind);
			const first = await store.refresh(request);
			if (first.kind !== 'ready' || first.parents[0] === undefined) {
				throw new Error('The current readable parent was not projected');
			}
			const { id, updatedAt } = first.parents[0];
			expect({
				first,
				second: await store.refresh(request),
				cas: await database.select().from(schema.casObject),
				references: await database.select().from(schema.artifactReference)
			}).toStrictEqual({
				first: {
					kind: 'ready',
					parents: [
						{
							id,
							tenant,
							cache,
							cacheGeneration: 1,
							storePathHash: path,
							generation: 3,
							narHash: sharedNarSource(3).narHash,
							updatedAt
						}
					]
				},
				second: first,
				cas: [],
				references: []
			});
		}
	);

	it('refuses projection while the cleanup contract is expanded', async () => {
		const { database, request, store } = await fixture();
		await database
			.update(schema.deploymentTransition)
			.set({ state: 'expanded' })
			.where(eq(schema.deploymentTransition.id, 'listing-adoption-parents'));
		expect({
			result: await store.refresh(request),
			rows: await database.select().from(schema.listingAdoptionParent)
		}).toStrictEqual({ result: { kind: 'unavailable' }, rows: [] });
	});
});
