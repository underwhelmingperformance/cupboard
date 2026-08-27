import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	cacheNameSchema,
	type Sha256HexDigest,
	sha256HexDigestSchema,
	type StorePathHash,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import {
	attestationNegotiateResponseSchema,
	attestationUploadDecisionSchema
} from '@cupboard/protocol/attestations';
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

import { setCacheReadCredential } from '../control/tenant-registry.ts';
import { sha256HexBytes } from '../crypto/crypto.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { setView } from '../do/reuse-view-read.test-support.ts';
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
	uploadMetadata
} from '../test-support.ts';

import { fixtureTenant } from './tenant-routing.test-support.ts';

const tenant = tenantIdSchema.parse(fixtureTenant);
const privateName = cacheNameSchema.parse('builds');
const privateSelector = `_private-${privateName}`;
const publicName = cacheNameSchema.parse('guides');
const viewName = 'reuse';
const privateViewName = `_private-${viewName}`;
const now = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');

// The tenant's own read credential, and the private cache's own credential.
// Once a cache holds one, only that credential opens the cache.
const tenantReader = { user: 'alice', password: 'secret' };
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

interface Published {
	readonly storePathHash: string;
	readonly narUrl: string;
	readonly bundleDigest: Sha256HexDigest;
}

// Negotiates, uploads and attaches one attestation bundle for the private
// cache. A write addresses a cache by selector, so this uses the write surface
// rather than the private read namespace.
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
	const [decision] = z
		.tuple([attestationUploadDecisionSchema])
		.parse(
			attestationNegotiateResponseSchema.parse(await negotiated.json()).bundles
		);
	await env.BLOBS.put(decision.r2Key, bundle, { sha256: hexBytes(digest) });

	const attached = await authorisedWorkerFetch(
		`/cache/${privateSelector}/attestations/${decision.uploadId}/attach`,
		token,
		{ method: 'POST' }
	);
	expect(attached.status).toBe(StatusCodes.OK);

	return digest;
}

/**
 * Publishes the same store path to the default cache, a named public cache and
 * a private cache, and attaches one attestation bundle to the private cache. It
 * defines public and private views over their respective namespaces and gives
 * the tenant and private cache separate read credentials. All three cache
 * references use the same NAR hash.
 */
async function publish(): Promise<Published> {
	const token = await initialiseViaWorker();
	const metadata = uploadMetadata({ fileSize: 1234 });
	await pushPathToTenant(tenant, token, metadata);
	await pushPathToTenant(tenant, token, metadata, undefined, publicName);
	await pushPathToTenant(tenant, token, metadata, undefined, privateSelector);
	const bundleDigest = await attachBundle(token, metadata.storePathHash);
	await setView([{ kind: 'prefix', pattern: '' }], viewName);
	await setView([{ kind: 'prefix', pattern: '' }], privateViewName);
	await provisionFixtureTenant({ read: tenantReader });
	await setCacheReadCredential(
		drizzleD1(env.CUPBOARD_DB, { schema: d1Schema }),
		tenant,
		privateName,
		cacheReader,
		now
	);

	const narinfo = await readFetch(`/${metadata.storePathHash}.narinfo`);
	expect(narinfo.status).toBe(StatusCodes.OK);

	return {
		storePathHash: metadata.storePathHash,
		narUrl: NarInfo.parse(await narinfo.text()).url,
		bundleDigest
	};
}

interface CredentialStatuses {
	readonly withTenant: number;
	readonly withCache: number;
}

// Reads one path twice: once with the tenant's read credential and once with
// the private cache's own credential.
async function statusesFor(path: string): Promise<CredentialStatuses> {
	const withTenant = await readFetch(path, basic(tenantReader));
	const withCache = await readFetch(path, basic(cacheReader));

	return { withTenant: withTenant.status, withCache: withCache.status };
}

// Every read the private cache namespace serves, relative to the prefix that
// addresses the cache.
const privateReads: readonly {
	readonly name: string;
	readonly suffix: (published: Published) => string;
}[] = [
	{ name: 'nix-cache-info', suffix: () => '/nix-cache-info' },
	{
		name: 'a narinfo',
		suffix: (published) => `/${published.storePathHash}.narinfo`
	},
	{ name: 'a NAR', suffix: (published) => `/${published.narUrl}` },
	{
		name: 'an attestation list',
		suffix: (published) => `/attestations/${published.storePathHash}`
	},
	{
		name: 'an attestation bundle',
		suffix: (published) => `/attestation-bundles/${published.bundleDigest}`
	}
];

describe('percent-encoded tenant route segments', () => {
	beforeEach(resetTestServer);

	// The tenant credential must not open a cache that holds its own credential.
	// Admission looks for the addressed cache in the raw path, so an encoded
	// namespace or an encoded name gives the route no cache verifier to check a
	// credential against.
	it.each(privateReads)(
		'refuses an encoded namespace or cache-name segment when reading $name',
		async ({ suffix }) => {
			const published = await publish();
			const suffixPath = suffix(published);
			const refused = StatusCodes.UNAUTHORIZED;

			expect({
				encodedNamespace: await statusesFor(
					`/private%2Dcache/${privateName}${suffixPath}`
				),
				encodedName: await statusesFor(`/private-cache/%62uilds${suffixPath}`),
				literal: await statusesFor(`/private-cache/${privateName}${suffixPath}`)
			}).toStrictEqual({
				encodedNamespace: { withTenant: refused, withCache: refused },
				encodedName: { withTenant: refused, withCache: refused },
				literal: { withTenant: refused, withCache: StatusCodes.OK }
			});
		}
	);

	it('refuses an encoded tenant slug', async () => {
		const published = await publish();
		const path = `/${published.storePathHash}.narinfo`;

		const encoded = await handlerFetch(`/t/%761${path}`);
		const literal = await handlerFetch(`/t/${tenant}${path}`);

		expect({
			encoded: encoded.status,
			literal: literal.status
		}).toStrictEqual({
			encoded: StatusCodes.NOT_FOUND,
			literal: StatusCodes.OK
		});
	});

	it('refuses an encoded cache name on a write', async () => {
		const token = await initialiseViaWorker();
		const body = JSON.stringify({ pushId: testPushId, paths: [] });
		const init = {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json'
			},
			body
		};

		const encoded = await handlerFetch(
			`/t/${tenant}/cache/%67uides/uploads`,
			init
		);
		const literal = await handlerFetch(
			`/t/${tenant}/cache/${publicName}/uploads`,
			init
		);

		expect({
			encoded: encoded.status,
			literal: literal.status
		}).toStrictEqual({
			encoded: StatusCodes.NOT_FOUND,
			literal: StatusCodes.OK
		});
	});

	it('serves the tenant metadata document under one spelling of the slug', async () => {
		await publish();
		const path = '/.well-known/oauth-authorization-server';

		const encoded = await handlerFetch(`${path}/t/%761`);
		const literal = await handlerFetch(`${path}/t/${tenant}`);

		expect({
			encoded: encoded.status,
			literal: literal.status
		}).toStrictEqual({
			encoded: StatusCodes.NOT_FOUND,
			literal: StatusCodes.OK
		});
	});

	it.each([
		{ name: 'an encoded cache name', path: '/private-cache/%62uilds' },
		{ name: 'an encoded cache namespace', path: '/private%2Dcache/builds' },
		{ name: 'an encoded view name', path: '/private-reuse/%72euse' },
		{ name: 'an encoded view namespace', path: `/private%2Dreuse/${viewName}` }
	])('requires authentication before rejecting $name', async ({ path }) => {
		await publish();

		const response = await readFetch(`${path}/nix-cache-info`);

		expect({
			status: response.status,
			challenge: response.headers.get('www-authenticate'),
			control: response.headers.get('cache-control')
		}).toStrictEqual({
			status: StatusCodes.UNAUTHORIZED,
			challenge: 'Basic realm="cupboard"',
			control: 'no-store'
		});
	});

	it.each([
		{
			name: 'a public cache name on a narinfo read',
			encoded: (published: Published) =>
				`/cache/%67uides/${published.storePathHash}.narinfo`,
			literal: (published: Published) =>
				`/cache/${publicName}/${published.storePathHash}.narinfo`,
			init: {}
		},
		{
			name: 'a public cache name on a NAR read',
			encoded: (published: Published) => `/cache/%67uides/${published.narUrl}`,
			literal: (published: Published) =>
				`/cache/${publicName}/${published.narUrl}`,
			init: {}
		},
		{
			name: 'the default cache selector',
			encoded: () => '/cache/%5Fdefault/nix-cache-info',
			literal: () => '/cache/_default/nix-cache-info',
			init: {}
		},
		{
			name: 'a public reuse-view name',
			encoded: () => `/reuse/%72euse/nix-cache-info`,
			literal: () => `/reuse/${viewName}/nix-cache-info`,
			init: {}
		},
		{
			name: 'a private reuse-view name',
			encoded: () => `/private-reuse/%72euse/nix-cache-info`,
			literal: () => `/private-reuse/${viewName}/nix-cache-info`,
			init: basic(tenantReader)
		},
		{
			name: 'the public cache namespace',
			encoded: (published: Published) =>
				`/cach%65/${publicName}/${published.storePathHash}.narinfo`,
			literal: (published: Published) =>
				`/cache/${publicName}/${published.storePathHash}.narinfo`,
			init: {}
		},
		{
			name: 'the public reuse-view namespace',
			encoded: () => `/reus%65/${viewName}/nix-cache-info`,
			literal: () => `/reuse/${viewName}/nix-cache-info`,
			init: {}
		},
		{
			name: 'the private reuse-view namespace',
			encoded: () => `/private%2Dreuse/${viewName}/nix-cache-info`,
			literal: () => `/private-reuse/${viewName}/nix-cache-info`,
			init: basic(tenantReader)
		}
	])(
		'refuses the encoded spelling of $name',
		async ({ encoded, literal, init }) => {
			const published = await publish();

			const refused = await readFetch(encoded(published), init);
			const served = await readFetch(literal(published), init);

			expect({
				encoded: refused.status,
				literal: served.status
			}).toStrictEqual({
				encoded: StatusCodes.NOT_FOUND,
				literal: StatusCodes.OK
			});
		}
	);
});
