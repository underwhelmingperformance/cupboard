import {
	cacheNameSchema,
	DEFAULT_CACHE,
	type NixSha256HashString,
	type StoredCache,
	type StorePathHash,
	WIRE_DEFAULT_CACHE
} from '@cupboard/nix-store/scalars';
import { type AuthorizationDetails } from '@cupboard/protocol/grants';
import {
	issuedAccessTokenType,
	type ParsedTokenResponse,
	refreshTokenGrantType,
	tokenExchangeGrantType,
	tokenResponseSchema
} from '@cupboard/protocol/oidc';
import {
	type ParsedSignupResponse,
	type SignupRequest,
	signupResponseSchema
} from '@cupboard/protocol/signup';
import {
	commitAcceptCapabilitiesHeader,
	commitBatchCapability,
	type UploadId
} from '@cupboard/protocol/upload';
import { StatusCodes } from 'http-status-codes';
import { WebSocket } from 'ws';
import { z } from 'zod';

import { throwIfAborted } from '../abort.ts';
import {
	CupboardHttpError,
	InvalidCacheNameError,
	MalformedResponseError,
	ResponseSchemaMismatchError
} from '../errors.ts';

import {
	type AdvertisedCapabilities,
	type CommitOutcome,
	type CommitSession,
	type CommitSocketConnect,
	runCommitSession
} from './commit-socket.ts';
import {
	type AccessCredential,
	bearerHeaders,
	isTokenProvider,
	resolveBearer
} from './credentials.ts';
import { resilientFetcher } from './transport.ts';

export { type AccessCredential, type TokenProvider } from './credentials.ts';

export class CupboardClient {
	static fromUrl(
		value: URL,
		options: string | CupboardClientOptions = DEFAULT_CACHE
	): CupboardClient {
		const resolved = typeof options === 'string' ? { cache: options } : options;

		return new CupboardClient(
			new URL(value),
			resilientFetcher(fetch),
			cachePrefixFor(resolved.cache ?? DEFAULT_CACHE),
			resolved.signal
		);
	}

	constructor(
		public readonly baseUrl: URL,
		public readonly fetcher: typeof fetch = fetch,
		// Prepended to path-scoped routes for a named cache (e.g. `/cache/builds`);
		// empty for the default cache. Not baked into `baseUrl`, so resolving an
		// absolute path against the base never discards it.
		public readonly cachePrefix = '',
		public readonly signal?: AbortSignal,
		private readonly connectSocket: CommitSocketConnect = connectCommitSocket
	) {}

	private async fetchText(path: string): Promise<string> {
		throwIfAborted(this.signal);

		const response = await this.fetcher(this.resolve(path), {
			signal: this.signal
		});

		if (!response.ok) {
			throw new CupboardHttpError(
				'GET',
				path,
				response.status,
				await response.text(),
				rayOf(response)
			);
		}

		const body = await response.text();

		return body.trimEnd();
	}

	// Routes on the contract address the default cache by its wire alias, so the
	// selector form is always prefixed.
	private selectorScoped(path: string): string {
		return this.cachePrefix === ''
			? `/cache/${WIRE_DEFAULT_CACHE}${path}`
			: `${this.cachePrefix}${path}`;
	}

	// Resolves a route under the base URL's full path, so a tenant base like
	// `https://host/t/<tenant>` keeps its prefix. A plain `new URL('/path', base)`
	// would discard the base path, because an absolute path replaces it.
	private resolve(path: string): URL {
		const url = new URL(this.baseUrl);
		url.pathname = `${url.pathname.replace(/\/+$/, '')}${path}`;

		return url;
	}

	private socketUrl(path: string): URL {
		const url = this.resolve(path);
		url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';

		return url;
	}

	private connectCommitSession(
		bearer: string | undefined,
		options: CommitOptions
	): CommitSession {
		const path = this.selectorScoped('/commit');

		return runCommitSession(
			this.connectSocket,
			this.socketUrl(path),
			{
				...bearerHeaders(bearer),
				[commitAcceptCapabilitiesHeader]: commitBatchCapability
			},
			{
				path,
				timeoutSeconds: options.timeoutSeconds ?? defaultCommitWaitSeconds,
				signal: this.signal,
				onCapabilities: options.onCapabilities
			}
		);
	}

	// A failed token grant fails the whole CI run or push behind it. The client's
	// fetcher already retries a transient refusal (a network fault, a gateway
	// blip, an overloaded 503) with backoff, so this only maps a settled non-ok
	// response to a typed error.
	private async postTokenForm(
		form: Readonly<Record<string, string>>
	): Promise<Response> {
		throwIfAborted(this.signal);

		const url = this.resolve('/token');
		const body = new URLSearchParams(form).toString();
		const response = await this.fetcher(url, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body,
			signal: this.signal
		});

		if (!response.ok) {
			throw new CupboardHttpError(
				'POST',
				'/token',
				response.status,
				await response.text(),
				rayOf(response)
			);
		}

		return response;
	}

	private async parseJson<S extends z.ZodType>(
		path: string,
		schema: S,
		response: Response
	): Promise<z.output<S>> {
		let payload: unknown;

		try {
			payload = await response.json();
		} catch (error) {
			if (error instanceof SyntaxError) {
				throw new MalformedResponseError(path, error);
			}

			throw error;
		}

		const result = schema.safeParse(payload);

		if (!result.success) {
			throw new ResponseSchemaMismatchError(path, result.error);
		}

		return result.data;
	}

	// The route renders the key set with a trailing newline; the keys themselves
	// carry none, so the newline is trimmed before the key set is returned.
	publicKey(): Promise<string> {
		return this.fetchText('/pubkey');
	}

	/**
	 * The build version the deployment answers on its unauthenticated
	 * `/_version` route, without the trailing newline the route renders.
	 */
	version(): Promise<string> {
		return this.fetchText('/_version');
	}

	/**
	 * Opens a commit session over one WebSocket. The upgrade request carries the
	 * write token; every path in the push commits over the returned session, and
	 * a deferred upload parks on the same socket for the server's verification
	 * verdict (or resolves `pending` straight away when `wait` is off).
	 */
	async openCommitSession(
		token: AccessCredential,
		options: CommitOptions = {}
	): Promise<CommitSession> {
		throwIfAborted(this.signal);

		return this.connectCommitSession(await resolveBearer(token), options);
	}

	/**
	 * Commits a single upload over its own session. Used to re-drive one path that
	 * a push had to renegotiate; the bulk push commits over a shared session.
	 */
	async commit(
		token: AccessCredential,
		target: CommitTarget,
		options: CommitOptions = {}
	): Promise<CommitOutcome> {
		throwIfAborted(this.signal);

		const settle = async (
			bearer: string | undefined
		): Promise<CommitOutcome> => {
			const session = this.connectCommitSession(bearer, options);

			let outcome: CommitOutcome;
			try {
				outcome = await session.commit(target);
			} catch (error) {
				// The ack itself failed (a pre-ack error frame that tears down only
				// this entry, or a refused upgrade). Close the one-shot session so its
				// socket never leaks; close is idempotent when a failure already tore
				// it down.
				session.close();
				throw error;
			}

			// The ack is in; keep the one-shot session open until the verdict
			// settles, then close it. The caller still observes a failed verdict on
			// `outcome.settled`; this awaits only to gate the close.
			const closeOnceSettled = async (): Promise<void> => {
				try {
					await outcome.settled;
				} catch {
					// Failed or timed out: closing the session is all this arm owes.
				} finally {
					session.close();
				}
			};

			void closeOnceSettled();

			return outcome;
		};

		try {
			return await settle(await resolveBearer(token));
		} catch (error) {
			// A long push can outlive the exchanged JWT; refresh once and retry.
			if (
				error instanceof CupboardHttpError &&
				error.status === unauthorizedStatus &&
				isTokenProvider(token)
			) {
				return settle(await token.refresh());
			}

			throw error;
		}
	}

	/**
	 * Claims (or idempotently re-claims) global admin of the deployment at the
	 * bootstrap `POST /signup` endpoint. The endpoint is unauthenticated (the
	 * external OIDC subject token is the credential, judged against the
	 * deployment's signup gate) and takes a urlencoded body.
	 */
	async signup(request: SignupRequest): Promise<ParsedSignupResponse> {
		throwIfAborted(this.signal);

		const url = this.resolve('/signup');
		const body = new URLSearchParams({
			subject_token: request.subject_token,
			...(request.claim_secret !== undefined && {
				claim_secret: request.claim_secret
			})
		});
		const response = await this.fetcher(url, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: body.toString(),
			signal: this.signal
		});

		if (!response.ok) {
			throw new CupboardHttpError(
				'POST',
				'/signup',
				response.status,
				await response.text(),
				rayOf(response)
			);
		}

		return this.parseJson('/signup', signupResponseSchema, response);
	}

	/**
	 * Exchanges an external OIDC subject token for a cupboard access token at the
	 * OAuth `POST /token` endpoint. The endpoint is unauthenticated (the subject
	 * token is the credential) and takes a urlencoded body, so it bypasses the
	 * JSON request path the rest of the client uses.
	 */
	async tokenExchange(
		subjectToken: string,
		subjectTokenType: string,
		authorizationDetails?: AuthorizationDetails
	): Promise<ParsedTokenResponse> {
		const response = await this.postTokenForm({
			grant_type: tokenExchangeGrantType,
			subject_token: subjectToken,
			subject_token_type: subjectTokenType,
			...(authorizationDetails !== undefined && {
				authorization_details: JSON.stringify(authorizationDetails)
			})
		});

		return this.parseJson('/token', tokenResponseSchema, response);
	}

	/**
	 * Narrows a token this deployment issued to a subset of its grants. The
	 * presented token is the subject; the server recognises it by signature and
	 * confines the new token to `authorizationDetails`, refusing anything the
	 * presenter could not already do.
	 */
	async tokenExchangeAttenuate(
		currentToken: string,
		authorizationDetails: AuthorizationDetails
	): Promise<ParsedTokenResponse> {
		return this.tokenExchange(
			currentToken,
			issuedAccessTokenType,
			authorizationDetails
		);
	}

	/**
	 * Renews a session at the OAuth `POST /token` endpoint with the RFC 6749
	 * refresh_token grant. The refresh token is the credential and the server
	 * rotates it on every use: the response carries its successor, and the
	 * presented token is spent whether or not the caller stores it.
	 */
	async tokenRefresh(refreshToken: string): Promise<ParsedTokenResponse> {
		const response = await this.postTokenForm({
			grant_type: refreshTokenGrantType,
			refresh_token: refreshToken
		});

		return this.parseJson('/token', tokenResponseSchema, response);
	}
}

export interface CupboardClientOptions {
	readonly cache?: string;
	readonly signal?: AbortSignal;
}

/**
 * The upload a commit settles: its id and the path identity negotiated for it.
 * The identity lets the client report a verdict that races ahead of the server's
 * deferred frame. `retention`, true only when this upload negotiated a
 * retention plan, lets a reconnect that resolves a gone row by identity ask
 * the server for the path's durable grace fact.
 */
export interface CommitTarget {
	readonly uploadId: UploadId;
	readonly storePathHash: StorePathHash;
	readonly narHash: NixSha256HashString;
	readonly retention?: boolean;
}

export interface CommitOptions {
	/** Bounds how long a parked upload waits for its verdict. */
	readonly timeoutSeconds?: number;
	/**
	 * Called on each connection with the capabilities the server advertised in
	 * the 101 response. Useful for logging the negotiated mode.
	 */
	readonly onCapabilities?: (capabilities: AdvertisedCapabilities) => void;
}

// Widened to `number` so a comparison against a plain response status is not an
// enum-versus-number mismatch.
const unauthorizedStatus: number = StatusCodes.UNAUTHORIZED;
const defaultCommitWaitSeconds = 600;

const connectCommitSocket: CommitSocketConnect = (url, headers) =>
	new WebSocket(url, { headers: { ...headers } });

// Cloudflare stamps every response with a `cf-ray` at the edge, so a server-side
// failure can be tied to its log line. Absent off Cloudflare (a local server).
function rayOf(response: Response): string | undefined {
	return response.headers.get('cf-ray') ?? undefined;
}

// Resolves a caller's optional cache option to its stored name, rejecting a
// malformed name so the CLI reports it before a request is built. An absent
// option and the default alias both resolve to the default cache.
export function storedCacheFor(cache: string | undefined): StoredCache {
	if (cache === undefined || cache === DEFAULT_CACHE) {
		return DEFAULT_CACHE;
	}

	const parsed = cacheNameSchema.safeParse(cache);

	if (!parsed.success) {
		throw new InvalidCacheNameError(cache);
	}

	return parsed.data;
}

export function cachePrefixFor(cache: string): string {
	const stored = storedCacheFor(cache);

	return stored === DEFAULT_CACHE ? '' : `/cache/${stored}`;
}
