import {
	type BootstrapResponse,
	bootstrapResponseSchema,
	cacheNameSchema,
	type CommitResponse,
	commitResponseSchema,
	DEFAULT_CACHE,
	type DeletePathResponse,
	deletePathResponseSchema,
	type KeyListResponse,
	keyListResponseSchema,
	type KeyRetireResponse,
	keyRetireResponseSchema,
	type KeyRotateResponse,
	keyRotateResponseSchema,
	type RootListResponse,
	rootListResponseSchema,
	type RootRemoveResponse,
	rootRemoveResponseSchema,
	type RootSetBody,
	type RootSetResponse,
	rootSetResponseSchema,
	type StatsResponse,
	statsResponseSchema,
	type UsageResponse,
	usageResponseSchema,
	type UploadNegotiateRequest,
	type UploadNegotiateResponse,
	uploadNegotiateResponseSchema,
	type UploadPrepareRequest,
	type UploadPrepareResponse,
	uploadPrepareResponseSchema
} from '@cupboard/shared';
import { z } from 'zod';

import {
	CupboardHttpError,
	CupboardUploadError,
	InvalidCacheNameError,
	MalformedResponseError,
	ResponseSchemaMismatchError
} from './errors.ts';

/**
 * Supplies bearer tokens to the client and can refresh them. The CLI exchanges
 * a bootstrap secret for a short-lived admin JWT; a long push can outlive that
 * token, so the client refreshes through the provider and retries once on a
 * 401.
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

	bootstrap(bootstrapSecret: string): Promise<BootstrapResponse> {
		return this.requestJson('/auth/bootstrap', bootstrapResponseSchema, {
			method: 'POST',
			token: bootstrapSecret
		});
	}

	async publicKey(): Promise<string> {
		const response = await this.request('/pubkey');

		return response.text();
	}

	private scoped(path: string): string {
		return `${this.cachePrefix}${path}`;
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

	private async requestJson<S extends z.ZodType>(
		path: string,
		schema: S,
		options: ClientRequestOptions = {}
	): Promise<z.output<S>> {
		const response = await this.request(path, options);
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
		const url = new URL(path, this.baseUrl);
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
}

interface StreamingRequestInit extends RequestInit {
	readonly duplex: 'half';
}
