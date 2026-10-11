import {
	cacheGenerationSchema,
	firstCacheGeneration,
	narInfoGenerationSchema,
	nixSha256HashSchema,
	storePathHashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { chunk } from '@cupboard/shared/collections';
import { env } from 'cloudflare:workers';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { cacheIdentityColumns } from '../db/cache.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { SharedFactsUnavailableError } from '../errors.ts';
import { defaultCache, flakyD1, namedCache } from '../test-support.ts';

import {
	intersectCachePaths,
	readableCachePathRange
} from './path-intersection.ts';

const tenant = tenantIdSchema.parse('acme');
const narHash = nixSha256HashSchema.parse(`sha256:${'1'.repeat(52)}`);
const hashes = Array.from({ length: 256 }, (_, index) =>
	storePathHashSchema.parse(String(index).padStart(32, '0'))
);
const hash = storePathHashSchema.parse('0'.repeat(32));
const cacheGeneration = cacheGenerationSchema.parse(3);
const planRow = z.object({ detail: z.string() });

async function seed(
	cache: ReturnType<typeof defaultCache>,
	count: number,
	incarnation = cacheGeneration
) {
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
	await database
		.insert(d1Schema.cacheLifecycle)
		.values({
			tenant,
			...cacheIdentityColumns(cache),
			generation: cacheGeneration,
			access: 'public',
			updatedAt: isoTimestamp(new Date())
		})
		.onConflictDoNothing();
	if (count === 0) {
		return;
	}
	const rows = Array.from({ length: count }, (_, index) => ({
		tenant,
		...cacheIdentityColumns(cache),
		storePathHash: hash,
		generation: narInfoGenerationSchema.parse(
			index + 1 + (incarnation === cacheGeneration ? 0 : incarnation * 100_000)
		),
		narHash,
		cacheGeneration: incarnation
	}));
	for (const group of chunk(rows, 10)) {
		await database
			.insert(d1Schema.blobReference)
			.values(group)
			.onConflictDoNothing();
	}
}

describe('bounded cache-first intersection', () => {
	it.each([defaultCache(), namedCache('falcon')])(
		'seeks one covering cache-incarnation range for %j',
		async (cache) => {
			const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
			const query = readableCachePathRange(
				database,
				tenant,
				{ scope: cache, generation: cacheGeneration },
				257
			).toSQL();
			const result = await env.CUPBOARD_DB.prepare(
				`EXPLAIN QUERY PLAN ${query.sql}`
			)
				.bind(...query.params)
				.all();
			const plans = z.array(planRow).parse(result.results);
			expect(plans.map(({ detail }) => detail)).toStrictEqual([
				'SEARCH blob_ref_storage USING COVERING INDEX blob_ref_readable_cache_generation_idx (tenant=? AND cache_kind=? AND cache_name=? AND cache_generation=?)'
			]);
		}
	);

	it.each([
		{ count: 0, strategy: 'cache', matches: [] },
		{ count: 256, strategy: 'cache', matches: [hash] },
		{ count: 257, strategy: 'candidate-fallback', matches: [hash] }
	])(
		'bounds physical generations before deduplication: $count',
		async ({ count, strategy, matches }) => {
			const cache = namedCache('falcon');
			await seed(cache, count);
			await seed(namedCache('other'), 300);
			await seed(cache, 500, firstCacheGeneration);
			await seed(cache, 500, cacheGenerationSchema.parse(2));
			const result = await intersectCachePaths(
				drizzleD1(env.CUPBOARD_DB, { schema: d1Schema }),
				tenant,
				{ scope: cache, generation: cacheGeneration },
				hashes
			);
			expect(result).toStrictEqual({
				matchingHashes: matches,
				strategy,
				scannedRows: Math.min(count, 257),
				candidateHashes: count === 0 ? 0 : strategy === 'cache' ? 1 : 256
			});
		}
	);

	it('checks candidates outside a truncated raw range', async () => {
		const cache = namedCache('falcon');
		await seed(cache, 257);
		const later = storePathHashSchema.parse('1'.repeat(32));
		const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
		await database.insert(d1Schema.blobReference).values({
			tenant,
			...cacheIdentityColumns(cache),
			storePathHash: later,
			generation: narInfoGenerationSchema.parse(1),
			narHash,
			cacheGeneration
		});
		expect(
			await intersectCachePaths(
				database,
				tenant,
				{ scope: cache, generation: cacheGeneration },
				[...hashes, later]
			)
		).toStrictEqual({
			matchingHashes: [hash, later],
			strategy: 'candidate-fallback',
			scannedRows: 258,
			candidateHashes: 257
		});
	});

	it('checks revocation fences and recommits before returning a possible match', async () => {
		const cache = namedCache('falcon');
		await seed(cache, 1);
		const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
		await database.insert(d1Schema.pathReadRevocation).values({
			tenant,
			...cacheIdentityColumns(cache),
			storePathHash: hash,
			cacheGeneration,
			generation: narInfoGenerationSchema.parse(1)
		});
		expect(
			await intersectCachePaths(
				database,
				tenant,
				{ scope: cache, generation: cacheGeneration },
				hashes
			)
		).toStrictEqual({
			matchingHashes: [],
			strategy: 'cache',
			scannedRows: 1,
			candidateHashes: 1
		});
		await seed(cache, 2);
		expect(
			await intersectCachePaths(
				database,
				tenant,
				{ scope: cache, generation: cacheGeneration },
				hashes
			)
		).toStrictEqual({
			matchingHashes: [hash],
			strategy: 'cache',
			scannedRows: 2,
			candidateHashes: 1
		});
	});

	it('refuses persistent query failures', async () => {
		const database = drizzleD1(
			flakyD1(env.CUPBOARD_DB, { failures: Infinity }),
			{ schema: d1Schema }
		);
		await expect(
			intersectCachePaths(
				database,
				tenant,
				{ scope: defaultCache(), generation: firstCacheGeneration },
				hashes
			)
		).rejects.toBeInstanceOf(SharedFactsUnavailableError);
	});
});
