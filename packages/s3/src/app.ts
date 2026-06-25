import { Hono } from 'hono';
import { StatusCodes } from 'http-status-codes';

import {
	dechunkStream,
	decodedContentLength,
	isAwsChunked
} from './chunked.ts';
import { evaluatePreconditions } from './conditional.ts';
import {
	ControlBodyTooLargeError,
	DeleteObjectsTooManyKeysError,
	InternalError,
	InvalidRangeError,
	ListPartsNotImplementedError,
	MalformedXmlBodyError,
	NoSuchBucketError,
	NoSuchKeyError,
	PreconditionFailedError,
	S3Error,
	type S3ErrorCode,
	UnsupportedOperationError
} from './errors.ts';
import type {
	ByteRange,
	CredentialResolver,
	ObjectContext,
	ObjectStat,
	ObjectStore,
	PutObjectMeta,
	S3Principal
} from './ports.ts';
import {
	parseMaxKeys,
	parseRange,
	parseRequest,
	type S3Operation
} from './request.ts';
import { isSigned, verifySignature } from './sigv4.ts';
import {
	type DeleteObjectsError,
	parseCompleteMultipartUpload,
	parseDeleteObjects,
	quoteEtag,
	renderBucketLocation,
	renderCompleteMultipartUpload,
	renderDeleteResult,
	renderInitiateMultipartUpload,
	renderListObjectsV1,
	renderListObjectsV2
} from './xml.ts';

export interface S3AppDeps {
	readonly resolver: CredentialResolver;
	readonly store: ObjectStore;
	/** Region reported by `GetBucketLocation`; defaults to `auto`. */
	readonly region?: string;
	/** Request-id source, injected for deterministic tests. */
	readonly requestId?: () => string;
}

/**
 * Builds a generic, S3-compatible Hono app over the injected
 * {@link CredentialResolver} and {@link ObjectStore}. The app owns the wire
 * protocol; all object semantics live behind the store.
 */
export function createS3App(deps: S3AppDeps): Hono {
	const app = new Hono();
	app.all('*', (context) => handle(context.req.raw, deps));
	return app;
}

async function handle(request: Request, deps: S3AppDeps): Promise<Response> {
	const requestId = (deps.requestId ?? defaultRequestId)();

	try {
		const url = new URL(request.url);
		const principal = isSigned(request)
			? await verifySignature(request, deps.resolver)
			: undefined;

		const { bucket, operation } = parseRequest(request, url);
		return await dispatch({
			request,
			url,
			bucket,
			operation,
			principal,
			deps,
			requestId
		});
	} catch (error) {
		if (error instanceof S3Error) {
			return error.toResponse(requestId);
		}

		// Internal failures are logged server-side but never described to the
		// client: the message could carry credential-decryption, database or
		// validation detail. Clients see a fixed, generic error.
		console.error('s3 request failed', requestId, error);
		return new InternalError().toResponse(requestId);
	}
}

interface Dispatch {
	readonly request: Request;
	readonly url: URL;
	readonly bucket: string;
	readonly operation: S3Operation;
	readonly principal: S3Principal | undefined;
	readonly deps: S3AppDeps;
	readonly requestId: string;
}

function dispatch(input: Dispatch): Promise<Response> {
	const { operation } = input;

	switch (operation.kind) {
		case 'GetBucketLocation': {
			return getBucketLocation(input);
		}
		case 'HeadBucket': {
			return headBucket(input);
		}
		case 'ListObjects': {
			return listObjects(input, operation.isV2);
		}
		case 'GetObject': {
			return getObject(input, operation.key);
		}
		case 'HeadObject': {
			return headObject(input, operation.key);
		}
		case 'PutObject': {
			return putObject(input, operation.key);
		}
		case 'DeleteObject': {
			return deleteObject(input, operation.key);
		}
		case 'DeleteObjects': {
			return deleteObjects(input);
		}
		case 'CreateMultipartUpload': {
			return createMultipartUpload(input, operation.key);
		}
		case 'UploadPart': {
			return uploadPart(
				input,
				operation.key,
				operation.uploadId,
				operation.partNumber
			);
		}
		case 'CompleteMultipartUpload': {
			return completeMultipartUpload(input, operation.key, operation.uploadId);
		}
		case 'AbortMultipartUpload': {
			return abortMultipartUpload(input, operation.key, operation.uploadId);
		}
		case 'ListParts': {
			throw new ListPartsNotImplementedError();
		}
		case 'Unsupported': {
			throw new UnsupportedOperationError();
		}
	}
}

function contextFor(input: Dispatch, key: string): ObjectContext {
	return { bucket: input.bucket, key, principal: input.principal };
}

async function getObject(input: Dispatch, key: string): Promise<Response> {
	const range = parseRange(input.request.headers.get('range'));
	const result = await input.deps.store.get(contextFor(input, key), range);

	if (result === undefined) {
		// A store may decline an unsatisfiable range by returning nothing; a stat
		// distinguishes a missing object (404) from a present one (416).
		if (range !== undefined) {
			const stat = await input.deps.store.stat(contextFor(input, key));
			if (stat !== undefined) {
				throw new InvalidRangeError(key);
			}
		}
		throw new NoSuchKeyError(key);
	}

	if (range !== undefined && isRangeUnsatisfiable(range, result.stat.size)) {
		await result.body.cancel();
		throw new InvalidRangeError(key);
	}

	const outcome = evaluatePreconditions(input.request.headers, result.stat);
	if (outcome !== 'ok') {
		await result.body.cancel();
		return conditionalResponse(outcome, result.stat, input.requestId);
	}

	const headers = objectHeaders(result.stat, input.requestId, result.range);
	const status =
		result.range === undefined ? StatusCodes.OK : StatusCodes.PARTIAL_CONTENT;
	return new Response(result.body, { status, headers });
}

async function headObject(input: Dispatch, key: string): Promise<Response> {
	const stat = await input.deps.store.stat(contextFor(input, key));
	if (stat === undefined) {
		throw new NoSuchKeyError(key);
	}

	const outcome = evaluatePreconditions(input.request.headers, stat);
	if (outcome !== 'ok') {
		return conditionalResponse(outcome, stat, input.requestId);
	}

	return new Response(undefined, {
		status: StatusCodes.OK,
		headers: objectHeaders(stat, input.requestId, undefined)
	});
}

async function putObject(input: Dispatch, key: string): Promise<Response> {
	const result = await input.deps.store.put(
		contextFor(input, key),
		writeBody(input.request),
		putMeta(input.request)
	);

	return new Response(undefined, {
		status: StatusCodes.OK,
		headers: {
			etag: quoteEtag(result.etag),
			'x-amz-request-id': input.requestId
		}
	});
}

async function deleteObject(input: Dispatch, key: string): Promise<Response> {
	await input.deps.store.delete(contextFor(input, key));
	return noContent(input.requestId);
}

async function deleteObjects(input: Dispatch): Promise<Response> {
	const body = await readControlBody(input.request);
	const { keys, quiet: isQuiet } = parseXml(() => parseDeleteObjects(body));

	if (keys.length > maxDeleteKeys) {
		throw new DeleteObjectsTooManyKeysError();
	}

	const deleted: string[] = [];
	const errors: DeleteObjectsError[] = [];

	for (const key of keys) {
		try {
			await input.deps.store.delete(contextFor(input, key));
			deleted.push(key);
		} catch (error) {
			if (!(error instanceof S3Error) || isRequestLevel(error)) {
				throw error;
			}
			errors.push({ key, code: error.code, message: error.message });
		}
	}

	// In quiet mode S3 reports only the errors, suppressing successful deletions.
	return xmlResponse(
		renderDeleteResult(isQuiet ? [] : deleted, errors),
		input.requestId
	);
}

// A batch delete reports per-object failures in its result body, but an
// authorisation or unsupported-operation failure is a property of the whole
// request: it fails the request so a client sees one `403`/`501` rather than a
// `200` that lists every key as individually failed.
const requestLevelDeleteCodes = new Set<S3ErrorCode>([
	'AccessDenied',
	'NotImplemented'
]);

function isRequestLevel(error: S3Error): boolean {
	return requestLevelDeleteCodes.has(error.code);
}

async function createMultipartUpload(
	input: Dispatch,
	key: string
): Promise<Response> {
	const upload = await input.deps.store.createMultipartUpload(
		contextFor(input, key),
		putMeta(input.request)
	);

	return xmlResponse(
		renderInitiateMultipartUpload(input.bucket, key, upload.uploadId),
		input.requestId
	);
}

async function uploadPart(
	input: Dispatch,
	key: string,
	uploadId: string,
	partNumber: number
): Promise<Response> {
	const part = await input.deps.store.uploadPart(
		contextFor(input, key),
		uploadId,
		partNumber,
		writeBody(input.request)
	);

	return new Response(undefined, {
		status: StatusCodes.OK,
		headers: {
			etag: quoteEtag(part.etag),
			'x-amz-request-id': input.requestId
		}
	});
}

async function completeMultipartUpload(
	input: Dispatch,
	key: string,
	uploadId: string
): Promise<Response> {
	const body = await readControlBody(input.request);
	const parts = parseXml(() => parseCompleteMultipartUpload(body));
	const result = await input.deps.store.completeMultipartUpload(
		contextFor(input, key),
		uploadId,
		parts
	);

	const location = `${input.url.origin}/${input.bucket}/${key}`;
	return xmlResponse(
		renderCompleteMultipartUpload(location, input.bucket, key, result.etag),
		input.requestId
	);
}

async function abortMultipartUpload(
	input: Dispatch,
	key: string,
	uploadId: string
): Promise<Response> {
	await input.deps.store.abortMultipartUpload(contextFor(input, key), uploadId);
	return noContent(input.requestId);
}

async function getBucketLocation(input: Dispatch): Promise<Response> {
	const isExists = await input.deps.store.bucketExists(
		input.bucket,
		input.principal
	);
	if (!isExists) {
		throw new NoSuchBucketError();
	}

	return xmlResponse(
		renderBucketLocation(input.deps.region ?? 'auto'),
		input.requestId
	);
}

async function headBucket(input: Dispatch): Promise<Response> {
	const isExists = await input.deps.store.bucketExists(
		input.bucket,
		input.principal
	);
	if (!isExists) {
		throw new NoSuchBucketError();
	}

	return new Response(undefined, {
		status: StatusCodes.OK,
		headers: { 'x-amz-request-id': input.requestId }
	});
}

async function listObjects(input: Dispatch, isV2: boolean): Promise<Response> {
	const query = input.url.searchParams;
	const token = isV2
		? (query.get('continuation-token') ?? query.get('start-after'))
		: query.get('marker');
	const continuationToken = token ?? undefined;

	const prefix = query.get('prefix') ?? '';
	const delimiter = query.get('delimiter') ?? undefined;
	const maxKeys = parseMaxKeys(query.get('max-keys'));

	const result = await input.deps.store.list(
		input.bucket,
		{ prefix, delimiter, continuationToken, maxKeys },
		input.principal
	);

	const render = {
		bucket: input.bucket,
		prefix,
		delimiter,
		maxKeys,
		keyCount: result.objects.length + result.commonPrefixes.length,
		isTruncated: result.isTruncated,
		continuationToken,
		nextContinuationToken: result.nextContinuationToken,
		contents: result.objects.map((object) => ({
			key: object.key,
			lastModified: object.lastModified,
			etag: object.etag,
			size: object.size
		})),
		commonPrefixes: result.commonPrefixes
	};

	const render2 = isV2 ? renderListObjectsV2 : renderListObjectsV1;
	return xmlResponse(render2(render), input.requestId);
}

// The effective object body for a write: AWS chunked requests carry the bytes
// inside a chunk-framing envelope, which is stripped here so only the content
// reaches the store. Other requests stream through unchanged.
function writeBody(request: Request): ReadableStream<Uint8Array> {
	const body = request.body ?? emptyStream();
	return isAwsChunked(request) ? dechunkStream(body) : body;
}

function putMeta(request: Request): PutObjectMeta {
	// For a chunked request `content-length` is the framed envelope length; the
	// object's real length is `x-amz-decoded-content-length`.
	const rawLength = request.headers.get('content-length');
	const contentLength =
		decodedContentLength(request) ??
		(rawLength === null ? undefined : Number(rawLength));

	return {
		contentType: request.headers.get('content-type') ?? undefined,
		contentLength,
		checksumSha256: request.headers.get('x-amz-checksum-sha256') ?? undefined
	};
}

function objectHeaders(
	stat: ObjectStat,
	requestId: string,
	range: { readonly start: number; readonly end: number } | undefined
): Headers {
	const headers = new Headers({
		etag: quoteEtag(stat.etag),
		'last-modified': stat.lastModified.toUTCString(),
		'content-type': stat.contentType ?? 'application/octet-stream',
		'accept-ranges': 'bytes',
		'x-amz-request-id': requestId
	});

	if (range === undefined) {
		headers.set('content-length', String(stat.size));
		return headers;
	}

	headers.set(
		'content-range',
		`bytes ${String(range.start)}-${String(range.end)}/${String(stat.size)}`
	);
	headers.set('content-length', String(range.end - range.start + 1));
	return headers;
}

function conditionalResponse(
	outcome: 'not-modified' | 'precondition-failed',
	stat: ObjectStat,
	requestId: string
): Response {
	if (outcome === 'precondition-failed') {
		throw new PreconditionFailedError();
	}

	return new Response(undefined, {
		status: StatusCodes.NOT_MODIFIED,
		headers: {
			etag: quoteEtag(stat.etag),
			'last-modified': stat.lastModified.toUTCString(),
			'x-amz-request-id': requestId
		}
	});
}

function xmlResponse(body: string, requestId: string): Response {
	return new Response(body, {
		status: StatusCodes.OK,
		headers: {
			'content-type': 'application/xml',
			'x-amz-request-id': requestId
		}
	});
}

function noContent(requestId: string): Response {
	return new Response(undefined, {
		status: StatusCodes.NO_CONTENT,
		headers: { 'x-amz-request-id': requestId }
	});
}

function emptyStream(): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.close();
		}
	});
}

const maxControlBodyBytes = 1024 * 1024;
const maxDeleteKeys = 1000;

// `DeleteObjects` and `CompleteMultipartUpload` carry small XML control bodies.
// A body past this cap is refused before it is buffered into a string, so a
// client cannot exhaust the isolate by sending an arbitrarily large one.
async function readControlBody(request: Request): Promise<string> {
	const declared = request.headers.get('content-length');
	if (declared !== null && Number(declared) > maxControlBodyBytes) {
		throw new ControlBodyTooLargeError();
	}

	const text = await request.text();
	if (text.length > maxControlBodyBytes) {
		throw new ControlBodyTooLargeError();
	}

	return text;
}

// The XML parsers throw when a body is not well-formed or fails schema
// validation; that surfaces as the S3 `MalformedXML` response. An `S3Error`
// raised inside the parse (its own protocol error) is preserved.
function parseXml<T>(parse: () => T): T {
	try {
		return parse();
	} catch (error) {
		if (error instanceof S3Error) {
			throw error;
		}
		throw new MalformedXmlBodyError();
	}
}

// An offset at or past the object size, or a zero-length suffix, names no bytes.
function isRangeUnsatisfiable(range: ByteRange, size: number): boolean {
	if ('suffix' in range) {
		return range.suffix === 0;
	}

	return range.offset >= size;
}

function defaultRequestId(): string {
	return crypto.randomUUID().replaceAll('-', '');
}
