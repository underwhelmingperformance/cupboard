import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { CredentialChain } from './auth.ts';
import {
	createCloudflareClient,
	defaultCredentialChain,
	resolveCloudflare,
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
		withGrantLock: (action, signal) => action(signal),
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
			subject: undefined
		});
	});

	it('uses a cached grant that is still valid, surfacing its identity', async () => {
		const { chain } = chainWith({ storedGrant: freshGrant });

		expect(await resolveCredential(chain)).toStrictEqual({
			token: 'cached-access',
			source: 'cached login',
			subject: 'cf-user-1'
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
			subject: 'cf-user-1'
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
			subject: 'cf-user-1'
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
			subject: undefined
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
			loginIdToken: 'login-id-token'
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
			subject: undefined
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
			subject: 'cf-user-1'
		});
	});

	it('uses a cached grant without refreshing it for an ID token', async () => {
		const stored: CloudflareGrant = { ...freshGrant, idToken: undefined };
		const { chain, calls } = chainWith({
			storedGrant: stored,
			upgradeLogin: true
		});

		expect({
			credential: await resolveCredential(chain),
			refreshedWith: calls.refreshedWith,
			logins: calls.logins
		}).toStrictEqual({
			credential: {
				token: 'cached-access',
				source: 'cached login',
				subject: 'cf-user-1'
			},
			refreshedWith: [],
			logins: 0
		});
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
			loginIdToken: 'login-id-token'
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
			subject: undefined
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
			subject: 'cf-user-1'
		});
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

describe('resolveCloudflare', () => {
	it('disables the SDK retry loop for Cloudflare mutations', async () => {
		const { chain } = chainWith({
			env: { CLOUDFLARE_API_TOKEN: 'env-token' }
		});
		const resolved = await resolveCloudflare(
			'acc-1',
			() => Promise.reject(new Error('account choice was not expected')),
			chain
		);

		expect(resolved.client.maxRetries).toBe(0);
	});

	it.each([
		{
			name: 'success',
			status: StatusCodes.OK,
			body: '{"result":"abcdef"}',
			expected:
				'Cloudflare API response exceeded the 8-byte limit after receiving 19 bytes'
		},
		{
			name: 'error',
			status: StatusCodes.INTERNAL_SERVER_ERROR,
			body: '{"error":"abcdef"}',
			expected:
				'Cloudflare API response exceeded the 4-byte limit after receiving 18 bytes'
		}
	])(
		'bounds an oversized SDK $name response',
		async ({ status, body, expected }) => {
			const client = createCloudflareClient(
				'token',
				() =>
					Promise.resolve(
						new Response(body, {
							status,
							headers: { 'content-type': 'application/json' }
						})
					),
				{ errorMaximumBytes: 4, successMaximumBytes: 8 }
			);

			await expect(client.get('/test')).rejects.toThrow(expected);
		}
	);

	it('cancels an SDK request when the deploy signal aborts', async () => {
		const controller = new AbortController();
		const reason = new Error('stop the deploy');
		let observedSignal: AbortSignal | null | undefined;
		const fetcher: typeof fetch = (_input, init) => {
			observedSignal = init?.signal;

			return new Promise((_resolve, reject) => {
				if (init?.signal?.aborted === true) {
					reject(reason);
					return;
				}

				init?.signal?.addEventListener(
					'abort',
					() => {
						reject(reason);
					},
					{ once: true }
				);
			});
		};
		const client = createCloudflareClient(
			'token',
			fetcher,
			{ errorMaximumBytes: 4, successMaximumBytes: 8 },
			controller.signal
		);
		const request = client.get('/test');

		controller.abort(reason);

		await expect(request).rejects.toThrow();
		expect(observedSignal?.aborted).toBe(true);
	});
});
