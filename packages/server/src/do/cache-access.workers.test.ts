import {
	CacheInfo,
	servedStoreDirectory
} from '@cupboard/nix-store/cache-info';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	type CacheGeneration,
	cacheNameSchema,
	cachePrioritySchema,
	type CacheReadRevision,
	type CacheScope,
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
import { cacheListResponseSchema } from '@cupboard/protocol/caches';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import {
	type TenantReadCredential,
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
import { cacheScopeFromRow } from '../db/cache.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	authorisedWorkerFetch,
	handlerFetch,
	hexBytes,
	initialiseViaWorker,
	namedCache,
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
const privateCache = namedCache(localName);
const cachePrefix = `/cache/${localName}`;
const tenant = tenantIdSchema.parse(fixtureTenant);
const now = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');

// The tenant credential is the fallback for every private cache that has no
// credential of its own.
const tenantReader = { user: 'alice', password: 'secret' };

// One private cache's own credential. Generated passwords are exactly 43
// base64url characters, matching the control-plane schema.
const cacheReader: TenantReadCredential = tenantReadCredentialSchema.parse({
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

async function cacheLifecycleVersion(cache: CacheScope): Promise<{
	readonly generation: CacheGeneration;
	readonly readRevision: CacheReadRevision;
}> {
	const rows = await database()
		.select({
			kind: d1Schema.cacheLifecycle.cacheKind,
			name: d1Schema.cacheLifecycle.cacheName,
			generation: d1Schema.cacheLifecycle.generation,
			readRevision: d1Schema.cacheLifecycle.readRevision
		})
		.from(d1Schema.cacheLifecycle)
		.all();
	const row = rows.find(
		(candidate) =>
			candidate.kind === cache.kind &&
			(cache.kind === 'default' || candidate.name === cache.name)
	);

	if (row === undefined) {
		throw new Error(`No lifecycle row exists for ${JSON.stringify(cache)}`);
	}

	return { generation: row.generation, readRevision: row.readRevision };
}

async function cacheCredentialRows(): Promise<
	{ tenant: string; cache: CacheScope }[]
> {
	const rows = await database()
		.select({
			tenant: d1Schema.tenantCacheReadCredential.tenant,
			kind: d1Schema.tenantCacheReadCredential.cacheKind,
			name: d1Schema.tenantCacheReadCredential.cacheName
		})
		.from(d1Schema.tenantCacheReadCredential)
		.all();

	return rows.map((row) => ({
		tenant: row.tenant,
		cache: cacheScopeFromRow({ kind: row.kind, name: row.name })
	}));
}

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

async function putNamedCache(
	token: string,
	name: string,
	access: 'public' | 'private',
	priority = 40
): Promise<void> {
	const response = await authorisedWorkerFetch(`/caches/${name}`, token, {
		body: JSON.stringify({ access, priority }),
		headers: { 'content-type': 'application/json' },
		method: 'PUT'
	});

	if (response.ok) {
		return;
	}

	expect(response.status).toBe(StatusCodes.CONFLICT);

	const accessResponse = await authorisedWorkerFetch(`/caches/${name}`, token, {
		body: JSON.stringify({ kind: 'access', access }),
		headers: { 'content-type': 'application/json' },
		method: 'PATCH'
	});
	const priorityResponse = await authorisedWorkerFetch(
		`/caches/${name}`,
		token,
		{
			body: JSON.stringify({ kind: 'priority', priority }),
			headers: { 'content-type': 'application/json' },
			method: 'PATCH'
		}
	);

	expect({
		access: accessResponse.status,
		priority: priorityResponse.status
	}).toStrictEqual({ access: StatusCodes.OK, priority: StatusCodes.OK });
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
	await putNamedCache(token, localName, 'private');
	await pushPathToTenant(tenant, token, metadata, undefined, privateCache);
	const bundleDigest = await attachBundle(token, metadata.storePathHash);
	await provisionFixtureTenant({ read: tenantReader });

	const narinfo = await readFetch(
		`${cachePrefix}/${metadata.storePathHash}.narinfo`,
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
// cache through its write routes.
async function attachBundle(
	token: string,
	storePathHash: StorePathHash
): Promise<Sha256HexDigest> {
	const bundle = sigstoreBundleBytes(narDigestHex(narHash));
	const digest = sha256HexDigestSchema.parse(await sha256HexBytes(bundle));
	const negotiated = await authorisedWorkerFetch(
		`${cachePrefix}/attestations`,
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
		`${cachePrefix}/attestations/${decision.uploadId}/attach`,
		token,
		{ method: 'POST' }
	);
	expect(attached.status).toBe(StatusCodes.OK);

	return digest;
}

describe('private cache access', () => {
	beforeEach(resetTestServer);

	it('requires a credential for every content route and marks every response no-store', async () => {
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
				const path = `${cachePrefix}${route.suffix}`;
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

		const pubkey = await readFetch(`${cachePrefix}/pubkey`);
		expect(pubkey.status).toBe(StatusCodes.OK);
	});

	it('serves HEAD for a narinfo in the addressed private cache', async () => {
		const published = await publishToPrivateCache();
		const path = `${cachePrefix}/${published.storePathHash}.narinfo`;

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

	it('reads the named cache the stable path identifies, not the default cache', async () => {
		const published = await publishToPrivateCache();
		const put = await authorisedWorkerFetch(
			`/caches/${localName}`,
			published.token,
			{
				body: JSON.stringify({ kind: 'priority', priority: 30 }),
				headers: { 'content-type': 'application/json' },
				method: 'PATCH'
			}
		);
		expect(put.status).toBe(StatusCodes.OK);

		const cacheInfo = await readFetch(
			`${cachePrefix}/nix-cache-info`,
			basic(tenantReader)
		);
		const availability = await readFetch(
			`${cachePrefix}/api/v1/missing-paths`,
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

	it('changes the read revision without changing the cache generation when access changes', async () => {
		const token = await initialiseViaWorker();
		await putNamedCache(token, localName, 'public');
		const created = await cacheLifecycleVersion(privateCache);

		const privateResponse = await authorisedWorkerFetch(
			`/caches/${localName}`,
			token,
			{
				body: JSON.stringify({ kind: 'access', access: 'private' }),
				headers: { 'content-type': 'application/json' },
				method: 'PATCH'
			}
		);
		const privateVersion = await cacheLifecycleVersion(privateCache);
		const publicResponse = await authorisedWorkerFetch(
			`/caches/${localName}`,
			token,
			{
				body: JSON.stringify({ kind: 'access', access: 'public' }),
				headers: { 'content-type': 'application/json' },
				method: 'PATCH'
			}
		);
		const publicVersion = await cacheLifecycleVersion(privateCache);

		expect({
			privateStatus: privateResponse.status,
			publicStatus: publicResponse.status,
			created,
			privateVersion,
			publicVersion
		}).toStrictEqual({
			privateStatus: StatusCodes.OK,
			publicStatus: StatusCodes.OK,
			created: { generation: 1, readRevision: 1 },
			privateVersion: { generation: 1, readRevision: 2 },
			publicVersion: { generation: 1, readRevision: 3 }
		});
	});

	it("lets only a cache's own credential open it once it has one", async () => {
		const published = await publishToPrivateCache();
		await putNamedCache(published.token, sibling, 'private');
		await pushPathToTenant(
			tenant,
			published.token,
			uploadMetadata({ fileSize: 1234, storePathHash: 'a'.repeat(32) }),
			undefined,
			namedCache(sibling)
		);
		await setCacheReadCredential(
			database(),
			tenant,
			privateCache,
			cacheReader,
			now
		);
		const path = `${cachePrefix}/${published.storePathHash}.narinfo`;
		const siblingPath = `/cache/${sibling}/nix-cache-info`;

		const exclusiveTenant = await readFetch(path, basic(tenantReader));
		const exclusiveCache = await readFetch(path, basic(cacheReader));
		const exclusiveSibling = await readFetch(siblingPath, basic(tenantReader));
		const exclusive = {
			withTenantCredential: exclusiveTenant.status,
			withCacheCredential: exclusiveCache.status,
			siblingWithTenantCredential: exclusiveSibling.status
		};

		await clearCacheReadCredential(database(), tenant, privateCache);
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

	it('refuses a private cache when neither the cache nor the tenant has a credential', async () => {
		const token = await initialiseViaWorker();
		const metadata = uploadMetadata({ fileSize: 1234 });
		await putNamedCache(token, localName, 'private');
		await pushPathToTenant(tenant, token, metadata, undefined, privateCache);

		const response = await readFetch(
			`${cachePrefix}/${metadata.storePathHash}.narinfo`,
			basic(tenantReader)
		);

		expect(response.status).toBe(StatusCodes.UNAUTHORIZED);
	});

	it('keeps a private path and its NAR out of the public default cache', async () => {
		const published = await publishToPrivateCache();

		const availability = await readFetch(
			'/api/v1/missing-paths',
			availabilityPost(published.storePathHash)
		);
		const narinfo = await readFetch(
			`/${published.storePathHash}.narinfo`,
			basic(tenantReader)
		);
		const bareNar = await readFetch(`/${published.narUrl}`);
		const privateNar = await readFetch(
			`${cachePrefix}/${published.narUrl}`,
			basic(tenantReader)
		);

		expect({
			bare: cacheAvailabilityResponseSchema.parse(await availability.json()),
			narinfo: narinfo.status,
			bareNar: bareNar.status,
			privateNar: privateNar.status
		}).toStrictEqual({
			bare: { missingStorePathHashes: [published.storePathHash] },
			narinfo: StatusCodes.NOT_FOUND,
			bareNar: StatusCodes.NOT_FOUND,
			privateNar: StatusCodes.OK
		});
	});

	it('refuses a NAR that only another private cache references', async () => {
		const published = await publishToPrivateCache();
		await putNamedCache(published.token, sibling, 'private');
		const siblingPrefix = `/cache/${sibling}`;

		const throughSibling = await readFetch(
			`${siblingPrefix}/${published.narUrl}`,
			basic(tenantReader)
		);
		const throughOwnCache = await readFetch(
			`${cachePrefix}/${published.narUrl}`,
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

	it('serves a NAR through both caches that reference it', async () => {
		const published = await publishToPrivateCache();
		const shared = uploadMetadata({
			fileSize: 1234,
			storePathHash: 'b'.repeat(32)
		});
		await pushPathToTenant(tenant, published.token, shared, undefined);

		const anonymousNar = await readFetch(`/${published.narUrl}`);
		const privateNar = await readFetch(
			`${cachePrefix}/${published.narUrl}`,
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

	it('applies the tenant credential independently to the default and named caches', async () => {
		const published = await publishToPrivateCache();
		const defaultPut = await authorisedWorkerFetch('/cache', published.token, {
			body: JSON.stringify({ kind: 'access', access: 'private' }),
			headers: { 'content-type': 'application/json' },
			method: 'PATCH'
		});
		expect(defaultPut.status).toBe(StatusCodes.OK);
		const privatePath = `${cachePrefix}/${published.storePathHash}.narinfo`;

		const bareRefused = await readFetch('/nix-cache-info', {});
		const bare = await readFetch('/nix-cache-info', basic(tenantReader));
		const namedRefused = await readFetch(privatePath, {});
		const namedServed = await readFetch(privatePath, basic(tenantReader));

		await setCacheReadCredential(
			database(),
			tenant,
			privateCache,
			cacheReader,
			now
		);
		const namedExclusive = await readFetch(privatePath, basic(tenantReader));

		expect({
			bareRefused: bareRefused.status,
			bare: bare.status,
			namedRefused: namedRefused.status,
			namedServed: namedServed.status,
			namedExclusive: namedExclusive.status
		}).toStrictEqual({
			bareRefused: StatusCodes.UNAUTHORIZED,
			bare: StatusCodes.OK,
			namedRefused: StatusCodes.UNAUTHORIZED,
			namedServed: StatusCodes.OK,
			namedExclusive: StatusCodes.UNAUTHORIZED
		});
	});

	it.each([
		{ name: 'an unserved path under a named cache', suffix: '/no-such-route' },
		{ name: 'the cache prefix itself', suffix: '' },
		{ name: 'a store-path deletion', suffix: `/paths/${'a'.repeat(32)}` }
	])(
		'returns 404 for $name whether or not a credential is offered',
		async ({ suffix }) => {
			await publishToPrivateCache();
			const path = `${cachePrefix}${suffix}`;

			const anonymous = await readFetch(path);
			const authenticated = await readFetch(path, basic(tenantReader));

			expect({
				anonymous: anonymous.status,
				authenticated: authenticated.status
			}).toStrictEqual({
				anonymous: StatusCodes.NOT_FOUND,
				authenticated: StatusCodes.NOT_FOUND
			});
		}
	);

	it('does not accept a read credential on a cache write route', async () => {
		await publishToPrivateCache();

		const anonymous = await readFetch(`${cachePrefix}/uploads`, {
			method: 'POST'
		});
		const reader = await readFetch(
			`${cachePrefix}/uploads`,
			withCredential(tenantReader, { method: 'POST' })
		);

		expect({
			anonymous: anonymous.status,
			reader: reader.status
		}).toStrictEqual({
			anonymous: StatusCodes.UNAUTHORIZED,
			reader: StatusCodes.UNAUTHORIZED
		});
	});

	it.each([
		{ name: 'a malformed cache name', path: '/cache/Bad_NAME!/pubkey' },
		{ name: 'a non-canonical cache name', path: '/cache/Builds/pubkey' }
	])(
		'returns 404 for $name whether or not a credential is offered',
		async ({ path }) => {
			await publishToPrivateCache();

			const anonymous = await readFetch(path, {});
			const authenticated = await readFetch(path, basic(tenantReader));

			expect({
				anonymous: anonymous.status,
				authenticated: authenticated.status
			}).toStrictEqual({
				anonymous: StatusCodes.NOT_FOUND,
				authenticated: StatusCodes.NOT_FOUND
			});
		}
	);

	it("creates and removes a private cache without removing another cache or the private cache's read credential", async () => {
		const published = await publishToPrivateCache();
		const retained = cacheNameSchema.parse('retained');
		await authorisedWorkerFetch(`/caches/${retained}`, published.token, {
			body: JSON.stringify({ access: 'public', priority: 41 }),
			headers: { 'content-type': 'application/json' },
			method: 'PUT'
		});
		await setCacheReadCredential(
			database(),
			tenant,
			privateCache,
			cacheReader,
			now
		);

		const created = await authorisedWorkerFetch(
			`/caches/${localName}`,
			published.token,
			{
				body: JSON.stringify({ kind: 'access', access: 'private' }),
				headers: { 'content-type': 'application/json' },
				method: 'PATCH'
			}
		);
		const removed = await authorisedWorkerFetch(
			`/caches/${localName}?force=true`,
			published.token,
			{ method: 'DELETE' }
		);
		const listed = await authorisedWorkerFetch('/caches', published.token);
		const registry = cacheListResponseSchema.parse(await listed.json());
		const touched = new Set<string>([retained, localName]);

		expect({
			created: await created.json(),
			removed: await removed.json(),
			caches: registry.caches.filter(
				(cache) => cache.scope.kind === 'named' && touched.has(cache.scope.name)
			),
			credentials: await cacheCredentialRows()
		}).toStrictEqual({
			created: {
				scope: privateCache,
				access: 'private',
				priority: 40,
				storePaths: 1,
				graceManaged: false
			},
			removed: {
				scope: privateCache,
				removed: true,
				storePathsRemoved: 1
			},
			caches: [
				{
					scope: namedCache(retained),
					access: 'public',
					priority: 41,
					storePaths: 0,
					graceManaged: false
				}
			],
			credentials: [{ tenant, cache: privateCache }]
		});
	});

	it('previews an upload for a private cache through the worker', async () => {
		const token = await initialiseViaWorker();
		const metadata = uploadMetadata({ fileSize: 1234 });
		await putNamedCache(token, localName, 'private');

		const preview = await handlerFetch(
			`/t/${tenant}/cache/${localName}/uploads/preview`,
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
