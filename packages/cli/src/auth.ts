import { subjectTokenTypeIdToken } from '@cupboard/shared';

import type { CupboardClient, TokenProvider } from './client.ts';
import { AuthSelectionError } from './errors.ts';
import {
	fetchGithubOidcToken,
	type GithubOidcEnvironment
} from './github-oidc.ts';

/**
 * Exchanges the deployment bootstrap secret for a short-lived admin access JWT
 * and returns a provider that caches it and re-exchanges on demand. A long
 * push can outlive a single token, so the client refreshes through this
 * provider and retries once on a 401. The CLI stays stateless: nothing is
 * persisted between invocations.
 *
 * The first exchange happens eagerly so an invalid bootstrap secret fails the
 * command up front.
 */
export async function authenticate(
	client: CupboardClient,
	bootstrapSecret: string
): Promise<TokenProvider> {
	const provider = new BootstrapTokenProvider(client, bootstrapSecret);
	await provider.get();

	return provider;
}

class BootstrapTokenProvider implements TokenProvider {
	#token: string | undefined;

	constructor(
		private readonly client: CupboardClient,
		private readonly bootstrapSecret: string
	) {}

	async get(): Promise<string> {
		return (this.#token ??= await this.exchange());
	}

	async refresh(): Promise<string> {
		this.#token = await this.exchange();

		return this.#token;
	}

	private async exchange(): Promise<string> {
		const { token } = await this.client.bootstrap(this.bootstrapSecret);

		return token;
	}
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
	readonly token?: string;
	readonly githubOidc?: boolean;
	readonly audience: string;
	readonly environment?: GithubOidcEnvironment;
}

/**
 * Picks the push credential from the command-line options: a bootstrap secret
 * (`--token`) or GitHub Actions OIDC federation (`--github-oidc`). Exactly one
 * must be given.
 */
export async function authenticateForPush(
	client: CupboardClient,
	options: PushAuthOptions
): Promise<TokenProvider> {
	if (options.githubOidc === true && options.token !== undefined) {
		throw new AuthSelectionError(
			'Pass either --token or --github-oidc, not both'
		);
	}

	if (options.githubOidc === true) {
		return authenticateGithubOidc(
			client,
			options.audience,
			options.environment
		);
	}

	if (options.token !== undefined) {
		return authenticate(client, options.token);
	}

	throw new AuthSelectionError(
		'Pass --token or --github-oidc to authenticate the push'
	);
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
