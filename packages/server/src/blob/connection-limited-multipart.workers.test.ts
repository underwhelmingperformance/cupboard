import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { boundedBlobs } from '../do/bounded-io.ts';
import {
	holdSubrequests,
	subrequestsAvailable,
	withSubrequestSlice
} from '../do/subrequest-slice.ts';
import { SubrequestSliceExceededError } from '../errors.ts';
import { r2ObjectKeySchema } from '../http/http.ts';
import { clearBlobStorage } from '../test-support.ts';

import { ConnectionLimitedBucket } from './connection-limited-bucket.ts';
import { ConnectionLimitedMultipartBucket } from './connection-limited-multipart.ts';
import { R2RequestAdmission } from './r2-request-admission.ts';

const source = r2ObjectKeySchema.parse('staging/admission-source');
const target = r2ObjectKeySchema.parse(
	'shared-artifact-staging/admission-target'
);
const bytes = new Uint8Array([1, 2, 3]);

async function flushMicrotasks(): Promise<void> {
	for (let turn = 0; turn < 20; turn += 1) {
		await Promise.resolve();
	}
}

describe('multipart admission shared with native R2 I/O', () => {
	beforeEach(clearBlobStorage);

	it('queues multipart allocation behind a native write and leaves a connection for its source read', async () => {
		await env.BLOBS.put(source, bytes);
		const admission = new R2RequestAdmission(2);
		const gate = Promise.withResolvers<undefined>();
		const raw = boundedBlobs(env.BLOBS);
		const native = new ConnectionLimitedBucket(
			{
				get: (key) => raw.get(key),
				put: async (key, body, options) => {
					await gate.promise;
					return raw.put(key, body, options);
				}
			},
			admission
		);
		const metadata = new ConnectionLimitedMultipartBucket(raw, admission);
		const create = vi.spyOn(env.BLOBS, 'createMultipartUpload');
		try {
			const stream = new FixedLengthStream(bytes.byteLength);
			const supply = async () => {
				const writer = stream.writable.getWriter();
				await writer.write(bytes);
				await writer.close();
			};
			const supplied = supply();
			const write = native.put(target, stream.readable, {});
			const upload = metadata.createMultipartUpload(target);
			await flushMicrotasks();
			const beforeRead = create.mock.calls.length;
			const read = await native.get(source);
			const readBytes =
				read === null ? undefined : new Uint8Array(await read.arrayBuffer());
			const afterRead = create.mock.calls.length;
			gate.resolve(undefined);
			await Promise.all([write, supplied]);
			const completed = await upload;
			await completed.abort();
			expect({
				beforeRead,
				afterRead,
				readBytes,
				creates: create.mock.calls.map(([key]) => key)
			}).toStrictEqual({
				beforeRead: 0,
				afterRead: 0,
				readBytes: bytes,
				creates: [target]
			});
		} finally {
			gate.resolve(undefined);
			create.mockRestore();
		}
	});

	it('accounts once for creation, parts, completion, metadata and native reads while resuming locally', async () => {
		const result = await withSubrequestSlice(
			async () => {
				const admission = new R2RequestAdmission(2);
				const raw = boundedBlobs(env.BLOBS);
				const metadata = new ConnectionLimitedMultipartBucket(raw, admission);
				const native = new ConnectionLimitedBucket(raw, admission);
				const upload = await metadata.createMultipartUpload(target);
				const part = await upload.uploadPart(1, bytes);
				const before = await metadata.head(target);
				await upload.complete([part]);
				const completed = await metadata.head(target);
				const beforeResume = subrequestsAvailable();
				const resumed = metadata.resumeMultipartUpload(target, upload.uploadId);
				const afterResume = subrequestsAvailable();
				const read = await native.get(target);
				return {
					isBeforePresent: before !== null,
					size: completed?.size,
					key: resumed.key,
					isSameUpload: resumed.uploadId === upload.uploadId,
					beforeResume,
					afterResume,
					readBytes:
						read === null
							? undefined
							: new Uint8Array(await read.arrayBuffer()),
					remaining: subrequestsAvailable()
				};
			},
			{ subrequests: 10, reserve: 0 }
		);
		expect(result).toStrictEqual({
			isBeforePresent: false,
			size: 3,
			key: target,
			isSameUpload: true,
			beforeResume: 5,
			afterResume: 5,
			readBytes: bytes,
			remaining: 4
		});
	});

	it('refuses producer work after cancellation but still permits multipart abort', async () => {
		const result = await withSubrequestSlice(
			async () => {
				const controller = new AbortController();
				const reason = new Error('capture cancelled');
				const metadata = new ConnectionLimitedMultipartBucket(
					boundedBlobs(env.BLOBS),
					new R2RequestAdmission(2),
					{ priority: 'optional', signal: controller.signal }
				);
				const upload = await metadata.createMultipartUpload(target);
				const part = await upload.uploadPart(1, bytes);
				controller.abort(reason);
				await expect(upload.uploadPart(2, bytes)).rejects.toBe(reason);
				await expect(upload.complete([part])).rejects.toBe(reason);
				await expect(metadata.head(target)).rejects.toBe(reason);
				await upload.abort();
				return { uploadId: upload.uploadId, remaining: subrequestsAvailable() };
			},
			{ subrequests: 8, reserve: 0 }
		);
		const raw = env.BLOBS.resumeMultipartUpload(target, result.uploadId);
		await expect(raw.uploadPart(2, bytes)).rejects.toThrow();
		expect({
			remaining: result.remaining,
			object: (await env.BLOBS.head(target)) ?? undefined
		}).toStrictEqual({ remaining: 5, object: undefined });
	});

	it('declines optional multipart allocation before R2 access when native calls are reserved', async () => {
		const create = vi.spyOn(env.BLOBS, 'createMultipartUpload');
		try {
			const result = await withSubrequestSlice(
				async () => {
					const native = holdSubrequests(2);
					const metadata = new ConnectionLimitedMultipartBucket(
						boundedBlobs(env.BLOBS),
						new R2RequestAdmission(2),
						{ priority: 'optional' }
					);
					await expect(
						metadata.createMultipartUpload(target)
					).rejects.toBeInstanceOf(SubrequestSliceExceededError);
					native.release();
					return {
						calls: create.mock.calls,
						remaining: subrequestsAvailable()
					};
				},
				{ subrequests: 2, reserve: 0 }
			);
			expect(result).toStrictEqual({ calls: [], remaining: 2 });
		} finally {
			create.mockRestore();
		}
	});
});
