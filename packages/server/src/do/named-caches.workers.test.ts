import { selectorForCache } from '@cupboard/nix/scalars';
import type { StatsResponse, UsageResponse } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import { narInfos } from '../db/schema.ts';
import { narInfoObjectKey, narObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	authorisedFetch,
	blobStateCount,
	bootstrap,
	cacheScopedPath,
	CommitSocketError,
	commitUpload,
	commitUploadRejection,
	mintServerSignedToken,
	narBytes,
	narHash,
	negotiateUploads,
	pushPath,
	putNarBytes,
	resetTestServer,
	singleDecision,
	testServerFor,
	uploadBlobMetadata,
	uploadMetadata,
	useTestServer
} from '../test-support.ts';

async function putRoot(
	token: string,
	cache: string,
	name: string,
	storePath: string
): Promise<void> {
	const response = await authorisedFetch(
		cacheScopedPath(cache, `/roots/${name}`),
		token,
		{
			body: JSON.stringify({ targets: [storePath] }),
			headers: { 'content-type': 'application/json' },
			method: 'PUT'
		}
	);

	expect(response.status).toBe(StatusCodes.OK);
}

async function statsForCache(
	token: string,
	cache: string
): Promise<StatsResponse> {
	const response = await authorisedFetch(
		`/cache/${selectorForCache(cache)}/stats`,
		token
	);

	expect(response.status).toBe(StatusCodes.OK);
	return response.json<StatsResponse>();
}

async function usageForTenant(token: string): Promise<UsageResponse> {
	const response = await authorisedFetch('/usage', token);

	expect(response.status).toBe(StatusCodes.OK);
	return response.json<UsageResponse>();
}

describe('named caches', () => {
	beforeEach(resetTestServer);

	it('materialises one path in two caches with a single shared blob', async () => {
		await useTestServer('named-cache-share');
		const init = await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		await pushPath(init.token, metadata);
		await pushPath(init.token, metadata, 'builds');

		const narinfoCaches = await runInDurableObject(
			testServerFor('named-cache-share'),
			(_instance, state) =>
				drizzle(state.storage, { schema: { narInfos } })
					.select({ cache: narInfos.cache })
					.from(narInfos)
					.orderBy(narInfos.cache)
					.all()
					.map((row) => row.cache)
		);
		const rows = { narinfoCaches, blobCount: await blobStateCount() };
		const defaultStats = await statsForCache(init.token, '');
		const buildsStats = await statsForCache(init.token, 'builds');
		const usage = await usageForTenant(init.token);
		const defaultObject = await env.BLOBS.head(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash)
		);
		const buildsObject = await env.BLOBS.head(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash, 'builds')
		);

		expect({
			narinfoCaches: rows.narinfoCaches,
			blobCount: rows.blobCount,
			defaultStats,
			buildsStats,
			usage,
			defaultObjectExists: defaultObject !== null,
			buildsObjectExists: buildsObject !== null
		}).toStrictEqual({
			narinfoCaches: ['', 'builds'],
			blobCount: 1,
			defaultStats: {
				storePaths: 1,
				narBlobs: 1,
				narFileSize: narBytes.byteLength,
				casObjects: 0,
				casFileSize: 0,
				pendingUploads: 0,
				totalFileSize: narBytes.byteLength
			},
			buildsStats: {
				storePaths: 1,
				narBlobs: 1,
				narFileSize: narBytes.byteLength,
				casObjects: 0,
				casFileSize: 0,
				pendingUploads: 0,
				totalFileSize: narBytes.byteLength
			},
			usage: {
				narBlobs: 1,
				narFileSize: narBytes.byteLength,
				casObjects: 0,
				casFileSize: 0,
				totalFileSize: narBytes.byteLength
			},
			defaultObjectExists: true,
			buildsObjectExists: true
		});
	});

	it('collects each cache independently while a shared NAR survives', async () => {
		await useTestServer('named-cache-gc');
		const init = await bootstrap();
		const kept = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'a'.repeat(32),
			name: 'kept'
		});
		const swept = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'b'.repeat(32),
			name: 'swept'
		});

		await pushPath(init.token, kept);
		await pushPath(init.token, swept);
		await pushPath(init.token, swept, 'builds');

		// The default cache retains `kept`, so `swept` is collectable there; the
		// builds cache retains `swept`, so the shared NAR stays referenced.
		await putRoot(init.token, '', 'channel', kept.storePath);
		await putRoot(init.token, 'builds', 'channel', swept.storePath);

		const gc = await authorisedFetch('/gc', init.token, { method: 'POST' });
		expect(gc.status).toBe(StatusCodes.OK);

		const sweptDefault = await env.BLOBS.head(
			narInfoObjectKey(fixtureTenant, swept.storePathHash)
		);
		const keptDefault = await env.BLOBS.head(
			narInfoObjectKey(fixtureTenant, kept.storePathHash)
		);
		const sweptBuilds = await env.BLOBS.head(
			narInfoObjectKey(fixtureTenant, swept.storePathHash, 'builds')
		);
		const sharedNar = await env.BLOBS.head(narObjectKey(narHash));

		expect({
			sweptFromDefault: sweptDefault === null,
			keptInDefault: keptDefault !== null,
			keptInBuilds: sweptBuilds !== null,
			sharedNarSurvives: sharedNar !== null
		}).toStrictEqual({
			sweptFromDefault: true,
			keptInDefault: true,
			keptInBuilds: true,
			sharedNarSurvives: true
		});
	});

	it('mirrors the per-route scope under a cache prefix', async () => {
		await useTestServer('named-cache-scope');
		await bootstrap();
		const admin = await mintServerSignedToken('admin', 'owner');
		// Activation gates on servability, so the target must be committed first.
		await pushPath(
			admin,
			uploadMetadata({
				fileSize: narBytes.byteLength,
				storePathHash: 'a'.repeat(32),
				name: 'x'
			}),
			'builds'
		);
		const writeToken = await mintServerSignedToken('write', 'ci', ['channel']);

		const rootPut = await authorisedFetch(
			'/cache/builds/roots/channel',
			writeToken,
			{
				body: JSON.stringify({ targets: [`/nix/store/${'a'.repeat(32)}-x`] }),
				headers: { 'content-type': 'application/json' },
				method: 'PUT'
			}
		);
		const rootList = await authorisedFetch('/cache/builds/roots', writeToken);
		const statsResponse = await authorisedFetch(
			'/cache/builds/stats',
			writeToken
		);
		const gc = await authorisedFetch('/cache/builds/gc', writeToken, {
			method: 'POST'
		});

		expect({
			write: rootPut.status,
			list: rootList.status,
			stats: statsResponse.status,
			gc: gc.status
		}).toStrictEqual({
			write: StatusCodes.OK,
			list: StatusCodes.FORBIDDEN,
			stats: StatusCodes.FORBIDDEN,
			gc: StatusCodes.FORBIDDEN
		});
	});

	it('authenticates before judging an invalid cache name', async () => {
		await useTestServer('named-cache-invalid');

		// The contract authenticates ahead of input validation, so a request
		// without a valid token learns nothing about the path's validity.
		const unauthenticated = await authorisedFetch(
			'/cache/Bad_NAME!/stats',
			'any-token'
		);
		const malformed = await authorisedFetch(
			'/cache/Bad_NAME!/stats',
			await mintServerSignedToken('admin')
		);

		expect({
			unauthenticated: unauthenticated.status,
			malformed: malformed.status
		}).toStrictEqual({
			unauthenticated: StatusCodes.UNAUTHORIZED,
			malformed: StatusCodes.BAD_REQUEST
		});
	});

	it('refuses to commit an upload under a different cache than negotiated', async () => {
		const init = await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const decision = singleDecision(
			await negotiateUploads(init.token, [metadata], 'builds')
		);

		if (decision.action !== 'upload') {
			throw new Error('expected an upload decision');
		}

		// Commit through the default cache: the pending row is bound to `builds`.
		const crossCommitError = await commitUploadRejection(
			init.token,
			decision.uploadId
		);

		// The same upload still completes through the cache it was negotiated under.
		await authorisedFetch(
			cacheScopedPath('builds', `/uploads/${decision.uploadId}`),
			init.token,
			{
				body: JSON.stringify(uploadBlobMetadata(metadata)),
				headers: { 'content-type': 'application/json' },
				method: 'PUT'
			}
		);
		await putNarBytes(decision.r2Key);
		const committed = await commitUpload(
			init.token,
			decision.uploadId,
			'builds'
		);
		const defaultStats = await statsForCache(init.token, '');
		const buildsStats = await statsForCache(init.token, 'builds');

		expect({
			crossCommit: crossCommitError,
			committed: committed.status,
			defaultPaths: defaultStats.storePaths,
			buildsPaths: buildsStats.storePaths
		}).toStrictEqual({
			crossCommit: new CommitSocketError(
				StatusCodes.BAD_REQUEST,
				'Upload prepared or committed under a different cache'
			),
			committed: 'committed',
			defaultPaths: 0,
			buildsPaths: 1
		});
	});

	it('refuses to prepare an upload under a different cache than negotiated', async () => {
		const init = await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const decision = singleDecision(
			await negotiateUploads(init.token, [metadata], 'builds')
		);

		if (decision.action !== 'upload') {
			throw new Error('expected an upload decision');
		}

		const prepare = await authorisedFetch(
			`/uploads/${decision.uploadId}`,
			init.token,
			{
				body: JSON.stringify(uploadBlobMetadata(metadata)),
				headers: { 'content-type': 'application/json' },
				method: 'PUT'
			}
		);

		expect(prepare.status).toBe(StatusCodes.BAD_REQUEST);
	});
});
