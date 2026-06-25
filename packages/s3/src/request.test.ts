import { describe, expect, it } from 'vitest';

import {
	InvalidMaxKeysError,
	InvalidPartNumberError,
	InvalidRangeHeaderError,
	MalformedPathEncodingError
} from './errors.ts';
import type { ByteRange } from './ports.ts';
import {
	parseMaxKeys,
	parseRange,
	parseRequest,
	type S3Operation
} from './request.ts';

function operationFor(method: string, path: string): S3Operation {
	const url = new URL(`https://s3.example.com${path}`);
	const request = new Request(url, { method });
	return parseRequest(request, url).operation;
}

describe('parseRequest classify', () => {
	it.each<{
		name: string;
		method: string;
		path: string;
		expected: S3Operation;
	}>([
		{
			name: 'list (v1)',
			method: 'GET',
			path: '/acme',
			expected: { kind: 'ListObjects', isV2: false }
		},
		{
			name: 'list (v2)',
			method: 'GET',
			path: '/acme?list-type=2',
			expected: { kind: 'ListObjects', isV2: true }
		},
		{
			name: 'bucket location',
			method: 'GET',
			path: '/acme?location',
			expected: { kind: 'GetBucketLocation' }
		},
		{
			name: 'head bucket',
			method: 'HEAD',
			path: '/acme',
			expected: { kind: 'HeadBucket' }
		},
		{
			name: 'delete objects',
			method: 'POST',
			path: '/acme?delete',
			expected: { kind: 'DeleteObjects' }
		},
		{
			name: 'get object',
			method: 'GET',
			path: '/acme/a.narinfo',
			expected: { kind: 'GetObject', key: 'a.narinfo' }
		},
		{
			name: 'list parts',
			method: 'GET',
			path: '/acme/a.narinfo?uploadId=u',
			expected: { kind: 'ListParts', key: 'a.narinfo', uploadId: 'u' }
		},
		{
			name: 'head object',
			method: 'HEAD',
			path: '/acme/a.narinfo',
			expected: { kind: 'HeadObject', key: 'a.narinfo' }
		},
		{
			name: 'put object',
			method: 'PUT',
			path: '/acme/a.narinfo',
			expected: { kind: 'PutObject', key: 'a.narinfo' }
		},
		{
			name: 'upload part',
			method: 'PUT',
			path: '/acme/nar/b.nar.zst?uploadId=u&partNumber=2',
			expected: {
				kind: 'UploadPart',
				key: 'nar/b.nar.zst',
				uploadId: 'u',
				partNumber: 2
			}
		},
		{
			name: 'create multipart',
			method: 'POST',
			path: '/acme/nar/b.nar.zst?uploads',
			expected: { kind: 'CreateMultipartUpload', key: 'nar/b.nar.zst' }
		},
		{
			name: 'complete multipart',
			method: 'POST',
			path: '/acme/nar/b.nar.zst?uploadId=u',
			expected: {
				kind: 'CompleteMultipartUpload',
				key: 'nar/b.nar.zst',
				uploadId: 'u'
			}
		},
		{
			name: 'abort multipart',
			method: 'DELETE',
			path: '/acme/nar/b.nar.zst?uploadId=u',
			expected: {
				kind: 'AbortMultipartUpload',
				key: 'nar/b.nar.zst',
				uploadId: 'u'
			}
		},
		{
			name: 'delete object',
			method: 'DELETE',
			path: '/acme/a.narinfo',
			expected: { kind: 'DeleteObject', key: 'a.narinfo' }
		},
		{
			name: 'no bucket',
			method: 'GET',
			path: '/',
			expected: { kind: 'Unsupported' }
		},
		{
			name: 'unsupported method',
			method: 'PATCH',
			path: '/acme/a.narinfo',
			expected: { kind: 'Unsupported' }
		}
	])('$name', ({ method, path, expected }) => {
		expect(operationFor(method, path)).toStrictEqual(expected);
	});

	it.each(['0', '10001'])('rejects part number %s', (partNumber) => {
		expect(() =>
			operationFor(
				'PUT',
				`/acme/nar/b.nar.zst?uploadId=u&partNumber=${partNumber}`
			)
		).toThrow(InvalidPartNumberError);
	});

	it('classifies a copy PUT as unsupported', () => {
		const url = new URL('https://s3.example.com/acme/a.narinfo');
		const request = new Request(url, {
			method: 'PUT',
			headers: { 'x-amz-copy-source': '/acme/b.narinfo' }
		});
		expect(parseRequest(request, url).operation).toStrictEqual({
			kind: 'Unsupported'
		});
	});

	it('rejects malformed percent-encoding in the path', () => {
		const url = new URL('https://s3.example.com/acme/a%ZZ.narinfo');
		const request = new Request(url, { method: 'GET' });
		expect(() => parseRequest(request, url)).toThrow(
			MalformedPathEncodingError
		);
	});
});

describe('parseRange', () => {
	it('returns undefined for an absent header', () => {
		expect(parseRange(new Headers().get('range'))).toBeUndefined();
	});

	it.each<{
		name: string;
		header: string;
		expected: ByteRange | undefined;
	}>([
		{
			name: 'closed range',
			header: 'bytes=0-99',
			expected: { offset: 0, length: 100 }
		},
		{ name: 'open-ended', header: 'bytes=100-', expected: { offset: 100 } },
		{ name: 'suffix', header: 'bytes=-50', expected: { suffix: 50 } },
		{ name: 'non-bytes unit', header: 'items=0-9', expected: undefined }
	])('$name', ({ header, expected }) => {
		expect(parseRange(header)).toStrictEqual(expected);
	});

	it.each(['bytes=-', 'bytes=50-10'])('rejects %s', (header) => {
		expect(() => parseRange(header)).toThrow(InvalidRangeHeaderError);
	});
});

describe('parseMaxKeys', () => {
	it('defaults when absent', () => {
		expect(parseMaxKeys(new URLSearchParams().get('max-keys'))).toBe(1000);
	});

	it.each<{ name: string; value: string; expected: number }>([
		{ name: 'within range', value: '10', expected: 10 },
		{ name: 'clamped to the cap', value: '5000', expected: 1000 }
	])('$name', ({ value, expected }) => {
		expect(parseMaxKeys(value)).toBe(expected);
	});

	it.each(['-1', 'abc'])('rejects %s', (value) => {
		expect(() => parseMaxKeys(value)).toThrow(InvalidMaxKeysError);
	});
});
