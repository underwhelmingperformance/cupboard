import {
	type ParsedTokenResponse,
	subjectTokenTypeIdToken
} from '@cupboard/protocol/oidc';

import { CupboardClient, type TokenProvider } from '../client/client.ts';
import { type CredentialChain, freshIdToken } from '../deploy/auth.ts';
import {
	jwtExpiryMs,
	refreshCloudflareGrant
} from '../deploy/cloudflare-oauth.ts';
import { readCachedGrant, writeCachedGrant } from '../deploy/grant-store.ts';
import { CupboardHttpError, OwnerLoginRequiredError } from '../errors.ts';

import {
	fetchGithubOidcToken,
	type GithubOidcEnvironment
} from './github-oidc.ts';
import {
	type CachedSession,
	readCachedSession,
	sessionFromTokenResponse,
	writeCachedSession
} from './token-store.ts';

// The slice of the client a session renewal needs: the two token grants.
interface SessionTokenClient {
	tokenRefresh(refreshToken: string): Promise<ParsedTokenResponse>;
	tokenExchange(
		subjectToken: string,
		subjectTokenType: string
	): Promise<ParsedTokenResponse>;
}

type GrantChain = Pick<
	CredentialChain,
	'readGrant' | 'writeGrant' | 'refreshGrant' | 'now'
>;

export interface OwnerSessionDependencies {
	readonly client?: SessionTokenClient;
	readonly grantChain?: GrantChain;
	readonly readSession?: (target: string) => Promise<CachedSession | undefined>;
	readonly writeSession?: (
		session: CachedSession,
		target: string
	) => Promise<void>;
	readonly now?: () => number;
	/** Aborts the token fetch the provider makes, so Ctrl-C is prompt. */
	readonly signal?: AbortSignal;
}

// An access token this close to its expiry is renewed up front rather than
// spent on a request that would only bounce with a 401.
const accessTokenFreshnessMarginMs = 30 * 1000;

/**
 * Supplies the owner's admin token to the admin commands, keeping the session
 * alive without a browser. A fresh cached access token is used as is; an
 * expired or refused one is renewed by rotating the cupboard refresh token,
 * falling back to exchanging a fresh `id_token` from the deploy's stored
 * Cloudflare grant. Only when neither silent path can issue does the session
 * surface as a prompt to run `cupboard login` again.
 */
export function cachedOwnerProvider(
	target: string,
	dependencies: OwnerSessionDependencies = {}
): TokenProvider {
	const client =
		dependencies.client ??
		CupboardClient.fromUrl(target, { signal: dependencies.signal });
	const readSession = dependencies.readSession ?? readCachedSession;
	const writeSession = dependencies.writeSession ?? writeCachedSession;
	const grantChain = dependencies.grantChain ?? {
		readGrant: readCachedGrant,
		writeGrant: writeCachedGrant,
		refreshGrant: (previous) => refreshCloudflareGrant(previous),
		now: Date.now
	};
	const now = dependencies.now ?? Date.now;

	const renew = async (): Promise<string> => {
		const session = await readSession(target);
		const rotated =
			session?.refreshToken === undefined
				? undefined
				: await rotateSession(client, session.refreshToken);
		const renewed =
			rotated ?? (await establishSession(client, grantChain, now));

		await writeSession(renewed, target);

		return renewed.accessToken;
	};

	return {
		async get(): Promise<string> {
			const session = await readSession(target);

			if (session !== undefined && !isExpired(session.accessToken, now())) {
				return session.accessToken;
			}

			return renew();
		},
		refresh: renew
	};
}

function isExpired(accessToken: string, nowMs: number): boolean {
	const expiry = jwtExpiryMs(accessToken);

	return expiry !== undefined && expiry <= nowMs + accessTokenFreshnessMarginMs;
}

// Rotates the cupboard refresh token. A token the server refuses outright is
// a stale session, answered with undefined so the caller falls back; a
// transport or server failure propagates rather than misreporting the session
// as logged out.
async function rotateSession(
	client: SessionTokenClient,
	refreshToken: string
): Promise<CachedSession | undefined> {
	try {
		return sessionFromTokenResponse(await client.tokenRefresh(refreshToken));
	} catch (error) {
		if (isGrantRefusal(error)) {
			return undefined;
		}

		throw error;
	}
}

// Establishes a session from the deploy's stored Cloudflare grant: a fresh
// `id_token` (renewed through the grant's refresh token when stale) exchanged
// for cupboard tokens. No grant, an expired token, or a refused exchange all
// end at `cupboard login`.
async function establishSession(
	client: SessionTokenClient,
	chain: GrantChain,
	now: () => number
): Promise<CachedSession> {
	const idToken = await freshIdToken(chain);
	const expiry = idToken === undefined ? undefined : jwtExpiryMs(idToken);

	if (idToken === undefined || (expiry !== undefined && expiry <= now())) {
		throw new OwnerLoginRequiredError();
	}

	try {
		return sessionFromTokenResponse(
			await client.tokenExchange(idToken, subjectTokenTypeIdToken)
		);
	} catch (error) {
		if (isGrantRefusal(error)) {
			throw new OwnerLoginRequiredError();
		}

		throw error;
	}
}

// The OAuth error responses that mean "this credential does not work", as
// opposed to the endpoint being unreachable or broken.
function isGrantRefusal(error: unknown): boolean {
	return (
		error instanceof CupboardHttpError &&
		(error.status === 400 || error.status === 401)
	);
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
			fetcher: this.client.fetcher,
			signal: this.client.signal
		});
		const { access_token } = await this.client.tokenExchange(
			subjectToken,
			subjectTokenTypeIdToken
		);

		return access_token;
	}
}
