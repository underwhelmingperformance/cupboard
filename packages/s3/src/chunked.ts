/**
 * Support for AWS chunked transfer encoding. Some S3 clients send
 * `Content-Encoding: aws-chunked` with streaming `x-amz-content-sha256`
 * values. The wire body contains
 * `<hex-size>[;chunk-signature=...]\r\n<data>\r\n` chunks, followed by a
 * zero-length chunk and optional trailers. The object consists of the
 * concatenated chunk data, and `x-amz-decoded-content-length` specifies its
 * length. Remove the framing before storing the object so stored NAR and
 * narinfo bytes do not include it.
 */

import {
	MalformedChunkedEncodingError,
	TruncatedChunkedBodyError
} from './errors.ts';

const CR = 0x0d;
const LF = 0x0a;

/**
Whether a write request carries an AWS chunked-encoding envelope.
*/
export function isAwsChunked(request: Request): boolean {
	const encoding = request.headers.get('content-encoding') ?? '';
	if (encoding.toLowerCase().split(',').includes('aws-chunked')) {
		return true;
	}

	const contentSha = request.headers.get('x-amz-content-sha256') ?? '';
	return contentSha.startsWith('STREAMING-');
}

/**
The decoded object length advertised by a chunked request, if present.
*/
export function decodedContentLength(request: Request): number | undefined {
	const value = request.headers.get('x-amz-decoded-content-length');
	if (value === null) {
		return undefined;
	}

	const length = Number(value);
	return Number.isSafeInteger(length) && length >= 0 ? length : undefined;
}

// A chunk header is `<hex-size>[;chunk-signature=...]`, and checksum trailer
// fields are similarly small. Bounding each framing line stops a client from
// streaming an endless line with no CRLF and forcing unbounded buffering.
const maxChunkHeaderLength = 8 * 1024;
const trailerFieldNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Removes the AWS chunk framing and emits only the chunk data. The SigV4
 * verifier permits only explicitly unsigned streaming modes to reach this
 * function. It also discards trailing checksums because they are not part of
 * the stored object.
 *
 * Chunk data is emitted as it arrives, so a large declared chunk size never
 * buffers the whole chunk in memory, and a chunk boundary that lands between the
 * data and its trailing CRLF on a stream-read boundary is handled correctly.
 */
export function dechunkStream(
	body: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
	const reader = body.getReader();
	let buffer: Uint8Array = new Uint8Array(0);
	let isUpstreamDone = false;
	let remaining = 0;

	async function pullMore(): Promise<void> {
		const { value, done: isDone } = await reader.read();
		if (isDone) {
			isUpstreamDone = true;
			return;
		}

		buffer = concat(buffer, value);
	}

	async function fill(min: number): Promise<void> {
		while (!isUpstreamDone && buffer.length < min) {
			await pullMore();
		}
	}

	async function readHeaderLine(): Promise<string | undefined> {
		let crlf = indexOfCrlf(buffer);
		while (crlf === -1 && !isUpstreamDone) {
			if (buffer.length > maxChunkHeaderLength) {
				throw new MalformedChunkedEncodingError();
			}
			await pullMore();
			crlf = indexOfCrlf(buffer);
		}
		if (crlf > maxChunkHeaderLength) {
			throw new MalformedChunkedEncodingError();
		}

		if (crlf === -1) {
			return undefined;
		}

		let line: string;
		try {
			line = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
				buffer.subarray(0, crlf)
			);
		} catch {
			throw new MalformedChunkedEncodingError();
		}
		buffer = buffer.subarray(crlf + 2);
		return line;
	}

	async function consumeTrailingCrlf(): Promise<void> {
		await fill(2);
		if (buffer.length < 2) {
			throw new TruncatedChunkedBodyError();
		}

		if (buffer[0] !== CR || buffer[1] !== LF) {
			throw new MalformedChunkedEncodingError();
		}

		buffer = buffer.subarray(2);
	}

	async function consumeTrailers(): Promise<void> {
		for (;;) {
			const line = await readHeaderLine();
			if (line === undefined) {
				throw new TruncatedChunkedBodyError();
			}
			if (line === '') {
				break;
			}
			if (!isValidTrailerField(line)) {
				throw new MalformedChunkedEncodingError();
			}
		}

		while (!isUpstreamDone) {
			await pullMore();
			if (buffer.length > 0) {
				throw new MalformedChunkedEncodingError();
			}
		}

		if (buffer.length > 0) {
			throw new MalformedChunkedEncodingError();
		}
	}

	async function beginChunk(
		controller: ReadableStreamDefaultController
	): Promise<'data' | 'terminal'> {
		const header = await readHeaderLine();
		if (header === undefined) {
			throw new TruncatedChunkedBodyError();
		}

		const sizeToken = header.split(';', 1)[0] ?? '';
		if (!/^[0-9a-f]+$/i.test(sizeToken)) {
			throw new MalformedChunkedEncodingError();
		}

		const size = Number.parseInt(sizeToken, 16);
		if (!Number.isSafeInteger(size) || size < 0) {
			throw new MalformedChunkedEncodingError();
		}

		if (size === 0) {
			await consumeTrailers();
			controller.close();
			return 'terminal';
		}

		remaining = size;
		return 'data';
	}

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				if (remaining === 0) {
					const nextChunk = await beginChunk(controller);
					if (nextChunk === 'terminal') {
						return;
					}
				}

				if (buffer.length === 0) {
					await fill(1);
				}
				if (buffer.length === 0) {
					throw new TruncatedChunkedBodyError();
				}

				const take = Math.min(remaining, buffer.length);
				const data = buffer.subarray(0, take);
				buffer = buffer.subarray(take);
				remaining -= take;

				if (remaining === 0) {
					await consumeTrailingCrlf();
				}

				controller.enqueue(data);
			} catch (error) {
				controller.error(error);
			}
		},
		cancel: (reason) => reader.cancel(reason)
	});
}

function isValidTrailerField(line: string): boolean {
	const separator = line.indexOf(':');
	if (
		separator < 1 ||
		!trailerFieldNamePattern.test(line.slice(0, separator))
	) {
		return false;
	}

	const fieldValue = line.slice(separator + 1);
	for (const character of fieldValue) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint !== 0x09 && codePoint < 0x20) {
			return false;
		}
		if (codePoint === 0x7f) {
			return false;
		}
	}

	return true;
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
	const out = new Uint8Array(left.length + right.length);
	out.set(left);
	out.set(right, left.length);
	return out;
}

function indexOfCrlf(buffer: Uint8Array): number {
	for (let index = 0; index + 1 < buffer.length; index++) {
		if (buffer[index] === CR && buffer[index + 1] === LF) {
			return index;
		}
	}

	return -1;
}
