import path from 'node:path';

import { cacheNameSchema, type CacheScope } from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import {
	cacheCreateAuthorizationDetails,
	pushAuthorizationDetails
} from '../../packages/cli/src/auth/attenuate.ts';
import { tenantRpc } from '../../packages/cli/src/client/orpc.ts';
import { githubPullRequestClaims } from '../../packages/cli/src/commands/github/claims.ts';
import { pullRequestCacheName } from '../../packages/cli/src/commands/github/convention.ts';
import { githubPrAddBody } from '../../packages/cli/src/commands/oidc-trust.ts';
import {
	CupboardTestServer,
	TokenExchangeFailedError
} from '../support/cupboard-server.ts';
import { withTemporaryDirectory } from '../support/filesystem.ts';
import { NixStore } from '../support/nix.ts';
import { pushStorePaths } from '../support/push.ts';

const repository = {
	repositoryId: 4321,
	repositoryOwnerId: 8765,
	fullName: 'owner/repo'
};
const contentAddressedFixture = path.join(
	path.resolve(import.meta.dirname, '../..'),
	'tests/fixtures/simple/source'
);
const firstPullRequestCache: CacheScope = {
	kind: 'named',
	name: cacheNameSchema.parse(pullRequestCacheName(repository.repositoryId, 1))
};

interface PullRequestTenant {
	readonly server: CupboardTestServer;
	readonly directory: string;
	readonly admin: ReturnType<typeof tenantRpc>;
}

/**
 * Starts a tenant configured the way `cupboard github setup` configures one,
 * by adding the same pull-request trust rule that command writes. The rule
 * builder pins the real GitHub issuer, which the stub cannot sign for, so the
 * issuer is the one field the fixture replaces.
 */
function withPullRequestTenant(
	prefix: string,
	body: (tenant: PullRequestTenant) => Promise<void>
): Promise<void> {
	return withTemporaryDirectory(
		prefix,
		async (directory) => {
			const server = await CupboardTestServer.start(directory);

			try {
				const admin = tenantRpc(server.tenantUrl, {
					credential: await server.ownerAdminToken()
				});
				await admin.oidcTrust.add({
					...githubPrAddBody(server.tenantUrl, repository, {
						repo: repository.fullName
					}),
					issuer: server.issuer.issuer
				});

				await body({ server, directory, admin });
			} finally {
				await server.stop();
			}
		},
		{ makeWritableBeforeCleanup: true }
	);
}

// Signs a pull-request token from the stub issuer. `claims` overrides the
// fields the GitHub claim helper produces, including the issuer it names.
function pullRequestToken(
	server: CupboardTestServer,
	claims: Readonly<Record<string, unknown>>
): string {
	return server.issuer.sign({
		...githubPullRequestClaims(server.tenantUrl, repository),
		iss: server.issuer.issuer,
		...claims
	});
}

describe('pull-request caches', () => {
	// The rule `cupboard github setup` writes names the cache
	// `gh-<repository-id>-pr-<number>`, which does not exist before the pull
	// request's first run. The workflow holds only its own pull-request token,
	// so it has to create that cache itself before it can negotiate an upload.
	it('creates and publishes to its own cache on a pull request first run', () =>
		withPullRequestTenant(
			'cupboard-e2e-pr-cache-',
			async ({ server, directory, admin }) => {
				const cache = firstPullRequestCache;
				const ciToken = await server.exchangeIdToken(
					pullRequestToken(server, { ref: 'refs/pull/1/merge' }),
					[
						...cacheCreateAuthorizationDetails({ cache }),
						...pushAuthorizationDetails({ cache, attest: false })
					]
				);
				const ci = tenantRpc(server.tenantUrl, { credential: ciToken });

				await ci.caches.put.inNamedCache({
					cacheName: cache.name,
					access: 'public',
					priority: 30
				});

				const source = await NixStore.host(path.join(directory, 'source'));
				const target = await source.add(contentAddressedFixture);
				await pushStorePaths(
					{ client: server.pushClient(ciToken, { cache }), store: source },
					[target]
				);

				const { caches } = await admin.caches.list();

				expect(
					caches
						.filter((summary) => summary.scope.kind === 'named')
						.map((summary) => ({
							name: summary.scope.kind === 'named' ? summary.scope.name : '',
							access: summary.access,
							storePaths: summary.storePaths
						}))
				).toStrictEqual([
					{
						name: pullRequestCacheName(repository.repositoryId, 1),
						access: 'public',
						storePaths: 1
					}
				]);
			}
		));

	// The rule derives the cache name from the `repository_id` and `ref`
	// claims, so a token with no usable `ref` renders no name. Rendering fails
	// closed and the exchange is refused. The stored rule is still valid, so
	// listing it and reading from the tenant's caches both go on working.
	it('refuses a token whose ref claim is absent or does not match, and still serves reads', () =>
		withPullRequestTenant(
			'cupboard-e2e-pr-claim-',
			async ({ server, admin }) => {
				const exchange = async (
					claims: Readonly<Record<string, unknown>>
				): Promise<number | string> => {
					try {
						await server.exchangeIdToken(
							pullRequestToken(server, claims),
							cacheCreateAuthorizationDetails({
								cache: firstPullRequestCache
							})
						);

						return 'issued';
					} catch (error: unknown) {
						return error instanceof TokenExchangeFailedError
							? error.status
							: 'other';
					}
				};

				// `githubPullRequestClaims` omits `ref` when it is given no pull
				// request number, so `undefined` here leaves the claim absent.
				const absent = await exchange({ ref: undefined });
				const unmatched = await exchange({ ref: 'refs/heads/main' });
				const { rules } = await admin.oidcTrust.list();
				const { caches } = await admin.caches.list();

				expect({
					absent,
					unmatched,
					storedRules: rules.length,
					namedCaches: caches.filter(
						(summary) => summary.scope.kind === 'named'
					).length
				}).toStrictEqual({
					absent: 400,
					unmatched: 400,
					storedRules: 2,
					namedCaches: 0
				});
			}
		));
});
