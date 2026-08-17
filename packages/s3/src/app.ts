import { Hono } from 'hono';
import { StatusCodes } from 'http-status-codes';

import { dechunkStream, isAwsChunked } from './chunked.ts';
import { evaluatePreconditions } from './conditional.ts';
import {
	ControlBodyTooLargeError,
	DeleteObjectsTooManyKeysError,
	InternalError,
	InvalidContentLengthError,
	InvalidPartOrderError,
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
import {
	type AuthenticatedPayload,
	authenticatePayload,
	completePayloadVerification
} from './payload.ts';
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

export interface S3AppDependencies {
	readonly resolver: CredentialResolver;
	readonly store: ObjectStore;
	/**
	Region reported by `GetBucketLocation`; defaults to `auto`.
	*/
	readonly region?: string;
	/**
	Request-id source, injected for deterministic tests.
	*/
	readonly requestId?: () => string;
}

/**
 * Builds a generic S3-compatible Hono app with the supplied
 * {@link CredentialResolver} and {@link ObjectStore}. The app implements the
 * wire protocol and delegates object behaviour to the store.
 */
export function createS3App(dependencies: S3AppDependencies): Hono {
	const app = new Hono();
	app.all('*', (context) => handle(context.req.raw, dependencies));
	return app;
}

async function handle(
	request: Request,
	dependencies: S3AppDependencies
): Promise<Response> {
	const requestId = (dependencies.requestId ?? defaultRequestId)();

	try {
		const url = new URL(request.url);
		const principal = isSigned(request)
			? await verifySignature(request, dependencies.resolver)
			: undefined;

		const { bucket, operation } = parseRequest(request, url);
		const payload = requestPayload(request, principal !== undefined);
		return await dispatch({
			request,
			url,
			bucket,
			operation,
			principal,
			payload,
			dependencies,
			requestId
		});
	} catch (error) {
		if (error instanceof S3Error) {
			return error.toResponse(requestId);
		}

		// Log internal failures on the server, but return a fixed error to the
		// client. The original error can contain details about credential
		// decryption, database access or validation.
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
	readonly payload: AuthenticatedPayload;
	readonly dependencies: S3AppDependencies;
	readonly requestId: string;
}

async function dispatch(input: Dispatch): Promise<Response> {
	const { operation } = input;
	if (requiresPreDispatchPayloadVerification(operation)) {
		await completePayloadVerification(input.payload);
	}

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

function requiresPreDispatchPayloadVerification(
	operation: S3Operation
): boolean {
	switch (operation.kind) {
		case 'GetBucketLocation':
		case 'HeadBucket':
		case 'ListObjects':
		case 'GetObject':
		case 'HeadObject':
		case 'DeleteObject':
		case 'CreateMultipartUpload':
		case 'AbortMultipartUpload': {
			return true;
		}
		case 'PutObject':
		case 'DeleteObjects':
		case 'UploadPart':
		case 'CompleteMultipartUpload':
		case 'ListParts':
		case 'Unsupported': {
			return false;
		}
	}
}

function contextFor(input: Dispatch, key: string): ObjectContext {
	return { bucket: input.bucket, key, principal: input.principal };
}

async function getObject(input: Dispatch, key: string): Promise<Response> {
	const range = parseRange(input.request.headers.get('range'));
	const result = await input.dependencies.store.get(
		contextFor(input, key),
		range
	);

	if (result === undefined) {
		// A store can return `undefined` for an unsatisfiable range. Calling `stat`
		// distinguishes that case from a missing object: return 416 for an existing
		// object and 404 when the object does not exist.
		if (range !== undefined) {
			const stat = await input.dependencies.store.stat(contextFor(input, key));
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
	const stat = await input.dependencies.store.stat(contextFor(input, key));
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
	const [result] = await Promise.all([
		input.dependencies.store.put(
			contextFor(input, key),
			input.payload.body,
			putMeta(input.request)
		),
		input.payload.verified
	]);

	return new Response(undefined, {
		status: StatusCodes.OK,
		headers: {
			etag: quoteEtag(result.etag),
			'x-amz-request-id': input.requestId
		}
	});
}

async function deleteObject(input: Dispatch, key: string): Promise<Response> {
	await input.dependencies.store.delete(contextFor(input, key));
	return noContent(input.requestId);
}

async function deleteObjects(input: Dispatch): Promise<Response> {
	const body = await readControlBody(input.request, input.payload.body);
	await input.payload.verified;
	const { keys, quiet: isQuiet } = parseXml(() => parseDeleteObjects(body));

	if (keys.length > maxDeleteKeys) {
		throw new DeleteObjectsTooManyKeysError();
	}

	const deleted: string[] = [];
	const errors: DeleteObjectsError[] = [];

	for (const key of keys) {
		try {
			await input.dependencies.store.delete(contextFor(input, key));
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

// A batch delete reports object-specific failures in its response body.
// Authorisation and unsupported-operation failures apply to the whole request,
// so return 403 or 501 instead of a 200 response that reports the same failure
// for every key.
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
	const upload = await input.dependencies.store.createMultipartUpload(
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
	const [part] = await Promise.all([
		input.dependencies.store.uploadPart(
			contextFor(input, key),
			uploadId,
			partNumber,
			payloadContentLength(input.request),
			input.payload.body
		),
		input.payload.verified
	]);

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
	const body = await readControlBody(input.request, input.payload.body);
	await input.payload.verified;
	const parts = parseXml(() => parseCompleteMultipartUpload(body));
	assertPartOrder(parts);
	const result = await input.dependencies.store.completeMultipartUpload(
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

function assertPartOrder(
	parts: readonly { readonly partNumber: number }[]
): void {
	let previousPartNumber: number | undefined;

	for (const { partNumber } of parts) {
		if (previousPartNumber !== undefined && partNumber <= previousPartNumber) {
			throw new InvalidPartOrderError();
		}

		previousPartNumber = partNumber;
	}
}

async function abortMultipartUpload(
	input: Dispatch,
	key: string,
	uploadId: string
): Promise<Response> {
	await input.dependencies.store.abortMultipartUpload(
		contextFor(input, key),
		uploadId
	);
	return noContent(input.requestId);
}

async function getBucketLocation(input: Dispatch): Promise<Response> {
	const isExists = await input.dependencies.store.bucketExists(
		input.bucket,
		input.principal
	);
	if (!isExists) {
		throw new NoSuchBucketError();
	}

	return xmlResponse(
		renderBucketLocation(input.dependencies.region ?? 'auto'),
		input.requestId
	);
}

async function headBucket(input: Dispatch): Promise<Response> {
	const isExists = await input.dependencies.store.bucketExists(
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

	const result = await input.dependencies.store.list(
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
function requestPayload(
	request: Request,
	isAuthenticated: boolean
): AuthenticatedPayload {
	const rawBody = request.body ?? emptyStream();
	const authenticated = authenticatePayload(
		rawBody,
		isAuthenticated
			? (request.headers.get('x-amz-content-sha256') ?? undefined)
			: undefined
	);

	const isChunked = isAwsChunked(request);
	const body = isChunked
		? validatePayloadLength(
				dechunkStream(authenticated.body),
				payloadContentLength(request)
			)
		: authenticated.body;

	return {
		body,
		verified: authenticated.verified,
		isVerificationRequired: authenticated.isVerificationRequired
	};
}

function validatePayloadLength(
	body: ReadableStream<Uint8Array>,
	expected: number | undefined
): ReadableStream<Uint8Array> {
	if (expected === undefined) {
		return body;
	}

	const reader = body.getReader();
	let received = 0;

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const { value, done: isDone } = await reader.read();
			if (isDone) {
				if (received !== expected) {
					controller.error(new InvalidContentLengthError());
					return;
				}

				controller.close();
				return;
			}

			received += value.length;
			if (received > expected) {
				await reader.cancel();
				controller.error(new InvalidContentLengthError());
				return;
			}

			controller.enqueue(value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		}
	});
}

function putMeta(request: Request): PutObjectMeta {
	return {
		contentType: request.headers.get('content-type') ?? undefined,
		contentLength: payloadContentLength(request),
		checksumSha256: request.headers.get('x-amz-checksum-sha256') ?? undefined
	};
}

function payloadContentLength(request: Request): number | undefined {
	const header = isAwsChunked(request)
		? 'x-amz-decoded-content-length'
		: 'content-length';

	return parseContentLength(request.headers.get(header));
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

async function readControlBody(
	request: Request,
	body: ReadableStream<Uint8Array>
): Promise<string> {
	parseContentLength(request.headers.get('content-length'));
	const declaredLength = payloadContentLength(request);
	if (declaredLength !== undefined && declaredLength > maxControlBodyBytes) {
		await body.cancel();
		throw new ControlBodyTooLargeError();
	}

	const reader = body.getReader();
	const decoder = new TextDecoder();
	let length = 0;
	let text = '';

	for (;;) {
		const { value, done: isDone } = await reader.read();
		if (isDone) {
			break;
		}

		length += value.length;
		if (length > maxControlBodyBytes) {
			await reader.cancel();
			throw new ControlBodyTooLargeError();
		}
		text += decoder.decode(value, { stream: true });
	}
	text += decoder.decode();

	if (declaredLength !== undefined && length !== declaredLength) {
		throw new InvalidContentLengthError();
	}

	return text;
}

function parseContentLength(value: string | null): number | undefined {
	if (value === null) {
		return undefined;
	}
	if (!/^[0-9]+$/.test(value)) {
		throw new InvalidContentLengthError();
	}

	const length = Number(value);
	if (!Number.isSafeInteger(length)) {
		throw new InvalidContentLengthError();
	}

	return length;
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

// A range that starts at or beyond the end of the object, or a suffix range of
// zero bytes, cannot be satisfied.
function isRangeUnsatisfiable(range: ByteRange, size: number): boolean {
	if ('suffix' in range) {
		return range.suffix === 0;
	}

	return range.offset >= size;
}

function defaultRequestId(): string {
	return crypto.randomUUID().replaceAll('-', '');
}
