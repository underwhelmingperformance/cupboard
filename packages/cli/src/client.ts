import type {
	CommitResponse,
	DeletePathResponse,
	InitResponse,
	StatsResponse,
	UploadNegotiateRequest,
	UploadNegotiateResponse,
	UploadPrepareRequest,
	UploadPrepareResponse
} from '@cupboard/shared';

import { CupboardHttpError, CupboardUploadError } from './errors.ts';

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
		public readonly fetcher: typeof fetch = fetch
	) {}

	static fromUrl(value: string): CupboardClient {
		return new CupboardClient(new URL(value));
	}

	init(bootstrapToken: string): Promise<InitResponse> {
		return this.requestJson('/admin/init', {
			method: 'POST',
			token: bootstrapToken
		});
	}

	async publicKey(): Promise<string> {
		const response = await this.request('/pubkey');

		return response.text();
	}

	stats(token: string): Promise<StatsResponse> {
		return this.requestJson('/_stats', { token });
	}

	deleteStorePath(
		token: string,
		storePathHash: string
	): Promise<DeletePathResponse> {
		return this.requestJson('/admin/delete', {
			method: 'POST',
			token,
			body: { storePathHash }
		});
	}

	negotiate(
		token: string,
		body: UploadNegotiateRequest
	): Promise<UploadNegotiateResponse> {
		return this.requestJson('/upload/negotiate', {
			method: 'POST',
			token,
			body
		});
	}

	commit(token: string, uploadId: string): Promise<CommitResponse> {
		return this.requestJson(`/upload/${uploadId}/commit`, {
			method: 'POST',
			token
		});
	}

	prepareUpload(
		token: string,
		uploadId: string,
		body: UploadPrepareRequest
	): Promise<UploadPrepareResponse> {
		return this.requestJson(`/upload/${uploadId}/prepare`, {
			method: 'POST',
			token,
			body
		});
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

	private async requestJson<T>(
		path: string,
		options: ClientRequestOptions = {}
	): Promise<T> {
		const response = await this.request(path, options);

		return (await response.json()) as T;
	}

	private async request(
		path: string,
		options: ClientRequestOptions = {}
	): Promise<Response> {
		const headers = new Headers(options.headers);

		if (options.token !== undefined) {
			headers.set('authorization', `Bearer ${options.token}`);
		}

		let body: string | undefined;

		if (options.body !== undefined) {
			headers.set('content-type', 'application/json');
			body = JSON.stringify(options.body);
		}

		const response = await this.fetcher(new URL(path, this.baseUrl), {
			method: options.method ?? 'GET',
			headers,
			body
		});

		if (!response.ok) {
			throw new CupboardHttpError(
				options.method ?? 'GET',
				path,
				response.status,
				await response.text()
			);
		}

		return response;
	}
}

interface ClientRequestOptions {
	readonly method?: 'GET' | 'POST';
	readonly token?: string;
	readonly headers?: ConstructorParameters<typeof Headers>[0];
	readonly body?: unknown;
}

interface StreamingRequestInit extends RequestInit {
	readonly duplex: 'half';
}
