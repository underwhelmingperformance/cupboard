import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CupboardClient } from '../../packages/cli/src/client/client.ts';
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
	readonly client: CupboardClient;
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
				await body({
					server,
					client: new CupboardClient(server.tenantUrl, server.uploadFetcher()),
					directory
				});
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
				credential: adminToken,
				fetcher: server.uploadFetcher()
			});
			const { rules } = await rpc.oidcTrust.list();

			const nonOwner = server.issuer.sign({
				aud: ownerAudience,
				sub: 'not-the-owner'
			});

			expect({
				ownerRule: rules.map((rule) => ({ id: rule.id, scope: rule.scope })),
				refused: await server.exchangeIdToken(nonOwner).then(
					() => 'accepted',
					(error: unknown) =>
						error instanceof TokenExchangeFailedError ? error.status : 'other'
				)
			}).toStrictEqual({
				ownerRule: [{ id: 'owner', scope: 'admin' }],
				refused: 400
			});
		}));

	it('federates a CI token into a write token bound to its allowed roots', () =>
		withFederation(
			'cupboard-e2e-ci-',
			async ({ server, client, directory }) => {
				const adminToken = await server.ownerAdminToken();
				const rpc = tenantRpc(server.tenantUrl, {
					credential: adminToken,
					fetcher: server.uploadFetcher()
				});
				await rpc.oidcTrust.add({
					issuer: server.issuer.issuer,
					audience: ciAudience,
					claims: { repository_owner_id: '5678' },
					allowedRoots: ['github:owner/']
				});

				const ciToken = await server.exchangeIdToken(
					server.issuer.sign({
						aud: ciAudience,
						sub: 'repo:owner/repo:ref:refs/heads/main',
						repository_owner_id: '5678'
					})
				);

				// Root activation gates on servability, so push a real target first.
				const source = await NixStore.host(path.join(directory, 'source-home'));
				const target = await source.add(contentAddressedFixture);
				await pushStorePaths(
					{
						client,
						token: adminToken,
						store: source,
						workDirectory: directory
					},
					[target]
				);

				const permitted = await client.setRoot(ciToken, 'github:owner/repo', {
					targets: [target]
				});

				expect({
					permittedRoot: permitted.name,
					outsideAllowedRoots: await client
						.setRoot(ciToken, 'github:other/repo', { targets: [target] })
						.then(
							() => 'accepted',
							() => 'refused'
						)
				}).toStrictEqual({
					permittedRoot: 'github:owner/repo',
					outsideAllowedRoots: 'refused'
				});
			}
		));

	it('refuses a CI token whose claims do not match the rule', () =>
		withFederation('cupboard-e2e-ci-mismatch-', async ({ server }) => {
			const adminToken = await server.ownerAdminToken();
			const rpc = tenantRpc(server.tenantUrl, {
				credential: adminToken,
				fetcher: server.uploadFetcher()
			});
			await rpc.oidcTrust.add({
				issuer: server.issuer.issuer,
				audience: ciAudience,
				claims: { repository_owner_id: '5678' },
				allowedRoots: ['github:owner/']
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

			expect({
				wrongClaim: await server.exchangeIdToken(wrongClaim).then(
					() => 'accepted',
					() => 'refused'
				),
				wrongAudience: await server.exchangeIdToken(wrongAudience).then(
					() => 'accepted',
					() => 'refused'
				)
			}).toStrictEqual({ wrongClaim: 'refused', wrongAudience: 'refused' });
		}));
});
