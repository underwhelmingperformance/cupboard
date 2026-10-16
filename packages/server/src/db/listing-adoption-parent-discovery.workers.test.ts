import {
	cacheGenerationSchema,
	cacheNameSchema,
	type CacheScope,
	narInfoGenerationSchema,
	storePathHashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { env } from 'cloudflare:workers';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
	type ListingAdoptionParentIdentity,
	listingAdoptionParentWindowSchema
} from '../blob/listing-adoption-parent-discovery.ts';
import { SharedFactsUnavailableError } from '../errors.ts';

import { cacheIdentityColumns } from './cache.ts';
import * as schema from './d1-schema.ts';
import { ListingAdoptionParentDiscovery } from './listing-adoption-parent-discovery.ts';
import {
	sharedNarDiscoveryFixture,
	sharedNarSource
} from './shared-nar-discovery.test-support.ts';

const tenant = tenantIdSchema.parse('discovery-first');
const cacheName = cacheNameSchema.parse('private');
const kinds: readonly CacheScope['kind'][] = ['default', 'named'];

function parent(
	index: number,
	kind: CacheScope['kind']
): ListingAdoptionParentIdentity {
	return {
		tenant,
		cache: kind === 'default' ? { kind } : { kind, name: cacheName },
		storePathHash: storePathHashSchema.parse(String(index).padStart(32, '0'))
	};
}

function window(kind: CacheScope['kind'], through = 65, after?: number) {
	const key = (index: number) => ({
		tenant,
		storePathHash: parent(index, kind).storePathHash,
		...(kind === 'named' && { cacheName })
	});
	return listingAdoptionParentWindowSchema.parse({
		kind,
		through: key(through),
		...(after !== undefined && { after: key(after) })
	});
}

async function fixture(kind: CacheScope['kind'], count = 65) {
	const { database } = await sharedNarDiscoveryFixture(0);
	if (count > 0) {
		await env.CUPBOARD_DB.prepare(
			`WITH RECURSIVE numbered(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM numbered WHERE value < ?), generations(value) AS (VALUES(1),(2))
INSERT INTO blob_ref_storage (tenant,cache_kind,cache_name,cache_generation,store_path_hash,generation,nar_hash,readable)
SELECT ?,?,CASE WHEN ? = 'named' THEN 'private' ELSE NULL END,1,printf('%032d',numbered.value),generations.value,?,numbered.value % 2 FROM numbered CROSS JOIN generations`
		)
			.bind(count, tenant, kind, kind, sharedNarSource(0).narHash)
			.run();
	}
	return { database, discovery: new ListingAdoptionParentDiscovery(database) };
}

describe('historical listing parent discovery', () => {
	it.each(kinds)('rejects a %s cursor beyond its frozen boundary', (kind) => {
		const parsed = listingAdoptionParentWindowSchema.safeParse({
			kind,
			through: window(kind, 65).through,
			after: window(kind, 66).through
		});
		expect(parsed.success).toBe(false);
	});

	it.each(['open', 'page'] as const)(
		'reports a database failure during %s as unavailable',
		async (operation) => {
			const { discovery } = await fixture('default', 1);
			const failure = vi
				.spyOn(env.CUPBOARD_DB, 'prepare')
				.mockImplementationOnce(() => {
					throw new Error('The parent catalogue is unavailable');
				});
			try {
				const result =
					operation === 'open'
						? discovery.open('default')
						: discovery.page(window('default', 1));
				await expect(result).rejects.toBeInstanceOf(
					SharedFactsUnavailableError
				);
			} finally {
				failure.mockRestore();
			}
		}
	);

	it.each(kinds)(
		'orders %s identities across tenants and cache names',
		async (kind) => {
			const { database, discovery } = await fixture(kind, 0);
			const secondTenant = tenantIdSchema.parse('discovery-second');
			const second =
				kind === 'default'
					? parent(2, kind)
					: {
							...parent(0, kind),
							cache: {
								kind: 'named' as const,
								name: cacheNameSchema.parse('zz-private')
							}
						};
			const expected = [
				parent(1, kind),
				second,
				{ ...parent(0, kind), tenant: secondTenant }
			];
			await database.insert(schema.blobReference).values(
				expected.toReversed().map((identity) => ({
					tenant: identity.tenant,
					...cacheIdentityColumns(identity.cache),
					cacheGeneration: cacheGenerationSchema.parse(1),
					storePathHash: identity.storePathHash,
					generation: narInfoGenerationSchema.parse(1),
					narHash: sharedNarSource(0).narHash
				}))
			);
			const opened = await discovery.open(kind);
			if (opened === undefined) {
				throw new Error('The cross-tenant parent catalogue has no window');
			}
			const through = { ...window(kind, 0).through, tenant: secondTenant };
			expect({ opened, page: await discovery.page(opened) }).toStrictEqual({
				opened: { kind, through },
				page: {
					parents: expected,
					window: { kind, through, after: through },
					isComplete: true
				}
			});
		}
	);

	it.each(kinds)(
		'leaves an empty %s catalogue without a window',
		async (kind) => {
			const { discovery } = await fixture(kind, 0);
			expect(await discovery.open(kind)).toBeUndefined();
		}
	);

	it.each(kinds)(
		'pages unique %s paths before filtering current authority',
		async (kind) => {
			const { discovery } = await fixture(kind);
			const opened = await discovery.open(kind);
			if (opened === undefined) {
				throw new Error('The non-empty parent catalogue has no window');
			}
			const first = await discovery.page(opened);
			const second = await discovery.page(first.window);
			const third = await discovery.page(second.window);
			expect({
				opened,
				first,
				second,
				third,
				again: await discovery.page(third.window)
			}).toStrictEqual({
				opened: window(kind),
				first: {
					parents: Array.from({ length: 32 }, (_, index) =>
						parent(index + 1, kind)
					),
					window: window(kind, 65, 32),
					isComplete: false
				},
				second: {
					parents: Array.from({ length: 32 }, (_, index) =>
						parent(index + 33, kind)
					),
					window: window(kind, 65, 64),
					isComplete: false
				},
				third: {
					parents: [parent(65, kind)],
					window: window(kind, 65, 65),
					isComplete: true
				},
				again: { parents: [], window: window(kind, 65, 65), isComplete: true }
			});
		}
	);

	it.each(kinds)(
		'preserves a frozen %s window across deleted cursors and later inserts',
		async (kind) => {
			const { database, discovery } = await fixture(kind);
			const first = await discovery.page(window(kind));
			await database
				.delete(schema.blobReference)
				.where(
					inArray(schema.blobReference.storePathHash, [
						parent(32, kind).storePathHash,
						parent(65, kind).storePathHash
					])
				);
			await database.insert(schema.blobReference).values(
				[0, 99].map((index) => ({
					tenant,
					cacheKind: kind,
					...(kind === 'named' && { cacheName }),
					cacheGeneration: cacheGenerationSchema.parse(1),
					storePathHash: parent(index, kind).storePathHash,
					generation: narInfoGenerationSchema.parse(3),
					narHash: sharedNarSource(0).narHash
				}))
			);
			expect(await discovery.page(first.window)).toStrictEqual({
				parents: Array.from({ length: 32 }, (_, index) =>
					parent(index + 33, kind)
				),
				window: window(kind, 65, 65),
				isComplete: true
			});
		}
	);

	it.each(
		kinds.flatMap((kind) => [
			{ kind, after: undefined },
			{ kind, after: 1 }
		])
	)(
		'seeks beyond 25,000 retained generations in the $kind identity index after $after',
		async ({ kind, after }) => {
			const { database } = await fixture(kind, 65);
			await database
				.delete(schema.blobReference)
				.where(
					eq(schema.blobReference.storePathHash, parent(1, kind).storePathHash)
				);
			await env.CUPBOARD_DB.prepare(
				`WITH RECURSIVE numbered(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM numbered WHERE value < 25000)
INSERT INTO blob_ref_storage (tenant,cache_kind,cache_name,cache_generation,store_path_hash,generation,nar_hash)
SELECT ?,?,CASE WHEN ? = 'named' THEN 'private' ELSE NULL END,1,?,value,? FROM numbered`
			)
				.bind(
					tenant,
					kind,
					kind,
					parent(1, kind).storePathHash,
					sharedNarSource(0).narHash
				)
				.run();
			const statements: { query: string; parameters: unknown[] }[] = [];
			const measuredDatabase = drizzle(env.CUPBOARD_DB, {
				schema,
				logger: {
					logQuery(query, parameters) {
						statements.push({ query, parameters });
					}
				}
			});
			const discovery = new ListingAdoptionParentDiscovery(measuredDatabase);
			const result = await discovery.page(window(kind, 65, after));
			const page = statements.find(({ query }) =>
				query.includes('WITH RECURSIVE')
			);
			if (page === undefined) {
				throw new Error('The bounded parent discovery query was not recorded');
			}
			const parameters = z
				.array(z.union([z.string(), z.number()]))
				.parse(page.parameters);
			const measured = await env.CUPBOARD_DB.prepare(page.query)
				.bind(...parameters)
				.all();
			const plan = await env.CUPBOARD_DB.prepare(
				`EXPLAIN QUERY PLAN ${page.query}`
			)
				.bind(...parameters)
				.all<{ detail: string }>();
			const searches = plan.results.filter(({ detail }) =>
				detail.includes(
					`SEARCH blob_ref_storage USING COVERING INDEX blob_ref_${kind}_identity_idx`
				)
			);
			expect({
				result,
				boundedReads: measured.meta.rows_read <= 200,
				indexedSeeks: searches.length >= 2,
				fullSourceScan: plan.results.some(({ detail }) =>
					detail.includes('SCAN blob_ref_storage')
				)
			}).toStrictEqual({
				result: {
					parents: Array.from({ length: 32 }, (_, index) =>
						parent(index + 1 + (after ?? 0), kind)
					),
					window: window(kind, 65, 32 + (after ?? 0)),
					isComplete: false
				},
				boundedReads: true,
				indexedSeeks: true,
				fullSourceScan: false
			});
		}
	);
});
