import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { BootstrapResponse, TokenResponse } from '@cupboard/shared';
import { describe, expect, it } from 'vitest';

import {
	authenticate,
	authenticateForPush,
	authenticateGithubOidc,
	cachedOwnerProvider
} from './auth.ts';
import { CupboardClient } from './client.ts';
import { AuthSelectionError, OwnerLoginRequiredError } from './errors.ts';
import type { GithubOidcEnvironment } from './github-oidc.ts';
import { writeCachedToken } from './token-store.ts';

const githubEnvironment: GithubOidcEnvironment = {
	requestUrl: 'https://actions.example.com/token',
	requestToken: 'request-bearer'
};

// A fetcher answering the GitHub OIDC request with a fresh subject token and
// the cupboard exchange with a write token derived from it, so a refresh yields
// a distinct token end to end.
function federatingClient(): CupboardClient {
	let issued = 0;

	return new CupboardClient(new URL('https://cupboard.test'), (input) => {
		if (!(input instanceof URL)) {
			throw new TypeError('expected the client to request a URL');
		}

		if (input.origin === 'https://actions.example.com') {
			issued += 1;

			return Promise.resolve(
				Response.json({ value: `subject-${String(issued)}` })
			);
		}

		return Promise.resolve(
			Response.json({
				access_token: `write-${String(issued)}`,
				token_type: 'Bearer',
				expires_in: 900,
				scope: 'write',
				issued_token_type: 'urn:ietf:params:oauth:token-type:access_token'
			} satisfies TokenResponse)
		);
	});
}

describe('authenticate', () => {
	it('exchanges the bootstrap secret eagerly, caches the token, and re-exchanges on refresh', async () => {
		const authorisations: (string | undefined)[] = [];
		let issued = 0;
		const client = new CupboardClient(
			new URL('https://cupboard.test'),
			(_input, init) => {
				authorisations.push(
					new Headers(init?.headers).get('authorization') ?? undefined
				);
				issued += 1;

				return Promise.resolve(
					Response.json({
						url: 'https://cupboard.test',
						publicKey: 'cupboard:key',
						token: `jwt-${String(issued)}`
					} satisfies BootstrapResponse)
				);
			}
		);

		const provider = await authenticate(client, 'bootstrap-secret');
		const eager = await provider.get();
		const refreshed = await provider.refresh();
		const afterRefresh = await provider.get();

		expect({ eager, refreshed, afterRefresh, authorisations }).toStrictEqual({
			eager: 'jwt-1',
			refreshed: 'jwt-2',
			afterRefresh: 'jwt-2',
			authorisations: ['Bearer bootstrap-secret', 'Bearer bootstrap-secret']
		});
	});
});

describe('authenticateGithubOidc', () => {
	it('federates a subject token into a write token, caching and refreshing it', async () => {
		const provider = await authenticateGithubOidc(
			federatingClient(),
			'https://cache.example.workers.dev',
			githubEnvironment
		);

		const eager = await provider.get();
		const refreshed = await provider.refresh();
		const afterRefresh = await provider.get();

		expect({ eager, refreshed, afterRefresh }).toStrictEqual({
			eager: 'write-1',
			refreshed: 'write-2',
			afterRefresh: 'write-2'
		});
	});
});

describe('authenticateForPush', () => {
	const client = new CupboardClient(new URL('https://cupboard.test'), () =>
		Promise.resolve(
			Response.json({
				url: 'https://cupboard.test',
				publicKey: 'cupboard:key',
				token: 'jwt'
			} satisfies BootstrapResponse)
		)
	);

	it('uses the bootstrap secret when only a token is given', async () => {
		const provider = await authenticateForPush(client, {
			token: 'secret',
			audience: 'https://cupboard.test'
		});

		expect(await provider.get()).toBe('jwt');
	});

	it('federates via GitHub OIDC when only --github-oidc is given', async () => {
		const provider = await authenticateForPush(federatingClient(), {
			githubOidc: true,
			audience: 'https://cache.example.workers.dev',
			environment: githubEnvironment
		});

		expect(await provider.get()).toBe('write-1');
	});

	it.each([
		{
			name: 'both a token and --github-oidc',
			token: 'secret',
			githubOidc: true
		},
		{ name: 'neither a token nor --github-oidc', githubOidc: false }
	])('rejects $name', async ({ token, githubOidc }) => {
		await expect(
			authenticateForPush(client, {
				...(token === undefined ? {} : { token }),
				githubOidc,
				audience: 'https://cupboard.test'
			})
		).rejects.toBeInstanceOf(AuthSelectionError);
	});
});

describe('cachedOwnerProvider', () => {
	it('returns the cached token and refuses to refresh it', async () => {
		const target = path.join(
			await mkdtemp(path.join(tmpdir(), 'cupboard-auth-')),
			'token'
		);
		await writeCachedToken('cached.admin.jwt', target);
		const provider = cachedOwnerProvider(target);

		expect(await provider.get()).toBe('cached.admin.jwt');
		await expect(provider.refresh()).rejects.toBeInstanceOf(
			OwnerLoginRequiredError
		);
	});

	it('prompts a login when no token is cached', async () => {
		const target = path.join(
			await mkdtemp(path.join(tmpdir(), 'cupboard-auth-')),
			'absent'
		);
		const provider = cachedOwnerProvider(target);

		await expect(provider.get()).rejects.toBeInstanceOf(
			OwnerLoginRequiredError
		);
	});
});
