import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	nixSha256HashSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import {
	MalformedNarInfoError,
	NarInfoMismatchError,
	NarInfoNotCommittableError,
	NarInfoTooLargeError,
	UploadDigestMismatchError,
	UploadOverQuotaError,
	UploadStillPendingError
} from '@cupboard/s3/errors';
import type {
	ObjectStat,
	PutObjectMeta,
	PutObjectResult
} from '@cupboard/s3/ports';
import { describe, expect, it, type Mock, vi } from 'vitest';

import { QuotaExceededError } from '../errors.ts';

import type { BlobStore } from './blob-store.ts';
import {
	type CommitOutcome,
	createNixCacheService,
	type NixCacheServiceDeps,
	type PendingUploadRow,
	type UploadSettlement
} from './nix-cache-service.ts';

const tenant = 'acme';
const storePathHash = storePathHashSchema.parse('0'.repeat(32));
const fileHashObject = NixSha256Hash.fromDigest(new Uint8Array(32).fill(1));
const narHashObject = NixSha256Hash.fromDigest(new Uint8Array(32).fill(2));
const fileHash = nixSha256HashSchema.parse(fileHashObject.toString());
const narHash = nixSha256HashSchema.parse(narHashObject.toString());
const issuedAt = new Date('2026-01-01T00:00:00.000Z');

const anyMeta: PutObjectMeta = {
	contentType: undefined,
	contentLength: undefined,
	checksumSha256: undefined
};

const narBody = new NarInfo(
	new StorePath(`/nix/store/${storePathHash}-name`),
	'nar/x.nar.zst',
	'zstd',
	fileHashObject,
	100,
	narHashObject,
	200,
	[]
).render();

function streamOf(text: string): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(text);
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

interface Harness {
	readonly deps: NixCacheServiceDeps;
	readonly puts: { key: string }[];
	readonly registered: PendingUploadRow[];
	readonly commit: Mock<(cache: string, id: string) => Promise<CommitOutcome>>;
	readonly settleUpload: Mock<(id: string) => Promise<UploadSettlement>>;
}

function harness(
	options: {
		commitOutcome?: CommitOutcome;
		settlement?: UploadSettlement;
		narinfoStat?: ObjectStat;
	} = {}
): Harness {
	const puts: { key: string }[] = [];
	const registered: PendingUploadRow[] = [];
	const commit: Mock<(cache: string, id: string) => Promise<CommitOutcome>> =
		vi.fn(() => Promise.resolve(options.commitOutcome ?? { kind: 'settled' }));
	const settleUpload: Mock<(id: string) => Promise<UploadSettlement>> = vi.fn(
		() => Promise.resolve(options.settlement ?? 'servable')
	);

	const blobStore: BlobStore = {
		head: () => Promise.resolve(options.narinfoStat),
		get: () => Promise.resolve(undefined),
		put: (key): Promise<PutObjectResult> => {
			puts.push({ key });
			return Promise.resolve({ etag: 'staged-etag' });
		},
		delete: () => Promise.resolve(),
		createMultipartUpload: () => Promise.resolve({ uploadId: 'mpu' }),
		uploadPart: rejectUnexpected,
		completeMultipartUpload: rejectUnexpected,
		abortMultipartUpload: rejectUnexpected
	};

	const deps: NixCacheServiceDeps = {
		tenant,
		blobStore,
		pipeline: {
			registerPending: (row) => {
				registered.push(row);
			},
			commit,
			settleUpload
		},
		caches: {
			find: (cache) =>
				Promise.resolve(
					cache === ''
						? { priority: 40, createdAt: '2026-01-01T00:00:00.000Z' }
						: undefined
				)
		},
		authorizer: {
			read: () => Promise.resolve(),
			write: () => Promise.resolve()
		},
		listing: {
			list: () =>
				Promise.resolve({
					objects: [],
					commonPrefixes: [],
					isTruncated: false,
					nextContinuationToken: undefined
				})
		},
		remover: { remove: () => Promise.resolve() },
		nars: { resolveServableNar: (hash) => Promise.resolve(hash) },
		now: () => issuedAt,
		newId: () => 'upload-1'
	};

	return { deps, puts, registered, commit, settleUpload };
}

describe('createNixCacheService write path', () => {
	it('stages a NAR under its file-hash staging key', async () => {
		const { deps, puts } = harness();
		const service = createNixCacheService(deps);

		const result = await service.stageNar(fileHash, streamOf('zstd'), anyMeta);
		expect(result.etag).toBe('staged-etag');
		expect(puts).toStrictEqual([{ key: `staging/s3/${fileHash}.nar.zst` }]);
	});

	it('commits a narinfo and settles a deferred verification inline', async () => {
		const { deps, registered, commit, settleUpload } = harness({
			commitOutcome: { kind: 'deferred' },
			settlement: 'servable',
			narinfoStat: {
				size: 10,
				etag: 'narinfo-etag',
				lastModified: issuedAt
			}
		});
		const service = createNixCacheService(deps);

		const result = await service.commitNarinfo(
			'',
			storePathHash,
			streamOf(narBody),
			anyMeta,
			undefined
		);

		expect(result.etag).toBe('narinfo-etag');
		expect(commit).toHaveBeenCalledWith('', 'upload-1');
		expect(settleUpload).toHaveBeenCalledWith('upload-1');
		expect(registered).toHaveLength(1);
		expect(registered[0]).toMatchObject({
			id: 'upload-1',
			cache: '',
			narHash,
			r2Key: `staging/s3/${fileHash}.nar.zst`,
			expectedSize: 100
		});
		expect(JSON.parse(registered[0]?.metadataJson ?? '{}')).toMatchObject({
			storePathHash,
			narHash,
			fileHash,
			narSize: 200,
			fileSize: 100,
			compression: 'zstd'
		});
	});

	it('does not settle when the commit is already settled', async () => {
		const { deps, settleUpload } = harness({
			commitOutcome: { kind: 'settled' },
			narinfoStat: { size: 10, etag: 'narinfo-etag', lastModified: issuedAt }
		});
		const service = createNixCacheService(deps);

		await service.commitNarinfo(
			'',
			storePathHash,
			streamOf(narBody),
			anyMeta,
			undefined
		);
		expect(settleUpload).not.toHaveBeenCalled();
	});

	it('rejects a malformed narinfo body', async () => {
		const { deps } = harness();
		const service = createNixCacheService(deps);

		await expect(
			service.commitNarinfo(
				'',
				storePathHash,
				streamOf('not a narinfo'),
				anyMeta,
				undefined
			)
		).rejects.toThrow(MalformedNarInfoError);
	});

	it('rejects a narinfo whose store path does not match the key', async () => {
		const { deps } = harness();
		const service = createNixCacheService(deps);
		const otherHash = storePathHashSchema.parse('1'.repeat(32));

		await expect(
			service.commitNarinfo(
				'',
				otherHash,
				streamOf(narBody),
				anyMeta,
				undefined
			)
		).rejects.toThrow(NarInfoMismatchError);
	});

	it('rejects a narinfo body that exceeds the size cap', async () => {
		const { deps } = harness();
		const service = createNixCacheService(deps);
		const huge = 'X'.repeat(64 * 1024 + 1);

		await expect(
			service.commitNarinfo(
				'',
				storePathHash,
				streamOf(huge),
				anyMeta,
				undefined
			)
		).rejects.toThrow(NarInfoTooLargeError);
	});

	it('resolves a servable NAR through the resolver collaborator', async () => {
		const { deps } = harness();
		const service = createNixCacheService(deps);

		expect(await service.resolveServableNar(fileHash)).toBe(fileHash);
	});
});

describe('createNixCacheService settlement', () => {
	it.each([
		{ settlement: 'mismatch', error: UploadDigestMismatchError },
		{ settlement: 'over-quota', error: UploadOverQuotaError },
		{ settlement: 'pending', error: UploadStillPendingError },
		{ settlement: 'absent', error: NarInfoNotCommittableError }
	] as const)(
		'maps a $settlement verdict to its S3 error',
		async ({ settlement, error }) => {
			const { deps } = harness({
				commitOutcome: { kind: 'deferred' },
				settlement
			});
			const service = createNixCacheService(deps);

			await expect(
				service.commitNarinfo(
					'',
					storePathHash,
					streamOf(narBody),
					anyMeta,
					undefined
				)
			).rejects.toThrow(error);
		}
	);

	it('translates a quota error thrown by the commit pipeline', async () => {
		const { deps, commit } = harness();
		commit.mockImplementation(() =>
			Promise.reject(new QuotaExceededError('acme'))
		);
		const service = createNixCacheService(deps);

		await expect(
			service.commitNarinfo(
				'',
				storePathHash,
				streamOf(narBody),
				anyMeta,
				undefined
			)
		).rejects.toThrow(UploadOverQuotaError);
	});
});

describe('createNixCacheService cache info', () => {
	it('renders nix-cache-info from the cache record', async () => {
		const { deps } = harness();
		const service = createNixCacheService(deps);

		const info = await service.cacheInfo('');
		expect(new TextDecoder().decode(info?.body)).toContain('Priority: 40');
		expect(info?.etag).toMatch(/^[0-9a-f]{64}$/);
		expect(info?.lastModified).toStrictEqual(
			new Date('2026-01-01T00:00:00.000Z')
		);
	});

	it('reports cache existence', async () => {
		const { deps } = harness();
		const service = createNixCacheService(deps);

		expect(await service.cacheExists('')).toBe(true);
		expect(await service.cacheExists('missing')).toBe(false);
		expect(await service.cacheInfo('missing')).toBeUndefined();
	});
});
