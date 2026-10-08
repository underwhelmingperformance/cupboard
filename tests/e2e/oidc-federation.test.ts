import path from 'node:path';

import { cacheNameSchema, type CacheScope } from '@cupboard/nix-store/scalars';
import {
	subjectTokenTypeIdToken,
	type TokenResponse
} from '@cupboard/protocol/oidc';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

import {
	BoundSignIn,
	canonicalTarget
} from '../../packages/cli/src/auth/bound-sign-in.ts';
import { CupboardClient } from '../../packages/cli/src/client/client.ts';
import { tenantRpc } from '../../packages/cli/src/client/orpc.ts';
import { signInTo } from '../../packages/cli/src/commands/login.ts';
import { CupboardHttpError } from '../../packages/cli/src/errors.ts';
import {
	CupboardTestServer,
	ownerAudience,
	ownerSubject,
	TokenExchangeFailedError
} from '../support/cupboard-server.ts';
import { withTemporaryDirectory } from '../support/filesystem.ts';
import { NixStore } from '../support/nix.ts';
import { pushStorePaths } from '../support/push.ts';

const ciAudience = 'https://cache.example.workers.dev';
const contentAddressedFixture = path.join(
	path.resolve(import.meta.dirname, '../..'),
	'tests/fixtures/simple/source'
);

interface Federation {
	readonly server: CupboardTestServer;
	readonly directory: string;
}

function withFederation(
	prefix: string,
	body: (federation: Federation) => Promise<void>
): Promise<void> {
	return withTemporaryDirectory(
		prefix,
		async (directory) => {
			const server = await CupboardTestServer.start(directory);

			try {
				await body({ server, directory });
			} finally {
				await server.stop();
			}
		},
		{ makeWritableBeforeCleanup: true }
	);
}

describe('OIDC federation', () => {
	it('exchanges an owner id_token for an admin token and refuses a non-owner', () =>
		withFederation('cupboard-e2e-owner-', async ({ server }) => {
			const adminToken = await server.ownerAdminToken();
			const rpc = tenantRpc(server.tenantUrl, {
				credential: adminToken
			});
			const { rules } = await rpc.oidcTrust.list();

			const nonOwner = server.issuer.sign({
				aud: ownerAudience,
				sub: 'not-the-owner'
			});

			let refused: number | string;
			try {
				await server.exchangeIdToken(nonOwner);
				refused = 'accepted';
			} catch (error: unknown) {
				refused =
					error instanceof TokenExchangeFailedError ? error.status : 'other';
			}

			expect({
				ownerRule: rules.map((rule) => ({
					id: rule.id,
					grantTypes: rule.permittedGrants.map((grant) => grant.type)
				})),
				refused
			}).toStrictEqual({
				ownerRule: [{ id: 'owner', grantTypes: ['cupboard_wildcard'] }],
				refused: 400
			});
		}));

	it('accepts an owner sign-in bound to the tenant once, and refuses a replay and a token bound elsewhere', () =>
		withFederation('cupboard-e2e-bound-', async ({ server }) => {
			const signIn = (): BoundSignIn =>
				new BoundSignIn({
					signIn: (nonce) =>
						Promise.resolve(
							server.issuer.sign({
								aud: ownerAudience,
								sub: ownerSubject,
								nonce
							})
						)
				});
			const client = CupboardClient.fromUrl(server.tenantUrl, {
				cache: { kind: 'default' }
			});
			const exchanges: Parameters<CupboardClient['tokenExchange']>[] = [];
			const sessions: TokenResponse[] = [];
			const refusal = async (
				pending: Promise<unknown>
			): Promise<Readonly<Record<string, unknown>>> => {
				try {
					await pending;

					return { accepted: true };
				} catch (error) {
					return error instanceof CupboardHttpError
						? { status: error.status, problem: error.oauthError?.problem }
						: { error: String(error) };
				}
			};

			await signInTo(server.tenantUrl, {
				signIn: signIn(),
				client: {
					tokenExchange: (...request) => {
						exchanges.push(request);

						return client.tokenExchange(...request);
					}
				},
				cacheSession: (response) => {
					sessions.push(response);

					return Promise.resolve();
				}
			});

			const [presented] = exchanges;
			const replay = await refusal(
				presented === undefined
					? Promise.reject(new Error('no exchange was sent'))
					: client.tokenExchange(...presented)
			);
			const elsewhere = await signIn().idTokenFor([
				canonicalTarget(new URL(server.url))
			]);
			const unbound = await refusal(
				client.tokenExchange(
					elsewhere.idToken,
					subjectTokenTypeIdToken,
					undefined,
					elsewhere.binding
				)
			);

			expect({
				targets: presented?.[3]?.targets,
				hasRefreshToken: sessions.map(
					(session) => session.refresh_token !== undefined
				),
				replay,
				unbound
			}).toStrictEqual({
				targets: [canonicalTarget(server.tenantUrl)],
				hasRefreshToken: [true],
				replay: {
					status: StatusCodes.BAD_REQUEST,
					problem: 'subject-token-replayed'
				},
				unbound: {
					status: StatusCodes.BAD_REQUEST,
					problem: 'subject-token-unbound'
				}
			});
		}));

	it('federates a CI token into a grant confined to its cache and root prefix', () =>
		withFederation('cupboard-e2e-ci-', async ({ server, directory }) => {
			const cache: CacheScope = {
				kind: 'named',
				name: cacheNameSchema.parse('owner-ci')
			};
			const adminToken = await server.ownerAdminToken();
			const rpc = tenantRpc(server.tenantUrl, {
				credential: adminToken
			});
			// The rule permits a named CI cache and root writes beneath an owner
			// prefix; the issued grant carries whatever subset the CI requests.
			await rpc.oidcTrust.add({
				issuer: server.issuer.issuer,
				audience: ciAudience,
				claims: { repository_owner_id: '5678' },
				permittedGrants: [
					{
						type: 'cupboard_cache',
						actions: ['upload:negotiate', 'upload:commit', 'root:set'],
						resources: {
							cache: {
								kind: 'named',
								exact: 'owner-ci',
								validate: 'cacheName'
							},
							root: { exact: 'github:owner/', validate: 'rootName' }
						}
					}
				]
			});

			const ciToken = await server.exchangeIdToken(
				server.issuer.sign({
					aud: ciAudience,
					sub: 'repo:owner/repo:ref:refs/heads/main',
					repository_owner_id: '5678'
				}),
				[
					{
						type: 'cupboard_cache',
						actions: ['root:set'],
						cache,
						root: 'github:owner/'
					}
				]
			);

			// Root activation gates on servability, so create the CI cache the rule
			// names and push a real target into it first.
			await rpc.caches.put.inNamedCache({
				cacheName: cache.name,
				access: 'public',
				priority: 30
			});
			const source = await NixStore.host(path.join(directory, 'source-home'));
			const target = await source.add(contentAddressedFixture);
			await pushStorePaths(
				{
					client: server.pushClient(adminToken, { cache }),
					store: source
				},
				[target]
			);

			// The CI token authorises per call, so its derived client binds it
			// directly, bypassing the cached owner session.
			const ciRoots = tenantRpc(server.tenantUrl, {
				credential: ciToken
			}).roots;
			const permitted = await ciRoots.set.inNamedCache({
				cacheName: cacheNameSchema.parse('owner-ci'),
				name: 'github:owner/repo',
				targets: [target]
			});

			let outsidePrefix: string;
			try {
				await ciRoots.set.inNamedCache({
					cacheName: cacheNameSchema.parse('owner-ci'),
					name: 'github:other/repo',
					targets: [target]
				});
				outsidePrefix = 'accepted';
			} catch {
				outsidePrefix = 'refused';
			}

			expect({
				permittedRoot: permitted.name,
				outsidePrefix
			}).toStrictEqual({
				permittedRoot: 'github:owner/repo',
				outsidePrefix: 'refused'
			});
		}));

	it('refuses a CI token whose claims do not match the rule', () =>
		withFederation('cupboard-e2e-ci-mismatch-', async ({ server }) => {
			const adminToken = await server.ownerAdminToken();
			const rpc = tenantRpc(server.tenantUrl, {
				credential: adminToken
			});
			await rpc.oidcTrust.add({
				issuer: server.issuer.issuer,
				audience: ciAudience,
				claims: { repository_owner_id: '5678' },
				permittedGrants: [
					{
						type: 'cupboard_cache',
						actions: ['upload:commit'],
						resources: {
							cache: { kind: 'named', exact: 'owner-ci', validate: 'cacheName' }
						}
					}
				]
			});

			const wrongClaim = server.issuer.sign({
				aud: ciAudience,
				sub: 'repo:intruder/repo',
				repository_owner_id: '0000'
			});
			const wrongAudience = server.issuer.sign({
				aud: 'https://someone-else',
				sub: 'repo:owner/repo',
				repository_owner_id: '5678'
			});

			let wrongClaimResult: string;
			try {
				await server.exchangeIdToken(wrongClaim);
				wrongClaimResult = 'accepted';
			} catch {
				wrongClaimResult = 'refused';
			}

			let wrongAudienceResult: string;
			try {
				await server.exchangeIdToken(wrongAudience);
				wrongAudienceResult = 'accepted';
			} catch {
				wrongAudienceResult = 'refused';
			}

			expect({
				wrongClaim: wrongClaimResult,
				wrongAudience: wrongAudienceResult
			}).toStrictEqual({ wrongClaim: 'refused', wrongAudience: 'refused' });
		}));
});
