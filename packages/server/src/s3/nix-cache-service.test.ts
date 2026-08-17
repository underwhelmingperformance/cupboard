import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	cacheNameSchema,
	cachePrioritySchema,
	nixSha256HashSchema,
	storePathHashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { uploadIdSchema } from '@cupboard/protocol/upload';
import {
	MalformedNarInfoError,
	MultipartUploadAlreadyCompletingError,
	NarChecksumMismatchError,
	NarInfoMismatchError,
	NarInfoNotCommittableError,
	NarInfoTooLargeError,
	NoSuchUploadError,
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

import { BlobSha256MismatchError, type BlobStore } from './blob-store.ts';
import {
	type CommitOutcome,
	createNixCacheService,
	type IngestPipeline,
	type NixCacheServiceDependencies,
	type PendingUploadRow,
	type UploadSettlement
} from './nix-cache-service.ts';
import { multipartCompletionLeaseMs } from './staging-accounting.ts';

const tenant = tenantIdSchema.parse('acme');
const missingCache = cacheNameSchema.parse('missing');
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
	readonly dependencies: NixCacheServiceDependencies;
	readonly puts: { key: string }[];
	readonly deletes: string[];
	readonly registered: PendingUploadRow[];
	readonly commit: Mock<IngestPipeline['commit']>;
	readonly settleUpload: Mock<IngestPipeline['settleUpload']>;
	readonly completeMultipartUpload: Mock<BlobStore['completeMultipartUpload']>;
	readonly abortMultipartUpload: Mock<BlobStore['abortMultipartUpload']>;
	readonly renewMultipartCompletion: Mock;
	readonly stagingEvents: unknown[];
}

function harness(
	options: {
		commitOutcome?: CommitOutcome;
		settlement?: UploadSettlement;
		narinfoStat?: ObjectStat;
		putError?: Error;
		stagedStatAfterPutFailure?: ObjectStat;
		stagedHeadError?: Error;
		multipartBytes?: Uint8Array;
		completeAccountingFailures?: number;
		completeMultipartError?: Error;
		completeMultipartWait?: Promise<void>;
		completionInProgressAfterFirst?: boolean;
		abortMultipartError?: Error;
		reusableNarHash?: typeof narHash;
		protectsStagedObject?: boolean;
	} = {}
): Harness {
	const puts: { key: string }[] = [];
	const deletes: string[] = [];
	const registered: PendingUploadRow[] = [];
	const stagingEvents: unknown[] = [];
	const commit: Mock<IngestPipeline['commit']> = vi.fn(() =>
		Promise.resolve(options.commitOutcome ?? { kind: 'settled' })
	);
	const settleUpload: Mock<IngestPipeline['settleUpload']> = vi.fn(() =>
		Promise.resolve(options.settlement ?? 'servable')
	);
	const completeMultipartUpload: Mock<BlobStore['completeMultipartUpload']> =
		vi.fn(async () => {
			await options.completeMultipartWait;
			if (options.completeMultipartError !== undefined) {
				throw options.completeMultipartError;
			}

			return { etag: 'multipart-etag' };
		});
	const abortMultipartUpload: Mock<BlobStore['abortMultipartUpload']> = vi.fn(
		() =>
			options.abortMultipartError === undefined
				? Promise.resolve()
				: Promise.reject(options.abortMultipartError)
	);
	const renewMultipartCompletion = vi.fn(() => Promise.resolve());
	let completionPreparations = 0;
	let completeAccountingFailures = options.completeAccountingFailures ?? 0;

	const blobStore: BlobStore = {
		head: (key) => {
			if (
				key.startsWith('staging/s3/') &&
				options.stagedHeadError !== undefined
			) {
				return Promise.reject(options.stagedHeadError);
			}

			return Promise.resolve(
				key.startsWith('staging/s3/')
					? options.stagedStatAfterPutFailure
					: options.narinfoStat
			);
		},
		get: () =>
			Promise.resolve(
				options.multipartBytes === undefined
					? undefined
					: {
							stat: {
								size: options.multipartBytes.byteLength,
								etag: 'multipart-etag',
								lastModified: issuedAt
							},
							body: streamOfBytes(options.multipartBytes)
						}
			),
		put: (key): Promise<PutObjectResult> => {
			puts.push({ key });
			if (options.putError !== undefined) {
				return Promise.reject(options.putError);
			}

			return Promise.resolve({ etag: 'staged-etag' });
		},
		delete: (key) => {
			deletes.push(key);
			return Promise.resolve();
		},
		createMultipartUpload: () => Promise.resolve({ uploadId: 'mpu' }),
		uploadPart: rejectUnexpected,
		completeMultipartUpload,
		abortMultipartUpload
	};

	const dependencies: NixCacheServiceDependencies = {
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
						? {
								priority: cachePrioritySchema.parse(40),
								createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z')
							}
						: undefined
				)
		},
		authoriser: {
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
		nars: {
			resolveServableNar: (_cache, hash) =>
				Promise.resolve(options.reusableNarHash ?? hash)
		},
		stagingAccounting: {
			reserveStagedObject: (...arguments_) => {
				stagingEvents.push(['reserve', ...arguments_]);
				return Promise.resolve();
			},
			settleStagedObject: (...arguments_) => {
				stagingEvents.push(['settle', ...arguments_]);
				return Promise.resolve();
			},
			protectStagedObject: (...arguments_) => {
				stagingEvents.push(['protect', ...arguments_]);
				return Promise.resolve(options.protectsStagedObject ?? true);
			},
			releaseStagedObject: (...arguments_) => {
				stagingEvents.push(['release', ...arguments_]);
				return Promise.resolve();
			},
			beginMultipart: () => Promise.resolve(),
			reserveMultipartPart: () => rejectUnexpected(),
			recordMultipartPart: () => Promise.resolve(),
			prepareMultipartCompletion: () => {
				if (
					completionPreparations > 0 &&
					options.completionInProgressAfterFirst === true
				) {
					return Promise.reject(new MultipartUploadAlreadyCompletingError());
				}

				completionPreparations += 1;
				return Promise.resolve({
					kind: completionPreparations === 1 ? 'started' : 'recovering',
					size: options.multipartBytes?.byteLength ?? 0,
					token: `completion-${String(completionPreparations)}`
				});
			},
			renewMultipartCompletion,
			reopenMultipart: () => Promise.resolve(),
			markMultipartRecovering: () => Promise.resolve(),
			markMultipartAborting: () => Promise.resolve(true),
			completeMultipart: () => {
				if (completeAccountingFailures > 0) {
					completeAccountingFailures -= 1;
					return Promise.reject(new Error('D1 finalisation failed'));
				}

				return Promise.resolve();
			},
			releaseMultipart: () => Promise.resolve()
		},
		now: () => issuedAt,
		newId: () => uploadIdSchema.parse('upload-1')
	};

	return {
		dependencies,
		puts,
		deletes,
		registered,
		commit,
		settleUpload,
		completeMultipartUpload,
		abortMultipartUpload,
		renewMultipartCompletion,
		stagingEvents
	};
}

function streamOfBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		}
	});
}

describe('createNixCacheService write path', () => {
	it('stages a NAR under its file-hash staging key', async () => {
		const { dependencies, puts } = harness();
		const service = createNixCacheService(dependencies);

		const result = await service.stageNar('', fileHash, streamOf('zstd'), {
			...anyMeta,
			contentLength: 4
		});
		expect(result.etag).toBe('staged-etag');
		expect(puts).toStrictEqual([
			{ key: `staging/s3/acme/_default/${fileHash}.nar.zst` }
		]);
	});

	it('maps a proven blob SHA-256 mismatch to BadDigest', async () => {
		const { dependencies } = harness({
			putError: new BlobSha256MismatchError()
		});
		const service = createNixCacheService(dependencies);

		await expect(
			service.stageNar('', fileHash, streamOf('different bytes'), {
				...anyMeta,
				contentLength: 15
			})
		).rejects.toThrow(NarChecksumMismatchError);
	});

	it('preserves an existing staged object after a replacement fails its checksum', async () => {
		const existing = {
			size: 3,
			etag: 'existing',
			lastModified: issuedAt
		};
		const { dependencies, deletes, stagingEvents } = harness({
			putError: new BlobSha256MismatchError(),
			stagedStatAfterPutFailure: existing
		});
		const service = createNixCacheService(dependencies);

		await expect(
			service.stageNar('', fileHash, streamOf('different bytes'), {
				...anyMeta,
				contentLength: 15
			})
		).rejects.toThrow(NarChecksumMismatchError);
		expect({ deletes, stagingEvents }).toStrictEqual({
			deletes: [],
			stagingEvents: [
				[
					'reserve',
					'',
					`staging/s3/acme/_default/${fileHash}.nar.zst`,
					15,
					'2026-01-01T00:15:00.000Z'
				],
				[
					'settle',
					`staging/s3/acme/_default/${fileHash}.nar.zst`,
					3,
					'2026-01-01T00:15:00.000Z'
				]
			]
		});
	});

	it('returns BadDigest when R2 cannot inspect a checksum-rejected replacement', async () => {
		const { dependencies, stagingEvents } = harness({
			putError: new BlobSha256MismatchError(),
			stagedHeadError: new Error('R2 HEAD failed')
		});
		const service = createNixCacheService(dependencies);

		await expect(
			service.stageNar('', fileHash, streamOf('different bytes'), {
				...anyMeta,
				contentLength: 15
			})
		).rejects.toThrow(NarChecksumMismatchError);
		expect(stagingEvents).toStrictEqual([
			[
				'reserve',
				'',
				`staging/s3/acme/_default/${fileHash}.nar.zst`,
				15,
				'2026-01-01T00:15:00.000Z'
			]
		]);
	});

	it('preserves an unrelated R2 failure', async () => {
		const failure = new Error(
			'put: The SHA-256 checksum service is unavailable.'
		);
		const { dependencies } = harness({ putError: failure });
		const service = createNixCacheService(dependencies);

		await expect(
			service.stageNar('', fileHash, streamOf('zstd'), {
				...anyMeta,
				contentLength: 4
			})
		).rejects.toBe(failure);
	});

	it('restores the previous staging charge after an unrelated PUT failure', async () => {
		const failure = new Error('R2 PUT failed');
		const previous = {
			size: 3,
			etag: 'previous',
			lastModified: issuedAt
		};
		const { dependencies, stagingEvents } = harness({
			putError: failure,
			stagedStatAfterPutFailure: previous
		});
		const service = createNixCacheService(dependencies);

		await expect(
			service.stageNar('', fileHash, streamOf('zstd'), {
				...anyMeta,
				contentLength: 4
			})
		).rejects.toBe(failure);
		expect(stagingEvents).toStrictEqual([
			[
				'reserve',
				'',
				`staging/s3/acme/_default/${fileHash}.nar.zst`,
				4,
				'2026-01-01T00:15:00.000Z'
			],
			[
				'settle',
				`staging/s3/acme/_default/${fileHash}.nar.zst`,
				3,
				'2026-01-01T00:15:00.000Z'
			]
		]);
	});

	it('commits a narinfo and settles a deferred verification inline', async () => {
		const { dependencies, registered, commit, settleUpload } = harness({
			commitOutcome: { kind: 'deferred' },
			settlement: 'servable',
			narinfoStat: {
				size: 10,
				etag: 'narinfo-etag',
				lastModified: issuedAt
			}
		});
		const service = createNixCacheService(dependencies);

		const result = await service.commitNarinfo(
			'',
			storePathHash,
			streamOf(narBody),
			anyMeta,
			undefined
		);

		expect(result.etag).toBe('narinfo-etag');
		expect(commit).toHaveBeenCalledWith('', 'upload-1');
		expect(settleUpload).toHaveBeenCalledWith('upload-1', {
			cache: '',
			storePathHash,
			narHash
		});
		expect(
			registered.map(({ metadataJson, ...row }) => ({
				...row,
				metadata: JSON.parse(metadataJson) as unknown
			}))
		).toStrictEqual([
			{
				id: 'upload-1',
				cache: '',
				narHash,
				r2Key: `staging/s3/acme/_default/${fileHash}.nar.zst`,
				origin: undefined,
				createdAt: '2026-01-01T00:00:00.000Z',
				expiresAt: '2026-01-01T00:15:00.000Z',
				metadata: {
					storePathHash,
					storePath: `/nix/store/${storePathHash}-name`,
					narHash,
					narSize: 200,
					references: [],
					fileHash,
					fileSize: 100,
					compression: 'zstd'
				}
			}
		]);
	});

	it('reuses the canonical NAR when the tenant already owns the file hash', async () => {
		const { dependencies, registered } = harness({
			reusableNarHash: narHash,
			narinfoStat: { size: 10, etag: 'narinfo-etag', lastModified: issuedAt }
		});
		const service = createNixCacheService(dependencies);

		await service.commitNarinfo(
			'',
			storePathHash,
			streamOf(narBody),
			anyMeta,
			undefined
		);

		expect(registered.map((row) => row.r2Key)).toStrictEqual([
			`nar/${narHash}.nar.zst`
		]);
	});

	it('does not register a pending upload after cleanup claims its NAR', async () => {
		const { dependencies, registered } = harness({
			protectsStagedObject: false
		});
		const service = createNixCacheService(dependencies);

		await expect(
			service.commitNarinfo(
				'',
				storePathHash,
				streamOf(narBody),
				anyMeta,
				undefined
			)
		).rejects.toThrow(UploadDigestMismatchError);
		expect(registered).toStrictEqual([]);
	});

	it.skipIf(typeof crypto.DigestStream !== 'function')(
		'verifies a completed multipart upload against its file-hash key',
		async () => {
			const bytes = new TextEncoder().encode('multipart NAR bytes');
			const digest = new Uint8Array(
				await crypto.subtle.digest('SHA-256', bytes)
			);
			const multipartHash = NixSha256Hash.fromDigest(digest).toString();
			const { dependencies, deletes } = harness({ multipartBytes: bytes });
			const service = createNixCacheService(dependencies);

			await expect(
				service.completeNarUpload('', multipartHash, 'mpu', [
					{ partNumber: 1, etag: 'part-etag' }
				])
			).resolves.toStrictEqual({ etag: 'multipart-etag' });
			expect(deletes).toStrictEqual([]);
		}
	);

	it.skipIf(typeof crypto.DigestStream !== 'function')(
		'rejects a concurrent multipart completion without aborting the active request',
		async () => {
			const bytes = new TextEncoder().encode('concurrent multipart NAR');
			const digest = new Uint8Array(
				await crypto.subtle.digest('SHA-256', bytes)
			);
			const multipartHash = NixSha256Hash.fromDigest(digest).toString();
			const completionMayFinish = Promise.withResolvers<undefined>();
			const { dependencies, abortMultipartUpload, completeMultipartUpload } =
				harness({
					multipartBytes: bytes,
					completeMultipartWait: completionMayFinish.promise,
					completionInProgressAfterFirst: true
				});
			const service = createNixCacheService(dependencies);
			const parts = [{ partNumber: 1, etag: 'part-etag' }];

			const first = service.completeNarUpload('', multipartHash, 'mpu', parts);
			await vi.waitFor(() => {
				expect(completeMultipartUpload).toHaveBeenCalledTimes(1);
			});
			await expect(
				service.completeNarUpload('', multipartHash, 'mpu', parts)
			).rejects.toThrow(MultipartUploadAlreadyCompletingError);
			expect(abortMultipartUpload).not.toHaveBeenCalled();

			completionMayFinish.resolve(undefined);
			await expect(first).resolves.toStrictEqual({ etag: 'multipart-etag' });
		}
	);

	it('renews completion ownership while an R2 operation remains in progress', async () => {
		vi.useFakeTimers();
		try {
			const completionMayFinish = Promise.withResolvers<undefined>();
			const {
				dependencies,
				completeMultipartUpload,
				renewMultipartCompletion
			} = harness({
				completeMultipartWait: completionMayFinish.promise
			});
			const service = createNixCacheService(dependencies);

			const completion = service.completeNarUpload('', fileHash, 'mpu', [
				{ partNumber: 1, etag: 'part-etag' }
			]);
			await vi.advanceTimersByTimeAsync(0);
			expect(completeMultipartUpload).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(multipartCompletionLeaseMs);
			expect(renewMultipartCompletion.mock.calls.length).toBeGreaterThan(1);

			completionMayFinish.resolve(undefined);
			await expect(completion).rejects.toThrow(
				'Completed multipart object is missing'
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it.skipIf(typeof crypto.DigestStream !== 'function')(
		'recovers a completed R2 upload after D1 finalisation fails',
		async () => {
			const bytes = new TextEncoder().encode('recoverable multipart NAR');
			const digest = new Uint8Array(
				await crypto.subtle.digest('SHA-256', bytes)
			);
			const multipartHash = NixSha256Hash.fromDigest(digest).toString();
			const { dependencies, completeMultipartUpload } = harness({
				multipartBytes: bytes,
				completeAccountingFailures: 1,
				abortMultipartError: new NoSuchUploadError()
			});
			const service = createNixCacheService(dependencies);
			const parts = [{ partNumber: 1, etag: 'part-etag' }];

			await expect(
				service.completeNarUpload('', multipartHash, 'mpu', parts)
			).rejects.toThrow('D1 finalisation failed');
			await expect(
				service.completeNarUpload('', multipartHash, 'mpu', parts)
			).resolves.toStrictEqual({ etag: 'multipart-etag' });
			expect(completeMultipartUpload).toHaveBeenCalledTimes(1);
		}
	);

	it.skipIf(typeof crypto.DigestStream !== 'function')(
		'aborts a live multipart handle before adopting an older matching object',
		async () => {
			const bytes = new TextEncoder().encode('older matching multipart NAR');
			const digest = new Uint8Array(
				await crypto.subtle.digest('SHA-256', bytes)
			);
			const multipartHash = NixSha256Hash.fromDigest(digest).toString();
			const completionFailure = new Error('R2 completion failed');
			const { dependencies, abortMultipartUpload, completeMultipartUpload } =
				harness({
					multipartBytes: bytes,
					completeMultipartError: completionFailure
				});
			const service = createNixCacheService(dependencies);

			await expect(
				service.completeNarUpload('', multipartHash, 'mpu', [
					{ partNumber: 1, etag: 'part-etag' }
				])
			).resolves.toStrictEqual({ etag: 'multipart-etag' });
			expect({
				completionCalls: completeMultipartUpload.mock.calls.length,
				abortCalls: abortMultipartUpload.mock.calls
			}).toStrictEqual({
				completionCalls: 1,
				abortCalls: [
					[`staging/s3/acme/_default/${multipartHash}.nar.zst`, 'mpu']
				]
			});
		}
	);

	it.skipIf(typeof crypto.DigestStream !== 'function')(
		'deletes a completed multipart upload whose file hash is wrong',
		async () => {
			const { dependencies, deletes } = harness({
				multipartBytes: new TextEncoder().encode('different multipart bytes')
			});
			const service = createNixCacheService(dependencies);

			await expect(
				service.completeNarUpload('', fileHash, 'mpu', [
					{ partNumber: 1, etag: 'part-etag' }
				])
			).rejects.toThrow(NarChecksumMismatchError);
			expect(deletes).toStrictEqual([
				`staging/s3/acme/_default/${fileHash}.nar.zst`
			]);
		}
	);

	it('does not settle when the commit is already settled', async () => {
		const { dependencies, settleUpload } = harness({
			commitOutcome: { kind: 'settled' },
			narinfoStat: { size: 10, etag: 'narinfo-etag', lastModified: issuedAt }
		});
		const service = createNixCacheService(dependencies);

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
		const { dependencies } = harness();
		const service = createNixCacheService(dependencies);

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
		const { dependencies } = harness();
		const service = createNixCacheService(dependencies);
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
		const { dependencies } = harness();
		const service = createNixCacheService(dependencies);
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
		const { dependencies } = harness();
		const service = createNixCacheService(dependencies);

		expect(await service.resolveServableNar('', fileHash)).toBe(fileHash);
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
			const { dependencies } = harness({
				commitOutcome: { kind: 'deferred' },
				settlement
			});
			const service = createNixCacheService(dependencies);

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
		const { dependencies, commit } = harness();
		commit.mockImplementation(() =>
			Promise.reject(new QuotaExceededError(tenant))
		);
		const service = createNixCacheService(dependencies);

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
		const { dependencies } = harness();
		const service = createNixCacheService(dependencies);

		const info = await service.cacheInfo('');
		expect(new TextDecoder().decode(info?.body)).toContain('Priority: 40');
		expect(info?.etag).toMatch(/^[0-9a-f]{64}$/);
		expect(info?.lastModified).toStrictEqual(
			new Date('2026-01-01T00:00:00.000Z')
		);
	});

	it('reports a missing cache when rendering cache info', async () => {
		const { dependencies } = harness();
		const service = createNixCacheService(dependencies);

		expect(await service.cacheInfo(missingCache)).toBeUndefined();
	});
});
