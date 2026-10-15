import {
	cacheGenerationSchema,
	cacheNameSchema,
	type CacheScope,
	narInfoGenerationSchema,
	storePathHashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { asc, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import {
	listingAdoptionCaptureSequenceSchema,
	type ListingAdoptionCaptureSource,
	listingAdoptionCaptureSourceSchema
} from '../blob/listing-adoption-capture.ts';
import { listingAdoptionSeedEpochSchema } from '../blob/listing-adoption-seed.ts';
import { SharedFactsUnavailableError } from '../errors.ts';

import { cacheIdentityColumns } from './cache.ts';
import * as schema from './d1-schema.ts';
import {
	type ListingAdoptionParentSeedResult,
	ListingAdoptionParentSeedStore
} from './listing-adoption-parent-seed.ts';
import {
	sharedNarDiscoveryFixture,
	sharedNarSource
} from './shared-nar-discovery.test-support.ts';

const tenant = tenantIdSchema.parse('discovery-first');
const now = isoTimestamp(new Date('2026-01-01T00:00:00.000Z'));
const kinds: readonly CacheScope['kind'][] = ['default', 'named'];

function scope(kind: CacheScope['kind']): CacheScope {
	return kind === 'default'
		? { kind }
		: { kind, name: cacheNameSchema.parse('private') };
}

function parent(
	index: number,
	kind: CacheScope['kind']
): Extract<ListingAdoptionCaptureSource, { kind: 'parent' }> {
	return {
		kind: 'parent',
		tenant,
		cache: scope(kind),
		cacheGeneration: cacheGenerationSchema.parse(1),
		storePathHash: storePathHashSchema.parse(String(index).padStart(32, '0')),
		generation: narInfoGenerationSchema.parse(3),
		narHash: sharedNarSource(index).narHash
	};
}

async function fixture(
	count = 65,
	selected: readonly CacheScope['kind'][] = kinds
) {
	const { database } = await sharedNarDiscoveryFixture(0);
	await database.insert(schema.deploymentTransition).values([
		{ id: 'listing-adoption-parents', state: 'complete', updatedAt: now },
		{ id: 'listing-adoption-parent-seed', state: 'complete', updatedAt: now }
	]);
	for (const kind of selected) {
		await database.insert(schema.cacheLifecycle).values({
			tenant,
			...cacheIdentityColumns(scope(kind)),
			generation: cacheGenerationSchema.parse(1),
			access: 'private',
			updatedAt: now
		});
		if (count === 0) {
			continue;
		}
		await env.CUPBOARD_DB.prepare(
			"WITH RECURSIVE numbered(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM numbered WHERE value<?) INSERT INTO blob_ref_storage (tenant,cache_kind,cache_name,cache_generation,store_path_hash,generation,nar_hash) SELECT ?,?,CASE WHEN ?='named' THEN 'private' ELSE NULL END,1,printf('%032d',value),3,'sha256:' || printf('%052d',value) FROM numbered"
		)
			.bind(count, tenant, kind, kind)
			.run();
	}
	await database.delete(schema.listingAdoptionCaptureEvent);
	await database
		.update(schema.listingAdoptionCaptureState)
		.set({ latest: listingAdoptionCaptureSequenceSchema.parse(0) });
	return { database, store: new ListingAdoptionParentSeedStore(database) };
}

async function captures(
	database: Awaited<ReturnType<typeof fixture>>['database']
) {
	const rows = await database
		.select({ source: schema.listingAdoptionCaptureEvent.source })
		.from(schema.listingAdoptionCaptureEvent)
		.orderBy(asc(schema.listingAdoptionCaptureEvent.id));
	return rows.map(({ source }) =>
		listingAdoptionCaptureSourceSchema.parse(source)
	);
}

async function progress(
	database: Awaited<ReturnType<typeof fixture>>['database']
) {
	const table = schema.listingAdoptionParentSeed;
	const rows = await database
		.select({
			kind: table.cacheKind,
			scanned: table.scanned,
			captured: table.captured,
			isComplete: table.isComplete,
			pageCaptureAfter: table.pageCaptureAfter
		})
		.from(table)
		.orderBy(asc(table.cacheKind));
	return rows.map(({ pageCaptureAfter, ...row }) => ({
		...row,
		pageCaptureAfter: pageCaptureAfter ?? undefined
	}));
}

describe('historical listing adoption parent seed', () => {
	it.each(kinds)(
		'bounds a full %s checkpoint across 25,000 retained generations',
		async (kind) => {
			const { database, store } = await fixture(65, [kind]);
			await env.CUPBOARD_DB.prepare(
				"WITH RECURSIVE numbered(value) AS (SELECT 4 UNION ALL SELECT value+1 FROM numbered WHERE value<25003) INSERT INTO blob_ref_storage (tenant,cache_kind,cache_name,cache_generation,store_path_hash,generation,nar_hash,readable) SELECT ?,?,CASE WHEN ?='named' THEN 'private' ELSE NULL END,1,?,value,?,0 FROM numbered"
			)
				.bind(
					tenant,
					kind,
					kind,
					storePathHashSchema.parse('1'.padStart(32, '0')),
					sharedNarSource(99).narHash
				)
				.run();
			const originalPrepare = env.CUPBOARD_DB.prepare.bind(env.CUPBOARD_DB);
			const originalBatch = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
			let maximumParameters = 0;
			let maximumQueryBytes = 0;
			let rowsRead = 0;
			let statements = 0;
			const restoreBindings: (() => void)[] = [];
			const prepared = vi
				.spyOn(env.CUPBOARD_DB, 'prepare')
				.mockImplementation((query) => {
					maximumQueryBytes = Math.max(
						maximumQueryBytes,
						new TextEncoder().encode(query).byteLength
					);
					const statement = originalPrepare(query);
					const originalBind = statement.bind.bind(statement);
					const binding = vi
						.spyOn(statement, 'bind')
						.mockImplementation((...values) => {
							maximumParameters = Math.max(maximumParameters, values.length);
							return originalBind(...values);
						});
					restoreBindings.push(() => {
						binding.mockRestore();
					});
					return statement;
				});
			const measured = vi
				.spyOn(env.CUPBOARD_DB, 'batch')
				.mockImplementationOnce(async (queries) => {
					const result = await originalBatch(queries);
					statements = queries.length;
					rowsRead = result.reduce(
						(total, row) => total + row.meta.rows_read,
						0
					);
					return result;
				});
			let result: ListingAdoptionParentSeedResult;
			try {
				result = await store.advance(kind);
			} finally {
				measured.mockRestore();
				prepared.mockRestore();
				for (const restore of restoreBindings) {
					restore();
				}
			}
			expect({
				result,
				statements,
				readsBounded: rowsRead > 0 && rowsRead <= 2048,
				parametersBounded: maximumParameters > 0 && maximumParameters <= 100,
				queryBytesBounded:
					maximumQueryBytes > 0 && maximumQueryBytes <= 100_000,
				captures: await captures(database)
			}).toStrictEqual({
				result: {
					kind: 'advanced',
					scanned: 32,
					captured: 32,
					isComplete: false
				},
				statements: 34,
				readsBounded: true,
				parametersBounded: true,
				queryBytesBounded: true,
				captures: Array.from({ length: 32 }, (_, index) =>
					parent(index + 1, kind)
				)
			});
		}
	);

	it('recovers a lost committed reply without repeating the page', async () => {
		const { database, store } = await fixture(65, ['default']);
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const reply = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (queries) => {
				await original(queries);
				throw new Error('The seed checkpoint reply was lost');
			});
		try {
			await expect(store.advance('default')).rejects.toBeInstanceOf(
				SharedFactsUnavailableError
			);
		} finally {
			reply.mockRestore();
		}
		expect({
			next: await store.advance('default'),
			captures: await captures(database),
			progress: await progress(database)
		}).toStrictEqual({
			next: { kind: 'advanced', scanned: 32, captured: 32, isComplete: false },
			captures: Array.from({ length: 64 }, (_, index) =>
				parent(index + 1, 'default')
			),
			progress: [
				{
					kind: 'default',
					scanned: 64,
					captured: 64,
					isComplete: false,
					pageCaptureAfter: undefined
				}
			]
		});
	});

	it('rolls back captures and the page marker when the checkpoint fails', async () => {
		const { database, store } = await fixture(65, ['default']);
		await env.CUPBOARD_DB.prepare(
			"CREATE TRIGGER test_parent_seed_abort BEFORE UPDATE ON listing_adoption_parent_seed WHEN NEW.scanned > 0 BEGIN SELECT RAISE(ABORT,'parent seed checkpoint failure'); END"
		).run();
		try {
			await expect(store.advance('default')).rejects.toBeInstanceOf(
				SharedFactsUnavailableError
			);
		} finally {
			await env.CUPBOARD_DB.prepare(
				'DROP TRIGGER test_parent_seed_abort'
			).run();
		}
		const before = {
			captures: await captures(database),
			progress: await progress(database)
		};
		expect({
			before,
			retry: await store.advance('default'),
			captures: await captures(database),
			progress: await progress(database)
		}).toStrictEqual({
			before: {
				captures: [],
				progress: [
					{
						kind: 'default',
						scanned: 0,
						captured: 0,
						isComplete: false,
						pageCaptureAfter: undefined
					}
				]
			},
			retry: { kind: 'advanced', scanned: 32, captured: 32, isComplete: false },
			captures: Array.from({ length: 32 }, (_, index) =>
				parent(index + 1, 'default')
			),
			progress: [
				{
					kind: 'default',
					scanned: 32,
					captured: 32,
					isComplete: false,
					pageCaptureAfter: undefined
				}
			]
		});
	});

	it('fences readiness lost after selection without leaving a page marker', async () => {
		const { database, store } = await fixture(1, ['default']);
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const readiness = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (queries) => {
				await database
					.update(schema.listingAdoptionCaptureState)
					.set({ isReady: false });
				return original(queries);
			});
		try {
			await expect(store.advance('default')).resolves.toStrictEqual({
				kind: 'stale'
			});
		} finally {
			readiness.mockRestore();
		}
		const before = {
			captures: await captures(database),
			progress: await progress(database)
		};
		await database
			.update(schema.listingAdoptionCaptureState)
			.set({ isReady: true });
		expect({
			before,
			retry: await store.advance('default'),
			captures: await captures(database),
			progress: await progress(database)
		}).toStrictEqual({
			before: {
				captures: [],
				progress: [
					{
						kind: 'default',
						scanned: 0,
						captured: 0,
						isComplete: false,
						pageCaptureAfter: undefined
					}
				]
			},
			retry: { kind: 'advanced', scanned: 1, captured: 1, isComplete: true },
			captures: [parent(1, 'default')],
			progress: [
				{
					kind: 'default',
					scanned: 1,
					captured: 1,
					isComplete: true,
					pageCaptureAfter: undefined
				}
			]
		});
	});

	it('rechecks changed source authority and excludes earlier live captures from its counter', async () => {
		const { database, store } = await fixture(1, ['default']);
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const source = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (queries) => {
				await database.update(schema.blobReference).set({
					generation: narInfoGenerationSchema.parse(4),
					narHash: sharedNarSource(99).narHash
				});
				return original(queries);
			});
		let result: ListingAdoptionParentSeedResult;
		try {
			result = await store.advance('default');
		} finally {
			source.mockRestore();
		}
		const changed = {
			...parent(1, 'default'),
			generation: 4,
			narHash: sharedNarSource(99).narHash
		};
		expect({
			result,
			captures: await captures(database),
			progress: await progress(database)
		}).toStrictEqual({
			result: { kind: 'advanced', scanned: 1, captured: 1, isComplete: true },
			captures: [changed, changed],
			progress: [
				{
					kind: 'default',
					scanned: 1,
					captured: 1,
					isComplete: true,
					pageCaptureAfter: undefined
				}
			]
		});
	});

	it('advances a selected deleted boundary without counting a capture', async () => {
		const { database, store } = await fixture(1, ['default']);
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const source = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (queries) => {
				await database.delete(schema.blobReference);
				return original(queries);
			});
		let result: ListingAdoptionParentSeedResult;
		try {
			result = await store.advance('default');
		} finally {
			source.mockRestore();
		}
		expect({
			result,
			captures: await captures(database),
			progress: await progress(database),
			again: await store.advance('default')
		}).toStrictEqual({
			result: { kind: 'advanced', scanned: 1, captured: 0, isComplete: true },
			captures: [],
			progress: [
				{
					kind: 'default',
					scanned: 1,
					captured: 0,
					isComplete: true,
					pageCaptureAfter: undefined
				}
			],
			again: { kind: 'complete' }
		});
	});

	it('rejects an old page after the seed epoch is replaced', async () => {
		const { database, store } = await fixture(65, ['default']);
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const replacement = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (queries) => {
				const row = await database
					.select()
					.from(schema.listingAdoptionParentSeed)
					.get();
				if (row === undefined) {
					throw new Error('The seed checkpoint was not initialised');
				}
				const epoch = listingAdoptionSeedEpochSchema.parse(
					row.epoch === 'e'.repeat(32) ? 'f'.repeat(32) : 'e'.repeat(32)
				);
				await database.update(schema.listingAdoptionParentSeed).set({ epoch });
				return original(queries);
			});
		try {
			await expect(store.advance('default')).resolves.toStrictEqual({
				kind: 'stale'
			});
		} finally {
			replacement.mockRestore();
		}
		const before = {
			captures: await captures(database),
			progress: await progress(database)
		};
		expect({
			before,
			retry: await store.advance('default'),
			captures: await captures(database)
		}).toStrictEqual({
			before: {
				captures: [],
				progress: [
					{
						kind: 'default',
						scanned: 0,
						captured: 0,
						isComplete: false,
						pageCaptureAfter: undefined
					}
				]
			},
			retry: { kind: 'advanced', scanned: 32, captured: 32, isComplete: false },
			captures: Array.from({ length: 32 }, (_, index) =>
				parent(index + 1, 'default')
			)
		});
	});

	it.each(['after', 'through'] as const)(
		'fences the named %s cache component of a stale window',
		async (field) => {
			const { database, store } = await fixture(65, ['named']);
			await store.advance('named');
			const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
			const concurrent = vi
				.spyOn(env.CUPBOARD_DB, 'batch')
				.mockImplementationOnce(async (queries) => {
					const change =
						field === 'after'
							? { afterCacheName: cacheNameSchema.parse('other') }
							: { throughCacheName: cacheNameSchema.parse('zzz') };
					await database.update(schema.listingAdoptionParentSeed).set(change);
					return original(queries);
				});
			let result: ListingAdoptionParentSeedResult;
			try {
				result = await store.advance('named');
			} finally {
				concurrent.mockRestore();
			}
			expect({
				result,
				captures: await captures(database),
				progress: await progress(database)
			}).toStrictEqual({
				result: { kind: 'stale' },
				captures: Array.from({ length: 32 }, (_, index) =>
					parent(index + 1, 'named')
				),
				progress: [
					{
						kind: 'named',
						scanned: 32,
						captured: 32,
						isComplete: false,
						pageCaptureAfter: undefined
					}
				]
			});
		}
	);

	it.each(['active', 'suspended', 'offboarding'] as const)(
		'captures only eligible tenant state %s',
		async (status) => {
			const { database, store } = await fixture(1, ['default']);
			await database
				.update(schema.tenant)
				.set({ status })
				.where(eq(schema.tenant.id, tenant));
			const count = status === 'offboarding' ? 0 : 1;
			expect({
				result: await store.advance('default'),
				captures: await captures(database),
				progress: await progress(database)
			}).toStrictEqual({
				result: {
					kind: 'advanced',
					scanned: 1,
					captured: count,
					isComplete: true
				},
				captures: count === 0 ? [] : [parent(1, 'default')],
				progress: [
					{
						kind: 'default',
						scanned: 1,
						captured: count,
						isComplete: true,
						pageCaptureAfter: undefined
					}
				]
			});
		}
	);

	it.each(kinds)(
		'captures bounded %s pages with atomic progress and no cache authority',
		async (kind) => {
			const { database, store } = await fixture(65, [kind]);
			const pages = [
				await store.advance(kind),
				await store.advance(kind),
				await store.advance(kind),
				await store.advance(kind)
			];
			expect({
				pages,
				captures: await captures(database),
				progress: await progress(database),
				parents: await database.select().from(schema.listingAdoptionParent),
				references: await database.select().from(schema.artifactReference),
				cas: await database.select().from(schema.casObject)
			}).toStrictEqual({
				pages: [
					{ kind: 'advanced', scanned: 32, captured: 32, isComplete: false },
					{ kind: 'advanced', scanned: 32, captured: 32, isComplete: false },
					{ kind: 'advanced', scanned: 1, captured: 1, isComplete: true },
					{ kind: 'complete' }
				],
				captures: Array.from({ length: 65 }, (_, index) => ({
					kind: 'parent',
					tenant,
					cache: scope(kind),
					cacheGeneration: 1,
					storePathHash: storePathHashSchema.parse(
						String(index + 1).padStart(32, '0')
					),
					generation: narInfoGenerationSchema.parse(3),
					narHash: sharedNarSource(index + 1).narHash
				})),
				progress: [
					{
						kind,
						scanned: 65,
						captured: 65,
						isComplete: true,
						pageCaptureAfter: undefined
					}
				],
				parents: [],
				references: [],
				cas: []
			});
		}
	);

	it.each(kinds)(
		'completes an empty %s window without captures',
		async (kind) => {
			const { database, store } = await fixture(0, [kind]);
			expect({
				result: await store.advance(kind),
				again: await store.advance(kind),
				captures: await captures(database),
				progress: await progress(database)
			}).toStrictEqual({
				result: { kind: 'complete' },
				again: { kind: 'complete' },
				captures: [],
				progress: [
					{
						kind,
						scanned: 0,
						captured: 0,
						isComplete: true,
						pageCaptureAfter: undefined
					}
				]
			});
		}
	);

	it('keeps independent progress for default and named windows', async () => {
		const { database, store } = await fixture();
		expect({
			first: await store.advance('default'),
			second: await store.advance('named'),
			progress: await progress(database)
		}).toStrictEqual({
			first: { kind: 'advanced', scanned: 32, captured: 32, isComplete: false },
			second: {
				kind: 'advanced',
				scanned: 32,
				captured: 32,
				isComplete: false
			},
			progress: kinds.map((kind) => ({
				kind,
				scanned: 32,
				captured: 32,
				isComplete: false,
				pageCaptureAfter: undefined
			}))
		});
	});

	it('waits for the parent cleanup contract before creating a checkpoint', async () => {
		const { database, store } = await fixture();
		await database
			.update(schema.deploymentTransition)
			.set({ state: 'expanded' })
			.where(eq(schema.deploymentTransition.id, 'listing-adoption-parents'));
		expect({
			result: await store.advance('default'),
			captures: await captures(database),
			progress: await progress(database)
		}).toStrictEqual({
			result: { kind: 'unavailable' },
			captures: [],
			progress: []
		});
	});
});
