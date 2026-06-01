import type { StatsResponse } from '@cupboard/shared';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { count } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import { narBlobs, narInfos } from './db/schema.ts';
import { narInfoObjectKey, narObjectKey } from './http.ts';
import {
	authorisedFetch,
	bootstrap,
	cacheScopedPath,
	mintServerSignedToken,
	narBytes,
	narHash,
	pushPath,
	resetTestServer,
	testServerFor,
	uploadMetadata,
	useTestServer
} from './test-support.ts';

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

async function storePathCount(token: string, cache: string): Promise<number> {
	const response = await authorisedFetch(
		cacheScopedPath(cache, '/stats'),
		token
	);
	const body = await response.json<StatsResponse>();

	return body.storePaths;
}

describe('named caches', () => {
	beforeEach(resetTestServer);

	it('materialises one path in two caches with a single shared blob', async () => {
		useTestServer('named-cache-share');
		const init = await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		await pushPath(init.token, metadata);
		await pushPath(init.token, metadata, 'builds');

		const rows = await runInDurableObject(
			testServerFor('named-cache-share'),
			(_instance, state) => {
				const database = drizzle(state.storage, {
					schema: { narBlobs, narInfos }
				});

				return {
					narinfoCaches: database
						.select({ cache: narInfos.cache })
						.from(narInfos)
						.orderBy(narInfos.cache)
						.all()
						.map((row) => row.cache),
					blobCount:
						database.select({ count: count() }).from(narBlobs).all()[0]
							?.count ?? 0
				};
			}
		);
		const defaultStorePaths = await storePathCount(init.token, '');
		const buildsStorePaths = await storePathCount(init.token, 'builds');
		const defaultObject = await env.BLOBS.head(
			narInfoObjectKey(metadata.storePathHash)
		);
		const buildsObject = await env.BLOBS.head(
			narInfoObjectKey(metadata.storePathHash, 'builds')
		);

		expect({
			narinfoCaches: rows.narinfoCaches,
			blobCount: rows.blobCount,
			defaultStorePaths,
			buildsStorePaths,
			defaultObjectExists: defaultObject !== null,
			buildsObjectExists: buildsObject !== null
		}).toStrictEqual({
			narinfoCaches: ['', 'builds'],
			blobCount: 1,
			defaultStorePaths: 1,
			buildsStorePaths: 1,
			defaultObjectExists: true,
			buildsObjectExists: true
		});
	});

	it('collects each cache independently while a shared NAR survives', async () => {
		useTestServer('named-cache-gc');
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
			narInfoObjectKey(swept.storePathHash)
		);
		const keptDefault = await env.BLOBS.head(
			narInfoObjectKey(kept.storePathHash)
		);
		const sweptBuilds = await env.BLOBS.head(
			narInfoObjectKey(swept.storePathHash, 'builds')
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
		useTestServer('named-cache-scope');
		await bootstrap();
		const writeToken = await mintServerSignedToken('write');

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

	it('rejects an invalid cache name before authorising', async () => {
		useTestServer('named-cache-invalid');

		// The name is validated in the routing layer ahead of the scope check, so
		// a malformed cache name is a 400 regardless of the bearer token.
		const response = await authorisedFetch(
			'/cache/Bad_NAME!/stats',
			'any-token'
		);

		expect(response.status).toBe(StatusCodes.BAD_REQUEST);
	});
});
