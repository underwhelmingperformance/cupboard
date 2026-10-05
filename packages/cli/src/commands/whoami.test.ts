import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { fakeCliUi } from '@cupboard/cli-ui/testing';
import { formatTimestamp } from '@cupboard/reporter';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import {
	type CachedSession,
	listCachedSessions,
	tokensDirectory,
	writeCachedSession
} from '../auth/token-store.ts';
import { cliExitCode } from '../cli.ts';
import type { CloudflareGrant } from '../deploy/cloudflare-oauth.ts';
import { cloudflareOauthClientId } from '../deploy/cloudflare-oauth.ts';
import { OwnerLoginRequiredError, UploadWaitTimeoutError } from '../errors.ts';
import { testWithConfigHome } from '../test-support.ts';

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
	value:
		'user-1 · tenant sign-in · saved sign-in current · automatic renewal available'
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
	testWithConfigHome.for(['grant-readable', 'grant-unreadable'] as const)(
		'reports readable sessions when another session file cannot be read: %s',
		async (grantState) => {
			await writeCachedSession(tenantSession, new URL(tenant));
			const unreadableFiles = ['0'.repeat(64), '1'.repeat(64)].map((file) =>
				path.join(tokensDirectory(), file)
			);
			for (const file of unreadableFiles) {
				await mkdir(file);
			}
			const { ui, captured } = fakeCliUi();
			const pending = runWhoami(
				{ kind: 'sessions' },
				ui.reporter(),
				dependencies({
					listSessions: listCachedSessions,
					readGrant: () =>
						grantState === 'grant-unreadable'
							? Promise.reject(new Error('grant is unreadable'))
							: Promise.resolve(grant)
				})
			);

			await expect(pending).rejects.toMatchObject({ code: 'EISDIR' });
			expect(captured.warnings).toStrictEqual([
				...unreadableFiles.map(
					(file) =>
						`Could not read the saved sign-in at ${file}. Check that the file is readable and retry.`
				),
				...(grantState === 'grant-unreadable'
					? [
							"Could not read the cached Cloudflare sign-in. Check access to the CLI's configuration directory and retry."
						]
					: [])
			]);
			expect(captured.results).toStrictEqual([
				{
					kind: 'whoami',
					title: 'Saved sign-ins (server access not checked)',
					data: {
						sessions: [tenantIdentity],
						...(grantState === 'grant-readable' && {
							cloudflareSignIn: { subject: 'user-1' }
						})
					},
					rows: [
						tenantRow,
						...(grantState === 'grant-readable'
							? [{ label: 'Cloudflare sign-in', value: 'user-1' }]
							: [])
					],
					empty: 'Some cached identity files could not be read.'
				}
			]);
		}
	);

	it.each([
		{ failure: new OwnerLoginRequiredError(), status: 77 },
		{ failure: new UploadWaitTimeoutError(1, 600), status: 75 }
	])(
		'preserves the original status $status after reporting each unreadable file',
		async ({ failure, status }) => {
			const { ui, captured } = fakeCliUi();
			const secondFailure = new Error('permission denied');
			let error: unknown;
			try {
				await runWhoami(
					{ kind: 'sessions' },
					ui.reporter(),
					dependencies({
						listSessions: (onReadFailure) => {
							onReadFailure?.({ file: '/tmp/session-a', cause: failure });
							onReadFailure?.({ file: '/tmp/session-b', cause: secondFailure });
							return Promise.resolve([tenantSession]);
						}
					})
				);
			} catch (error_) {
				error = error_;
			}
			expect({
				error,
				status: cliExitCode(error, 130),
				warnings: captured.warnings,
				results: captured.results
			}).toStrictEqual({
				error: failure,
				status,
				warnings: [
					'Could not read the saved sign-in at /tmp/session-a. Check that the file is readable and retry.',
					'Could not read the saved sign-in at /tmp/session-b. Check that the file is readable and retry.'
				],
				results: [
					{
						kind: 'whoami',
						title: 'Saved sign-ins (server access not checked)',
						data: {
							sessions: [tenantIdentity],
							cloudflareSignIn: { subject: 'user-1' }
						},
						rows: [tenantRow, { label: 'Cloudflare sign-in', value: 'user-1' }],
						empty: 'Some cached identity files could not be read.'
					}
				]
			});
		}
	);

	it('shows saved credential metadata only with details', async () => {
		const { ui, captured } = fakeCliUi({ presentation: 'details' });
		await runWhoami(
			{ kind: 'sessions' },
			ui.reporter(),
			dependencies({
				listSessions: () => Promise.resolve([tenantSession]),
				readGrant: () => Promise.resolve(undefined)
			})
		);
		expect(captured.results).toStrictEqual([
			{
				kind: 'whoami',
				title: 'Saved sign-ins (server access not checked)',
				data: { sessions: [tenantIdentity] },
				rows: [
					tenantRow,
					{ label: 'Trust rule', value: tenantIdentity.rule },
					{ label: 'Credential expiry', value: formatTimestamp(expiryIso) }
				],
				empty: emptyMessage
			}
		]);
	});

	it.each(['grant', 'sessions'] as const)(
		'reports independently readable identity fields when %s cannot be read',
		async (unreadable) => {
			const { ui, captured } = fakeCliUi();
			const failure = new Error('EACCES: permission denied');
			const pending = runWhoami(
				{ kind: 'sessions' },
				ui.reporter(),
				dependencies({
					listSessions: () =>
						unreadable === 'sessions'
							? Promise.reject(failure)
							: Promise.resolve([tenantSession]),
					readGrant: () =>
						unreadable === 'grant'
							? Promise.reject(failure)
							: Promise.resolve(grant)
				})
			);

			await expect(pending).rejects.toBe(failure);
			expect(captured.results).toStrictEqual([
				{
					kind: 'whoami',
					title: 'Saved sign-ins (server access not checked)',
					data:
						unreadable === 'grant'
							? { sessions: [tenantIdentity] }
							: { cloudflareSignIn: { subject: 'user-1' } },
					rows: [
						unreadable === 'grant'
							? tenantRow
							: { label: 'Cloudflare sign-in', value: 'user-1' }
					],
					empty: 'Some cached identity files could not be read.'
				}
			]);
			expect(captured.warnings).toStrictEqual([
				`Could not read the cached ${unreadable === 'grant' ? 'Cloudflare sign-in' : 'Cupboard sessions'}. Check access to the CLI's configuration directory and retry.`
			]);
		}
	);

	it('describes every cached session and the Cloudflare sign-in', async () => {
		const { ui, captured } = fakeCliUi();

		await runWhoami({ kind: 'sessions' }, ui.reporter(), dependencies());

		expect(captured.results).toStrictEqual([
			{
				kind: 'whoami',
				title: 'Saved sign-ins (server access not checked)',
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
						value:
							'user-1 · deployment sign-in · expiry unknown · sign in again when needed'
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
			{
				kind: 'whoami',
				title: 'Saved sign-ins (server access not checked)',
				data,
				rows,
				empty: emptyMessage
			}
		]);
	});

	it('describes the session for one URL', async () => {
		const { ui, captured } = fakeCliUi();

		await runWhoami(
			{ kind: 'sessions', url: new URL(tenant) },
			ui.reporter(),
			dependencies({
				listSessions: () => Promise.resolve([tenantSession]),
				readGrant: () => Promise.resolve(undefined)
			})
		);

		expect(captured.results).toStrictEqual([
			{
				kind: 'whoami',
				title: 'Saved sign-ins (server access not checked)',
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
					title: 'Identity provider claims (not verified)',
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
