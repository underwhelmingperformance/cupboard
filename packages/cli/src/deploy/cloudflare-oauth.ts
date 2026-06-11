import { z } from 'zod';

import { obtainAuthorizationCode, postForm } from '../auth/oidc-login.ts';
import { CliError } from '../errors.ts';

/** Base of every failure mode of the Cloudflare browser login. */
export abstract class CloudflareLoginError extends CliError {}

export class CloudflareTokenRequestError extends CloudflareLoginError {
	constructor(public readonly status: number) {
		super(`Cloudflare token request failed with HTTP ${String(status)}`);
		this.name = 'CloudflareTokenRequestError';
	}
}

/** Base of the malformed-token-response failures. */
export abstract class CloudflareTokenResponseError extends CloudflareLoginError {}

export class CloudflareTokenResponseNotJsonError extends CloudflareTokenResponseError {
	constructor(options: { readonly cause: unknown }) {
		super('Cloudflare token endpoint returned a non-JSON response', options);
		this.name = 'CloudflareTokenResponseNotJsonError';
	}
}

export class CloudflareTokenResponseMalformedError extends CloudflareTokenResponseError {
	constructor(options: { readonly cause: unknown }) {
		super('Cloudflare token response carried no access token', options);
		this.name = 'CloudflareTokenResponseMalformedError';
	}
}

/**
 * cupboard's public OAuth client, registered on Cloudflare. A public client
 * carries no secret; the authorization code flow is bound by PKCE instead.
 */
export const cloudflareOauthClientId = '6c915db1f16ece47255821ee6ca1d538';

const authorizationEndpoint = 'https://dash.cloudflare.com/oauth2/auth';
const tokenEndpoint = 'https://dash.cloudflare.com/oauth2/token';

// The client's pre-registered redirect URLs are exact-match, so the loopback
// server must bind one of these ports and the redirect URI must use the
// `localhost` spelling they were registered with.
const callbackPorts: readonly number[] = [8377, 8378, 8379];
const callbackPath = '/oauth/callback';

/**
 * The scopes every login requests: what the deploy pipeline needs, as
 * registered on the OAuth client (scope ids correspond to Cloudflare API token
 * permission names), plus `offline_access` so the grant carries a refresh
 * token and repeat deploys do not reopen the browser.
 */
export const deployScopes: readonly string[] = [
	'account-settings.write',
	'd1.write',
	'offline_access',
	'queues.write',
	'workers-kv-storage.write',
	'workers-r2.write',
	'workers-routes.write',
	'workers-scripts.write',
	'zone.read'
];

const defaultAccessTokenLifetimeSeconds = 3600;

/** An issued Cloudflare grant: a Bearer token, and the means to renew it. */
export interface CloudflareGrant {
	readonly accessToken: string;
	readonly refreshToken: string | undefined;
	/** Epoch milliseconds after which `accessToken` must not be used. */
	readonly expiresAt: number;
}

export interface CloudflareLoginOptions {
	readonly openBrowser: (url: string) => void | Promise<void>;
	readonly fetcher?: typeof fetch;
	readonly timeoutMs?: number;
	readonly ports?: readonly number[];
	readonly now?: () => number;
}

const tokenResponseSchema = z.object({
	access_token: z.string().min(1),
	refresh_token: z.string().min(1).optional(),
	expires_in: z.number().int().positive().optional()
});

/**
 * Logs in to Cloudflare as cupboard's OAuth client: PKCE with a loopback
 * redirect on one of the client's registered ports.
 */
export async function cloudflareLogin(
	options: CloudflareLoginOptions
): Promise<CloudflareGrant> {
	const fetcher = options.fetcher ?? fetch;
	const now = options.now ?? Date.now;

	const obtained = await obtainAuthorizationCode({
		authorizationEndpoint,
		clientId: cloudflareOauthClientId,
		scope: deployScopes.join(' '),
		openBrowser: options.openBrowser,
		timeoutMs: options.timeoutMs,
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
		now
	);
}

/**
 * Renews a grant from its refresh token. Returns undefined when Cloudflare
 * declines (a revoked or expired grant) or the endpoint is unreachable, so the
 * caller can fall back to an interactive login.
 */
export async function refreshCloudflareGrant(
	refreshToken: string,
	fetcher: typeof fetch = fetch,
	now: () => number = Date.now
): Promise<CloudflareGrant | undefined> {
	try {
		return await exchangeForGrant(
			fetcher,
			{
				grant_type: 'refresh_token',
				refresh_token: refreshToken,
				client_id: cloudflareOauthClientId
			},
			now,
			refreshToken
		);
	} catch {
		return undefined;
	}
}

async function exchangeForGrant(
	fetcher: typeof fetch,
	form: Readonly<Record<string, string>>,
	now: () => number,
	previousRefreshToken?: string
): Promise<CloudflareGrant> {
	const response = await fetcher(tokenEndpoint, postForm(form));

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

	return {
		accessToken: parsed.data.access_token,
		// The server may rotate the refresh token on use; keep the previous one
		// only when no replacement is issued.
		refreshToken: parsed.data.refresh_token ?? previousRefreshToken,
		expiresAt: now() + expiresIn * 1000
	};
}
