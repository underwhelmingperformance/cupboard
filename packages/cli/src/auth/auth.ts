import { type AuthorizationDetails } from '@cupboard/protocol/grants';
import {
	type ParsedTokenResponse,
	subjectTokenProblemSchema,
	subjectTokenTypeIdToken
} from '@cupboard/protocol/oidc';
import { StatusCodes } from 'http-status-codes';

import { throwIfAborted } from '../abort.ts';
import { type Audience } from '../audience.ts';
import { CupboardClient, type TokenProvider } from '../client/client.ts';
import { type CredentialChain, freshIdToken } from '../deploy/auth.ts';
import {
	jwtExpiryMs,
	refreshCloudflareGrant
} from '../deploy/cloudflare-oauth.ts';
import {
	readCachedGrant,
	withCachedGrantLock,
	writeCachedGrant
} from '../deploy/grant-store.ts';
import { CupboardHttpError, OwnerLoginRequiredError } from '../errors.ts';

import {
	fetchGithubOidcToken,
	type GithubOidcEnvironment
} from './github-oidc.ts';
import { hasOAuthErrorCode, oauthErrorProblem } from './oauth-error.ts';
import {
	type CachedSession,
	readCachedSession,
	sessionFromTokenResponse,
	withCachedSessionLock,
	writeCachedSession
} from './token-store.ts';

interface SessionTokenClient {
	tokenRefresh(refreshToken: string): Promise<ParsedTokenResponse>;
	tokenExchange(
		subjectToken: string,
		subjectTokenType: string
	): Promise<ParsedTokenResponse>;
}

type GrantChain = Pick<
	CredentialChain,
	'readGrant' | 'writeGrant' | 'withGrantLock' | 'refreshGrant' | 'now'
>;

export interface OwnerSessionDependencies {
	readonly client?: SessionTokenClient;
	readonly grantChain?: GrantChain;
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
 * Supplies the owner's admin token to the admin commands, keeping the session
 * alive without a browser. A fresh cached access token is used as is; an
 * expired or refused one is renewed by rotating the cupboard refresh token,
 * falling back to exchanging a fresh `id_token` from the deploy's stored
 * Cloudflare grant. When neither silent path yields a token, the provider
 * throws `OwnerLoginRequiredError`, whose message tells the user to run
 * `cupboard login` again.
 */
export function cachedOwnerProvider(
	target: URL,
	dependencies: OwnerSessionDependencies = {}
): TokenProvider {
	const readSession = dependencies.readSession ?? readCachedSession;
	const writeSession = dependencies.writeSession ?? writeCachedSession;
	const withSessionLock = dependencies.withSessionLock ?? withCachedSessionLock;
	const grantChain = dependencies.grantChain ?? {
		readGrant: readCachedGrant,
		writeGrant: writeCachedGrant,
		withGrantLock: withCachedGrantLock,
		refreshGrant: (previous, signal = dependencies.signal) =>
			refreshCloudflareGrant(previous, undefined, Date.now, signal),
		now: Date.now
	};
	const now = dependencies.now ?? Date.now;

	const renew = (observed: CachedSession | undefined): Promise<string> =>
		withSessionLock(
			target,
			async (lockSignal) => {
				const signal = lockSignal ?? dependencies.signal;
				const client =
					dependencies.client ?? CupboardClient.fromUrl(target, { signal });
				const session = await readSession(target);
				throwIfAborted(signal);

				if (
					session !== undefined &&
					!isSameSession(session, observed) &&
					!isExpired(session.accessToken, now())
				) {
					return session.accessToken;
				}

				const rotated =
					session?.refreshToken === undefined
						? undefined
						: await rotateSession(client, session.refreshToken);
				const renewed =
					rotated ?? (await establishSession(client, grantChain, now, signal));

				throwIfAborted(signal);
				await writeSession(renewed, target, signal);
				throwIfAborted(signal);

				return renewed.accessToken;
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

			if (session !== undefined && !isExpired(session.accessToken, now())) {
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

function isExpired(accessToken: string, nowMs: number): boolean {
	const expiry = jwtExpiryMs(accessToken);

	return expiry !== undefined && expiry <= nowMs + accessTokenFreshnessMarginMs;
}

// Rotates the cupboard refresh token. A refresh token the server refuses
// outright means the cached session is stale, so this returns undefined and
// the caller falls back; a transport or server failure propagates.
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

// Establishes a session from the deploy's stored Cloudflare grant: a fresh
// `id_token` (renewed through the grant's refresh token when stale) exchanged
// for cupboard tokens. No grant, an expired token, or a refused exchange all
// end at `cupboard login`.
async function establishSession(
	client: SessionTokenClient,
	chain: GrantChain,
	now: () => number,
	signal?: AbortSignal
): Promise<CachedSession> {
	const idToken = await freshIdToken(chain, signal);
	const expiry = idToken === undefined ? undefined : jwtExpiryMs(idToken);

	if (idToken === undefined || (expiry !== undefined && expiry <= now())) {
		throw new OwnerLoginRequiredError();
	}

	try {
		return sessionFromTokenResponse(
			await client.tokenExchange(idToken, subjectTokenTypeIdToken)
		);
	} catch (error) {
		if (isStaleSubjectToken(error)) {
			throw new OwnerLoginRequiredError();
		}

		throw error;
	}
}

function isStaleRefreshToken(error: unknown): boolean {
	return isBadRequest(error) && hasOAuthErrorCode(error, 'invalid_grant');
}

function isStaleSubjectToken(error: unknown): boolean {
	if (!isBadRequest(error)) {
		return false;
	}

	if (hasOAuthErrorCode(error, 'invalid_grant')) {
		return true;
	}

	if (!hasOAuthErrorCode(error, 'invalid_request')) {
		return false;
	}

	return subjectTokenProblemSchema.safeParse(oauthErrorProblem(error)).success;
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
