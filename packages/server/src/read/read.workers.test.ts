import {
	type CacheAccessMode,
	type CacheGeneration,
	cacheGenerationSchema,
	type CacheScope,
	firstCacheGeneration,
	narInfoGenerationSchema,
	nixSha256HashSchema,
	storePathHashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { type ReuseViewSelector } from '@cupboard/protocol/reuse-views';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { sql } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { cacheIdentityColumns } from '../db/cache.ts';
import { writeCacheLifecycle } from '../db/cache-lifecycle-write.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { jsonRowList, jsonValueLists } from '../do/json-list.ts';
import { reuseEdgeSelect } from '../do/reuse-view-lookup-service.ts';
import {
	PathReadAuthorityMigrationPendingError,
	SharedFactsUnavailableError
} from '../errors.ts';
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
			...cacheIdentityColumns(cache),
			storePathHash: referencingPath,
			generation: referencedGeneration,
			narHash,
			cacheGeneration: edgeGeneration ?? firstCacheGeneration
		})
		.onConflictDoNothing();
	const insertLifecycle = database
		.insert(d1Schema.cacheLifecycle)
		.values({
			tenant,
			...cacheIdentityColumns(cache),
			access,
			generation: edgeGeneration ?? firstCacheGeneration,
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
	const insert = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
		.insert(d1Schema.cacheLifecycle)
		.values({
			tenant,
			...cacheIdentityColumns(cache),
			access,
			generation,
			updatedAt: isoTimestamp(new Date())
		});
	const set = { access, generation };

	// Each cache kind has its own partial unique index, so name the matching
	// conflict target.
	return cache.kind === 'default'
		? insert.onConflictDoUpdate({
				target: d1Schema.cacheLifecycle.tenant,
				targetWhere: sql`${d1Schema.cacheLifecycle.cacheKind} = 'default'`,
				set
			})
		: insert.onConflictDoUpdate({
				target: [
					d1Schema.cacheLifecycle.tenant,
					d1Schema.cacheLifecycle.cacheName
				],
				targetWhere: sql`${d1Schema.cacheLifecycle.cacheKind} = 'named'`,
				set
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
				{
					scope: defaultCache(),
					access: 'public',
					generation: firstCacheGeneration
				},
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
});

describe('NAR reference cache generations', () => {
	const secondGeneration = cacheGenerationSchema.parse(2);
	const cases: {
		readonly name: string;
		readonly edgeGeneration: CacheGeneration;
		readonly cacheGeneration?: CacheGeneration;
		readonly isServed: boolean;
	}[] = [
		{
			name: 'serves a generation-1 reference while the cache is at generation 1',
			edgeGeneration: firstCacheGeneration,
			isServed: true
		},
		{
			name: 'refuses a generation-1 reference after cache deletion',
			edgeGeneration: firstCacheGeneration,
			cacheGeneration: secondGeneration,
			isServed: false
		},
		{
			name: 'serves a generation-2 reference while the cache is at generation 2',
			edgeGeneration: secondGeneration,
			cacheGeneration: secondGeneration,
			isServed: true
		},
		{
			name: 'refuses a generation-2 reference after another cache deletion',
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
				row.detail.includes('blob_ref_readable_nar_idx')
			),
			blobState: isIndexSeek('blob_state'),
			lifecycle: isIndexSeek('cache_lifecycle_storage'),
			scans: rows.filter((row) => row.detail.startsWith('SCAN ')).length
		}).toStrictEqual({
			edge: true,
			blobState: true,
			lifecycle: true,
			scans: 0
		});
	});

	it('seeks the cache-identity index for an authenticated narinfo read', async () => {
		const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
		const [list] = jsonValueLists([referencingPath]);

		if (list === undefined) {
			throw new Error('one store path produced no bound list');
		}

		const query = narInfoReferenceQuery(
			database,
			tenant,
			privateCache,
			list
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

		// The identity index leads with the tenant and the cache's identity
		// columns, so the narinfo check needs no index of its own. The plan also
		// walks `json_each`, which reads the bound list itself: SQLite probes the
		// index once per store path, so only a scan of a real table would show
		// that the list had stopped the index being used.
		expect({
			edge: isIndexSeek('blob_ref_storage'),
			lifecycle: isIndexSeek('cache_lifecycle_storage'),
			tableScans: rows.filter(
				(row) =>
					row.detail.startsWith('SCAN ') &&
					!row.detail.includes('VIRTUAL TABLE')
			).length
		}).toStrictEqual({ edge: true, lifecycle: true, tableScans: 0 });
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
	await env.BLOBS.put(narObjectKey(narHash), narBytes);
	await env.BLOBS.put(
		narInfoObjectKey(
			tenant,
			referencingPath,
			privateCache,
			edgeGeneration ?? firstCacheGeneration
		),
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
	const privateRead = {
		scope: privateCache,
		access: 'private',
		generation: firstCacheGeneration
	} as const;

	it('serves a narinfo without reading the NAR at its recorded URL', async () => {
		await seedPrivateNarInfo();
		await env.BLOBS.delete(narObjectKey(narHash));
		const heads = vi.spyOn(env.BLOBS, 'head');

		try {
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
				body: await response.text(),
				heads: heads.mock.calls
			}).toStrictEqual({
				status: StatusCodes.OK,
				body: 'narinfo-bytes',
				heads: []
			});
		} finally {
			heads.mockRestore();
		}
	});

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
				{ ...privateRead, generation: cacheGeneration ?? firstCacheGeneration },
				referencingPath,
				true
			);
			const missing = await missingStorePathHashes(
				env.BLOBS,
				drizzleD1(env.CUPBOARD_DB, { schema: d1Schema }),
				tenant,
				privateRead.scope,
				[referencingPath]
			);

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
			const missing = await missingStorePathHashes(
				env.BLOBS,
				drizzleD1(env.CUPBOARD_DB, { schema: d1Schema }),
				tenant,
				privateRead.scope,
				[referencingPath]
			);

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

async function restoreExpandedAuthority(): Promise<void> {
	await env.CUPBOARD_DB.batch(
		[
			'DROP VIEW attestation_ref',
			'DROP VIEW blob_ref',
			'ALTER TABLE blob_ref_storage RENAME TO blob_ref',
			'ALTER TABLE attestation_ref_storage RENAME TO attestation_ref',
			'CREATE VIEW blob_ref_storage AS SELECT * FROM blob_ref',
			'CREATE VIEW attestation_ref_storage AS SELECT * FROM attestation_ref',
			'DROP VIEW cache_lifecycle',
			'ALTER TABLE cache_lifecycle_storage RENAME TO cache_lifecycle',
			'CREATE VIEW cache_lifecycle_storage AS SELECT * FROM cache_lifecycle'
		].map((query) => env.CUPBOARD_DB.prepare(query))
	);
	await env.CUPBOARD_DB.prepare(
		"UPDATE deployment_transition SET state = 'expanded', contracted_at = NULL WHERE id = 'blob-reference-read-authority'"
	).run();
}

async function contractAuthority(): Promise<void> {
	const contract = env.TEST_MIGRATIONS.find(
		(migration) => migration.name === '0036_path_read_authority_contract.sql'
	);
	if (contract === undefined) {
		throw new Error('The path read authority contract migration is missing.');
	}
	await env.CUPBOARD_DB.batch(
		contract.queries.map((query) => env.CUPBOARD_DB.prepare(query))
	);
	await env.CUPBOARD_DB.prepare(
		"UPDATE deployment_transition SET state = 'complete', contracted_at = '2026-01-01T00:00:00.000Z' WHERE id = 'blob-reference-read-authority'"
	).run();
}

describe('cache admission compatibility', () => {
	it('writes lifecycle rows before contraction, refuses the switch, and resumes on physical storage', async () => {
		await seedOwnedNar();
		const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
		await restoreExpandedAuthority();
		try {
			const before = await writeCacheLifecycle(database, async (table) =>
				database
					.update(table)
					.set({ access: 'private' })
					.where(sql`${table.tenant} = ${tenant}`)
					.returning({ access: table.access })
					.all()
			);
			await env.CUPBOARD_DB.prepare(
				"UPDATE deployment_transition SET contracted_at = '2026-01-01T00:00:00.000Z' WHERE id = 'blob-reference-read-authority'"
			).run();
			const mutation = () =>
				writeCacheLifecycle(database, async (table) =>
					database
						.update(table)
						.set({ access: 'public' })
						.where(sql`${table.tenant} = ${tenant}`)
						.returning({ access: table.access })
						.all()
				);
			await expect(mutation()).rejects.toBeInstanceOf(
				PathReadAuthorityMigrationPendingError
			);
			await contractAuthority();
			const after = await mutation();
			expect({ before, after }).toStrictEqual({
				before: [{ access: 'private' }],
				after: [{ access: 'public' }]
			});
		} finally {
			const type = await env.CUPBOARD_DB.prepare(
				"SELECT type FROM sqlite_master WHERE name = 'cache_lifecycle'"
			).first<{ type: string }>();
			if (type?.type === 'table') {
				await contractAuthority();
			}
		}
	});

	it('classifies an overlapping lifecycle switch and rolls back the whole write batch', async () => {
		await seedOwnedNar();
		const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
		const before = await env.CUPBOARD_DB.prepare(
			'SELECT * FROM tenant_usage'
		).all();
		await restoreExpandedAuthority();
		try {
			const mutation = writeCacheLifecycle(database, async (table) => {
				await contractAuthority();
				return database.batch([
					database
						.update(d1Schema.tenantUsage)
						.set({ narinfos: sql`${d1Schema.tenantUsage.narinfos} + 1` }),
					database
						.update(table)
						.set({ access: 'private' })
						.where(sql`${table.tenant} = ${tenant}`)
				]);
			});
			let failure:
				| {
						name: string;
						status: number;
						retryAfterSeconds: number;
						hasCause: boolean;
				  }
				| undefined;
			try {
				await mutation;
			} catch (error) {
				if (!(error instanceof PathReadAuthorityMigrationPendingError)) {
					throw error;
				}
				failure = {
					name: error.name,
					status: error.status,
					retryAfterSeconds: error.retryAfterSeconds,
					hasCause: error.cause instanceof Error
				};
			}
			expect(failure).toStrictEqual({
				name: 'PathReadAuthorityMigrationPendingError',
				status: 503,
				retryAfterSeconds: 1,
				hasCause: true
			});
			const after = await env.CUPBOARD_DB.prepare(
				'SELECT * FROM tenant_usage'
			).all();
			expect(after.results).toStrictEqual(before.results);
		} finally {
			const type = await env.CUPBOARD_DB.prepare(
				"SELECT type FROM sqlite_master WHERE name = 'cache_lifecycle'"
			).first<{ type: string }>();
			if (type?.type === 'table') {
				await contractAuthority();
			}
		}
	});

	it.each([
		{ access: 'public', stage: 'expanded' },
		{ access: 'private', stage: 'expanded' },
		{ access: 'public', stage: 'contracted' },
		{ access: 'private', stage: 'contracted' }
	] as const)(
		'keeps current $access admission through $stage storage',
		async ({ access, stage }) => {
			await seedOwnedNar(defaultCache(), access);
			if (stage === 'expanded') {
				await restoreExpandedAuthority();
			}
			try {
				const database = drizzleD1(env.CUPBOARD_DB);
				const current = await database
					.select({
						access: d1Schema.cacheLifecycle.access,
						generation: d1Schema.cacheLifecycle.generation
					})
					.from(d1Schema.cacheLifecycle)
					.where(sql`${d1Schema.cacheLifecycle.tenant} = ${tenant}`)
					.get();
				const preceding = await env.CUPBOARD_DB.prepare(
					'SELECT count(*) AS admitted FROM cache_lifecycle WHERE tenant = ?'
				)
					.bind(tenant)
					.first();
				expect({ current, preceding }).toStrictEqual({
					current: { access, generation: firstCacheGeneration },
					preceding: { admitted: stage === 'expanded' ? 1 : 0 }
				});
			} finally {
				if (stage === 'expanded') {
					await contractAuthority();
				}
			}
		}
	);

	it.each(['insert', 'update', 'delete'] as const)(
		'rolls back a preceding lifecycle %s after contraction',
		async (operation) => {
			await seedOwnedNar();
			const before = await env.CUPBOARD_DB.prepare(
				'SELECT * FROM tenant_usage'
			).all();
			const queries = {
				insert:
					"INSERT INTO cache_lifecycle(tenant,cache_kind,access,generation,updated_at) VALUES (?, 'default', 'public', 1, '2026-01-01T00:00:00.000Z')",
				update: 'UPDATE cache_lifecycle SET deleted_at = NULL WHERE tenant = ?',
				delete: 'DELETE FROM cache_lifecycle WHERE tenant = ?'
			};
			await expect(
				env.CUPBOARD_DB.batch([
					env.CUPBOARD_DB.prepare(
						'UPDATE tenant_usage SET narinfos = narinfos + 1'
					),
					env.CUPBOARD_DB.prepare(queries[operation]).bind(tenant)
				])
			).rejects.toThrow('cannot modify cache_lifecycle because it is a view');
			const after = await env.CUPBOARD_DB.prepare(
				'SELECT * FROM tenant_usage'
			).all();
			expect(after.results).toStrictEqual(before.results);
		}
	);
});

describe('preceding reference authority queries', () => {
	it.each([0, 2, 5, 6, 7, 8])(
		'resumes an interrupted authority contract after statement %s without changing rows or indexes',
		async (boundary) => {
			await seedOwnedNar();
			const contract = env.TEST_MIGRATIONS.find(
				(migration) =>
					migration.name === '0036_path_read_authority_contract.sql'
			);
			if (contract === undefined) {
				throw new Error(
					'The path read authority contract migration is missing.'
				);
			}
			await restoreExpandedAuthority();
			const before = await env.CUPBOARD_DB.prepare(
				"SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name LIKE '%ref%' OR name LIKE '%lifecycle%' ORDER BY name"
			).all();
			const queries = contract.queries.flatMap((query, index) =>
				index === boundary
					? [query, 'SELECT * FROM interrupted_authority_contract']
					: [query]
			);
			try {
				await expect(
					env.CUPBOARD_DB.batch(
						queries.map((query) => env.CUPBOARD_DB.prepare(query))
					)
				).rejects.toThrow('no such table: interrupted_authority_contract');
				const after = await env.CUPBOARD_DB.prepare(
					"SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name LIKE '%ref%' OR name LIKE '%lifecycle%' ORDER BY name"
				).all();
				expect(after.results).toStrictEqual(before.results);
			} finally {
				await contractAuthority();
			}
			const rows = await drizzleD1(env.CUPBOARD_DB)
				.select()
				.from(d1Schema.blobReference)
				.all();
			expect(
				rows.map((row) => ({ ...row, cacheName: row.cacheName ?? undefined }))
			).toStrictEqual([
				{
					tenant,
					cacheKind: 'default',
					cacheName: undefined,
					storePathHash: referencingPath,
					generation: referencedGeneration,
					narHash,
					readable: true,
					cacheGeneration: firstCacheGeneration
				}
			]);
		}
	);

	it.each(['insert', 'update', 'delete'] as const)(
		'refuses a preceding %s and rolls back its quota charge after contraction',
		async (operation) => {
			await seedOwnedNar();
			const before = await env.CUPBOARD_DB.prepare(
				'SELECT * FROM tenant_usage'
			).all();
			const statements = {
				insert:
					"INSERT INTO blob_ref(tenant,cache_kind,store_path_hash,generation,nar_hash,cache_generation) VALUES (?, 'default', ?, 2, ?, 1)",
				update:
					'UPDATE blob_ref SET readable = true WHERE tenant = ? AND store_path_hash = ? AND nar_hash = ?',
				delete:
					'DELETE FROM blob_ref WHERE tenant = ? AND store_path_hash = ? AND nar_hash = ?'
			};
			const mutation = env.CUPBOARD_DB.prepare(statements[operation]).bind(
				tenant,
				referencingPath,
				narHash
			);
			await expect(
				env.CUPBOARD_DB.batch([
					env.CUPBOARD_DB.prepare(
						'UPDATE tenant_usage SET narinfos = narinfos + 1'
					),
					mutation
				])
			).rejects.toThrow('cannot modify blob_ref because it is a view');
			const after = await env.CUPBOARD_DB.prepare(
				'SELECT * FROM tenant_usage'
			).all();
			expect(after.results).toStrictEqual(before.results);
		}
	);

	it.each(['current', 'preceding'] as const)(
		'refuses a first authority query after revocation through the %s representation',
		async (reader) => {
			await seedOwnedNar();
			const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
			const hasReadAuthority = async () => {
				if (reader === 'current') {
					const rows = await narReferenceQuery(
						database,
						tenant,
						narHash,
						defaultPublicAuthority
					).all();
					return rows.some((row) => row.available);
				}
				const result = await env.CUPBOARD_DB.prepare(
					`SELECT blob_state.nar_hash FROM blob_ref
					INNER JOIN blob_state ON blob_state.nar_hash = blob_ref.nar_hash
					INNER JOIN cache_lifecycle ON cache_lifecycle.tenant = blob_ref.tenant
					 AND cache_lifecycle.cache_kind = blob_ref.cache_kind
					 AND ((blob_ref.cache_kind = 'default' AND cache_lifecycle.cache_name IS NULL AND blob_ref.cache_name IS NULL)
					 OR (blob_ref.cache_kind = 'named' AND cache_lifecycle.cache_name = blob_ref.cache_name))
					WHERE blob_ref.tenant = ? AND blob_ref.nar_hash = ?
					 AND blob_ref.cache_kind = 'default' AND blob_ref.cache_name IS NULL
					 AND cache_lifecycle.access = 'public'
					 AND blob_ref.cache_generation = coalesce(cache_lifecycle.generation, 1)`
				)
					.bind(tenant, narHash)
					.first();
				return result !== null;
			};
			await restoreExpandedAuthority();
			const wasAuthorisedBefore = await hasReadAuthority();
			await contractAuthority();
			await database.insert(d1Schema.pathReadRevocation).values({
				tenant,
				...cacheIdentityColumns(defaultCache()),
				storePathHash: referencingPath,
				cacheGeneration: firstCacheGeneration,
				generation: referencedGeneration
			});
			const wasAuthorisedAfter = await hasReadAuthority();
			const retained = await database
				.select({
					generation: d1Schema.blobReference.generation,
					readable: d1Schema.blobReference.readable
				})
				.from(d1Schema.blobReference)
				.all();
			const object = await env.BLOBS.get(narObjectKey(narHash));
			expect({
				wasAuthorisedBefore,
				wasAuthorisedAfter,
				retained,
				bytes: await object?.text()
			}).toStrictEqual({
				wasAuthorisedBefore: true,
				wasAuthorisedAfter: false,
				retained: [{ generation: referencedGeneration, readable: true }],
				bytes: narBytes
			});
		}
	);
});

describe('path read revocation scale', () => {
	it('bounds candidate reads after revoking 25,000 retained generations', async () => {
		await seedOwnedNarReference();
		await env.CUPBOARD_DB.prepare(
			`WITH RECURSIVE source(n) AS (SELECT 2 UNION ALL SELECT n + 1 FROM source WHERE n < 25000)
   INSERT INTO blob_ref_storage(tenant,cache_kind,store_path_hash,generation,nar_hash,cache_generation)
   SELECT ?, 'default', ?, n, ?, 1 FROM source`
		)
			.bind(tenant, referencingPath, narHash)
			.run();
		await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
			.insert(d1Schema.pathReadRevocation)
			.values({
				tenant,
				...cacheIdentityColumns(defaultCache()),
				storePathHash: referencingPath,
				cacheGeneration: firstCacheGeneration,
				generation: narInfoGenerationSchema.parse(25_000)
			});
		const query = narReferenceQuery(
			drizzleD1(env.CUPBOARD_DB, { schema: d1Schema }),
			tenant,
			narHash,
			defaultPublicAuthority
		).toSQL();
		const measured = await env.CUPBOARD_DB.prepare(query.sql)
			.bind(...query.params)
			.all();
		expect({
			candidates: measured.results.length,
			read: measured.meta.rows_read
		}).toStrictEqual({ candidates: 65, read: 196 });
		const [paths] = jsonValueLists([referencingPath]);
		if (paths === undefined) {
			throw new Error('The direct read has no requested path.');
		}
		const direct = narInfoReferenceQuery(
			drizzleD1(env.CUPBOARD_DB, { schema: d1Schema }),
			tenant,
			defaultCache(),
			paths
		).toSQL();
		const before = await env.CUPBOARD_DB.prepare(direct.sql)
			.bind(...direct.params)
			.all();
		await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
			.insert(d1Schema.blobReference)
			.values({
				tenant,
				...cacheIdentityColumns(defaultCache()),
				storePathHash: referencingPath,
				generation: narInfoGenerationSchema.parse(25_001),
				narHash,
				cacheGeneration: firstCacheGeneration
			});
		const after = await env.CUPBOARD_DB.prepare(direct.sql)
			.bind(...direct.params)
			.all();
		expect({
			before: before.results,
			beforeRead: before.meta.rows_read,
			after: after.results,
			afterRead: after.meta.rows_read
		}).toStrictEqual({
			before: [],
			beforeRead: 5,
			after: [
				{
					store_path_hash: referencingPath,
					generation: 25_001,
					nar_hash: narHash,
					cache_generation: 1
				}
			],
			afterRead: 6
		});
		const reused = reuseEdgeSelect(
			drizzleD1(env.CUPBOARD_DB, { schema: d1Schema }),
			tenant,
			'public',
			jsonRowList([
				{
					cacheKind: 'default',
					cacheName: '',
					storePathHash: referencingPath,
					generation: narInfoGenerationSchema.parse(25_001)
				}
			])
		).toSQL();
		const reuseResult = await env.CUPBOARD_DB.prepare(reused.sql)
			.bind(...reused.params)
			.all();
		expect({
			rows: reuseResult.results.map((row) => ({
				...row,
				cache_name: row.cache_name ?? undefined
			})),
			read: reuseResult.meta.rows_read
		}).toStrictEqual({
			rows: [
				{
					cache_kind: 'default',
					cache_name: undefined,
					store_path_hash: referencingPath,
					generation: 25_001,
					nar_hash: narHash
				}
			],
			read: 4
		});

		await expect(
			serveNar(
				new Request('https://example.com/nar'),
				env,
				tenant,
				parsedNar(),
				defaultPublicAuthority,
				false
			)
		).rejects.toBeInstanceOf(SharedFactsUnavailableError);
	});
});

it('discovers a public source after 25,000 earlier policy-ineligible references', async () => {
	await seedOwnedNarReference(defaultCache(), 'private');
	await env.CUPBOARD_DB.prepare(
		`WITH RECURSIVE source(n) AS (SELECT 2 UNION ALL SELECT n+1 FROM source WHERE n < 25001)
 INSERT INTO blob_ref_storage(tenant,cache_kind,store_path_hash,generation,nar_hash,cache_generation) SELECT ?, 'default', ?, n, ?, 1 FROM source`
	)
		.bind(tenant, referencingPath, narHash)
		.run();
	await seedOwnedNarReference(namedCache('zz-authorised'), 'public');
	const query = narReferenceQuery(
		drizzleD1(env.CUPBOARD_DB, { schema: d1Schema }),
		tenant,
		narHash,
		viewAuthority('public')
	).toSQL();
	const result = await env.CUPBOARD_DB.prepare(query.sql)
		.bind(...query.params)
		.all();
	const plan = await env.CUPBOARD_DB.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
		.bind(...query.params)
		.all();
	expect({
		rows: result.results,
		read: result.meta.rows_read,
		plan: plan.results.map((row) => row.detail)
	}).toStrictEqual({
		rows: [{ nar_hash: narHash, available: 1 }],
		read: 75_006,
		plan: [
			'SEARCH blob_state USING COVERING INDEX sqlite_autoindex_blob_state_1 (nar_hash=?)',
			'SEARCH blob_ref_storage USING INDEX blob_ref_readable_nar_idx (tenant=? AND nar_hash=?)',
			'SEARCH cache_lifecycle_storage USING INDEX cache_lifecycle_native_identity_idx (tenant=? AND cache_kind=?)',
			'CORRELATED SCALAR SUBQUERY 1',
			'SEARCH path_read_revocation USING INDEX path_read_revocation_native_identity_idx (tenant=? AND cache_kind=? AND cache_name=? AND store_path_hash=?)'
		]
	});
});
