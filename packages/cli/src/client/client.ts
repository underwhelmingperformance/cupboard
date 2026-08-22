import { parsePublishedNixPublicKeys } from '@cupboard/nix-store/public-key';
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
	commitCreditCapability,
	type UploadId
} from '@cupboard/protocol/upload';
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
	type CommitSocketCredentials,
	runCommitSession
} from './commit-socket.ts';
import { type AccessCredential, bearerAttempt } from './credentials.ts';
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
			fetch,
			cachePrefixFor(resolved.cache ?? DEFAULT_CACHE),
			resolved.signal
		);
	}

	private readonly replaySafeFetcher: typeof fetch;

	private readonly replayUnsafeFetcher: typeof fetch;

	constructor(
		public readonly baseUrl: URL,
		public readonly fetcher: typeof fetch = fetch,
		// Keep the cache selector separate from `baseUrl`. Resolving an absolute
		// route can discard the base path, including a tenant prefix.
		public readonly cachePrefix = '',
		public readonly signal?: AbortSignal,
		private readonly connectSocket: CommitSocketConnect = connectCommitSocket
	) {
		this.replaySafeFetcher = resilientFetcher('replay-safe', fetcher);
		this.replayUnsafeFetcher = resilientFetcher('replay-unsafe', fetcher);
	}

	private async fetchText(path: string): Promise<string> {
		throwIfAborted(this.signal);

		const response = await this.replaySafeFetcher(this.resolve(path), {
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

	// Contract routes require an explicit cache selector, including the wire
	// alias for the default cache.
	private selectorScoped(path: string): string {
		return this.cachePrefix === ''
			? `/cache/${WIRE_DEFAULT_CACHE}${path}`
			: `${this.cachePrefix}${path}`;
	}

	// Append routes to the complete base path. `new URL('/path', base)` would
	// replace a tenant prefix such as `/t/<tenant>`.
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
		credentials: CommitSocketCredentials,
		options: CommitOptions
	): CommitSession {
		const path = this.selectorScoped('/commit');

		return runCommitSession(
			this.connectSocket,
			this.socketUrl(path),
			credentials,
			{
				path,
				timeoutSeconds: options.timeoutSeconds ?? defaultCommitWaitSeconds,
				signal: this.signal,
				onCapabilities: options.onCapabilities,
				onWaiting: options.onWaiting
			}
		);
	}

	private async commitSocketCredentials(
		credential: AccessCredential
	): Promise<CommitSocketCredentials> {
		// Declare credit pacing on every upgrade. The server enforces the request
		// declaration even if an intermediary strips the response capability. An
		// `unsupported` frame is the only signal that permits the local window.
		const headers = {
			[commitAcceptCapabilitiesHeader]: `${commitBatchCapability},${commitCreditCapability}`
		};
		const authorise = () => bearerAttempt(credential, headers);

		return { initial: await authorise(), authorise };
	}

	private async postTokenForm(
		form: Readonly<Record<string, string>>
	): Promise<Response> {
		throwIfAborted(this.signal);

		const url = this.resolve('/token');
		const body = new URLSearchParams(form).toString();
		const response = await this.replayUnsafeFetcher(url, {
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

	// The route renders the key set with a trailing newline. Individual keys do
	// not contain newlines, so trim it before returning the key set.
	async publicKey(): Promise<string> {
		const source = await this.fetchText('/pubkey');

		return parsePublishedNixPublicKeys(source)
			.map((key) => key.value)
			.join('\n');
	}

	version(): Promise<string> {
		return this.fetchText('/_version');
	}

	/**
	 * Opens a commit session over one WebSocket. The upgrade request includes the
	 * write token. Every path in the push commits over the returned session, and
	 * a deferred upload waits on the same socket for the server's verification
	 * verdict. With `wait` disabled, the upload returns `pending` immediately.
	 */
	async openCommitSession(
		token: AccessCredential,
		options: CommitOptions = {}
	): Promise<CommitSession> {
		throwIfAborted(this.signal);

		return this.connectCommitSession(
			await this.commitSocketCredentials(token),
			options
		);
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

		const settle = async (): Promise<CommitOutcome> => {
			const session = this.connectCommitSession(
				await this.commitSocketCredentials(token),
				options
			);

			let outcome: CommitOutcome;
			try {
				outcome = await session.commit(target);
			} catch (error) {
				// An acknowledgement failure leaves no verdict to wait for. Close the
				// one-shot session here; teardown may already have closed the socket.
				session.close();
				throw error;
			}

			// A deferred outcome still needs this socket for its verdict. Close only
			// after `settled`, while leaving that promise's result to the caller.
			const closeOnceSettled = async (): Promise<void> => {
				try {
					await outcome.settled;
				} catch {
					// The caller observes this rejection through `outcome.settled`.
				} finally {
					session.close();
				}
			};

			void closeOnceSettled();

			return outcome;
		};

		return settle();
	}

	/**
	 * Claims (or idempotently re-claims) global admin of the deployment at the
	 * bootstrap `POST /signup` endpoint. The endpoint is unauthenticated (the
	 * external OIDC subject token is the credential, which the server evaluates
	 * against the deployment's signup gate) and takes a urlencoded body.
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
		const response = await this.replayUnsafeFetcher(url, {
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
	 * rotates it on every use: the response returns its successor, and the
	 * presented token is spent whether or not the caller stores the replacement.
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
 * The path identity lets a verdict settle the upload even if it arrives before
 * the acknowledgement.
 * `retention` is set when the original negotiation response acknowledged
 * `upload-grace-facts`. On an identity-based reconnect, it asks a capable server
 * to return the stored grace fact after the pending row has been cleared.
 */
export interface CommitTarget {
	readonly uploadId: UploadId;
	readonly storePathHash: StorePathHash;
	readonly narHash: NixSha256HashString;
	readonly retention?: boolean;
}

export interface CommitOptions {
	/**
	 * Bounds how long a deferred upload waits for its verdict, and how long the
	 * session as a whole waits for the server to grant commit capacity.
	 */
	readonly timeoutSeconds?: number;
	readonly onCapabilities?: (capabilities: AdvertisedCapabilities) => void;
	/**
	 * Called when the session starts waiting for commit capacity, and again when
	 * it stops, so a progress display can report the fact.
	 */
	readonly onWaiting?: (isWaitingForCapacity: boolean) => void;
}

const defaultCommitWaitSeconds = 600;

const connectCommitSocket: CommitSocketConnect = (url, headers) =>
	new WebSocket(url, { headers: { ...headers } });

// Cloudflare stamps edge responses with `cf-ray`, which ties a server failure to
// its log entry. Local and non-Cloudflare responses can omit the header.
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
