import type {
	CacheListResponse,
	CacheRemoveResponse,
	CacheSummary
} from '@cupboard/shared';
import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import { narInfoObjectKey } from './http.ts';
import {
	authorisedFetch,
	bootstrap,
	cacheScopedPath,
	mintServerSignedToken,
	narBytes,
	negotiateUploads,
	pushPath,
	resetTestServer,
	singleDecision,
	uploadMetadata,
	useTestServer
} from './test-support.ts';

async function putCache(
	token: string,
	name: string,
	priority: number
): Promise<CacheSummary> {
	const response = await authorisedFetch(`/caches/${name}`, token, {
		body: JSON.stringify({ priority }),
		headers: { 'content-type': 'application/json' },
		method: 'PUT'
	});

	expect(response.status).toBe(StatusCodes.OK);

	return response.json<CacheSummary>();
}

async function listCaches(token: string): Promise<CacheListResponse> {
	const response = await authorisedFetch('/caches', token);

	expect(response.status).toBe(StatusCodes.OK);

	return response.json<CacheListResponse>();
}

describe('cache registry admin', () => {
	beforeEach(resetTestServer);

	it('lists registered caches with their priority and store-path count', async () => {
		useTestServer('cache-admin-list');
		const init = await bootstrap();
		await putCache(init.token, 'builds', 30);
		await pushPath(
			init.token,
			uploadMetadata({ fileSize: narBytes.byteLength }),
			'builds'
		);

		const { caches } = await listCaches(init.token);

		expect(caches).toStrictEqual([
			{ name: '', priority: 40, storePaths: 0 },
			{ name: 'builds', priority: 30, storePaths: 1 }
		]);
	});

	it('refuses to delete a non-empty cache without force, then force-tears it down', async () => {
		useTestServer('cache-admin-delete');
		const init = await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await pushPath(init.token, metadata, 'builds');

		const refused = await authorisedFetch('/caches/builds', init.token, {
			method: 'DELETE'
		});
		const forced = await authorisedFetch(
			'/caches/builds?force=true',
			init.token,
			{
				method: 'DELETE'
			}
		);
		const removed = await forced.json<CacheRemoveResponse>();
		const object = await env.BLOBS.head(
			narInfoObjectKey(metadata.storePathHash, 'builds')
		);
		const { caches } = await listCaches(init.token);

		expect({
			refusedStatus: refused.status,
			forcedStatus: forced.status,
			removed,
			objectGone: object === null,
			remainingNames: caches.map((cache) => cache.name)
		}).toStrictEqual({
			refusedStatus: StatusCodes.CONFLICT,
			forcedStatus: StatusCodes.OK,
			removed: { name: 'builds', removed: true, storePathsRemoved: 1 },
			objectGone: true,
			remainingNames: ['']
		});
	});

	it('requires admin scope for the registry routes', async () => {
		useTestServer('cache-admin-scope');
		await bootstrap();
		const writeToken = await mintServerSignedToken('write');

		const list = await authorisedFetch('/caches', writeToken);
		const put = await authorisedFetch('/caches/builds', writeToken, {
			body: JSON.stringify({ priority: 10 }),
			headers: { 'content-type': 'application/json' },
			method: 'PUT'
		});
		const remove = await authorisedFetch('/caches/builds', writeToken, {
			method: 'DELETE'
		});

		expect({
			list: list.status,
			put: put.status,
			remove: remove.status
		}).toStrictEqual({
			list: StatusCodes.FORBIDDEN,
			put: StatusCodes.FORBIDDEN,
			remove: StatusCodes.FORBIDDEN
		});
	});

	it('clears in-flight uploads negotiated under a cache it tears down', async () => {
		useTestServer('cache-admin-teardown-pending');
		const init = await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const decision = singleDecision(
			await negotiateUploads(init.token, [metadata], 'builds')
		);

		if (decision.action !== 'upload') {
			throw new Error('expected an upload decision');
		}

		const removed = await authorisedFetch('/caches/builds', init.token, {
			method: 'DELETE'
		});

		// The pending upload is gone with the cache, so a late commit cannot
		// resurrect it.
		const commit = await authorisedFetch(
			cacheScopedPath('builds', `/uploads/${decision.uploadId}/commit`),
			init.token,
			{ method: 'POST' }
		);

		expect({ removed: removed.status, commit: commit.status }).toStrictEqual({
			removed: StatusCodes.OK,
			commit: StatusCodes.NOT_FOUND
		});
	});
});
