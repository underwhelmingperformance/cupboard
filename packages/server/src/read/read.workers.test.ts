import {
	type CacheAccessMode,
	type CacheGeneration,
	cacheGenerationSchema,
	type CacheScope,
	narInfoGenerationSchema,
	nixSha256HashSchema,
	storePathHashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { type ReuseViewSelector } from '@cupboard/protocol/reuse-views';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { cacheIdentityColumns, cacheIdentityCondition } from '../db/cache.ts';
import { firstCacheGeneration } from '../db/cache-generation.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { SharedFactsUnavailableError } from '../errors.ts';
import { narCacheTag } from '../http/cache-tags.ts';
import {
	narInfoObjectKey,
	narObjectKey,
	type NarObjectName
} from '../http/http.ts';
import { defaultCache, flakyD1, namedCache } from '../test-support.ts';

import {
	missingStorePathHashes,
	type NarAuthority,
	narInfoReferenceQuery,
	narReferenceQuery,
	serveNar,
	serveNarInfo
} from './read.ts';

const tenant = tenantIdSchema.parse('acme');
const narHash = nixSha256HashSchema.parse(`sha256:${'1'.repeat(52)}`);
const narBytes = 'nar-bytes';
const referencingPath = storePathHashSchema.parse(
	'0123456789abcdfghijklmnpqrsvwxyz'
);
const privateCache = namedCache('builds');

// The narinfo generation every seeded reference edge records.
const referencedGeneration = narInfoGenerationSchema.parse(1);

function cacheAuthority(
	scope: CacheScope,
	access: CacheAccessMode = 'public'
): NarAuthority {
	return { kind: 'cache', scope, access };
}

function viewAuthority(
	access: CacheAccessMode,
	selectors: readonly ReuseViewSelector[] = [{ kind: 'all' }]
): NarAuthority {
	return { kind: 'view', access, selectors };
}

const defaultPublicAuthority = cacheAuthority(defaultCache());

function parsedNar(hash = narHash): NarObjectName {
	return { narHash: hash, incarnation: 1 };
}

async function seedOwnedNar(
	cache: CacheScope = defaultCache(),
	access: CacheAccessMode = 'public'
): Promise<void> {
	await seedOwnedNarReference(cache, access);
	await env.BLOBS.put(narObjectKey(narHash), narBytes);
}

async function seedOwnedNarReference(
	cache: CacheScope = defaultCache(),
	access: CacheAccessMode = 'public',
	edgeGeneration: CacheGeneration = firstCacheGeneration
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
			...cacheIdentityColumns(cache),
			storePathHash: referencingPath,
			generation: referencedGeneration,
			narHash,
			cacheGeneration: edgeGeneration
		})
		.onConflictDoNothing();
	const insertLifecycle = database
		.insert(d1Schema.cacheLifecycle)
		.values({
			tenant,
			...cacheIdentityColumns(cache),
			access,
			generation: edgeGeneration,
			updatedAt: isoTimestamp(new Date())
		})
		.onConflictDoNothing();

	await database.batch([insertBlob, insertReference, insertLifecycle]);
}

function seedCacheGeneration(
	cache: CacheScope,
	generation: CacheGeneration,
	access: CacheAccessMode = 'public'
): Promise<unknown> {
	return drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
		.insert(d1Schema.cacheLifecycle)
		.values({
			tenant,
			...cacheIdentityColumns(cache),
			access,
			generation,
			updatedAt: isoTimestamp(new Date())
		})
		.onConflictDoUpdate(
			cache.kind === 'default'
				? {
						target: [d1Schema.cacheLifecycle.tenant],
						targetWhere: sql`${d1Schema.cacheLifecycle.cacheKind} = 'default'`,
						set: { access, generation }
					}
				: {
						target: [
							d1Schema.cacheLifecycle.tenant,
							d1Schema.cacheLifecycle.cacheName
						],
						targetWhere: sql`${d1Schema.cacheLifecycle.cacheKind} = 'named'`,
						set: { access, generation }
					}
		);
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
		defaultPublicAuthority,
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
				defaultPublicAuthority,
				true
			),
			serveNar(
				new Request('https://cache.example/nar/absent'),
				env,
				tenant,
				parsedNar(),
				defaultPublicAuthority,
				true
			),
			serveNarInfo(
				new Request('https://cache.example/0.narinfo'),
				env,
				tenant,
				{ scope: defaultCache(), access: 'public' },
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
			defaultPublicAuthority,
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
			defaultPublicAuthority,
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
	const otherPrivateCache = namedCache('guides');

	const cases: readonly {
		readonly name: string;
		readonly cache: CacheScope;
		readonly access: CacheAccessMode;
		readonly authority: NarAuthority;
		readonly isServed: boolean;
	}[] = [
		{
			name: 'a public reference authorises a read of its cache',
			cache: defaultCache(),
			access: 'public',
			authority: defaultPublicAuthority,
			isServed: true
		},
		{
			name: 'a public reference does not authorise another private cache',
			cache: defaultCache(),
			access: 'public',
			authority: cacheAuthority(privateCache, 'private'),
			isServed: false
		},
		{
			name: 'a public reference does not authorise a private view read',
			cache: defaultCache(),
			access: 'public',
			authority: viewAuthority('private'),
			isServed: false
		},
		{
			name: 'a private reference does not authorise a public view read',
			cache: privateCache,
			access: 'private',
			authority: viewAuthority('public'),
			isServed: false
		},
		{
			name: 'a private reference authorises a read of its own cache',
			cache: privateCache,
			access: 'private',
			authority: cacheAuthority(privateCache, 'private'),
			isServed: true
		},
		{
			name: 'a private reference does not authorise a read of another private cache',
			cache: privateCache,
			access: 'private',
			authority: cacheAuthority(otherPrivateCache, 'private'),
			isServed: false
		},
		{
			name: 'a private reference authorises a private view read',
			cache: privateCache,
			access: 'private',
			authority: viewAuthority('private'),
			isServed: true
		}
	];

	it.each(cases)('$name', async ({ cache, access, authority, isServed }) => {
		await seedOwnedNar(cache, access);

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
						cacheTag:
							authority.kind === 'cache'
								? narCacheTag(tenant, authority.scope, narHash)
								: undefined,
						body: narBytes
					}
				: {
						status: StatusCodes.NOT_FOUND,
						cacheTag: undefined,
						body: 'Not found\n'
					}
		);
	});

	it('refuses a reference whose cache has no lifecycle', async () => {
		const orphan = namedCache('orphan');
		await seedOwnedNar(orphan);

		await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
			.delete(d1Schema.cacheLifecycle)
			.where(
				and(
					eq(d1Schema.cacheLifecycle.tenant, tenant),
					cacheIdentityCondition(
						d1Schema.cacheLifecycle.cacheKind,
						d1Schema.cacheLifecycle.cacheName,
						orphan
					)
				)
			)
			.run();

		const response = await serveNar(
			new Request('https://cache.example/nar/probe'),
			env,
			tenant,
			parsedNar(),
			cacheAuthority(orphan),
			false
		);

		expect({
			status: response.status,
			body: await response.text()
		}).toStrictEqual({ status: StatusCodes.NOT_FOUND, body: 'Not found\n' });
	});
});

// Deleting a cache advances its lifecycle to the next generation, so every
// earlier edge stops matching.
describe('NAR reference cache generations', () => {
	const secondGeneration = cacheGenerationSchema.parse(2);
	const cases: {
		readonly name: string;
		readonly edgeGeneration: CacheGeneration;
		readonly cacheGeneration?: CacheGeneration;
		readonly isServed: boolean;
	}[] = [
		{
			name: 'an edge of a first-generation cache',
			edgeGeneration: firstCacheGeneration,
			isServed: true
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
			await seedOwnedNarReference(defaultCache(), 'public', edgeGeneration);
			await env.BLOBS.put(narObjectKey(narHash), narBytes);

			if (cacheGeneration !== undefined) {
				await seedCacheGeneration(defaultCache(), cacheGeneration);
			}

			const response = await serveNar(
				new Request('https://cache.example/nar/probe'),
				env,
				tenant,
				parsedNar(),
				defaultPublicAuthority,
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
		{
			name: 'one private cache',
			authority: cacheAuthority(privateCache, 'private')
		},
		{ name: 'a public view', authority: viewAuthority('public') },
		{ name: 'a private view', authority: viewAuthority('private') }
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
				row.detail.includes('blob_ref_tenant_nar_hash_native_idx')
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

	it('seeks the native partial indexes for a private narinfo read', async () => {
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

		// The named-cache indexes lead with the tenant, cache name and store path,
		// so the query can seek both native identities without a table scan.
		expect({
			edge: rows.some((row) =>
				row.detail.includes('blob_ref_named_identity_idx')
			),
			lifecycle: rows.some((row) =>
				row.detail.includes('cache_lifecycle_named_identity_idx')
			),
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
	await seedOwnedNarReference(privateCache, 'private', edgeGeneration);
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
	const privateRead = { scope: privateCache, access: 'private' } as const;

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
				await seedCacheGeneration(privateCache, cacheGeneration, 'private');
			}

			const response = await serveNarInfo(
				new Request('https://cache.example/probe.narinfo'),
				env,
				tenant,
				privateRead,
				referencingPath,
				true
			);
			const missing = await missingStorePathHashes(env, tenant, privateRead, [
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
				privateRead,
				referencingPath,
				true
			);
			const missing = await missingStorePathHashes(env, tenant, privateRead, [
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
			privateRead,
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
