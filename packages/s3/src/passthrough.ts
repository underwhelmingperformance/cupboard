import { AwsClient } from 'aws4fetch';

import { type S3ErrorCode, UpstreamError } from './errors.ts';
import type {
	ByteRange,
	CompletedUpload,
	GetObjectResult,
	ListObjectsQuery,
	ListObjectsResult,
	MultipartUpload,
	ObjectContext,
	ObjectStat,
	ObjectStore,
	PutObjectMeta,
	PutObjectResult,
	UploadedPart
} from './ports.ts';
import {
	type CompletedPart,
	parseCompletedEtag,
	parseListResult,
	parseUploadId,
	renderCompleteMultipartUploadRequest,
	unquoteEtag
} from './xml.ts';

export interface PassthroughOptions {
	/**
	Base URL of the backing S3 service, e.g. R2's S3 endpoint.
	*/
	readonly endpoint: string;
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
	readonly region?: string;
	/**
	Underlying fetch, injected so tests can target an in-process app.
	*/
	readonly fetch?: typeof fetch;
}

/**
 * A reference {@link ObjectStore} that signs requests with SigV4 and relays
 * every operation to another S3 service, such as R2. When used with
 * `createS3App`, it forms the transparent proxy used as the conformance oracle
 * for the generic protocol layer. Do not use this store in production.
 */
export function createPassthroughStore(
	options: PassthroughOptions
): ObjectStore {
	const region = options.region ?? 'auto';
	const client = new AwsClient({
		accessKeyId: options.accessKeyId,
		secretAccessKey: options.secretAccessKey,
		service: 's3',
		region
	});
	const fetcher = options.fetch ?? fetch;

	async function send(
		method: string,
		url: URL,
		init: {
			headers?: Record<string, string>;
			body?: ReadableStream<Uint8Array> | string;
		} = {}
	): Promise<Response> {
		const signed = await client.sign(url.href, {
			method,
			headers: init.headers,
			body: init.body,
			aws: { service: 's3', region }
		});
		return fetcher(signed);
	}

	function objectUrl(bucket: string, key: string): URL {
		const path = key
			.split('/')
			.map((segment) => encodeURIComponent(segment))
			.join('/');
		return new URL(`/${encodeURIComponent(bucket)}/${path}`, options.endpoint);
	}

	function bucketUrl(bucket: string): URL {
		return new URL(`/${encodeURIComponent(bucket)}`, options.endpoint);
	}

	return {
		async stat(context: ObjectContext): Promise<ObjectStat | undefined> {
			const response = await send(
				'HEAD',
				objectUrl(context.bucket, context.key)
			);
			if (response.status === 404) {
				return undefined;
			}
			assertOk(response);
			return statFromHeaders(response.headers).stat;
		},

		async get(
			context: ObjectContext,
			range: ByteRange | undefined
		): Promise<GetObjectResult | undefined> {
			const headers: Record<string, string> = {};
			if (range !== undefined) {
				headers.range = rangeHeader(range);
			}
			const response = await send(
				'GET',
				objectUrl(context.bucket, context.key),
				{
					headers
				}
			);

			if (response.status === 404) {
				return undefined;
			}
			assertOk(response);

			const { stat, contentRange } = statFromHeaders(response.headers);
			const body = response.body ?? emptyStream();
			return { stat, body, range: contentRange };
		},

		async put(
			context: ObjectContext,
			body: ReadableStream<Uint8Array>,
			meta: PutObjectMeta
		): Promise<PutObjectResult> {
			const headers: Record<string, string> = {};
			if (meta.contentType !== undefined) {
				headers['content-type'] = meta.contentType;
			}
			if (meta.checksumSha256 !== undefined) {
				headers['x-amz-checksum-sha256'] = meta.checksumSha256;
			}

			const response = await send(
				'PUT',
				objectUrl(context.bucket, context.key),
				{
					headers,
					body
				}
			);
			assertOk(response);
			return { etag: etagOf(response.headers) };
		},

		async delete(context: ObjectContext): Promise<void> {
			const response = await send(
				'DELETE',
				objectUrl(context.bucket, context.key)
			);
			if (response.status !== 404) {
				assertOk(response);
			}
		},

		async list(
			bucket: string,
			query: ListObjectsQuery
		): Promise<ListObjectsResult> {
			const url = bucketUrl(bucket);
			url.searchParams.set('list-type', '2');
			url.searchParams.set('prefix', query.prefix);
			url.searchParams.set('max-keys', String(query.maxKeys));
			if (query.delimiter !== undefined) {
				url.searchParams.set('delimiter', query.delimiter);
			}
			if (query.continuationToken !== undefined) {
				url.searchParams.set('continuation-token', query.continuationToken);
			}

			const response = await send('GET', url);
			assertOk(response);
			return parseListResult(await response.text());
		},

		async bucketExists(bucket: string): Promise<boolean> {
			const response = await send('HEAD', bucketUrl(bucket));
			return response.status === 200;
		},

		async createMultipartUpload(
			context: ObjectContext,
			meta: PutObjectMeta
		): Promise<MultipartUpload> {
			const url = objectUrl(context.bucket, context.key);
			url.searchParams.set('uploads', '');
			const headers =
				meta.contentType === undefined
					? undefined
					: { 'content-type': meta.contentType };

			const response = await send('POST', url, { headers });
			assertOk(response);
			return { uploadId: parseUploadId(await response.text()) };
		},

		async uploadPart(
			context: ObjectContext,
			uploadId: string,
			partNumber: number,
			contentLength: number | undefined,
			body: ReadableStream<Uint8Array>
		): Promise<UploadedPart> {
			const url = objectUrl(context.bucket, context.key);
			url.searchParams.set('partNumber', String(partNumber));
			url.searchParams.set('uploadId', uploadId);

			const headers =
				contentLength === undefined
					? undefined
					: { 'content-length': String(contentLength) };
			const response = await send('PUT', url, { body, headers });
			assertOk(response);
			return { partNumber, etag: etagOf(response.headers) };
		},

		async completeMultipartUpload(
			context: ObjectContext,
			uploadId: string,
			parts: readonly UploadedPart[]
		): Promise<CompletedUpload> {
			const url = objectUrl(context.bucket, context.key);
			url.searchParams.set('uploadId', uploadId);
			const body = renderCompleteMultipartUploadRequest(
				parts.map((part): CompletedPart => ({
					partNumber: part.partNumber,
					etag: part.etag
				}))
			);

			const response = await send('POST', url, {
				headers: { 'content-type': 'application/xml' },
				body
			});
			assertOk(response);
			return { etag: parseCompletedEtag(await response.text()) };
		},

		async abortMultipartUpload(
			context: ObjectContext,
			uploadId: string
		): Promise<void> {
			const url = objectUrl(context.bucket, context.key);
			url.searchParams.set('uploadId', uploadId);
			const response = await send('DELETE', url);
			if (response.status !== 404) {
				assertOk(response);
			}
		}
	} satisfies ObjectStore;
}

interface StatResult {
	readonly stat: ObjectStat;
	readonly contentRange:
		{ readonly start: number; readonly end: number } | undefined;
}

function statFromHeaders(headers: Headers): StatResult {
	const etagHeader = headers.get('etag');
	const lastModified = headers.get('last-modified');
	const contentRangeHeader = headers.get('content-range');
	const range = parseContentRange(contentRangeHeader);

	const size = range?.total ?? Number(headers.get('content-length') ?? '0');

	return {
		stat: {
			size,
			etag: etagHeader === null ? '' : unquoteEtag(etagHeader),
			contentType: headers.get('content-type') ?? undefined,
			lastModified: lastModified === null ? new Date(0) : new Date(lastModified)
		},
		contentRange:
			range === undefined ? undefined : { start: range.start, end: range.end }
	};
}

function parseContentRange(
	header: string | null
): { start: number; end: number; total: number } | undefined {
	if (header === null) {
		return undefined;
	}

	const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header);
	if (match === null) {
		return undefined;
	}

	const [, start, end, total] = match;
	return { start: Number(start), end: Number(end), total: Number(total) };
}

function rangeHeader(range: ByteRange): string {
	if ('suffix' in range) {
		return `bytes=-${String(range.suffix)}`;
	}

	if (range.length === undefined) {
		return `bytes=${String(range.offset)}-`;
	}

	return `bytes=${String(range.offset)}-${String(range.offset + range.length - 1)}`;
}

function etagOf(headers: Headers): string {
	const etag = headers.get('etag');
	return etag === null ? '' : unquoteEtag(etag);
}

const statusToCode: Record<number, S3ErrorCode> = {
	403: 'AccessDenied',
	404: 'NoSuchKey',
	405: 'MethodNotAllowed',
	411: 'MissingContentLength',
	412: 'PreconditionFailed',
	501: 'NotImplemented'
};

function assertOk(response: Response): void {
	if (response.ok) {
		return;
	}

	const code = statusToCode[response.status] ?? 'InternalError';
	throw new UpstreamError(
		response.status,
		code,
		`Upstream responded with ${String(response.status)}.`
	);
}

function emptyStream(): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.close();
		}
	});
}
