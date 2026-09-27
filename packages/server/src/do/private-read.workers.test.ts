import { type CacheScope } from '@cupboard/nix-store/scalars';
import { oidcIssuerSchema } from '@cupboard/protocol/oidc';
import {
	readTokenBasicUser,
	readTokenPasswordPrefix
} from '@cupboard/protocol/read-access';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	cacheWriteGrants,
	currentNarObjectKey,
	fixtureWorkerServer,
	initialiseViaWorker,
	issueTokenForTenant,
	issueWorkerSignedToken,
	namedCache,
	narBytes,
	provisionFixtureTenant,
	pushPathToTenant,
	putWorkerTestCache,
	readFetch,
	recordTransition,
	resetTestServer,
	uploadMetadata
} from '../test-support.ts';

const readUser = 'alice';
const readPassword = 'secret';

async function provisionReader(): Promise<void> {
	await provisionFixtureTenant({
		read: { user: readUser, password: readPassword }
	});
}

async function putCache(
	token: string,
	cache: CacheScope,
	access: 'public' | 'private'
): Promise<void> {
	await putWorkerTestCache(token, cache, access);
}

async function makeDefaultPrivate(token: string): Promise<void> {
	await provisionReader();
	await putCache(token, { kind: 'default' }, 'private');
}

function authorised(): RequestInit {
	return {
		headers: { authorization: `Basic ${btoa(`${readUser}:${readPassword}`)}` }
	};
}

function tokenBasic(token: string): RequestInit {
	return {
		headers: {
			authorization: `Basic ${btoa(`${readTokenBasicUser}:${readTokenPasswordPrefix}${token}`)}`
		}
	};
}

describe('per-cache private reads', () => {
	beforeEach(async () => {
		await resetTestServer();
		await recordTransition('cache-identity', 'complete');
	});

	it('serves reads publicly when no credential is configured', async () => {
		const token = await initialiseViaWorker();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await pushPathToTenant(fixtureTenant, token, metadata);

		const narinfo = await readFetch(`/${metadata.storePathHash}.narinfo`);
		const cacheInfo = await readFetch('/nix-cache-info');

		expect({
			narinfo: narinfo.status,
			cacheInfo: cacheInfo.status
		}).toStrictEqual({ narinfo: StatusCodes.OK, cacheInfo: StatusCodes.OK });
	});

	it('requires Basic auth on narinfo, NAR and nix-cache-info', async () => {
		const token = await initialiseViaWorker();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await pushPathToTenant(fixtureTenant, token, metadata);
		await makeDefaultPrivate(token);
		const narinfoPath = `/${metadata.storePathHash}.narinfo`;
		const narPath = `/${await currentNarObjectKey(metadata.narHash)}`;

		const unauthorised = await readFetch(narinfoPath, {});
		const narinfo = await readFetch(narinfoPath, authorised());
		const narUnauthorised = await readFetch(narPath, {});
		const nar = await readFetch(narPath, authorised());
		const cacheInfoUnauthorised = await readFetch('/nix-cache-info', {});
		const cacheInfo = await readFetch('/nix-cache-info', authorised());

		expect({
			unauthorisedStatus: unauthorised.status,
			wwwAuthenticate: unauthorised.headers.get('www-authenticate'),
			narinfoStatus: narinfo.status,
			narinfoControl: narinfo.headers.get('cache-control'),
			narUnauthorisedStatus: narUnauthorised.status,
			narStatus: nar.status,
			narControl: nar.headers.get('cache-control'),
			cacheInfoUnauthorisedStatus: cacheInfoUnauthorised.status,
			cacheInfoStatus: cacheInfo.status,
			cacheInfoControl: cacheInfo.headers.get('cache-control')
		}).toStrictEqual({
			unauthorisedStatus: StatusCodes.UNAUTHORIZED,
			wwwAuthenticate: 'Basic realm="cupboard"',
			narinfoStatus: StatusCodes.OK,
			narinfoControl: 'no-store',
			narUnauthorisedStatus: StatusCodes.UNAUTHORIZED,
			narStatus: StatusCodes.OK,
			narControl: 'no-store',
			cacheInfoUnauthorisedStatus: StatusCodes.UNAUTHORIZED,
			cacheInfoStatus: StatusCodes.OK,
			cacheInfoControl: 'no-store'
		});
	});

	it('uses an exact read grant for all private cache routes', async () => {
		const admin = await initialiseViaWorker();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await pushPathToTenant(fixtureTenant, admin, metadata);
		await putCache(admin, { kind: 'default' }, 'private');
		await putCache(admin, namedCache('other'), 'private');

		const readToken = await issueWorkerSignedToken([
			{
				type: 'cupboard_cache',
				actions: ['cache:content-read'],
				cache: { kind: 'default' }
			}
		]);
		const writeToken = await issueWorkerSignedToken(
			cacheWriteGrants([], { kind: 'default' })
		);
		const otherTenantToken = await issueTokenForTenant(
			fixtureWorkerServer(),
			oidcIssuerSchema.parse('other-tenant'),
			[
				{
					type: 'cupboard_cache',
					actions: ['cache:content-read'],
					cache: { kind: 'default' }
				}
			]
		);
		const path = `/${metadata.storePathHash}.narinfo`;
		const routes = [
			{ path: '/nix-cache-info', init: {} },
			{ path, init: {} },
			{ path: `/${await currentNarObjectKey(metadata.narHash)}`, init: {} },
			{ path: '/attestations/' + metadata.storePathHash, init: {} },
			{ path: '/attestation-bundles/' + 'a'.repeat(64), init: {} },
			{
				path: '/api/v1/missing-paths',
				init: {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ storePathHashes: [metadata.storePathHash] })
				}
			},
			{
				path: '/api/v1/attested-paths',
				init: {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ storePathHashes: [metadata.storePathHash] })
				}
			}
		];
		const observed = await Promise.all(
			routes.map(async (route) => {
				const headers = new Headers(route.init.headers);
				headers.set(
					'authorization',
					new Headers(tokenBasic(readToken).headers).get('authorization') ?? ''
				);
				const response = await readFetch(route.path, {
					...route.init,
					headers
				});

				return {
					path: route.path,
					status: response.status,
					cacheControl: response.headers.get('cache-control')
				};
			})
		);
		const bearer = await readFetch(path, {
			headers: { authorization: `Bearer ${readToken}` }
		});
		const wrongCache = await readFetch(
			'/cache/other/nix-cache-info',
			tokenBasic(readToken)
		);
		const writeOnly = await readFetch(path, tokenBasic(writeToken));
		const otherTenant = await readFetch(path, tokenBasic(otherTenantToken));

		expect({
			observed,
			bearer: bearer.status,
			wrongCache: wrongCache.status,
			writeOnly: writeOnly.status,
			otherTenant: otherTenant.status
		}).toStrictEqual({
			observed: [
				{
					path: '/nix-cache-info',
					status: StatusCodes.OK,
					cacheControl: 'no-store'
				},
				{ path, status: StatusCodes.OK, cacheControl: 'no-store' },
				{
					path: routes[2]?.path,
					status: StatusCodes.OK,
					cacheControl: 'no-store'
				},
				{
					path: routes[3]?.path,
					status: StatusCodes.NOT_FOUND,
					cacheControl: 'no-store'
				},
				{
					path: routes[4]?.path,
					status: StatusCodes.NOT_FOUND,
					cacheControl: 'no-store'
				},
				{
					path: '/api/v1/missing-paths',
					status: StatusCodes.OK,
					cacheControl: 'no-store'
				},
				{
					path: '/api/v1/attested-paths',
					status: StatusCodes.OK,
					cacheControl: 'no-store'
				}
			],
			bearer: StatusCodes.OK,
			wrongCache: StatusCodes.UNAUTHORIZED,
			writeOnly: StatusCodes.UNAUTHORIZED,
			otherTenant: StatusCodes.UNAUTHORIZED
		});
	});

	it.each(['expired', 'malformed', 'invalid signature'] as const)(
		'rejects a %s content token at the private read route',
		async (failure) => {
			const admin = await initialiseViaWorker();
			await putCache(admin, { kind: 'default' }, 'private');
			const validToken = await issueWorkerSignedToken(
				[
					{
						type: 'cupboard_cache',
						actions: ['cache:content-read'],
						cache: { kind: 'default' }
					}
				],
				'route-test',
				failure === 'expired'
					? new Date(Date.now() - 60 * 60 * 1000)
					: new Date()
			);
			const token =
				failure === 'malformed'
					? 'malformed'
					: failure === 'invalid signature'
						? validToken.replace(
								/\.([^.]+)$/u,
								(_, signature: string) =>
									`.${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`
							)
						: validToken;
			const basic = await readFetch('/nix-cache-info', tokenBasic(token));
			const bearer = await readFetch('/nix-cache-info', {
				headers: { authorization: `Bearer ${token}` }
			});

			expect({
				basic: basic.status,
				basicControl: basic.headers.get('cache-control'),
				bearer: bearer.status,
				bearerControl: bearer.headers.get('cache-control')
			}).toStrictEqual({
				basic: StatusCodes.UNAUTHORIZED,
				basicControl: 'no-store',
				bearer: StatusCodes.UNAUTHORIZED,
				bearerControl: 'no-store'
			});
		}
	);

	it('forces no-store on an authorised named-cache nix-cache-info', async () => {
		const token = await initialiseViaWorker();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await putCache(token, namedCache('builds'), 'private');
		await pushPathToTenant(
			fixtureTenant,
			token,
			metadata,
			undefined,
			namedCache('builds')
		);
		await provisionReader();

		const cacheInfo = await readFetch(
			'/cache/builds/nix-cache-info',
			authorised()
		);

		expect({
			status: cacheInfo.status,
			control: cacheInfo.headers.get('cache-control')
		}).toStrictEqual({ status: StatusCodes.OK, control: 'no-store' });
	});

	it('leaves tenant-wide public routes ungated when the default cache is private', async () => {
		const token = await initialiseViaWorker();
		await makeDefaultPrivate(token);

		const pubkey = await readFetch('/pubkey', {});
		const health = await readFetch('/_health', {});
		const version = await readFetch('/_version', {});

		expect({
			pubkey: pubkey.status,
			health: health.status,
			version: version.status
		}).toStrictEqual({
			pubkey: StatusCodes.OK,
			health: StatusCodes.OK,
			version: StatusCodes.OK
		});
	});

	it('makes only public narinfos eligible for Workers Cache', async () => {
		const token = await initialiseViaWorker();
		const privatePath = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'a'.repeat(32),
			name: 'private'
		});
		const publicPath = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'b'.repeat(32),
			name: 'public'
		});
		await putCache(token, namedCache('builds'), 'public');
		await pushPathToTenant(fixtureTenant, token, privatePath);
		await pushPathToTenant(
			fixtureTenant,
			token,
			publicPath,
			undefined,
			namedCache('builds')
		);

		await makeDefaultPrivate(token);
		const privateResponse = await readFetch(
			`/${privatePath.storePathHash}.narinfo`,
			authorised()
		);

		const publicResponse = await readFetch(
			`/cache/builds/${publicPath.storePathHash}.narinfo`
		);

		expect({
			privateControl: privateResponse.headers.get('cache-control'),
			publicControl: publicResponse.headers.get('cache-control')
		}).toStrictEqual({
			privateControl: 'no-store',
			publicControl: 'public, max-age=3600, must-revalidate'
		});
	});
});
