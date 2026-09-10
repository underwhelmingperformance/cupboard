import {
	CacheInfo,
	servedStoreDirectory
} from '@cupboard/nix-store/cache-info';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import { cachePrioritySchema } from '@cupboard/nix-store/scalars';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	initialiseViaWorker,
	namedCache,
	narBytes,
	provisionFixtureTenant,
	pushPathToTenant,
	putWorkerTestCache,
	readFetch,
	resetTestServer,
	uploadMetadata
} from '../test-support.ts';

function authorised(): RequestInit {
	return { headers: { authorization: `Basic ${btoa('alice:secret')}` } };
}

describe('named cache reads', () => {
	beforeEach(resetTestServer);

	it('serves a namespaced narinfo and the shared NAR through the Worker', async () => {
		const token = await initialiseViaWorker();
		await putWorkerTestCache(token, namedCache('builds'));
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await pushPathToTenant(
			fixtureTenant,
			token,
			metadata,
			undefined,
			namedCache('builds')
		);

		const narinfoResponse = await readFetch(
			`/cache/builds/${metadata.storePathHash}.narinfo`
		);
		const narinfo = NarInfo.parse(await narinfoResponse.text());
		const narResponse = await readFetch(`/cache/builds/${narinfo.url}`);
		const narBody = new Uint8Array(await narResponse.arrayBuffer());

		expect({
			narinfoStatus: narinfoResponse.status,
			storePath: narinfo.storePath.value,
			narStatus: narResponse.status,
			narBody: [...narBody]
		}).toStrictEqual({
			narinfoStatus: StatusCodes.OK,
			storePath: metadata.storePath,
			narStatus: StatusCodes.OK,
			narBody: [...narBytes]
		});
	});

	it('does not authorise one public cache with another public cache reference', async () => {
		const token = await initialiseViaWorker();
		await putWorkerTestCache(token, namedCache('builds'));
		await putWorkerTestCache(token, namedCache('guides'));
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await pushPathToTenant(
			fixtureTenant,
			token,
			metadata,
			undefined,
			namedCache('builds')
		);

		const narinfoResponse = await readFetch(
			`/cache/builds/${metadata.storePathHash}.narinfo`
		);
		const narUrl = NarInfo.parse(await narinfoResponse.text()).url;
		const builds = await readFetch(`/cache/builds/${narUrl}`);
		const guides = await readFetch(`/cache/guides/${narUrl}`);

		expect({ builds: builds.status, guides: guides.status }).toStrictEqual({
			builds: StatusCodes.OK,
			guides: StatusCodes.NOT_FOUND
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
		const token = await initialiseViaWorker();
		await putWorkerTestCache(token, namedCache('builds'), 'public', 30);

		const named = await readFetch('/cache/builds/nix-cache-info');
		const namedBody = await named.text();
		const bare = await readFetch('/nix-cache-info');
		const bareBody = await bare.text();
		const expectedNamedInfo = new CacheInfo(
			servedStoreDirectory,
			true,
			cachePrioritySchema.parse(30)
		);

		expect({ namedStatus: named.status, namedBody, bareBody }).toStrictEqual({
			namedStatus: StatusCodes.OK,
			namedBody: expectedNamedInfo.render(),
			bareBody: CacheInfo.default.render()
		});
	});

	it('renders the default cache priority from its registry row', async () => {
		const token = await initialiseViaWorker();
		await putWorkerTestCache(token, { kind: 'default' }, 'public', 30);

		const response = await readFetch('/nix-cache-info');
		const body = await response.text();
		const expected = new CacheInfo(
			servedStoreDirectory,
			true,
			cachePrioritySchema.parse(30)
		);

		expect({
			status: response.status,
			body,
			cacheControl: response.headers.get('cache-control')
		}).toStrictEqual({
			status: StatusCodes.OK,
			body: expected.render(),
			cacheControl: 'no-store'
		});
	});

	it('404s cache metadata for an absent named cache', async () => {
		await initialiseViaWorker();

		const response = await readFetch('/cache/missing/nix-cache-info');

		expect({
			status: response.status,
			cacheControl: response.headers.get('cache-control')
		}).toStrictEqual({
			status: StatusCodes.NOT_FOUND,
			cacheControl: 'no-store'
		});
	});

	it('gates named-cache reads in private mode', async () => {
		const token = await initialiseViaWorker();
		await putWorkerTestCache(token, namedCache('builds'), 'private');
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await pushPathToTenant(
			fixtureTenant,
			token,
			metadata,
			undefined,
			namedCache('builds')
		);
		await provisionFixtureTenant({
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
