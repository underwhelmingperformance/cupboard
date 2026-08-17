import { describe, expect, it } from 'vitest';

import {
	dechunkStream,
	decodedContentLength,
	isAwsChunked
} from './chunked.ts';

function requestWith(headers: Record<string, string>): Request {
	return new Request('https://s3.example.com/bucket/key', {
		method: 'PUT',
		headers
	});
}

function streamOf(...parts: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const chunks = parts.map((part) => encoder.encode(part));
	let index = 0;

	return new ReadableStream<Uint8Array>({
		pull(controller) {
			const chunk = chunks[index];
			if (chunk === undefined) {
				controller.close();
				return;
			}
			controller.enqueue(chunk);
			index += 1;
		}
	});
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const parts: Uint8Array[] = [];

	for (;;) {
		const { value, done: isDone } = await reader.read();
		if (isDone) {
			break;
		}
		parts.push(value);
	}

	return parts.map((part) => new TextDecoder().decode(part)).join('');
}

describe('isAwsChunked', () => {
	it.each<{ name: string; headers: Record<string, string>; expected: boolean }>(
		[
			{
				name: 'content-encoding aws-chunked',
				headers: { 'content-encoding': 'aws-chunked' },
				expected: true
			},
			{
				name: 'content-encoding list with aws-chunked',
				headers: { 'content-encoding': 'gzip,aws-chunked' },
				expected: true
			},
			{
				name: 'streaming content-sha256',
				headers: {
					'x-amz-content-sha256': 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD'
				},
				expected: true
			},
			{
				name: 'streaming unsigned',
				headers: {
					'x-amz-content-sha256': 'STREAMING-UNSIGNED-PAYLOAD-TRAILER'
				},
				expected: true
			},
			{
				name: 'plain digest',
				headers: {
					'x-amz-content-sha256':
						'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
				},
				expected: false
			},
			{ name: 'no headers', headers: {}, expected: false }
		]
	)('$name returns $expected', ({ headers, expected }) => {
		expect(isAwsChunked(requestWith(headers))).toBe(expected);
	});
});

describe('decodedContentLength', () => {
	it.each<{
		name: string;
		headers: Record<string, string>;
		expected: number | undefined;
	}>([
		{
			name: 'a valid length',
			headers: { 'x-amz-decoded-content-length': '42' },
			expected: 42
		},
		{ name: 'absent', headers: {}, expected: undefined },
		{
			name: 'non-numeric',
			headers: { 'x-amz-decoded-content-length': 'abc' },
			expected: undefined
		}
	])('$name', ({ headers, expected }) => {
		expect(decodedContentLength(requestWith(headers))).toBe(expected);
	});
});

describe('dechunkStream', () => {
	it.each([
		{
			name: 'a signed single chunk',
			body: '5;chunk-signature=abc\r\nhello\r\n0;chunk-signature=def\r\n\r\n',
			expected: 'hello'
		},
		{
			name: 'an unsigned single chunk',
			body: '5\r\nhello\r\n0\r\n\r\n',
			expected: 'hello'
		},
		{
			name: 'multiple chunks',
			body: '5\r\nhello\r\n5\r\nworld\r\n0\r\n\r\n',
			expected: 'helloworld'
		},
		{
			name: 'a checksum trailer',
			body: '5\r\nhello\r\n0\r\nx-amz-checksum-sha256: aGVsbG8=\r\n\r\n',
			expected: 'hello'
		}
	])('strips the envelope from $name', async ({ body, expected }) => {
		const stream = streamOf(body);
		expect(await collect(dechunkStream(stream))).toBe(expected);
	});

	it('reassembles a chunk split across stream reads', async () => {
		const stream = streamOf('5\r\nhel', 'lo\r\n0', '\r\n\r\n');
		expect(await collect(dechunkStream(stream))).toBe('hello');
	});

	it('reassembles when the chunk data and its CRLF arrive separately', async () => {
		const stream = streamOf('5\r\nhello', '\r\n0\r\n\r\n');
		expect(await collect(dechunkStream(stream))).toBe('hello');
	});

	it('reassembles when the trailing CRLF is split across reads', async () => {
		const stream = streamOf('5\r\nhello\r', '\n0\r\n\r\n');
		expect(await collect(dechunkStream(stream))).toBe('hello');
	});

	it('rejects a chunk not terminated by a CRLF', async () => {
		const stream = streamOf('5\r\nhelloXX0\r\n\r\n');
		await expect(collect(dechunkStream(stream))).rejects.toThrow();
	});

	it('rejects a truncated body', async () => {
		const stream = streamOf('5\r\nhel');
		await expect(collect(dechunkStream(stream))).rejects.toThrow();
	});

	it('rejects an unterminated chunk header', async () => {
		const stream = streamOf(`${'a'.repeat(9000)}\r\n`);
		await expect(collect(dechunkStream(stream))).rejects.toThrow();
	});

	it('rejects trailing characters in a chunk size', async () => {
		const stream = streamOf('5g\r\nhello\r\n0\r\n\r\n');
		await expect(collect(dechunkStream(stream))).rejects.toThrow();
	});

	it('rejects an oversized chunk header received in one read', async () => {
		const stream = streamOf(`${'a'.repeat(8193)}\r\n`);
		await expect(collect(dechunkStream(stream))).rejects.toThrow();
	});

	it.each([
		{
			name: 'no zero-length chunk',
			body: '5\r\nhello\r\n'
		},
		{
			name: 'no final empty trailer line',
			body: '5\r\nhello\r\n0\r\n'
		},
		{
			name: 'a malformed trailer field',
			body: '5\r\nhello\r\n0\r\nnot-a-field\r\n\r\n'
		},
		{
			name: 'bytes after the trailer section',
			body: '5\r\nhello\r\n0\r\n\r\nextra'
		}
	])('rejects terminal framing with $name', async ({ body }) => {
		const decoded = dechunkStream(streamOf(body));
		await expect(collect(decoded)).rejects.toThrow();
	});
});
