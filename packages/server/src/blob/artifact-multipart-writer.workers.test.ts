import { sha256HexDigestSchema } from '@cupboard/nix-store/scalars';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import { sha256HexBytes } from '../crypto/crypto.ts';
import { SubrequestTimeoutError } from '../errors.ts';

import {
	ArtifactMultipartWriter,
	ArtifactOutputBuffer
} from './artifact-multipart-writer.ts';
import { ByteBufferPool } from './byte-buffers.ts';

const partBytes = 5 * 1024 * 1024;

async function fixture() {
	const key = `artifact-staging/writer-${crypto.randomUUID()}`;
	const upload = await env.BLOBS.createMultipartUpload(key);
	return { key, upload };
}

describe('bounded artifact multipart writer', () => {
	it('reserves output capacity before a multipart upload is created', () => {
		const pool = new ByteBufferPool({ buffers: 1, bufferSize: partBytes });
		const buffer = ArtifactOutputBuffer.tryAcquire(pool);
		if (buffer === undefined) {
			throw new Error('The output buffer was not reserved');
		}
		const occupied = ArtifactOutputBuffer.tryAcquire(pool);
		const before = pool.state;
		buffer.release();
		buffer.release();
		expect({ occupied, before, after: pool.state }).toStrictEqual({
			occupied: undefined,
			before: { free: 0, allocations: 1 },
			after: { free: 1, allocations: 1 }
		});
	});

	it('transfers buffer ownership without letting caller cleanup release an unfinished upload', async () => {
		const { upload } = await fixture();
		const pool = new ByteBufferPool({ buffers: 1, bufferSize: partBytes });
		const buffer = ArtifactOutputBuffer.tryAcquire(pool);
		if (buffer === undefined) {
			throw new Error('The output buffer was not reserved');
		}
		const pending = Promise.withResolvers<R2UploadedPart>();
		const parts = vi
			.spyOn(upload, 'uploadPart')
			.mockReturnValueOnce(pending.promise);
		const writer = new ArtifactMultipartWriter(upload, {
			kind: 'listing',
			buffer
		});
		const writing = writer.write(new Uint8Array(partBytes));
		const rejected = expect(writing).rejects.toThrow('cancelled');
		await vi.waitFor(() => {
			expect(parts).toHaveBeenCalledTimes(1);
		});
		buffer.release();
		await writer.abort(new Error('producer cancelled'));
		await rejected;
		expect(pool.state).toStrictEqual({ free: 0, allocations: 1 });
		pending.resolve({ partNumber: 1, etag: 'fixture' });
		await writer.settled();
		expect(pool.state).toStrictEqual({ free: 1, allocations: 1 });
		parts.mockRestore();
	});

	it('refuses reuse of a transferred output reservation', async () => {
		const { upload } = await fixture();
		const pool = new ByteBufferPool({ buffers: 1, bufferSize: partBytes });
		const buffer = ArtifactOutputBuffer.tryAcquire(pool);
		if (buffer === undefined) {
			throw new Error('The output buffer was not reserved');
		}
		const writer = new ArtifactMultipartWriter(upload, {
			kind: 'listing',
			buffer
		});
		expect(
			() => new ArtifactMultipartWriter(upload, { kind: 'listing', buffer })
		).toThrow('transferred or released');
		await writer.abort();
		expect(pool.state).toStrictEqual({ free: 1, allocations: 1 });
	});

	it('streams chunk boundaries into valid R2 parts and measures the exact bytes', async () => {
		const { key, upload } = await fixture();
		const pool = new ByteBufferPool({ buffers: 1, bufferSize: partBytes });
		const writer = new ArtifactMultipartWriter(upload, {
			kind: 'listing',
			pool
		});
		const bytes = Uint8Array.from(
			{ length: partBytes + 257 },
			(_, index) => index % 251
		);
		await writer.write(bytes.subarray(0, 17));
		await writer.write(bytes.subarray(17, partBytes + 13));
		await writer.write(bytes.subarray(partBytes + 13));
		const measurement = await writer.finish();
		const object = await env.BLOBS.get(key);
		if (object === null) {
			throw new Error('The completed fixture object is missing');
		}
		expect({
			measurement,
			body: new Uint8Array(await object.arrayBuffer()),
			pool: pool.state
		}).toStrictEqual({
			measurement: {
				digest: sha256HexDigestSchema.parse(await sha256HexBytes(bytes)),
				size: bytes.byteLength
			},
			body: bytes,
			pool: { free: 1, allocations: 1 }
		});
		await env.BLOBS.delete(key);
	});

	it('completes an empty log as an empty measured object', async () => {
		const { key, upload } = await fixture();
		const writer = new ArtifactMultipartWriter(upload, { kind: 'build-log' });
		const measurement = await writer.finish();
		const emptyBytes = new Uint8Array();
		const emptyDigest = sha256HexDigestSchema.parse(
			await sha256HexBytes(emptyBytes)
		);
		const object = await env.BLOBS.head(key);
		expect({ measurement, size: object?.size }).toStrictEqual({
			measurement: {
				digest: emptyDigest,
				size: 0
			},
			size: 0
		});
		await env.BLOBS.delete(key);
	});

	it('refuses bytes beyond the output budget before they can form a part', async () => {
		const { upload } = await fixture();
		const pool = new ByteBufferPool({ buffers: 1, bufferSize: partBytes });
		const writer = new ArtifactMultipartWriter(upload, {
			kind: 'listing-proof',
			maximumBytes: 4,
			pool
		});
		const parts = vi.spyOn(upload, 'uploadPart');
		await writer.write(new Uint8Array([1, 2, 3, 4]));
		await expect(writer.write(new Uint8Array([5]))).rejects.toThrow('exceeds');
		await writer.abort();
		expect({ parts: parts.mock.calls.length, pool: pool.state }).toStrictEqual({
			parts: 0,
			pool: { free: 1, allocations: 1 }
		});
	});

	it('checks the producer lease before every storage mutation', async () => {
		const { upload } = await fixture();
		const current = vi
			.fn<() => Promise<void>>()
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error('producer lease revoked'));
		const writer = new ArtifactMultipartWriter(upload, {
			kind: 'listing',
			assertCurrent: current
		});
		const complete = vi.spyOn(upload, 'complete');
		await writer.write(new Uint8Array(partBytes));
		await expect(writer.finish()).rejects.toThrow('producer lease revoked');
		await writer.abort();
		expect({
			checks: current.mock.calls.length,
			completions: complete.mock.calls.length
		}).toStrictEqual({ checks: 2, completions: 0 });
	});

	it('keeps a timed-out part buffer reserved until the abandoned write settles', async () => {
		const { upload } = await fixture();
		const pool = new ByteBufferPool({ buffers: 1, bufferSize: partBytes });
		const abandoned = Promise.withResolvers<undefined>();
		const parts = vi
			.spyOn(upload, 'uploadPart')
			.mockRejectedValueOnce(
				new SubrequestTimeoutError('r2.uploadPart', abandoned.promise)
			);
		const writer = new ArtifactMultipartWriter(upload, {
			kind: 'listing',
			pool
		});
		await expect(writer.write(new Uint8Array(partBytes))).rejects.toThrow(
			'timed out'
		);
		await writer.abort();
		expect(pool.state).toStrictEqual({ free: 0, allocations: 1 });
		abandoned.resolve(undefined);
		await writer.settled();
		expect(pool.state).toStrictEqual({ free: 1, allocations: 1 });
		parts.mockRestore();
	});

	it('rejects another writer when the shared upload buffer is occupied', async () => {
		const firstUpload = await fixture();
		const secondUpload = await fixture();
		const pool = new ByteBufferPool({ buffers: 1, bufferSize: partBytes });
		const first = new ArtifactMultipartWriter(firstUpload.upload, {
			kind: 'listing',
			pool
		});
		expect(
			() =>
				new ArtifactMultipartWriter(secondUpload.upload, {
					kind: 'listing',
					pool
				})
		).toThrow('buffers are busy');
		await first.abort();
		const second = new ArtifactMultipartWriter(secondUpload.upload, {
			kind: 'listing',
			pool
		});
		await second.abort();
		expect(pool.state).toStrictEqual({ free: 1, allocations: 1 });
	});

	it('cancels promptly without returning a buffer still used by an upload', async () => {
		const { upload } = await fixture();
		const pool = new ByteBufferPool({ buffers: 1, bufferSize: partBytes });
		const pending = Promise.withResolvers<R2UploadedPart>();
		const parts = vi
			.spyOn(upload, 'uploadPart')
			.mockReturnValueOnce(pending.promise);
		const writer = new ArtifactMultipartWriter(upload, {
			kind: 'listing',
			pool
		});
		const writing = writer.write(new Uint8Array(partBytes));
		const rejected = expect(writing).rejects.toThrow('cancelled');
		await vi.waitFor(() => {
			expect(parts).toHaveBeenCalledTimes(1);
		});
		await writer.abort(new Error('producer cancelled'));
		await rejected;
		expect(pool.state).toStrictEqual({ free: 0, allocations: 1 });
		pending.resolve({ partNumber: 1, etag: 'fixture' });
		await writer.settled();
		expect(pool.state).toStrictEqual({ free: 1, allocations: 1 });
		parts.mockRestore();
	});

	it('rejects concurrent writes while an upload is reading the part buffer', async () => {
		const { upload } = await fixture();
		const pending = Promise.withResolvers<R2UploadedPart>();
		const parts = vi
			.spyOn(upload, 'uploadPart')
			.mockReturnValueOnce(pending.promise);
		const writer = new ArtifactMultipartWriter(upload, { kind: 'listing' });
		const first = writer.write(new Uint8Array(partBytes));
		await vi.waitFor(() => {
			expect(parts).toHaveBeenCalledTimes(1);
		});
		await expect(writer.write(new Uint8Array([7]))).rejects.toThrow('busy');
		pending.resolve({ partNumber: 1, etag: 'fixture' });
		await first;
		await writer.abort();
		parts.mockRestore();
	});
});
