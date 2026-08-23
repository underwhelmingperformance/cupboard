import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import { isAllowedIssuerUrl, IssuerUrl } from '@cupboard/protocol/oidc-issuer';
import { z } from 'zod';

import { abortable, delayMs, throwIfAborted } from '../abort.ts';
import { resilientFetcher } from '../client/transport.ts';
import { CliError } from '../errors.ts';

export interface OidcLoginErrorOptions {
	readonly cause?: unknown;
	readonly issuer?: string;
	readonly kind?: OidcLoginErrorKind;
	readonly metadataIssuer?: string;
	readonly providerError?: string;
	readonly status?: number;
}

export type OidcLoginErrorKind =
	| 'authorization-declined'
	| 'device-authorization-http'
	| 'device-authorization-non-json'
	| 'device-authorization-schema'
	| 'device-denied'
	| 'device-expired'
	| 'device-token-non-json'
	| 'device-token-response'
	| 'discovery-http'
	| 'discovery-non-json'
	| 'discovery-request'
	| 'discovery-schema'
	| 'generic'
	| 'invalid-issuer'
	| 'issuer-mismatch'
	| 'loopback-bind'
	| 'loopback-timeout'
	| 'token-http'
	| 'token-non-json'
	| 'token-response'
	| 'unsupported-device-flow';

export class OidcLoginError extends CliError {
	readonly kind: OidcLoginErrorKind;

	readonly issuer: string | undefined;

	readonly metadataIssuer: string | undefined;

	readonly providerError: string | undefined;

	readonly status: number | undefined;

	constructor(message: string, options: OidcLoginErrorOptions = {}) {
		super(
			message,
			options.cause === undefined ? undefined : { cause: options.cause }
		);
		this.name = 'OidcLoginError';
		this.kind = options.kind ?? 'generic';
		this.issuer = options.issuer;
		this.metadataIssuer = options.metadataIssuer;
		this.providerError = options.providerError;
		this.status = options.status;
	}
}

export abstract class AuthorizationDeclinedError extends OidcLoginError {
	static fromProviderCode(code: string): AuthorizationDeclinedError {
		switch (code) {
			case 'access_denied': {
				return new AuthorizationAccessDeniedError();
			}
			case 'invalid_scope': {
				return new AuthorizationInvalidScopeError();
			}
			default: {
				return new AuthorizationProviderError(code);
			}
		}
	}

	protected constructor(public readonly providerError: string) {
		super(`Authorization failed: ${providerError}`, {
			kind: 'authorization-declined',
			providerError
		});
	}
}

export class AuthorizationAccessDeniedError extends AuthorizationDeclinedError {
	constructor() {
		super('access_denied');
		this.name = 'AuthorizationAccessDeniedError';
	}
}

export class AuthorizationInvalidScopeError extends AuthorizationDeclinedError {
	constructor() {
		super('invalid_scope');
		this.name = 'AuthorizationInvalidScopeError';
	}
}

/**
Preserves an unrecognised RFC 6749 error code for the caller.
*/
export class AuthorizationProviderError extends AuthorizationDeclinedError {
	constructor(providerError: string) {
		super(providerError);
		this.name = 'AuthorizationProviderError';
	}
}

export class LoginTimeoutError extends OidcLoginError {
	constructor() {
		super('Timed out waiting for the browser to complete login', {
			kind: 'loopback-timeout'
		});
		this.name = 'LoginTimeoutError';
	}
}

export class DeviceAuthorizationRequestError extends OidcLoginError {
	constructor(public readonly status: number) {
		super(`Device authorization request failed with HTTP ${String(status)}`, {
			kind: 'device-authorization-http',
			status
		});
		this.name = 'DeviceAuthorizationRequestError';
	}
}

export class LoopbackBindError extends OidcLoginError {
	constructor(
		public readonly ports: readonly number[],
		options?: { readonly cause: unknown }
	) {
		super(`Could not bind the loopback server on port(s) ${ports.join(', ')}`, {
			...options,
			kind: 'loopback-bind'
		});
		this.name = 'LoopbackBindError';
	}
}

export interface Pkce {
	readonly verifier: string;
	readonly challenge: string;
}

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

// The client sends the authorization code, PKCE verifier, or device code to
// these endpoints. Require HTTPS, except on loopback, so a discovery document
// cannot redirect those credentials to a plain-HTTP server.
const endpointUrl = z.url().refine(isAllowedIssuerUrl);

const endpointsSchema = z.object({
	issuer: z.url(),
	authorization_endpoint: endpointUrl,
	token_endpoint: endpointUrl,
	device_authorization_endpoint: endpointUrl.optional()
});

/**
 * Reads an issuer's authorization, token and device endpoints from its OIDC
 * metadata. The issuer must be an HTTPS URL, except on loopback. Cupboard
 * removes one trailing slash before comparing the metadata issuer with the
 * requested issuer, then validates every returned endpoint independently.
 */
export async function discoverOidcLogin(
	issuer: string,
	fetcher: typeof fetch = resilientFetcher(),
	signal?: AbortSignal
): Promise<OidcLoginEndpoints> {
	throwIfAborted(signal);

	const issuerUrl = IssuerUrl.parse(issuer);

	if (issuerUrl === undefined) {
		throw new OidcLoginError(
			`Issuer ${issuer} must be an https URL (http only for loopback)`,
			{ issuer, kind: 'invalid-issuer' }
		);
	}

	let response: Response;

	try {
		// A redirected metadata document could retain the expected issuer while
		// sending the authorization code and PKCE verifier to another token endpoint.
		response = await fetcher(issuerUrl.discoveryUrl, {
			redirect: 'manual',
			signal
		});
	} catch (error) {
		throw new OidcLoginError(`Could not read OIDC metadata for ${issuer}`, {
			kind: 'discovery-request',
			issuer,
			cause: error
		});
	}

	if (!response.ok) {
		throw new OidcLoginError(`Could not read OIDC metadata for ${issuer}`, {
			kind: 'discovery-http',
			issuer,
			status: response.status
		});
	}

	let payload: unknown;

	try {
		payload = await response.json();
	} catch (error) {
		throw new OidcLoginError(`Could not read OIDC metadata for ${issuer}`, {
			kind: 'discovery-non-json',
			issuer,
			cause: error
		});
	}

	const parsed = endpointsSchema.safeParse(payload);

	if (!parsed.success) {
		throw new OidcLoginError(
			`OIDC metadata for ${issuer} is missing endpoints`,
			{
				kind: 'discovery-schema',
				issuer,
				cause: parsed.error
			}
		);
	}

	if (!issuerUrl.matches(parsed.data.issuer)) {
		throw new OidcLoginError(
			`OIDC metadata issuer ${parsed.data.issuer} does not match ${issuer}`,
			{
				kind: 'issuer-mismatch',
				issuer,
				metadataIssuer: parsed.data.issuer
			}
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
	readonly signal?: AbortSignal;
	/**
	Fixed loopback settings for an exactly registered redirect URI.
	*/
	readonly loopback?: LoopbackOptions;
}

/**
 * The default owner-login flow: PKCE with a 127.0.0.1 loopback redirect. It
 * binds a throwaway server, opens the browser to the issuer's authorization
 * endpoint, accepts the redirect, and exchanges the code for an `id_token`.
 * `state` and the PKCE verifier guard the exchange; the redirect is accepted
 * only on loopback.
 */
export async function loopbackLogin(
	options: LoopbackLoginOptions
): Promise<string> {
	throwIfAborted(options.signal);

	const fetcher = options.fetcher ?? resilientFetcher();
	const obtained = await obtainAuthorizationCode({
		authorizationEndpoint: options.endpoints.authorizationEndpoint,
		clientId: options.clientId,
		scope: options.scope ?? 'openid',
		openBrowser: options.openBrowser,
		timeoutMs: options.timeoutMs,
		signal: options.signal,
		loopback: options.loopback
	});

	return exchangeCode(
		options.endpoints,
		fetcher,
		{
			grant_type: 'authorization_code',
			code: obtained.code,
			redirect_uri: obtained.redirectUri,
			client_id: options.clientId,
			code_verifier: obtained.codeVerifier
		},
		options.signal
	);
}

export interface AuthorizeUrlParameters {
	readonly endpoint: string;
	readonly clientId: string;
	readonly redirectUri: string;
	readonly state: string;
	readonly challenge: string;
	readonly scope: string;
}

export function buildAuthorizeUrl(parameters: AuthorizeUrlParameters): string {
	const url = new URL(parameters.endpoint);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('client_id', parameters.clientId);
	url.searchParams.set('redirect_uri', parameters.redirectUri);
	url.searchParams.set('scope', parameters.scope);
	url.searchParams.set('state', parameters.state);
	url.searchParams.set('code_challenge', parameters.challenge);
	url.searchParams.set('code_challenge_method', 'S256');

	return url.href;
}

export interface LoopbackOptions {
	/**
	Ports to try in order; `[0]` requests an ephemeral port.
	*/
	readonly ports?: readonly number[];
	readonly host?: string;
	readonly path?: string;
}

export interface AuthorizationCodeOptions {
	readonly authorizationEndpoint: string;
	readonly clientId: string;
	readonly scope: string;
	readonly openBrowser: (url: string) => void | Promise<void>;
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
	readonly loopback?: LoopbackOptions;
}

export interface ObtainedAuthorizationCode {
	readonly code: string;
	/**
	The exact redirect URI to repeat in the token exchange.
	*/
	readonly redirectUri: string;
	/**
	The PKCE verifier whose challenge is bound to the code.
	*/
	readonly codeVerifier: string;
}

/**
 * Runs the browser half of a PKCE authorization code flow. It binds a loopback
 * redirect server, opens the authorization endpoint, and waits for a matching
 * redirect until the configured timeout. The caller performs the
 * provider-specific token exchange.
 */
export async function obtainAuthorizationCode(
	options: AuthorizationCodeOptions
): Promise<ObtainedAuthorizationCode> {
	throwIfAborted(options.signal);

	const pkce = createPkce();
	const state = randomState();
	const host = options.loopback?.host ?? '127.0.0.1';
	const path = options.loopback?.path ?? '/callback';
	const loopback = await startLoopbackServer({
		expectedState: state,
		ports: options.loopback?.ports,
		host,
		path
	});
	let timer: ReturnType<typeof setTimeout> | undefined;

	try {
		const redirectUri = `http://${host}:${String(loopback.port)}${path}`;
		const authorizeUrl = buildAuthorizeUrl({
			endpoint: options.authorizationEndpoint,
			clientId: options.clientId,
			redirectUri,
			state,
			challenge: pkce.challenge,
			scope: options.scope
		});

		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				reject(new LoginTimeoutError());
			}, options.timeoutMs ?? loopbackLoginTimeoutMs);
		});
		// The redirect can arrive while `openBrowser` is still pending, so the
		// browser launch and the wait for the code are awaited together: either
		// failing fails the login, and neither rejection goes unobserved.
		const openBrowserDeferred = async (): Promise<void> => {
			await Promise.resolve();

			return options.openBrowser(authorizeUrl);
		};
		const [, code] = await Promise.all([
			abortable(openBrowserDeferred(), options.signal),
			abortable(Promise.race([loopback.code, timeout]), options.signal)
		]);

		return { code, redirectUri, codeVerifier: pkce.verifier };
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}

		loopback.server.close();
	}
}

interface LoopbackServer {
	readonly server: Server;
	readonly port: number;
	readonly code: Promise<string>;
}

interface LoopbackServerOptions {
	readonly expectedState: string;
	readonly ports?: readonly number[];
	readonly host?: string;
	readonly path?: string;
}

async function startLoopbackServer(
	options: LoopbackServerOptions
): Promise<LoopbackServer> {
	const ports = options.ports ?? [0];
	let lastError: unknown;

	for (const port of ports) {
		try {
			return await bindLoopbackServer(port, options);
		} catch (error) {
			lastError = error;
		}
	}

	throw new LoopbackBindError(ports, { cause: lastError });
}

function bindLoopbackServer(
	port: number,
	options: LoopbackServerOptions
): Promise<LoopbackServer> {
	const callbackPath = options.path ?? '/callback';

	return new Promise((resolveServer, rejectServer) => {
		const {
			promise: code,
			resolve: resolveCode,
			reject: rejectCode
		} = Promise.withResolvers<string>();

		const server = createServer((request, response) => {
			const url = new URL(request.url ?? '/', 'http://127.0.0.1');

			if (url.pathname !== callbackPath) {
				response.writeHead(404);
				response.end();
				return;
			}

			const outcome = readCallback(url, options.expectedState);
			response.writeHead(outcome.kind === 'code' ? 200 : 400, {
				'content-type': 'text/plain; charset=utf-8'
			});
			response.end(outcome.message);

			// Return a response to stray requests without aborting the login; only the
			// matching redirect resolves or rejects the wait.
			switch (outcome.kind) {
				case 'code': {
					resolveCode(outcome.code);

					break;
				}
				case 'declined': {
					rejectCode(
						AuthorizationDeclinedError.fromProviderCode(outcome.providerError)
					);

					break;
				}
				case 'malformed': {
					rejectCode(new OidcLoginError(outcome.message));

					break;
				}
				// No default
			}
		});

		server.on('error', rejectServer);
		server.listen(port, options.host ?? '127.0.0.1', () => {
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
	| {
			readonly kind: 'declined';
			readonly providerError: string;
			readonly message: string;
	  }
	| { readonly kind: 'malformed'; readonly message: string }
	| { readonly kind: 'ignore'; readonly message: string };

function readCallback(url: URL, expectedState: string): CallbackOutcome {
	if (url.searchParams.get('state') !== expectedState) {
		return { kind: 'ignore', message: 'Unexpected callback; ignoring.' };
	}

	const error = url.searchParams.get('error');

	if (error !== null) {
		return {
			kind: 'declined',
			providerError: error,
			message: `Authorization failed: ${error}`
		};
	}

	const code = url.searchParams.get('code');

	if (code === null || code === '') {
		return {
			kind: 'malformed',
			message: 'Authorization response did not include a code'
		};
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
		/**
		The issuer's verification URL with the user code already included.
		*/
		readonly verificationUriComplete?: string;
	}) => void;
	readonly fetcher?: typeof fetch;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly now?: () => number;
	readonly signal?: AbortSignal;
}

const deviceAuthorizationSchema = z.object({
	device_code: z.string().min(1),
	user_code: z.string().min(1),
	verification_uri: z.string().min(1),
	verification_uri_complete: z.string().min(1).optional(),
	expires_in: z.number().int().positive().optional(),
	interval: z.number().int().positive().optional()
});

// RFC 8628 makes `expires_in` required; an issuer that omits it still gets a
// bounded poll.
const deviceCodeFallbackLifetimeSeconds = 600;

// The poll interval used when the issuer advertises none, and the increment
// applied on a `slow_down`, both 5 seconds, per the RFC 8628 example.
const devicePollIntervalSeconds = 5;
const deviceSlowDownIncrementMs = 5 * 1000;

const deviceErrorSchema = z.object({ error: z.string() });

/**
 * The `--headless` owner-login flow: RFC 8628 device authorization. It requests
 * a code, shows the user where to enter it, and polls the token
 * endpoint, honouring `authorization_pending` and `slow_down`, until an
 * `id_token` is issued.
 */
export async function deviceLogin(
	options: DeviceLoginOptions
): Promise<string> {
	throwIfAborted(options.signal);

	const endpoint = options.endpoints.deviceAuthorizationEndpoint;

	if (endpoint === undefined) {
		throw new OidcLoginError('The issuer does not support the device flow', {
			kind: 'unsupported-device-flow'
		});
	}

	const fetcher = options.fetcher ?? resilientFetcher();
	const now = options.now ?? Date.now;

	const authorization = await requestDeviceCode(
		endpoint,
		fetcher,
		{
			client_id: options.clientId,
			scope: options.scope ?? 'openid'
		},
		options.signal
	);
	options.prompt({
		userCode: authorization.user_code,
		verificationUri: authorization.verification_uri,
		verificationUriComplete: authorization.verification_uri_complete
	});

	let intervalMs = (authorization.interval ?? devicePollIntervalSeconds) * 1000;
	const deadlineMs =
		now() +
		(authorization.expires_in ?? deviceCodeFallbackLifetimeSeconds) * 1000;

	for (;;) {
		await delayMs(intervalMs, {
			delay: options.sleep,
			signal: options.signal
		});

		if (now() >= deadlineMs) {
			throw new OidcLoginError(
				'Device authorization expired before it was approved',
				{ kind: 'device-expired' }
			);
		}

		const outcome = await pollDeviceToken(
			options.endpoints,
			fetcher,
			{
				grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
				device_code: authorization.device_code,
				client_id: options.clientId
			},
			options.signal
		);

		if (outcome.kind === 'token') {
			return outcome.idToken;
		}

		if (outcome.kind === 'slow_down') {
			intervalMs += deviceSlowDownIncrementMs;
		} else if (outcome.kind === 'denied') {
			throw new OidcLoginError(
				`Device authorization failed: ${outcome.error}`,
				{
					kind: 'device-denied',
					providerError: outcome.error
				}
			);
		}
	}
}

async function requestDeviceCode(
	endpoint: string,
	fetcher: typeof fetch,
	form: Readonly<Record<string, string>>,
	signal: AbortSignal | undefined
): Promise<z.infer<typeof deviceAuthorizationSchema>> {
	const response = await fetcher(endpoint, postForm(form, signal));

	if (!response.ok) {
		throw new DeviceAuthorizationRequestError(response.status);
	}

	const parsed = deviceAuthorizationSchema.safeParse(
		await readJson(response, 'device-authorization-non-json')
	);

	if (!parsed.success) {
		throw new OidcLoginError('Device authorization response was malformed', {
			kind: 'device-authorization-schema',
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
	form: Readonly<Record<string, string>>,
	signal: AbortSignal | undefined
): Promise<PollOutcome> {
	const response = await fetcher(
		endpoints.tokenEndpoint,
		postForm(form, signal)
	);
	const payload = await readJson(response, 'device-token-non-json');

	if (response.ok) {
		const parsed = idTokenSchema.safeParse(payload);

		if (!parsed.success) {
			throw new OidcLoginError(
				'Device token response did not include id_token',
				{
					kind: 'device-token-response'
				}
			);
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

async function readJson(
	response: Response,
	kind: OidcLoginErrorKind
): Promise<unknown> {
	try {
		return await response.json();
	} catch (error) {
		throw new OidcLoginError('OIDC endpoint returned a non-JSON response', {
			kind,
			cause: error
		});
	}
}

async function exchangeCode(
	endpoints: OidcLoginEndpoints,
	fetcher: typeof fetch,
	form: Readonly<Record<string, string>>,
	signal: AbortSignal | undefined
): Promise<string> {
	const response = await fetcher(
		endpoints.tokenEndpoint,
		postForm(form, signal)
	);

	if (!response.ok) {
		throw new OidcLoginError(
			`Token exchange failed with HTTP ${String(response.status)}`,
			{ kind: 'token-http', status: response.status }
		);
	}

	const parsed = idTokenSchema.safeParse(
		await readJson(response, 'token-non-json')
	);

	if (!parsed.success) {
		throw new OidcLoginError('Token response did not include id_token', {
			kind: 'token-response'
		});
	}

	return parsed.data.id_token;
}

export function postForm(
	form: Readonly<Record<string, string>>,
	signal?: AbortSignal
): RequestInit {
	const parameters = new URLSearchParams(form);

	return {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: parameters.toString(),
		signal
	};
}
