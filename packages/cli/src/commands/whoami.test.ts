import { Writable } from 'node:stream';

import { createReporter, type Reporter } from '@cupboard/reporter';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import type { CachedSession } from '../auth/token-store.ts';
import type { CloudflareGrant } from '../deploy/cloudflare-oauth.ts';

import { type ProviderSignInOptions, providerSignInOptions } from './login.ts';
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
const cloudflareIssuer = 'https://dash.cloudflare.com';

function jwtSegment(value: object): string {
	return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function jwt(claims: Record<string, unknown>): string {
	return `${jwtSegment({ alg: 'EdDSA', typ: 'JWT' })}.${jwtSegment(claims)}.signature`;
}

interface JsonEvent {
	readonly event: string;
	readonly kind?: string;
	readonly data?: unknown;
}

function jsonReporter(): { reporter: Reporter; events: () => JsonEvent[] } {
	const chunks: string[] = [];
	const stream = new Writable({
		write(chunk: Buffer, _encoding, callback): void {
			chunks.push(chunk.toString('utf8'));
			callback();
		}
	});

	return {
		reporter: createReporter({ stream, out: stream, now: () => now }),
		events: () =>
			chunks
				.join('')
				.split('\n')
				.filter((line) => line !== '')
				.map((line) => JSON.parse(line) as JsonEvent)
	};
}

function resultData(events: readonly JsonEvent[]): unknown {
	return events.find((event) => event.event === 'result')?.data;
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
} as const;

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
	const options = providerSignInOptions({ provider: true });

	for (const option of options) {
		command.addOption(option);
	}

	return command.parse(argv, { from: 'user' }).opts();
}

describe('providerSignInOptions', () => {
	it('leaves --provider off when only the defaults apply', () => {
		expect(parseSignInOptions([])).toStrictEqual({
			oidcIssuer: cloudflareIssuer,
			clientId: expect.any(String) as string
		});
	});

	it.each([
		[['--oidc-issuer', 'https://idp.example.com']],
		[['--client-id', 'other']],
		[['--headless']]
	])('turns --provider on when %j is given', (argv) => {
		expect(parseSignInOptions(argv)).toMatchObject({ provider: true });
	});
});

describe('runWhoami', () => {
	it('describes every cached session and the Cloudflare sign-in', async () => {
		const { reporter, events } = jsonReporter();

		await runWhoami({ kind: 'sessions' }, reporter, dependencies());

		expect(resultData(events())).toStrictEqual({
			sessions: [
				{
					url: tenant,
					kind: 'tenant',
					subject: 'user-1',
					rule: 'owner',
					accessTokenExpiresAt: new Date(expiry * 1000).toISOString(),
					renewable: true
				},
				{
					url: deployment,
					kind: 'deployment',
					subject: 'user-1',
					renewable: false
				}
			],
			cloudflareSignIn: { subject: 'user-1' }
		});
	});

	it('reports no sessions and no Cloudflare sign-in', async () => {
		const { reporter, events } = jsonReporter();

		await runWhoami(
			{ kind: 'sessions' },
			reporter,
			dependencies({
				listSessions: () => Promise.resolve([]),
				readGrant: () => Promise.resolve(undefined)
			})
		);

		expect(resultData(events())).toStrictEqual({ sessions: [] });
	});

	it('describes the session for one URL', async () => {
		const { reporter, events } = jsonReporter();

		await runWhoami(
			{ kind: 'sessions', url: new URL(tenant) },
			reporter,
			dependencies({ readGrant: () => Promise.resolve(undefined) })
		);

		expect(resultData(events())).toMatchObject({
			sessions: [{ url: tenant, subject: 'user-1' }]
		});
	});

	it('fails with the sign-in exit status when the URL has no session', async () => {
		const { reporter } = jsonReporter();
		const failure = runWhoami(
			{ kind: 'sessions', url: new URL(`${deployment}/t/beta`) },
			reporter,
			dependencies()
		);

		await expect(failure).rejects.toBeInstanceOf(NoCachedSessionError);
		await expect(failure).rejects.toMatchObject({ exitCode: 77 });
	});

	it('signs in with the provider and reports the identity without contacting cupboard', async () => {
		const { reporter, events } = jsonReporter();
		const signIn = vi.fn((_options: ProviderSignInOptions) =>
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
			reporter,
			dependencies({ signIn })
		);

		expect({
			signIns: signIn.mock.calls,
			data: resultData(events())
		}).toStrictEqual({
			signIns: [[options]],
			data: {
				issuer: 'https://idp.example.com',
				audience: 'client-id',
				subject: 'user-9',
				expiresAt: new Date(expiry * 1000).toISOString(),
				claims: { email: 'someone@example.com', sub: 'user-9' },
				rule: {
					issuer: 'https://idp.example.com',
					audience: 'client-id',
					claims: { sub: 'user-9' }
				},
				verified: false
			}
		});
	});
});
