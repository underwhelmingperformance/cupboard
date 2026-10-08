import { createHash } from 'node:crypto';
import { PassThrough, Transform } from 'node:stream';

import { ZstdDecoder } from '@cupboard/nix-store/zstd';
import { describe, expect, it } from 'vitest';

import {
	fingerprint,
	pseudoRandomBytes
} from '../../../../tests/support/bytes.ts';
import { MemoryNarSource } from '../../../../tests/support/nar-source.ts';
import { type ByteSource, byteStream } from '../io/byte-stream.ts';

import {
	CheckpointUnavailableError,
	type CompressedCheckpoint,
	compressNarToStream,
	defaultNarCompression,
	FramedNarCompressor,
	type NarCompressionOptions,
	NarHashStateMissingError,
	NarSizeChangedError,
	RecompressedNarMismatchError,
	sendCompressedNar,
	zstdCompressBound
} from './blob.ts';
import { type NarDigest, NixSha256Hash } from './nar.ts';
import type { NarSource } from './nar-source.ts';

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
			const stream = compressNarToStream(
				narSourceOf([input]),
				input.byteLength
			);

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
			const upload = compressNarToStream(pieceSource(input, 100_000), size);
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
			pieceSource(new Uint8Array(narSize), mebibyte),
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
			pieceSource(new Uint8Array(narSize), mebibyte),
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
				pieceSource(new Uint8Array(actual), mebibyte),
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
				pieceSource(new Uint8Array(narSize), mebibyte),
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
			narSourceOf(source),
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

describe('FramedNarCompressor', () => {
	// 20 MiB that zstd cannot compress, then 20 MiB of text that it can: two
	// 16 MiB frames and one of 8 MiB, with frame 1 straddling the change.
	const nar = Buffer.concat([
		pseudoRandomBytes(20 * mebibyte, 3),
		Buffer.from('compressible NAR text '.repeat(1_000_000)).subarray(
			0,
			20 * mebibyte
		)
	]);

	// The first read yields pieces of 100,003 bytes and later reads yield
	// 1 MiB pieces, so recompressed frames are written to zstd in pieces of a
	// different size. A store with one connection refuses a second open while
	// the first is still being read.
	function source(
		contents: (open: number) => Uint8Array = () => nar
	): MemoryNarSource {
		return new MemoryNarSource({
			contents,
			pieceSize: (open) => (open === 0 ? 100_003 : mebibyte),
			isExclusive: true
		});
	}

	interface FirstPass {
		readonly compressor: FramedNarCompressor;
		readonly output: Buffer;
		readonly checkpoint: CompressedCheckpoint;
	}

	// Reads the first pass a chunk at a time. Takes a checkpoint at the first
	// position of at least `from.position` bytes, or at the start of frame
	// `from.frame`, and stops at the first position of at least `to` bytes or
	// at the end.
	async function firstPass(
		compressor: FramedNarCompressor,
		from: { readonly position: number } | { readonly frame: number },
		to: number
	): Promise<FirstPass> {
		const chunks: Uint8Array[] = [];
		let checkpoint: CompressedCheckpoint | undefined;

		while (compressor.position < to && (await compressor.hasMore())) {
			const candidate = compressor.checkpoint();
			const isStart =
				'frame' in from
					? candidate.frame === from.frame && candidate.frameOffset === 0
					: candidate.position >= from.position;
			checkpoint ??= isStart ? candidate : undefined;
			chunks.push((await compressor.read(Infinity)) ?? new Uint8Array());
		}

		if (checkpoint === undefined) {
			throw new RangeError('the first pass never reached the checkpoint');
		}

		return { compressor, output: Buffer.concat(chunks), checkpoint };
	}

	// Reads the rest of the compressed NAR, up to `until` bytes in all.
	async function readOn(
		compressor: FramedNarCompressor,
		until = Infinity
	): Promise<Buffer> {
		const chunks: Uint8Array[] = [];

		while (compressor.position < until && (await compressor.hasMore())) {
			chunks.push(
				(await compressor.read(until - compressor.position)) ?? new Uint8Array()
			);
		}

		return Buffer.concat(chunks);
	}

	it.each([
		{
			name: 'within one frame',
			from: { position: 2 * mebibyte },
			to: 9 * mebibyte
		},
		{
			name: 'across a frame boundary',
			from: { position: 10 * mebibyte },
			to: 18 * mebibyte
		},
		{
			name: 'from the start of a frame',
			from: { frame: 1 },
			to: 19 * mebibyte
		},
		{
			name: 'to the end of the NAR',
			from: { position: 17 * mebibyte },
			to: Infinity
		}
	])(
		'rewinds $name to a checkpoint and recompresses from the frame that contains it, with one open at a time',
		async ({ from, to }) => {
			const narSource = source();
			const pass = await firstPass(
				new FramedNarCompressor(narSource, nar.byteLength),
				from,
				to
			);
			const reached = pass.compressor.position;
			await pass.compressor.rewind(pass.checkpoint);
			const recompressed = await readOn(pass.compressor, reached);
			const rest = await readOn(pass.compressor);
			const whole = Buffer.concat([
				pass.output.subarray(0, pass.checkpoint.position),
				recompressed,
				rest
			]);

			expect({
				recompressed: fingerprint(recompressed),
				whole: fingerprint(whole),
				opens: narSource.opens,
				closed: narSource.closed,
				digest: pass.compressor.digest()
			}).toStrictEqual({
				recompressed: fingerprint(
					pass.output.subarray(pass.checkpoint.position)
				),
				whole: fingerprint(await compressedOf(nar)),
				opens: [0, pass.checkpoint.frame * frameSizeBytes],
				closed: 2,
				digest: expectedDigest(nar)
			});
		}
	);

	it('refuses to rewind when the bytes before the checkpoint changed', async () => {
		const changed = Buffer.from(nar);
		changed[1000] = (changed[1000] ?? 0) ^ 0xff;
		const pass = await firstPass(
			new FramedNarCompressor(
				source((open) => (open === 0 ? nar : changed)),
				nar.byteLength
			),
			{ position: 2 * mebibyte },
			4 * mebibyte
		);

		const error = await rejectionOf(pass.compressor.rewind(pass.checkpoint));

		expect(mismatchOf(error)).toStrictEqual({
			name: 'RecompressedNarMismatchError',
			frame: 0,
			position: pass.checkpoint.position
		});
	});

	it('rejects while it recompresses a frame that changed after the checkpoint', async () => {
		const changed = Buffer.from(nar);
		const index = 18 * mebibyte;
		changed[index] = (changed[index] ?? 0) ^ 0xff;
		const pass = await firstPass(
			new FramedNarCompressor(
				source((open) => (open === 0 ? nar : changed)),
				nar.byteLength
			),
			{ position: 2 * mebibyte },
			19 * mebibyte
		);
		const reached = pass.compressor.position;
		await pass.compressor.rewind(pass.checkpoint);
		const returned: number[] = [];

		const error = await rejectionOf(
			(async () => {
				while (pass.compressor.position < reached) {
					const chunk = await pass.compressor.read(reached);
					returned.push(chunk?.byteLength ?? 0);
				}
			})()
		);

		// The last chunk before the position that the first read reached is
		// checked before it is returned, so the changed bytes are never handed
		// out.
		expect({
			mismatch: mismatchOf(error),
			returnedAll:
				returned.reduce((total, length) => total + length, 0) ===
				reached - pass.checkpoint.position
		}).toStrictEqual({
			mismatch: {
				name: 'RecompressedNarMismatchError',
				frame: 1,
				position: reached
			},
			returnedAll: false
		});
	});
});

// Frame compressors that pass the NAR bytes through unchanged, so a
// compressed position is also a NAR offset. Each one buffers up to 4 MiB, so
// the compressor reads pieces ahead of the bytes that it returns, as zstd
// does.
const identity: NarCompressionOptions = {
	createFrameCompressor: () => new PassThrough({ highWaterMark: 4 * mebibyte }),
	now: () => 0
};

describe('FramedNarCompressor NAR hash after a rewind', () => {
	it('continues after a rewind to the current checkpoint at a frame boundary', async () => {
		const nar = pseudoRandomBytes(17 * mebibyte, 45);
		const source = MemoryNarSource.of(nar);
		const compressor = new FramedNarCompressor(
			source,
			nar.byteLength,
			identity
		);
		await readTo(compressor, 16 * mebibyte);
		await compressor.hasMore();
		const current = compressor.checkpoint();

		await compressor.rewind(current);
		const rest = await readTo(compressor);

		expect({
			rest: fingerprint(rest),
			digest: compressor.digest(),
			opens: source.opens,
			closed: source.closed
		}).toStrictEqual({
			rest: fingerprint(nar.subarray(16 * mebibyte)),
			digest: expectedDigest(nar),
			opens: [0, 16 * mebibyte],
			closed: 2
		});
	});

	it('hashes the bytes that it reads again after the position that the first read reached', async () => {
		const nar = pseudoRandomBytes(3 * mebibyte, 41);
		// The first read returns bytes up to `reached`, but it has already
		// hashed the rest of the 1 MiB piece that contains `reached`. The NAR
		// changes in that piece before it is read again.
		const reached = 2 * mebibyte + 1000;
		const changed = Buffer.from(nar);
		changed[reached + 10] = (changed[reached + 10] ?? 0) ^ 0xff;
		const compressor = new FramedNarCompressor(
			new MemoryNarSource({
				contents: (open) => (open === 0 ? nar : changed)
			}),
			nar.byteLength,
			identity
		);
		await compressor.hasMore();
		const start = compressor.checkpoint();
		await readTo(compressor, reached);

		await compressor.rewind(start);
		const stored = await readTo(compressor);

		expect({
			stored: fingerprint(stored),
			digest: compressor.digest()
		}).toStrictEqual({
			stored: fingerprint(changed),
			digest: expectedDigest(changed)
		});
	});

	it('hashes each NAR byte once when a read finishes while the rewind closes the source', async () => {
		const nar = pseudoRandomBytes(3 * mebibyte, 42);
		const arrived = Promise.withResolvers<undefined>();
		const released = Promise.withResolvers<undefined>();
		// The first read waits for the piece at 2 MiB until the rewind has
		// started to close the source.
		const compressor = new FramedNarCompressor(
			new MemoryNarSource({
				contents: () => nar,
				beforePiece: async (open, offset) => {
					if (open !== 0 || offset !== 2 * mebibyte) {
						return;
					}

					arrived.resolve(undefined);
					await released.promise;
				}
			}),
			nar.byteLength,
			identity
		);
		await compressor.hasMore();
		const start = compressor.checkpoint();
		await readTo(compressor, 2 * mebibyte);
		await arrived.promise;

		const rewinding = compressor.rewind(start);
		await new Promise((resolve) => setImmediate(resolve));
		released.resolve(undefined);
		await rewinding;
		const stored = await readTo(compressor);

		expect({
			stored: fingerprint(stored),
			digest: compressor.digest()
		}).toStrictEqual({
			stored: fingerprint(nar),
			digest: expectedDigest(nar)
		});
	});
});

describe('FramedNarCompressor saved hash states', () => {
	it('keeps no state for the frames before a discarded checkpoint', async () => {
		const nar = pseudoRandomBytes(40 * mebibyte, 44);
		const compressor = new FramedNarCompressor(
			MemoryNarSource.of(nar),
			nar.byteLength,
			identity
		);
		await compressor.hasMore();
		const first = compressor.checkpoint();
		await readTo(compressor, 33 * mebibyte);
		await compressor.hasMore();
		const late = compressor.checkpoint();
		compressor.discardBefore(late);

		const error = await rejectionOf(compressor.rewind(first));

		expect({ error, late: late.frame }).toStrictEqual({
			error: new NarHashStateMissingError(0),
			late: 2
		});
	});
});

describe('FramedNarCompressor misuse', () => {
	it('refuses a checkpoint before it has a compressed byte to follow it', () => {
		const compressor = new FramedNarCompressor(
			MemoryNarSource.of(new Uint8Array(10)),
			10
		);

		expect(rejectionOfSync(() => compressor.checkpoint())).toStrictEqual(
			new CheckpointUnavailableError(0)
		);
	});

	it('refuses to rewind to a frame that the NAR hash has not reached', async () => {
		const nar = pseudoRandomBytes(mebibyte, 43);
		const compressor = new FramedNarCompressor(
			MemoryNarSource.of(nar),
			nar.byteLength
		);
		await compressor.hasMore();

		const error = await rejectionOf(
			compressor.rewind({
				position: 0,
				frame: 1,
				frameOffset: 0,
				digest: ''
			})
		);

		expect(error).toStrictEqual(new NarHashStateMissingError(16 * mebibyte));
	});
});

function rejectionOfSync(operation: () => unknown): unknown {
	try {
		operation();
	} catch (error) {
		return error;
	}

	return undefined;
}

// Reads until the compressed position reaches `to` and returns the bytes.
async function readTo(
	compressor: FramedNarCompressor,
	to = Infinity
): Promise<Buffer> {
	const chunks: Uint8Array[] = [];

	while (compressor.position < to && (await compressor.hasMore())) {
		chunks.push(
			(await compressor.read(to - compressor.position)) ?? new Uint8Array()
		);
	}

	return Buffer.concat(chunks);
}

function mismatchOf(error: unknown): unknown {
	if (!(error instanceof RecompressedNarMismatchError)) {
		return error;
	}

	return { name: error.name, frame: error.frame, position: error.position };
}

async function compressedOf(nar: Uint8Array): Promise<Buffer> {
	const upload = compressNarToStream(MemoryNarSource.of(nar), nar.byteLength);

	return Buffer.from(await new Response(upload.body).arrayBuffer());
}

describe('zstdCompressBound', () => {
	// The values follow ZSTD_COMPRESSBOUND in zstd.h, which adds a margin to
	// inputs smaller than 128 KiB.
	it.each([
		{ length: 0, bound: 64 },
		{ length: 1, bound: 64 },
		{ length: 2048, bound: 2119 },
		{ length: 128 * 1024, bound: 128 * 1024 + 512 },
		{ length: 16 * mebibyte, bound: 16 * mebibyte + 65_536 }
	])('bounds a frame of $length bytes at $bound bytes', ({ length, bound }) => {
		expect(zstdCompressBound(length)).toBe(bound);
	});
});

describe('sendCompressedNar', () => {
	it('cancels the body and rethrows when sending fails', async () => {
		const source = new RecordingSource(8 * 16);
		const failure = new UploadFailedError();
		const upload = compressNarToStream(
			narSourceOf(source),
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

function pieceSource(input: Uint8Array, length: number): NarSource {
	return narSourceOf(pieces(input, length));
}

// A NAR source that serves `source` from offset 0, the only offset that
// `compressNarToStream` opens.
function narSourceOf(source: ByteSource): NarSource {
	return {
		open: (offset) => {
			if (offset !== 0) {
				throw new RangeError(`unexpected offset ${String(offset)}`);
			}

			return byteStream(source);
		}
	};
}

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
