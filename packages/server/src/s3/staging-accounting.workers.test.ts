import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	cacheNameSchema,
	nixSha256HashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { uploadIdSchema } from '@cupboard/protocol/upload';
import {
	InvalidPartError,
	MultipartUploadAlreadyCompletingError,
	NoSuchUploadError,
	StagedObjectBeingDeletedError
} from '@cupboard/s3/errors';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it, vi } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import { QuotaExceededError } from '../errors.ts';

import { type BlobStore, createR2BlobStore } from './blob-store.ts';
import {
	createNixCacheService,
	type NixCacheServiceDependencies
} from './nix-cache-service.ts';
import {
	multipartCompletionLeaseMs,
	MultipartPartReservationSupersededError,
	S3StagingAccounting
} from './staging-accounting.ts';

const tenant = tenantIdSchema.parse('quota-accounting');
const cache = cacheNameSchema.parse('release');
const otherCache = cacheNameSchema.parse('other');
const uploadId = uploadIdSchema.parse('multipart-1');
const key = `staging/s3/${tenant}/${cache}/${nixSha256HashSchema.parse(`sha256:${'0'.repeat(52)}`)}.nar.zst`;
const now = new Date('2026-01-01T00:00:00.000Z');
const expiresAt = isoTimestamp(new Date('2026-01-08T00:00:00.000Z'));

type UploadState = Omit<
	typeof d1Schema.s3MultipartUpload.$inferSelect,
	'completionToken' | 'completionLeaseExpiresAt'
> & {
	readonly completionToken?: string;
	readonly completionLeaseExpiresAt?: IsoTimestamp;
};

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		}
	});
}

async function setup(
	quotaBytes: number,
	clock: () => Date = () => now
): Promise<S3StagingAccounting> {
	const database = drizzle(env.CUPBOARD_DB, { schema: d1Schema });
	await database.insert(d1Schema.tenant).values({
		id: tenant,
		status: 'active',
		readMode: 'public',
		ownerIssuer: 'https://issuer.example',
		ownerSubject: 'owner',
		ownerAudience: 'cupboard',
		configVersion: 1,
		createdAt: isoTimestamp(now)
	});
	await database.insert(d1Schema.tenantUsage).values({
		tenant,
		quotaBytes,
		updatedAt: isoTimestamp(now)
	});

	let token = 0;
	return new S3StagingAccounting(database, tenant, clock, () => {
		token += 1;
		return `token-${String(token)}`;
	});
}

async function state(): Promise<{
	readonly stagedBytes: number;
	readonly multipartBytes: number;
	readonly staged: (typeof d1Schema.s3StagedObject.$inferSelect)[];
	readonly uploads: UploadState[];
	readonly parts: (typeof d1Schema.s3MultipartPart.$inferSelect)[];
}> {
	const database = drizzle(env.CUPBOARD_DB, { schema: d1Schema });
	const usage = await database
		.select({
			stagedBytes: d1Schema.tenantUsage.stagedBytes,
			multipartBytes: d1Schema.tenantUsage.multipartBytes
		})
		.from(d1Schema.tenantUsage)
		.where(eq(d1Schema.tenantUsage.tenant, tenant))
		.get();

	if (usage === undefined) {
		throw new Error('tenant usage row is missing');
	}

	const uploads = await database.select().from(d1Schema.s3MultipartUpload);
	return {
		...usage,
		staged: await database.select().from(d1Schema.s3StagedObject),
		uploads: uploads.map(
			({ completionToken, completionLeaseExpiresAt, ...upload }) => {
				const token = completionToken ?? undefined;
				const leaseExpiresAt = completionLeaseExpiresAt ?? undefined;

				return {
					...upload,
					...(token !== undefined && { completionToken: token }),
					...(leaseExpiresAt !== undefined && {
						completionLeaseExpiresAt: leaseExpiresAt
					})
				};
			}
		),
		parts: await database.select().from(d1Schema.s3MultipartPart)
	};
}

describe('S3StagingAccounting', () => {
	it('charges only the replacement delta for a multipart part', async () => {
		const accounting = await setup(100);
		await accounting.beginMultipart(cache, key, uploadId, expiresAt);

		const first = await accounting.reserveMultipartPart(key, uploadId, 1, 30);
		await accounting.recordMultipartPart(first, { partNumber: 1, etag: 'one' });
		const replacement = await accounting.reserveMultipartPart(
			key,
			uploadId,
			1,
			45
		);
		await accounting.recordMultipartPart(replacement, {
			partNumber: 1,
			etag: 'two'
		});

		expect(await state()).toStrictEqual({
			stagedBytes: 0,
			multipartBytes: 45,
			staged: [],
			uploads: [
				{
					tenant,
					uploadId,
					cache,
					r2Key: key,
					state: 'open',
					createdAt: isoTimestamp(now),
					expiresAt
				}
			],
			parts: [
				{
					tenant,
					uploadId,
					partNumber: 1,
					size: 45,
					reservedSize: 45,
					etag: 'two',
					reservationToken: 'token-2'
				}
			]
		});
	});

	it('rejects a superseded same-part result before recording its ETag', async () => {
		const accounting = await setup(100);
		await accounting.beginMultipart(cache, key, uploadId, expiresAt);
		const first = await accounting.reserveMultipartPart(key, uploadId, 1, 20);
		const second = await accounting.reserveMultipartPart(key, uploadId, 1, 30);

		await expect(
			accounting.recordMultipartPart(first, { partNumber: 1, etag: 'first' })
		).rejects.toThrow(MultipartPartReservationSupersededError);
		await accounting.recordMultipartPart(second, {
			partNumber: 1,
			etag: 'second'
		});

		expect(await state()).toStrictEqual({
			stagedBytes: 0,
			multipartBytes: 30,
			staged: [],
			uploads: [
				{
					tenant,
					uploadId,
					cache,
					r2Key: key,
					state: 'open',
					createdAt: isoTimestamp(now),
					expiresAt
				}
			],
			parts: [
				{
					tenant,
					uploadId,
					partNumber: 1,
					size: 30,
					reservedSize: 30,
					etag: 'second',
					reservationToken: 'token-2'
				}
			]
		});
	});

	it('rejects a part that would exceed the absolute tenant quota', async () => {
		const accounting = await setup(40);
		await accounting.beginMultipart(cache, key, uploadId, expiresAt);
		const reservation = await accounting.reserveMultipartPart(
			key,
			uploadId,
			1,
			30
		);
		await accounting.recordMultipartPart(reservation, {
			partNumber: 1,
			etag: 'one'
		});

		await expect(
			accounting.reserveMultipartPart(key, uploadId, 2, 11)
		).rejects.toThrow(QuotaExceededError);
		expect(await state()).toStrictEqual({
			stagedBytes: 0,
			multipartBytes: 30,
			staged: [],
			uploads: [
				{
					tenant,
					uploadId,
					cache,
					r2Key: key,
					state: 'open',
					createdAt: isoTimestamp(now),
					expiresAt
				}
			],
			parts: [
				{
					tenant,
					uploadId,
					partNumber: 1,
					size: 30,
					reservedSize: 30,
					etag: 'one',
					reservationToken: 'token-1'
				}
			]
		});
	});

	it('moves selected multipart bytes into staged accounting on completion', async () => {
		const accounting = await setup(100);
		await accounting.beginMultipart(cache, key, uploadId, expiresAt);
		const first = await accounting.reserveMultipartPart(key, uploadId, 1, 20);
		await accounting.recordMultipartPart(first, { partNumber: 1, etag: 'one' });
		const second = await accounting.reserveMultipartPart(key, uploadId, 2, 30);
		await accounting.recordMultipartPart(second, {
			partNumber: 2,
			etag: 'two'
		});

		const preparation = await accounting.prepareMultipartCompletion(
			key,
			uploadId,
			[{ partNumber: 2, etag: 'two' }]
		);
		await accounting.completeMultipart(
			key,
			uploadId,
			preparation.token,
			[{ partNumber: 2, etag: 'two' }],
			expiresAt
		);

		expect(await state()).toStrictEqual({
			stagedBytes: 30,
			multipartBytes: 0,
			staged: [
				{ tenant, cache, r2Key: key, size: 30, expiresAt, deleting: false }
			],
			uploads: [],
			parts: []
		});
	});

	it('does not charge a part reservation after completion takes ownership', async () => {
		const accounting = await setup(100);
		await accounting.beginMultipart(cache, key, uploadId, expiresAt);
		const first = await accounting.reserveMultipartPart(key, uploadId, 1, 20);
		const part = { partNumber: 1, etag: 'one' };
		await accounting.recordMultipartPart(first, part);

		const database = drizzle(env.CUPBOARD_DB, { schema: d1Schema });
		const originalBatch = database.batch.bind(database);
		let hasCompletionStarted = false;
		const batchAfterCompletion = async (
			queries: Parameters<typeof database.batch>[0]
		) => {
			if (!hasCompletionStarted) {
				hasCompletionStarted = true;
				await accounting.prepareMultipartCompletion(key, uploadId, [part]);
			}

			return originalBatch(queries);
		};
		const racingDatabase = new Proxy(database, {
			get(target, property, receiver) {
				if (property !== 'batch') {
					const value: unknown = Reflect.get(target, property, receiver);
					return value;
				}

				return batchAfterCompletion;
			}
		});
		const racingAccounting = new S3StagingAccounting(
			racingDatabase,
			tenant,
			() => now,
			() => 'racing-part'
		);

		await expect(
			racingAccounting.reserveMultipartPart(key, uploadId, 2, 30)
		).rejects.toThrow(NoSuchUploadError);

		const leaseExpiresAt = isoTimestamp(
			new Date(now.getTime() + multipartCompletionLeaseMs)
		);
		expect(await state()).toStrictEqual({
			stagedBytes: 0,
			multipartBytes: 20,
			staged: [],
			uploads: [
				{
					tenant,
					uploadId,
					cache,
					r2Key: key,
					state: 'completing',
					completionToken: 'token-2',
					completionLeaseExpiresAt: leaseExpiresAt,
					createdAt: isoTimestamp(now),
					expiresAt
				}
			],
			parts: [
				{
					tenant,
					uploadId,
					partNumber: 1,
					size: 20,
					reservedSize: 20,
					etag: 'one',
					reservationToken: 'token-2'
				}
			]
		});
	});

	it('fences a part replacement that was still in flight when completion started', async () => {
		const accounting = await setup(200);
		await accounting.beginMultipart(cache, key, uploadId, expiresAt);
		const first = await accounting.reserveMultipartPart(key, uploadId, 1, 100);
		await accounting.recordMultipartPart(first, {
			partNumber: 1,
			etag: 'original'
		});
		const selected = await accounting.reserveMultipartPart(
			key,
			uploadId,
			2,
			20
		);
		const selectedPart = { partNumber: 2, etag: 'selected' };
		await accounting.recordMultipartPart(selected, selectedPart);
		const replacement = await accounting.reserveMultipartPart(
			key,
			uploadId,
			1,
			50
		);

		const preparation = await accounting.prepareMultipartCompletion(
			key,
			uploadId,
			[selectedPart]
		);
		await expect(
			accounting.recordMultipartPart(replacement, {
				partNumber: 1,
				etag: 'replacement'
			})
		).rejects.toThrow(MultipartUploadAlreadyCompletingError);
		await accounting.completeMultipart(
			key,
			uploadId,
			preparation.token,
			[selectedPart],
			expiresAt
		);

		expect(await state()).toStrictEqual({
			stagedBytes: 20,
			multipartBytes: 0,
			staged: [
				{ tenant, cache, r2Key: key, size: 20, expiresAt, deleting: false }
			],
			uploads: [],
			parts: []
		});
	});

	it('leases one multipart completion and lets one request recover it after expiry', async () => {
		let current = now;
		const accounting = await setup(100, () => current);
		await accounting.beginMultipart(cache, key, uploadId, expiresAt);
		const reservation = await accounting.reserveMultipartPart(
			key,
			uploadId,
			1,
			20
		);
		const part = { partNumber: 1, etag: 'one' };
		await accounting.recordMultipartPart(reservation, part);

		const started = await accounting.prepareMultipartCompletion(key, uploadId, [
			part
		]);
		await expect(
			accounting.prepareMultipartCompletion(key, uploadId, [part])
		).rejects.toMatchObject({
			name: 'MultipartUploadAlreadyCompletingError',
			code: 'ServiceUnavailable',
			message: 'The multipart upload is already being completed; retry shortly.'
		});
		const abortMultipartUpload = vi.fn(() => Promise.resolve());
		const cleanupStore = {
			...createR2BlobStore(env.BLOBS),
			abortMultipartUpload
		} satisfies BlobStore;
		await expect(
			accounting.cleanupCache(cleanupStore, cache)
		).resolves.toStrictEqual({
			multipartReleased: 0,
			stagedReleased: 0,
			failures: []
		});
		expect(abortMultipartUpload).not.toHaveBeenCalled();

		current = new Date(now.getTime() + multipartCompletionLeaseMs - 1);
		await accounting.renewMultipartCompletion(key, uploadId, started.token);
		current = new Date(now.getTime() + 2 * multipartCompletionLeaseMs);
		const recoveryLeaseExpiresAt = isoTimestamp(
			new Date(current.getTime() + multipartCompletionLeaseMs)
		);
		const attempts = await Promise.allSettled([
			accounting.prepareMultipartCompletion(key, uploadId, [part]),
			accounting.prepareMultipartCompletion(key, uploadId, [part])
		]);
		expect(
			attempts
				.map((attempt) => attempt.status)
				.toSorted((left, right) => left.localeCompare(right))
		).toStrictEqual(['fulfilled', 'rejected']);
		const recovered = attempts.find(
			(
				attempt
			): attempt is PromiseFulfilledResult<
				Awaited<ReturnType<S3StagingAccounting['prepareMultipartCompletion']>>
			> => attempt.status === 'fulfilled'
		);
		const rejected = attempts.find(
			(attempt): attempt is PromiseRejectedResult =>
				attempt.status === 'rejected'
		);
		if (recovered === undefined || rejected === undefined) {
			throw new Error('exactly one completion recovery must succeed');
		}
		expect(rejected.reason).toBeInstanceOf(
			MultipartUploadAlreadyCompletingError
		);

		expect({
			started,
			recovered: recovered.value,
			state: await state()
		}).toStrictEqual({
			started: { kind: 'started', size: 20, token: 'token-2' },
			recovered: { kind: 'recovering', size: 20, token: recovered.value.token },
			state: {
				stagedBytes: 0,
				multipartBytes: 20,
				staged: [],
				uploads: [
					{
						tenant,
						uploadId,
						cache,
						r2Key: key,
						state: 'recovering',
						completionToken: recovered.value.token,
						completionLeaseExpiresAt: recoveryLeaseExpiresAt,
						createdAt: isoTimestamp(now),
						expiresAt
					}
				],
				parts: [
					{
						tenant,
						uploadId,
						partNumber: 1,
						size: 20,
						reservedSize: 20,
						etag: 'one',
						reservationToken: recovered.value.token
					}
				]
			}
		});
	});

	it('does not let cleanup claim a staged object during active completion', async () => {
		const accounting = await setup(100);
		const blobStore = createR2BlobStore(env.BLOBS);
		const bytes = new Uint8Array([1, 2, 3]);
		await accounting.reserveStagedObject(
			cache,
			key,
			bytes.byteLength,
			expiresAt
		);
		await env.BLOBS.put(key, bytes);
		await accounting.beginMultipart(cache, key, uploadId, expiresAt);
		const reservation = await accounting.reserveMultipartPart(
			key,
			uploadId,
			1,
			20
		);
		const part = { partNumber: 1, etag: 'one' };
		await accounting.recordMultipartPart(reservation, part);
		const preparation = await accounting.prepareMultipartCompletion(
			key,
			uploadId,
			[part]
		);
		const leaseExpiresAt = isoTimestamp(
			new Date(now.getTime() + multipartCompletionLeaseMs)
		);

		const outcome = await accounting.cleanupExpired(
			blobStore,
			new Date('2026-01-09T00:00:00.000Z')
		);

		expect({
			outcome,
			state: await state(),
			objectPresent: (await env.BLOBS.head(key)) !== null
		}).toStrictEqual({
			outcome: {
				multipartReleased: 0,
				stagedReleased: 0,
				failures: []
			},
			state: {
				stagedBytes: bytes.byteLength,
				multipartBytes: 20,
				staged: [
					{
						tenant,
						cache,
						r2Key: key,
						size: bytes.byteLength,
						expiresAt,
						deleting: false
					}
				],
				uploads: [
					{
						tenant,
						uploadId,
						cache,
						r2Key: key,
						state: 'completing',
						completionToken: preparation.token,
						completionLeaseExpiresAt: leaseExpiresAt,
						createdAt: isoTimestamp(now),
						expiresAt
					}
				],
				parts: [
					{
						tenant,
						uploadId,
						partNumber: 1,
						size: 20,
						reservedSize: 20,
						etag: 'one',
						reservationToken: preparation.token
					}
				]
			},
			objectPresent: true
		});
	});

	it('does not start completion while cleanup owns the staged object', async () => {
		const accounting = await setup(100);
		await accounting.beginMultipart(cache, key, uploadId, expiresAt);
		const reservation = await accounting.reserveMultipartPart(
			key,
			uploadId,
			1,
			20
		);
		const part = { partNumber: 1, etag: 'one' };
		await accounting.recordMultipartPart(reservation, part);
		await accounting.reserveStagedObject(otherCache, key, 7, expiresAt);
		const database = drizzle(env.CUPBOARD_DB, { schema: d1Schema });
		await database
			.update(d1Schema.s3StagedObject)
			.set({ deleting: true })
			.where(eq(d1Schema.s3StagedObject.r2Key, key));
		await expect(
			accounting.prepareMultipartCompletion(key, uploadId, [part])
		).rejects.toThrow(StagedObjectBeingDeletedError);

		expect(await state()).toStrictEqual({
			stagedBytes: 7,
			multipartBytes: 20,
			staged: [
				{
					tenant,
					cache: otherCache,
					r2Key: key,
					size: 7,
					expiresAt,
					deleting: true
				}
			],
			uploads: [
				{
					tenant,
					uploadId,
					cache,
					r2Key: key,
					state: 'open',
					createdAt: isoTimestamp(now),
					expiresAt
				}
			],
			parts: [
				{
					tenant,
					uploadId,
					partNumber: 1,
					size: 20,
					reservedSize: 20,
					etag: 'one',
					reservationToken: 'token-1'
				}
			]
		});
	});

	it('recovers quota accounting after R2 completes before D1 finalisation', async () => {
		const accounting = await setup(100);
		const blobStore = createR2BlobStore(env.BLOBS);
		const bytes = new TextEncoder().encode('recoverable multipart bytes');
		const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
		const fileHash = NixSha256Hash.fromDigest(digest).toString();
		const r2Key = `staging/s3/${tenant}/${cache}/${fileHash}.nar.zst`;
		const failure = new Error('D1 finalisation failed');
		let failuresRemaining = 1;
		const stagingAccounting: NixCacheServiceDependencies['stagingAccounting'] =
			{
				reserveStagedObject: (...arguments_) =>
					accounting.reserveStagedObject(...arguments_),
				settleStagedObject: (...arguments_) =>
					accounting.settleStagedObject(...arguments_),
				protectStagedObject: (...arguments_) =>
					accounting.protectStagedObject(...arguments_),
				releaseStagedObject: (...arguments_) =>
					accounting.releaseStagedObject(...arguments_),
				beginMultipart: (...arguments_) =>
					accounting.beginMultipart(...arguments_),
				reserveMultipartPart: (...arguments_) =>
					accounting.reserveMultipartPart(...arguments_),
				recordMultipartPart: (...arguments_) =>
					accounting.recordMultipartPart(...arguments_),
				prepareMultipartCompletion: (...arguments_) =>
					accounting.prepareMultipartCompletion(...arguments_),
				renewMultipartCompletion: (...arguments_) =>
					accounting.renewMultipartCompletion(...arguments_),
				reopenMultipart: (...arguments_) =>
					accounting.reopenMultipart(...arguments_),
				markMultipartRecovering: (...arguments_) =>
					accounting.markMultipartRecovering(...arguments_),
				markMultipartAborting: (...arguments_) =>
					accounting.markMultipartAborting(...arguments_),
				completeMultipart: (...arguments_) => {
					if (failuresRemaining > 0) {
						failuresRemaining -= 1;
						return Promise.reject(failure);
					}

					return accounting.completeMultipart(...arguments_);
				},
				releaseMultipart: (...arguments_) =>
					accounting.releaseMultipart(...arguments_)
			};
		const service = createNixCacheService({
			tenant,
			blobStore,
			stagingAccounting,
			pipeline: {
				registerPending: () => {
					throw new Error('not used');
				},
				commit: () => Promise.reject(new Error('not used')),
				settleUpload: () => Promise.reject(new Error('not used'))
			},
			caches: { find: () => Promise.resolve(undefined) },
			authoriser: {
				read: () => Promise.resolve(),
				write: () => Promise.resolve()
			},
			listing: { list: () => Promise.reject(new Error('not used')) },
			remover: { remove: () => Promise.reject(new Error('not used')) },
			nars: { resolveServableNar: () => Promise.resolve(undefined) },
			now: () => now,
			newId: () => uploadId
		});
		const upload = await service.beginNarUpload(cache, fileHash, {
			contentType: undefined,
			contentLength: undefined,
			checksumSha256: undefined
		});
		const part = await service.uploadNarPart(
			cache,
			fileHash,
			upload.uploadId,
			1,
			bytes.byteLength,
			streamOf(bytes)
		);

		await expect(
			service.completeNarUpload(cache, fileHash, upload.uploadId, [part])
		).rejects.toBe(failure);
		const interrupted = await state();
		const result = await service.completeNarUpload(
			cache,
			fileHash,
			upload.uploadId,
			[part]
		);
		const object = await env.BLOBS.get(r2Key);
		if (object === null) {
			throw new Error('the completed multipart object is missing');
		}
		const objectBuffer = await object.arrayBuffer();
		const objectBytes = new Uint8Array(objectBuffer);

		expect({
			result,
			interrupted,
			settled: await state(),
			object: {
				size: object.size,
				bytes: [...objectBytes]
			}
		}).toStrictEqual({
			result: { etag: object.etag },
			interrupted: {
				stagedBytes: 0,
				multipartBytes: bytes.byteLength,
				staged: [],
				uploads: [
					{
						tenant,
						uploadId: upload.uploadId,
						cache,
						r2Key,
						state: 'recovering',
						completionLeaseExpiresAt: isoTimestamp(now),
						createdAt: isoTimestamp(now),
						expiresAt: isoTimestamp(new Date('2026-01-07T00:00:00.000Z'))
					}
				],
				parts: [
					{
						tenant,
						uploadId: upload.uploadId,
						partNumber: 1,
						size: bytes.byteLength,
						reservedSize: bytes.byteLength,
						etag: part.etag,
						reservationToken: 'token-2'
					}
				]
			},
			settled: {
				stagedBytes: bytes.byteLength,
				multipartBytes: 0,
				staged: [
					{
						tenant,
						cache,
						r2Key,
						size: bytes.byteLength,
						expiresAt: isoTimestamp(new Date('2026-01-01T00:15:00.000Z')),
						deleting: false
					}
				],
				uploads: [],
				parts: []
			},
			object: { size: bytes.byteLength, bytes: [...bytes] }
		});
	});

	it('releases staged and multipart reservations', async () => {
		const accounting = await setup(100);
		await accounting.reserveStagedObject(cache, key, 25, expiresAt);
		await accounting.beginMultipart(cache, `${key}.parts`, uploadId, expiresAt);
		await accounting.reserveMultipartPart(`${key}.parts`, uploadId, 1, 40);

		await accounting.releaseStagedObject(key);
		await accounting.releaseMultipart(`${key}.parts`, uploadId);

		expect(await state()).toStrictEqual({
			stagedBytes: 0,
			multipartBytes: 0,
			staged: [],
			uploads: [],
			parts: []
		});
	});

	it('releases several staged objects through one bulk accounting path', async () => {
		const accounting = await setup(100);
		const secondKey = `${key}.second`;
		await accounting.reserveStagedObject(cache, key, 25, expiresAt);
		await accounting.reserveStagedObject(cache, secondKey, 35, expiresAt);

		await accounting.releaseStagedObjects([key, secondKey]);

		expect(await state()).toStrictEqual({
			stagedBytes: 0,
			multipartBytes: 0,
			staged: [],
			uploads: [],
			parts: []
		});
	});

	it('extends a near-expiry staging object for a live narinfo commit', async () => {
		const accounting = await setup(100);
		const stagedBytes = new Uint8Array([1, 2, 3]);
		const originalExpiry = isoTimestamp(new Date('2026-01-01T00:15:00.000Z'));
		const commitExpiry = isoTimestamp(new Date('2026-01-01T00:29:59.000Z'));
		await accounting.reserveStagedObject(
			cache,
			key,
			stagedBytes.byteLength,
			originalExpiry
		);
		await env.BLOBS.put(key, stagedBytes);

		const isProtectedForCommit = await accounting.protectStagedObject(
			key,
			commitExpiry
		);
		const outcome = await accounting.cleanupExpired(
			createR2BlobStore(env.BLOBS),
			new Date('2026-01-01T00:15:01.000Z')
		);

		expect({
			isProtectedForCommit,
			outcome,
			state: await state(),
			objectPresent: (await env.BLOBS.head(key)) !== null
		}).toStrictEqual({
			isProtectedForCommit: true,
			outcome: {
				multipartReleased: 0,
				stagedReleased: 0,
				failures: []
			},
			state: {
				stagedBytes: stagedBytes.byteLength,
				multipartBytes: 0,
				staged: [
					{
						tenant,
						cache,
						r2Key: key,
						size: stagedBytes.byteLength,
						expiresAt: commitExpiry,
						deleting: false
					}
				],
				uploads: [],
				parts: []
			},
			objectPresent: true
		});
	});

	it('refuses to protect a staged object after cleanup claims it', async () => {
		const accounting = await setup(100);
		const blobStore = createR2BlobStore(env.BLOBS);
		await accounting.reserveStagedObject(cache, key, 3, expiresAt);
		await env.BLOBS.put(key, new Uint8Array([1, 2, 3]));
		const deletionStarted = Promise.withResolvers<undefined>();
		const deletionMayFinish = Promise.withResolvers<undefined>();
		const pausedStore = {
			...blobStore,
			delete: async (r2Key: string) => {
				deletionStarted.resolve(undefined);
				await deletionMayFinish.promise;
				await blobStore.delete(r2Key);
			}
		} satisfies BlobStore;

		const cleanup = accounting.cleanupExpired(
			pausedStore,
			new Date('2026-01-09T00:00:00.000Z')
		);
		await deletionStarted.promise;
		const isProtectedForCommit = await accounting.protectStagedObject(
			key,
			isoTimestamp(new Date('2026-01-09T00:15:00.000Z'))
		);
		deletionMayFinish.resolve(undefined);

		expect({ isProtectedForCommit, outcome: await cleanup }).toStrictEqual({
			isProtectedForCommit: false,
			outcome: {
				multipartReleased: 0,
				stagedReleased: 1,
				failures: []
			}
		});
	});

	it('retries a claimed row after R2 deletion outlives its D1 release', async () => {
		const accounting = await setup(100);
		const blobStore = createR2BlobStore(env.BLOBS);
		await accounting.reserveStagedObject(cache, key, 3, expiresAt);
		await env.BLOBS.put(key, new Uint8Array([1, 2, 3]));
		const database = drizzle(env.CUPBOARD_DB, { schema: d1Schema });
		await database
			.update(d1Schema.s3StagedObject)
			.set({ deleting: true })
			.where(eq(d1Schema.s3StagedObject.r2Key, key));
		await env.BLOBS.delete(key);

		const outcomes = await Promise.all([
			accounting.cleanupExpired(
				blobStore,
				new Date('2026-01-09T00:00:00.000Z')
			),
			accounting.cleanupExpired(blobStore, new Date('2026-01-09T00:00:00.000Z'))
		]);

		expect({
			released: outcomes.reduce(
				(total, outcome) => total + outcome.stagedReleased,
				0
			),
			failures: outcomes.flatMap((outcome) => outcome.failures),
			state: await state()
		}).toStrictEqual({
			released: 1,
			failures: [],
			state: {
				stagedBytes: 0,
				multipartBytes: 0,
				staged: [],
				uploads: [],
				parts: []
			}
		});
	});

	it('removes one cache staging state and releases only its charges', async () => {
		const accounting = await setup(200);
		const blobStore = createR2BlobStore(env.BLOBS);
		const targetMultipartKey = `${key}.target-parts`;
		const otherStagedKey = `${key}.other`;
		const otherMultipartKey = `${key}.other-parts`;
		const otherUploadId = uploadIdSchema.parse('multipart-2');
		const targetStagedBytes = new Uint8Array([1, 2, 3, 4]);
		const otherStagedBytes = new Uint8Array([5, 6]);
		const targetPartBytes = new Uint8Array([7, 8, 9]);
		const otherPartBytes = new Uint8Array([10, 11, 12, 13, 14]);
		await env.BLOBS.delete([
			key,
			targetMultipartKey,
			otherStagedKey,
			otherMultipartKey
		]);

		await accounting.reserveStagedObject(
			cache,
			key,
			targetStagedBytes.byteLength,
			expiresAt
		);
		await env.BLOBS.put(key, targetStagedBytes);
		await accounting.reserveStagedObject(
			otherCache,
			otherStagedKey,
			otherStagedBytes.byteLength,
			expiresAt
		);
		await env.BLOBS.put(otherStagedKey, otherStagedBytes);

		const targetUpload = await blobStore.createMultipartUpload(
			targetMultipartKey,
			{
				contentType: undefined,
				contentLength: undefined,
				checksumSha256: undefined
			}
		);
		await accounting.beginMultipart(
			cache,
			targetMultipartKey,
			targetUpload.uploadId,
			expiresAt
		);
		const targetReservation = await accounting.reserveMultipartPart(
			targetMultipartKey,
			targetUpload.uploadId,
			1,
			targetPartBytes.byteLength
		);
		const targetPart = await blobStore.uploadPart(
			targetMultipartKey,
			targetUpload.uploadId,
			1,
			targetPartBytes.byteLength,
			streamOf(targetPartBytes)
		);
		await accounting.recordMultipartPart(targetReservation, targetPart);

		await accounting.beginMultipart(
			otherCache,
			otherMultipartKey,
			otherUploadId,
			expiresAt
		);
		const otherReservation = await accounting.reserveMultipartPart(
			otherMultipartKey,
			otherUploadId,
			1,
			otherPartBytes.byteLength
		);
		const otherPart = { partNumber: 1, etag: 'other-part' };
		await accounting.recordMultipartPart(otherReservation, otherPart);

		const outcome = await accounting.cleanupCache(blobStore, cache);

		expect({
			outcome,
			state: await state(),
			targetStagedPresent: (await env.BLOBS.head(key)) !== null,
			otherStagedPresent: (await env.BLOBS.head(otherStagedKey)) !== null
		}).toStrictEqual({
			outcome: {
				multipartReleased: 1,
				stagedReleased: 1,
				failures: []
			},
			state: {
				stagedBytes: otherStagedBytes.byteLength,
				multipartBytes: otherPartBytes.byteLength,
				staged: [
					{
						tenant,
						cache: otherCache,
						r2Key: otherStagedKey,
						size: otherStagedBytes.byteLength,
						expiresAt,
						deleting: false
					}
				],
				uploads: [
					{
						tenant,
						uploadId: otherUploadId,
						cache: otherCache,
						r2Key: otherMultipartKey,
						state: 'open',
						createdAt: isoTimestamp(now),
						expiresAt
					}
				],
				parts: [
					{
						tenant,
						uploadId: otherUploadId,
						partNumber: 1,
						size: otherPartBytes.byteLength,
						reservedSize: otherPartBytes.byteLength,
						etag: otherPart.etag,
						reservationToken: 'token-2'
					}
				]
			},
			targetStagedPresent: false,
			otherStagedPresent: true
		});
		const retryBody = streamOf(new Uint8Array([15]));
		await expect(
			blobStore.uploadPart(
				targetMultipartKey,
				targetUpload.uploadId,
				2,
				1,
				retryBody
			)
		).rejects.toThrow();
	});

	it('does not create a staging ledger without a tenant usage row', async () => {
		const database = drizzle(env.CUPBOARD_DB, { schema: d1Schema });
		const accounting = new S3StagingAccounting(
			database,
			tenant,
			() => now,
			() => crypto.randomUUID()
		);

		await expect(
			accounting.reserveStagedObject(cache, key, 10, expiresAt)
		).rejects.toThrow('Tenant usage is not available');
		expect(await database.select().from(d1Schema.s3StagedObject)).toStrictEqual(
			[]
		);
	});

	it('removes expired multipart and staged bytes from R2 and the ledger', async () => {
		const accounting = await setup(100);
		const blobStore = createR2BlobStore(env.BLOBS);
		const multipartKey = `${key}.multipart`;
		const stagedBytes = new Uint8Array([1, 2, 3, 4]);
		const partBytes = new Uint8Array([5, 6, 7]);
		await env.BLOBS.delete([key, multipartKey]);

		await accounting.reserveStagedObject(
			cache,
			key,
			stagedBytes.byteLength,
			expiresAt
		);
		await env.BLOBS.put(key, stagedBytes);
		const upload = await blobStore.createMultipartUpload(multipartKey, {
			contentType: undefined,
			contentLength: undefined,
			checksumSha256: undefined
		});
		await accounting.beginMultipart(
			cache,
			multipartKey,
			upload.uploadId,
			expiresAt
		);
		const reservation = await accounting.reserveMultipartPart(
			multipartKey,
			upload.uploadId,
			1,
			partBytes.byteLength
		);
		const part = await blobStore.uploadPart(
			multipartKey,
			upload.uploadId,
			1,
			partBytes.byteLength,
			streamOf(partBytes)
		);
		await accounting.recordMultipartPart(reservation, part);

		const outcome = await accounting.cleanupExpired(
			blobStore,
			new Date('2026-01-09T00:00:00.000Z')
		);

		expect({
			outcome,
			state: await state(),
			stagedPresent: (await env.BLOBS.head(key)) !== null
		}).toStrictEqual({
			outcome: {
				multipartReleased: 1,
				stagedReleased: 1,
				failures: []
			},
			state: {
				stagedBytes: 0,
				multipartBytes: 0,
				staged: [],
				uploads: [],
				parts: []
			},
			stagedPresent: false
		});
		const retryBytes = new Uint8Array([8]);
		await expect(
			blobStore.uploadPart(
				multipartKey,
				upload.uploadId,
				2,
				1,
				streamOf(retryBytes)
			)
		).rejects.toThrow();
	});

	it('releases expired multipart accounting when R2 already removed the upload', async () => {
		const accounting = await setup(100);
		const blobStore = createR2BlobStore(env.BLOBS);
		const multipartKey = `${key}.already-removed`;
		const partBytes = new Uint8Array([1, 2, 3]);
		const upload = await blobStore.createMultipartUpload(multipartKey, {
			contentType: undefined,
			contentLength: undefined,
			checksumSha256: undefined
		});
		await accounting.beginMultipart(
			cache,
			multipartKey,
			upload.uploadId,
			expiresAt
		);
		const reservation = await accounting.reserveMultipartPart(
			multipartKey,
			upload.uploadId,
			1,
			partBytes.byteLength
		);
		const part = await blobStore.uploadPart(
			multipartKey,
			upload.uploadId,
			1,
			partBytes.byteLength,
			streamOf(partBytes)
		);
		await accounting.recordMultipartPart(reservation, part);
		await blobStore.abortMultipartUpload(multipartKey, upload.uploadId);

		const outcome = await accounting.cleanupExpired(
			blobStore,
			new Date('2026-01-09T00:00:00.000Z')
		);

		expect({ outcome, state: await state() }).toStrictEqual({
			outcome: {
				multipartReleased: 1,
				stagedReleased: 0,
				failures: []
			},
			state: {
				stagedBytes: 0,
				multipartBytes: 0,
				staged: [],
				uploads: [],
				parts: []
			}
		});
	});

	it('deletes a completed multipart object before releasing its reservation', async () => {
		const accounting = await setup(100);
		const blobStore = createR2BlobStore(env.BLOBS);
		const multipartKey = `${key}.completed-before-cleanup`;
		const partBytes = new Uint8Array([4, 5, 6]);
		const upload = await blobStore.createMultipartUpload(multipartKey, {
			contentType: undefined,
			contentLength: undefined,
			checksumSha256: undefined
		});
		await accounting.beginMultipart(
			cache,
			multipartKey,
			upload.uploadId,
			expiresAt
		);
		const reservation = await accounting.reserveMultipartPart(
			multipartKey,
			upload.uploadId,
			1,
			partBytes.byteLength
		);
		const part = await blobStore.uploadPart(
			multipartKey,
			upload.uploadId,
			1,
			partBytes.byteLength,
			streamOf(partBytes)
		);
		await accounting.recordMultipartPart(reservation, part);
		await blobStore.completeMultipartUpload(multipartKey, upload.uploadId, [
			part
		]);

		const outcome = await accounting.cleanupExpired(
			blobStore,
			new Date('2026-01-09T00:00:00.000Z')
		);

		expect({
			outcome,
			state: await state(),
			objectPresent: (await env.BLOBS.head(multipartKey)) !== null
		}).toStrictEqual({
			outcome: {
				multipartReleased: 1,
				stagedReleased: 0,
				failures: []
			},
			state: {
				stagedBytes: 0,
				multipartBytes: 0,
				staged: [],
				uploads: [],
				parts: []
			},
			objectPresent: false
		});
	});

	it('keeps multipart accounting after another R2 abort error', async () => {
		const accounting = await setup(100);
		const multipartKey = `${key}.abort-failure`;
		await accounting.beginMultipart(cache, multipartKey, uploadId, expiresAt);
		const reservation = await accounting.reserveMultipartPart(
			multipartKey,
			uploadId,
			1,
			3
		);
		await accounting.recordMultipartPart(reservation, {
			partNumber: 1,
			etag: 'part'
		});
		const failure = new InvalidPartError();
		const failingStore = {
			...createR2BlobStore(env.BLOBS),
			abortMultipartUpload: () => Promise.reject(failure)
		} satisfies BlobStore;

		const outcome = await accounting.cleanupExpired(
			failingStore,
			new Date('2026-01-09T00:00:00.000Z')
		);

		expect({ outcome, state: await state() }).toStrictEqual({
			outcome: {
				multipartReleased: 0,
				stagedReleased: 0,
				failures: [failure]
			},
			state: {
				stagedBytes: 0,
				multipartBytes: 3,
				staged: [],
				uploads: [
					{
						tenant,
						uploadId,
						cache,
						r2Key: multipartKey,
						state: 'aborting',
						createdAt: isoTimestamp(now),
						expiresAt
					}
				],
				parts: [
					{
						tenant,
						uploadId,
						partNumber: 1,
						size: 3,
						reservedSize: 3,
						etag: 'part',
						reservationToken: 'token-1'
					}
				]
			}
		});
	});
});
