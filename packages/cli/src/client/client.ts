import { cacheNameSchema, DEFAULT_CACHE } from '@cupboard/nix/scalars';
import {
	type AttestationAttachResponse,
	attestationAttachResponseSchema,
	type AttestationNegotiateRequest,
	type AttestationNegotiateResponse,
	attestationNegotiateResponseSchema,
	type AttestationPrepareResponse,
	attestationPrepareResponseSchema
} from '@cupboard/protocol/attestations';
import {
	type ControlKeyListResponse,
	controlKeyListResponseSchema,
	type ControlKeyRetireResponse,
	controlKeyRetireResponseSchema,
	type ControlKeyRotateResponse,
	controlKeyRotateResponseSchema
} from '@cupboard/protocol/control-keys';
import {
	type ParsedTokenResponse,
	refreshTokenGrantType,
	tokenExchangeGrantType,
	tokenResponseSchema
} from '@cupboard/protocol/oidc';
import {
	controlCheckReportSchema,
	type ParsedControlCheckReport
} from '@cupboard/protocol/reports';
import {
	type RootListResponse,
	rootListResponseSchema,
	type RootRemoveResponse,
	rootRemoveResponseSchema,
	type RootSetBody,
	type RootSetResponse,
	rootSetResponseSchema
} from '@cupboard/protocol/retention';
import {
	type ParsedSignupResponse,
	type SignupRequest,
	signupResponseSchema
} from '@cupboard/protocol/signup';
import {
	type TenantCreateBody,
	type TenantListResponse,
	tenantListResponseSchema,
	type TenantMutateResponse,
	tenantMutateResponseSchema,
	type TenantSummary,
	tenantSummarySchema
} from '@cupboard/protocol/tenants';
import {
	type CommitResponse,
	type DeletePathResponse,
	deletePathResponseSchema,
	type UploadNegotiateRequest,
	type UploadNegotiateResponse,
	uploadNegotiateResponseSchema,
	type UploadPrepareRequest,
	type UploadPrepareResponse,
	uploadPrepareResponseSchema
} from '@cupboard/protocol/upload';
import { WebSocket } from 'ws';
import { z } from 'zod';

import { throwIfAborted } from '../abort.ts';
import {
	CupboardHttpError,
	CupboardUploadError,
	InvalidCacheNameError,
	MalformedResponseError,
	ResponseSchemaMismatchError
} from '../errors.ts';

import {
	type CommitSocketConnect,
	settleCommitSocket
} from './commit-socket.ts';
import {
	type AccessCredential,
	bearerHeaders,
	isTokenProvider,
	resolveBearer
} from './credentials.ts';

export { type AccessCredential, type TokenProvider } from './credentials.ts';

export interface CupboardBlobUpload {
	readonly r2Key: string;
	readonly uploadUrl: string;
	readonly body: ReadableStream<Uint8Array>;
	readonly contentLength: number;
	readonly headers: Readonly<Record<string, string>>;
}

export class CupboardClient {
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

	static fromUrl(
		value: string,
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

	async publicKey(): Promise<string> {
		const response = await this.request('/pubkey');
		const body = await response.text();

		// The route renders the key set with a trailing newline; the keys
		// themselves carry none, so return them without it.
		return body.trimEnd();
	}

	/**
	 * The build version the deployment answers on its unauthenticated
	 * `/_version` route, without the trailing newline the route renders.
	 */
	async version(): Promise<string> {
		const response = await this.request('/_version');
		const body = await response.text();

		return body.trimEnd();
	}

	private scoped(path: string): string {
		return `${this.cachePrefix}${path}`;
	}

	// Resolves a route under the base URL's full path, so a tenant base like
	// `https://host/t/<tenant>` keeps its prefix. A plain `new URL('/path', base)`
	// would discard the base path, because an absolute path replaces it.
	private resolve(path: string): URL {
		const url = new URL(this.baseUrl);
		url.pathname = `${url.pathname.replace(/\/$/, '')}${path}`;

		return url;
	}

	/**
	 * The admin-gated deployment check at the bare host: diagnostics only the
	 * deployment can perform on itself, such as proving the R2 credentials it
	 * is bound with (their values cannot be read back from outside).
	 */
	controlCheck(token: AccessCredential): Promise<ParsedControlCheckReport> {
		return this.requestJson('/control/check', controlCheckReportSchema, {
			token
		});
	}

	// The control-plane key routes live at the bare host, not under a tenant
	// prefix, so this client must be built from the deployment's base URL.
	listControlKeys(token: AccessCredential): Promise<ControlKeyListResponse> {
		return this.requestJson('/control/keys', controlKeyListResponseSchema, {
			token
		});
	}

	rotateControlKey(token: AccessCredential): Promise<ControlKeyRotateResponse> {
		return this.requestJson(
			'/control/keys/rotate',
			controlKeyRotateResponseSchema,
			{
				method: 'POST',
				token
			}
		);
	}

	retireControlKey(
		token: AccessCredential,
		kid: string
	): Promise<ControlKeyRetireResponse> {
		return this.requestJson(
			`/control/keys/retire/${encodeURIComponent(kid)}`,
			controlKeyRetireResponseSchema,
			{
				method: 'POST',
				token
			}
		);
	}

	// The tenant registry routes live at the bare host, so this client must be
	// built from the deployment's base URL with a control-admin token.
	createTenant(
		token: AccessCredential,
		body: TenantCreateBody
	): Promise<TenantSummary> {
		return this.requestJson('/control/tenants', tenantSummarySchema, {
			method: 'POST',
			token,
			body
		});
	}

	listTenants(token: AccessCredential): Promise<TenantListResponse> {
		return this.requestJson('/control/tenants', tenantListResponseSchema, {
			token
		});
	}

	suspendTenant(
		token: AccessCredential,
		id: string
	): Promise<TenantMutateResponse> {
		return this.requestJson(
			`/control/tenants/${encodeURIComponent(id)}/suspend`,
			tenantMutateResponseSchema,
			{
				method: 'POST',
				token
			}
		);
	}

	deleteTenant(
		token: AccessCredential,
		id: string
	): Promise<TenantMutateResponse> {
		return this.requestJson(
			`/control/tenants/${encodeURIComponent(id)}`,
			tenantMutateResponseSchema,
			{
				method: 'DELETE',
				token
			}
		);
	}

	deleteStorePath(
		token: AccessCredential,
		storePathHash: string
	): Promise<DeletePathResponse> {
		return this.requestJson(
			this.scoped(`/paths/${storePathHash}`),
			deletePathResponseSchema,
			{
				method: 'DELETE',
				token
			}
		);
	}

	setRoot(
		token: AccessCredential,
		name: string,
		body: RootSetBody
	): Promise<RootSetResponse> {
		return this.requestJson(
			this.scoped(`/roots/${encodeURIComponent(name)}`),
			rootSetResponseSchema,
			{
				method: 'PUT',
				token,
				body
			}
		);
	}

	listRoots(token: AccessCredential): Promise<RootListResponse> {
		return this.requestJson(this.scoped('/roots'), rootListResponseSchema, {
			token
		});
	}

	removeRoot(
		token: AccessCredential,
		name: string
	): Promise<RootRemoveResponse> {
		return this.requestJson(
			this.scoped(`/roots/${encodeURIComponent(name)}`),
			rootRemoveResponseSchema,
			{
				method: 'DELETE',
				token
			}
		);
	}

	negotiate(
		token: AccessCredential,
		body: UploadNegotiateRequest
	): Promise<UploadNegotiateResponse> {
		return this.requestJson(
			this.scoped('/uploads'),
			uploadNegotiateResponseSchema,
			{
				method: 'POST',
				token,
				body
			}
		);
	}

	/**
	 * Commits an upload over the commit WebSocket. The upgrade request carries
	 * the write token; a deferred upload parks on the socket for the server's
	 * verification verdict, or returns `pending` straight away when `wait` is
	 * off.
	 */
	async commit(
		token: AccessCredential,
		uploadId: string,
		options: CommitOptions = {}
	): Promise<CommitResponse> {
		throwIfAborted(this.signal);

		const path = this.scoped(`/uploads/${uploadId}/commit`);
		const settle = (bearer: string | undefined): Promise<CommitResponse> =>
			settleCommitSocket(
				this.connectSocket(this.socketUrl(path), bearerHeaders(bearer)),
				{
					path,
					uploadId,
					wait: options.wait ?? true,
					timeoutSeconds: options.timeoutSeconds ?? defaultCommitWaitSeconds,
					signal: this.signal
				}
			);

		try {
			return await settle(await resolveBearer(token));
		} catch (error) {
			// A long push can outlive the exchanged JWT; refresh once and retry.
			if (
				error instanceof CupboardHttpError &&
				error.status === unauthorizedStatusCode &&
				isTokenProvider(token)
			) {
				return settle(await token.refresh());
			}

			throw error;
		}
	}

	private socketUrl(path: string): URL {
		const url = this.resolve(path);
		url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';

		return url;
	}

	prepareUpload(
		token: AccessCredential,
		uploadId: string,
		body: UploadPrepareRequest
	): Promise<UploadPrepareResponse> {
		return this.requestJson(
			this.scoped(`/uploads/${uploadId}`),
			uploadPrepareResponseSchema,
			{
				method: 'PUT',
				token,
				body
			}
		);
	}

	negotiateAttestations(
		token: AccessCredential,
		body: AttestationNegotiateRequest
	): Promise<AttestationNegotiateResponse> {
		return this.requestJson(
			this.scoped('/attestations'),
			attestationNegotiateResponseSchema,
			{
				method: 'POST',
				token,
				body
			}
		);
	}

	prepareAttestation(
		token: AccessCredential,
		uploadId: string
	): Promise<AttestationPrepareResponse> {
		return this.requestJson(
			this.scoped(`/attestations/${uploadId}`),
			attestationPrepareResponseSchema,
			{
				method: 'PUT',
				token
			}
		);
	}

	attachAttestation(
		token: AccessCredential,
		uploadId: string
	): Promise<AttestationAttachResponse> {
		return this.requestJson(
			this.scoped(`/attestations/${uploadId}/attach`),
			attestationAttachResponseSchema,
			{
				method: 'POST',
				token
			}
		);
	}

	async uploadBlob(upload: CupboardBlobUpload): Promise<void> {
		throwIfAborted(this.signal);

		const requestHeaders = new Headers(upload.headers);
		requestHeaders.set('content-length', String(upload.contentLength));
		const request: StreamingRequestInit = {
			method: 'PUT',
			headers: requestHeaders,
			body: upload.body,
			duplex: 'half',
			signal: this.signal
		};
		const response = await this.fetcher(upload.uploadUrl, request);

		if (response.ok) {
			return;
		}

		throw new CupboardUploadError(
			upload.r2Key,
			response.status,
			await response.text()
		);
	}

	/**
	 * Exchanges an external OIDC subject token for a cupboard access token at the
	 * OAuth `POST /token` endpoint. The endpoint is unauthenticated — the subject
	 * token is the credential — and takes a urlencoded body, so it bypasses the
	 * JSON request path the rest of the client uses.
	 */
	/**
	 * Claims (or idempotently re-claims) global admin of the deployment at the
	 * bootstrap `POST /signup` endpoint. The endpoint is unauthenticated — the
	 * external OIDC subject token is the credential, judged against the
	 * deployment's signup gate — and takes a urlencoded body.
	 */
	async signup(request: SignupRequest): Promise<ParsedSignupResponse> {
		throwIfAborted(this.signal);

		const url = this.resolve('/signup');
		const body = new URLSearchParams({
			subject_token: request.subject_token,
			...(request.claim_secret === undefined
				? {}
				: { claim_secret: request.claim_secret })
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
				await response.text()
			);
		}

		return this.parseJson('/signup', signupResponseSchema, response);
	}

	async tokenExchange(
		subjectToken: string,
		subjectTokenType: string
	): Promise<ParsedTokenResponse> {
		const response = await this.postTokenForm({
			grant_type: tokenExchangeGrantType,
			subject_token: subjectToken,
			subject_token_type: subjectTokenType
		});

		return this.parseJson('/token', tokenResponseSchema, response);
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

	private async postTokenForm(
		form: Readonly<Record<string, string>>
	): Promise<Response> {
		throwIfAborted(this.signal);

		const url = this.resolve('/token');
		const response = await this.fetcher(url, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams(form).toString(),
			signal: this.signal
		});

		if (!response.ok) {
			throw new CupboardHttpError(
				'POST',
				'/token',
				response.status,
				await response.text()
			);
		}

		return response;
	}

	private async requestJson<S extends z.ZodType>(
		path: string,
		schema: S,
		options: ClientRequestOptions = {}
	): Promise<z.output<S>> {
		const response = await this.request(path, options);

		return this.parseJson(path, schema, response);
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
			throw new ResponseSchemaMismatchError(
				path,
				z.prettifyError(result.error)
			);
		}

		return result.data;
	}

	private async request(
		path: string,
		options: ClientRequestOptions = {}
	): Promise<Response> {
		throwIfAborted(this.signal);

		const method = options.method ?? 'GET';
		const url = this.resolve(path);

		for (const [key, value] of Object.entries(options.query ?? {})) {
			url.searchParams.set(key, value);
		}

		const body =
			options.body === undefined ? undefined : JSON.stringify(options.body);
		const credential = options.token;

		let response = await this.send(
			url,
			method,
			options.headers,
			body,
			await resolveBearer(credential)
		);

		// A long push can outlive the exchanged JWT; refresh once and retry.
		if (
			response.status === unauthorizedStatusCode &&
			isTokenProvider(credential)
		) {
			response = await this.send(
				url,
				method,
				options.headers,
				body,
				await credential.refresh()
			);
		}

		if (!response.ok) {
			throw new CupboardHttpError(
				method,
				path,
				response.status,
				await response.text()
			);
		}

		return response;
	}

	private send(
		url: URL,
		method: string,
		headers: ConstructorParameters<typeof Headers>[0],
		body: string | undefined,
		bearer: string | undefined
	): Promise<Response> {
		throwIfAborted(this.signal);

		const requestHeaders = new Headers(headers);

		if (bearer !== undefined) {
			requestHeaders.set('authorization', `Bearer ${bearer}`);
		}

		if (body !== undefined) {
			requestHeaders.set('content-type', 'application/json');
		}

		return this.fetcher(url, {
			method,
			headers: requestHeaders,
			body,
			signal: this.signal
		});
	}
}

export interface CupboardClientOptions {
	readonly cache?: string;
	readonly signal?: AbortSignal;
}

export interface CommitOptions {
	/** Park for the verification verdict on a deferred upload (the default). */
	readonly wait?: boolean;
	/** Bounds how long a parked upload waits for its verdict. */
	readonly timeoutSeconds?: number;
}

const unauthorizedStatusCode = 401;
const defaultCommitWaitSeconds = 600;

const connectCommitSocket: CommitSocketConnect = (url, headers) =>
	new WebSocket(url, { headers: { ...headers } });

function cachePrefixFor(cache: string): string {
	if (cache === DEFAULT_CACHE) {
		return '';
	}

	if (!cacheNameSchema.safeParse(cache).success) {
		throw new InvalidCacheNameError(cache);
	}

	return `/cache/${cache}`;
}

interface ClientRequestOptions {
	readonly method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
	readonly token?: AccessCredential;
	readonly headers?: ConstructorParameters<typeof Headers>[0];
	readonly body?: unknown;
	readonly query?: Readonly<Record<string, string>>;
}

interface StreamingRequestInit extends RequestInit {
	readonly duplex: 'half';
}
