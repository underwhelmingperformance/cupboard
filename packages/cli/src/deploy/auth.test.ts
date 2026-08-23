import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { CredentialChain } from './auth.ts';
import {
	defaultCredentialChain,
	freshIdToken,
	resolveCredential
} from './auth.ts';
import type { CloudflareGrant } from './cloudflare-oauth.ts';

const hour = 60 * 60 * 1000;
const now = 1_700_000_000_000;

const freshGrant: CloudflareGrant = {
	accessToken: 'cached-access',
	refreshToken: 'cached-refresh',
	expiresAt: now + hour,
	subject: 'cf-user-1',
	idToken: 'cached-id-token'
};

const expiredGrant: CloudflareGrant = {
	accessToken: 'stale-access',
	refreshToken: 'stale-refresh',
	expiresAt: now - hour,
	subject: 'cf-user-1',
	idToken: 'stale-id-token'
};

interface ChainCalls {
	readonly written: CloudflareGrant[];
	readonly refreshedWith: CloudflareGrant[];
	readonly logins: number;
}

interface ChainWorld {
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly storedGrant?: CloudflareGrant;
	readonly renewedGrant?: CloudflareGrant;
	readonly wranglerToken?: string;
	readonly loginGrant?: CloudflareGrant;
	readonly upgradeLogin?: boolean;
}

function chainWith(world: ChainWorld): {
	chain: CredentialChain;
	calls: ChainCalls;
} {
	const written: CloudflareGrant[] = [];
	const refreshedWith: CloudflareGrant[] = [];
	const counter = { logins: 0 };

	const chain: CredentialChain = {
		env: world.env ?? {},
		readGrant: () => Promise.resolve(world.storedGrant),
		writeGrant: (grant) => {
			written.push(grant);
			return Promise.resolve();
		},
		refreshGrant: (previous) => {
			refreshedWith.push(previous);
			return Promise.resolve(world.renewedGrant);
		},
		readWranglerToken: () => Promise.resolve(world.wranglerToken),
		login: () => {
			counter.logins += 1;
			const loginGrant = z
				.custom<CloudflareGrant>((value) => value !== undefined)
				.parse(world.loginGrant);

			return Promise.resolve(loginGrant);
		},
		upgradeLogin: world.upgradeLogin ?? false,
		now: () => now
	};

	return {
		chain,
		calls: {
			written,
			refreshedWith,
			get logins() {
				return counter.logins;
			}
		}
	};
}

describe('resolveCredential', () => {
	it.each([
		['CLOUDFLARE_API_TOKEN', { CLOUDFLARE_API_TOKEN: 'env-token' }],
		['CF_API_TOKEN', { CF_API_TOKEN: 'env-token' }]
	])('prefers %s over everything else', async (_name, env) => {
		const { chain } = chainWith({ env, storedGrant: freshGrant });

		expect(await resolveCredential(chain)).toStrictEqual({
			token: 'env-token',
			source: 'environment',
			subject: undefined,
			idToken: undefined
		});
	});

	it('uses a cached grant that is still valid, surfacing its identity', async () => {
		const { chain } = chainWith({ storedGrant: freshGrant });

		expect(await resolveCredential(chain)).toStrictEqual({
			token: 'cached-access',
			source: 'cached login',
			subject: 'cf-user-1',
			idToken: 'cached-id-token'
		});
	});

	it('renews an expired grant from its refresh token and persists the result', async () => {
		const renewed: CloudflareGrant = {
			accessToken: 'renewed-access',
			refreshToken: 'renewed-refresh',
			expiresAt: now + hour,
			subject: 'cf-user-1',
			idToken: 'renewed-id-token'
		};
		const { chain, calls } = chainWith({
			storedGrant: expiredGrant,
			renewedGrant: renewed
		});

		expect(await resolveCredential(chain)).toStrictEqual({
			token: 'renewed-access',
			source: 'cached login',
			subject: 'cf-user-1',
			idToken: 'renewed-id-token'
		});
		expect(calls.written).toStrictEqual([renewed]);
	});

	it('treats a grant within the expiry margin as expired', async () => {
		const nearlyExpired: CloudflareGrant = {
			...freshGrant,
			expiresAt: now + 30 * 1000
		};
		const renewed: CloudflareGrant = {
			accessToken: 'renewed-access',
			refreshToken: 'renewed-refresh',
			expiresAt: now + hour,
			subject: 'cf-user-1',
			idToken: 'renewed-id-token'
		};
		const { chain, calls } = chainWith({
			storedGrant: nearlyExpired,
			renewedGrant: renewed
		});

		expect(await resolveCredential(chain)).toStrictEqual({
			token: 'renewed-access',
			source: 'cached login',
			subject: 'cf-user-1',
			idToken: 'renewed-id-token'
		});
		expect(calls.refreshedWith).toStrictEqual([nearlyExpired]);
	});

	it('falls back to wrangler when the refresh is declined', async () => {
		const { chain, calls } = chainWith({
			storedGrant: expiredGrant,
			wranglerToken: 'wrangler-token'
		});

		expect(await resolveCredential(chain)).toStrictEqual({
			token: 'wrangler-token',
			source: 'wrangler',
			subject: undefined,
			idToken: undefined
		});
		expect(calls.refreshedWith).toStrictEqual([expiredGrant]);
	});

	it('logs in interactively as the last resort and caches the grant', async () => {
		const loginGrant: CloudflareGrant = {
			accessToken: 'login-access',
			refreshToken: 'login-refresh',
			expiresAt: now + hour,
			subject: 'cf-user-2',
			idToken: 'login-id-token'
		};
		const { chain, calls } = chainWith({ loginGrant });

		expect(await resolveCredential(chain)).toStrictEqual({
			token: 'login-access',
			source: 'browser login',
			subject: 'cf-user-2',
			idToken: 'login-id-token'
		});
		expect(calls.written).toStrictEqual([loginGrant]);
	});

	it('skips wrangler entirely when the chain has no reader for it', async () => {
		const loginGrant: CloudflareGrant = {
			accessToken: 'login-access',
			refreshToken: 'login-refresh',
			expiresAt: now + hour,
			subject: undefined,
			idToken: undefined
		};
		const { chain } = chainWith({
			wranglerToken: 'wrangler-token',
			loginGrant
		});
		const { readWranglerToken: _wrangler, ...withoutWrangler } = chain;

		expect(await resolveCredential(withoutWrangler)).toStrictEqual({
			token: 'login-access',
			source: 'browser login',
			subject: undefined,
			idToken: undefined
		});
	});

	it('does not consult the cache when the env token is empty', async () => {
		const { chain } = chainWith({
			env: { CLOUDFLARE_API_TOKEN: '' },
			storedGrant: freshGrant
		});

		expect(await resolveCredential(chain)).toStrictEqual({
			token: 'cached-access',
			source: 'cached login',
			subject: 'cf-user-1',
			idToken: 'cached-id-token'
		});
	});

	it('refreshes a grant that predates id_token storage', async () => {
		const stored: CloudflareGrant = { ...freshGrant, idToken: undefined };
		const renewed: CloudflareGrant = {
			...freshGrant,
			accessToken: 'renewed-access',
			idToken: 'renewed-id-token'
		};
		const { chain, calls } = chainWith({
			storedGrant: stored,
			renewedGrant: renewed,
			upgradeLogin: true
		});

		expect(await resolveCredential(chain)).toStrictEqual({
			token: 'renewed-access',
			source: 'cached login',
			subject: 'cf-user-1',
			idToken: 'renewed-id-token'
		});
		expect({
			refreshedWith: calls.refreshedWith,
			written: calls.written
		}).toStrictEqual({
			refreshedWith: [stored],
			written: [renewed]
		});
	});

	it('falls back to a login when the refresh reissues no id_token', async () => {
		const stored: CloudflareGrant = { ...freshGrant, idToken: undefined };
		const renewed: CloudflareGrant = {
			...stored,
			refreshToken: 'rotated-refresh'
		};
		const loginGrant: CloudflareGrant = {
			accessToken: 'login-access',
			refreshToken: 'login-refresh',
			expiresAt: now + hour,
			subject: 'cf-user-1',
			idToken: 'login-id-token'
		};
		const { chain, calls } = chainWith({
			storedGrant: stored,
			renewedGrant: renewed,
			loginGrant,
			upgradeLogin: true
		});

		expect(await resolveCredential(chain)).toStrictEqual({
			token: 'login-access',
			source: 'browser login',
			subject: 'cf-user-1',
			idToken: 'login-id-token'
		});
		// The rotation is persisted before the login overwrites it, so a login
		// abandoned midway does not strand a revoked refresh token.
		expect(calls.written).toStrictEqual([renewed, loginGrant]);
	});

	it('keeps an id_token-less grant when no upgrade is possible', async () => {
		const stored: CloudflareGrant = { ...freshGrant, idToken: undefined };
		const { chain, calls } = chainWith({ storedGrant: stored });

		expect(await resolveCredential(chain)).toStrictEqual({
			token: 'cached-access',
			source: 'cached login',
			subject: 'cf-user-1',
			idToken: undefined
		});
		expect(calls.refreshedWith).toStrictEqual([stored]);
	});

	it('replaces an identity-less grant with a fresh login when allowed', async () => {
		const loginGrant: CloudflareGrant = {
			accessToken: 'login-access',
			refreshToken: 'login-refresh',
			expiresAt: now + hour,
			subject: 'cf-user-9',
			idToken: 'login-id-token'
		};
		const { chain, calls } = chainWith({
			storedGrant: { ...freshGrant, subject: undefined },
			loginGrant,
			upgradeLogin: true
		});

		expect(await resolveCredential(chain)).toStrictEqual({
			token: 'login-access',
			source: 'browser login',
			subject: 'cf-user-9',
			idToken: 'login-id-token'
		});
		expect(calls.written).toStrictEqual([loginGrant]);
	});

	it('keeps an identity-less grant when no upgrade is possible', async () => {
		const { chain } = chainWith({
			storedGrant: { ...freshGrant, subject: undefined }
		});

		expect(await resolveCredential(chain)).toStrictEqual({
			token: 'cached-access',
			source: 'cached login',
			subject: undefined,
			idToken: 'cached-id-token'
		});
	});

	it('does not upgrade a grant that already has an identity', async () => {
		const { chain } = chainWith({
			storedGrant: freshGrant,
			upgradeLogin: true
		});

		expect(await resolveCredential(chain)).toStrictEqual({
			token: 'cached-access',
			source: 'cached login',
			subject: 'cf-user-1',
			idToken: 'cached-id-token'
		});
	});
});

function tokenExpiringAt(expSeconds: number): string {
	const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString(
		'base64url'
	);
	const payload = Buffer.from(
		JSON.stringify({ sub: 'cf-user-1', exp: expSeconds })
	).toString('base64url');

	return `${header}.${payload}.signature`;
}

describe('freshIdToken', () => {
	const nowSeconds = now / 1000;

	it('keeps a cached id_token with time left, without refreshing', async () => {
		const idToken = tokenExpiringAt(nowSeconds + 3600);
		const { chain, calls } = chainWith({
			storedGrant: { ...freshGrant, idToken }
		});

		expect({
			token: await freshIdToken(chain),
			refreshedWith: calls.refreshedWith,
			written: calls.written
		}).toStrictEqual({ token: idToken, refreshedWith: [], written: [] });
	});

	it('refreshes an id_token at the edge of expiry and persists the grant', async () => {
		const stale = tokenExpiringAt(nowSeconds + 60);
		const reissued = tokenExpiringAt(nowSeconds + 3600);
		const renewed: CloudflareGrant = { ...freshGrant, idToken: reissued };
		const { chain, calls } = chainWith({
			storedGrant: { ...freshGrant, idToken: stale },
			renewedGrant: renewed
		});

		expect({
			token: await freshIdToken(chain),
			written: calls.written
		}).toStrictEqual({ token: reissued, written: [renewed] });
	});

	it('refreshes when the grant has no id_token at all', async () => {
		const reissued = tokenExpiringAt(nowSeconds + 3600);
		const renewed: CloudflareGrant = { ...freshGrant, idToken: reissued };
		const { chain } = chainWith({
			storedGrant: { ...freshGrant, idToken: undefined },
			renewedGrant: renewed
		});

		expect(await freshIdToken(chain)).toBe(reissued);
	});

	it('falls back to the stale token when the refresh declines', async () => {
		const stale = tokenExpiringAt(nowSeconds - 60);
		const { chain, calls } = chainWith({
			storedGrant: { ...freshGrant, idToken: stale }
		});

		expect({
			token: await freshIdToken(chain),
			written: calls.written
		}).toStrictEqual({ token: stale, written: [] });
	});

	it('returns undefined without a cached grant', async () => {
		const { chain } = chainWith({});

		expect(await freshIdToken(chain)).toBeUndefined();
	});
});

describe('defaultCredentialChain', () => {
	it.each([
		['installs the wrangler reader when allowed', true],
		['omits the wrangler reader when disallowed', false]
	])('%s', (_name, wrangler) => {
		const browserUrls: string[] = [];
		const chain = defaultCredentialChain({
			openBrowser: (url) => {
				browserUrls.push(url);
			},
			wrangler,
			interactive: true
		});

		expect({
			wranglerReader: typeof chain.readWranglerToken,
			upgradeLogin: chain.upgradeLogin,
			browserUrls
		}).toStrictEqual({
			wranglerReader: wrangler ? 'function' : 'undefined',
			upgradeLogin: true,
			browserUrls: []
		});
	});
});
