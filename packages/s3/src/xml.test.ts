import { describe, expect, it } from 'vitest';

import {
	buildErrorXml,
	parseCompletedEtag,
	parseCompleteMultipartUpload,
	parseDeleteObjects,
	parseListResult,
	parseUploadId,
	renderBucketLocation,
	renderCompleteMultipartUpload,
	renderInitiateMultipartUpload,
	renderListObjectsV1,
	renderListObjectsV2
} from './xml.ts';

describe('renderListObjectsV2', () => {
	it('round-trips contents and common prefixes through the parser', () => {
		const xml = renderListObjectsV2({
			bucket: 'acme',
			prefix: 'nar/',
			delimiter: '/',
			maxKeys: 1000,
			keyCount: 1,
			isTruncated: false,
			continuationToken: undefined,
			nextContinuationToken: undefined,
			contents: [
				{
					key: 'nar/abc.nar.zst',
					lastModified: new Date('2026-01-02T03:04:05.000Z'),
					etag: 'd41d8cd98f00b204e9800998ecf8427e',
					size: 42
				}
			],
			commonPrefixes: ['nar/sub/']
		});

		expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
		expect(xml).toContain('http://s3.amazonaws.com/doc/2006-03-01/');

		expect(parseListResult(xml)).toStrictEqual({
			objects: [
				{
					key: 'nar/abc.nar.zst',
					size: 42,
					etag: 'd41d8cd98f00b204e9800998ecf8427e',
					lastModified: new Date('2026-01-02T03:04:05.000Z')
				}
			],
			commonPrefixes: ['nar/sub/'],
			isTruncated: false,
			nextContinuationToken: undefined
		});
	});
});

describe('renderListObjectsV1', () => {
	it('renders marker-based pagination and contents', () => {
		const xml = renderListObjectsV1({
			bucket: 'acme',
			prefix: '',
			delimiter: undefined,
			maxKeys: 1,
			keyCount: 1,
			isTruncated: true,
			continuationToken: undefined,
			nextContinuationToken: 'abc.narinfo',
			contents: [
				{
					key: 'abc.narinfo',
					lastModified: new Date('2026-01-02T03:04:05.000Z'),
					etag: 'deadbeef',
					size: 7
				}
			],
			commonPrefixes: []
		});

		expect(xml).toContain('<Name>acme</Name>');
		expect(xml).toContain('<Key>abc.narinfo</Key>');
		expect(xml).toContain('<IsTruncated>true</IsTruncated>');
		expect(xml).toContain('<NextMarker>abc.narinfo</NextMarker>');
		expect(xml).not.toContain('NextContinuationToken');
	});
});

describe('buildErrorXml', () => {
	it('escapes the message and includes the request id', () => {
		const xml = buildErrorXml(
			'NoSuchKey',
			'missing <a> & <b>',
			'req-1',
			undefined
		);
		expect(xml).toContain('<Code>NoSuchKey</Code>');
		expect(xml).toContain(
			'<Message>missing &lt;a&gt; &amp; &lt;b&gt;</Message>'
		);
		expect(xml).toContain('<RequestId>req-1</RequestId>');
	});
});

describe('renderBucketLocation', () => {
	it('renders the region as the constraint text', () => {
		expect(renderBucketLocation('auto')).toContain(
			'>auto</LocationConstraint>'
		);
	});
});

describe('multipart and delete parsing', () => {
	it('parses multipart response values and a completion part list', () => {
		const initiate = renderInitiateMultipartUpload(
			'acme',
			'nar/x.nar.zst',
			'up-1'
		);
		expect(parseUploadId(initiate)).toBe('up-1');

		const complete = renderCompleteMultipartUpload(
			'https://s3/acme/x',
			'acme',
			'nar/x.nar.zst',
			'deadbeef'
		);
		expect(parseCompletedEtag(complete)).toBe('deadbeef');

		// A client echoes the quoted ETags it received from UploadPart; the parser
		// unquotes them so the object store sees the raw ETag values it issued.
		const parts = parseCompleteMultipartUpload(
			'<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>"a"</ETag></Part><Part><PartNumber>2</PartNumber><ETag>"b"</ETag></Part></CompleteMultipartUpload>'
		);
		expect(parts).toStrictEqual([
			{ partNumber: 1, etag: 'a' },
			{ partNumber: 2, etag: 'b' }
		]);
	});

	it('parses a single-part body into a one-element list', () => {
		const parts = parseCompleteMultipartUpload(
			'<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>"a"</ETag></Part></CompleteMultipartUpload>'
		);
		expect(parts).toStrictEqual([{ partNumber: 1, etag: 'a' }]);
	});

	it('parses delete object keys', () => {
		const result = parseDeleteObjects(
			'<Delete><Object><Key>a.narinfo</Key></Object><Object><Key>nar/b.nar.zst</Key></Object></Delete>'
		);
		expect(result).toStrictEqual({
			keys: ['a.narinfo', 'nar/b.nar.zst'],
			quiet: false
		});
	});

	it('parses the delete quiet flag', () => {
		const result = parseDeleteObjects(
			'<Delete><Quiet>true</Quiet><Object><Key>a.narinfo</Key></Object></Delete>'
		);
		expect(result).toStrictEqual({ keys: ['a.narinfo'], quiet: true });
	});
});
