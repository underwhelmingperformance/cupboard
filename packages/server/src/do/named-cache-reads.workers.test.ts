import { CacheInfo } from '@cupboard/nix/cache-info';
import { NarInfo } from '@cupboard/nix/narinfo';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	authorisedWorkerFetch,
	bootstrap,
	initialiseViaWorker,
	narBytes,
	provisionDefaultTenant,
	pushPath,
	readFetch,
	resetTestServer,
	uploadMetadata,
	useTestServer
} from '../test-support.ts';

function authorised(): RequestInit {
	return { headers: { authorization: `Basic ${btoa('alice:secret')}` } };
}

describe('named cache reads', () => {
	beforeEach(resetTestServer);

	it('serves a namespaced narinfo and the shared NAR through the Worker', async () => {
		const init = await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await pushPath(init.token, metadata, 'builds');

		const narinfoResponse = await readFetch(
			`/cache/builds/${metadata.storePathHash}.narinfo`
		);
		const narinfo = NarInfo.parse(await narinfoResponse.text());
		const narResponse = await readFetch(
			`/cache/builds/nar/${metadata.narHash}.nar.zst`
		);
		const narBody = new Uint8Array(await narResponse.arrayBuffer());

		expect({
			narinfoStatus: narinfoResponse.status,
			storePath: narinfo.storePath,
			narStatus: narResponse.status,
			narBody: [...narBody]
		}).toStrictEqual({
			narinfoStatus: StatusCodes.OK,
			storePath: metadata.storePath,
			narStatus: StatusCodes.OK,
			narBody: [...narBytes]
		});
	});

	it('returns the deployment key set under a cache prefix', async () => {
		await initialiseViaWorker();

		const bare = await readFetch('/pubkey');
		const bareBody = await bare.text();
		const scoped = await readFetch('/cache/builds/pubkey');
		const scopedBody = await scoped.text();

		expect({ scopedStatus: scoped.status, scopedBody }).toStrictEqual({
			scopedStatus: StatusCodes.OK,
			scopedBody: bareBody
		});
	});

	it('renders a named cache nix-cache-info from its registry priority', async () => {
		await useTestServer('named-cache-info');
		const token = await initialiseViaWorker();
		const put = await authorisedWorkerFetch('/caches/builds', token, {
			body: JSON.stringify({ priority: 30 }),
			headers: { 'content-type': 'application/json' },
			method: 'PUT'
		});
		expect(put.status).toBe(StatusCodes.OK);

		const named = await readFetch('/cache/builds/nix-cache-info');
		const namedBody = await named.text();
		const bare = await readFetch('/nix-cache-info');
		const bareBody = await bare.text();

		expect({ namedStatus: named.status, namedBody, bareBody }).toStrictEqual({
			namedStatus: StatusCodes.OK,
			namedBody: new CacheInfo('/nix/store', true, 30).render(),
			bareBody: CacheInfo.default.render()
		});
	});

	it('gates named-cache reads in private mode', async () => {
		const init = await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await pushPath(init.token, metadata, 'builds');
		await provisionDefaultTenant({
			readMode: 'private',
			read: { user: 'alice', password: 'secret' }
		});
		const narinfoPath = `/cache/builds/${metadata.storePathHash}.narinfo`;

		const unauthorised = await readFetch(narinfoPath, {});
		const authorisedResponse = await readFetch(narinfoPath, authorised());

		expect({
			unauthorised: unauthorised.status,
			authorised: authorisedResponse.status
		}).toStrictEqual({
			unauthorised: StatusCodes.UNAUTHORIZED,
			authorised: StatusCodes.OK
		});
	});

	it('404s a read under an invalid cache name', async () => {
		const response = await readFetch(
			`/cache/Bad_NAME!/${'a'.repeat(32)}.narinfo`
		);

		expect(response.status).toBe(StatusCodes.NOT_FOUND);
	});
});
