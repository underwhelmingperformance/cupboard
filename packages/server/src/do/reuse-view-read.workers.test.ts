import {
	CacheInfo,
	servedStoreDirectory
} from '@cupboard/nix-store/cache-info';
import { cachePrioritySchema } from '@cupboard/nix-store/scalars';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	adminGrants,
	authorisedWorkerFetch,
	handlerFetch,
	initialiseViaWorker,
	issueTokenForTenant,
	provisionFixtureTenant,
	provisionNamedTenant,
	readFetch,
	resetTestServer,
	testServerFor
} from '../test-support.ts';

function authorised(): RequestInit {
	return { headers: { authorization: `Basic ${btoa('alice:secret')}` } };
}

async function makePrivate(): Promise<void> {
	await provisionFixtureTenant({
		readMode: 'private',
		read: { user: 'alice', password: 'secret' }
	});
}

async function setView(name: string, priority: number): Promise<Response> {
	const token = await initialiseViaWorker();

	return authorisedWorkerFetch(
		`/reuse-views/${encodeURIComponent(name)}`,
		token,
		{
			body: JSON.stringify({
				selectors: [{ kind: 'prefix', pattern: '' }],
				priority
			}),
			headers: { 'content-type': 'application/json' },
			method: 'PUT'
		}
	);
}

describe('reuse-view nix-cache-info', () => {
	beforeEach(resetTestServer);

	it('renders the view nix-cache-info from its stored priority, always no-store', async () => {
		const set = await setView('reuse', 55);
		expect(set.status).toBe(StatusCodes.OK);

		const response = await readFetch('/reuse/reuse/nix-cache-info');
		const body = await response.text();

		expect({
			status: response.status,
			body,
			contentType: response.headers.get('content-type'),
			cacheControl: response.headers.get('cache-control')
		}).toStrictEqual({
			status: StatusCodes.OK,
			body: new CacheInfo(
				servedStoreDirectory,
				true,
				cachePrioritySchema.parse(55)
			).render(),
			contentType: 'text/x-nix-cache-info; charset=utf-8',
			cacheControl: 'no-store'
		});
	});

	it('answers HEAD with an empty body and the same headers as GET', async () => {
		await setView('reuse', 55);

		const fullResponse = await readFetch('/reuse/reuse/nix-cache-info');
		const fullBody = await fullResponse.text();
		const head = await readFetch('/reuse/reuse/nix-cache-info', {
			method: 'HEAD'
		});
		const headBody = await head.text();

		expect({
			headStatus: head.status,
			headBody,
			headContentType: head.headers.get('content-type'),
			headCacheControl: head.headers.get('cache-control'),
			headContentLength: head.headers.get('content-length'),
			fullContentLength: fullResponse.headers.get('content-length')
		}).toStrictEqual({
			headStatus: StatusCodes.OK,
			headBody: '',
			headContentType: 'text/x-nix-cache-info; charset=utf-8',
			headCacheControl: 'no-store',
			headContentLength: String(fullBody.length),
			fullContentLength: String(fullBody.length)
		});
	});

	it('404s an unknown view and a syntactically invalid view name, no-store', async () => {
		const unknown = await readFetch('/reuse/nonexistent/nix-cache-info');
		const invalid = await readFetch('/reuse/Bad_NAME!/nix-cache-info');

		// A cacheable negative answer would keep 404ing after the view is
		// created, so the misses are no-store like every other reuse response.
		expect({
			unknown: unknown.status,
			unknownCacheControl: unknown.headers.get('cache-control'),
			invalid: invalid.status,
			invalidCacheControl: invalid.headers.get('cache-control')
		}).toStrictEqual({
			unknown: StatusCodes.NOT_FOUND,
			unknownCacheControl: 'no-store',
			invalid: StatusCodes.NOT_FOUND,
			invalidCacheControl: 'no-store'
		});
	});

	it('gates a private tenant, serving no-store once authorised', async () => {
		await setView('reuse', 50);
		await makePrivate();

		const unauthorised = await readFetch('/reuse/reuse/nix-cache-info', {});
		const authorisedResponse = await readFetch(
			'/reuse/reuse/nix-cache-info',
			authorised()
		);

		expect({
			unauthorisedStatus: unauthorised.status,
			authorisedStatus: authorisedResponse.status,
			authorisedControl: authorisedResponse.headers.get('cache-control')
		}).toStrictEqual({
			unauthorisedStatus: StatusCodes.UNAUTHORIZED,
			authorisedStatus: StatusCodes.OK,
			authorisedControl: 'no-store'
		});
	});

	it('gates every other path under a private tenant reuse subtree', async () => {
		await setView('reuse', 50);
		await makePrivate();

		const response = await readFetch('/reuse/reuse/anything', {});

		expect(response.status).toBe(StatusCodes.UNAUTHORIZED);
	});

	it('404s every unimplemented path under a public tenant reuse subtree, no-store', async () => {
		await setView('reuse', 50);

		const narPath = await readFetch('/reuse/reuse/nar/whatever.nar.zst');
		const arbitrary = await readFetch('/reuse/reuse/some/other/path');

		// Like every reuse response, the catch-all 404 must never be cached: a
		// stored negative answer would outlive a deploy that adds the route.
		expect({
			narPath: narPath.status,
			narPathCacheControl: narPath.headers.get('cache-control'),
			arbitrary: arbitrary.status,
			arbitraryCacheControl: arbitrary.headers.get('cache-control')
		}).toStrictEqual({
			narPath: StatusCodes.NOT_FOUND,
			narPathCacheControl: 'no-store',
			arbitrary: StatusCodes.NOT_FOUND,
			arbitraryCacheControl: 'no-store'
		});
	});

	it('404s a view defined on one tenant under a different tenant path', async () => {
		const ownerIssuer = await provisionNamedTenant('acme');
		const ownerToken = await issueTokenForTenant(
			testServerFor('acme'),
			ownerIssuer,
			adminGrants()
		);
		await provisionNamedTenant('mallory');

		const put = await handlerFetch('/t/acme/reuse-views/reuse', {
			body: JSON.stringify({
				selectors: [{ kind: 'prefix', pattern: '' }],
				priority: 55
			}),
			headers: {
				authorization: `Bearer ${ownerToken}`,
				'content-type': 'application/json'
			},
			method: 'PUT'
		});
		expect(put.status).toBe(StatusCodes.OK);

		const ownerGet = await handlerFetch('/t/acme/reuse/reuse/nix-cache-info');
		const intruderGet = await handlerFetch(
			'/t/mallory/reuse/reuse/nix-cache-info'
		);

		expect({
			ownerGet: ownerGet.status,
			intruderGet: intruderGet.status
		}).toStrictEqual({
			ownerGet: StatusCodes.OK,
			intruderGet: StatusCodes.NOT_FOUND
		});
	});

	it('leaves the ordinary per-cache nix-cache-info route unaffected', async () => {
		const response = await readFetch('/nix-cache-info');

		expect(response.status).toBe(StatusCodes.OK);
	});
});
