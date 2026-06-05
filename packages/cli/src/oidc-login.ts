import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

import { isAllowedIssuerUrl, IssuerUrl } from '@cupboard/protocol/oidc-issuer';
import { z } from 'zod';

import { CliError } from './errors.ts';

export class OidcLoginError extends CliError {
	constructor(message: string, options?: { readonly cause: unknown }) {
		super(message, options);
		this.name = 'OidcLoginError';
	}
}

export interface Pkce {
	readonly verifier: string;
	readonly challenge: string;
}

/** A PKCE verifier and its S256 challenge (RFC 7636). */
export function createPkce(): Pkce {
	const verifier = randomBytes(32).toString('base64url');
	const challenge = createHash('sha256').update(verifier).digest('base64url');

	return { verifier, challenge };
}

function randomState(): string {
	return randomBytes(16).toString('base64url');
}

export interface OidcLoginEndpoints {
	readonly authorizationEndpoint: string;
	readonly tokenEndpoint: string;
	readonly deviceAuthorizationEndpoint?: string;
}

// The endpoints carry the authorization code, PKCE verifier and device code, so
// they are held to the same transport rule as the issuer: https, or http only
// for loopback. A tampered discovery document cannot redirect them to plain http.
const endpointUrl = z.url().refine(isAllowedIssuerUrl);

const endpointsSchema = z.object({
	issuer: z.url(),
	authorization_endpoint: endpointUrl,
	token_endpoint: endpointUrl,
	device_authorization_endpoint: endpointUrl.optional()
});

/**
 * Reads an issuer's authorization, token and device endpoints from its OIDC
 * metadata. The issuer must be an https URL (loopback excepted) and the
 * document's own `issuer` must match it, so a misconfigured or hostile document
 * cannot send the login flow to another provider's endpoints.
 */
export async function discoverOidcLogin(
	issuer: string,
	fetcher: typeof fetch = fetch
): Promise<OidcLoginEndpoints> {
	const issuerUrl = IssuerUrl.parse(issuer);

	if (issuerUrl === undefined) {
		throw new OidcLoginError(
			`Issuer ${issuer} must be an https URL (http only for loopback)`
		);
	}

	let payload: unknown;

	try {
		// Do not follow redirects, matching the server's discovery fetch: a
		// redirect from the issuer's metadata endpoint could serve a document that
		// keeps the issuer but points the token endpoint at an attacker, who would
		// then receive the authorization code and PKCE verifier. A 3xx fails the
		// `ok` check below.
		const response = await fetcher(issuerUrl.discoveryUrl, {
			redirect: 'manual'
		});

		if (!response.ok) {
			throw new Error(
				`discovery responded with HTTP ${String(response.status)}`
			);
		}

		payload = await response.json();
	} catch (error) {
		throw new OidcLoginError(`Could not read OIDC metadata for ${issuer}`, {
			cause: error
		});
	}

	const parsed = endpointsSchema.safeParse(payload);

	if (!parsed.success) {
		throw new OidcLoginError(
			`OIDC metadata for ${issuer} is missing endpoints`,
			{
				cause: parsed.error
			}
		);
	}

	if (!issuerUrl.matches(parsed.data.issuer)) {
		throw new OidcLoginError(
			`OIDC metadata issuer ${parsed.data.issuer} does not match ${issuer}`
		);
	}

	return {
		authorizationEndpoint: parsed.data.authorization_endpoint,
		tokenEndpoint: parsed.data.token_endpoint,
		deviceAuthorizationEndpoint: parsed.data.device_authorization_endpoint
	};
}

const idTokenSchema = z.object({ id_token: z.string().min(1) });

const loopbackLoginTimeoutMs = 5 * 60 * 1000;

export interface LoopbackLoginOptions {
	readonly endpoints: OidcLoginEndpoints;
	readonly clientId: string;
	readonly scope?: string;
	readonly openBrowser: (url: string) => void | Promise<void>;
	readonly fetcher?: typeof fetch;
	readonly timeoutMs?: number;
}

/**
 * The default owner-login flow: PKCE with a 127.0.0.1 loopback redirect. Binds a
 * throwaway server, opens the browser to the issuer's authorization endpoint,
 * catches the redirect, and exchanges the code for an `id_token`. `state` and the
 * PKCE verifier guard the exchange; the redirect is accepted only on loopback.
 */
export async function loopbackLogin(
	options: LoopbackLoginOptions
): Promise<string> {
	const fetcher = options.fetcher ?? fetch;
	const timeoutMs = options.timeoutMs ?? loopbackLoginTimeoutMs;
	const pkce = createPkce();
	const state = randomState();
	const loopback = await startLoopbackServer(state);
	let timer: ReturnType<typeof setTimeout> | undefined;

	try {
		const redirectUri = `http://127.0.0.1:${String(loopback.port)}/callback`;
		const authorizeUrl = buildAuthorizeUrl(
			options.endpoints.authorizationEndpoint,
			{
				clientId: options.clientId,
				redirectUri,
				state,
				challenge: pkce.challenge,
				scope: options.scope ?? 'openid'
			}
		);

		await options.openBrowser(authorizeUrl);

		// A login the user never finishes would otherwise hang the CLI on the
		// pending callback, so the wait is bounded; the timer is cleared below.
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				reject(
					new OidcLoginError(
						'Timed out waiting for the browser to complete login'
					)
				);
			}, timeoutMs);
		});
		const code = await Promise.race([loopback.code, timeout]);

		return await exchangeCode(options.endpoints, fetcher, {
			grant_type: 'authorization_code',
			code,
			redirect_uri: redirectUri,
			client_id: options.clientId,
			code_verifier: pkce.verifier
		});
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}

		loopback.server.close();
	}
}

function buildAuthorizeUrl(
	endpoint: string,
	parameters: {
		readonly clientId: string;
		readonly redirectUri: string;
		readonly state: string;
		readonly challenge: string;
		readonly scope: string;
	}
): string {
	const url = new URL(endpoint);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('client_id', parameters.clientId);
	url.searchParams.set('redirect_uri', parameters.redirectUri);
	url.searchParams.set('scope', parameters.scope);
	url.searchParams.set('state', parameters.state);
	url.searchParams.set('code_challenge', parameters.challenge);
	url.searchParams.set('code_challenge_method', 'S256');

	return url.toString();
}

interface LoopbackServer {
	readonly server: Server;
	readonly port: number;
	readonly code: Promise<string>;
}

function startLoopbackServer(expectedState: string): Promise<LoopbackServer> {
	return new Promise((resolveServer, rejectServer) => {
		let resolveCode!: (code: string) => void;
		let rejectCode!: (error: Error) => void;
		const code = new Promise<string>((resolve, reject) => {
			resolveCode = resolve;
			rejectCode = reject;
		});

		const server = createServer((request, response) => {
			const url = new URL(request.url ?? '/', 'http://127.0.0.1');

			if (url.pathname !== '/callback') {
				response.writeHead(404);
				response.end();
				return;
			}

			const outcome = readCallback(url, expectedState);
			response.writeHead(outcome.kind === 'code' ? 200 : 400, {
				'content-type': 'text/plain; charset=utf-8'
			});
			response.end(outcome.message);

			// A stray request, or one whose `state` is not ours, is answered but
			// otherwise ignored so it cannot abort an in-flight login; only the
			// matching redirect resolves or rejects the wait.
			if (outcome.kind === 'code') {
				resolveCode(outcome.code);
			} else if (outcome.kind === 'error') {
				rejectCode(new OidcLoginError(outcome.message));
			}
		});

		server.on('error', rejectServer);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();

			if (address === null || typeof address === 'string') {
				rejectServer(new OidcLoginError('Could not bind the loopback server'));
				return;
			}

			resolveServer({ server, port: address.port, code });
		});
	});
}

type CallbackOutcome =
	| { readonly kind: 'code'; readonly code: string; readonly message: string }
	| { readonly kind: 'error'; readonly message: string }
	| { readonly kind: 'ignore'; readonly message: string };

function readCallback(url: URL, expectedState: string): CallbackOutcome {
	// `state` is checked first: a request that is not for this login (no state or
	// a stale one) is ignored rather than failing the flow.
	if (url.searchParams.get('state') !== expectedState) {
		return { kind: 'ignore', message: 'Unexpected callback; ignoring.' };
	}

	const error = url.searchParams.get('error');

	if (error !== null) {
		return { kind: 'error', message: `Authorization failed: ${error}` };
	}

	const code = url.searchParams.get('code');

	if (code === null || code === '') {
		return { kind: 'error', message: 'Authorization response carried no code' };
	}

	return {
		kind: 'code',
		code,
		message: 'cupboard login complete. You may close this window.'
	};
}

export interface DeviceLoginOptions {
	readonly endpoints: OidcLoginEndpoints;
	readonly clientId: string;
	readonly scope?: string;
	readonly prompt: (verification: {
		readonly userCode: string;
		readonly verificationUri: string;
	}) => void;
	readonly fetcher?: typeof fetch;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly now?: () => number;
}

const deviceAuthorizationSchema = z.object({
	device_code: z.string().min(1),
	user_code: z.string().min(1),
	verification_uri: z.string().min(1),
	expires_in: z.number().int().positive().optional(),
	interval: z.number().int().positive().optional()
});

// RFC 8628 makes `expires_in` required; an issuer that omits it still gets a
// bounded poll rather than an unbounded one.
const deviceCodeFallbackLifetimeSeconds = 600;

// The poll interval used when the issuer advertises none, and the increment
// applied on a `slow_down` — both 5 seconds, per the RFC 8628 example.
const devicePollIntervalSeconds = 5;
const deviceSlowDownIncrementMs = 5 * 1000;

const deviceErrorSchema = z.object({ error: z.string() });

/**
 * The `--headless` owner-login flow: RFC 8628 device authorization. Asks the
 * issuer for a code, shows the user where to enter it, and polls the token
 * endpoint — honouring `authorization_pending` and `slow_down` — until an
 * `id_token` is issued.
 */
export async function deviceLogin(
	options: DeviceLoginOptions
): Promise<string> {
	const endpoint = options.endpoints.deviceAuthorizationEndpoint;

	if (endpoint === undefined) {
		throw new OidcLoginError('The issuer does not support the device flow');
	}

	const fetcher = options.fetcher ?? fetch;
	const sleep = options.sleep ?? delay;
	const now = options.now ?? Date.now;

	const authorization = await requestDeviceCode(endpoint, fetcher, {
		client_id: options.clientId,
		scope: options.scope ?? 'openid'
	});
	options.prompt({
		userCode: authorization.user_code,
		verificationUri: authorization.verification_uri
	});

	let intervalMs = (authorization.interval ?? devicePollIntervalSeconds) * 1000;
	const deadlineMs =
		now() +
		(authorization.expires_in ?? deviceCodeFallbackLifetimeSeconds) * 1000;

	for (;;) {
		await sleep(intervalMs);

		if (now() >= deadlineMs) {
			throw new OidcLoginError(
				'Device authorization expired before it was approved'
			);
		}

		const outcome = await pollDeviceToken(options.endpoints, fetcher, {
			grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
			device_code: authorization.device_code,
			client_id: options.clientId
		});

		if (outcome.kind === 'token') {
			return outcome.idToken;
		}

		if (outcome.kind === 'slow_down') {
			intervalMs += deviceSlowDownIncrementMs;
		} else if (outcome.kind === 'denied') {
			throw new OidcLoginError(`Device authorization failed: ${outcome.error}`);
		}
	}
}

async function requestDeviceCode(
	endpoint: string,
	fetcher: typeof fetch,
	form: Readonly<Record<string, string>>
): Promise<z.infer<typeof deviceAuthorizationSchema>> {
	const response = await fetcher(endpoint, postForm(form));

	if (!response.ok) {
		throw new OidcLoginError(
			`Device authorization request failed with HTTP ${String(response.status)}`
		);
	}

	const parsed = deviceAuthorizationSchema.safeParse(await readJson(response));

	if (!parsed.success) {
		throw new OidcLoginError('Device authorization response was malformed', {
			cause: parsed.error
		});
	}

	return parsed.data;
}

type PollOutcome =
	| { readonly kind: 'token'; readonly idToken: string }
	| { readonly kind: 'pending' }
	| { readonly kind: 'slow_down' }
	| { readonly kind: 'denied'; readonly error: string };

async function pollDeviceToken(
	endpoints: OidcLoginEndpoints,
	fetcher: typeof fetch,
	form: Readonly<Record<string, string>>
): Promise<PollOutcome> {
	const response = await fetcher(endpoints.tokenEndpoint, postForm(form));
	const payload = await readJson(response);

	if (response.ok) {
		const parsed = idTokenSchema.safeParse(payload);

		if (!parsed.success) {
			throw new OidcLoginError('Device token response carried no id_token');
		}

		return { kind: 'token', idToken: parsed.data.id_token };
	}

	const error = deviceErrorSchema.safeParse(payload);

	if (error.success && error.data.error === 'authorization_pending') {
		return { kind: 'pending' };
	}

	if (error.success && error.data.error === 'slow_down') {
		return { kind: 'slow_down' };
	}

	return {
		kind: 'denied',
		error: error.success ? error.data.error : 'unknown'
	};
}

// A token endpoint can return a non-JSON body (an HTML error page, a proxy
// notice); parse defensively so that surfaces as an `OidcLoginError` rather than
// a raw `SyntaxError`.
async function readJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch (error) {
		throw new OidcLoginError('OIDC endpoint returned a non-JSON response', {
			cause: error
		});
	}
}

async function exchangeCode(
	endpoints: OidcLoginEndpoints,
	fetcher: typeof fetch,
	form: Readonly<Record<string, string>>
): Promise<string> {
	const response = await fetcher(endpoints.tokenEndpoint, postForm(form));

	if (!response.ok) {
		throw new OidcLoginError(
			`Token exchange failed with HTTP ${String(response.status)}`
		);
	}

	const parsed = idTokenSchema.safeParse(await readJson(response));

	if (!parsed.success) {
		throw new OidcLoginError('Token response carried no id_token');
	}

	return parsed.data.id_token;
}

function postForm(form: Readonly<Record<string, string>>): RequestInit {
	return {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(form).toString()
	};
}
