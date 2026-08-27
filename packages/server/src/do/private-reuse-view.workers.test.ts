import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	cacheNameSchema,
	nixSha256HashSchema,
	type NixSha256HashString,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { cacheAvailabilityResponseSchema } from '@cupboard/protocol/cache-availability';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import {
	type ParsedTenantReadCredential,
	tenantReadCredentialSchema
} from '@cupboard/protocol/tenants';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { setCacheReadCredential } from '../control/tenant-registry.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { narObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	authorisedWorkerFetch,
	fixtureWorkerServer,
	handlerFetch,
	initialiseViaWorker,
	provisionFixtureTenant,
	readFetch,
	resetTestServer
} from '../test-support.ts';

import { committedPath, setView } from './reuse-view-read.test-support.ts';

const tenant = tenantIdSchema.parse(fixtureTenant);
const builds = cacheNameSchema.parse('builds');
const privateBuilds = `_private-${builds}`;
const now = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');

// The tenant's own read credential. It is the only credential that opens a
// private view.
const tenantReader = { user: 'alice', password: 'secret' };

// One private cache's own credential. Generated passwords are exactly 43
// base64url characters, matching the control-plane schema.
const cacheReader: ParsedTenantReadCredential =
	tenantReadCredentialSchema.parse({
		user: 'reader',
		password: 'wRt2Qm7kZ9x1Yb4Nc6Vd8Fg0Hj3Kl5Mn7Pq9Rs1Tu23'
	});

const privateViewName = '_private-reuse';
const privateViewPath = '/private-reuse/reuse';

const orpcErrorBodySchema = z.strictObject({
	defined: z.boolean(),
	code: z.string(),
	status: z.number(),
	message: z.string(),
	data: z.unknown().optional()
});

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

// Commits one path with a distinct NAR to the named cache and returns its
// store-path hash.
async function commitTo(cache: string): Promise<string> {
	const storePathHash = nextStorePathHash();
	await committedPath(`private-reuse-${storePathHash}`, cache, {
		storePathHash
	});

	return storePathHash;
}

async function setViewRaw(name: string, body: unknown): Promise<Response> {
	const token = await initialiseViaWorker();

	return authorisedWorkerFetch(
		`/reuse-views/${encodeURIComponent(name)}`,
		token,
		{
			body: JSON.stringify(body),
			headers: { 'content-type': 'application/json' },
			method: 'PUT'
		}
	);
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
	const storePathHash = await commitTo(privateBuilds);
	await setView([{ kind: 'prefix', pattern: '' }], privateViewName);
	await provisionFixtureTenant({ read: tenantReader });

	return storePathHash;
}

describe('private reuse views', () => {
	beforeEach(async () => {
		await resetTestServer();
		await forgetViews();
	});

	it('requires the tenant credential on every route and marks every response no-store', async () => {
		const storePathHash = await publishThroughPrivateView();
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
				name: 'an unserved path',
				path: `${privateViewPath}/nar/whatever.nar.zst`,
				served: StatusCodes.NOT_FOUND
			},
			{
				name: 'an unknown view',
				path: '/private-reuse/nonexistent/nix-cache-info',
				served: StatusCodes.NOT_FOUND
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

	it('refuses the namespace root whether or not a credential is offered', async () => {
		await publishThroughPrivateView();

		const anonymous = await readFetch('/private-reuse', {});
		const authenticated = await readFetch(
			'/private-reuse',
			basic(tenantReader)
		);

		expect({
			anonymous: anonymous.status,
			authenticated: authenticated.status,
			control: anonymous.headers.get('cache-control')
		}).toStrictEqual({
			anonymous: StatusCodes.UNAUTHORIZED,
			authenticated: StatusCodes.UNAUTHORIZED,
			control: 'no-store'
		});
	});

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
		await setCacheReadCredential(database(), tenant, builds, cacheReader, now);
		const viewPath = `${privateViewPath}/${storePathHash}.narinfo`;
		const cachePath = `/private-cache/${builds}/${storePathHash}.narinfo`;

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
		const storePathHash = await commitTo(privateBuilds);
		await setView([{ kind: 'prefix', pattern: '' }], privateViewName);

		const response = await readFetch(
			`${privateViewPath}/${storePathHash}.narinfo`,
			basic(tenantReader)
		);

		expect(response.status).toBe(StatusCodes.UNAUTHORIZED);
	});

	it.each([
		{
			name: 'the empty prefix selects every private cache',
			selectors: [{ kind: 'prefix' as const, pattern: '' }],
			isPrivateServed: true
		},
		{
			name: 'an exact selector names a private cache',
			selectors: [{ kind: 'exact' as const, pattern: 'builds' }],
			isPrivateServed: true
		},
		{
			name: 'a prefix selector matches private local names',
			selectors: [{ kind: 'prefix' as const, pattern: 'bu' }],
			isPrivateServed: true
		},
		{
			name: 'an exact selector for another cache returns a miss',
			selectors: [{ kind: 'exact' as const, pattern: 'guides' }],
			isPrivateServed: false
		},
		{
			name: 'an unmatched private prefix returns a miss',
			selectors: [{ kind: 'prefix' as const, pattern: 'gu' }],
			isPrivateServed: false
		}
	])(
		'resolves inside the private namespace: $name',
		async ({ selectors, isPrivateServed }) => {
			const privateHash = await commitTo(privateBuilds);
			const publicHash = await commitTo(builds);
			await setView(selectors, privateViewName);
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

	it('does not expose a private cache through a public view with an empty-prefix selector', async () => {
		const privateHash = await commitTo(privateBuilds);
		const publicHash = await commitTo(builds);
		await setView([{ kind: 'prefix', pattern: '' }]);

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

	it('serves a view only under the namespace of its name', async () => {
		await publishThroughPrivateView();
		await setView([{ kind: 'prefix', pattern: '' }], 'public');

		const privateUnderPublic = await readFetch('/reuse/reuse/nix-cache-info');
		const publicUnderPrivate = await readFetch(
			'/private-reuse/public/nix-cache-info',
			basic(tenantReader)
		);
		// A view's local name has no slash, so the public prefix cannot address a
		// stored private name by encoding one.
		const storedNameUnderPublic = await readFetch(
			'/reuse/private%2Freuse/nix-cache-info'
		);

		expect({
			privateUnderPublic: privateUnderPublic.status,
			publicUnderPrivate: publicUnderPrivate.status,
			storedNameUnderPublic: storedNameUnderPublic.status
		}).toStrictEqual({
			privateUnderPublic: StatusCodes.NOT_FOUND,
			publicUnderPrivate: StatusCodes.NOT_FOUND,
			storedNameUnderPublic: StatusCodes.NOT_FOUND
		});
	});

	it('substitutes through a private view under the view namespace alone', async () => {
		const storePathHash = nextStorePathHash();
		const committed = await committedPath(
			`private-reuse-${storePathHash}`,
			privateBuilds,
			{ storePathHash }
		);
		await setView([{ kind: 'prefix', pattern: '' }], privateViewName);
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

	it('refuses an exact selector for the default cache in a private view', async () => {
		const selectors = [{ kind: 'exact', pattern: '_default' }];

		const refused = await setViewRaw(privateViewName, { selectors });
		const errorBody = orpcErrorBodySchema.parse(await refused.json());
		const accepted = await setViewRaw('reuse', { selectors });

		expect({
			refusedStatus: refused.status,
			code: errorBody.code,
			defined: errorBody.defined,
			data: errorBody.data,
			acceptedStatus: accepted.status
		}).toStrictEqual({
			refusedStatus: StatusCodes.BAD_REQUEST,
			code: 'PRIVATE_VIEW_DEFAULT_SELECTOR',
			defined: true,
			data: { view: privateViewName },
			acceptedStatus: StatusCodes.OK
		});
	});

	it('keeps a private tenant gated on both view namespaces', async () => {
		const storePathHash = await publishThroughPrivateView();
		await setView([{ kind: 'prefix', pattern: '' }]);
		await provisionFixtureTenant({ readMode: 'private', read: tenantReader });

		const publicRefused = await readFetch('/reuse/reuse/nix-cache-info', {});
		const publicServed = await readFetch(
			'/reuse/reuse/nix-cache-info',
			basic(tenantReader)
		);
		const privateRefused = await readFetch(
			`${privateViewPath}/${storePathHash}.narinfo`,
			{}
		);
		const privateServed = await readFetch(
			`${privateViewPath}/${storePathHash}.narinfo`,
			basic(tenantReader)
		);

		expect({
			publicRefused: publicRefused.status,
			publicServed: publicServed.status,
			privateRefused: privateRefused.status,
			privateServed: privateServed.status,
			privateControl: privateServed.headers.get('cache-control')
		}).toStrictEqual({
			publicRefused: StatusCodes.UNAUTHORIZED,
			publicServed: StatusCodes.OK,
			privateRefused: StatusCodes.UNAUTHORIZED,
			privateServed: StatusCodes.OK,
			privateControl: 'no-store'
		});
	});
});
