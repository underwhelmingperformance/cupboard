/**
 * AWS "chunked" transfer support. The AWS CLI, the SDKs and rclone default to
 * `Content-Encoding: aws-chunked` with a streaming `x-amz-content-sha256`, where
 * the wire body is framed as `<hex-size>[;chunk-signature=...]\r\n<data>\r\n`
 * chunks terminated by a zero-length chunk and optional trailers. The framing is
 * an envelope: the object's real bytes are the concatenated chunk data, and its
 * real length is `x-amz-decoded-content-length`. We strip the envelope before
 * the bytes reach the object store, so a stored NAR or narinfo is the content,
 * not the framing.
 */

import {
	MalformedChunkedEncodingError,
	TruncatedChunkedBodyError
} from './errors.ts';

const CR = 0x0d;
const LF = 0x0a;

/** Whether a write request carries an AWS chunked-encoding envelope. */
export function isAwsChunked(request: Request): boolean {
	const encoding = request.headers.get('content-encoding') ?? '';
	if (encoding.toLowerCase().split(',').includes('aws-chunked')) {
		return true;
	}

	const contentSha = request.headers.get('x-amz-content-sha256') ?? '';
	return contentSha.startsWith('STREAMING-');
}

/** The decoded object length advertised by a chunked request, if present. */
export function decodedContentLength(request: Request): number | undefined {
	const value = request.headers.get('x-amz-decoded-content-length');
	if (value === null) {
		return undefined;
	}

	const length = Number(value);
	return Number.isSafeInteger(length) && length >= 0 ? length : undefined;
}

// A chunk header is `<hex-size>[;chunk-signature=...]`; even a signed header is
// well under a kilobyte. Bounding the scan stops a client streaming an endless
// header line with no CRLF from forcing unbounded buffering.
const maxChunkHeaderLength = 8 * 1024;

/**
 * Strips the AWS chunked envelope from a body, emitting only the chunk data.
 * Chunk signatures and trailers are ignored: the signature is verified by
 * re-signing the request, not by re-hashing the body, and trailing checksums are
 * not part of the stored object.
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

	async function pullMore(): Promise<boolean> {
		const { value, done: isDone } = await reader.read();
		if (isDone) {
			isUpstreamDone = true;
			return false;
		}

		buffer = concat(buffer, value);
		return true;
	}

	async function fill(min: number): Promise<boolean> {
		while (buffer.length < min && !isUpstreamDone) {
			await pullMore();
		}
		return buffer.length >= min;
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

		if (crlf === -1) {
			return undefined;
		}

		const line = new TextDecoder().decode(buffer.subarray(0, crlf));
		buffer = buffer.subarray(crlf + 2);
		return line;
	}

	async function consumeTrailingCrlf(): Promise<void> {
		if (!(await fill(2))) {
			throw new TruncatedChunkedBodyError();
		}

		if (buffer[0] !== CR || buffer[1] !== LF) {
			throw new MalformedChunkedEncodingError();
		}

		buffer = buffer.subarray(2);
	}

	async function beginChunk(
		controller: ReadableStreamDefaultController
	): Promise<boolean> {
		const header = await readHeaderLine();
		if (header === undefined) {
			controller.close();
			return false;
		}

		const size = Number.parseInt(header.split(';', 1)[0] ?? '', 16);
		if (!Number.isSafeInteger(size) || size < 0) {
			controller.error(new MalformedChunkedEncodingError());
			return false;
		}

		if (size === 0) {
			controller.close();
			return false;
		}

		remaining = size;
		return true;
	}

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				if (remaining === 0 && !(await beginChunk(controller))) {
					return;
				}

				if (buffer.length === 0 && !(await fill(1))) {
					controller.error(new TruncatedChunkedBodyError());
					return;
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
