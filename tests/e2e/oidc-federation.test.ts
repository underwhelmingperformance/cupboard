import { describe, expect, it } from 'vitest';

import { CupboardClient } from '../../packages/cli/src/client.ts';
import {
	CupboardTestServer,
	ownerAudience,
	TokenExchangeFailedError
} from '../support/cupboard-server.ts';
import { withTemporaryDirectory } from '../support/filesystem.ts';

const ciAudience = 'https://cache.example.workers.dev';
const target = `/nix/store/${'0'.repeat(32)}-app`;

interface Federation {
	readonly server: CupboardTestServer;
	readonly client: CupboardClient;
}

function withFederation(
	prefix: string,
	body: (federation: Federation) => Promise<void>
): Promise<void> {
	return withTemporaryDirectory(prefix, async (directory) => {
		const server = await CupboardTestServer.start(directory);

		try {
			await body({
				server,
				client: new CupboardClient(server.tenantUrl)
			});
		} finally {
			await server.stop();
		}
	});
}

describe('OIDC federation', () => {
	it('exchanges an owner id_token for an admin token and refuses a non-owner', () =>
		withFederation('cupboard-e2e-owner-', async ({ server, client }) => {
			const adminToken = await server.ownerAdminToken();
			const { rules } = await client.listOidcTrust(adminToken);

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
		withFederation('cupboard-e2e-ci-', async ({ server, client }) => {
			const adminToken = await server.ownerAdminToken();
			await client.addOidcTrust(adminToken, {
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
		}));

	it('refuses a CI token whose claims do not match the rule', () =>
		withFederation('cupboard-e2e-ci-mismatch-', async ({ server, client }) => {
			const adminToken = await server.ownerAdminToken();
			await client.addOidcTrust(adminToken, {
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
