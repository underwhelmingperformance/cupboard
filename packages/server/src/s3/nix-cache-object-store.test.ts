import {
	nixSha256HashSchema,
	storePathHashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import {
	NonCacheWriteError,
	NoSuchBucketError,
	NoSuchKeyError,
	RequestNotSignedError
} from '@cupboard/s3/errors';
import type {
	ListObjectsResult,
	ObjectStat,
	PutObjectMeta
} from '@cupboard/s3/ports';
import { describe, expect, it, type Mock, vi } from 'vitest';

import type { BlobStore } from './blob-store.ts';
import {
	createNixCacheObjectStore,
	type NixCacheBackend,
	type RenderedCacheInfo
} from './nix-cache-object-store.ts';

const tenant = tenantIdSchema.parse('acme');
const storePathHash = storePathHashSchema.parse(
	'00000000000000000000000000000000'
);
const narHash = nixSha256HashSchema.parse(`sha256:${'0'.repeat(52)}`);
const fileHash = nixSha256HashSchema.parse(`sha256:${'1'.repeat(52)}`);

const lastModified = new Date('2026-01-01T00:00:00.000Z');
const anyMeta: PutObjectMeta = {
	contentType: undefined,
	contentLength: undefined,
	checksumSha256: undefined
};
const emptyBytes = new Uint8Array();

function utf8(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

function statOf(bytes: Uint8Array): ObjectStat {
	return { size: bytes.length, etag: 'etag', lastModified };
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		}
	});
}

function rejectUnexpected(): Promise<never> {
	return Promise.reject(new Error('not expected in this test'));
}

function fakeBlobStore(objects: Map<string, Uint8Array>): BlobStore {
	return {
		head: (key) => {
			const bytes = objects.get(key);
			return Promise.resolve(bytes === undefined ? undefined : statOf(bytes));
		},
		get: (key) => {
			const bytes = objects.get(key);
			return Promise.resolve(
				bytes === undefined
					? undefined
					: { stat: statOf(bytes), body: streamOf(bytes) }
			);
		},
		put: rejectUnexpected,
		delete: () => Promise.resolve(),
		createMultipartUpload: rejectUnexpected,
		uploadPart: rejectUnexpected,
		completeMultipartUpload: rejectUnexpected,
		abortMultipartUpload: rejectUnexpected
	};
}

function fakeBackend(
	overrides: Partial<NixCacheBackend> = {}
): NixCacheBackend {
	return {
		authoriseRead: () => Promise.resolve(),
		authoriseWrite: () => Promise.resolve(),
		cacheInfo: () => Promise.resolve(undefined),
		list: () =>
			Promise.resolve({
				objects: [],
				commonPrefixes: [],
				isTruncated: false,
				nextContinuationToken: undefined
			}),
		resolveServableNar: (_cache, hash) => Promise.resolve(hash),
		stageNar: () => Promise.resolve({ etag: 'staged' }),
		beginNarUpload: () => Promise.resolve({ uploadId: 'up' }),
		uploadNarPart: () => Promise.resolve({ partNumber: 1, etag: 'p1' }),
		completeNarUpload: () => Promise.resolve({ etag: 'done' }),
		abortNarUpload: () => Promise.resolve(),
		commitNarinfo: () => Promise.resolve({ etag: 'committed' }),
		remove: () => Promise.resolve(),
		...overrides
	};
}

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
	return new Response(stream).text();
}

function present<T>(value: T | undefined): T {
	if (value === undefined) {
		throw new Error('expected a result');
	}
	return value;
}

describe('createNixCacheObjectStore reads', () => {
	it('delegates a narinfo read to its tenant-namespaced key', async () => {
		const objects = new Map([
			[`t/acme/narinfo/${storePathHash}`, utf8('narinfo')]
		]);
		const store = createNixCacheObjectStore(
			tenant,
			fakeBlobStore(objects),
			fakeBackend()
		);

		const result = present(
			await store.get(
				{
					bucket: tenant,
					key: `${storePathHash}.narinfo`,
					principal: undefined
				},
				undefined
			)
		);
		expect(await readText(result.body)).toBe('narinfo');
	});

	it('delegates a NAR read to the shared content-addressed key', async () => {
		const objects = new Map([[`nar/${narHash}.nar.zst`, utf8('narbytes')]]);
		const store = createNixCacheObjectStore(
			tenant,
			fakeBlobStore(objects),
			fakeBackend()
		);

		const result = present(
			await store.get(
				{ bucket: tenant, key: `nar/${narHash}.nar.zst`, principal: undefined },
				undefined
			)
		);
		expect(await readText(result.body)).toBe('narbytes');
	});

	it('resolves a NAR within the cache selected by the object key', async () => {
		const resolveServableNar: Mock = vi.fn(() => Promise.resolve(narHash));
		const objects = new Map([[`nar/${narHash}.nar.zst`, utf8('narbytes')]]);
		const store = createNixCacheObjectStore(
			tenant,
			fakeBlobStore(objects),
			fakeBackend({ resolveServableNar })
		);

		await store.get(
			{
				bucket: tenant,
				key: `builds/nar/${narHash}.nar.zst`,
				principal: undefined
			},
			undefined
		);

		expect(resolveServableNar).toHaveBeenCalledWith('builds', narHash);
	});

	it('renders nix-cache-info from the backend', async () => {
		const info: RenderedCacheInfo = {
			body: utf8('StoreDir: /nix/store\n'),
			etag: 'cacheinfo-etag',
			lastModified
		};
		const store = createNixCacheObjectStore(
			tenant,
			fakeBlobStore(new Map()),
			fakeBackend({ cacheInfo: () => Promise.resolve(info) })
		);

		const result = present(
			await store.get(
				{ bucket: tenant, key: 'nix-cache-info', principal: undefined },
				undefined
			)
		);
		expect(result.stat.etag).toBe('cacheinfo-etag');
		expect(await readText(result.body)).toBe('StoreDir: /nix/store\n');
	});

	it('resolves a named cache from the key prefix', async () => {
		const objects = new Map([
			[`t/acme/narinfo/builds/${storePathHash}`, utf8('scoped')]
		]);
		const authoriseRead: Mock = vi.fn(() => Promise.resolve());
		const store = createNixCacheObjectStore(
			tenant,
			fakeBlobStore(objects),
			fakeBackend({ authoriseRead })
		);

		const result = present(
			await store.get(
				{
					bucket: tenant,
					key: `builds/${storePathHash}.narinfo`,
					principal: undefined
				},
				undefined
			)
		);
		expect(await readText(result.body)).toBe('scoped');
		expect(authoriseRead).toHaveBeenCalledWith('builds', undefined);
	});

	it('throws NoSuchKeyError for a missing object and a non-cache key', async () => {
		const store = createNixCacheObjectStore(
			tenant,
			fakeBlobStore(new Map()),
			fakeBackend()
		);

		await expect(
			store.get(
				{
					bucket: tenant,
					key: `${storePathHash}.narinfo`,
					principal: undefined
				},
				undefined
			)
		).rejects.toThrow(NoSuchKeyError);

		await expect(
			store.get(
				{ bucket: tenant, key: 'random.txt', principal: undefined },
				undefined
			)
		).rejects.toThrow(NoSuchKeyError);
	});

	it('throws NoSuchKeyError for a NAR the tenant does not reference', async () => {
		const objects = new Map([[`nar/${narHash}.nar.zst`, utf8('narbytes')]]);
		const store = createNixCacheObjectStore(
			tenant,
			fakeBlobStore(objects),
			fakeBackend({ resolveServableNar: () => Promise.resolve(undefined) })
		);

		await expect(
			store.get(
				{ bucket: tenant, key: `nar/${narHash}.nar.zst`, principal: undefined },
				undefined
			)
		).rejects.toThrow(NoSuchKeyError);
	});

	it('resolves a NAR addressed by its file hash to the canonical object', async () => {
		const objects = new Map([[`nar/${narHash}.nar.zst`, utf8('narbytes')]]);
		const store = createNixCacheObjectStore(
			tenant,
			fakeBlobStore(objects),
			fakeBackend({ resolveServableNar: () => Promise.resolve(narHash) })
		);

		const result = present(
			await store.get(
				{
					bucket: tenant,
					key: `nar/${fileHash}.nar.zst`,
					principal: undefined
				},
				undefined
			)
		);
		expect(await readText(result.body)).toBe('narbytes');
	});

	it('rejects a request for the wrong bucket', async () => {
		const store = createNixCacheObjectStore(
			tenant,
			fakeBlobStore(new Map()),
			fakeBackend()
		);

		await expect(
			store.get(
				{ bucket: 'someone-else', key: 'nix-cache-info', principal: undefined },
				undefined
			)
		).rejects.toThrow(NoSuchBucketError);
	});
});

describe('createNixCacheObjectStore writes', () => {
	it('stages a NAR put by its file hash', async () => {
		const stageNar: Mock = vi.fn(() => Promise.resolve({ etag: 'staged' }));
		const store = createNixCacheObjectStore(
			tenant,
			fakeBlobStore(new Map()),
			fakeBackend({ stageNar })
		);

		const result = await store.put(
			{ bucket: tenant, key: `nar/${fileHash}.nar.zst`, principal: undefined },
			streamOf(emptyBytes),
			anyMeta
		);
		expect(result.etag).toBe('staged');
		expect(stageNar).toHaveBeenCalledWith(
			'',
			fileHash,
			expect.anything(),
			anyMeta
		);
	});

	it('commits a narinfo put through the pipeline', async () => {
		const commitNarinfo: Mock = vi.fn(() =>
			Promise.resolve({ etag: 'committed' })
		);
		const store = createNixCacheObjectStore(
			tenant,
			fakeBlobStore(new Map()),
			fakeBackend({ commitNarinfo })
		);

		const result = await store.put(
			{
				bucket: tenant,
				key: `${storePathHash}.narinfo`,
				principal: undefined
			},
			streamOf(emptyBytes),
			anyMeta
		);
		expect(result.etag).toBe('committed');
		expect(commitNarinfo).toHaveBeenCalledWith(
			'',
			storePathHash,
			expect.anything(),
			anyMeta,
			undefined
		);
	});

	it('refuses to write nix-cache-info', async () => {
		const store = createNixCacheObjectStore(
			tenant,
			fakeBlobStore(new Map()),
			fakeBackend()
		);

		await expect(
			store.put(
				{ bucket: tenant, key: 'nix-cache-info', principal: undefined },
				streamOf(emptyBytes),
				anyMeta
			)
		).rejects.toThrow(NonCacheWriteError);
	});

	it('propagates an authorisation denial', async () => {
		const store = createNixCacheObjectStore(
			tenant,
			fakeBlobStore(new Map()),
			fakeBackend({
				authoriseWrite: () => Promise.reject(new RequestNotSignedError())
			})
		);

		await expect(
			store.put(
				{
					bucket: tenant,
					key: `nar/${fileHash}.nar.zst`,
					principal: undefined
				},
				streamOf(emptyBytes),
				anyMeta
			)
		).rejects.toThrow(RequestNotSignedError);
	});
});

describe('createNixCacheObjectStore multipart', () => {
	const narKey = `nar/${fileHash}.nar.zst`;
	const narContext = { bucket: tenant, key: narKey, principal: undefined };

	it('delegates the multipart lifecycle for a NAR key', async () => {
		const beginNarUpload: Mock = vi.fn(() =>
			Promise.resolve({ uploadId: 'up' })
		);
		const uploadNarPart: Mock = vi.fn(() =>
			Promise.resolve({ partNumber: 1, etag: 'p1' })
		);
		const completeNarUpload: Mock = vi.fn(() =>
			Promise.resolve({ etag: 'done' })
		);
		const abortNarUpload: Mock = vi.fn(() => Promise.resolve());
		const store = createNixCacheObjectStore(
			tenant,
			fakeBlobStore(new Map()),
			fakeBackend({
				beginNarUpload,
				uploadNarPart,
				completeNarUpload,
				abortNarUpload
			})
		);

		await store.createMultipartUpload(narContext, anyMeta);
		await store.uploadPart(
			narContext,
			'up',
			1,
			undefined,
			streamOf(emptyBytes)
		);
		await store.completeMultipartUpload(narContext, 'up', [
			{ partNumber: 1, etag: 'p1' }
		]);
		await store.abortMultipartUpload(narContext, 'up');

		expect(beginNarUpload).toHaveBeenCalledWith('', fileHash, anyMeta);
		expect(uploadNarPart).toHaveBeenCalledWith(
			'',
			fileHash,
			'up',
			1,
			undefined,
			expect.anything()
		);
		expect(completeNarUpload).toHaveBeenCalledWith('', fileHash, 'up', [
			{ partNumber: 1, etag: 'p1' }
		]);
		expect(abortNarUpload).toHaveBeenCalledWith('', fileHash, 'up');
	});

	it.each([
		'createMultipartUpload',
		'uploadPart',
		'completeMultipartUpload',
		'abortMultipartUpload'
	] as const)('enforces write authorisation on %s', async (operation) => {
		const store = createNixCacheObjectStore(
			tenant,
			fakeBlobStore(new Map()),
			fakeBackend({
				authoriseWrite: () => Promise.reject(new RequestNotSignedError())
			})
		);

		const invoke = {
			createMultipartUpload: () =>
				store.createMultipartUpload(narContext, anyMeta),
			uploadPart: () =>
				store.uploadPart(narContext, 'up', 1, undefined, streamOf(emptyBytes)),
			completeMultipartUpload: () =>
				store.completeMultipartUpload(narContext, 'up', []),
			abortMultipartUpload: () => store.abortMultipartUpload(narContext, 'up')
		}[operation];

		await expect(invoke()).rejects.toThrow(RequestNotSignedError);
	});

	it('refuses multipart on a narinfo key', async () => {
		const store = createNixCacheObjectStore(
			tenant,
			fakeBlobStore(new Map()),
			fakeBackend()
		);
		const narinfoContext = {
			bucket: tenant,
			key: `${storePathHash}.narinfo`,
			principal: undefined
		};

		await expect(
			store.uploadPart(narinfoContext, 'up', 1, undefined, streamOf(emptyBytes))
		).rejects.toThrow(NonCacheWriteError);
	});
});

describe('createNixCacheObjectStore list', () => {
	it('scopes returned keys under the resolved cache', async () => {
		const listing: ListObjectsResult = {
			objects: [
				{ key: `${storePathHash}.narinfo`, size: 1, etag: 'e', lastModified }
			],
			commonPrefixes: ['nar/'],
			isTruncated: true,
			nextContinuationToken: `${storePathHash}.narinfo`
		};
		const list: Mock = vi.fn(() => Promise.resolve(listing));
		const store = createNixCacheObjectStore(
			tenant,
			fakeBlobStore(new Map()),
			fakeBackend({ list })
		);

		const result = await store.list(
			tenant,
			{
				prefix: 'builds/',
				delimiter: '/',
				continuationToken: 'builds/previous',
				maxKeys: 1000
			},
			undefined
		);
		expect(result.objects.map((object) => object.key)).toStrictEqual([
			`builds/${storePathHash}.narinfo`
		]);
		expect(result.commonPrefixes).toStrictEqual(['builds/nar/']);
		expect(result.nextContinuationToken).toBe(
			`builds/${storePathHash}.narinfo`
		);
		expect(list).toHaveBeenCalledWith('builds', {
			prefix: '',
			delimiter: '/',
			continuationToken: 'previous',
			maxKeys: 1000
		});
	});
});

describe('createNixCacheObjectStore bucket operations', () => {
	it('reports the tenant bucket to an admitted anonymous request', async () => {
		const store = createNixCacheObjectStore(
			tenant,
			fakeBlobStore(new Map()),
			fakeBackend()
		);

		expect(await store.bucketExists(tenant, undefined)).toBe(true);
	});

	it('reports one tenant bucket for a credential scoped to any prefix', async () => {
		const store = createNixCacheObjectStore(
			tenant,
			fakeBlobStore(new Map()),
			fakeBackend()
		);

		expect(
			await store.bucketExists(tenant, {
				tenant,
				cache: 'builds',
				grants: []
			})
		).toBe(true);
	});

	it('does not report another tenant as a bucket', async () => {
		const store = createNixCacheObjectStore(
			tenant,
			fakeBlobStore(new Map()),
			fakeBackend()
		);

		expect(await store.bucketExists('someone-else', undefined)).toBe(false);
	});
});
