import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { TokenResponse } from '@cupboard/protocol/oidc';
import { describe, expect, it } from 'vitest';

import {
	authenticateForPush,
	authenticateGithubOidc,
	cachedOwnerProvider
} from './auth.ts';
import { CupboardClient } from './client.ts';
import { OwnerLoginRequiredError } from './errors.ts';
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

async function cachePath(): Promise<string> {
	return path.join(
		await mkdtemp(path.join(tmpdir(), 'cupboard-auth-')),
		'token'
	);
}

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
	it('federates via GitHub OIDC when --github-oidc is given', async () => {
		const provider = await authenticateForPush(federatingClient(), {
			githubOidc: true,
			audience: 'https://cache.example.workers.dev',
			environment: githubEnvironment
		});

		expect(await provider.get()).toBe('write-1');
	});

	it('otherwise uses the cached owner token, prompting a login when absent', async () => {
		const provider = await authenticateForPush(federatingClient(), {
			audience: 'https://cache.example.workers.dev'
		});

		await expect(provider.get()).rejects.toBeInstanceOf(
			OwnerLoginRequiredError
		);
	});
});

describe('cachedOwnerProvider', () => {
	it('returns the cached token and refuses to refresh it', async () => {
		const target = await cachePath();
		await writeCachedToken('cached.admin.jwt', target);
		const provider = cachedOwnerProvider(target);

		expect(await provider.get()).toBe('cached.admin.jwt');
		await expect(provider.refresh()).rejects.toBeInstanceOf(
			OwnerLoginRequiredError
		);
	});

	it('prompts a login when no token is cached', async () => {
		const provider = cachedOwnerProvider(await cachePath());

		await expect(provider.get()).rejects.toBeInstanceOf(
			OwnerLoginRequiredError
		);
	});
});
