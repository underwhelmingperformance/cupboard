import { z } from 'zod';

import { throwIfAborted } from '../abort.ts';
import { decodeJwtPayload } from '../auth/jwt.ts';
import { obtainAuthorizationCode, postForm } from '../auth/oidc-login.ts';
import { resilientFetcher } from '../client/transport.ts';
import { CliError } from '../errors.ts';

export abstract class CloudflareLoginError extends CliError {}

export class CloudflareTokenRequestError extends CloudflareLoginError {
	constructor(public readonly status: number) {
		super(`Cloudflare token request failed with HTTP ${String(status)}`);
		this.name = 'CloudflareTokenRequestError';
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

const authorizationEndpoint = 'https://dash.cloudflare.com/oauth2/auth';
const tokenEndpoint = 'https://dash.cloudflare.com/oauth2/token';

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
 * The scopes every login requests: what the deploy pipeline needs, as
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
	The raw id_token, presentable as a subject token to a cupboard server.
	*/
	readonly idToken: string | undefined;
}

export interface CloudflareLoginOptions {
	readonly openBrowser: (url: string) => void | Promise<void>;
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
 * whether a cached ID token is worth presenting. The server verifies the token.
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

	const fetcher = options.fetcher ?? resilientFetcher();
	const now = options.now ?? Date.now;

	const obtained = await obtainAuthorizationCode({
		authorizationEndpoint,
		clientId: cloudflareOauthClientId,
		scope: deployScopes.join(' '),
		openBrowser: options.openBrowser,
		timeoutMs: options.timeoutMs,
		signal: options.signal,
		loopback: {
			ports: options.ports ?? callbackPorts,
			host: 'localhost',
			path: callbackPath
		}
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
 * Attempts to renew a grant while preserving its subject. Returns `undefined`
 * when there is no refresh token or any part of the exchange fails, including
 * cancellation. Callers then fall back to interactive login.
 */
export async function refreshCloudflareGrant(
	previous: CloudflareGrant,
	fetcher: typeof fetch = resilientFetcher(),
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
	} catch {
		return undefined;
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

	if (!response.ok) {
		throw new CloudflareTokenRequestError(response.status);
	}

	let payload: unknown;

	try {
		payload = await response.json();
	} catch (error) {
		throw new CloudflareTokenResponseNotJsonError({ cause: error });
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
		// The server may rotate the refresh token on use, and a refresh response
		// may omit the id_token. Keep the previous values when the response omits
		// their replacements.
		refreshToken: parsed.data.refresh_token ?? previous?.refreshToken,
		expiresAt: now() + expiresIn * 1000,
		subject: subject ?? previous?.subject,
		idToken: parsed.data.id_token ?? previous?.idToken
	};
}
