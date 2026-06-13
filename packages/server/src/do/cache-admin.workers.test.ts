import type {
	CacheListResponse,
	CacheRemoveResponse,
	CacheSummary
} from '@cupboard/protocol/caches';
import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import { narInfoObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	authorisedFetch,
	bootstrap,
	cacheScopedPath,
	issueServerSignedToken,
	narBytes,
	negotiateUploads,
	pushPath,
	putNarBytes,
	resetTestServer,
	singleDecision,
	uploadBlobMetadata,
	uploadMetadata,
	useTestServer
} from '../test-support.ts';

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
		await useTestServer('cache-admin-list');
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
		await useTestServer('cache-admin-delete');
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
			narInfoObjectKey(fixtureTenant, metadata.storePathHash, 'builds')
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
		await useTestServer('cache-admin-scope');
		await bootstrap();
		const writeToken = await issueServerSignedToken('write');

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
		await useTestServer('cache-admin-teardown-pending');
		const init = await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const decision = singleDecision(
			await negotiateUploads(init.token, [metadata], 'builds')
		);

		if (decision.action !== 'upload') {
			throw new Error('expected an upload decision');
		}

		const prepared = await authorisedFetch(
			cacheScopedPath('builds', `/uploads/${decision.uploadId}`),
			init.token,
			{
				body: JSON.stringify(uploadBlobMetadata(metadata)),
				headers: { 'content-type': 'application/json' },
				method: 'PUT'
			}
		);
		await putNarBytes(decision.r2Key);

		const stagedBefore = await env.BLOBS.head(decision.r2Key);
		const removed = await authorisedFetch('/caches/builds', init.token, {
			method: 'DELETE'
		});
		const stagedAfter = await env.BLOBS.head(decision.r2Key);

		// The pending upload is gone with the cache, so a late commit cannot
		// resurrect it.
		const commit = await authorisedFetch(
			cacheScopedPath('builds', `/uploads/${decision.uploadId}/commit`),
			init.token,
			{ method: 'POST' }
		);

		expect({
			prepared: prepared.status,
			stagedBefore: stagedBefore !== null,
			removed: removed.status,
			stagedAfter: stagedAfter === null,
			commit: commit.status
		}).toStrictEqual({
			prepared: StatusCodes.OK,
			stagedBefore: true,
			removed: StatusCodes.OK,
			stagedAfter: true,
			commit: StatusCodes.NOT_FOUND
		});
	});
});
