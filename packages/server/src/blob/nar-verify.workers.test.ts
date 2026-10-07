import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { zstdCompressionStream } from '@cupboard/nix-store/zstd';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { SubrequestTimeoutError } from '../errors.ts';
import { r2ObjectKeySchema } from '../http/http.ts';
import { resetTestServer } from '../test-support.ts';

import {
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
 * Stores a three-byte placeholder at `r2Key` and returns a bucket whose `get`
 * returns that object's metadata with `body` as its body.
 */
async function bucketServing(
	r2Key: string,
	body: ReadableStream<Uint8Array>
): Promise<R2Bucket> {
	await env.BLOBS.put(r2Key, new Uint8Array([1, 2, 3]));
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
			{ progress }
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
				narBytes: nar.byteLength
			}
		});
	});

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
				{ stallMs: 20 }
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
		const bucket = await bucketServing(r2Key, body.stream);
		const testBase = new Date();
		const stallMs = 1000;
		vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });

		try {
			const verifying = verifyStoredNar(
				bucket,
				r2Key,
				{ narHash: await nixNarHash(nar), narSize: nar.byteLength },
				{ stallMs }
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
		const bucket = await bucketServing(r2Key, body.stream);
		const controller = new AbortController();
		const reason = new SubrequestTimeoutError('nar.verify.batch');

		const verifying = verifyStoredNar(
			bucket,
			r2Key,
			{ narHash: await nixNarHash(nar), narSize: nar.byteLength },
			{ signal: controller.signal }
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
				{ stallMs: 20 }
			)
		).rejects.toBeInstanceOf(SubrequestTimeoutError);

		resolve(withStalledBody(real, stream));
		await cancelled;

		expect(wasCancelled()).toBe(true);
	});
});
