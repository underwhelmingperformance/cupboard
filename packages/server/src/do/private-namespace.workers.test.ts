import {
	CacheInfo,
	servedStoreDirectory
} from '@cupboard/nix-store/cache-info';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	cacheNameSchema,
	cachePrioritySchema,
	privateStoredCache,
	type Sha256HexDigest,
	sha256HexDigestSchema,
	type StorePathHash,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import {
	attestationNegotiateResponseSchema,
	attestationUploadDecisionSchema
} from '@cupboard/protocol/attestations';
import { cacheAvailabilityResponseSchema } from '@cupboard/protocol/cache-availability';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import {
	type ParsedTenantReadCredential,
	tenantReadCredentialSchema
} from '@cupboard/protocol/tenants';
import { env } from 'cloudflare:workers';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	clearCacheReadCredential,
	setCacheReadCredential
} from '../control/tenant-registry.ts';
import { sha256HexBytes } from '../crypto/crypto.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	authorisedWorkerFetch,
	handlerFetch,
	hexBytes,
	initialiseViaWorker,
	narDigestHex,
	narHash,
	provisionFixtureTenant,
	pushPathToTenant,
	readFetch,
	resetTestServer,
	sigstoreBundleBytes,
	testPushId,
	uploadMetadata,
	uploadPathNegotiation
} from '../test-support.ts';

const localName = cacheNameSchema.parse('builds');
const sibling = cacheNameSchema.parse('guides');
const privateSelector = `_private-${localName}`;
const privatePrefix = `/private-cache/${localName}`;
const tenant = tenantIdSchema.parse(fixtureTenant);
const now = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');

// The tenant's own read credential. A public tenant can hold one: it opens the
// private namespace without gating the public routes.
const tenantReader = { user: 'alice', password: 'secret' };

// One private cache's own credential. Generated passwords are exactly 43
// base64url characters, matching the control-plane schema.
const cacheReader: ParsedTenantReadCredential =
	tenantReadCredentialSchema.parse({
		user: 'reader',
		password: 'wRt2Qm7kZ9x1Yb4Nc6Vd8Fg0Hj3Kl5Mn7Pq9Rs1Tu23'
	});

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

function cacheCredentialRows(): Promise<{ tenant: string; cache: string }[]> {
	return database()
		.select({
			tenant: d1Schema.tenantCacheReadCredential.tenant,
			cache: d1Schema.tenantCacheReadCredential.cache
		})
		.from(d1Schema.tenantCacheReadCredential)
		.all();
}

const cacheNameRowSchema = z.object({ name: z.string() });
const cacheNamesSchema = z.object({ caches: z.array(cacheNameRowSchema) });

const availabilityPost = (storePathHash: StorePathHash): RequestInit => ({
	body: JSON.stringify({ storePathHashes: [storePathHash] }),
	headers: { 'content-type': 'application/json' },
	method: 'POST'
});

interface PublishedPath {
	readonly token: string;
	readonly storePathHash: StorePathHash;
	readonly narUrl: string;
	readonly bundleDigest: Sha256HexDigest;
}

/**
 * Publishes one store path and one attestation bundle to the private cache
 * through the routes a real push uses, then gives the tenant a read credential.
 * The push authenticates with its bearer token, so it runs before the read
 * credential exists.
 */
async function publishToPrivateCache(): Promise<PublishedPath> {
	const token = await initialiseViaWorker();
	const metadata = uploadMetadata({ fileSize: 1234 });
	await pushPathToTenant(tenant, token, metadata, undefined, privateSelector);
	const bundleDigest = await attachBundle(token, metadata.storePathHash);
	await provisionFixtureTenant({ read: tenantReader });

	const narinfo = await readFetch(
		`${privatePrefix}/${metadata.storePathHash}.narinfo`,
		basic(tenantReader)
	);
	expect(narinfo.status).toBe(StatusCodes.OK);

	return {
		token,
		storePathHash: metadata.storePathHash,
		narUrl: NarInfo.parse(await narinfo.text()).url,
		bundleDigest
	};
}

// Negotiates, uploads and attaches one attestation bundle for the private
// cache. Writes address a cache by selector, so this is the private cache's
// write surface rather than its read namespace.
async function attachBundle(
	token: string,
	storePathHash: StorePathHash
): Promise<Sha256HexDigest> {
	const bundle = sigstoreBundleBytes(narDigestHex(narHash));
	const digest = sha256HexDigestSchema.parse(await sha256HexBytes(bundle));
	const negotiated = await authorisedWorkerFetch(
		`/cache/${privateSelector}/attestations`,
		token,
		{
			body: JSON.stringify({
				pushId: testPushId,
				bundles: [{ storePathHash, digest }]
			}),
			headers: { 'content-type': 'application/json' },
			method: 'POST'
		}
	);
	expect(negotiated.status).toBe(StatusCodes.OK);
	const body = attestationNegotiateResponseSchema.parse(
		await negotiated.json()
	);
	const [decision] = z
		.tuple([attestationUploadDecisionSchema])
		.parse(body.bundles);
	await env.BLOBS.put(decision.r2Key, bundle, { sha256: hexBytes(digest) });

	const attached = await authorisedWorkerFetch(
		`/cache/${privateSelector}/attestations/${decision.uploadId}/attach`,
		token,
		{ method: 'POST' }
	);
	expect(attached.status).toBe(StatusCodes.OK);

	return digest;
}

describe('private cache namespace', () => {
	beforeEach(resetTestServer);

	it('requires a credential for every route and marks every response no-store', async () => {
		const published = await publishToPrivateCache();
		const routes: readonly {
			name: string;
			suffix: string;
			init?: RequestInit;
		}[] = [
			{ name: 'nix-cache-info', suffix: '/nix-cache-info' },
			{
				name: 'a narinfo',
				suffix: `/${published.storePathHash}.narinfo`
			},
			{ name: 'a NAR', suffix: `/${published.narUrl}` },
			{ name: 'the key set', suffix: '/pubkey' },
			{
				name: 'an attestation list',
				suffix: `/attestations/${published.storePathHash}`
			},
			{
				name: 'an attestation bundle',
				suffix: `/attestation-bundles/${published.bundleDigest}`
			},
			{
				name: 'a cache-availability report',
				suffix: '/api/v1/missing-paths',
				init: availabilityPost(published.storePathHash)
			}
		];

		const observed = await Promise.all(
			routes.map(async (route) => {
				const path = `${privatePrefix}${route.suffix}`;
				const refused = await readFetch(path, route.init ?? {});
				const served = await readFetch(
					path,
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
				status: StatusCodes.OK,
				control: 'no-store'
			}))
		);
	});

	it('serves HEAD for a narinfo in the addressed private cache', async () => {
		const published = await publishToPrivateCache();
		const path = `${privatePrefix}/${published.storePathHash}.narinfo`;

		const refused = await readFetch(path, { method: 'HEAD' });
		const served = await readFetch(
			path,
			withCredential(tenantReader, { method: 'HEAD' })
		);

		expect({
			refused: refused.status,
			status: served.status,
			control: served.headers.get('cache-control'),
			body: await served.text()
		}).toStrictEqual({
			refused: StatusCodes.UNAUTHORIZED,
			status: StatusCodes.OK,
			control: 'no-store',
			body: ''
		});
	});

	it('reads the cache the namespace prefix names, not the default cache', async () => {
		const published = await publishToPrivateCache();
		const put = await authorisedWorkerFetch(
			`/caches/${privateSelector}`,
			published.token,
			{
				body: JSON.stringify({ priority: 30 }),
				headers: { 'content-type': 'application/json' },
				method: 'PUT'
			}
		);
		expect(put.status).toBe(StatusCodes.OK);

		const cacheInfo = await readFetch(
			`${privatePrefix}/nix-cache-info`,
			basic(tenantReader)
		);
		const availability = await readFetch(
			`${privatePrefix}/api/v1/missing-paths`,
			withCredential(tenantReader, availabilityPost(published.storePathHash))
		);

		expect({
			cacheInfo: await cacheInfo.text(),
			availability: cacheAvailabilityResponseSchema.parse(
				await availability.json()
			)
		}).toStrictEqual({
			cacheInfo: new CacheInfo(
				servedStoreDirectory,
				true,
				cachePrioritySchema.parse(30)
			).render(),
			availability: { missingStorePathHashes: [] }
		});
	});

	it("lets only a cache's own credential open it once it has one", async () => {
		const published = await publishToPrivateCache();
		await pushPathToTenant(
			tenant,
			published.token,
			uploadMetadata({ fileSize: 1234, storePathHash: 'a'.repeat(32) }),
			undefined,
			`_private-${sibling}`
		);
		await setCacheReadCredential(
			database(),
			tenant,
			localName,
			cacheReader,
			now
		);
		const path = `${privatePrefix}/${published.storePathHash}.narinfo`;
		const siblingPath = `/private-cache/${sibling}/nix-cache-info`;

		const exclusiveTenant = await readFetch(path, basic(tenantReader));
		const exclusiveCache = await readFetch(path, basic(cacheReader));
		const exclusiveSibling = await readFetch(siblingPath, basic(tenantReader));
		const exclusive = {
			withTenantCredential: exclusiveTenant.status,
			withCacheCredential: exclusiveCache.status,
			siblingWithTenantCredential: exclusiveSibling.status
		};

		await clearCacheReadCredential(database(), tenant, localName);
		const restoredTenant = await readFetch(path, basic(tenantReader));
		const restoredCache = await readFetch(path, basic(cacheReader));
		const restored = {
			withTenantCredential: restoredTenant.status,
			withCacheCredential: restoredCache.status
		};

		expect({ exclusive, restored }).toStrictEqual({
			exclusive: {
				withTenantCredential: StatusCodes.UNAUTHORIZED,
				withCacheCredential: StatusCodes.OK,
				siblingWithTenantCredential: StatusCodes.OK
			},
			restored: {
				withTenantCredential: StatusCodes.OK,
				withCacheCredential: StatusCodes.UNAUTHORIZED
			}
		});
	});

	it('refuses the namespace when neither the cache nor the tenant has a credential', async () => {
		const token = await initialiseViaWorker();
		const metadata = uploadMetadata({ fileSize: 1234 });
		await pushPathToTenant(tenant, token, metadata, undefined, privateSelector);

		const response = await readFetch(
			`${privatePrefix}/${metadata.storePathHash}.narinfo`,
			basic(tenantReader)
		);

		expect(response.status).toBe(StatusCodes.UNAUTHORIZED);
	});

	it('keeps a private path and its NAR out of the public namespace', async () => {
		const published = await publishToPrivateCache();

		const availability = await readFetch(
			'/api/v1/missing-paths',
			availabilityPost(published.storePathHash)
		);
		const defaultAvailability = await readFetch(
			'/cache/_default/api/v1/missing-paths',
			availabilityPost(published.storePathHash)
		);
		const narinfo = await readFetch(
			`/${published.storePathHash}.narinfo`,
			basic(tenantReader)
		);
		const bareNar = await readFetch(`/${published.narUrl}`);
		const namedNar = await readFetch(`/cache/_default/${published.narUrl}`);
		const privateNar = await readFetch(
			`${privatePrefix}/${published.narUrl}`,
			basic(tenantReader)
		);

		expect({
			bare: cacheAvailabilityResponseSchema.parse(await availability.json()),
			defaultCache: cacheAvailabilityResponseSchema.parse(
				await defaultAvailability.json()
			),
			narinfo: narinfo.status,
			bareNar: bareNar.status,
			namedNar: namedNar.status,
			privateNar: privateNar.status
		}).toStrictEqual({
			bare: { missingStorePathHashes: [published.storePathHash] },
			defaultCache: { missingStorePathHashes: [published.storePathHash] },
			narinfo: StatusCodes.NOT_FOUND,
			bareNar: StatusCodes.NOT_FOUND,
			namedNar: StatusCodes.NOT_FOUND,
			privateNar: StatusCodes.OK
		});
	});

	it('refuses a NAR that only another private cache references', async () => {
		const published = await publishToPrivateCache();
		const siblingPrefix = `/private-cache/${sibling}`;

		const throughSibling = await readFetch(
			`${siblingPrefix}/${published.narUrl}`,
			basic(tenantReader)
		);
		const throughOwnCache = await readFetch(
			`${privatePrefix}/${published.narUrl}`,
			basic(tenantReader)
		);

		expect({
			throughSibling: throughSibling.status,
			throughOwnCache: throughOwnCache.status
		}).toStrictEqual({
			throughSibling: StatusCodes.NOT_FOUND,
			throughOwnCache: StatusCodes.OK
		});
	});

	it('serves a NAR both namespaces reference through either of them', async () => {
		const published = await publishToPrivateCache();
		const shared = uploadMetadata({
			fileSize: 1234,
			storePathHash: 'b'.repeat(32)
		});
		await pushPathToTenant(tenant, published.token, shared, undefined);

		const anonymousNar = await readFetch(`/${published.narUrl}`);
		const privateNar = await readFetch(
			`${privatePrefix}/${published.narUrl}`,
			basic(tenantReader)
		);

		expect({
			anonymousNar: anonymousNar.status,
			privateNar: privateNar.status
		}).toStrictEqual({
			anonymousNar: StatusCodes.OK,
			privateNar: StatusCodes.OK
		});
	});

	it('keeps a private tenant gated on the public routes and opens the namespace with the same credential', async () => {
		const published = await publishToPrivateCache();
		await provisionFixtureTenant({
			readMode: 'private',
			read: tenantReader
		});
		const privatePath = `${privatePrefix}/${published.storePathHash}.narinfo`;

		const bareRefused = await readFetch('/nix-cache-info', {});
		const bare = await readFetch('/nix-cache-info', basic(tenantReader));
		const named = await readFetch(
			'/cache/_default/nix-cache-info',
			basic(tenantReader)
		);
		const namespaceRefused = await readFetch(privatePath, {});
		const namespaceServed = await readFetch(privatePath, basic(tenantReader));

		await setCacheReadCredential(
			database(),
			tenant,
			localName,
			cacheReader,
			now
		);
		const namespaceExclusive = await readFetch(
			privatePath,
			basic(tenantReader)
		);

		expect({
			bareRefused: bareRefused.status,
			bare: bare.status,
			named: named.status,
			namespaceRefused: namespaceRefused.status,
			namespaceServed: namespaceServed.status,
			namespaceExclusive: namespaceExclusive.status
		}).toStrictEqual({
			bareRefused: StatusCodes.UNAUTHORIZED,
			bare: StatusCodes.OK,
			named: StatusCodes.OK,
			namespaceRefused: StatusCodes.UNAUTHORIZED,
			namespaceServed: StatusCodes.OK,
			namespaceExclusive: StatusCodes.UNAUTHORIZED
		});
	});

	it.each([
		{ name: 'an unserved path under a named cache', suffix: '/no-such-route' },
		{ name: 'the cache prefix itself', suffix: '' },
		{ name: 'a store-path deletion', suffix: `/paths/${'a'.repeat(32)}` },
		{
			name: 'an upload negotiation',
			suffix: '/uploads',
			init: { method: 'POST' }
		}
	])(
		'returns 401 without a credential and 404 with a valid credential for $name',
		async ({ suffix, init }) => {
			await publishToPrivateCache();
			const path = `${privatePrefix}${suffix}`;

			const refused = await readFetch(path, init ?? {});
			const served = await readFetch(path, withCredential(tenantReader, init));

			expect({
				refused: refused.status,
				refusedControl: refused.headers.get('cache-control'),
				served: served.status,
				servedControl: served.headers.get('cache-control')
			}).toStrictEqual({
				refused: StatusCodes.UNAUTHORIZED,
				refusedControl: 'no-store',
				served: StatusCodes.NOT_FOUND,
				servedControl: 'no-store'
			});
		}
	);

	it.each([
		{ name: 'the namespace root', path: '/private-cache' },
		{ name: 'the namespace root with a slash', path: '/private-cache/' },
		{ name: 'a malformed local name', path: '/private-cache/Bad_NAME!/pubkey' },
		{
			name: 'a selector in place of a local name',
			path: `/private-cache/${privateSelector}/pubkey`
		}
	])(
		'refuses $name whether or not a credential is offered',
		async ({ path }) => {
			await publishToPrivateCache();

			const anonymous = await readFetch(path, {});
			const authenticated = await readFetch(path, basic(tenantReader));

			expect({
				anonymous: anonymous.status,
				authenticated: authenticated.status,
				control: anonymous.headers.get('cache-control')
			}).toStrictEqual({
				anonymous: StatusCodes.UNAUTHORIZED,
				authenticated: StatusCodes.UNAUTHORIZED,
				control: 'no-store'
			});
		}
	);

	it("creates and removes a private cache by selector without removing another cache or the private cache's read credential", async () => {
		const published = await publishToPrivateCache();
		await authorisedWorkerFetch(`/caches/${sibling}`, published.token, {
			body: JSON.stringify({ priority: 41 }),
			headers: { 'content-type': 'application/json' },
			method: 'PUT'
		});
		await setCacheReadCredential(
			database(),
			tenant,
			localName,
			cacheReader,
			now
		);

		const created = await authorisedWorkerFetch(
			`/caches/${privateSelector}`,
			published.token,
			{
				body: JSON.stringify({ priority: 40 }),
				headers: { 'content-type': 'application/json' },
				method: 'PUT'
			}
		);
		const removed = await authorisedWorkerFetch(
			`/caches/${privateSelector}?force=true`,
			published.token,
			{ method: 'DELETE' }
		);
		const listed = await authorisedWorkerFetch('/caches', published.token);
		const registry = cacheNamesSchema.parse(await listed.json());
		const touched = new Set<string>([sibling, privateStoredCache(localName)]);

		expect({
			created: await created.json(),
			removed: await removed.json(),
			// The Durable Object the worker routes to keeps its registry across the
			// tests in this file, so compare only the two caches this test creates.
			caches: registry.caches
				.map((cache) => cache.name)
				.filter((name) => touched.has(name)),
			credentials: await cacheCredentialRows()
		}).toStrictEqual({
			created: {
				name: privateStoredCache(localName),
				priority: 40,
				storePaths: 1,
				graceManaged: false
			},
			removed: {
				name: privateStoredCache(localName),
				removed: true,
				storePathsRemoved: 1
			},
			caches: [sibling],
			credentials: [{ tenant, cache: privateStoredCache(localName) }]
		});
	});

	it('previews an upload for a private cache through the worker', async () => {
		const token = await initialiseViaWorker();
		const metadata = uploadMetadata({ fileSize: 1234 });

		const preview = await handlerFetch(
			`/t/${tenant}/cache/${privateSelector}/uploads/preview`,
			{
				body: JSON.stringify({ paths: [uploadPathNegotiation(metadata)] }),
				headers: {
					authorization: `Bearer ${token}`,
					'content-type': 'application/json'
				},
				method: 'POST'
			}
		);

		expect(preview.status).toBe(StatusCodes.OK);
	});
});
