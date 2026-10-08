import { discardResponseBody } from '@cupboard/shared/cleanup';
import { readResponseJson } from '@cupboard/shared/response-body';
import { z } from 'zod';

import { throwIfAborted } from '../abort.ts';
import { decodeJwtPayload } from '../auth/jwt.ts';
import {
	hasOAuthErrorCode,
	type OAuthErrorResponse,
	parseOAuthErrorResponse
} from '../auth/oauth-error.ts';
import {
	isRedirectStatus,
	obtainAuthorizationCode,
	type PastedRedirectReader,
	postForm
} from '../auth/oidc-login.ts';
import { postRevocation, type RevocationOutcome } from '../auth/revocation.ts';
import { resilientFetcher } from '../client/transport.ts';
import { CliError } from '../errors.ts';

export abstract class CloudflareLoginError extends CliError {}

export class CloudflareTokenRequestError extends CloudflareLoginError {
	readonly providerError: string | undefined;

	constructor(
		public readonly status: number,
		public readonly oauthError: OAuthErrorResponse | undefined
	) {
		const detail = oauthError === undefined ? '' : `: ${oauthError.error}`;

		super(
			`Cloudflare token request failed with HTTP ${String(status)}${detail}`
		);
		this.name = 'CloudflareTokenRequestError';
		this.providerError = oauthError?.error;
	}
}

export abstract class CloudflareTokenResponseError extends CloudflareLoginError {}

export class CloudflareTokenResponseNotJsonError extends CloudflareTokenResponseError {
	constructor(options: { readonly cause: unknown }) {
		super('Cloudflare token endpoint returned a non-JSON response', options);
		this.name = 'CloudflareTokenResponseNotJsonError';
	}
}

export class CloudflareTokenResponseMalformedError extends CloudflareTokenResponseError {
	constructor(options: { readonly cause: unknown }) {
		super('Cloudflare token response did not include an access token', options);
		this.name = 'CloudflareTokenResponseMalformedError';
	}
}

/**
 * Cupboard's public OAuth client, registered on Cloudflare. A public client
 * has no secret; PKCE binds the authorization code flow instead.
 */
export const cloudflareOauthClientId = '6c915db1f16ece47255821ee6ca1d538';

/**
 * The issuer of the Cloudflare login. `cupboard init` and `cupboard login` use
 * it for the admin's identity unless `--oidc-issuer` specifies another.
 */
export const cloudflareDashIssuer = 'https://dash.cloudflare.com';

const authorizationEndpoint = 'https://dash.cloudflare.com/oauth2/auth';
const tokenEndpoint = 'https://dash.cloudflare.com/oauth2/token';
const revocationEndpoint = 'https://dash.cloudflare.com/oauth2/revoke';

// The client's pre-registered redirect URLs are exact-match, so the loopback
// server must bind one of these ports and the redirect URI must use the
// `localhost` spelling they were registered with.
const callbackPorts: readonly number[] = [8377, 8378, 8379];
const callbackPath = '/oauth/callback';

export const cloudflareLoopback = {
	ports: callbackPorts,
	host: 'localhost',
	path: callbackPath
} as const;

/**
 * The scopes that a deploy's login requests: what the deploy pipeline needs, as
 * registered on the OAuth client (scope ids correspond to Cloudflare API token
 * permission names), plus `offline_access` so the grant includes a refresh
 * token and repeat deploys do not reopen the browser, and `openid` so the
 * grant includes the deployer's identity in an ID token.
 */
export const deployScopes: readonly string[] = [
	'account-settings.write',
	'd1.write',
	'offline_access',
	'openid',
	'queues.write',
	'workers-kv-storage.write',
	'workers-r2.write',
	'workers-routes.write',
	'workers-scripts.write',
	'zone.read'
];

/**
 * The scopes of a sign-in that only needs an ID token. Cloudflare refuses a
 * request for `openid` alone at the consent step, so this is the deploy's set
 * without `offline_access`. Without that scope, Cloudflare issues no refresh
 * token.
 */
export const signInScopes: readonly string[] = deployScopes.filter(
	(scope) => scope !== 'offline_access'
);

const defaultAccessTokenLifetimeSeconds = 3600;

export interface CloudflareGrant {
	readonly accessToken: string;
	readonly refreshToken: string | undefined;
	/**
	Epoch milliseconds after which `accessToken` must not be used.
	*/
	readonly expiresAt: number;
	/**
	The Cloudflare user the grant belongs to (the id_token `sub`).
	*/
	readonly subject: string | undefined;
	/**
	 * The raw id_token. Only the token from a browser login can be presented to
	 * a cupboard server: a refreshed one repeats the nonce of the original
	 * login.
	 */
	readonly idToken: string | undefined;
}

export interface CloudflareLoginOptions {
	/**
	The OIDC `nonce` that the grant's ID token must contain.
	*/
	readonly nonce: string;
	/**
	The scopes to request. The default is {@link deployScopes}.
	*/
	readonly scopes?: readonly string[];
	readonly openBrowser: (url: string) => void | Promise<void>;
	readonly readPastedRedirect?: PastedRedirectReader;
	readonly fetcher?: typeof fetch;
	readonly timeoutMs?: number;
	readonly ports?: readonly number[];
	readonly now?: () => number;
	readonly signal?: AbortSignal;
}

const tokenResponseSchema = z.object({
	access_token: z.string().min(1),
	refresh_token: z.string().min(1).optional(),
	expires_in: z.number().int().positive().optional(),
	id_token: z.string().min(1).optional()
});

const idTokenClaimsSchema = z.object({ sub: z.string().min(1) });
const idTokenExpirySchema = z.object({ exp: z.number() });

// The `sub` of an id_token, or undefined when the token does not parse. The
// claim is read unverified: it only seeds a default the user reviews in the
// plan, and the server verifies the real login token against the issuer.
function jwtSubject(idToken: string): string | undefined {
	const parsed = idTokenClaimsSchema.safeParse(decodeJwtPayload(idToken));

	return parsed.success ? parsed.data.sub : undefined;
}

/**
 * The token's `exp` in epoch milliseconds, or undefined when the token does
 * not parse or has no `exp`. The claim is unverified here: it only decides
 * whether a cached access token needs renewing. The server verifies the token.
 */
export function jwtExpiryMs(token: string): number | undefined {
	const parsed = idTokenExpirySchema.safeParse(decodeJwtPayload(token));

	return parsed.success ? parsed.data.exp * 1000 : undefined;
}

/**
 * Logs in to Cloudflare as cupboard's OAuth client: PKCE with a loopback
 * redirect on one of the client's registered ports.
 */
export async function cloudflareLogin(
	options: CloudflareLoginOptions
): Promise<CloudflareGrant> {
	throwIfAborted(options.signal);

	const fetcher = options.fetcher ?? resilientFetcher('replay-unsafe');
	const now = options.now ?? Date.now;

	const obtained = await obtainAuthorizationCode({
		// Cloudflare's metadata does not advertise RFC 9207 support, so a
		// callback can arrive without `iss`.
		expectedIssuer: cloudflareDashIssuer,
		isIssuerParameterOptional: true,
		authorizationEndpoint,
		clientId: cloudflareOauthClientId,
		scope: (options.scopes ?? deployScopes).join(' '),
		nonce: options.nonce,
		openBrowser: options.openBrowser,
		timeoutMs: options.timeoutMs,
		signal: options.signal,
		loopback: {
			ports: options.ports ?? callbackPorts,
			host: 'localhost',
			path: callbackPath
		},
		readPastedRedirect: options.readPastedRedirect
	});

	return exchangeForGrant(
		fetcher,
		{
			grant_type: 'authorization_code',
			code: obtained.code,
			redirect_uri: obtained.redirectUri,
			client_id: cloudflareOauthClientId,
			code_verifier: obtained.codeVerifier
		},
		now,
		undefined,
		options.signal
	);
}

/**
 * Renews a grant from its refresh token and preserves the subject. Returns
 * `undefined` if the grant has no refresh token or Cloudflare rejects it with
 * `invalid_grant`, which lets the caller start an interactive login. Transport,
 * server, and malformed-response failures propagate to the caller.
 */
export async function refreshCloudflareGrant(
	previous: CloudflareGrant,
	fetcher: typeof fetch = resilientFetcher('replay-unsafe'),
	now: () => number = Date.now,
	signal?: AbortSignal
): Promise<CloudflareGrant | undefined> {
	throwIfAborted(signal);

	if (previous.refreshToken === undefined) {
		return undefined;
	}

	try {
		return await exchangeForGrant(
			fetcher,
			{
				grant_type: 'refresh_token',
				refresh_token: previous.refreshToken,
				client_id: cloudflareOauthClientId
			},
			now,
			previous,
			signal
		);
	} catch (error) {
		if (hasOAuthErrorCode(error, 'invalid_grant')) {
			return undefined;
		}

		throw error;
	}
}

/**
 * Sends Cloudflare a revocation request for a grant's refresh token (RFC 7009).
 * Cupboard is a public client, so the request includes its client ID.
 */
export function revokeCloudflareGrant(
	grant: CloudflareGrant,
	fetcher: typeof fetch,
	signal?: AbortSignal
): Promise<RevocationOutcome> {
	if (grant.refreshToken === undefined) {
		return Promise.resolve('no-refresh-token');
	}

	return postRevocation(
		revocationEndpoint,
		{
			token: grant.refreshToken,
			token_type_hint: 'refresh_token',
			client_id: cloudflareOauthClientId
		},
		fetcher,
		signal
	);
}

const maximumTokenResponseBytes = 64 * 1024;

async function tokenResponsePayload(response: Response): Promise<unknown> {
	try {
		return await readResponseJson(response, {
			description: 'Cloudflare token response',
			maximumBytes: maximumTokenResponseBytes
		});
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new CloudflareTokenResponseNotJsonError({ cause: error });
		}

		throw error;
	}
}

async function exchangeForGrant(
	fetcher: typeof fetch,
	form: Readonly<Record<string, string>>,
	now: () => number,
	previous?: Pick<CloudflareGrant, 'refreshToken' | 'subject' | 'idToken'>,
	signal?: AbortSignal
): Promise<CloudflareGrant> {
	const response = await fetcher(tokenEndpoint, postForm(form, signal));

	if (isRedirectStatus(response.status)) {
		await discardResponseBody(response);
		throw new CloudflareTokenRequestError(response.status, undefined);
	}

	const payload = await tokenResponsePayload(response);

	if (!response.ok) {
		throw new CloudflareTokenRequestError(
			response.status,
			parseOAuthErrorResponse(payload)
		);
	}

	const parsed = tokenResponseSchema.safeParse(payload);

	if (!parsed.success) {
		throw new CloudflareTokenResponseMalformedError({ cause: parsed.error });
	}

	const expiresIn = parsed.data.expires_in ?? defaultAccessTokenLifetimeSeconds;
	const subject =
		parsed.data.id_token === undefined
			? undefined
			: jwtSubject(parsed.data.id_token);

	return {
		accessToken: parsed.data.access_token,
		// The server may rotate the refresh token on use. A response without an
		// id_token does not renew the old token, which may already be expired.
		refreshToken: parsed.data.refresh_token ?? previous?.refreshToken,
		expiresAt: now() + expiresIn * 1000,
		subject: subject ?? previous?.subject,
		idToken: parsed.data.id_token
	};
}
