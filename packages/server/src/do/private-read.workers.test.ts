import { type CacheScope } from '@cupboard/nix-store/scalars';
import { authorizationDetailsSchema } from '@cupboard/protocol/grants';
import { oidcIssuerSchema } from '@cupboard/protocol/oidc';
import {
	readTokenBasicUser,
	readTokenPasswordPrefix
} from '@cupboard/protocol/read-access';
import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import { sha256Hex } from '../crypto/crypto.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	cacheWriteGrants,
	createTestAccessKey,
	currentNarObjectKey,
	fixtureReaderAuthorization,
	fixtureWorkerServer,
	initialiseViaWorker,
	issueTokenForTenant,
	issueWorkerSignedToken,
	namedCache,
	narBytes,
	provisionFixtureReader,
	provisionFixtureTenant,
	pushPathToTenant,
	putWorkerTestCache,
	readFetch,
	recordTransition,
	resetTestServer,
	uploadMetadata
} from '../test-support.ts';

async function provisionReader(): Promise<void> {
	await provisionFixtureTenant();
	await provisionFixtureReader();
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
	return { headers: { authorization: fixtureReaderAuthorization } };
}

function tokenBasic(token: string): RequestInit {
	return {
		headers: {
			authorization: `Basic ${btoa(`${readTokenBasicUser}:${readTokenPasswordPrefix}${token}`)}`
		}
	};
}

const readDefault = authorizationDetailsSchema.parse([
	{
		type: 'cupboard_cache',
		cache: { kind: 'default' },
		actions: ['cache:content-read']
	}
]);

function keyBasic(secret: string, user = 'anyone'): RequestInit {
	return {
		headers: { authorization: `Basic ${btoa(`${user}:${secret}`)}` }
	};
}

function unknownKeyBasic(): RequestInit {
	return keyBasic(
		`cupboard_ak_00000000-0000-4000-8000-0000000000ff_${'a'.repeat(64)}`
	);
}

describe('per-cache private reads', () => {
	beforeEach(async () => {
		await resetTestServer();
		await recordTransition('cache-identity', 'complete');
	});

	it('accepts scoped metadata authority only for an absent cache and never streams private content', async () => {
		const admin = await initialiseViaWorker();
		const cache = namedCache('pending');
		const metadata = await issueWorkerSignedToken([
			{ type: 'cupboard_cache', cache, actions: ['cache:read'] }
		]);
		const credential = tokenBasic(metadata);
		const absent = await readFetch('/cache/pending/nix-cache-info', credential);
		const other = await readFetch('/cache/other/nix-cache-info', credential);
		const missing = await readFetch('/cache/pending/api/v1/missing-paths', {
			...credential,
			method: 'POST',
			headers: {
				...Object.fromEntries(new Headers(credential.headers)),
				'content-type': 'application/json'
			},
			body: JSON.stringify({ storePathHashes: ['0'.repeat(32)] })
		});

		expect({
			absent: absent.status,
			caching: absent.headers.get('cache-control'),
			other: other.status,
			missing: await missing.json()
		}).toStrictEqual({
			absent: StatusCodes.NOT_FOUND,
			caching: 'no-store',
			other: StatusCodes.UNAUTHORIZED,
			missing: { missingStorePathHashes: ['0'.repeat(32)] }
		});

		await putCache(admin, cache, 'private');
		const existing = await readFetch(
			'/cache/pending/nix-cache-info',
			credential
		);
		const content = await readFetch(
			`/cache/pending/${'0'.repeat(32)}.narinfo`,
			credential
		);

		expect({
			existing: existing.status,
			content: content.status
		}).toStrictEqual({
			existing: StatusCodes.UNAUTHORIZED,
			content: StatusCodes.UNAUTHORIZED
		});
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
			narinfoControl: 'no-store, no-transform',
			narUnauthorisedStatus: StatusCodes.UNAUTHORIZED,
			narStatus: StatusCodes.OK,
			narControl: 'no-store',
			cacheInfoUnauthorisedStatus: StatusCodes.UNAUTHORIZED,
			cacheInfoStatus: StatusCodes.OK,
			cacheInfoControl: 'no-store'
		});
	});

	it('refuses a static read password that an earlier release stored', async () => {
		const token = await initialiseViaWorker();
		await provisionFixtureTenant();
		await putCache(token, { kind: 'default' }, 'private');
		const salt = 'legacy-salt';
		const verifier = await sha256Hex(
			`cupboard-read-password-v1\0${salt}\0legacy-password`
		);
		await env.CUPBOARD_DB.prepare(
			'UPDATE tenant SET read_user = ?, read_password_hash = ?, read_password_salt = ? WHERE id = ?'
		)
			.bind('alice', verifier, salt, fixtureTenant)
			.run();

		const response = await readFetch('/nix-cache-info', {
			headers: { authorization: `Basic ${btoa('alice:legacy-password')}` }
		});

		expect(response.status).toBe(StatusCodes.UNAUTHORIZED);
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
				path: '/api/v1/attestation-info',
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
				{
					path,
					status: StatusCodes.OK,
					cacheControl: 'no-store, no-transform'
				},
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
					path: '/api/v1/attestation-info',
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
			privateControl: 'no-store, no-transform',
			publicControl: 'public, max-age=3600, must-revalidate, no-transform'
		});
	});
});

describe('access-key reads', () => {
	beforeEach(async () => {
		await resetTestServer();
		await recordTransition('cache-identity', 'complete');
	});

	it('reads a private cache with a key from Bearer or a Basic password with any username', async () => {
		const admin = await initialiseViaWorker();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await pushPathToTenant(fixtureTenant, admin, metadata);
		await putCache(admin, { kind: 'default' }, 'private');
		const key = await createTestAccessKey(fixtureWorkerServer(), readDefault);
		const path = `/${metadata.storePathHash}.narinfo`;

		const responses = {
			basic: await readFetch(path, keyBasic(key.secret)),
			otherUser: await readFetch(path, keyBasic(key.secret, 'nix')),
			bearer: await readFetch(path, {
				headers: { authorization: `Bearer ${key.secret}` }
			}),
			nar: await readFetch(
				`/${await currentNarObjectKey(metadata.narHash)}`,
				keyBasic(key.secret)
			)
		};

		expect(
			Object.fromEntries(
				Object.entries(responses).map(([name, response]) => [
					name,
					response.status
				])
			)
		).toStrictEqual({
			basic: StatusCodes.OK,
			otherUser: StatusCodes.OK,
			bearer: StatusCodes.OK,
			nar: StatusCodes.OK
		});
	});

	it('refuses a key on a cache outside its read grants', async () => {
		const admin = await initialiseViaWorker();
		await putCache(admin, { kind: 'default' }, 'private');
		await putCache(admin, namedCache('other'), 'private');
		const key = await createTestAccessKey(fixtureWorkerServer(), readDefault);

		const inside = await readFetch('/nix-cache-info', keyBasic(key.secret));
		const outside = await readFetch(
			'/cache/other/nix-cache-info',
			keyBasic(key.secret)
		);

		expect({ inside: inside.status, outside: outside.status }).toStrictEqual({
			inside: StatusCodes.OK,
			outside: StatusCodes.UNAUTHORIZED
		});
	});

	it('refuses a wrong secret for a key that this isolate has verified', async () => {
		const admin = await initialiseViaWorker();
		await putCache(admin, { kind: 'default' }, 'private');
		const key = await createTestAccessKey(fixtureWorkerServer(), readDefault);
		const wrongSecret = key.secret.replace(/[\da-f]{64}$/u, '0'.repeat(64));

		const warm = await readFetch('/nix-cache-info', keyBasic(key.secret));
		const wrong = await readFetch('/nix-cache-info', keyBasic(wrongSecret));
		const right = await readFetch('/nix-cache-info', keyBasic(key.secret));

		expect({
			warm: warm.status,
			wrong: wrong.status,
			right: right.status
		}).toStrictEqual({
			warm: StatusCodes.OK,
			wrong: StatusCodes.UNAUTHORIZED,
			right: StatusCodes.OK
		});
	});

	it.each([
		{ name: 'an unknown access key', credential: unknownKeyBasic },
		{
			name: 'an invalid access token',
			credential: () => tokenBasic('malformed')
		}
	])(
		'serves a public cache to a request with $name as to an anonymous one',
		async ({ credential }) => {
			const admin = await initialiseViaWorker();
			const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
			await pushPathToTenant(fixtureTenant, admin, metadata);
			const path = `/${metadata.storePathHash}.narinfo`;

			const anonymous = await readFetch(path);
			const presented = await readFetch(path, credential());

			expect({
				status: presented.status,
				body: await presented.text()
			}).toStrictEqual({
				status: anonymous.status,
				body: await anonymous.text()
			});
		}
	);

	it('refuses a private cache to a request with an unknown access key', async () => {
		const admin = await initialiseViaWorker();
		await putCache(admin, { kind: 'default' }, 'private');

		const response = await readFetch('/nix-cache-info', unknownKeyBasic());

		expect(response.status).toBe(StatusCodes.UNAUTHORIZED);
	});
});
