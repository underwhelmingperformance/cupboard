import {
	InternalError,
	InvalidPartError,
	NoSuchUploadError
} from '@cupboard/s3/errors';
import type { GetObjectResult } from '@cupboard/s3/ports';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { BlobSha256MismatchError, createR2BlobStore } from './blob-store.ts';

const store = createR2BlobStore(env.BLOBS);

class TestR2Error extends Error implements R2Error {
	readonly action = 'completeMultipartUpload';

	constructor(readonly code: number) {
		super('R2 operation failed.');
	}

	override get stack(): string {
		return super.stack ?? '';
	}
}

function failingMultipartBucket(code: number): R2Bucket {
	return new Proxy(env.BLOBS, {
		get(target, property) {
			if (property === 'resumeMultipartUpload') {
				return () => ({
					complete: () => Promise.reject(new TestR2Error(code))
				});
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

function streamOf(text: string): ReadableStream<Uint8Array> {
	// A `Response` body is a fixed-length stream, which R2's binding requires for
	// `put`/`uploadPart`; in production the body is the request stream, which
	// carries a content-length the same way. Workers types `Response.body` as
	// `ReadableStream<any>`, so narrow the element type the runtime guarantees.
	const body: ReadableStream<Uint8Array> | null = new Response(
		new TextEncoder().encode(text)
	).body as ReadableStream<Uint8Array> | null;
	if (body === null) {
		throw new Error('unreachable: response body is never null here');
	}
	return body;
}

function bodyText(result: GetObjectResult | undefined): Promise<string> {
	if (result === undefined) {
		throw new Error('expected the object to exist');
	}
	return new Response(result.body).text();
}

const emptyMeta = {
	contentType: undefined,
	contentLength: undefined,
	checksumSha256: undefined
};

describe('createR2BlobStore', () => {
	it('puts an object and reports R2 metadata on head and get', async () => {
		const put = await store.put('blob/full', streamOf('hello cupboard'), {
			contentType: 'text/plain',
			contentLength: 14,
			checksumSha256: undefined
		});
		expect(put.etag).toMatch(/^[0-9a-f]{32}$/);

		const head = await store.head('blob/full');
		expect(head).toMatchObject({
			size: 14,
			etag: put.etag,
			contentType: 'text/plain'
		});
		expect(head?.lastModified).toBeInstanceOf(Date);

		const got = await store.get('blob/full', undefined);
		expect(got?.range).toBeUndefined();
		expect(await bodyText(got)).toBe('hello cupboard');
	});

	it('reports a SHA-256 mismatch with a typed error', async () => {
		const body = 'different bytes';

		await expect(
			store.put(
				'blob/bad-digest',
				streamOf(body),
				{ ...emptyMeta, contentLength: body.length },
				'0'.repeat(64)
			)
		).rejects.toThrow(BlobSha256MismatchError);
	});

	it('keeps the existing object when a replacement fails its SHA-256 check', async () => {
		const key = 'blob/rejected-replacement';
		const original = 'existing bytes';
		const replacement = 'different bytes';
		await store.put(key, streamOf(original), {
			...emptyMeta,
			contentLength: original.length
		});

		await expect(
			store.put(
				key,
				streamOf(replacement),
				{ ...emptyMeta, contentLength: replacement.length },
				'0'.repeat(64)
			)
		).rejects.toThrow(BlobSha256MismatchError);

		expect(await bodyText(await store.get(key, undefined))).toBe(original);
	});

	it('preserves another R2 failure after hashing the body', async () => {
		const body = 'checked body';
		let rejection: unknown;

		try {
			await store.put(
				'x'.repeat(1025),
				streamOf(body),
				{ ...emptyMeta, contentLength: body.length },
				'5d8566b5e43a2b04be16da9e666470e3766483cb4ed9e41e561d21eba05a818f'
			);
		} catch (error) {
			rejection = error;
		}

		expect(rejection).toBeInstanceOf(Error);
		expect(rejection).not.toBeInstanceOf(BlobSha256MismatchError);
	});

	it('satisfies offset and suffix ranges', async () => {
		await store.put('blob/ranged', streamOf('0123456789'), {
			contentType: undefined,
			contentLength: 10,
			checksumSha256: undefined
		});

		const offset = await store.get('blob/ranged', { offset: 2, length: 3 });
		expect(offset?.range).toStrictEqual({ start: 2, end: 4 });
		expect(await bodyText(offset)).toBe('234');

		const suffix = await store.get('blob/ranged', { suffix: 4 });
		expect(suffix?.range).toStrictEqual({ start: 6, end: 9 });
		expect(await bodyText(suffix)).toBe('6789');
	});

	it('returns undefined for a missing object and after deletion', async () => {
		expect(await store.head('blob/absent')).toBeUndefined();
		expect(await store.get('blob/absent', undefined)).toBeUndefined();

		await store.put('blob/temp', streamOf('x'), {
			contentType: undefined,
			contentLength: 1,
			checksumSha256: undefined
		});
		await store.delete('blob/temp');
		expect(await store.head('blob/temp')).toBeUndefined();
	});

	it('assembles a multipart upload', async () => {
		const upload = await store.createMultipartUpload('blob/multi', emptyMeta);
		const part = await store.uploadPart(
			'blob/multi',
			upload.uploadId,
			1,
			'single-part-body'.length,
			streamOf('single-part-body')
		);
		const completed = await store.completeMultipartUpload(
			'blob/multi',
			upload.uploadId,
			[part]
		);
		expect(completed.etag).toMatch(/^[0-9a-f]/);

		expect(await bodyText(await store.get('blob/multi', undefined))).toBe(
			'single-part-body'
		);
	});

	it('aborts a multipart upload', async () => {
		const upload = await store.createMultipartUpload('blob/aborted', emptyMeta);
		await store.uploadPart(
			'blob/aborted',
			upload.uploadId,
			1,
			'discarded'.length,
			streamOf('discarded')
		);
		await store.abortMultipartUpload('blob/aborted', upload.uploadId);
		expect(await store.head('blob/aborted')).toBeUndefined();
	});

	it.each([
		{ code: 10_024, error: NoSuchUploadError },
		{ code: 10_025, error: InvalidPartError },
		{ code: 10_048, error: InvalidPartError },
		{ code: 10_999, error: InternalError }
	])(
		'maps R2 multipart error $code to $error.name',
		async ({ code, error }) => {
			const failing = createR2BlobStore(failingMultipartBucket(code));

			await expect(
				failing.completeMultipartUpload('blob/missing', 'upload', [])
			).rejects.toThrow(error);
		}
	);
});
