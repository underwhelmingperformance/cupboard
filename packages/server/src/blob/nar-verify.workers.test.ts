import { hexToBytes } from '@cupboard/nix-store/encoding';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { zstdCompressionStream } from '@cupboard/nix-store/zstd';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { boundedBlobs } from '../do/bounded-io.ts';
import {
	holdSubrequests,
	withSubrequestSlice
} from '../do/subrequest-slice.ts';
import {
	StoredObjectInconsistentError,
	SubrequestTimeoutError
} from '../errors.ts';
import { r2ObjectKeySchema } from '../http/http.ts';
import { resetTestServer } from '../test-support.ts';

import {
	type NarChunkSource,
	openStoredNarChunks,
	type ReadWatch
} from './nar-chunks.ts';
import { NarReadBufferPool } from './nar-read-buffers.ts';
import {
	type NarVerification,
	type NarVerifyProgress,
	narVerifyProgress,
	verifyDecompressedNar,
	verifyStoredNar
} from './nar-verify.ts';

const mebibyte = 1024 * 1024;

async function nixNarHash(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));

	return NixSha256Hash.fromDigest(digest).toString();
}

interface TrackedBody {
	readonly stream: ReadableStream<Uint8Array>;
	readonly wasCancelled: () => boolean;
	readonly cancelled: Promise<undefined>;
}

/**
 * A readable byte stream that serves `chunks` in order. R2 bodies are byte
 * streams, and the verifier reads them with a BYOB reader.
 */
function byteBody(chunks: readonly Uint8Array[]): TrackedBody {
	let wasCancelled = false;
	const cancelled = Promise.withResolvers<undefined>();
	let index = 0;

	const stream = new ReadableStream({
		type: 'bytes',
		pull(controller) {
			const chunk = chunks[index];
			index += 1;

			if (chunk === undefined) {
				controller.close();
				return;
			}

			controller.enqueue(new Uint8Array(chunk));
		},
		cancel() {
			wasCancelled = true;
			cancelled.resolve(undefined);
		}
	});

	return {
		stream,
		wasCancelled: () => wasCancelled,
		cancelled: cancelled.promise
	};
}

/**
 * A byte stream that serves each chunk only after the test releases it.
 * `requested(index)` resolves when the reader asks for that chunk; the index
 * after the last chunk is the request that the stream answers by closing.
 */
function gatedBody(chunks: readonly Uint8Array[]): TrackedBody & {
	readonly requested: (index: number) => Promise<void>;
	readonly release: (index: number) => void;
} {
	let wasCancelled = false;
	const cancelled = Promise.withResolvers<undefined>();
	const requests = Array.from({ length: chunks.length + 1 }, () =>
		Promise.withResolvers<undefined>()
	);
	const releases = Array.from({ length: chunks.length + 1 }, () =>
		Promise.withResolvers<undefined>()
	);
	let index = 0;

	const stream = new ReadableStream({
		type: 'bytes',
		async pull(controller) {
			const current = index;
			index += 1;
			requests[current]?.resolve(undefined);
			await releases[current]?.promise;
			const chunk = chunks[current];

			if (chunk === undefined) {
				controller.close();
				return;
			}

			controller.enqueue(new Uint8Array(chunk));
		},
		cancel() {
			wasCancelled = true;
			cancelled.resolve(undefined);
		}
	});

	return {
		stream,
		wasCancelled: () => wasCancelled,
		cancelled: cancelled.promise,
		requested: async (index) => {
			await requests[index]?.promise;
		},
		release: (index) => {
			releases[index]?.resolve(undefined);
		}
	};
}

function neverProducingBody(): TrackedBody {
	let wasCancelled = false;
	const cancelled = Promise.withResolvers<undefined>();

	const stream = new ReadableStream({
		type: 'bytes',
		pull() {
			return new Promise(() => {
				// Keep this promise pending until the stall timeout cancels it.
			});
		},
		cancel() {
			wasCancelled = true;
			cancelled.resolve(undefined);
		}
	});

	return {
		stream,
		wasCancelled: () => wasCancelled,
		cancelled: cancelled.promise
	};
}

function withStalledBody(
	object: R2ObjectBody,
	body: ReadableStream<Uint8Array>
): R2ObjectBody {
	return new Proxy(object, {
		get(target, property) {
			if (property === 'body') {
				return body;
			}

			const value: unknown = Reflect.get(target, property, target);

			if (typeof value !== 'function') {
				return value;
			}

			const bound: unknown = value.bind(target);

			return bound;
		}
	});
}

function stubbedGetBucket(
	bucket: R2Bucket,
	stalledKey: string,
	stalledObject: R2ObjectBody
): R2Bucket {
	return new Proxy(bucket, {
		get(target, property) {
			if (property === 'get') {
				return async (key: string, options?: R2GetOptions) =>
					key === stalledKey ? stalledObject : target.get(key, options);
			}

			const value: unknown = Reflect.get(target, property, target);

			if (typeof value !== 'function') {
				return value;
			}

			const bound: unknown = value.bind(target);

			return bound;
		}
	});
}

function deferredGetBucket(
	bucket: R2Bucket,
	stalledKey: string,
	pending: Promise<R2ObjectBody | null>
): R2Bucket {
	return new Proxy(bucket, {
		get(target, property) {
			if (property === 'get') {
				return (key: string, options?: R2GetOptions) =>
					key === stalledKey ? pending : target.get(key, options);
			}

			const value: unknown = Reflect.get(target, property, target);

			if (typeof value !== 'function') {
				return value;
			}

			const bound: unknown = value.bind(target);

			return bound;
		}
	});
}

/**
 * Stores `stored` at `r2Key` and returns a bucket whose `get` returns that
 * object's metadata with `body` as its body.
 */
async function bucketServing(
	r2Key: string,
	body: ReadableStream<Uint8Array>,
	stored: Uint8Array = new Uint8Array([1, 2, 3])
): Promise<R2Bucket> {
	await env.BLOBS.put(r2Key, stored);
	const real = await env.BLOBS.get(r2Key);

	if (real === null) {
		throw new Error('expected the staged object to exist');
	}

	return stubbedGetBucket(env.BLOBS, r2Key, withStalledBody(real, body));
}

async function settle<T>(
	operation: Promise<T>
): Promise<{ readonly value: T } | { readonly error: unknown }> {
	try {
		return { value: await operation };
	} catch (error) {
		return { error };
	}
}

async function compressedBytes(bytes: Uint8Array): Promise<Uint8Array> {
	const source = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		}
	});

	const compressed = source.pipeThrough(zstdCompressionStream());

	return new Uint8Array(await new Response(compressed).arrayBuffer());
}

async function compressedStream(
	bytes: Uint8Array
): Promise<ReadableStream<Uint8Array>> {
	return byteBody([await compressedBytes(bytes)]).stream;
}

/**
 * Builds a zstd frame that stores `content` in raw blocks, with the content
 * size in the frame header. workerd's zstd compressor fails once its output
 * exceeds about 40 KiB, so multi-MiB fixtures are built by hand. A raw-block
 * frame is as large as its content, so it also gives a large compressed
 * object.
 */
function rawZstdFrame(content: Uint8Array, windowLog = 20): Uint8Array {
	const maxBlockSize = 128 * 1024;
	const blockCount = Math.max(1, Math.ceil(content.byteLength / maxBlockSize));
	const headerSize = 10;
	const frame = new Uint8Array(
		headerSize + blockCount * 3 + content.byteLength
	);
	const view = new DataView(frame.buffer);

	view.setUint32(0, 0xfd_2f_b5_28, true);
	// Frame_Header_Descriptor: a 4-byte Frame_Content_Size and a window
	// descriptor, with no checksum and no dictionary.
	view.setUint8(4, 0x80);
	view.setUint8(5, (windowLog - 10) << 3);
	view.setUint32(6, content.byteLength, true);

	let offset = headerSize;

	for (let block = 0; block < blockCount; block += 1) {
		const data = content.subarray(
			block * maxBlockSize,
			(block + 1) * maxBlockSize
		);
		const lastBlockFlag = block === blockCount - 1 ? 1 : 0;
		// Block_Type 0 is a raw block.
		const header = lastBlockFlag | (data.byteLength << 3);

		view.setUint16(offset, header & 0xff_ff, true);
		view.setUint8(offset + 2, header >>> 16);
		frame.set(data, offset + 3);
		offset += 3 + data.byteLength;
	}

	return frame;
}

function concatenated(parts: readonly Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
	const joined = new Uint8Array(total);
	let offset = 0;

	for (const part of parts) {
		joined.set(part, offset);
		offset += part.byteLength;
	}

	return joined;
}

function slices(bytes: Uint8Array, size: number): Uint8Array[] {
	return Array.from(
		{ length: Math.ceil(bytes.byteLength / size) },
		(_, index) => bytes.subarray(index * size, (index + 1) * size)
	);
}

/**
 * A 4.5 MiB NAR stored as three concatenated raw-block frames. The compressed
 * object is slightly larger than 4.5 MiB, so the verifier reads it in five
 * reads of up to 1 MiB.
 */
function multiFrameNar(): {
	readonly nar: Uint8Array;
	readonly compressed: Uint8Array;
} {
	const frames = [1, 2, 3].map((fill) =>
		new Uint8Array(1.5 * mebibyte).fill(fill)
	);

	return {
		nar: concatenated(frames),
		compressed: concatenated(frames.map((frame) => rawZstdFrame(frame)))
	};
}

/**
 * Builds a zstd skippable frame of `size` bytes: the magic number, the length
 * of the payload, and a payload of zeros. Decoders that follow RFC 8878 skip
 * it. The CLI pads a streamed part whose compressed bytes end before the part
 * does.
 */
function skippableFrame(size: number): Uint8Array {
	const frame = new Uint8Array(size);
	const view = new DataView(frame.buffer);

	view.setUint32(0, 0x18_4d_2a_50, true);
	view.setUint32(4, size - 8, true);

	return frame;
}

describe('verifyDecompressedNar', () => {
	// Keep the payload large enough to cross the bridge in several chunks. The
	// runtime benchmark covers bounded memory with multi-hundred-megabyte NARs.
	const encoder = new TextEncoder();
	const nar = encoder.encode('nar payload '.repeat(250_000));

	it('accepts a blob and reports the compressed file hash and size', async () => {
		const narHash = await nixNarHash(nar);
		const compressed = await compressedBytes(nar);

		const result = await verifyDecompressedNar(await compressedStream(nar), {
			narHash,
			narSize: nar.byteLength
		});

		expect(result).toStrictEqual({
			ok: true,
			fileHash: await nixNarHash(compressed),
			fileSize: compressed.byteLength
		});
	});

	it('rejects a hash mismatch and reports the recomputed hash', async () => {
		const encoder = new TextEncoder();
		const claimed = await nixNarHash(encoder.encode('something else'));
		const actualNarHash = await nixNarHash(nar);

		const result = await verifyDecompressedNar(await compressedStream(nar), {
			narHash: claimed,
			narSize: nar.byteLength
		});

		expect(result).toStrictEqual({
			ok: false,
			reason: 'nar-hash-mismatch',
			actualNarHash
		});
	});

	it('rejects a size mismatch when the hash matches', async () => {
		const narHash = await nixNarHash(nar);

		const result = await verifyDecompressedNar(await compressedStream(nar), {
			narHash,
			narSize: nar.byteLength + 1
		});

		expect(result).toStrictEqual({
			ok: false,
			reason: 'nar-size-mismatch',
			actualNarSize: nar.byteLength
		});
	});

	it('aborts decompression mid-stream once the declared size is exceeded', async () => {
		const narHash = await nixNarHash(nar);
		const declaredNarSize = 1024;

		// A declaration far below the payload size must trip the overrun guard before
		// the stream drains. A reported size above the declaration but below the full
		// payload proves that the zstd-bomb defence stopped decompression mid-stream.
		const result = await verifyDecompressedNar(await compressedStream(nar), {
			narHash,
			narSize: declaredNarSize
		});
		const mismatch = z
			.object({
				ok: z.literal(false),
				reason: z.literal('nar-size-mismatch'),
				actualNarSize: z.number()
			})
			.parse(result);

		expect({
			mismatch,
			bounds: {
				overDeclared: mismatch.actualNarSize > declaredNarSize,
				underFullPayload: mismatch.actualNarSize < nar.byteLength
			}
		}).toStrictEqual({
			mismatch: {
				ok: false,
				reason: 'nar-size-mismatch',
				actualNarSize: mismatch.actualNarSize
			},
			bounds: {
				overDeclared: true,
				underFullPayload: true
			}
		});
	});

	it('decodes concatenated frames that end within one read', async () => {
		const first = encoder.encode('first frame '.repeat(1000));
		const second = encoder.encode('second frame '.repeat(1000));
		const both = concatenated([first, second]);
		const compressed = concatenated([
			await compressedBytes(first),
			await compressedBytes(second)
		]);

		const result = await verifyDecompressedNar(byteBody([compressed]).stream, {
			narHash: await nixNarHash(both),
			narSize: both.byteLength
		});

		expect(result).toStrictEqual({
			ok: true,
			fileHash: await nixNarHash(compressed),
			fileSize: compressed.byteLength
		});
	});

	it.each([
		{ name: 'the smallest skippable frame', padding: 8 },
		{ name: 'a skippable frame within the last read', padding: 1000 },
		{
			name: 'a skippable frame that spans several reads',
			padding: 3 * mebibyte + 5
		}
	])('accepts concatenated frames followed by $name', async ({ padding }) => {
		const { nar, compressed } = multiFrameNar();
		const padded = concatenated([compressed, skippableFrame(padding)]);

		const result = await verifyDecompressedNar(
			byteBody(slices(padded, mebibyte)).stream,
			{ narHash: await nixNarHash(nar), narSize: nar.byteLength }
		);

		expect(result).toStrictEqual({
			ok: true,
			fileHash: await nixNarHash(padded),
			fileSize: padded.byteLength
		});
	});

	it.each([
		{ windowLog: 23, verdict: 'ok' },
		{ windowLog: 24, verdict: 'undecodable' }
	])(
		'reports a frame with a window log of $windowLog as $verdict',
		async ({ windowLog, verdict }) => {
			const content = new Uint8Array(1.5 * mebibyte).fill(7);

			const result = await verifyDecompressedNar(
				byteBody([rawZstdFrame(content, windowLog)]).stream,
				{ narHash: await nixNarHash(content), narSize: content.byteLength }
			);

			expect(result.ok ? 'ok' : result.reason).toBe(verdict);
		}
	);

	it.each([
		{
			name: 'the declared size is exceeded',
			chunks: slices(multiFrameNar().compressed, mebibyte),
			narSize: 1000,
			outcome: 'nar-size-mismatch'
		},
		{
			name: 'the body is not zstd',
			chunks: [new Uint8Array(2 * mebibyte), new Uint8Array(mebibyte)],
			narSize: 3 * mebibyte,
			outcome: 'undecodable'
		}
	])(
		'stops reading and cancels the body when $name',
		async ({ chunks, narSize, outcome }) => {
			const body = byteBody(chunks);
			const progress = narVerifyProgress();

			const result = await verifyDecompressedNar(
				body.stream,
				{ narHash: 'sha256:unused', narSize },
				{ progress }
			);

			expect({
				outcome: result.ok ? 'ok' : result.reason,
				reads: progress.reads,
				cancelled: body.wasCancelled()
			}).toStrictEqual({ outcome, reads: 1, cancelled: true });
		}
	);
});

describe('verifyStoredNar', () => {
	beforeEach(resetTestServer);

	it('reads concatenated frames from R2 in 1 MiB chunks', async () => {
		const { nar, compressed } = multiFrameNar();
		const r2Key = r2ObjectKeySchema.parse('staging/verify-multi-frame-test');
		await env.BLOBS.put(r2Key, compressed);
		const progress = narVerifyProgress();

		const verification = await verifyStoredNar(
			env.BLOBS,
			r2Key,
			{ narHash: await nixNarHash(nar), narSize: nar.byteLength },
			{ buffers: new NarReadBufferPool(), progress }
		);

		expect({ verification, progress }).toStrictEqual({
			verification: {
				ok: true,
				fileHash: await nixNarHash(compressed),
				fileSize: compressed.byteLength
			},
			progress: {
				stage: 'decode',
				reads: 5,
				compressedBytes: compressed.byteLength,
				narBytes: nar.byteLength,
				ranges: 0,
				rangeBufferMisses: 0,
				rangeBudgetSkips: 0,
				lostRangeBuffers: 0,
				peakRangeBuffers: 0
			}
		});
	});

	// After the first 8 MiB block, the verifier reads ranges into pooled
	// buffers ahead of the decoder, so 10 MiB of padding is read by a
	// prefetched range.
	it.each([
		{ name: 'inside the first block', padding: mebibyte, ranges: 0 },
		{ name: 'in a prefetched range', padding: 10 * mebibyte, ranges: 1 }
	])(
		'verifies a stored object that ends with a skippable frame $name',
		async ({ padding, ranges }) => {
			const { nar, compressed } = multiFrameNar();
			const padded = concatenated([compressed, skippableFrame(padding)]);
			const r2Key = r2ObjectKeySchema.parse('staging/verify-padded-test');
			await env.BLOBS.put(r2Key, padded);
			const progress = narVerifyProgress();

			const verification = await verifyStoredNar(
				env.BLOBS,
				r2Key,
				{ narHash: await nixNarHash(nar), narSize: nar.byteLength },
				{ buffers: new NarReadBufferPool(), progress }
			);

			expect({ verification, ranges: progress.ranges }).toStrictEqual({
				verification: {
					ok: true,
					fileHash: await nixNarHash(padded),
					fileSize: padded.byteLength
				},
				ranges
			});
		}
	);

	it('times out and cancels a stalled R2 stream', async () => {
		const r2Key = r2ObjectKeySchema.parse('staging/verify-timeout-test');
		const { stream, wasCancelled } = neverProducingBody();
		const bucket = await bucketServing(r2Key, stream);
		let error: unknown;

		try {
			await verifyStoredNar(
				bucket,
				r2Key,
				{ narHash: 'sha256:invalid', narSize: 1000 },
				{ buffers: new NarReadBufferPool(), stallMs: 20 }
			);
		} catch (error_) {
			error = error_;
		}

		if (!(error instanceof SubrequestTimeoutError)) {
			throw new Error(
				`expected a SubrequestTimeoutError, received ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`
			);
		}

		expect({
			name: error.name,
			subrequest: error.subrequest,
			wasCancelled: wasCancelled()
		}).toStrictEqual({
			name: 'SubrequestTimeoutError',
			subrequest: 'nar.verify',
			wasCancelled: true
		});
	});

	it('keeps verifying while each read completes within the stall interval', async () => {
		const { nar, compressed } = multiFrameNar();
		const chunks = slices(compressed, mebibyte);
		const r2Key = r2ObjectKeySchema.parse('staging/verify-slow-test');
		const body = gatedBody(chunks);
		const bucket = await bucketServing(r2Key, body.stream, compressed);
		const testBase = new Date();
		const stallMs = 1000;
		vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });

		try {
			const verifying = verifyStoredNar(
				bucket,
				r2Key,
				{ narHash: await nixNarHash(nar), narSize: nar.byteLength },
				{ buffers: new NarReadBufferPool(), stallMs }
			);
			const settled = settle(verifying);

			// The last chunk is shorter than a read, so the read completes only when
			// the body closes. Each read waits for most of the stall interval, and
			// together they take several times longer than it.
			body.release(chunks.length);

			for (let index = 0; index < chunks.length; index += 1) {
				await Promise.race([body.requested(index), settled]);
				await vi.advanceTimersByTimeAsync(stallMs * 0.75);
				body.release(index);
			}

			expect(await settled).toStrictEqual({
				value: {
					ok: true,
					fileHash: await nixNarHash(compressed),
					fileSize: compressed.byteLength
				}
			});
		} finally {
			vi.useRealTimers();
			vi.useFakeTimers({ toFake: ['Date'] });
			vi.setSystemTime(testBase);
		}
	});

	it('cancels the body and rejects with the abort reason when the outer signal aborts', async () => {
		const { nar, compressed } = multiFrameNar();
		const r2Key = r2ObjectKeySchema.parse('staging/verify-abort-test');
		const body = gatedBody(slices(compressed, mebibyte));
		const bucket = await bucketServing(r2Key, body.stream, compressed);
		const controller = new AbortController();
		const reason = new SubrequestTimeoutError('nar.verify.batch');

		const verifying = verifyStoredNar(
			bucket,
			r2Key,
			{ narHash: await nixNarHash(nar), narSize: nar.byteLength },
			{ buffers: new NarReadBufferPool(), signal: controller.signal }
		);
		const settled = settle(verifying);
		await body.requested(0);
		body.release(0);
		await body.requested(1);
		controller.abort(reason);
		const outcome = await settled;

		expect({ outcome, cancelled: body.wasCancelled() }).toStrictEqual({
			outcome: { error: reason },
			cancelled: true
		});
	});

	it('cancels a body returned after its R2 get deadline', async () => {
		const r2Key = r2ObjectKeySchema.parse('staging/verify-get-timeout-test');
		await env.BLOBS.put(r2Key, new Uint8Array([1, 2, 3]));
		const real = await env.BLOBS.get(r2Key);

		if (real === null) {
			throw new Error('expected the staged object to exist');
		}

		const { stream, wasCancelled, cancelled } = neverProducingBody();
		const { promise, resolve } = Promise.withResolvers<R2ObjectBody | null>();
		const bucket = deferredGetBucket(env.BLOBS, r2Key, promise);

		await expect(
			verifyStoredNar(
				bucket,
				r2Key,
				{ narHash: 'sha256:invalid', narSize: 1000 },
				{ buffers: new NarReadBufferPool(), stallMs: 20 }
			)
		).rejects.toBeInstanceOf(SubrequestTimeoutError);

		resolve(withStalledBody(real, stream));
		await cancelled;

		expect(wasCancelled()).toBe(true);
	});
});

interface CompressedNar {
	readonly compressed: Uint8Array;
	readonly expected: { readonly narHash: string; readonly narSize: number };
}

/**
 * The compressed NAR from the vitest config: about 21 MiB of concatenated zstd
 * frames, which the default 8 MiB buffer size divides into three blocks.
 */
function compressedNar(): CompressedNar {
	const { narSha256, narSize } = env.TEST_COMPRESSED_NAR;

	return {
		compressed: new Uint8Array(env.TEST_COMPRESSED_NAR_BYTES),
		expected: {
			narHash: NixSha256Hash.fromDigest(hexToBytes(narSha256)).toString(),
			narSize
		}
	};
}

type GetResult = R2ObjectBody | R2Object | null;

/**
 * Handles one get of the object under test. `offset` is the start of a ranged
 * get, or `undefined` for a get of the whole object. `get` performs the real
 * get.
 */
type PartHandler = (
	offset: number | undefined,
	get: () => Promise<GetResult>
) => Promise<GetResult>;

function rangeOffset(options?: R2GetOptions): number | undefined {
	const range = options?.range;

	if (range === undefined || range instanceof Headers || !('offset' in range)) {
		return undefined;
	}

	return range.offset;
}

function bucketWithParts(
	r2Key: string,
	handle: PartHandler,
	bucket: R2Bucket = env.BLOBS
): R2Bucket {
	return new Proxy(bucket, {
		get(target, property) {
			if (property === 'get') {
				return (key: string, options?: R2GetOptions) => {
					const get = (): Promise<GetResult> => target.get(key, options);

					return key === r2Key ? handle(rangeOffset(options), get) : get();
				};
			}

			const value: unknown = Reflect.get(target, property, target);

			if (typeof value !== 'function') {
				return value;
			}

			const bound: unknown = value.bind(target);

			return bound;
		}
	});
}

/**
 * Performs the real get, keeps the returned object's metadata, and replaces
 * its body with `body`.
 */
async function servedPart(
	get: () => Promise<GetResult>,
	body: ReadableStream<Uint8Array>
): Promise<R2ObjectBody> {
	const real = await get();

	if (real === null || !('body' in real)) {
		throw new Error('expected the stored object to have a body');
	}

	await real.body.cancel();

	return withStalledBody(real, body);
}

/**
 * Serves `bytes` in 1 MiB chunks and errors the stream as soon as it has
 * enqueued the last chunk.
 */
function erroringBody(
	bytes: Uint8Array,
	error: Error
): { readonly stream: ReadableStream<Uint8Array> } {
	let offset = 0;
	const stream = new ReadableStream({
		type: 'bytes',
		pull(controller) {
			const chunk = bytes.subarray(offset, offset + mebibyte);
			offset += chunk.byteLength;
			controller.enqueue(new Uint8Array(chunk));

			if (offset >= bytes.byteLength) {
				controller.error(error);
			}
		}
	});

	return { stream };
}

/**
 * Deferreds keyed by a number, created on first use.
 */
class Deferreds {
	private readonly entries = new Map<number, PromiseWithResolvers<undefined>>();

	of(key: number): PromiseWithResolvers<undefined> {
		const existing = this.entries.get(key);

		if (existing !== undefined) {
			return existing;
		}

		const created = Promise.withResolvers<undefined>();
		this.entries.set(key, created);

		return created;
	}
}

/**
 * Leases every free buffer and returns their sizes. A detached buffer has a
 * size of 0.
 */
function leasedBufferSizes(buffers: NarReadBufferPool): number[] {
	const leases = Array.from({ length: buffers.state.free }, () =>
		buffers.tryAcquire()
	);
	const sizes = leases.map((lease) => lease?.buffer.byteLength ?? 0);

	for (const lease of leases) {
		lease?.release();
	}

	return sizes;
}

function outcomeOf(
	settled: Awaited<ReturnType<typeof settle<NarVerification>>>
): unknown {
	if ('error' in settled) {
		return settled.error;
	}

	return settled.value.ok ? 'ok' : settled.value.reason;
}

function inconsistency(outcome: unknown): {
	readonly name: string;
	readonly offset: number;
	readonly reason: string;
} {
	if (!(outcome instanceof StoredObjectInconsistentError)) {
		throw new TypeError('expected a StoredObjectInconsistentError', {
			cause: outcome
		});
	}

	return {
		name: outcome.name,
		offset: outcome.offset,
		reason: outcome.reason
	};
}

function totals(
	progresses: readonly NarVerifyProgress[]
): Pick<
	NarVerifyProgress,
	'ranges' | 'rangeBufferMisses' | 'rangeBudgetSkips' | 'lostRangeBuffers'
> {
	const sum = (
		field:
			'ranges' | 'rangeBufferMisses' | 'rangeBudgetSkips' | 'lostRangeBuffers'
	): number =>
		progresses.reduce((total, progress) => total + progress[field], 0);

	return {
		ranges: sum('ranges'),
		rangeBufferMisses: sum('rangeBufferMisses'),
		rangeBudgetSkips: sum('rangeBudgetSkips'),
		lostRangeBuffers: sum('lostRangeBuffers')
	};
}

const noStallTimer: ReadWatch = {
	signal: new AbortController().signal,
	restart: () => {
		// These tests drive the source directly and need no stall timer.
	},
	stop: () => {
		// These tests drive the source directly and need no stall timer.
	}
};

describe('verifyStoredNar with ranged reads', () => {
	beforeEach(resetTestServer);

	it('delivers ranges in order when they complete out of order', async () => {
		const { compressed, expected } = compressedNar();
		const r2Key = r2ObjectKeySchema.parse('staging/verify-range-order-test');
		await env.BLOBS.put(r2Key, compressed);
		const buffers = new NarReadBufferPool();
		const rangeSize = buffers.bufferSize;
		const requested = new Deferreds();
		const released = new Deferreds();
		const filled = new Deferreds();
		const bucket = bucketWithParts(r2Key, async (offset, get) => {
			if (offset === undefined) {
				return get();
			}

			requested.of(offset).resolve(undefined);
			await released.of(offset).promise;
			const body = byteBody([compressed.subarray(offset, offset + rangeSize)]);
			// The source cancels a range's body once it has read the whole range.
			void body.cancelled.then(() => {
				filled.of(offset).resolve(undefined);
			});

			return servedPart(get, body.stream);
		});
		const progress = narVerifyProgress();

		const settled = settle(
			verifyStoredNar(bucket, r2Key, expected, { buffers, progress })
		);
		await requested.of(rangeSize).promise;
		await requested.of(2 * rangeSize).promise;
		released.of(2 * rangeSize).resolve(undefined);
		await filled.of(2 * rangeSize).promise;
		released.of(rangeSize).resolve(undefined);

		expect({
			outcome: await settled,
			progress,
			pool: buffers.state
		}).toStrictEqual({
			outcome: {
				value: {
					ok: true,
					fileHash: await nixNarHash(compressed),
					fileSize: compressed.byteLength
				}
			},
			progress: {
				stage: 'decode',
				reads: Math.ceil(compressed.byteLength / mebibyte),
				compressedBytes: compressed.byteLength,
				narBytes: expected.narSize,
				ranges: 2,
				rangeBufferMisses: 0,
				rangeBudgetSkips: 0,
				lostRangeBuffers: 0,
				peakRangeBuffers: 2
			},
			pool: { free: 4, allocations: 2 }
		});
	});

	it('reads sequentially while the pool has no free buffer', async () => {
		const { compressed, expected } = compressedNar();
		const r2Key = r2ObjectKeySchema.parse('staging/verify-range-exhausted');
		await env.BLOBS.put(r2Key, compressed);
		const buffers = new NarReadBufferPool({ buffers: 1 });
		const otherVerification = buffers.tryAcquire();
		const progress = narVerifyProgress();

		const verification = await verifyStoredNar(env.BLOBS, r2Key, expected, {
			buffers,
			progress
		});
		otherVerification?.release();

		expect({ verification, progress, pool: buffers.state }).toStrictEqual({
			verification: {
				ok: true,
				fileHash: await nixNarHash(compressed),
				fileSize: compressed.byteLength
			},
			progress: {
				stage: 'decode',
				reads: Math.ceil(compressed.byteLength / mebibyte),
				compressedBytes: compressed.byteLength,
				narBytes: expected.narSize,
				ranges: 0,
				// The two blocks after the first each found the pool empty.
				rangeBufferMisses: 2,
				rangeBudgetSkips: 0,
				lostRangeBuffers: 0,
				peakRangeBuffers: 0
			},
			pool: { free: 1, allocations: 1 }
		});
	});

	it('reuses one pooled buffer for several ranges of several reads each', async () => {
		const { compressed, expected } = compressedNar();
		const r2Key = r2ObjectKeySchema.parse('staging/verify-range-reuse');
		await env.BLOBS.put(r2Key, compressed);
		const buffers = new NarReadBufferPool({
			buffers: 1,
			bufferSize: 3 * mebibyte
		});
		const progress = narVerifyProgress();

		const verification = await verifyStoredNar(env.BLOBS, r2Key, expected, {
			buffers,
			progress
		});

		// Each range fills the buffer with three reads. While the buffer is in
		// use, the block after each range finds the pool empty and the head reads
		// it, so ranges start at 3, 9, 15 and 21 MiB. The pool allocated the
		// buffer once, so every later range reused it.
		expect({
			verification,
			progress,
			pool: buffers.state,
			bufferSizes: leasedBufferSizes(buffers)
		}).toStrictEqual({
			verification: {
				ok: true,
				fileHash: await nixNarHash(compressed),
				fileSize: compressed.byteLength
			},
			progress: {
				stage: 'decode',
				reads: Math.ceil(compressed.byteLength / mebibyte),
				compressedBytes: compressed.byteLength,
				narBytes: expected.narSize,
				ranges: 4,
				rangeBufferMisses: 6,
				rangeBudgetSkips: 0,
				lostRangeBuffers: 0,
				peakRangeBuffers: 1
			},
			pool: { free: 1, allocations: 1 },
			bufferSizes: [3 * mebibyte]
		});
	});

	// After the first get, a range needs one get of its own and one held back
	// for the head that reads on after it.
	it.each([
		{ subrequests: 1, ranges: 0, rangeBudgetSkips: 2 },
		{ subrequests: 2, ranges: 0, rangeBudgetSkips: 2 },
		{ subrequests: 3, ranges: 1, rangeBudgetSkips: 1 }
	])(
		'starts $ranges ranges in a slice of $subrequests subrequests',
		async ({ subrequests, ranges, rangeBudgetSkips }) => {
			const { compressed, expected } = compressedNar();
			const r2Key = r2ObjectKeySchema.parse('staging/verify-range-budget');
			await env.BLOBS.put(r2Key, compressed);
			const buffers = new NarReadBufferPool();
			const progress = narVerifyProgress();

			const verification = await withSubrequestSlice(
				() =>
					verifyStoredNar(boundedBlobs(env.BLOBS), r2Key, expected, {
						buffers,
						progress
					}),
				{ subrequests, reserve: 0 }
			);

			expect({ verification, progress, pool: buffers.state }).toStrictEqual({
				verification: {
					ok: true,
					fileHash: await nixNarHash(compressed),
					fileSize: compressed.byteLength
				},
				progress: {
					stage: 'decode',
					reads: Math.ceil(compressed.byteLength / mebibyte),
					compressedBytes: compressed.byteLength,
					narBytes: expected.narSize,
					ranges,
					rangeBufferMisses: 0,
					rangeBudgetSkips,
					lostRangeBuffers: 0,
					peakRangeBuffers: ranges
				},
				pool: { free: 4, allocations: ranges }
			});
		}
	);

	it('keeps the head get of each concurrent verification back from the other', async () => {
		const { compressed, expected } = compressedNar();
		const keys = ['staging/verify-budget-a', 'staging/verify-budget-b'].map(
			(key) => r2ObjectKeySchema.parse(key)
		);
		await Promise.all(keys.map((key) => env.BLOBS.put(key, compressed)));
		const progresses = keys.map(() => narVerifyProgress());
		const fileHash = await nixNarHash(compressed);

		// Both first gets leave three subrequests. The first verification to
		// start a range sets one of them aside for its head, so the other cannot
		// also start one and then need a head get that the slice cannot afford.
		const verifications = await withSubrequestSlice(
			() =>
				Promise.all(
					keys.map((key, index) =>
						verifyStoredNar(boundedBlobs(env.BLOBS), key, expected, {
							buffers: new NarReadBufferPool({ buffers: 1 }),
							progress: progresses[index]
						})
					)
				),
			{ subrequests: 5, reserve: 0 }
		);

		expect({ verifications, totals: totals(progresses) }).toStrictEqual({
			verifications: keys.map(() => ({
				ok: true,
				fileHash,
				fileSize: compressed.byteLength
			})),
			totals: {
				ranges: 1,
				rangeBufferMisses: 1,
				rangeBudgetSkips: 2,
				lostRangeBuffers: 0
			}
		});
	});

	it('releases a first get that the pass set aside when the verification makes it', async () => {
		const { compressed, expected } = compressedNar();
		const keys = ['staging/verify-first-a', 'staging/verify-first-b'].map(
			(key) => r2ObjectKeySchema.parse(key)
		);
		await Promise.all(keys.map((key) => env.BLOBS.put(key, compressed)));
		const progresses = keys.map(() => narVerifyProgress());

		// The pass sets both first gets aside before it starts. The first
		// verification releases its own first get, so it can afford one range,
		// and the second verification's first get is still covered afterwards.
		const verifications = await withSubrequestSlice(
			async () => {
				const firstGets = keys.map(() => holdSubrequests(1));
				const results: NarVerification[] = [];

				for (const [index, key] of keys.entries()) {
					results.push(
						await verifyStoredNar(boundedBlobs(env.BLOBS), key, expected, {
							buffers: new NarReadBufferPool(),
							firstGet: firstGets[index],
							progress: progresses[index]
						})
					);
				}

				return results;
			},
			{ subrequests: 4, reserve: 0 }
		);

		expect({
			outcomes: verifications.map((verification) => verification.ok),
			progresses: progresses.map(({ ranges, rangeBudgetSkips }) => ({
				ranges,
				rangeBudgetSkips
			}))
		}).toStrictEqual({
			outcomes: [true, true],
			progresses: [
				{ ranges: 1, rangeBudgetSkips: 1 },
				{ ranges: 0, rangeBudgetSkips: 2 }
			]
		});
	});

	it('completes two verifications that share one buffer', async () => {
		const { compressed, expected } = compressedNar();
		const keys = ['staging/verify-shared-a', 'staging/verify-shared-b'].map(
			(key) => r2ObjectKeySchema.parse(key)
		);
		await Promise.all(keys.map((key) => env.BLOBS.put(key, compressed)));
		const buffers = new NarReadBufferPool({
			buffers: 1,
			bufferSize: 2 * mebibyte
		});
		const progresses = keys.map(() => narVerifyProgress());
		const fileHash = await nixNarHash(compressed);

		const verifications = await Promise.all(
			keys.map((key, index) =>
				verifyStoredNar(env.BLOBS, key, expected, {
					buffers,
					progress: progresses[index]
				})
			)
		);
		const { ranges, lostRangeBuffers } = totals(progresses);

		expect({
			verifications,
			hasRanges: ranges > 0,
			lostRangeBuffers,
			pool: buffers.state
		}).toStrictEqual({
			verifications: keys.map(() => ({
				ok: true,
				fileHash,
				fileSize: compressed.byteLength
			})),
			hasRanges: true,
			lostRangeBuffers: 0,
			pool: { free: 1, allocations: 1 }
		});
	});

	it.each([
		{ part: 'a range', change: 'replaced', at: 8, reason: 'etag-changed' },
		{ part: 'a range', change: 'deleted', at: 8, reason: 'deleted' },
		{
			part: 'a reopened head',
			change: 'replaced',
			at: 16,
			reason: 'etag-changed'
		},
		{ part: 'a reopened head', change: 'deleted', at: 16, reason: 'deleted' }
	])(
		'fails with StoredObjectInconsistentError when the object is $change before $part',
		async ({ change, at, reason }) => {
			const { compressed, expected } = compressedNar();
			const r2Key = r2ObjectKeySchema.parse('staging/verify-range-changed');
			await env.BLOBS.put(r2Key, compressed);
			// With one buffer, the source gets a range at 8 MiB and reopens the
			// head at 16 MiB.
			const buffers = new NarReadBufferPool({ buffers: 1 });
			const bucket = bucketWithParts(r2Key, async (offset, get) => {
				if (offset === undefined) {
					return servedPart(get, byteBody([compressed]).stream);
				}

				if (offset === at * mebibyte) {
					await (change === 'deleted'
						? env.BLOBS.delete(r2Key)
						: env.BLOBS.put(r2Key, compressed.subarray(1)));
				}

				return get();
			});
			const progress = narVerifyProgress();

			const outcome = outcomeOf(
				await settle(
					verifyStoredNar(bucket, r2Key, expected, { buffers, progress })
				)
			);

			expect({
				error: inconsistency(outcome),
				lostRangeBuffers: progress.lostRangeBuffers,
				pool: buffers.state
			}).toStrictEqual({
				error: {
					name: 'StoredObjectInconsistentError',
					offset: at * mebibyte,
					reason
				},
				lostRangeBuffers: 0,
				pool: { free: 1, allocations: 1 }
			});
		}
	);

	it.each([
		{ part: 'the head', ends: 5, offset: 5 },
		{ part: 'a range', ends: 11, offset: 11 }
	])(
		'fails with StoredObjectInconsistentError when $part ends early',
		async ({ part, ends, offset }) => {
			const { compressed, expected } = compressedNar();
			const r2Key = r2ObjectKeySchema.parse('staging/verify-range-truncated');
			await env.BLOBS.put(r2Key, compressed);
			const buffers = new NarReadBufferPool();
			const rangeSize = buffers.bufferSize;
			const bucket = bucketWithParts(r2Key, async (start, get) => {
				const from = start ?? 0;
				const to =
					start === undefined ? compressed.byteLength : from + rangeSize;
				const isTruncated =
					start === (part === 'the head' ? undefined : rangeSize);
				const end = isTruncated ? ends * mebibyte : to;

				return servedPart(
					get,
					byteBody([compressed.subarray(from, end)]).stream
				);
			});
			const progress = narVerifyProgress();

			const outcome = outcomeOf(
				await settle(
					verifyStoredNar(bucket, r2Key, expected, { buffers, progress })
				)
			);

			expect({
				error: inconsistency(outcome),
				lostRangeBuffers: progress.lostRangeBuffers,
				bufferSizes: leasedBufferSizes(buffers),
				pool: buffers.state
			}).toStrictEqual({
				error: {
					name: 'StoredObjectInconsistentError',
					offset: offset * mebibyte,
					reason: 'truncated'
				},
				lostRangeBuffers: 0,
				bufferSizes: Array.from({ length: 4 }, () => rangeSize),
				pool: { free: 4, allocations: 4 }
			});
		}
	);

	it('ignores an error from a head that it no longer reads', async () => {
		const { compressed, expected } = compressedNar();
		const r2Key = r2ObjectKeySchema.parse('staging/verify-range-head-error');
		await env.BLOBS.put(r2Key, compressed);
		const buffers = new NarReadBufferPool();
		const bucket = bucketWithParts(r2Key, async (offset, get) => {
			if (offset !== undefined) {
				return get();
			}

			// The head errors once it has delivered the block before the first range.
			return servedPart(
				get,
				erroringBody(
					compressed.subarray(0, buffers.bufferSize),
					new TypeError('the head failed')
				).stream
			);
		});

		const verification = await verifyStoredNar(bucket, r2Key, expected, {
			buffers
		});

		expect(verification).toStrictEqual({
			ok: true,
			fileHash: await nixNarHash(compressed),
			fileSize: compressed.byteLength
		});
	});

	const rangeFailure = new TypeError('the ranged get failed');

	it.each([
		{ name: 'succeeds', fault: 'none', outcome: 'ok' },
		{
			name: 'finds a NAR hash mismatch',
			fault: 'nar-hash',
			outcome: 'nar-hash-mismatch'
		},
		{
			name: 'stops at the declared NAR size',
			fault: 'nar-size',
			outcome: 'nar-size-mismatch'
		},
		{
			name: 'cannot decode the object',
			fault: 'not-zstd',
			outcome: 'undecodable'
		},
		{ name: 'fails to read a range', fault: 'range', outcome: rangeFailure }
	])(
		'returns every buffer to the pool when verification $name',
		async ({ fault, outcome }) => {
			const { compressed, expected } = compressedNar();
			const r2Key = r2ObjectKeySchema.parse('staging/verify-range-exit');
			await env.BLOBS.put(
				r2Key,
				fault === 'not-zstd'
					? new Uint8Array(compressed.byteLength)
					: compressed
			);
			const buffers = new NarReadBufferPool({ bufferSize: 2 * mebibyte });
			const otherNarHash = await nixNarHash(new Uint8Array(1));
			const bucket = bucketWithParts(r2Key, async (offset, get) => {
				if (fault === 'range' && offset !== undefined) {
					throw rangeFailure;
				}

				return get();
			});
			const progress = narVerifyProgress();

			const settled = await settle(
				verifyStoredNar(
					bucket,
					r2Key,
					{
						narHash: fault === 'nar-hash' ? otherNarHash : expected.narHash,
						narSize: fault === 'nar-size' ? 3 * mebibyte : expected.narSize
					},
					{ buffers, progress }
				)
			);

			// Leasing every buffer again allocates a replacement for any buffer
			// that a cancelled read kept.
			expect({
				outcome: outcomeOf(settled),
				lostRangeBuffers: progress.lostRangeBuffers,
				bufferSizes: leasedBufferSizes(buffers),
				pool: buffers.state
			}).toStrictEqual({
				outcome,
				lostRangeBuffers: 0,
				bufferSizes: Array.from({ length: 4 }, () => 2 * mebibyte),
				pool: { free: 4, allocations: 4 }
			});
		}
	);

	it('times out a stalled range and returns its buffer', async () => {
		const { compressed, expected } = compressedNar();
		const r2Key = r2ObjectKeySchema.parse('staging/verify-range-stall');
		await env.BLOBS.put(r2Key, compressed);
		const buffers = new NarReadBufferPool();
		const rangeSize = buffers.bufferSize;
		const head = byteBody([compressed]);
		const stalled = neverProducingBody();
		const bucket = bucketWithParts(r2Key, async (offset, get) => {
			if (offset === undefined) {
				return servedPart(get, head.stream);
			}

			if (offset === rangeSize) {
				return servedPart(get, stalled.stream);
			}

			return servedPart(
				get,
				byteBody([compressed.subarray(offset, offset + rangeSize)]).stream
			);
		});
		const progress = narVerifyProgress();
		const stallMs = 1000;
		const testBase = new Date();
		vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });

		try {
			const settled = settle(
				verifyStoredNar(bucket, r2Key, expected, {
					buffers,
					stallMs,
					progress
				})
			);
			// The source cancels the head when it reaches the first range. From then
			// on the verifier waits only for the stalled range. The other range can
			// still restart the stall interval while it finishes, so advance the
			// clock more than once.
			await head.cancelled;

			for (let attempt = 0; attempt < 3; attempt += 1) {
				await vi.advanceTimersByTimeAsync(stallMs);
			}

			const outcome = outcomeOf(await settled);

			if (!(outcome instanceof SubrequestTimeoutError)) {
				throw new TypeError('expected a SubrequestTimeoutError', {
					cause: outcome
				});
			}

			// How many NAR bytes the decoder produced from the first block depends
			// on where its frames end, so the assertion checks only that it decoded.
			const { narBytes, ...counts } = progress;

			expect({
				subrequest: outcome.subrequest,
				hasDecoded: narBytes > 0,
				counts,
				stalledCancelled: stalled.wasCancelled(),
				pool: buffers.state,
				bufferSizes: leasedBufferSizes(buffers)
			}).toStrictEqual({
				subrequest: 'nar.verify',
				hasDecoded: true,
				counts: {
					stage: 'read',
					reads: rangeSize / mebibyte,
					compressedBytes: rangeSize,
					ranges: 2,
					rangeBufferMisses: 0,
					rangeBudgetSkips: 0,
					// Cancelling the stalled read returned its buffer.
					lostRangeBuffers: 0,
					peakRangeBuffers: 2
				},
				stalledCancelled: true,
				pool: { free: 4, allocations: 2 },
				bufferSizes: Array.from({ length: 4 }, () => rangeSize)
			});
		} finally {
			vi.useRealTimers();
			vi.useFakeTimers({ toFake: ['Date'] });
			vi.setSystemTime(testBase);
		}
	});

	it('counts a buffer that a failed read kept, and the pool replaces it', async () => {
		const { compressed, expected } = compressedNar();
		const r2Key = r2ObjectKeySchema.parse('staging/verify-range-lost');
		await env.BLOBS.put(r2Key, compressed);
		const buffers = new NarReadBufferPool();
		const failure = new TypeError('the range body failed');
		// The body errors while the range's first read is waiting for bytes. The
		// read rejects and does not return the buffer that it was given.
		const failing = new ReadableStream({
			type: 'bytes',
			pull(controller) {
				controller.error(failure);
			}
		});
		const bucket = bucketWithParts(r2Key, async (offset, get) =>
			offset === buffers.bufferSize ? servedPart(get, failing) : get()
		);
		const progress = narVerifyProgress();

		const outcome = outcomeOf(
			await settle(
				verifyStoredNar(bucket, r2Key, expected, { buffers, progress })
			)
		);
		const pool = buffers.state;

		expect({
			outcome,
			lostRangeBuffers: progress.lostRangeBuffers,
			pool,
			bufferSizes: leasedBufferSizes(buffers),
			poolAfterLeasing: buffers.state
		}).toStrictEqual({
			outcome: failure,
			lostRangeBuffers: 1,
			pool: { free: 4, allocations: 2 },
			bufferSizes: Array.from({ length: 4 }, () => buffers.bufferSize),
			// One idle buffer and three new ones, one of them in place of the lost
			// buffer.
			poolAfterLeasing: { free: 4, allocations: 5 }
		});
	});

	it('cancels its ranges and returns their buffers when the outer signal aborts', async () => {
		const { compressed, expected } = compressedNar();
		const r2Key = r2ObjectKeySchema.parse('staging/verify-range-abort');
		await env.BLOBS.put(r2Key, compressed);
		const buffers = new NarReadBufferPool();
		const rangeSize = buffers.bufferSize;
		const requested = new Deferreds();
		const released = Promise.withResolvers<undefined>();
		const bucket = bucketWithParts(r2Key, async (offset, get) => {
			if (offset !== undefined) {
				requested.of(offset).resolve(undefined);
				await released.promise;
			}

			return get();
		});
		const controller = new AbortController();
		const reason = new SubrequestTimeoutError('nar.verify.batch');
		const progress = narVerifyProgress();

		const settled = settle(
			verifyStoredNar(bucket, r2Key, expected, {
				buffers,
				signal: controller.signal,
				progress
			})
		);
		await requested.of(rangeSize).promise;
		await requested.of(2 * rangeSize).promise;
		controller.abort(reason);
		const outcome = await settled;
		released.resolve(undefined);

		expect({
			outcome,
			ranges: progress.ranges,
			lostRangeBuffers: progress.lostRangeBuffers,
			pool: buffers.state
		}).toStrictEqual({
			outcome: { error: reason },
			ranges: 2,
			lostRangeBuffers: 0,
			pool: { free: 4, allocations: 2 }
		});
	});
});

describe('openStoredNarChunks', () => {
	beforeEach(resetTestServer);

	it('cancels a head that a get returns after the source has closed', async () => {
		const { compressed } = compressedNar();
		const r2Key = r2ObjectKeySchema.parse('staging/chunks-late-head');
		await env.BLOBS.put(r2Key, compressed);
		// With one 2 MiB buffer, the source reads a range at 2 MiB and then
		// reopens the head at 4 MiB.
		const reopenAt = 4 * mebibyte;
		const buffers = new NarReadBufferPool({
			buffers: 1,
			bufferSize: 2 * mebibyte
		});
		const reopened = byteBody([compressed.subarray(reopenAt)]);
		const opened: { source?: NarChunkSource } = {};
		let closing: Promise<void> | undefined;
		const bucket = bucketWithParts(r2Key, async (offset, get) => {
			if (offset !== reopenAt) {
				return get();
			}

			const part = await servedPart(get, reopened.stream);

			// Close the source between the get and the moment that the source
			// starts to use the returned body.
			return new Proxy(part, {
				get(target, property) {
					if (property === 'body') {
						closing ??= opened.source?.close();
					}

					const value: unknown = Reflect.get(target, property, target);

					return value;
				}
			});
		});
		const source = await openStoredNarChunks(bucket, r2Key, {
			buffers,
			watch: noStallTimer,
			progress: narVerifyProgress()
		});
		opened.source = source;
		let failure: unknown;

		try {
			for (;;) {
				const chunk = await source.read();

				if (chunk === undefined) {
					break;
				}

				chunk.release();
			}
		} catch (error) {
			failure = error;
		}

		await closing;

		expect({
			failed: failure !== undefined,
			reopenedCancelled: reopened.wasCancelled(),
			pool: buffers.state
		}).toStrictEqual({
			failed: true,
			reopenedCancelled: true,
			pool: { free: 1, allocations: 1 }
		});
	});
});
