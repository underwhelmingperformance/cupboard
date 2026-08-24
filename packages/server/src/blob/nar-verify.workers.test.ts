import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { zstdCompressionStream } from '@cupboard/nix-store/zstd';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { SubrequestTimeoutError } from '../errors.ts';
import { r2ObjectKeySchema } from '../http/http.ts';
import { resetTestServer } from '../test-support.ts';

import { verifyDecompressedNar, verifyStoredNar } from './nar-verify.ts';

async function nixNarHash(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));

	return NixSha256Hash.fromDigest(digest).toString();
}

function compressedStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
	const source = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		}
	});

	return source.pipeThrough(zstdCompressionStream());
}

function neverProducingBody(): {
	readonly stream: ReadableStream<Uint8Array>;
	readonly wasCancelled: () => boolean;
} {
	let wasCancelled = false;

	const stream = new ReadableStream<Uint8Array>({
		pull() {
			return new Promise(() => {
				// Keep this promise pending until the verification deadline cancels it.
			});
		},
		cancel() {
			wasCancelled = true;
		}
	});

	return { stream, wasCancelled: () => wasCancelled };
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

async function compressedBytes(bytes: Uint8Array): Promise<Uint8Array> {
	return new Uint8Array(
		await new Response(compressedStream(bytes)).arrayBuffer()
	);
}

describe('verifyDecompressedNar', () => {
	// Keep the payload large enough to cross the bridge in several chunks. The
	// runtime benchmark covers bounded memory with multi-hundred-megabyte NARs.
	const encoder = new TextEncoder();
	const nar = encoder.encode('nar payload '.repeat(250_000));

	it('accepts a blob and reports the compressed file hash and size', async () => {
		const narHash = await nixNarHash(nar);
		const compressed = await compressedBytes(nar);

		const result = await verifyDecompressedNar(compressedStream(nar), {
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

		const result = await verifyDecompressedNar(compressedStream(nar), {
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

		const result = await verifyDecompressedNar(compressedStream(nar), {
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
		const result = await verifyDecompressedNar(compressedStream(nar), {
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
});

describe('verifyStoredNar', () => {
	beforeEach(resetTestServer);

	it('times out and cancels a stalled R2 stream', async () => {
		const r2Key = r2ObjectKeySchema.parse('staging/verify-timeout-test');
		await env.BLOBS.put(r2Key, new Uint8Array([1, 2, 3]));
		const real = await env.BLOBS.get(r2Key);

		if (real === null) {
			throw new Error('expected the staged object to exist');
		}

		const { stream, wasCancelled } = neverProducingBody();
		const bucket = stubbedGetBucket(
			env.BLOBS,
			r2Key,
			withStalledBody(real, stream)
		);
		let error: unknown;

		try {
			await verifyStoredNar(
				bucket,
				r2Key,
				{ narHash: 'sha256:invalid', narSize: 1000 },
				20
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

	it('cancels a body returned after its R2 get deadline', async () => {
		const r2Key = r2ObjectKeySchema.parse('staging/verify-get-timeout-test');
		await env.BLOBS.put(r2Key, new Uint8Array([1, 2, 3]));
		const real = await env.BLOBS.get(r2Key);

		if (real === null) {
			throw new Error('expected the staged object to exist');
		}

		const { stream, wasCancelled } = neverProducingBody();
		const { promise, resolve } = Promise.withResolvers<R2ObjectBody | null>();
		const bucket = deferredGetBucket(env.BLOBS, r2Key, promise);

		await expect(
			verifyStoredNar(
				bucket,
				r2Key,
				{ narHash: 'sha256:invalid', narSize: 1000 },
				20
			)
		).rejects.toBeInstanceOf(SubrequestTimeoutError);

		resolve(withStalledBody(real, stream));
		await new Promise((resolveTick) => setTimeout(resolveTick, 0));

		expect(wasCancelled()).toBe(true);
	});
});
