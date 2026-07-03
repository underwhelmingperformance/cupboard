import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { tenantRpc } from '../../packages/cli/src/client/orpc.ts';
import {
	CupboardTestServer,
	ownerAudience,
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

	it('federates a CI token into a grant confined to its cache and root prefix', () =>
		withFederation('cupboard-e2e-ci-', async ({ server, directory }) => {
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
							cache: { exact: 'owner-ci', validate: 'cacheName' },
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
						cache: 'owner-ci',
						root: 'github:owner/'
					}
				]
			);

			// Root activation gates on servability, so create the CI cache the rule
			// names and push a real target into it first.
			await rpc.caches.put({ cacheName: 'owner-ci', priority: 30 });
			const source = await NixStore.host(path.join(directory, 'source-home'));
			const target = await source.add(contentAddressedFixture);
			await pushStorePaths(
				{
					client: server.pushClient(adminToken, { cache: 'owner-ci' }),
					store: source
				},
				[target]
			);

			// The CI token authorises per call, so its derived client binds it
			// directly, bypassing the cached owner session.
			const ciRoots = tenantRpc(server.tenantUrl, {
				credential: ciToken
			}).roots;
			const permitted = await ciRoots.set({
				cacheName: 'owner-ci',
				name: 'github:owner/repo',
				targets: [target]
			});

			let outsidePrefix: string;
			try {
				await ciRoots.set({
					cacheName: 'owner-ci',
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
						resources: { cache: { exact: 'owner-ci', validate: 'cacheName' } }
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
