import { subjectTokenTypeIdToken } from '@cupboard/protocol/oidc';

import type { CupboardClient, TokenProvider } from '../client/client.ts';
import { OwnerLoginRequiredError } from '../errors.ts';

import {
	fetchGithubOidcToken,
	type GithubOidcEnvironment
} from './github-oidc.ts';
import { readCachedToken } from './token-store.ts';

/**
 * Supplies the cached owner admin token to the admin commands. A cached token
 * cannot be silently refreshed — there is no refresh grant yet — so an absent
 * cache or a 401 surfaces as a prompt to run `cupboard login` again.
 */
export function cachedOwnerProvider(target: string): TokenProvider {
	return {
		async get(): Promise<string> {
			const token = await readCachedToken(target);

			if (token === undefined) {
				throw new OwnerLoginRequiredError();
			}

			return token;
		},
		refresh(): Promise<string> {
			return Promise.reject(new OwnerLoginRequiredError());
		}
	};
}

/**
 * Federates a GitHub Actions OIDC token into a cupboard write token through the
 * token-exchange endpoint, returning a provider that caches it and re-exchanges
 * on demand. The first exchange happens eagerly so a workflow missing the
 * `id-token: write` permission, or a token no rule trusts, fails up front.
 */
export async function authenticateGithubOidc(
	client: CupboardClient,
	audience: string,
	environment?: GithubOidcEnvironment
): Promise<TokenProvider> {
	const provider = new GithubOidcTokenProvider(client, audience, environment);
	await provider.get();

	return provider;
}

export interface PushAuthOptions {
	readonly githubOidc?: boolean;
	readonly audience: string;
	readonly environment?: GithubOidcEnvironment;
}

/**
 * Picks the push credential: GitHub Actions OIDC federation with
 * `--github-oidc`, otherwise the cached owner token from `cupboard login`.
 */
export function authenticateForPush(
	client: CupboardClient,
	options: PushAuthOptions
): Promise<TokenProvider> {
	if (options.githubOidc === true) {
		return authenticateGithubOidc(
			client,
			options.audience,
			options.environment
		);
	}

	return Promise.resolve(cachedOwnerProvider(client.baseUrl.href));
}

class GithubOidcTokenProvider implements TokenProvider {
	#token: string | undefined;

	constructor(
		private readonly client: CupboardClient,
		private readonly audience: string,
		private readonly environment?: GithubOidcEnvironment
	) {}

	async get(): Promise<string> {
		return (this.#token ??= await this.exchange());
	}

	async refresh(): Promise<string> {
		this.#token = await this.exchange();

		return this.#token;
	}

	private async exchange(): Promise<string> {
		const subjectToken = await fetchGithubOidcToken({
			audience: this.audience,
			environment: this.environment,
			fetcher: this.client.fetcher
		});
		const { access_token } = await this.client.tokenExchange(
			subjectToken,
			subjectTokenTypeIdToken
		);

		return access_token;
	}
}
