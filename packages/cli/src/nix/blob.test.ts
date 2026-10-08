import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';

import { ZstdDecoder } from '@cupboard/nix-store/zstd';
import { describe, expect, it } from 'vitest';

import {
	fingerprint,
	pseudoRandomBytes
} from '../../../../tests/support/bytes.ts';

import {
	compressNarToStream,
	defaultNarCompression,
	type NarCompressionOptions,
	NarSizeChangedError,
	sendCompressedNar
} from './blob.ts';
import { type NarDigest, NixSha256Hash } from './nar.ts';

const mebibyte = 1024 * 1024;

async function drainStream(stream: ReadableStream<Uint8Array>): Promise<void> {
	const reader = stream.getReader();

	for (
		let result = await reader.read();
		!result.done;
		result = await reader.read()
	) {
		// Pull the compressed frame through so the hash sees every NAR byte.
	}
}

function expectedDigest(input: Uint8Array): NarDigest {
	return {
		narHash: NixSha256Hash.fromDigest(
			createHash('sha256').update(input).digest()
		),
		narSize: input.byteLength
	};
}

describe('compressNarToStream', () => {
	const cases: readonly {
		readonly name: string;
		readonly input: Uint8Array;
	}[] = [
		{ name: 'empty input', input: new Uint8Array() },
		{
			name: 'a short NAR fragment',
			input: new TextEncoder().encode('nix-archive-1 contents')
		},
		{
			name: 'a multi-kilobyte body',
			input: new Uint8Array(8192).fill(0x61)
		}
	];

	it.each(cases)(
		'hashes the uncompressed NAR for $name and caches the digest',
		async ({ input }) => {
			const stream = compressNarToStream([input], input.byteLength);

			await drainStream(stream.body);

			const first = stream.digest();
			const second = stream.digest();

			expect({
				first,
				second,
				cached: first.narHash === second.narHash
			}).toStrictEqual({
				first: expectedDigest(input),
				second: expectedDigest(input),
				cached: true
			});
		}
	);
});

describe('compressNarToStream frames', () => {
	const frameSize = 16 * mebibyte;
	const cases: readonly {
		readonly name: string;
		readonly size: number;
		readonly frames: readonly number[];
	}[] = [
		{ name: 'empty input', size: 0, frames: [0] },
		{ name: 'less than one frame', size: mebibyte + 3, frames: [mebibyte + 3] },
		{
			name: 'an exact multiple of the frame size',
			size: 2 * frameSize,
			frames: [frameSize, frameSize]
		},
		{
			name: 'several frames and a remainder',
			size: 2 * frameSize + 5,
			frames: [frameSize, frameSize, 5]
		}
	];

	it.each(cases)(
		'writes one checksummed frame per 16 MiB of NAR for $name',
		async ({ size, frames }) => {
			const input = pseudoRandomBytes(size, 1);
			const upload = compressNarToStream(pieces(input, 100_000), size);
			const chunks = await Array.fromAsync(upload.body);
			const compressed = Buffer.concat(chunks);

			expect({
				frames: frameHeaders(compressed),
				chunksWithinLimit: chunks.every(
					(chunk) => chunk.byteLength <= mebibyte
				),
				decoded: fingerprint(await decodeWithVerifierDecoder(compressed)),
				digest: upload.digest()
			}).toStrictEqual({
				frames: frames.map((contentSize) => ({
					contentSize,
					hasChecksum: true,
					windowSize: Math.min(contentSize, 2 * mebibyte)
				})),
				chunksWithinLimit: true,
				decoded: fingerprint(input),
				digest: expectedDigest(input)
			});
		}
	);

	it('compresses one frame at a time from the NAR pieces as they are read', async () => {
		const compressors = new RecordingCompressors();
		const narSize = 2 * frameSize + 5;

		const upload = compressNarToStream(
			pieces(new Uint8Array(narSize), mebibyte),
			narSize,
			compressors.options()
		);
		await drainStream(upload.body);

		expect(compressors.summary()).toStrictEqual({
			frameLengths: [frameSize, frameSize, 5],
			peakActive: 1,
			largestWrite: mebibyte,
			written: narSize
		});
	});

	it('reports the NAR and compressed bytes, frames and time waited for compression', async () => {
		const narSize = 2 * frameSize + 5;
		let tick = 0;
		const upload = compressNarToStream(
			pieces(new Uint8Array(narSize), mebibyte),
			narSize,
			{ ...new RecordingCompressors().options(), now: () => (tick += 1) }
		);

		await drainStream(upload.body);

		// `now` returns one more on each call, so each wait measures 1 ms. The
		// meter times 34 waits: one for each of the 33 chunks and one for the
		// end.
		expect(upload.compression?.()).toStrictEqual({
			narBytes: narSize,
			compressedBytes: narSize,
			frames: 3,
			compressionMs: 34
		});
	});

	it.each([
		{
			name: 'fewer bytes than declared',
			actual: 100,
			declared: 101,
			ending: 'ended'
		},
		{
			name: 'more bytes than declared',
			actual: 101,
			declared: 100,
			ending: 'continued'
		},
		{
			name: 'more bytes than declared after a whole frame',
			actual: frameSize + 1,
			declared: frameSize,
			ending: 'continued'
		}
	])(
		'fails with NarSizeChangedError when the NAR has $name',
		async ({ actual, declared, ending }) => {
			const upload = compressNarToStream(
				pieces(new Uint8Array(actual), mebibyte),
				declared
			);

			const error = await rejectionOf(drainStream(upload.body));

			expect(error).toBeInstanceOf(NarSizeChangedError);
			expect(error).toMatchObject({
				expected: declared,
				actual,
				ending
			});
		}
	);

	it('emits the frames before a failed frame and then fails with its error', async () => {
		const failure = new FrameFailedError(2);
		const compressors = new RecordingCompressors(failure);
		const narSize = 3 * frameSize;
		const consumed: number[] = [];
		let rejection: unknown;

		try {
			const upload = compressNarToStream(
				pieces(new Uint8Array(narSize), mebibyte),
				narSize,
				compressors.options()
			);

			for await (const chunk of upload.body) {
				consumed.push(chunk.byteLength);
			}
		} catch (error) {
			rejection = error;
		}

		expect({
			consumed: consumed.reduce((total, length) => total + length, 0),
			rejection
		}).toStrictEqual({ consumed: frameSize, rejection: failure });
		expect(rejection).toBe(failure);
	});

	it('stops reading and compressing when the body is cancelled', async () => {
		const source = new RecordingSource(8 * 16);
		const compressors = new RecordingCompressors();
		const upload = compressNarToStream(
			source,
			8 * frameSize,
			compressors.options()
		);
		const reader = upload.body.getReader();

		await reader.read();
		const before = { reads: source.reads, frames: compressors.created };
		await reader.cancel();
		await new Promise((resolve) => setImmediate(resolve));

		expect({
			returned: source.returned,
			reads: source.reads,
			frames: compressors.created,
			active: compressors.active
		}).toStrictEqual({
			returned: true,
			reads: before.reads,
			frames: before.frames,
			active: 0
		});
	});
});

describe('sendCompressedNar', () => {
	it('cancels the body and rethrows when sending fails', async () => {
		const source = new RecordingSource(8 * 16);
		const failure = new UploadFailedError();
		const upload = compressNarToStream(
			source,
			8 * frameSizeBytes,
			new RecordingCompressors().options()
		);
		let rejection: unknown;

		try {
			await sendCompressedNar(upload.body, async (body) => {
				const reader = body.getReader();
				await reader.read();
				reader.releaseLock();
				throw failure;
			});
		} catch (error) {
			rejection = error;
		}

		const readsAfterFailure = source.reads;
		await new Promise((resolve) => setImmediate(resolve));

		expect({
			rejection,
			returned: source.returned,
			reads: source.reads
		}).toStrictEqual({
			rejection: failure,
			returned: true,
			reads: readsAfterFailure
		});
		expect(rejection).toBe(failure);
	});
});

const frameSizeBytes = 16 * mebibyte;

class UploadFailedError extends Error {
	constructor() {
		super('upload failed');
		this.name = 'UploadFailedError';
	}
}

class FrameFailedError extends Error {
	constructor(public readonly frame: number) {
		super(`frame ${String(frame)} failed`);
		this.name = 'FrameFailedError';
	}
}

// Yields `count` NAR pieces of 1 MiB and records how many were read and
// whether the consumer stopped the iteration early.
class RecordingSource implements AsyncIterable<Uint8Array> {
	reads = 0;

	returned = false;

	constructor(private readonly count: number) {}

	[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
		return {
			next: () => {
				if (this.reads >= this.count) {
					return Promise.resolve({ done: true, value: undefined });
				}

				this.reads += 1;

				return Promise.resolve({
					done: false,
					value: new Uint8Array(mebibyte)
				});
			},
			return: () => {
				this.returned = true;

				return Promise.resolve({ done: true, value: undefined });
			}
		};
	}
}

// Frame compressors that pass their input through unchanged and record each
// frame's length, the largest write and how many frames were open at once. The
// frame numbered `failure.frame`, counting from 1, fails with `failure`.
class RecordingCompressors {
	private peakActive = 0;

	private largestWrite = 0;

	private written = 0;

	readonly frameLengths: number[] = [];

	created = 0;

	active = 0;

	constructor(private readonly failure?: FrameFailedError) {}

	private create(frameLength: number): Transform {
		this.created += 1;
		this.active += 1;
		this.peakActive = Math.max(this.peakActive, this.active);
		this.frameLengths.push(frameLength);

		const frame = this.created;
		const transform = new Transform({
			transform: (chunk: Buffer, _encoding, callback) => {
				this.largestWrite = Math.max(this.largestWrite, chunk.byteLength);
				this.written += chunk.byteLength;

				if (this.failure?.frame === frame) {
					callback(this.failure);
					return;
				}

				callback(undefined, chunk);
			}
		});

		transform.once('close', () => {
			this.active -= 1;
		});

		return transform;
	}

	options(): NarCompressionOptions {
		return {
			...defaultNarCompression,
			createFrameCompressor: (length) => this.create(length)
		};
	}

	summary(): {
		readonly frameLengths: readonly number[];
		readonly peakActive: number;
		readonly largestWrite: number;
		readonly written: number;
	} {
		return {
			frameLengths: this.frameLengths,
			peakActive: this.peakActive,
			largestWrite: this.largestWrite,
			written: this.written
		};
	}
}

async function rejectionOf(operation: Promise<unknown>): Promise<unknown> {
	try {
		await operation;
	} catch (error) {
		return error;
	}

	return undefined;
}

interface FrameHeader {
	readonly contentSize: number | undefined;
	readonly hasChecksum: boolean;
	readonly windowSize: number | undefined;
}

// Walks the zstd frames in `bytes` (RFC 8878, section 3.1.1) and returns
// each frame's declared content size, checksum flag and window size.
function frameHeaders(bytes: Buffer): FrameHeader[] {
	const headers: FrameHeader[] = [];
	let offset = 0;

	while (offset < bytes.byteLength) {
		expect(bytes.readUInt32LE(offset)).toBe(0xfd_2f_b5_28);

		const descriptor = bytes.readUInt8(offset + 4);
		const contentSizeFlag = descriptor >> 6;
		const isSingleSegment = (descriptor & 0x20) !== 0;
		const hasChecksum = (descriptor & 0x04) !== 0;
		offset += 5;

		let windowSize = 0;

		if (!isSingleSegment) {
			const windowDescriptor = bytes.readUInt8(offset);
			const windowBase = 2 ** (10 + (windowDescriptor >> 3));
			windowSize = windowBase + (windowBase / 8) * (windowDescriptor & 0x07);
			offset += 1;
		}

		offset += [0, 1, 2, 4][descriptor & 0x03] ?? 0;

		const contentSizeLength = [isSingleSegment ? 1 : 0, 2, 4, 8][
			contentSizeFlag
		];
		const contentSize = readContentSize(bytes, offset, contentSizeLength);
		offset += contentSizeLength ?? 0;

		for (let isLast = false; !isLast;) {
			const blockHeader = bytes.readUIntLE(offset, 3);
			isLast = (blockHeader & 1) === 1;
			const blockType = (blockHeader >> 1) & 0x03;
			const blockSize = blockHeader >> 3;
			offset += 3 + (blockType === 1 ? 1 : blockSize);
		}

		offset += hasChecksum ? 4 : 0;
		headers.push({
			contentSize,
			hasChecksum,
			windowSize: isSingleSegment ? contentSize : windowSize
		});
	}

	return headers;
}

function readContentSize(
	bytes: Buffer,
	offset: number,
	length: number | undefined
): number | undefined {
	if (length === undefined || length === 0) {
		return undefined;
	}

	if (length === 2) {
		return bytes.readUInt16LE(offset) + 256;
	}

	if (length === 8) {
		return Number(bytes.readBigUInt64LE(offset));
	}

	return bytes.readUIntLE(offset, length);
}

// Node's zstd decompressor silently stops after the first frame, so decode
// with the server's `ZstdDecoder`, using the verifier's settings.
async function decodeWithVerifierDecoder(
	compressed: Uint8Array
): Promise<Uint8Array> {
	const decoded: Uint8Array[] = [];
	const decoder = new ZstdDecoder({
		chunkSize: mebibyte,
		windowLogMax: 23,
		onOutput: (chunk) => {
			decoded.push(Buffer.from(chunk));
		}
	});

	for (const piece of pieces(compressed, mebibyte)) {
		await decoder.write(piece);
	}

	await decoder.end();

	return Buffer.concat(decoded);
}

function pieces(bytes: Uint8Array, size: number): Uint8Array[] {
	return Array.from(
		{ length: Math.ceil(bytes.byteLength / size) },
		(_, index) => bytes.subarray(index * size, (index + 1) * size)
	);
}
