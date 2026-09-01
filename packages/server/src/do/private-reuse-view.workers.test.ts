import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	cacheNameSchema,
	type CacheScope,
	nixSha256HashSchema,
	type NixSha256HashString,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { cacheAvailabilityResponseSchema } from '@cupboard/protocol/cache-availability';
import type { ReuseViewSelectorInput } from '@cupboard/protocol/reuse-views';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import {
	type TenantReadCredential,
	tenantReadCredentialSchema
} from '@cupboard/protocol/tenants';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import { setCacheReadCredential } from '../control/tenant-registry.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { narObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	fixtureWorkerServer,
	handlerFetch,
	namedCache,
	provisionFixtureTenant,
	readFetch,
	resetTestServer
} from '../test-support.ts';

import { committedPath, setView } from './reuse-view-read.test-support.ts';

const tenant = tenantIdSchema.parse(fixtureTenant);
const builds = cacheNameSchema.parse('builds');
const privateBuilds = namedCache(builds);
const publicBuilds = namedCache('public-builds');
const now = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');

// The tenant's own read credential. It is the only credential that opens a
// private view.
const tenantReader = { user: 'alice', password: 'secret' };

// One private cache's own credential. Generated passwords are exactly 43
// base64url characters, matching the control-plane schema.
const cacheReader: TenantReadCredential = tenantReadCredentialSchema.parse({
	user: 'reader',
	password: 'wRt2Qm7kZ9x1Yb4Nc6Vd8Fg0Hj3Kl5Mn7Pq9Rs1Tu23'
});

const privateViewName = 'private';
const privateViewPath = `/reuse/${privateViewName}`;

// The fixture tenant's Durable Object keeps its narinfo rows across the tests in
// this file, so every commit needs a store-path hash of its own.
const pathCounter = { next: 1 };

function nextStorePathHash(): string {
	const storePathHash = String(pathCounter.next).padStart(32, '0');
	pathCounter.next += 1;

	return storePathHash;
}

function basic(credential: {
	readonly user: string;
	readonly password: string;
}): RequestInit {
	return {
		headers: {
			authorization: `Basic ${btoa(`${credential.user}:${credential.password}`)}`
		}
	};
}

function withCredential(
	credential: { readonly user: string; readonly password: string },
	init: RequestInit = {}
): RequestInit {
	const headers = new Headers(init.headers);
	headers.set(
		'authorization',
		`Basic ${btoa(`${credential.user}:${credential.password}`)}`
	);

	return { ...init, headers };
}

function database() {
	return drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
}

// NAR object keys include the incarnation suffix from the second version
// onwards, so read the fixture's current incarnation from D1.
async function blobIncarnation(narHash: NixSha256HashString): Promise<number> {
	const row = await database()
		.select({ incarnation: d1Schema.blobState.incarnation })
		.from(d1Schema.blobState)
		.where(eq(d1Schema.blobState.narHash, narHash))
		.get();

	return row?.incarnation ?? 1;
}

function availabilityPost(storePathHash: string): RequestInit {
	return {
		body: JSON.stringify({ storePathHashes: [storePathHash] }),
		headers: { 'content-type': 'application/json' },
		method: 'POST'
	};
}

// Commits one path with a distinct NAR after explicitly provisioning its cache.
async function commitTo(
	cache: CacheScope,
	access: 'public' | 'private'
): Promise<string> {
	const storePathHash = nextStorePathHash();
	await committedPath(`reuse-private-${storePathHash}`, cache, {
		storePathHash,
		access
	});

	return storePathHash;
}

// A view definition outlives the Worker the harness creates for each test, so
// remove the definitions a previous test left behind.
async function forgetViews(): Promise<void> {
	await runInDurableObject(fixtureWorkerServer(), (instance) => {
		instance.context.db.delete(schema.reuseViewSelectors).run();
		instance.context.db.delete(schema.reuseViews).run();
	});
}

/**
 * Commits one store path to a private cache, defines a private view over every
 * private cache, and gives the tenant a read credential. The push authenticates
 * with its bearer token, so it runs before the credential exists.
 */
async function publishThroughPrivateView(): Promise<string> {
	const storePathHash = await commitTo(privateBuilds, 'private');
	await setView([{ kind: 'all' }], privateViewName, 'private');
	await provisionFixtureTenant({ read: tenantReader });

	return storePathHash;
}

describe('private reuse-view access', () => {
	beforeEach(async () => {
		await resetTestServer();
		await forgetViews();
	});

	it('requires the tenant credential on every content route and marks every response no-store', async () => {
		const storePathHash = await publishThroughPrivateView();
		const narInfoResponse = await readFetch(
			`${privateViewPath}/${storePathHash}.narinfo`,
			basic(tenantReader)
		);
		const narUrl = NarInfo.parse(await narInfoResponse.text()).url;
		const routes: readonly {
			name: string;
			path: string;
			init?: RequestInit;
			served: number;
		}[] = [
			{
				name: 'nix-cache-info',
				path: `${privateViewPath}/nix-cache-info`,
				served: StatusCodes.OK
			},
			{
				name: 'a narinfo',
				path: `${privateViewPath}/${storePathHash}.narinfo`,
				served: StatusCodes.OK
			},
			{
				name: 'a cache-availability report',
				path: `${privateViewPath}/api/v1/missing-paths`,
				init: availabilityPost(storePathHash),
				served: StatusCodes.OK
			},
			{
				name: 'the view NAR route',
				path: `${privateViewPath}/${narUrl}`,
				served: StatusCodes.OK
			}
		];

		const observed = await Promise.all(
			routes.map(async (route) => {
				const refused = await readFetch(route.path, route.init ?? {});
				const served = await readFetch(
					route.path,
					withCredential(tenantReader, route.init)
				);

				return {
					name: route.name,
					refusedStatus: refused.status,
					challenge: refused.headers.get('www-authenticate'),
					refusedControl: refused.headers.get('cache-control'),
					status: served.status,
					control: served.headers.get('cache-control')
				};
			})
		);

		expect(observed).toStrictEqual(
			routes.map((route) => ({
				name: route.name,
				refusedStatus: StatusCodes.UNAUTHORIZED,
				challenge: 'Basic realm="cupboard"',
				refusedControl: 'no-store',
				status: route.served,
				control: 'no-store'
			}))
		);
	});

	it.each(['/reuse', '/reuse/nonexistent/nix-cache-info'])(
		'returns 404 for an unresolved path at %s without using credentials',
		async (path) => {
			await publishThroughPrivateView();

			const anonymous = await readFetch(path, {});
			const authenticated = await readFetch(path, basic(tenantReader));

			expect({
				anonymous: anonymous.status,
				authenticated: authenticated.status,
				control: anonymous.headers.get('cache-control')
			}).toStrictEqual({
				anonymous: StatusCodes.NOT_FOUND,
				authenticated: StatusCodes.NOT_FOUND,
				control: 'no-store'
			});
		}
	);

	it('answers HEAD with the headers of the GET it re-dispatches', async () => {
		const storePathHash = await publishThroughPrivateView();
		const path = `${privateViewPath}/${storePathHash}.narinfo`;

		const refused = await readFetch(path, { method: 'HEAD' });
		const served = await readFetch(
			path,
			withCredential(tenantReader, { method: 'HEAD' })
		);
		const full = await readFetch(path, basic(tenantReader));
		const fullBody = await full.text();

		expect({
			refused: refused.status,
			status: served.status,
			control: served.headers.get('cache-control'),
			contentType: served.headers.get('content-type'),
			contentLength: served.headers.get('content-length'),
			body: await served.text()
		}).toStrictEqual({
			refused: StatusCodes.UNAUTHORIZED,
			status: StatusCodes.OK,
			control: 'no-store',
			contentType: 'text/x-nix-narinfo; charset=utf-8',
			contentLength: String(fullBody.length),
			body: ''
		});
	});

	it("opens a view to the tenant credential alone, whatever a source cache's own credential is", async () => {
		const storePathHash = await publishThroughPrivateView();
		await setCacheReadCredential(
			database(),
			tenant,
			namedCache(builds),
			cacheReader,
			now
		);
		const viewPath = `${privateViewPath}/${storePathHash}.narinfo`;
		const cachePath = `/cache/${builds}/${storePathHash}.narinfo`;

		const viewWithTenant = await readFetch(viewPath, basic(tenantReader));
		const viewWithCache = await readFetch(viewPath, basic(cacheReader));
		const cacheWithTenant = await readFetch(cachePath, basic(tenantReader));
		const cacheWithCache = await readFetch(cachePath, basic(cacheReader));

		expect({
			viewWithTenant: viewWithTenant.status,
			viewWithCache: viewWithCache.status,
			cacheWithTenant: cacheWithTenant.status,
			cacheWithCache: cacheWithCache.status
		}).toStrictEqual({
			viewWithTenant: StatusCodes.OK,
			viewWithCache: StatusCodes.UNAUTHORIZED,
			cacheWithTenant: StatusCodes.UNAUTHORIZED,
			cacheWithCache: StatusCodes.OK
		});
	});

	it('refuses a private view when the tenant has no read credential', async () => {
		const storePathHash = await commitTo(privateBuilds, 'private');
		await setView([{ kind: 'all' }], privateViewName, 'private');

		const response = await readFetch(
			`${privateViewPath}/${storePathHash}.narinfo`,
			basic(tenantReader)
		);

		expect(response.status).toBe(StatusCodes.UNAUTHORIZED);
	});

	const selectorCases: {
		readonly name: string;
		readonly selectors: ReuseViewSelectorInput[];
		readonly isPrivateServed: boolean;
	}[] = [
		{
			name: 'the all selector selects every private cache',
			selectors: [{ kind: 'all' }],
			isPrivateServed: true
		},
		{
			name: 'a named selector names a private cache',
			selectors: [{ kind: 'named', name: 'builds' }],
			isPrivateServed: true
		},
		{
			name: 'a prefix selector matches private local names',
			selectors: [{ kind: 'prefix', prefix: 'bu' }],
			isPrivateServed: true
		},
		{
			name: 'a named selector for another cache returns a miss',
			selectors: [{ kind: 'named', name: 'guides' }],
			isPrivateServed: false
		},
		{
			name: 'an unmatched private prefix returns a miss',
			selectors: [{ kind: 'prefix', prefix: 'gu' }],
			isPrivateServed: false
		}
	];

	it.each(selectorCases)(
		'resolves a private view at its stable URL: $name',
		async ({ selectors, isPrivateServed }) => {
			const privateHash = await commitTo(privateBuilds, 'private');
			const publicHash = await commitTo(publicBuilds, 'public');
			await setView(selectors, privateViewName, 'private');
			await provisionFixtureTenant({ read: tenantReader });

			const privateRead = await readFetch(
				`${privateViewPath}/${privateHash}.narinfo`,
				basic(tenantReader)
			);
			const publicRead = await readFetch(
				`${privateViewPath}/${publicHash}.narinfo`,
				basic(tenantReader)
			);

			expect({
				privateRead: privateRead.status,
				publicRead: publicRead.status
			}).toStrictEqual({
				privateRead: isPrivateServed ? StatusCodes.OK : StatusCodes.NOT_FOUND,
				publicRead: StatusCodes.NOT_FOUND
			});
		}
	);

	it('does not expose a private cache through a public view with an all selector', async () => {
		const privateHash = await commitTo(privateBuilds, 'private');
		const publicHash = await commitTo(publicBuilds, 'public');
		await setView([{ kind: 'all' }]);

		const privateRead = await readFetch(`/reuse/reuse/${privateHash}.narinfo`);
		const publicRead = await readFetch(`/reuse/reuse/${publicHash}.narinfo`);
		const availability = await readFetch(
			'/reuse/reuse/api/v1/missing-paths',
			availabilityPost(privateHash)
		);
		const body = cacheAvailabilityResponseSchema.parse(
			await availability.json()
		);

		expect({
			privateRead: privateRead.status,
			publicRead: publicRead.status,
			body
		}).toStrictEqual({
			privateRead: StatusCodes.NOT_FOUND,
			publicRead: StatusCodes.OK,
			body: { missingStorePathHashes: [privateHash] }
		});
	});

	it('does not authorise a view NAR through an unselected public cache', async () => {
		const excluded = await committedPath(
			'reuse-unselected-public',
			publicBuilds,
			{
				storePathHash: nextStorePathHash(),
				access: 'public'
			}
		);
		await committedPath('reuse-selected-public', namedCache('selected'), {
			storePathHash: nextStorePathHash(),
			access: 'public'
		});
		await setView([{ kind: 'named', name: cacheNameSchema.parse('selected') }]);
		const incarnation = await blobIncarnation(
			nixSha256HashSchema.parse(excluded.narHash)
		);
		const narPath = narObjectKey(
			nixSha256HashSchema.parse(excluded.narHash),
			incarnation
		);

		const response = await readFetch(`/reuse/reuse/${narPath}`);

		expect(response.status).toBe(StatusCodes.NOT_FOUND);
	});

	it('resolves each view by its name and stored access', async () => {
		await publishThroughPrivateView();
		await setView([{ kind: 'all' }], 'public');

		const privateView = await readFetch('/reuse/private/nix-cache-info');
		const privateAuthenticated = await readFetch(
			'/reuse/private/nix-cache-info',
			basic(tenantReader)
		);
		const publicView = await readFetch('/reuse/public/nix-cache-info');
		expect({
			private: privateView.status,
			privateAuthenticated: privateAuthenticated.status,
			public: publicView.status
		}).toStrictEqual({
			private: StatusCodes.UNAUTHORIZED,
			privateAuthenticated: StatusCodes.OK,
			public: StatusCodes.OK
		});
	});

	it('substitutes through a private view under the stable view route', async () => {
		const storePathHash = nextStorePathHash();
		const committed = await committedPath(
			`reuse-private-${storePathHash}`,
			privateBuilds,
			{ storePathHash, access: 'private' }
		);
		await setView([{ kind: 'all' }], privateViewName, 'private');
		await provisionFixtureTenant({ read: tenantReader });
		const narInfoPath = `/t/${tenant}${privateViewPath}/${storePathHash}.narinfo`;
		const narHash = nixSha256HashSchema.parse(committed.narHash);
		const narUrl = narObjectKey(narHash, await blobIncarnation(narHash));

		const narInfoResponse = await handlerFetch(
			narInfoPath,
			basic(tenantReader)
		);
		const narInfo = NarInfo.parse(await narInfoResponse.text());
		const narPath = new URL(narInfo.url, `https://cupboard.test${narInfoPath}`)
			.pathname;
		const served = await handlerFetch(narPath, basic(tenantReader));
		const narBytes = await served.arrayBuffer();
		const refused = await handlerFetch(narPath);
		const publicRoute = await handlerFetch(`/t/${tenant}/${narUrl}`);

		expect({
			narInfoStatus: narInfoResponse.status,
			url: narInfo.url,
			narPath,
			servedStatus: served.status,
			hasBytes: narBytes.byteLength > 0,
			refusedStatus: refused.status,
			publicRouteStatus: publicRoute.status
		}).toStrictEqual({
			narInfoStatus: StatusCodes.OK,
			url: narUrl,
			narPath: `/t/${tenant}${privateViewPath}/${narUrl}`,
			servedStatus: StatusCodes.OK,
			hasBytes: true,
			refusedStatus: StatusCodes.UNAUTHORIZED,
			publicRouteStatus: StatusCodes.NOT_FOUND
		});
	});

	it('selects a private default cache through the same scope model', async () => {
		const defaultCache: CacheScope = { kind: 'default' };
		const storePathHash = await commitTo(defaultCache, 'private');
		await setView([{ kind: 'default' }], privateViewName, 'private');
		await provisionFixtureTenant({
			defaultCacheAccess: 'private',
			read: tenantReader
		});

		const anonymous = await readFetch(
			`${privateViewPath}/${storePathHash}.narinfo`
		);
		const authenticated = await readFetch(
			`${privateViewPath}/${storePathHash}.narinfo`,
			basic(tenantReader)
		);

		expect({
			anonymous: anonymous.status,
			authenticated: authenticated.status
		}).toStrictEqual({
			anonymous: StatusCodes.UNAUTHORIZED,
			authenticated: StatusCodes.OK
		});
	});

	it('applies each view access independently of the default cache', async () => {
		const privateHash = await publishThroughPrivateView();
		const publicHash = await commitTo(publicBuilds, 'public');
		await setView([{ kind: 'all' }]);

		const publicServed = await readFetch(`/reuse/reuse/${publicHash}.narinfo`);
		const privateRefused = await readFetch(
			`${privateViewPath}/${privateHash}.narinfo`,
			{}
		);
		const privateServed = await readFetch(
			`${privateViewPath}/${privateHash}.narinfo`,
			basic(tenantReader)
		);

		expect({
			publicServed: publicServed.status,
			privateRefused: privateRefused.status,
			privateServed: privateServed.status,
			privateControl: privateServed.headers.get('cache-control')
		}).toStrictEqual({
			publicServed: StatusCodes.OK,
			privateRefused: StatusCodes.UNAUTHORIZED,
			privateServed: StatusCodes.OK,
			privateControl: 'no-store'
		});
	});
});
