import { cacheNameSchema, DEFAULT_CACHE } from '@cupboard/nix/scalars';
import {
	type CacheListResponse,
	cacheListResponseSchema,
	type CacheRemoveResponse,
	cacheRemoveResponseSchema,
	type CacheSummary,
	cacheSummarySchema
} from '@cupboard/protocol/caches';
import {
	type ControlKeyListResponse,
	controlKeyListResponseSchema,
	type ControlKeyRetireResponse,
	controlKeyRetireResponseSchema,
	type ControlKeyRotateResponse,
	controlKeyRotateResponseSchema
} from '@cupboard/protocol/control-keys';
import {
	type AuthKeyListResponse,
	authKeyListResponseSchema,
	type AuthKeyRetireResponse,
	authKeyRetireResponseSchema,
	type AuthKeyRotateResponse,
	authKeyRotateResponseSchema,
	type KeyListResponse,
	keyListResponseSchema,
	type KeyRetireResponse,
	keyRetireResponseSchema,
	type KeyRotateResponse,
	keyRotateResponseSchema
} from '@cupboard/protocol/keys';
import {
	type OidcTrustAddBody,
	type OidcTrustListResponse,
	oidcTrustListResponseSchema,
	type OidcTrustRemoveResponse,
	oidcTrustRemoveResponseSchema,
	type OidcTrustSummary,
	oidcTrustSummarySchema,
	type ParsedTokenResponse,
	tokenExchangeGrantType,
	tokenResponseSchema
} from '@cupboard/protocol/oidc';
import {
	type CheckReport,
	checkReportSchema
} from '@cupboard/protocol/reports';
import {
	type RetentionPolicyAddBody,
	type RetentionPolicyListResponse,
	retentionPolicyListResponseSchema,
	type RetentionPolicyRemoveResponse,
	retentionPolicyRemoveResponseSchema,
	type RetentionPolicySummary,
	retentionPolicySummarySchema,
	type RootListResponse,
	rootListResponseSchema,
	type RootRemoveResponse,
	rootRemoveResponseSchema,
	type RootSetBody,
	type RootSetResponse,
	rootSetResponseSchema
} from '@cupboard/protocol/retention';
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
	commitResponseSchema,
	type DeletePathResponse,
	deletePathResponseSchema,
	type StatsResponse,
	statsResponseSchema,
	type UploadNegotiateRequest,
	type UploadNegotiateResponse,
	uploadNegotiateResponseSchema,
	type UploadPrepareRequest,
	type UploadPrepareResponse,
	uploadPrepareResponseSchema,
	type UploadStatusResponse,
	uploadStatusResponseSchema,
	type UsageResponse,
	usageResponseSchema
} from '@cupboard/protocol/upload';
import { z } from 'zod';

import {
	CupboardHttpError,
	CupboardUploadError,
	InvalidCacheNameError,
	MalformedResponseError,
	ResponseSchemaMismatchError
} from '../errors.ts';

/**
 * Supplies bearer tokens to the client and can refresh them. The CLI obtains a
 * short-lived access token by OIDC token-exchange and caches it; a long push can
 * outlive that token, so the client refreshes through the provider and retries
 * once on a 401.
 */
export interface TokenProvider {
	get(): Promise<string>;
	refresh(): Promise<string>;
}

/** Either a fixed bearer token or a provider that can refresh one. */
export type AccessCredential = string | TokenProvider;

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
		public readonly cachePrefix = ''
	) {}

	static fromUrl(value: string, cache: string = DEFAULT_CACHE): CupboardClient {
		return new CupboardClient(new URL(value), fetch, cachePrefixFor(cache));
	}

	async publicKey(): Promise<string> {
		const response = await this.request('/pubkey');
		const body = await response.text();

		// The route renders the key set with a trailing newline; the keys
		// themselves carry none, so return them without it.
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

	stats(token: AccessCredential): Promise<StatsResponse> {
		return this.requestJson(this.scoped('/stats'), statsResponseSchema, {
			token
		});
	}

	usage(token: AccessCredential): Promise<UsageResponse> {
		return this.requestJson('/usage', usageResponseSchema, { token });
	}

	listKeys(token: AccessCredential): Promise<KeyListResponse> {
		return this.requestJson('/keys', keyListResponseSchema, { token });
	}

	rotateKey(token: AccessCredential): Promise<KeyRotateResponse> {
		return this.requestJson('/keys/rotate', keyRotateResponseSchema, {
			method: 'POST',
			token
		});
	}

	retireKey(token: AccessCredential, id: string): Promise<KeyRetireResponse> {
		return this.requestJson(
			`/keys/retire/${encodeURIComponent(id)}`,
			keyRetireResponseSchema,
			{
				method: 'POST',
				token
			}
		);
	}

	listCaches(token: AccessCredential): Promise<CacheListResponse> {
		return this.requestJson('/caches', cacheListResponseSchema, { token });
	}

	putCache(
		token: AccessCredential,
		name: string,
		priority: number
	): Promise<CacheSummary> {
		return this.requestJson(
			`/caches/${encodeURIComponent(name)}`,
			cacheSummarySchema,
			{
				method: 'PUT',
				token,
				body: { priority }
			}
		);
	}

	removeCache(
		token: AccessCredential,
		name: string,
		force: boolean
	): Promise<CacheRemoveResponse> {
		return this.requestJson(
			`/caches/${encodeURIComponent(name)}`,
			cacheRemoveResponseSchema,
			{
				method: 'DELETE',
				token,
				query: force ? { force: 'true' } : undefined
			}
		);
	}

	listPolicies(token: AccessCredential): Promise<RetentionPolicyListResponse> {
		return this.requestJson('/policies', retentionPolicyListResponseSchema, {
			token
		});
	}

	addPolicy(
		token: AccessCredential,
		body: RetentionPolicyAddBody
	): Promise<RetentionPolicySummary> {
		return this.requestJson('/policies', retentionPolicySummarySchema, {
			method: 'POST',
			token,
			body
		});
	}

	removePolicy(
		token: AccessCredential,
		id: string
	): Promise<RetentionPolicyRemoveResponse> {
		return this.requestJson(
			`/policies/${encodeURIComponent(id)}`,
			retentionPolicyRemoveResponseSchema,
			{
				method: 'DELETE',
				token
			}
		);
	}

	listOidcTrust(token: AccessCredential): Promise<OidcTrustListResponse> {
		return this.requestJson('/oidc-trust', oidcTrustListResponseSchema, {
			token
		});
	}

	addOidcTrust(
		token: AccessCredential,
		body: OidcTrustAddBody
	): Promise<OidcTrustSummary> {
		return this.requestJson('/oidc-trust', oidcTrustSummarySchema, {
			method: 'POST',
			token,
			body
		});
	}

	removeOidcTrust(
		token: AccessCredential,
		id: string
	): Promise<OidcTrustRemoveResponse> {
		return this.requestJson(
			`/oidc-trust/${encodeURIComponent(id)}`,
			oidcTrustRemoveResponseSchema,
			{
				method: 'DELETE',
				token
			}
		);
	}

	listAuthKeys(token: AccessCredential): Promise<AuthKeyListResponse> {
		return this.requestJson('/keys/auth', authKeyListResponseSchema, { token });
	}

	rotateAuthKey(token: AccessCredential): Promise<AuthKeyRotateResponse> {
		return this.requestJson('/keys/auth/rotate', authKeyRotateResponseSchema, {
			method: 'POST',
			token
		});
	}

	retireAuthKey(
		token: AccessCredential,
		kid: string
	): Promise<AuthKeyRetireResponse> {
		return this.requestJson(
			`/keys/auth/retire/${encodeURIComponent(kid)}`,
			authKeyRetireResponseSchema,
			{
				method: 'POST',
				token
			}
		);
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

	check(
		token: AccessCredential,
		options: { readonly deep: boolean }
	): Promise<CheckReport> {
		return this.requestJson('/check', checkReportSchema, {
			token,
			query: options.deep ? { deep: 'true' } : undefined
		});
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

	commit(token: AccessCredential, uploadId: string): Promise<CommitResponse> {
		return this.requestJson(
			this.scoped(`/uploads/${uploadId}/commit`),
			commitResponseSchema,
			{
				method: 'POST',
				token
			}
		);
	}

	uploadStatus(
		token: AccessCredential,
		uploadId: string
	): Promise<UploadStatusResponse> {
		return this.requestJson(
			`/uploads/${uploadId}/status`,
			uploadStatusResponseSchema,
			{ token }
		);
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

	async uploadBlob(upload: CupboardBlobUpload): Promise<void> {
		const requestHeaders = new Headers(upload.headers);
		requestHeaders.set('content-length', String(upload.contentLength));
		const request: StreamingRequestInit = {
			method: 'PUT',
			headers: requestHeaders,
			body: upload.body,
			duplex: 'half'
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
	async tokenExchange(
		subjectToken: string,
		subjectTokenType: string
	): Promise<ParsedTokenResponse> {
		const url = this.resolve('/token');
		const body = new URLSearchParams({
			grant_type: tokenExchangeGrantType,
			subject_token: subjectToken,
			subject_token_type: subjectTokenType
		});
		const response = await this.fetcher(url, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: body.toString()
		});

		if (!response.ok) {
			throw new CupboardHttpError(
				'POST',
				'/token',
				response.status,
				await response.text()
			);
		}

		return this.parseJson('/token', tokenResponseSchema, response);
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
		const requestHeaders = new Headers(headers);

		if (bearer !== undefined) {
			requestHeaders.set('authorization', `Bearer ${bearer}`);
		}

		if (body !== undefined) {
			requestHeaders.set('content-type', 'application/json');
		}

		return this.fetcher(url, { method, headers: requestHeaders, body });
	}
}

const unauthorizedStatusCode = 401;

function cachePrefixFor(cache: string): string {
	if (cache === DEFAULT_CACHE) {
		return '';
	}

	if (!cacheNameSchema.safeParse(cache).success) {
		throw new InvalidCacheNameError(cache);
	}

	return `/cache/${cache}`;
}

function isTokenProvider(
	credential: AccessCredential | undefined
): credential is TokenProvider {
	return typeof credential === 'object';
}

async function resolveBearer(
	credential: AccessCredential | undefined
): Promise<string | undefined> {
	if (credential === undefined || typeof credential === 'string') {
		return credential;
	}

	const token = await credential.get();

	return token;
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
