import { type AuthorizationDetails } from '@cupboard/protocol/grants';
import {
	subjectTokenTypeIdToken,
	type TokenResponse
} from '@cupboard/protocol/oidc';
import { StatusCodes } from 'http-status-codes';

import { throwIfAborted } from '../abort.ts';
import { type Audience } from '../audience.ts';
import { CupboardClient, type TokenProvider } from '../client/client.ts';
import { jwtExpiryMs } from '../deploy/cloudflare-oauth.ts';
import { CupboardHttpError, OwnerLoginRequiredError } from '../errors.ts';

import {
	fetchGithubOidcToken,
	type GithubOidcEnvironment
} from './github-oidc.ts';
import { hasOAuthErrorCode } from './oauth-error.ts';
import {
	type CachedSession,
	readCachedSession,
	sessionFromTokenResponse,
	withCachedSessionLock,
	writeCachedSession
} from './token-store.ts';

interface SessionTokenClient {
	tokenRefresh(refreshToken: string): Promise<TokenResponse>;
}

export interface OwnerSessionDependencies {
	readonly client?: SessionTokenClient;
	readonly readSession?: (target: URL) => Promise<CachedSession | undefined>;
	readonly writeSession?: (
		session: CachedSession,
		target: URL,
		signal?: AbortSignal
	) => Promise<void>;
	readonly withSessionLock?: <T>(
		target: URL,
		action: (signal?: AbortSignal) => Promise<T>,
		signal?: AbortSignal
	) => Promise<T>;
	readonly now?: () => number;
	readonly signal?: AbortSignal;
}

// An access token this close to its expiry is renewed up front.
const accessTokenFreshnessMarginMs = 30 * 1000;
const badRequestStatusCode: number = StatusCodes.BAD_REQUEST;

/**
 * Supplies the owner's admin token to the admin commands from the session
 * cached for `target`, and never opens a browser. A fresh cached access token
 * is used as is; an expired or refused one is renewed by rotating the cupboard
 * refresh token. When the session has no refresh token, or the server refuses
 * it, the provider throws `OwnerLoginRequiredError`, whose message tells the
 * user to run `cupboard login` again.
 */
export function cachedOwnerProvider(
	target: URL,
	dependencies: OwnerSessionDependencies = {}
): TokenProvider {
	const readSession = dependencies.readSession ?? readCachedSession;
	const writeSession = dependencies.writeSession ?? writeCachedSession;
	const withSessionLock = dependencies.withSessionLock ?? withCachedSessionLock;
	const now = dependencies.now ?? Date.now;

	const renew = (observed: CachedSession | undefined): Promise<string> =>
		withSessionLock(
			target,
			async (lockSignal) => {
				const signal = lockSignal ?? dependencies.signal;
				const client =
					dependencies.client ??
					CupboardClient.fromUrl(target, {
						cache: { kind: 'default' },
						signal
					});
				const session = await readSession(target);
				throwIfAborted(signal);

				if (
					session !== undefined &&
					!isSameSession(session, observed) &&
					!isAccessTokenExpired(session.accessToken, now())
				) {
					return session.accessToken;
				}

				const rotated =
					session?.refreshToken === undefined
						? undefined
						: await rotateSession(client, session.refreshToken);

				if (rotated === undefined) {
					throw new OwnerLoginRequiredError();
				}

				throwIfAborted(signal);
				await writeSession(rotated, target, signal);
				throwIfAborted(signal);

				return rotated.accessToken;
			},
			dependencies.signal
		);
	let activeRenewal: Promise<string> | undefined;
	const renewOnce = async (
		observed: CachedSession | undefined
	): Promise<string> => {
		if (activeRenewal !== undefined) {
			return activeRenewal;
		}

		const pending = renew(observed);
		activeRenewal = pending;

		try {
			return await pending;
		} finally {
			if (activeRenewal === pending) {
				activeRenewal = undefined;
			}
		}
	};

	return {
		async get(): Promise<string> {
			const session = await readSession(target);
			throwIfAborted(dependencies.signal);

			if (
				session !== undefined &&
				!isAccessTokenExpired(session.accessToken, now())
			) {
				return session.accessToken;
			}

			return renewOnce(session);
		},
		async refresh(): Promise<string> {
			const session = await readSession(target);
			throwIfAborted(dependencies.signal);

			return renewOnce(session);
		}
	};
}

function isSameSession(
	left: CachedSession,
	right: CachedSession | undefined
): boolean {
	if (right === undefined) {
		return false;
	}

	return (
		left.accessToken === right.accessToken &&
		left.refreshToken === right.refreshToken
	);
}

/**
 * Whether a cached access token is expired or expires within 30 seconds, and
 * so needs renewing before use.
 */
export function isAccessTokenExpired(
	accessToken: string,
	nowMs: number
): boolean {
	const expiry = jwtExpiryMs(accessToken);

	return expiry !== undefined && expiry <= nowMs + accessTokenFreshnessMarginMs;
}

// Rotates the cupboard refresh token. When the server refuses the refresh token
// outright, the cached session is stale, so this returns undefined and the
// caller throws `OwnerLoginRequiredError`. A transport or server failure propagates.
async function rotateSession(
	client: SessionTokenClient,
	refreshToken: string
): Promise<CachedSession | undefined> {
	try {
		return sessionFromTokenResponse(await client.tokenRefresh(refreshToken));
	} catch (error) {
		if (isStaleRefreshToken(error)) {
			return undefined;
		}

		throw error;
	}
}

function isStaleRefreshToken(error: unknown): boolean {
	return isBadRequest(error) && hasOAuthErrorCode(error, 'invalid_grant');
}

function isBadRequest(error: unknown): error is CupboardHttpError {
	return (
		error instanceof CupboardHttpError && error.status === badRequestStatusCode
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
	audience: Audience,
	options: {
		readonly environment?: GithubOidcEnvironment;
		readonly authorizationDetails?: AuthorizationDetails;
		readonly now?: () => number;
	} = {}
): Promise<TokenProvider> {
	const provider = new GithubOidcTokenProvider(
		client,
		audience,
		options.authorizationDetails,
		options.environment,
		options.now
	);
	await provider.get();

	return provider;
}

/**
 * A provider that exchanges a GitHub Actions OIDC token for a Cupboard token
 * on first use and, as the Cupboard token nears expiry, requests a new GitHub
 * token and exchanges that. Unlike {@link authenticateGithubOidc}, it does not
 * exchange up front. The first exchange happens at the first `get()`, and
 * `get()` throws any failure.
 */
export function githubOidcTokenProvider(
	client: CupboardClient,
	audience: Audience,
	authorizationDetails: AuthorizationDetails
): TokenProvider {
	return new GithubOidcTokenProvider(client, audience, authorizationDetails);
}

export interface PushAuthOptions {
	readonly githubOidc?: boolean;
	readonly audience: Audience;
	readonly environment?: GithubOidcEnvironment;
	// The grant the push requests; a CI (claim-bound) exchange must name it.
	readonly authorizationDetails?: AuthorizationDetails;
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
		return authenticateGithubOidc(client, options.audience, {
			environment: options.environment,
			authorizationDetails: options.authorizationDetails
		});
	}

	return Promise.resolve(
		cachedOwnerProvider(client.baseUrl, { signal: client.signal })
	);
}

// A CI exchange issues an access token with no refresh token, so a token this
// close to expiry is exchanged anew before it is handed out. GitHub issues
// fresh OIDC tokens throughout a job's lifetime, and every request resolves
// its bearer through the provider, so renewal on `get` keeps a run that
// outlives one token authenticated to the end. The margin matches the push's
// R2 credential renewal.
const exchangedTokenRenewalMarginMs = 5 * 60 * 1000;

class GithubOidcTokenProvider implements TokenProvider {
	#token: string | undefined;
	#expiresAtMs: number | undefined;

	constructor(
		private readonly client: CupboardClient,
		private readonly audience: string,
		private readonly authorizationDetails: AuthorizationDetails | undefined,
		private readonly environment?: GithubOidcEnvironment,
		private readonly now: () => number = Date.now
	) {}

	private async exchange(): Promise<string> {
		const subjectToken = await fetchGithubOidcToken({
			audience: this.audience,
			environment: this.environment,
			fetcher: this.client.fetcher,
			signal: this.client.signal
		});
		const { access_token, expires_in } = await this.client.tokenExchange(
			subjectToken,
			subjectTokenTypeIdToken,
			this.authorizationDetails
		);

		this.#token = access_token;
		this.#expiresAtMs = this.now() + expires_in * 1000;

		return access_token;
	}

	private isFresh(): boolean {
		return (
			this.#expiresAtMs !== undefined &&
			this.#expiresAtMs - this.now() > exchangedTokenRenewalMarginMs
		);
	}

	async get(): Promise<string> {
		const cached = this.#token;

		if (cached !== undefined && this.isFresh()) {
			return cached;
		}

		return this.exchange();
	}

	async refresh(): Promise<string> {
		return this.exchange();
	}
}
