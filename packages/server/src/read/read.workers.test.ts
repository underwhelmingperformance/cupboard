import {
	type CacheGeneration,
	cacheGenerationSchema,
	cacheNameSchema,
	DEFAULT_CACHE,
	narInfoGenerationSchema,
	nixSha256HashSchema,
	privateStoredCache,
	type StoredCache,
	storePathHashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { firstCacheGeneration } from '../db/cache-generation.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { SharedFactsUnavailableError } from '../errors.ts';
import { narCacheTag } from '../http/cache-tags.ts';
import {
	narInfoObjectKey,
	narObjectKey,
	type ParsedNarName
} from '../http/http.ts';
import { flakyD1 } from '../test-support.ts';

import {
	missingStorePathHashes,
	type NarAuthority,
	narInfoReferenceQuery,
	narReferenceQuery,
	privateNamespaceNarAuthority,
	publicNarAuthority,
	serveNar,
	serveNarInfo
} from './read.ts';

const tenant = tenantIdSchema.parse('acme');
const narHash = nixSha256HashSchema.parse(`sha256:${'1'.repeat(52)}`);
const narBytes = 'nar-bytes';
const referencingPath = storePathHashSchema.parse(
	'0123456789abcdfghijklmnpqrsvwxyz'
);
const privateCache = privateStoredCache(cacheNameSchema.parse('builds'));

// The narinfo generation every seeded reference edge records.
const referencedGeneration = narInfoGenerationSchema.parse(1);

function cacheAuthority(cache: StoredCache): NarAuthority {
	return { kind: 'cache', cache };
}

function parsedNar(hash = narHash): ParsedNarName {
	return { narHash: hash, incarnation: 1 };
}

async function seedOwnedNar(cache: StoredCache = DEFAULT_CACHE): Promise<void> {
	await seedOwnedNarReference(cache);
	await env.BLOBS.put(narObjectKey(narHash), narBytes);
}

async function seedOwnedNarReference(
	cache: StoredCache = DEFAULT_CACHE,
	edgeGeneration?: CacheGeneration
): Promise<void> {
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
	const insertBlob = database
		.insert(d1Schema.blobState)
		.values({
			narHash,
			fileHash: narHash,
			fileSize: narBytes.length,
			compression: 'zstd',
			narSize: narBytes.length,
			verifiedAt: isoTimestamp(new Date())
		})
		.onConflictDoNothing();
	const insertReference = database
		.insert(d1Schema.blobReference)
		.values({
			tenant,
			cache,
			storePathHash: referencingPath,
			generation: referencedGeneration,
			narHash,
			...(edgeGeneration !== undefined && { cacheGeneration: edgeGeneration })
		})
		.onConflictDoNothing();

	await database.batch([insertBlob, insertReference]);
}

function seedCacheGeneration(
	cache: StoredCache,
	generation: CacheGeneration
): Promise<unknown> {
	return drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
		.insert(d1Schema.cacheLifecycle)
		.values({
			tenant,
			cache,
			generation,
			updatedAt: isoTimestamp(new Date())
		});
}

async function serveWithFaults(failures: number): Promise<Response> {
	const faultyEnv = {
		...env,
		CUPBOARD_DB: flakyD1(env.CUPBOARD_DB, { failures })
	};
	const response = await serveNar(
		new Request('https://cache.example/nar/probe'),
		faultyEnv,
		tenant,
		parsedNar(),
		publicNarAuthority,
		true
	);
	return response;
}

describe('NAR serve under shared-fact read faults', () => {
	it('marks every private miss as uncacheable', async () => {
		const absentNarHash = nixSha256HashSchema.parse(`sha256:${'2'.repeat(52)}`);
		await seedOwnedNarReference();

		const [unreferencedMiss, objectMiss, narInfoMiss] = await Promise.all([
			serveNar(
				new Request('https://cache.example/nar/unreferenced'),
				env,
				tenant,
				parsedNar(absentNarHash),
				publicNarAuthority,
				true
			),
			serveNar(
				new Request('https://cache.example/nar/absent'),
				env,
				tenant,
				parsedNar(),
				publicNarAuthority,
				true
			),
			serveNarInfo(
				new Request('https://cache.example/0.narinfo'),
				env,
				tenant,
				DEFAULT_CACHE,
				referencingPath,
				true
			)
		]);

		expect(
			[unreferencedMiss, objectMiss, narInfoMiss].map((response) => ({
				status: response.status,
				cacheControl: response.headers.get('cache-control')
			}))
		).toStrictEqual([
			{ status: StatusCodes.NOT_FOUND, cacheControl: 'no-store' },
			{ status: StatusCodes.NOT_FOUND, cacheControl: 'no-store' },
			{ status: StatusCodes.NOT_FOUND, cacheControl: 'no-store' }
		]);
	});

	it('returns the GET representation when Hono dispatches HEAD', async () => {
		await seedOwnedNar();

		const response = await serveNar(
			new Request('https://cache.example/nar/probe', { method: 'HEAD' }),
			env,
			tenant,
			parsedNar(),
			publicNarAuthority,
			false
		);

		expect({
			status: response.status,
			body: await response.text()
		}).toStrictEqual({ status: StatusCodes.OK, body: narBytes });
	});

	it('returns metadata only for an uncached private HEAD', async () => {
		await seedOwnedNar();

		const response = await serveNar(
			new Request('https://cache.example/nar/probe', { method: 'HEAD' }),
			env,
			tenant,
			parsedNar(),
			publicNarAuthority,
			true
		);

		expect({
			status: response.status,
			contentLength: response.headers.get('content-length'),
			body: await response.text()
		}).toStrictEqual({
			status: StatusCodes.OK,
			contentLength: String(narBytes.length),
			body: ''
		});
	});

	it('retries a transient fault on the reference read', async () => {
		await seedOwnedNar();

		const response = await serveWithFaults(1);

		expect({
			status: response.status,
			body: await response.text()
		}).toStrictEqual({ status: StatusCodes.OK, body: narBytes });
	});

	it('throws a retryable shared-facts error when both reference reads fail', async () => {
		await seedOwnedNar();

		let caught: unknown;

		try {
			await serveWithFaults(Number.MAX_SAFE_INTEGER);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(SharedFactsUnavailableError);

		if (!(caught instanceof SharedFactsUnavailableError)) {
			return;
		}

		expect({
			status: caught.status,
			retryAfterSeconds: caught.retryAfterSeconds
		}).toStrictEqual({
			status: StatusCodes.SERVICE_UNAVAILABLE,
			retryAfterSeconds: 5
		});
	});
});

describe('NAR reference authorisation', () => {
	const otherPrivateCache = privateStoredCache(cacheNameSchema.parse('guides'));

	const cases: readonly {
		readonly name: string;
		readonly cache: StoredCache;
		readonly authority: NarAuthority;
		readonly isServed: boolean;
	}[] = [
		{
			name: 'a public reference authorises a public read',
			cache: DEFAULT_CACHE,
			authority: publicNarAuthority,
			isServed: true
		},
		{
			name: 'a public reference does not authorise a private cache read',
			cache: DEFAULT_CACHE,
			authority: cacheAuthority(privateCache),
			isServed: false
		},
		{
			name: 'a public reference does not authorise a private view read',
			cache: DEFAULT_CACHE,
			authority: privateNamespaceNarAuthority,
			isServed: false
		},
		{
			name: 'a private reference does not authorise a public read',
			cache: privateCache,
			authority: publicNarAuthority,
			isServed: false
		},
		{
			name: 'a private reference authorises a read of its own cache',
			cache: privateCache,
			authority: cacheAuthority(privateCache),
			isServed: true
		},
		{
			name: 'a private reference does not authorise a read of another private cache',
			cache: privateCache,
			authority: cacheAuthority(otherPrivateCache),
			isServed: false
		},
		{
			name: 'a private reference authorises a private view read',
			cache: privateCache,
			authority: privateNamespaceNarAuthority,
			isServed: true
		}
	];

	it.each(cases)('$name', async ({ cache, authority, isServed }) => {
		await seedOwnedNar(cache);

		const response = await serveNar(
			new Request('https://cache.example/nar/probe'),
			env,
			tenant,
			parsedNar(),
			authority,
			false
		);

		expect({
			status: response.status,
			cacheTag: response.headers.get('cache-tag') ?? undefined,
			body: await response.text()
		}).toStrictEqual(
			isServed
				? {
						status: StatusCodes.OK,
						cacheTag: narCacheTag(tenant, narHash),
						body: narBytes
					}
				: {
						status: StatusCodes.NOT_FOUND,
						cacheTag: undefined,
						body: 'Not found\n'
					}
		);
	});
});

// A cache belongs to generation 1 while it has no lifecycle row, and an edge
// belongs to generation 1 while it carries no cache generation. Deleting a
// cache advances the cache to the next generation, so all of its edges,
// including those written before the column existed, stop matching.
describe('NAR reference cache generations', () => {
	const secondGeneration = cacheGenerationSchema.parse(2);
	const cases: {
		readonly name: string;
		readonly edgeGeneration?: CacheGeneration;
		readonly cacheGeneration?: CacheGeneration;
		readonly isServed: boolean;
	}[] = [
		{
			name: 'an unstamped edge of a cache no deletion has reached',
			isServed: true
		},
		{
			name: 'a first-generation edge of a cache no deletion has reached',
			edgeGeneration: firstCacheGeneration,
			isServed: true
		},
		{
			name: 'an unstamped edge of a deleted cache',
			cacheGeneration: secondGeneration,
			isServed: false
		},
		{
			name: 'a first-generation edge of a deleted cache',
			edgeGeneration: firstCacheGeneration,
			cacheGeneration: secondGeneration,
			isServed: false
		},
		{
			name: 'an edge of the generation the cache is on',
			edgeGeneration: secondGeneration,
			cacheGeneration: secondGeneration,
			isServed: true
		},
		{
			name: 'an edge of a cache created and deleted again',
			edgeGeneration: secondGeneration,
			cacheGeneration: cacheGenerationSchema.parse(3),
			isServed: false
		}
	];

	it.each(cases)(
		'$name',
		async ({ edgeGeneration, cacheGeneration, isServed }) => {
			await seedOwnedNarReference(DEFAULT_CACHE, edgeGeneration);
			await env.BLOBS.put(narObjectKey(narHash), narBytes);

			if (cacheGeneration !== undefined) {
				await seedCacheGeneration(DEFAULT_CACHE, cacheGeneration);
			}

			const response = await serveNar(
				new Request('https://cache.example/nar/probe'),
				env,
				tenant,
				parsedNar(),
				publicNarAuthority,
				false
			);

			expect({ status: response.status }).toStrictEqual({
				status: isServed ? StatusCodes.OK : StatusCodes.NOT_FOUND
			});
		}
	);
});

describe('NAR reference index', () => {
	const planRowSchema = z.object({ detail: z.string() });

	it.each([
		{ name: 'one private cache', authority: cacheAuthority(privateCache) },
		{ name: 'the public namespace', authority: publicNarAuthority },
		{ name: 'the private namespace', authority: privateNamespaceNarAuthority }
	])('seeks the composite index for $name', async ({ authority }) => {
		const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
		const query = narReferenceQuery(
			database,
			tenant,
			narHash,
			authority
		).toSQL();
		const explained = await env.CUPBOARD_DB.prepare(
			`EXPLAIN QUERY PLAN ${query.sql}`
		)
			.bind(...query.params)
			.all();
		const rows = z.array(planRowSchema).parse(explained.results);
		const isIndexSeek = (table: string): boolean =>
			rows.some(
				(row) =>
					row.detail.startsWith(`SEARCH ${table} `) &&
					row.detail.includes('INDEX')
			);

		// Every table the authorisation check reads is an index seek, so the whole
		// check remains one statement that never scans.
		expect({
			edge: rows.some((row) =>
				row.detail.includes('blob_ref_tenant_nar_hash_cache_idx')
			),
			blobState: isIndexSeek('blob_state'),
			lifecycle: isIndexSeek('cache_lifecycle'),
			scans: rows.filter((row) => row.detail.startsWith('SCAN ')).length
		}).toStrictEqual({
			edge: true,
			blobState: true,
			lifecycle: true,
			scans: 0
		});
	});

	it('seeks the reference primary key for a private narinfo read', async () => {
		const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
		const query = narInfoReferenceQuery(database, tenant, privateCache, [
			referencingPath
		]).toSQL();
		const explained = await env.CUPBOARD_DB.prepare(
			`EXPLAIN QUERY PLAN ${query.sql}`
		)
			.bind(...query.params)
			.all();
		const rows = z.array(planRowSchema).parse(explained.results);
		const isIndexSeek = (table: string): boolean =>
			rows.some(
				(row) =>
					row.detail.startsWith(`SEARCH ${table} `) &&
					row.detail.includes('INDEX')
			);

		// The reference edge's primary key already leads with the tenant, cache and
		// store path, so the narinfo check needs no index of its own.
		expect({
			edge: isIndexSeek('blob_ref'),
			lifecycle: isIndexSeek('cache_lifecycle'),
			scans: rows.filter((row) => row.detail.startsWith('SCAN ')).length
		}).toStrictEqual({ edge: true, lifecycle: true, scans: 0 });
	});
});

// Metadata for the commit described by the seeded narinfo object.
const currentObjectMetadata: Record<string, string> = {
	generation: String(referencedGeneration),
	narHash,
	narUrl: narObjectKey(narHash),
	signatureGeneration: '0'
};

async function seedPrivateNarInfoObject(
	objectMetadata: Record<string, string> | undefined,
	edgeGeneration?: CacheGeneration
): Promise<void> {
	await seedOwnedNarReference(privateCache, edgeGeneration);
	await env.BLOBS.put(
		narInfoObjectKey(tenant, referencingPath, privateCache),
		'narinfo-bytes',
		objectMetadata === undefined
			? undefined
			: { customMetadata: objectMetadata }
	);
}

function seedPrivateNarInfo(edgeGeneration?: CacheGeneration): Promise<void> {
	return seedPrivateNarInfoObject(currentObjectMetadata, edgeGeneration);
}

describe('private narinfo reference gate', () => {
	const secondGeneration = cacheGenerationSchema.parse(2);

	it.each([
		{
			scenario: 'the cache has never been deleted',
			action: 'serves',
			isServed: true
		},
		{
			scenario: 'the current cache generation authorises the edge',
			action: 'serves',
			edgeGeneration: secondGeneration,
			cacheGeneration: secondGeneration,
			isServed: true
		},
		{
			scenario: 'cache deletion has revoked the only edge',
			action: 'refuses',
			edgeGeneration: firstCacheGeneration,
			cacheGeneration: secondGeneration,
			isServed: false
		}
	])(
		'$action the published object when $scenario',
		async ({ edgeGeneration, cacheGeneration, isServed }) => {
			await seedPrivateNarInfo(edgeGeneration);

			if (cacheGeneration !== undefined) {
				await seedCacheGeneration(privateCache, cacheGeneration);
			}

			const response = await serveNarInfo(
				new Request('https://cache.example/probe.narinfo'),
				env,
				tenant,
				privateCache,
				referencingPath,
				true
			);
			const missing = await missingStorePathHashes(env, tenant, privateCache, [
				referencingPath
			]);

			expect({ status: response.status, missing }).toStrictEqual({
				status: isServed ? StatusCodes.OK : StatusCodes.NOT_FOUND,
				missing: isServed ? [] : [referencingPath]
			});
		}
	);

	it.each([
		{
			scenario: 'the object has no version metadata',
			objectMetadata: undefined
		},
		{
			scenario: 'the object belongs to an earlier commit of the path',
			objectMetadata: {
				...currentObjectMetadata,
				generation: String(referencedGeneration - 1)
			}
		},
		{
			scenario: 'the object records a different NAR hash',
			objectMetadata: {
				...currentObjectMetadata,
				narHash: nixSha256HashSchema.parse(`sha256:${'3'.repeat(52)}`)
			}
		}
	])(
		'refuses the published object when $scenario',
		async ({ objectMetadata }) => {
			await seedPrivateNarInfoObject(objectMetadata);

			const response = await serveNarInfo(
				new Request('https://cache.example/probe.narinfo'),
				env,
				tenant,
				privateCache,
				referencingPath,
				true
			);
			const missing = await missingStorePathHashes(env, tenant, privateCache, [
				referencingPath
			]);

			expect({
				status: response.status,
				cacheControl: response.headers.get('cache-control'),
				missing
			}).toStrictEqual({
				status: StatusCodes.NOT_FOUND,
				cacheControl: 'no-store',
				missing: [referencingPath]
			});
		}
	);

	it('refuses a published object when no reference edge names it', async () => {
		await env.BLOBS.put(
			narInfoObjectKey(tenant, referencingPath, privateCache),
			'narinfo-bytes'
		);

		const response = await serveNarInfo(
			new Request('https://cache.example/probe.narinfo'),
			env,
			tenant,
			privateCache,
			referencingPath,
			true
		);

		expect({
			status: response.status,
			cacheControl: response.headers.get('cache-control')
		}).toStrictEqual({
			status: StatusCodes.NOT_FOUND,
			cacheControl: 'no-store'
		});
	});
});
