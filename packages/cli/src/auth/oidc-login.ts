import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import { isAllowedIssuerUrl, IssuerUrl } from '@cupboard/protocol/oidc-issuer';
import { discardResponseBody } from '@cupboard/shared/cleanup';
import { readResponseJson } from '@cupboard/shared/response-body';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';

import { abortable, throwIfAborted } from '../abort.ts';
import { resilientFetcher } from '../client/transport.ts';
import { CliAbortError, CliError } from '../errors.ts';

const maximumOidcResponseBytes = 1024 * 1024;

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
	| 'discovery-http'
	| 'discovery-non-json'
	| 'discovery-request'
	| 'discovery-schema'
	| 'generic'
	| 'invalid-issuer'
	| 'issuer-mismatch'
	| 'loopback-bind'
	| 'loopback-timeout'
	| 'pasted-redirect-refused'
	| 'token-http'
	| 'token-non-json'
	| 'token-response';

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

/**
 * Why a pasted redirect URL was refused: it is not a URL, its `state` belongs
 * to another sign-in, or it fails a check that also applies to a loopback
 * redirect.
 */
export type PastedRedirectProblem =
	CallbackProblem | 'not-a-url' | 'other-sign-in';

export class PastedRedirectRefusedError extends OidcLoginError {
	constructor(public readonly problem: PastedRedirectProblem) {
		super(`The pasted URL is not the redirect for this sign-in (${problem})`, {
			kind: 'pasted-redirect-refused'
		});
		this.name = 'PastedRedirectRefusedError';
	}
}

/**
 * Reads the redirect URL pasted from the browser's address bar and resolves to
 * the pasted text. It resolves to undefined when the user cancels.
 * The sign-in aborts `signal` once it has a code, and the prompt then closes.
 * After a refused paste, the sign-in asks again with the `refusal`, which the
 * prompt reports.
 */
export type PastedRedirectReader = (
	signal: AbortSignal,
	refusal?: PastedRedirectRefusedError
) => Promise<string | undefined>;

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
	readonly issuer: string;
	readonly authorizationEndpoint: string;
	readonly tokenEndpoint: string;
}

// The client sends the code and the PKCE verifier to these endpoints. Require
// HTTPS, except on loopback, so a discovery document cannot redirect those
// credentials to a plain-HTTP server.
const endpointUrl = z.url().refine(isAllowedIssuerUrl);

const interactiveOidcDiscoverySchema = z.object({
	issuer: z.url(),
	authorization_endpoint: endpointUrl,
	token_endpoint: endpointUrl,
	authorization_response_iss_parameter_supported: z.literal(true),
	response_types_supported: z
		.array(z.string())
		.min(1)
		.refine((responseTypes) => responseTypes.includes('code')),
	subject_types_supported: z.array(z.string()).min(1),
	id_token_signing_alg_values_supported: z
		.array(z.string())
		.min(1)
		.refine((algorithms) => algorithms.includes('RS256'))
});

/**
 * Reads an issuer's `authorization_endpoint` and `token_endpoint` from its OIDC
 * metadata. The issuer must be an HTTPS URL, except on loopback. Cupboard
 * removes one trailing slash before comparing the metadata issuer with the
 * requested issuer, then validates every returned endpoint independently.
 */
export async function discoverOidcLogin(
	issuer: string,
	fetcher: typeof fetch = resilientFetcher('replay-unsafe'),
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
		await discardResponseBody(response);
		throw new OidcLoginError(`Could not read OIDC metadata for ${issuer}`, {
			kind: 'discovery-http',
			issuer,
			status: response.status
		});
	}

	let payload: unknown;

	try {
		payload = await readResponseJson(response, {
			description: `OIDC metadata for ${issuer}`,
			maximumBytes: maximumOidcResponseBytes,
			signal
		});
	} catch (error) {
		if (!(error instanceof SyntaxError)) {
			throw error;
		}

		throw new OidcLoginError(`Could not read OIDC metadata for ${issuer}`, {
			kind: 'discovery-non-json',
			issuer,
			cause: error
		});
	}

	const mediaType = response.headers
		.get('content-type')
		?.split(';', 1)[0]
		?.trim()
		.toLowerCase();

	if (mediaType !== 'application/json') {
		throw new OidcLoginError(`Could not read OIDC metadata for ${issuer}`, {
			kind: 'discovery-non-json',
			issuer
		});
	}

	const parsed = interactiveOidcDiscoverySchema.safeParse(payload);

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
		issuer: issuerUrl.value,
		authorizationEndpoint: parsed.data.authorization_endpoint,
		tokenEndpoint: parsed.data.token_endpoint
	};
}

const idTokenSchema = z.object({ id_token: z.string().min(1) });

const loopbackLoginTimeoutMs = 5 * 60 * 1000;

export interface LoopbackLoginOptions {
	readonly endpoints: OidcLoginEndpoints;
	readonly clientId: string;
	readonly scope?: string;
	/**
	The OIDC `nonce` that the returned ID token must contain.
	*/
	readonly nonce: string;
	readonly openBrowser: (url: string) => void | Promise<void>;
	readonly fetcher?: typeof fetch;
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
	/**
	Fixed loopback settings for an exactly registered redirect URI.
	*/
	readonly loopback?: LoopbackOptions;
	readonly readPastedRedirect?: PastedRedirectReader;
}

/**
 * Starts the default owner-login flow with PKCE and a 127.0.0.1 loopback
 * redirect. It opens the browser to the issuer's authorization endpoint,
 * accepts the redirect on loopback or, with `readPastedRedirect`, as a pasted
 * URL, and exchanges the code for an `id_token`. The state, response issuer
 * and PKCE verifier bind the response to this login.
 */
export async function loopbackLogin(
	options: LoopbackLoginOptions
): Promise<string> {
	throwIfAborted(options.signal);

	const fetcher = options.fetcher ?? resilientFetcher('replay-unsafe');
	const obtained = await obtainAuthorizationCode({
		expectedIssuer: options.endpoints.issuer,
		authorizationEndpoint: options.endpoints.authorizationEndpoint,
		clientId: options.clientId,
		scope: options.scope ?? 'openid',
		nonce: options.nonce,
		openBrowser: options.openBrowser,
		timeoutMs: options.timeoutMs,
		signal: options.signal,
		loopback: options.loopback,
		readPastedRedirect: options.readPastedRedirect
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
	readonly nonce: string;
}

export function buildAuthorizeUrl(parameters: AuthorizeUrlParameters): string {
	const url = new URL(parameters.endpoint);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('client_id', parameters.clientId);
	url.searchParams.set('redirect_uri', parameters.redirectUri);
	url.searchParams.set('scope', parameters.scope);
	url.searchParams.set('state', parameters.state);
	url.searchParams.set('nonce', parameters.nonce);
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
	/**
	The issuer bound to this transaction. When present, the callback must contain
	an exact RFC 9207 `iss` match.
	*/
	readonly expectedIssuer?: string;
	/**
	 * True for an issuer whose metadata does not advertise RFC 9207 support. A
	 * callback without `iss` is then accepted, and a callback with `iss` must
	 * still match `expectedIssuer`.
	 */
	readonly isIssuerParameterOptional?: boolean;
	readonly authorizationEndpoint: string;
	readonly clientId: string;
	readonly scope: string;
	readonly nonce: string;
	readonly openBrowser: (url: string) => void | Promise<void>;
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
	readonly loopback?: LoopbackOptions;
	/**
	 * Use this reader when the browser cannot reach the loopback server. The first
	 * redirect wins. A pasted URL receives the same callback-parameter checks.
	 */
	readonly readPastedRedirect?: PastedRedirectReader;
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
	const expected: CallbackExpectation = {
		expectedState: randomState(),
		expectedIssuer: options.expectedIssuer,
		isIssuerParameterOptional: options.isIssuerParameterOptional
	};
	const host = options.loopback?.host ?? '127.0.0.1';
	const path = options.loopback?.path ?? '/callback';
	const loopback = await startLoopbackServer({
		...expected,
		ports: options.loopback?.ports,
		host,
		path
	});
	const pasteController = new AbortController();
	const pasteSignal =
		options.signal === undefined
			? pasteController.signal
			: AbortSignal.any([pasteController.signal, options.signal]);
	let timer: ReturnType<typeof setTimeout> | undefined;

	try {
		const redirectUri = `http://${host}:${String(loopback.port)}${path}`;
		const authorizeUrl = buildAuthorizeUrl({
			endpoint: options.authorizationEndpoint,
			clientId: options.clientId,
			redirectUri,
			state: expected.expectedState,
			challenge: pkce.challenge,
			scope: options.scope,
			nonce: options.nonce
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
		const opened = openBrowserDeferred();
		const read = options.readPastedRedirect;
		const pastedAfterOpening = async (
			reader: PastedRedirectReader
		): Promise<string> => {
			await opened;

			return pastedCode(reader, expected, pasteSignal);
		};
		const pasted = read === undefined ? [] : [pastedAfterOpening(read)];
		const [, code] = await Promise.all([
			abortable(opened, options.signal),
			abortable(
				Promise.race([loopback.code, timeout, ...pasted]),
				options.signal
			)
		]);

		return { code, redirectUri, codeVerifier: pkce.verifier };
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}

		pasteController.abort();
		loopback.server.close();
	}
}

// A refused paste leaves the loopback server waiting, so the user can paste
// again or complete the sign-in in a browser that reaches it. The prompt ends
// when the sign-in has a code, times out or is cancelled.
async function pastedCode(
	read: PastedRedirectReader,
	expected: CallbackExpectation,
	signal: AbortSignal
): Promise<string> {
	let refusal: PastedRedirectRefusedError | undefined;

	for (;;) {
		const pasted = await read(signal, refusal);

		try {
			return checkedPaste(pasted, expected);
		} catch (error) {
			if (!(error instanceof PastedRedirectRefusedError)) {
				throw error;
			}

			refusal = error;
		}
	}
}

function checkedPaste(
	pasted: string | undefined,
	expected: CallbackExpectation
): string {
	if (pasted === undefined) {
		throw new CliAbortError();
	}

	const url = URL.parse(pasted.trim());

	if (url === null) {
		throw new PastedRedirectRefusedError('not-a-url');
	}

	const outcome = readCallback(url, expected);

	switch (outcome.kind) {
		case 'code': {
			return outcome.code;
		}
		case 'declined': {
			throw AuthorizationDeclinedError.fromProviderCode(outcome.providerError);
		}
		case 'malformed': {
			throw new PastedRedirectRefusedError(outcome.problem);
		}
		case 'ignore': {
			throw new PastedRedirectRefusedError('other-sign-in');
		}
	}
}

interface LoopbackServer {
	readonly server: Server;
	readonly port: number;
	readonly code: Promise<string>;
}

interface CallbackExpectation {
	readonly expectedState: string;
	readonly expectedIssuer?: string;
	readonly isIssuerParameterOptional?: boolean;
}

interface LoopbackServerOptions extends CallbackExpectation {
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

			const outcome = readCallback(url, options);
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
	| {
			readonly kind: 'malformed';
			readonly problem: CallbackProblem;
			readonly message: string;
	  }
	| { readonly kind: 'ignore'; readonly message: string };

type CallbackProblem =
	'issuer-mismatch' | 'missing-code' | 'repeated-parameter';

type CallbackParameter = 'state' | 'iss' | 'error' | 'code';

function repeatedCallbackParameter(
	parameters: URLSearchParams,
	parameter: CallbackParameter
): Extract<CallbackOutcome, { readonly kind: 'malformed' }> | undefined {
	if (parameters.getAll(parameter).length < 2) {
		return undefined;
	}

	return {
		kind: 'malformed',
		problem: 'repeated-parameter',
		message: `Authorization response includes repeated ${parameter} parameter`
	};
}

function readCallback(
	url: URL,
	expected: CallbackExpectation
): CallbackOutcome {
	const { expectedIssuer } = expected;

	// Check state before parsing the response. Requests for another login are
	// ignored.
	if (!url.searchParams.getAll('state').includes(expected.expectedState)) {
		return { kind: 'ignore', message: 'Unexpected callback; ignoring.' };
	}

	for (const parameter of ['state', 'iss', 'error', 'code'] as const) {
		const repeatedParameter = repeatedCallbackParameter(
			url.searchParams,
			parameter
		);

		if (repeatedParameter !== undefined) {
			return repeatedParameter;
		}
	}

	const issuer = url.searchParams.get('iss');
	const isIssuerUnchecked =
		issuer === null && expected.isIssuerParameterOptional === true;

	if (
		expectedIssuer !== undefined &&
		!isIssuerUnchecked &&
		issuer !== expectedIssuer
	) {
		return {
			kind: 'malformed',
			problem: 'issuer-mismatch',
			message: 'Authorization response issuer does not match the login issuer'
		};
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
			problem: 'missing-code',
			message: 'Authorization response did not include a code'
		};
	}

	return {
		kind: 'code',
		code,
		message: 'cupboard login complete. You may close this window.'
	};
}

async function readJson(
	response: Response,
	kind: OidcLoginErrorKind,
	signal?: AbortSignal
): Promise<unknown> {
	try {
		return await readResponseJson(response, {
			description: 'OIDC endpoint response',
			maximumBytes: maximumOidcResponseBytes,
			signal
		});
	} catch (error) {
		if (!(error instanceof SyntaxError)) {
			throw error;
		}

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
		await discardResponseBody(response);
		throw new OidcLoginError(
			`Token exchange failed with HTTP ${String(response.status)}`,
			{ kind: 'token-http', status: response.status }
		);
	}

	const parsed = idTokenSchema.safeParse(
		await readJson(response, 'token-non-json', signal)
	);

	if (!parsed.success) {
		throw new OidcLoginError('Token response did not include id_token', {
			kind: 'token-response'
		});
	}

	return parsed.data.id_token;
}

const redirectStatuses: ReadonlySet<number> = new Set([
	StatusCodes.MOVED_PERMANENTLY,
	StatusCodes.MOVED_TEMPORARILY,
	StatusCodes.SEE_OTHER,
	StatusCodes.TEMPORARY_REDIRECT,
	StatusCodes.PERMANENT_REDIRECT
]);

export function isRedirectStatus(status: number): boolean {
	return redirectStatuses.has(status);
}

/**
 * Builds a URL-encoded POST for a token endpoint. Following a 307 or 308 would
 * send the form, with its code or refresh token, to the redirect target.
 */
export function postForm(
	form: Readonly<Record<string, string>>,
	signal?: AbortSignal
): RequestInit {
	const parameters = new URLSearchParams(form);

	return {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: parameters.toString(),
		redirect: 'manual',
		signal
	};
}
