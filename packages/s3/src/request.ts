import {
	InvalidMaxKeysError,
	InvalidPartNumberError,
	InvalidRangeHeaderError,
	MalformedPathEncodingError
} from './errors.ts';
import type { ByteRange } from './ports.ts';

/**
 * The S3 operation a request resolves to, after method and sub-resource query
 * parameters are taken into account.
 */
export type S3Operation =
	| { readonly kind: 'GetBucketLocation' }
	| { readonly kind: 'HeadBucket' }
	| { readonly kind: 'ListObjects'; readonly isV2: boolean }
	| { readonly kind: 'GetObject'; readonly key: string }
	| { readonly kind: 'HeadObject'; readonly key: string }
	| { readonly kind: 'PutObject'; readonly key: string }
	| { readonly kind: 'DeleteObject'; readonly key: string }
	| { readonly kind: 'DeleteObjects' }
	| { readonly kind: 'CreateMultipartUpload'; readonly key: string }
	| {
			readonly kind: 'UploadPart';
			readonly key: string;
			readonly uploadId: string;
			readonly partNumber: number;
	  }
	| {
			readonly kind: 'CompleteMultipartUpload';
			readonly key: string;
			readonly uploadId: string;
	  }
	| {
			readonly kind: 'AbortMultipartUpload';
			readonly key: string;
			readonly uploadId: string;
	  }
	| {
			readonly kind: 'ListParts';
			readonly key: string;
			readonly uploadId: string;
	  }
	| { readonly kind: 'Unsupported' };

export interface ParsedRequest {
	readonly bucket: string;
	readonly key: string;
	readonly operation: S3Operation;
}

/**
 * Classifies a request into a bucket, key and {@link S3Operation} using
 * path-style addressing (`/<bucket>/<key...>`) and the S3 sub-resource query
 * parameters (`?uploads`, `?uploadId`, `?delete`, `?location`, `?list-type`).
 */
export function parseRequest(request: Request, url: URL): ParsedRequest {
	const { bucket, key } = splitPath(url.pathname);
	const query = url.searchParams;
	const method = request.method.toUpperCase();
	const isCopy = request.headers.has('x-amz-copy-source');

	const operation = classify(method, bucket, key, query, isCopy);
	return { bucket, key, operation };
}

function classify(
	method: string,
	bucket: string,
	key: string,
	query: URLSearchParams,
	isCopy: boolean
): S3Operation {
	if (bucket === '') {
		return { kind: 'Unsupported' };
	}

	const uploadId = query.get('uploadId');

	if (key === '') {
		if (method === 'GET' || method === 'HEAD') {
			if (query.has('location')) {
				return { kind: 'GetBucketLocation' };
			}
			if (method === 'HEAD') {
				return { kind: 'HeadBucket' };
			}
			return { kind: 'ListObjects', isV2: query.get('list-type') === '2' };
		}
		if (method === 'POST' && query.has('delete')) {
			return { kind: 'DeleteObjects' };
		}
		return { kind: 'Unsupported' };
	}

	switch (method) {
		case 'GET': {
			if (uploadId !== null) {
				return { kind: 'ListParts', key, uploadId };
			}
			return { kind: 'GetObject', key };
		}
		case 'HEAD': {
			return { kind: 'HeadObject', key };
		}
		case 'PUT': {
			// CopyObject and UploadPartCopy both carry an `x-amz-copy-source`; the
			// cache is not a general object store and does not support server-side
			// copies, so an `x-amz-copy-source` PUT is rejected as unsupported.
			if (isCopy) {
				return { kind: 'Unsupported' };
			}

			const partNumber = query.get('partNumber');
			if (uploadId !== null && partNumber !== null) {
				return {
					kind: 'UploadPart',
					key,
					uploadId,
					partNumber: parsePartNumber(partNumber)
				};
			}
			return { kind: 'PutObject', key };
		}
		case 'POST': {
			if (query.has('uploads')) {
				return { kind: 'CreateMultipartUpload', key };
			}
			if (uploadId !== null) {
				return { kind: 'CompleteMultipartUpload', key, uploadId };
			}
			return { kind: 'Unsupported' };
		}
		case 'DELETE': {
			if (uploadId !== null) {
				return { kind: 'AbortMultipartUpload', key, uploadId };
			}
			return { kind: 'DeleteObject', key };
		}
		default: {
			return { kind: 'Unsupported' };
		}
	}
}

function splitPath(pathname: string): { bucket: string; key: string } {
	const trimmed = pathname.replace(/^\/+/, '');
	const slash = trimmed.indexOf('/');

	if (slash === -1) {
		return { bucket: decodeSegment(trimmed), key: '' };
	}

	return {
		bucket: decodeSegment(trimmed.slice(0, slash)),
		key: decodeSegment(trimmed.slice(slash + 1))
	};
}

// `decodeURIComponent` throws on malformed percent-encoding; that surfaces as a
// 400 client error.
function decodeSegment(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		throw new MalformedPathEncodingError();
	}
}

function parsePartNumber(value: string): number {
	const partNumber = Number(value);
	if (
		!Number.isSafeInteger(partNumber) ||
		partNumber < 1 ||
		partNumber > 10_000
	) {
		throw new InvalidPartNumberError();
	}

	return partNumber;
}

/**
 * Parses an HTTP `Range` header limited to a single `bytes=` range, the only
 * form S3 object reads use. Returns `undefined` when absent or not a single
 * byte range; throws on a malformed `bytes=` value.
 */
export function parseRange(header: string | null): ByteRange | undefined {
	if (header === null) {
		return undefined;
	}

	const match = /^bytes=(\d*)-(\d*)$/.exec(header);
	if (match === null) {
		return undefined;
	}

	const [, startText, endText] = match;

	if (startText === '' && endText === '') {
		throw new InvalidRangeHeaderError();
	}

	if (startText === '') {
		return { suffix: Number(endText) };
	}

	const offset = Number(startText);
	if (endText === '') {
		return { offset };
	}

	const end = Number(endText);
	if (end < offset) {
		throw new InvalidRangeHeaderError();
	}

	return { offset, length: end - offset + 1 };
}

const defaultMaxKeys = 1000;
const maxMaxKeys = 1000;

/**
 * Parses and clamps the `max-keys` listing parameter to the S3 default and cap.
 */
export function parseMaxKeys(value: string | null): number {
	if (value === null) {
		return defaultMaxKeys;
	}

	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw new InvalidMaxKeysError();
	}

	return Math.min(parsed, maxMaxKeys);
}
