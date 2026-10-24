import {
	type CacheScope,
	nixSha256HashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import {
	type AuthorizationDetails,
	authorizationDetailsSchema
} from '@cupboard/protocol/grants';
import {
	type UploadId,
	uploadNegotiateResponseSchema,
	type UploadPathMetadata
} from '@cupboard/protocol/upload';
import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import { narObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	adminGrants,
	blobReferenceRows,
	cacheScopedPath,
	cacheWriteGrants,
	CommitSocketError,
	commitUploadViaWorker,
	expectSingleCommitDecision,
	expectSingleUploadDecision,
	handlerFetch,
	initialiseViaWorker,
	issueWorkerSignedToken,
	namedCache,
	pushPathToTenant,
	putWorkerTestCache,
	readFetch,
	recordTransition,
	resetTestServer,
	syntheticStorePathHash,
	testPushId,
	uploadMetadata,
	uploadPathNegotiation,
	verifiablePath,
	workerFetch
} from '../test-support.ts';

import { jsonValueLists } from './json-list.ts';
import { readableReferenceSelect } from './reuse-authority.ts';
import { setView } from './reuse-view-read.test-support.ts';

// A public pull-request cache receives the push. A pull request may publish
// the private cache's NARs there only if its token can read them.
const destination = namedCache('pr-builds');
const privateSource = namedCache('falcon');
const publicSource = namedCache('releases');
const privateView = 'falcon-view';

const contentReadOnPrivateSource = {
	type: 'cupboard_cache',
	actions: ['cache:content-read'],
	cache: privateSource
};
const contentReadOnPrivateView = {
	type: 'cupboard_view',
	actions: ['view:content-read'],
	view: privateView
};

// The fixture tenant's D1 rows persist across the tests in this file, so every
// test publishes a NAR and store paths of its own.
const counter = { next: 1 };

function writeGrantsWith(extra: readonly object[]): AuthorizationDetails {
	return authorizationDetailsSchema.parse([
		...cacheWriteGrants([], destination),
		...extra
	]);
}

/**
Publishes a fresh NAR under one store path in `holder` and returns metadata
for another store path with the same NAR.
*/
async function publishedIn(holder: CacheScope): Promise<UploadPathMetadata> {
	const index = counter.next;
	counter.next += 2;
	const owner = await initialiseViaWorker();
	const { metadata, nar } = await verifiablePath(
		`access-checked-reuse-${String(index)}`,
		{ storePathHash: syntheticStorePathHash(index) }
	);
	await pushPathToTenant(fixtureTenant, owner, metadata, nar, holder);

	return uploadMetadata({
		storePathHash: syntheticStorePathHash(index + 1),
		narHash: metadata.narHash,
		narSize: metadata.narSize,
		fileHash: metadata.fileHash,
		fileSize: metadata.fileSize
	});
}

function negotiation(
	token: string,
	metadata: UploadPathMetadata
): [string, RequestInit] {
	return [
		cacheScopedPath(destination, '/uploads'),
		{
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json'
			},
			body: JSON.stringify({
				pushId: testPushId,
				paths: [uploadPathNegotiation(metadata)]
			})
		}
	];
}

// The Worker prefetches negotiate hints before it dispatches the request. A
// request sent straight to the Durable Object has no hints.
async function negotiateThrough(
	route: 'worker' | 'object',
	token: string,
	metadata: UploadPathMetadata
) {
	const [path, init] = negotiation(token, metadata);
	const response =
		route === 'worker'
			? await handlerFetch(`/t/${fixtureTenant}${path}`, init)
			: await workerFetch(path, init);

	expect(response.status).toBe(StatusCodes.OK);

	return uploadNegotiateResponseSchema.parse(await response.json());
}

async function commitRefusal(
	token: string,
	uploadId: UploadId
): Promise<unknown> {
	try {
		await commitUploadViaWorker(token, uploadId, { cache: destination });
	} catch (error: unknown) {
		return error;
	}

	throw new Error('Expected the commit to be refused');
}

function expectCommitSocketError(
	error: unknown
): asserts error is CommitSocketError {
	expect(error).toBeInstanceOf(CommitSocketError);
}

describe('access-checked blob reuse', () => {
	beforeEach(async () => {
		await resetTestServer();
		await recordTransition('cache-identity', 'complete');

		const owner = await initialiseViaWorker();
		await putWorkerTestCache(owner, destination, 'public');
		await putWorkerTestCache(owner, privateSource, 'private');
		await putWorkerTestCache(owner, publicSource, 'public');
		await setView(
			[{ kind: 'named', name: privateSource.name }],
			privateView,
			'private'
		);
	});

	it('uploads a NAR that only an unreadable private cache references', async () => {
		const sibling = await publishedIn(privateSource);
		const token = await issueWorkerSignedToken(writeGrantsWith([]));

		const hinted = await negotiateThrough('worker', token, sibling);
		const direct = await negotiateThrough('object', token, sibling);
		const anonymousNar = await readFetch(
			cacheScopedPath(destination, `/${narObjectKey(sibling.narHash)}`)
		);

		expectSingleUploadDecision(hinted, sibling);
		expectSingleUploadDecision(direct, sibling);
		expect(anonymousNar.status).toBe(StatusCodes.NOT_FOUND);
	});

	it.each([
		{ source: 'the destination itself', holder: destination, extra: [] },
		{ source: 'a public cache', holder: publicSource, extra: [] },
		{
			source: 'a private cache that the token can read',
			holder: privateSource,
			extra: [contentReadOnPrivateSource]
		},
		{
			source: 'a private cache in a view that the token can read',
			holder: privateSource,
			extra: [contentReadOnPrivateView]
		}
	])('reuses a NAR referenced by $source', async ({ holder, extra }) => {
		const sibling = await publishedIn(holder);
		const token = await issueWorkerSignedToken(writeGrantsWith(extra));

		const direct = await negotiateThrough('object', token, sibling);
		expectSingleCommitDecision(direct, sibling);
		const decision = expectSingleCommitDecision(
			await negotiateThrough('worker', token, sibling),
			sibling
		);
		const committed = await commitUploadViaWorker(token, decision.uploadId, {
			cache: destination
		});

		expect(committed).toStrictEqual({
			storePathHash: sibling.storePathHash,
			narHash: sibling.narHash,
			status: 'committed'
		});
	});

	it('reuses a NAR that only a private cache references for a wildcard token', async () => {
		const sibling = await publishedIn(privateSource);
		const token = await issueWorkerSignedToken(adminGrants());

		expectSingleCommitDecision(
			await negotiateThrough('worker', token, sibling),
			sibling
		);
	});

	it('refuses a reuse commit after the authorising reference is removed', async () => {
		const sibling = await publishedIn(privateSource);
		const token = await issueWorkerSignedToken(
			writeGrantsWith([contentReadOnPrivateSource])
		);
		const decision = expectSingleCommitDecision(
			await negotiateThrough('worker', token, sibling),
			sibling
		);

		await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
			.delete(d1Schema.blobReference)
			.where(
				and(
					eq(d1Schema.blobReference.cacheName, privateSource.name),
					eq(d1Schema.blobReference.narHash, sibling.narHash)
				)
			)
			.run();

		const refusal = await commitRefusal(token, decision.uploadId);
		const references = await blobReferenceRows();

		expectCommitSocketError(refusal);
		expect({
			status: refusal.status,
			referencesToNar: references.filter(
				(reference) => reference.narHash === sibling.narHash
			)
		}).toStrictEqual({ status: StatusCodes.NOT_FOUND, referencesToNar: [] });
	});

	it('refuses a reuse commit after the source cache becomes private', async () => {
		const sibling = await publishedIn(publicSource);
		const token = await issueWorkerSignedToken(writeGrantsWith([]));
		const decision = expectSingleCommitDecision(
			await negotiateThrough('worker', token, sibling),
			sibling
		);

		await putWorkerTestCache(
			await initialiseViaWorker(),
			publicSource,
			'private'
		);

		const refusal = await commitRefusal(token, decision.uploadId);
		const references = await blobReferenceRows();

		expectCommitSocketError(refusal);
		expect({
			status: refusal.status,
			referencesToNar: references
				.filter((reference) => reference.narHash === sibling.narHash)
				.map((reference) => reference.cache)
		}).toStrictEqual({
			status: StatusCodes.NOT_FOUND,
			referencesToNar: [publicSource]
		});
	});
});

function byCacheName(
	left: Record<string, unknown>,
	right: Record<string, unknown>
): number {
	return String(left.cache_name).localeCompare(String(right.cache_name));
}

describe('readable reference select', () => {
	it('seeks one lifecycle row for each reference across ten named caches', async () => {
		const tenant = tenantIdSchema.parse('acme');
		const narHash = nixSha256HashSchema.parse(`sha256:${'1'.repeat(52)}`);
		const path = syntheticStorePathHash(1);
		// The default cache and ten named caches in `acme` and in `other`. The
		// even-numbered named caches are private, and `cache-1` was deleted and
		// created again.
		await env.CUPBOARD_DB.prepare(
			`WITH RECURSIVE source(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM source WHERE n < 10)
			 INSERT INTO cache_lifecycle_storage(tenant,cache_kind,cache_name,access,generation,updated_at)
			 SELECT owner.value, CASE n WHEN 0 THEN 'default' ELSE 'named' END, CASE n WHEN 0 THEN NULL ELSE 'cache-' || n END, CASE n % 2 WHEN 0 THEN 'private' ELSE 'public' END, CASE n WHEN 1 THEN 2 ELSE 1 END, '2026-01-01T00:00:00.000Z'
			 FROM source CROSS JOIN json_each('["acme","other"]') owner`
		).run();
		// Each cache has four generations of one path that refer to the NAR. The
		// first three are demoted.
		await env.CUPBOARD_DB.prepare(
			`WITH RECURSIVE source(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM source WHERE n < 4)
			 INSERT INTO blob_ref_storage(tenant,cache_kind,cache_name,store_path_hash,generation,nar_hash,cache_generation,readable)
			 SELECT tenant, cache_kind, cache_name, ?, n, ?, generation, n = 4 FROM cache_lifecycle_storage CROSS JOIN source`
		)
			.bind(path, narHash)
			.run();
		// A reference from the deleted first generation of `cache-1`.
		await env.CUPBOARD_DB.prepare(
			`INSERT INTO blob_ref_storage(tenant,cache_kind,cache_name,store_path_hash,generation,nar_hash,cache_generation) VALUES (?, 'named', 'cache-1', ?, 5, ?, 1)`
		)
			.bind(tenant, path, narHash)
			.run();
		await env.CUPBOARD_DB.prepare(
			`INSERT INTO tenant_blob(tenant,nar_hash,file_size) SELECT value, ?, 1 FROM json_each('["acme","other"]')`
		)
			.bind(narHash)
			.run();
		const [list] = jsonValueLists([narHash]);
		if (list === undefined) {
			throw new Error('The NAR list is empty.');
		}
		const query = readableReferenceSelect(
			drizzleD1(env.CUPBOARD_DB, { schema: d1Schema }),
			tenant,
			list
		).toSQL();

		const measured = await env.CUPBOARD_DB.prepare(query.sql)
			.bind(...query.params)
			.all();
		const plan = await env.CUPBOARD_DB.prepare(
			`EXPLAIN QUERY PLAN ${query.sql}`
		)
			.bind(...query.params)
			.all();

		expect({
			rows: measured.results
				.map((row) => ({ ...row, cache_name: row.cache_name ?? undefined }))
				.toSorted(byCacheName),
			read: measured.meta.rows_read,
			plan: plan.results.map((row) => row.detail)
		}).toStrictEqual({
			rows: Array.from({ length: 11 }, (_, n) => ({
				nar_hash: narHash,
				cache_kind: n === 0 ? 'default' : 'named',
				cache_name: n === 0 ? undefined : `cache-${String(n)}`,
				access: n % 2 === 0 ? 'private' : 'public'
			})).toSorted(byCacheName),
			read: 62,
			plan: [
				'SEARCH blob_ref_storage USING INDEX blob_ref_readable_nar_idx (tenant=? AND nar_hash=?)',
				'LIST SUBQUERY 1',
				'SCAN json_each VIRTUAL TABLE INDEX 1:',
				'CREATE BLOOM FILTER',
				'CORRELATED SCALAR SUBQUERY 2',
				'SEARCH path_read_revocation USING INDEX path_read_revocation_native_identity_idx (tenant=? AND cache_kind=? AND cache_name=? AND store_path_hash=?)',
				'SEARCH tenant_blob USING COVERING INDEX sqlite_autoindex_tenant_blob_1 (tenant=? AND nar_hash=?)',
				'SEARCH cache_lifecycle_storage USING INDEX cache_lifecycle_native_identity_idx (tenant=? AND cache_kind=? AND cache_name=?)',
				'USE TEMP B-TREE FOR GROUP BY'
			]
		});
	});
});
