import {
	type CacheScope,
	type StorePathHash
} from '@cupboard/nix-store/scalars';
import {
	type DependencyStatusResponse,
	dependencyStatusResponseSchema
} from '@cupboard/protocol/dependency-status';
import {
	type AuthorizationDetails,
	authorizationDetailsSchema
} from '@cupboard/protocol/grants';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { uploadIdSchema } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema.ts';
import { r2ObjectKeySchema } from '../http/http.ts';
import {
	authorisedWorkerFetch,
	cacheScopedPath,
	cacheWriteGrants,
	defaultCache,
	fixtureWorkerServer,
	initialiseViaWorker,
	issueWorkerSignedToken,
	namedCache,
	putWorkerTestCache,
	recordTransition,
	resetTestServer,
	resolvedCache,
	syntheticNarHash,
	syntheticStorePathHash,
	uploadMetadata
} from '../test-support.ts';

import { type ServerContext } from './context.ts';
import { DependencyStatusService } from './dependency-status-service.ts';
import {
	pastInstant,
	storePathString
} from './garbage-collection.test-support.ts';
import { noCost } from './operation-cost.test-support.ts';
import {
	type OperationCostRecord,
	withOperationCost
} from './operation-cost.ts';
import { setView } from './reuse-view-read.test-support.ts';

// The fixture creates the caches in this order, and their identities follow
// it. A path's source is the first permitted cache in identity order. The
// destination is private, so private caches can supply it.
const destination = namedCache('pr-builds');
const unreadable = namedCache('secrets');
const publicSource = namedCache('releases');
const grantedSource = namedCache('falcon');
const viewedSource = namedCache('vault');
const removedSource = namedCache('archive');
const sourceView = 'vault-view';

const contentReadOnGrantedSource = {
	type: 'cupboard_cache',
	actions: ['cache:content-read'],
	cache: grantedSource
};
const contentReadOnSourceView = {
	type: 'cupboard_view',
	actions: ['view:content-read'],
	view: sourceView
};

const path = syntheticStorePathHash(1);

type UploadVerdict = 'pending' | 'committing' | 'servable';

interface FixtureRow {
	readonly cache: CacheScope;
	readonly storePathHash: StorePathHash;
	readonly buildInputsVersion?: number;
	readonly upload?: UploadVerdict;
	// The upload has no narinfo row yet, as between the start of its commit
	// and the reservation of its row.
	readonly withoutRow?: boolean;
}

function grantsWith(extra: readonly object[]): AuthorizationDetails {
	return authorizationDetailsSchema.parse([
		...cacheWriteGrants([], destination),
		...extra
	]);
}

const readingGrants = grantsWith([
	contentReadOnGrantedSource,
	contentReadOnSourceView
]);

function insertRow(context: ServerContext, row: FixtureRow, index: number) {
	const cacheId = resolvedCache(context, row.cache).id;
	const createdAt = isoTimestamp(new Date(pastInstant));

	if (row.withoutRow !== true) {
		insertNarInfoRow(context, row, index);
	}

	if (row.upload === undefined) {
		return;
	}

	const id = uploadIdSchema.parse(crypto.randomUUID());

	context.db
		.insert(schema.pendingUploads)
		.values({
			id,
			cacheId,
			narHash: syntheticNarHash(index),
			r2Key: r2ObjectKeySchema.parse(`staging/${id}`),
			metadataJson: JSON.stringify(
				uploadMetadata({ fileSize: 1, storePathHash: row.storePathHash })
			),
			createdAt,
			expiresAt: isoTimestamp(new Date('2099-01-01T00:00:00.000Z')),
			verdict: row.upload
		})
		.run();
}

function insertNarInfoRow(
	context: ServerContext,
	row: FixtureRow,
	index: number
) {
	context.db
		.insert(schema.narInfos)
		.values({
			cacheId: resolvedCache(context, row.cache).id,
			storePathHash: row.storePathHash,
			storePath: storePathString(row.storePathHash),
			narHash: syntheticNarHash(index),
			narSize: 1,
			referencesJson: '[]',
			...(row.buildInputsVersion !== undefined && {
				buildInputsJson: '[]',
				buildInputsVersion: row.buildInputsVersion
			}),
			createdAt: isoTimestamp(new Date(pastInstant))
		})
		.run();
}

async function insertRows(rows: readonly FixtureRow[]): Promise<void> {
	await runInDurableObject(fixtureWorkerServer(), (instance) => {
		for (const [index, row] of rows.entries()) {
			insertRow(instance.context, row, index);
		}
	});
}

// Marks `scope` removed the way the gated step of a removal does. The
// teardown drain has not yet deleted its rows.
async function markRemoved(scope: CacheScope): Promise<void> {
	await runInDurableObject(fixtureWorkerServer(), (instance) => {
		const cache = resolvedCache(instance.context, scope);

		instance.context.db
			.update(schema.cacheIdentities)
			.set({ deletedAt: isoTimestamp(new Date()) })
			.where(eq(schema.cacheIdentities.id, cache.id))
			.run();
		instance.context.db
			.insert(schema.cacheTeardowns)
			.values({ cacheId: cache.id })
			.run();
	});
}

async function requestStatus(
	grants: AuthorizationDetails,
	storePathHashes: readonly StorePathHash[],
	cache: CacheScope = destination
): Promise<Response> {
	const token = await issueWorkerSignedToken(grants);

	return authorisedWorkerFetch(
		cacheScopedPath(cache, '/uploads/dependency-status'),
		token,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ storePathHashes })
		}
	);
}

async function status(
	grants: AuthorizationDetails,
	storePathHashes: readonly StorePathHash[],
	cache: CacheScope = destination
): Promise<DependencyStatusResponse> {
	const response = await requestStatus(grants, storePathHashes, cache);

	expect(response.status).toBe(StatusCodes.OK);

	return dependencyStatusResponseSchema.parse(await response.json());
}

async function refusal(
	grants: AuthorizationDetails,
	storePathHashes: readonly StorePathHash[]
): Promise<unknown> {
	const response = await requestStatus(grants, storePathHashes);
	const body: { code?: unknown; data?: unknown } = await response.json();

	return { status: response.status, code: body.code, data: body.data };
}

// Answers through the service and returns the response with the cost of the
// answer alone.
async function measuredStatus(storePathHashes: readonly StorePathHash[]) {
	return runInDurableObject(fixtureWorkerServer(), async (instance) => {
		let cost: OperationCostRecord | undefined;
		const response = await withOperationCost(
			'dependency-status',
			() =>
				Promise.resolve(
					new DependencyStatusService(instance.context).status(
						destination,
						storePathHashes,
						readingGrants
					)
				),
			(recorded) => {
				cost = recorded;
			}
		);

		return { response, cost };
	});
}

describe('dependency status', () => {
	beforeEach(async () => {
		await resetTestServer();
		await recordTransition('cache-identity', 'complete');

		const owner = await initialiseViaWorker();
		await putWorkerTestCache(owner, destination, 'private');
		await putWorkerTestCache(owner, unreadable, 'private');
		await putWorkerTestCache(owner, publicSource, 'public');
		await putWorkerTestCache(owner, grantedSource, 'private');
		await putWorkerTestCache(owner, viewedSource, 'private');
		await putWorkerTestCache(owner, removedSource, 'public');
		await setView(
			[{ kind: 'named', name: viewedSource.name }],
			sourceView,
			'private'
		);
	});

	it.each<{ state: string; rows: readonly FixtureRow[]; entry: unknown }>([
		{
			state: 'absent without a row',
			rows: [],
			entry: { storePathHash: path, state: 'absent' }
		},
		{
			state: 'in flight with a pending upload',
			rows: [{ cache: destination, storePathHash: path, upload: 'pending' }],
			entry: { storePathHash: path, state: 'in-flight' }
		},
		{
			state: 'in flight with a committing upload',
			rows: [{ cache: destination, storePathHash: path, upload: 'committing' }],
			entry: { storePathHash: path, state: 'in-flight' }
		},
		{
			state: 'in flight before its committing upload reserves a row',
			rows: [
				{
					cache: destination,
					storePathHash: path,
					upload: 'committing',
					withoutRow: true
				},
				{ cache: publicSource, storePathHash: path }
			],
			entry: { storePathHash: path, state: 'in-flight' }
		},
		{
			state: 'in flight with recorded build inputs',
			rows: [
				{
					cache: destination,
					storePathHash: path,
					buildInputsVersion: 2,
					upload: 'pending'
				}
			],
			entry: { storePathHash: path, state: 'in-flight' }
		},
		{
			state: 'present without recorded build inputs',
			rows: [{ cache: destination, storePathHash: path }],
			entry: { storePathHash: path, state: 'present' }
		},
		{
			state: 'present after its upload became servable',
			rows: [{ cache: destination, storePathHash: path, upload: 'servable' }],
			entry: { storePathHash: path, state: 'present' }
		},
		{
			state: 'recorded with its build-input version',
			rows: [
				{ cache: destination, storePathHash: path, buildInputsVersion: 2 }
			],
			entry: { storePathHash: path, state: 'recorded', buildInputsVersion: 2 }
		}
	])('reports a path $state', async ({ rows, entry }) => {
		await insertRows(rows);

		expect(await status(readingGrants, [path])).toStrictEqual({
			paths: [entry]
		});
	});

	it.each<{
		holder: string;
		rows: readonly FixtureRow[];
		removed?: CacheScope;
		extra: readonly object[];
		entry: unknown;
	}>([
		{
			holder: 'the destination alone',
			rows: [{ cache: destination, storePathHash: path }],
			extra: [],
			entry: { storePathHash: path, state: 'present' }
		},
		{
			holder: 'a public cache',
			rows: [{ cache: publicSource, storePathHash: path }],
			extra: [],
			entry: { storePathHash: path, state: 'absent', source: publicSource }
		},
		{
			holder: 'a private cache that the token can read',
			rows: [{ cache: grantedSource, storePathHash: path }],
			extra: [contentReadOnGrantedSource],
			entry: { storePathHash: path, state: 'absent', source: grantedSource }
		},
		{
			holder: 'a private cache in a reuse view that the token can read',
			rows: [{ cache: viewedSource, storePathHash: path }],
			extra: [contentReadOnSourceView],
			entry: { storePathHash: path, state: 'absent', source: viewedSource }
		},
		{
			holder: 'a private cache that the token cannot read',
			rows: [{ cache: unreadable, storePathHash: path }],
			extra: [contentReadOnGrantedSource, contentReadOnSourceView],
			entry: { storePathHash: path, state: 'absent' }
		},
		{
			holder: 'a private cache in a reuse view that the token cannot read',
			rows: [{ cache: viewedSource, storePathHash: path }],
			extra: [contentReadOnGrantedSource],
			entry: { storePathHash: path, state: 'absent' }
		},
		{
			holder: 'a removed public cache',
			rows: [{ cache: removedSource, storePathHash: path }],
			removed: removedSource,
			extra: [],
			entry: { storePathHash: path, state: 'absent' }
		},
		{
			holder: 'a public cache whose upload of the path is in flight',
			rows: [{ cache: publicSource, storePathHash: path, upload: 'pending' }],
			extra: [],
			entry: { storePathHash: path, state: 'absent' }
		}
	])(
		'offers a source for a path that $holder has',
		async ({ rows, removed, extra, entry }) => {
			await insertRows(rows);
			if (removed !== undefined) {
				await markRemoved(removed);
			}

			expect(await status(grantsWith(extra), [path])).toStrictEqual({
				paths: [entry]
			});
		}
	);

	it.each<{ sources: string; rows: readonly FixtureRow[]; source: CacheScope }>(
		[
			{
				sources: 'every readable cache',
				rows: [
					{ cache: unreadable, storePathHash: path },
					{ cache: publicSource, storePathHash: path },
					{ cache: grantedSource, storePathHash: path },
					{ cache: viewedSource, storePathHash: path }
				],
				source: publicSource
			},
			{
				sources: 'the readable caches without an upload in flight',
				rows: [
					{ cache: unreadable, storePathHash: path },
					{ cache: publicSource, storePathHash: path, upload: 'committing' },
					{ cache: grantedSource, storePathHash: path },
					{ cache: viewedSource, storePathHash: path }
				],
				source: grantedSource
			}
		]
	)(
		'offers the first of $sources in identity order',
		async ({ rows, source }) => {
			await insertRows(rows);

			expect(await status(readingGrants, [path])).toStrictEqual({
				paths: [{ storePathHash: path, state: 'absent', source }]
			});
		}
	);

	it.each<{ destinationState: string; arrange: () => Promise<void> }>([
		{
			destinationState: 'removed',
			arrange: async () => {
				await markRemoved(destination);
			}
		},
		{
			destinationState: 'removed and created again',
			arrange: async () => {
				await markRemoved(destination);
				await putWorkerTestCache(
					await initialiseViaWorker(),
					destination,
					'private'
				);
			}
		}
	])(
		'reports the rows of a $destinationState destination as absent',
		async ({ arrange }) => {
			const recorded = syntheticStorePathHash(2);
			const copied = syntheticStorePathHash(3);
			await insertRows([
				{ cache: destination, storePathHash: path },
				{ cache: destination, storePathHash: recorded, buildInputsVersion: 1 },
				{ cache: destination, storePathHash: copied },
				{ cache: publicSource, storePathHash: copied }
			]);
			await arrange();

			expect(
				await status(readingGrants, [path, recorded, copied])
			).toStrictEqual({
				paths: [
					{ storePathHash: path, state: 'absent' },
					{ storePathHash: recorded, state: 'absent' },
					{ storePathHash: copied, state: 'absent', source: publicSource }
				]
			});
		}
	);

	// A path is never offered from a private cache to a public one. A cache
	// that does not exist yet takes the access of the default cache when a
	// write creates it.
	it.each<{
		pair: string;
		target: CacheScope;
		defaultAccess?: 'public' | 'private';
		// Whether the tenant's default cache is removed, so that it has none.
		isDefaultRemoved?: boolean;
		holder: CacheScope;
		source?: CacheScope;
	}>([
		{
			pair: 'a private source and a public destination',
			target: namedCache('pr-public'),
			holder: grantedSource
		},
		{
			pair: 'a private source and a private destination',
			target: destination,
			holder: grantedSource,
			source: grantedSource
		},
		{
			pair: 'a public source and a public destination',
			target: namedCache('pr-public'),
			holder: publicSource,
			source: publicSource
		},
		{
			pair: 'a private source and a new destination in a public tenant',
			target: namedCache('pr-new'),
			defaultAccess: 'public',
			holder: grantedSource
		},
		{
			pair: 'a private source and a new destination in a private tenant',
			target: namedCache('pr-new'),
			defaultAccess: 'private',
			holder: grantedSource,
			source: grantedSource
		},
		{
			pair: 'a private source and a new destination in a tenant without a default cache',
			target: namedCache('pr-new'),
			defaultAccess: 'private',
			isDefaultRemoved: true,
			holder: grantedSource
		},
		{
			pair: 'a private source and a missing default destination',
			target: defaultCache(),
			defaultAccess: 'private',
			isDefaultRemoved: true,
			holder: grantedSource
		}
	])(
		'offers a source for $pair only when access allows it',
		async ({ target, defaultAccess, isDefaultRemoved, holder, source }) => {
			const owner = await initialiseViaWorker();
			await putWorkerTestCache(owner, namedCache('pr-public'), 'public');
			if (defaultAccess !== undefined) {
				await putWorkerTestCache(owner, defaultCache(), defaultAccess);
			}
			if (isDefaultRemoved === true) {
				await markRemoved(defaultCache());
			}
			await insertRows([{ cache: holder, storePathHash: path }]);
			const grants = authorizationDetailsSchema.parse([
				...cacheWriteGrants([], target),
				contentReadOnGrantedSource
			]);

			expect(await status(grants, [path], target)).toStrictEqual({
				paths: [
					{
						storePathHash: path,
						state: 'absent',
						...(source !== undefined && { source })
					}
				]
			});
		}
	);

	it('answers a destination that does not exist yet', async () => {
		const newCache = namedCache('pr-new');
		await insertRows([{ cache: publicSource, storePathHash: path }]);

		expect(
			await status(cacheWriteGrants([], newCache), [path], newCache)
		).toStrictEqual({
			paths: [{ storePathHash: path, state: 'absent', source: publicSource }]
		});
	});

	it.each([
		{ route: 'a named cache', cache: destination },
		{ route: 'the default cache', cache: defaultCache() }
	])('answers a full page through $route', async ({ cache }) => {
		const page = Array.from({ length: 1024 }, (_, index) =>
			syntheticStorePathHash(index)
		);

		expect(
			await status(cacheWriteGrants([], cache), page, cache)
		).toStrictEqual({
			paths: page.map((storePathHash) => ({ storePathHash, state: 'absent' }))
		});
	});

	it('answers a hash that the request lists twice', async () => {
		const absent = syntheticStorePathHash(2);
		await insertRows([{ cache: destination, storePathHash: path }]);

		expect(await status(readingGrants, [path, absent, path])).toStrictEqual({
			paths: [
				{ storePathHash: path, state: 'present' },
				{ storePathHash: absent, state: 'absent' },
				{ storePathHash: path, state: 'present' }
			]
		});
	});

	it('refuses a page above the limit', async () => {
		const page = Array.from({ length: 1025 }, (_, index) =>
			syntheticStorePathHash(index)
		);

		expect(await refusal(readingGrants, page)).toStrictEqual({
			status: StatusCodes.REQUEST_TOO_LONG,
			code: 'UPLOAD_REQUEST_LIMIT_EXCEEDED',
			data: { maxPaths: 1024 }
		});
	});

	it.each([
		{
			token: 'only content reads on the destination',
			grants: [
				{
					type: 'cupboard_cache',
					actions: ['cache:content-read'],
					cache: destination
				}
			]
		},
		{
			token: 'negotiation on another cache',
			grants: [
				{
					type: 'cupboard_cache',
					actions: ['upload:negotiate'],
					cache: publicSource
				}
			]
		}
	])('refuses a token with $token', async ({ grants }) => {
		expect(
			await refusal(authorizationDetailsSchema.parse(grants), [path])
		).toStrictEqual({
			status: StatusCodes.FORBIDDEN,
			code: 'FORBIDDEN',
			data: undefined
		});
	});

	// A page of 64 hashes. Every page reads the JSON list of its hashes, 64
	// rows, and the destination's identity. Each row that the destination has
	// costs its primary-key entry, its table row and one entry of the
	// in-flight upload index. An absent page reads the live caches, the reuse
	// view and its members, the JSON list of the caches that the token may
	// reuse from and the JSON list of its absent hashes. For each absent hash
	// it reads one entry of the in-flight upload index, which finds an upload
	// that has not reserved its row yet, looks up the hash in each cache that
	// the token may reuse from, and probes the in-flight index once for a
	// cache that has the path. Uploads of other paths add no reads, because
	// the in-flight check searches the upload index on the cache, the path and
	// the verdict together.
	it.each<{
		page: string;
		rows: (hashes: readonly StorePathHash[]) => FixtureRow[];
		entry: (storePathHash: StorePathHash) => unknown;
		rowsRead: number;
	}>([
		{
			page: 'paths that no cache has',
			rows: () => [],
			entry: (storePathHash) => ({ storePathHash, state: 'absent' }),
			rowsRead: 282
		},
		{
			page: 'paths that the destination has',
			rows: (hashes) =>
				hashes.map((storePathHash) => ({ cache: destination, storePathHash })),
			entry: (storePathHash) => ({ storePathHash, state: 'present' }),
			rowsRead: 257
		},
		{
			page: 'paths that the destination has beside uploads of other paths',
			rows: (hashes) => [
				...hashes.map((storePathHash) => ({
					cache: destination,
					storePathHash
				})),
				...hashes.map((_, index) => ({
					cache: destination,
					storePathHash: syntheticStorePathHash(1000 + index),
					upload: 'pending' as const
				}))
			],
			entry: (storePathHash) => ({ storePathHash, state: 'present' }),
			rowsRead: 257
		},
		{
			page: 'paths that every source has',
			rows: (hashes) =>
				hashes.flatMap((storePathHash) =>
					[unreadable, publicSource, grantedSource, viewedSource].map(
						(cache) => ({ cache, storePathHash })
					)
				),
			entry: (storePathHash) => ({
				storePathHash,
				state: 'absent',
				source: publicSource
			}),
			rowsRead: 474
		}
	])(
		'reads a bounded number of rows and writes none for $page',
		async ({ rows, entry, rowsRead }) => {
			const page = Array.from({ length: 64 }, (_, index) =>
				syntheticStorePathHash(index)
			);
			await insertRows(rows(page));

			expect(await measuredStatus(page)).toStrictEqual({
				response: { paths: page.map((storePathHash) => entry(storePathHash)) },
				cost: { ...noCost, rowsRead }
			});
		}
	);

	// Private caches that the token cannot read have every path of the page,
	// and a public cache created after them has it too. The answer depends
	// only on the caches that the token may reuse from, so the unreadable
	// holders never change it. Twenty of them add 60 rows to the request, the
	// reads of their cache identities, whether the token may reuse from few or
	// many caches.
	it.each<{
		readable: string;
		holders: number;
		spares: number;
		rowsRead: number;
	}>([
		{ readable: 'few caches', holders: 0, spares: 0, rowsRead: 205 },
		{ readable: 'few caches', holders: 20, spares: 0, rowsRead: 265 },
		{ readable: 'many caches', holders: 0, spares: 17, rowsRead: 249 },
		{ readable: 'many caches', holders: 20, spares: 17, rowsRead: 309 }
	])(
		'offers the same source to a token that may reuse from $readable beside $holders unreadable holders',
		async ({ holders, spares, rowsRead }) => {
			const owner = await initialiseViaWorker();
			const unreadableHolders = Array.from({ length: holders }, (_, index) =>
				namedCache(`held-${String(index)}`)
			);
			for (const holder of unreadableHolders) {
				await putWorkerTestCache(owner, holder, 'private');
			}
			const late = namedCache('late');
			await putWorkerTestCache(owner, late, 'public');
			for (let index = 0; index < spares; index += 1) {
				await putWorkerTestCache(
					owner,
					namedCache(`spare-${String(index)}`),
					'public'
				);
			}
			const page = Array.from({ length: 16 }, (_, index) =>
				syntheticStorePathHash(index)
			);
			await insertRows(
				page.flatMap((storePathHash) =>
					[...unreadableHolders, late].map((cache) => ({
						cache,
						storePathHash
					}))
				)
			);

			expect(await measuredStatus(page)).toStrictEqual({
				response: {
					paths: page.map((storePathHash) => ({
						storePathHash,
						state: 'absent',
						source: late
					}))
				},
				cost: { ...noCost, rowsRead }
			});
		}
	);

	it('misses a source behind the first caches that the token may reuse from', async () => {
		const owner = await initialiseViaWorker();
		for (let index = 0; index < 17; index += 1) {
			await putWorkerTestCache(
				owner,
				namedCache(`spare-${String(index)}`),
				'public'
			);
		}
		const later = namedCache('later');
		await putWorkerTestCache(owner, later, 'public');
		await insertRows([{ cache: later, storePathHash: path }]);

		expect(await status(readingGrants, [path])).toStrictEqual({
			paths: [{ storePathHash: path, state: 'absent' }]
		});
	});
});
