import { fakeCliUi } from '@cupboard/cli-ui/testing';
import { formatTimestamp } from '@cupboard/reporter';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import type { CachedSession } from '../auth/token-store.ts';
import type { CloudflareGrant } from '../deploy/cloudflare-oauth.ts';
import { cloudflareOauthClientId } from '../deploy/cloudflare-oauth.ts';

import { type IdentityLoginOptions, identityLoginOptions } from './login.ts';
import {
	NoCachedSessionError,
	runWhoami,
	type WhoamiDependencies,
	whoamiInput,
	WhoamiProviderWithUrlError
} from './whoami.ts';

const tenant = 'https://cupboard.example.workers.dev/t/acme';
const deployment = 'https://cupboard.example.workers.dev';
const now = 1_700_000_000_000;
const expiry = now / 1000 + 600;
const expiryIso = new Date(expiry * 1000).toISOString();
const cloudflareIssuer = 'https://dash.cloudflare.com';
const emptyMessage =
	'No sessions are cached. Sign in with `cupboard login <url>`, or run ' +
	'`cupboard whoami --provider` to see the identity you would sign in as.';

function jwtSegment(value: object): string {
	return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function jwt(claims: Record<string, unknown>): string {
	return `${jwtSegment({ alg: 'EdDSA', typ: 'JWT' })}.${jwtSegment(claims)}.signature`;
}

const tenantSession: CachedSession = {
	accessToken: jwt({
		iss: tenant,
		aud: tenant,
		sub: 'user-1',
		exp: expiry,
		cb_rule: 'owner'
	}),
	refreshToken: 'refresh'
};
const deploymentSession: CachedSession = {
	accessToken: jwt({ iss: deployment, aud: 'client-id', sub: 'user-1' })
};
const grant: CloudflareGrant = {
	accessToken: 'cloudflare-access',
	refreshToken: undefined,
	idToken: undefined,
	expiresAt: now + 60_000,
	subject: 'user-1'
};
const tenantIdentity = {
	url: tenant,
	kind: 'tenant',
	subject: 'user-1',
	rule: 'owner',
	accessTokenExpiresAt: expiryIso,
	refreshTokenCached: true
};
const tenantRow = {
	label: tenant,
	value: `user-1 · tenant · rule owner · access token expires ${formatTimestamp(expiryIso)} · refresh token cached`
};

function dependencies(
	overrides: Partial<WhoamiDependencies> = {}
): WhoamiDependencies {
	return {
		listSessions: () => Promise.resolve([tenantSession, deploymentSession]),
		readSession: (target) =>
			Promise.resolve(target.href === tenant ? tenantSession : undefined),
		readGrant: () => Promise.resolve(grant),
		signIn: () => Promise.reject(new Error('no sign-in expected')),
		now: () => now,
		...overrides
	};
}

const defaultSignIn = {
	oidcIssuer: cloudflareIssuer,
	clientId: 'client-id'
};

describe('whoamiInput', () => {
	it('shows every cached session without a URL', () => {
		expect(whoamiInput(undefined, defaultSignIn)).toStrictEqual({
			kind: 'sessions'
		});
	});

	it('shows one session for a URL', () => {
		const url = new URL(tenant);

		expect(whoamiInput(url, defaultSignIn)).toStrictEqual({
			kind: 'sessions',
			url
		});
	});

	it('asks the identity provider with --provider', () => {
		expect(
			whoamiInput(undefined, {
				...defaultSignIn,
				provider: true,
				headless: true
			})
		).toStrictEqual({
			kind: 'provider',
			options: { ...defaultSignIn, headless: true }
		});
	});

	it('refuses a URL with --provider', () => {
		expect(() =>
			whoamiInput(new URL(tenant), { ...defaultSignIn, provider: true })
		).toThrow(WhoamiProviderWithUrlError);
	});
});

function parseSignInOptions(argv: readonly string[]): Record<string, unknown> {
	const command = new Command().exitOverride().option('--provider');
	const options = identityLoginOptions({ provider: true });

	for (const option of options) {
		command.addOption(option);
	}

	return command.parse(argv, { from: 'user' }).opts();
}

describe('identityLoginOptions', () => {
	const defaults = {
		oidcIssuer: cloudflareIssuer,
		clientId: cloudflareOauthClientId
	};

	it.each([
		{ argv: [], expected: defaults },
		{
			argv: ['--oidc-issuer', 'https://idp.example.com'],
			expected: {
				...defaults,
				oidcIssuer: 'https://idp.example.com',
				provider: true
			}
		},
		{
			argv: ['--client-id', 'other'],
			expected: { ...defaults, clientId: 'other', provider: true }
		},
		{
			argv: ['--headless'],
			expected: { ...defaults, headless: true, provider: true }
		}
	])('parses $argv', ({ argv, expected }) => {
		expect(parseSignInOptions(argv)).toStrictEqual(expected);
	});
});

describe('runWhoami', () => {
	it('describes every cached session and the Cloudflare sign-in', async () => {
		const { ui, captured } = fakeCliUi();

		await runWhoami({ kind: 'sessions' }, ui.reporter(), dependencies());

		expect(captured.results).toStrictEqual([
			{
				kind: 'whoami',
				data: {
					sessions: [
						tenantIdentity,
						{
							url: deployment,
							kind: 'deployment',
							subject: 'user-1',
							refreshTokenCached: false
						}
					],
					cloudflareSignIn: { subject: 'user-1' }
				},
				rows: [
					tenantRow,
					{
						label: deployment,
						value: 'user-1 · deployment · no refresh token'
					},
					{ label: 'Cloudflare sign-in', value: 'user-1' }
				],
				empty: emptyMessage
			}
		]);
	});

	it.each([
		{
			name: 'no sessions and no Cloudflare sign-in',
			grant: undefined,
			data: { sessions: [] },
			rows: []
		},
		{
			name: 'a Cloudflare sign-in without sessions',
			grant,
			data: { sessions: [], cloudflareSignIn: { subject: 'user-1' } },
			rows: [{ label: 'Cloudflare sign-in', value: 'user-1' }]
		}
	])('reports $name', async ({ grant: cached, data, rows }) => {
		const { ui, captured } = fakeCliUi();

		await runWhoami(
			{ kind: 'sessions' },
			ui.reporter(),
			dependencies({
				listSessions: () => Promise.resolve([]),
				readGrant: () => Promise.resolve(cached)
			})
		);

		expect(captured.results).toStrictEqual([
			{ kind: 'whoami', data, rows, empty: emptyMessage }
		]);
	});

	it('describes the session for one URL', async () => {
		const { ui, captured } = fakeCliUi();

		await runWhoami(
			{ kind: 'sessions', url: new URL(tenant) },
			ui.reporter(),
			dependencies({ readGrant: () => Promise.resolve(undefined) })
		);

		expect(captured.results).toStrictEqual([
			{
				kind: 'whoami',
				data: { sessions: [tenantIdentity] },
				rows: [tenantRow],
				empty: emptyMessage
			}
		]);
	});

	it('fails with the sign-in exit status when the URL has no session', async () => {
		const { ui, captured } = fakeCliUi();
		const url = `${deployment}/t/beta`;
		const failure = runWhoami(
			{ kind: 'sessions', url: new URL(url) },
			ui.reporter(),
			dependencies()
		);

		await expect(failure).rejects.toBeInstanceOf(NoCachedSessionError);
		await expect(failure).rejects.toMatchObject({ url, exitCode: 77 });
		expect(captured.results).toStrictEqual([]);
	});

	it('signs in with the provider and reports the identity without contacting cupboard', async () => {
		const { ui, captured } = fakeCliUi();
		const signIn = vi.fn((_options: IdentityLoginOptions) =>
			Promise.resolve(
				jwt({
					iss: 'https://idp.example.com',
					aud: 'client-id',
					sub: 'user-9',
					email: 'someone@example.com',
					exp: expiry
				})
			)
		);
		const options = {
			oidcIssuer: 'https://idp.example.com',
			clientId: 'client-id'
		};

		await runWhoami(
			{ kind: 'provider', options },
			ui.reporter(),
			dependencies({ signIn })
		);

		expect({
			signIns: signIn.mock.calls,
			results: captured.results,
			infos: captured.infos.length
		}).toStrictEqual({
			signIns: [[options]],
			results: [
				{
					kind: 'whoami-provider',
					data: {
						issuer: 'https://idp.example.com',
						audience: 'client-id',
						subject: 'user-9',
						expiresAt: expiryIso,
						claims: { email: 'someone@example.com', sub: 'user-9' },
						rule: {
							issuer: 'https://idp.example.com',
							audience: 'client-id',
							claims: { sub: 'user-9' }
						},
						verified: false
					},
					rows: [
						{ label: 'Issuer', value: 'https://idp.example.com' },
						{ label: 'Audience', value: 'client-id' },
						{ label: 'Subject', value: 'user-9' },
						{ label: 'Expires', value: formatTimestamp(expiryIso) },
						{ label: 'Claim email', value: 'someone@example.com' }
					]
				}
			],
			infos: 1
		});
	});
});
