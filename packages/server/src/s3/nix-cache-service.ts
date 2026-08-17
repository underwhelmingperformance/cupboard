import { bytesToHex } from '@cupboard/nix-store/encoding';
import { fromNixBase32 } from '@cupboard/nix-store/hash';
import { parseNarInfo } from '@cupboard/nix-store/narinfo';
import type {
	CachePriority,
	NixSha256HashString,
	StoredCache,
	StorePathHash,
	TenantId
} from '@cupboard/nix-store/scalars';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import {
	type ParsedUploadPathMetadata,
	type UploadId,
	uploadPathMetadataSchema
} from '@cupboard/protocol/upload';
import {
	CommittedNarInfoUnreadableError,
	MalformedNarInfoError,
	MissingContentLengthError,
	MultipartUploadAlreadyCompletingError,
	NarChecksumMismatchError,
	NarInfoMismatchError,
	NarInfoNotCommittableError,
	NarInfoTooLargeError,
	NoSuchUploadError,
	type S3Error,
	UploadDigestMismatchError,
	UploadNotSettledError,
	UploadOverQuotaError,
	UploadStillPendingError
} from '@cupboard/s3/errors';
import type {
	ListObjectsQuery,
	ListObjectsResult,
	PutObjectMeta,
	PutObjectResult,
	S3Principal
} from '@cupboard/s3/ports';

import {
	NarTooLargeError,
	QuotaExceededError,
	UploadedObjectNotFoundError,
	UploadExpiredError
} from '../errors.ts';
import {
	narInfoObjectKey,
	narObjectKey,
	type R2ObjectKey
} from '../http/http.ts';

import { BlobSha256MismatchError, type BlobStore } from './blob-store.ts';
import { renderNixCacheInfoObject } from './cache-info-object.ts';
import { type NixCacheObject } from './nix-cache-keys.ts';
import type {
	NixCacheBackend,
	RenderedCacheInfo
} from './nix-cache-object-store.ts';
import { s3NarStagingKey, s3StagingPrefix, s3StagingTtlMs } from './staging.ts';
import {
	multipartCompletionLeaseMs,
	type MultipartPartReservation,
	MultipartPartReservationSupersededError,
	type S3StagingAccounting
} from './staging-accounting.ts';
import { renderS3Committer } from './upload-origin.ts';

/**
A staged narinfo commit settles to one of these outcomes.
*/
export type CommitOutcome =
	{ readonly kind: 'settled' } | { readonly kind: 'deferred' };

/**
 * The terminal outcome of settling one upload: `servable` once the path is
 * verified and served; `mismatch` when the NAR fails its hash check or was never
 * staged; `over-quota` when the canonical size exceeds the tenant's quota;
 * `pending` when verification has not yet reached a verdict; `absent` when
 * neither the pending upload nor the committed path matches this upload.
 */
export type UploadSettlement =
	'servable' | 'mismatch' | 'over-quota' | 'pending' | 'absent';

/**
The cache, store-path hash and NAR hash expected after this upload commits.
*/
export interface UploadSettlementTarget {
	readonly cache: StoredCache;
	readonly storePathHash: StorePathHash;
	readonly narHash: NixSha256HashString;
}

/**
A pending-upload row, as the commit pipeline consumes it.
*/
export interface PendingUploadRow {
	readonly id: UploadId;
	readonly cache: StoredCache;
	readonly narHash: NixSha256HashString;
	readonly r2Key: R2ObjectKey;
	readonly metadataJson: string;
	readonly origin: string | undefined;
	readonly createdAt: IsoTimestamp;
	readonly expiresAt: IsoTimestamp;
}

/**
 * The commit operations used by S3 uploads. A narinfo PUT waits for deferred
 * verification so the path is readable before the request returns.
 */
export interface IngestPipeline {
	registerPending(row: PendingUploadRow): void;
	commit(cache: StoredCache, uploadId: UploadId): Promise<CommitOutcome>;
	settleUpload(
		uploadId: UploadId,
		target: UploadSettlementTarget
	): Promise<UploadSettlement>;
}

export interface CacheRecord {
	readonly priority: CachePriority;
	readonly createdAt: IsoTimestamp;
}

export interface CacheRecords {
	find(cache: StoredCache): Promise<CacheRecord | undefined>;
}

export interface CacheAuthoriser {
	read(cache: StoredCache, principal: S3Principal | undefined): Promise<void>;
	write(cache: StoredCache, principal: S3Principal | undefined): Promise<void>;
}

export interface CacheListing {
	list(cache: StoredCache, query: ListObjectsQuery): Promise<ListObjectsResult>;
}

export interface CacheRemover {
	remove(
		cache: StoredCache,
		object: NixCacheObject,
		principal: S3Principal | undefined
	): Promise<void>;
}

export interface NarResolver {
	resolveServableNar(
		cache: StoredCache,
		hash: NixSha256HashString
	): Promise<NixSha256HashString | undefined>;
}

export interface NixCacheServiceDependencies {
	readonly tenant: TenantId;
	readonly blobStore: BlobStore;
	readonly pipeline: IngestPipeline;
	readonly caches: CacheRecords;
	readonly authoriser: CacheAuthoriser;
	readonly listing: CacheListing;
	readonly remover: CacheRemover;
	readonly nars: NarResolver;
	readonly stagingAccounting: Pick<
		S3StagingAccounting,
		| 'reserveStagedObject'
		| 'settleStagedObject'
		| 'protectStagedObject'
		| 'releaseStagedObject'
		| 'beginMultipart'
		| 'reserveMultipartPart'
		| 'recordMultipartPart'
		| 'prepareMultipartCompletion'
		| 'renewMultipartCompletion'
		| 'reopenMultipart'
		| 'markMultipartRecovering'
		| 'markMultipartAborting'
		| 'completeMultipart'
		| 'releaseMultipart'
	>;
	readonly now: () => Date;
	readonly newId: () => UploadId;
}

// A narinfo is a few hundred bytes of text; a body past this is refused before
// it is buffered into a string in the single-threaded Durable Object.
const maxNarInfoBodyBytes = 64 * 1024;
// Abort while R2's upload handle still exists. R2's default lifecycle removes
// incomplete multipart uploads after seven days, so Cupboard expires them first.
const multipartUploadTtlMs = 6 * 24 * 60 * 60 * 1000;
const multipartCompletionRenewalMs = multipartCompletionLeaseMs / 2;

async function withRenewingLease<T>(
	renew: () => Promise<void>,
	operation: () => Promise<T>
): Promise<T> {
	await renew();

	let isStopped = false;
	let renewalFailure: { readonly error: unknown } | undefined;
	let renewalInProgress: Promise<void> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const renewLease = async () => {
		try {
			await renew();
		} catch (error) {
			renewalFailure = { error };
		} finally {
			renewalInProgress = undefined;
			if (!isStopped && renewalFailure === undefined) {
				scheduleRenewal();
			}
		}
	};
	const scheduleRenewal = () => {
		timer = setTimeout(() => {
			renewalInProgress = renewLease();
		}, multipartCompletionRenewalMs);
	};
	scheduleRenewal();

	let outcome:
		| { readonly kind: 'returned'; readonly value: T }
		| { readonly kind: 'threw'; readonly error: unknown };
	try {
		outcome = { kind: 'returned', value: await operation() };
	} catch (error) {
		outcome = { kind: 'threw', error };
	} finally {
		isStopped = true;
		clearTimeout(timer);
		await renewalInProgress;
	}

	if (renewalFailure !== undefined) {
		throw renewalFailure.error;
	}

	await renew();
	if (outcome.kind === 'threw') {
		throw outcome.error;
	}

	return outcome.value;
}

function settlementError(settlement: UploadSettlement): S3Error {
	switch (settlement) {
		case 'mismatch': {
			return new UploadDigestMismatchError();
		}
		case 'over-quota': {
			return new UploadOverQuotaError();
		}
		case 'absent': {
			return new NarInfoNotCommittableError();
		}
		case 'pending': {
			return new UploadStillPendingError();
		}
		default: {
			return new UploadNotSettledError();
		}
	}
}

// The commit pipeline raises its own server errors before a settlement verdict
// is reached; translate the ones a client caused into the matching S3 error so
// they are not reported as a generic internal failure.
function translatePipelineError(error: unknown): never {
	if (
		error instanceof QuotaExceededError ||
		error instanceof NarTooLargeError
	) {
		throw new UploadOverQuotaError();
	}

	if (
		error instanceof UploadedObjectNotFoundError ||
		error instanceof UploadExpiredError
	) {
		throw new UploadDigestMismatchError();
	}

	throw error;
}

const sha256Prefix = 'sha256:';

function sha256HexOf(fileHash: NixSha256HashString): string {
	return bytesToHex(fromNixBase32(fileHash.slice(sha256Prefix.length)));
}

function expiryAfter(now: Date, ttlMs: number): IsoTimestamp {
	return isoTimestamp(new Date(now.getTime() + ttlMs));
}

/**
 * The production {@link NixCacheBackend}: it stages NAR bytes in R2, drives the
 * existing verify/sign/commit pipeline for narinfo, and renders `nix-cache-info`
 * from the cache record. Reads, listing, authorisation and removal are delegated
 * to the injected collaborators.
 */
export function createNixCacheService(
	dependencies: NixCacheServiceDependencies
): NixCacheBackend {
	async function stageNar(
		cache: StoredCache,
		fileHash: NixSha256HashString,
		body: ReadableStream<Uint8Array>,
		meta: PutObjectMeta
	): Promise<PutObjectResult> {
		if (meta.contentLength === undefined) {
			throw new MissingContentLengthError();
		}

		const key = s3NarStagingKey(dependencies.tenant, cache, fileHash);
		const expiresAt = isoTimestamp(
			new Date(dependencies.now().getTime() + s3StagingTtlMs)
		);
		try {
			await dependencies.stagingAccounting.reserveStagedObject(
				cache,
				key,
				meta.contentLength,
				expiresAt
			);
		} catch (error) {
			if (error instanceof QuotaExceededError) {
				throw new UploadOverQuotaError();
			}
			throw error;
		}

		// The nar object is named by its file hash, so record it as the staged
		// object's SHA-256: R2 verifies the body against it and the commit pipeline
		// reads it back as the blob's file hash.
		try {
			const result = await dependencies.blobStore.put(
				key,
				body,
				meta,
				sha256HexOf(fileHash)
			);
			await dependencies.stagingAccounting.settleStagedObject(
				key,
				meta.contentLength,
				expiresAt
			);
			return result;
		} catch (error) {
			if (error instanceof BlobSha256MismatchError) {
				try {
					const stored = await dependencies.blobStore.head(key);
					if (stored === undefined) {
						await dependencies.stagingAccounting.releaseStagedObject(key);
					} else {
						await dependencies.stagingAccounting.settleStagedObject(
							key,
							stored.size,
							expiresAt
						);
					}
				} catch {
					// Retain the reservation when R2 cannot report the object that remains.
				}
				throw new NarChecksumMismatchError();
			}

			try {
				const stored = await dependencies.blobStore.head(key);
				if (stored === undefined) {
					await dependencies.stagingAccounting.releaseStagedObject(key);
				} else {
					await dependencies.stagingAccounting.settleStagedObject(
						key,
						stored.size,
						expiresAt
					);
				}
			} catch {
				// Keep the conservative reservation when R2 cannot report which
				// object remains after the failed replacement.
			}

			throw error;
		}
	}

	async function commitNarinfo(
		cache: StoredCache,
		storePathHash: StorePathHash,
		body: ReadableStream<Uint8Array>,
		meta: PutObjectMeta,
		principal: S3Principal | undefined
	): Promise<PutObjectResult> {
		if (
			meta.contentLength !== undefined &&
			meta.contentLength > maxNarInfoBodyBytes
		) {
			throw new NarInfoTooLargeError();
		}

		const text = await readBoundedText(body, maxNarInfoBodyBytes);
		const metadata = parseMetadata(text, storePathHash);

		const uploadId = dependencies.newId();
		const issued = dependencies.now();
		const expires = new Date(issued.getTime() + s3StagingTtlMs);
		const reusableNarHash = await dependencies.nars.resolveServableNar(
			cache,
			metadata.fileHash
		);
		const r2Key =
			reusableNarHash === metadata.narHash
				? narObjectKey(metadata.narHash)
				: s3NarStagingKey(dependencies.tenant, cache, metadata.fileHash);
		if (r2Key.startsWith(s3StagingPrefix)) {
			const isProtectedForCommit =
				await dependencies.stagingAccounting.protectStagedObject(
					r2Key,
					isoTimestamp(expires)
				);
			if (!isProtectedForCommit) {
				throw new UploadDigestMismatchError();
			}
		}
		dependencies.pipeline.registerPending({
			id: uploadId,
			cache,
			narHash: metadata.narHash,
			r2Key,
			metadataJson: JSON.stringify(metadata),
			origin: renderS3Committer(principal),
			createdAt: isoTimestamp(issued),
			expiresAt: isoTimestamp(expires)
		});

		let settlement: UploadSettlement;
		try {
			const outcome = await dependencies.pipeline.commit(cache, uploadId);
			settlement = 'servable';

			if (outcome.kind === 'deferred') {
				settlement = await dependencies.pipeline.settleUpload(uploadId, {
					cache,
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash
				});
			}
		} catch (error) {
			translatePipelineError(error);
		}

		if (settlement !== 'servable') {
			throw settlementError(settlement);
		}

		const stat = await dependencies.blobStore.head(
			narInfoObjectKey(dependencies.tenant, storePathHash, cache)
		);

		// A servable verdict guarantees the served object exists; a missing one
		// here would be an internal inconsistency, not a client error.
		if (stat === undefined) {
			throw new CommittedNarInfoUnreadableError();
		}

		return { etag: stat.etag };
	}

	async function completeNarUpload(
		cache: StoredCache,
		fileHash: NixSha256HashString,
		uploadId: string,
		parts: Parameters<BlobStore['completeMultipartUpload']>[2]
	) {
		const key = s3NarStagingKey(dependencies.tenant, cache, fileHash);
		const preparation =
			await dependencies.stagingAccounting.prepareMultipartCompletion(
				key,
				uploadId,
				parts
			);
		const withCompletionLease = <T>(operation: () => Promise<T>) =>
			withRenewingLease(
				() =>
					dependencies.stagingAccounting.renewMultipartCompletion(
						key,
						uploadId,
						preparation.token
					),
				operation
			);
		let object: CompletedMultipartInspection | undefined;
		if (preparation.kind === 'recovering') {
			await withCompletionLease(() =>
				abortOrConfirmMissingUpload(dependencies.blobStore, key, uploadId)
			);
			object = await withCompletionLease(() =>
				inspectCompletedMultipart(
					dependencies.blobStore,
					key,
					fileHash,
					preparation.size
				)
			);
			if (object.kind === 'missing') {
				await dependencies.stagingAccounting.releaseMultipart(key, uploadId);
				throw new NoSuchUploadError();
			}
			if (object.kind === 'mismatch') {
				await dependencies.blobStore.delete(key);
				await dependencies.stagingAccounting.releaseMultipart(key, uploadId);
				await dependencies.stagingAccounting.releaseStagedObject(key);
				throw new NarChecksumMismatchError();
			}
		}
		let completed: PutObjectResult | undefined;

		if (object?.kind !== 'valid') {
			try {
				completed = await withCompletionLease(() =>
					dependencies.blobStore.completeMultipartUpload(key, uploadId, parts)
				);
				object = undefined;
			} catch (error) {
				object = await withCompletionLease(() =>
					inspectCompletedMultipart(
						dependencies.blobStore,
						key,
						fileHash,
						preparation.size
					)
				);
				if (object.kind === 'valid') {
					await withCompletionLease(() =>
						abortOrConfirmMissingUpload(dependencies.blobStore, key, uploadId)
					);
					object = await withCompletionLease(() =>
						inspectCompletedMultipart(
							dependencies.blobStore,
							key,
							fileHash,
							preparation.size
						)
					);
				} else {
					await dependencies.stagingAccounting.reopenMultipart(
						key,
						uploadId,
						preparation.token
					);
					throw error;
				}
			}
		}

		object ??= await withCompletionLease(() =>
			inspectCompletedMultipart(
				dependencies.blobStore,
				key,
				fileHash,
				preparation.size
			)
		);
		if (object.kind === 'missing') {
			throw new Error('Completed multipart object is missing');
		}
		if (object.kind === 'mismatch') {
			await dependencies.blobStore.delete(key);
			await dependencies.stagingAccounting.releaseMultipart(key, uploadId);
			await dependencies.stagingAccounting.releaseStagedObject(key);
			throw new NarChecksumMismatchError();
		}

		const expiresAt = expiryAfter(dependencies.now(), s3StagingTtlMs);
		try {
			await dependencies.stagingAccounting.completeMultipart(
				key,
				uploadId,
				preparation.token,
				parts,
				expiresAt
			);
		} catch (error) {
			await dependencies.stagingAccounting.markMultipartRecovering(
				key,
				uploadId,
				preparation.token
			);
			throw error;
		}

		return completed ?? { etag: object.etag };
	}

	async function beginNarUpload(
		cache: StoredCache,
		fileHash: NixSha256HashString,
		meta: PutObjectMeta
	) {
		const key = s3NarStagingKey(dependencies.tenant, cache, fileHash);
		const upload = await dependencies.blobStore.createMultipartUpload(
			key,
			meta
		);

		const expiresAt = expiryAfter(dependencies.now(), multipartUploadTtlMs);
		try {
			await dependencies.stagingAccounting.beginMultipart(
				cache,
				key,
				upload.uploadId,
				expiresAt
			);
		} catch (error) {
			await dependencies.blobStore.abortMultipartUpload(key, upload.uploadId);
			throw error;
		}

		return upload;
	}

	async function abortNarUploadIfIdle(
		cache: StoredCache,
		fileHash: NixSha256HashString,
		uploadId: string
	): Promise<'aborted' | 'active-completion'> {
		const key = s3NarStagingKey(dependencies.tenant, cache, fileHash);
		const canAbort = await dependencies.stagingAccounting.markMultipartAborting(
			key,
			uploadId
		);
		if (!canAbort) {
			return 'active-completion';
		}
		await dependencies.blobStore.abortMultipartUpload(key, uploadId);
		await dependencies.stagingAccounting.releaseMultipart(key, uploadId);
		return 'aborted';
	}

	async function abortNarUpload(
		cache: StoredCache,
		fileHash: NixSha256HashString,
		uploadId: string
	): Promise<void> {
		const outcome = await abortNarUploadIfIdle(cache, fileHash, uploadId);
		if (outcome === 'aborted') {
			return;
		}

		throw new MultipartUploadAlreadyCompletingError();
	}

	async function uploadNarPart(
		cache: StoredCache,
		fileHash: NixSha256HashString,
		uploadId: string,
		partNumber: number,
		contentLength: number | undefined,
		body: ReadableStream<Uint8Array>
	) {
		const key = s3NarStagingKey(dependencies.tenant, cache, fileHash);
		if (contentLength === undefined) {
			await abortNarUpload(cache, fileHash, uploadId);
			throw new MissingContentLengthError();
		}

		let reservation: MultipartPartReservation;
		try {
			reservation = await dependencies.stagingAccounting.reserveMultipartPart(
				key,
				uploadId,
				partNumber,
				contentLength
			);
		} catch (error) {
			if (!(error instanceof QuotaExceededError)) {
				throw error;
			}

			await abortNarUpload(cache, fileHash, uploadId);
			throw new UploadOverQuotaError();
		}

		const part = await dependencies.blobStore.uploadPart(
			key,
			uploadId,
			partNumber,
			contentLength,
			body
		);
		try {
			await dependencies.stagingAccounting.recordMultipartPart(
				reservation,
				part
			);
		} catch (error) {
			if (!(error instanceof MultipartPartReservationSupersededError)) {
				throw error;
			}

			await abortNarUploadIfIdle(cache, fileHash, uploadId);
			throw error;
		}
		return part;
	}

	return {
		authoriseRead: (cache, principal) =>
			dependencies.authoriser.read(cache, principal),
		authoriseWrite: (cache, principal) =>
			dependencies.authoriser.write(cache, principal),

		resolveServableNar: (cache, hash) =>
			dependencies.nars.resolveServableNar(cache, hash),

		async cacheInfo(cache) {
			const record = await dependencies.caches.find(cache);
			if (record === undefined) {
				return;
			}
			return renderCacheInfo(record);
		},

		list: (cache, query) => dependencies.listing.list(cache, query),

		stageNar,
		beginNarUpload,
		uploadNarPart,
		completeNarUpload,
		abortNarUpload,

		commitNarinfo,
		remove: (cache, object, principal) =>
			dependencies.remover.remove(cache, object, principal)
	};
}

type CompletedMultipartInspection =
	| { readonly kind: 'missing' }
	| { readonly kind: 'mismatch' }
	| { readonly kind: 'valid'; readonly etag: string };

async function inspectCompletedMultipart(
	blobStore: BlobStore,
	key: string,
	fileHash: NixSha256HashString,
	expectedSize: number
): Promise<CompletedMultipartInspection> {
	const object = await blobStore.get(key, undefined);
	if (object === undefined) {
		return { kind: 'missing' };
	}
	if (object.stat.size !== expectedSize) {
		return { kind: 'mismatch' };
	}

	const actualSha256 = await sha256HexOfBody(object.body);
	return actualSha256 === sha256HexOf(fileHash)
		? { kind: 'valid', etag: object.stat.etag }
		: { kind: 'mismatch' };
}

async function abortOrConfirmMissingUpload(
	blobStore: BlobStore,
	key: string,
	uploadId: string
): Promise<void> {
	try {
		await blobStore.abortMultipartUpload(key, uploadId);
	} catch (error) {
		if (error instanceof NoSuchUploadError) {
			return;
		}

		throw error;
	}
}

async function sha256HexOfBody(
	body: ReadableStream<Uint8Array>
): Promise<string> {
	const digestStream = new crypto.DigestStream('SHA-256');
	const writer = digestStream.getWriter();
	const reader = body.getReader();

	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}

		await writer.write(value);
	}

	await writer.close();
	return bytesToHex(new Uint8Array(await digestStream.digest));
}

function parseMetadata(
	text: string,
	storePathHash: StorePathHash
): ParsedUploadPathMetadata {
	let narInfo;
	try {
		narInfo = parseNarInfo(text);
	} catch {
		throw new MalformedNarInfoError();
	}

	const parsed = uploadPathMetadataSchema.safeParse({
		storePathHash,
		storePath: narInfo.storePath.value,
		narHash: narInfo.narHash.toString(),
		narSize: narInfo.narSize,
		references: narInfo.references,
		deriver: narInfo.deriver,
		ca: narInfo.ca,
		fileHash: narInfo.fileHash.toString(),
		fileSize: narInfo.fileSize,
		compression: narInfo.compression
	});

	if (!parsed.success) {
		throw new NarInfoMismatchError();
	}

	return parsed.data;
}

async function readBoundedText(
	body: ReadableStream<Uint8Array>,
	maxBytes: number
): Promise<string> {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;

	for (;;) {
		const { done: isDone, value } = await reader.read();
		if (isDone) {
			break;
		}

		total += value.length;
		if (total > maxBytes) {
			await reader.cancel();
			throw new NarInfoTooLargeError();
		}
		chunks.push(value);
	}

	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.length;
	}
	return new TextDecoder().decode(merged);
}

async function renderCacheInfo(
	record: CacheRecord
): Promise<RenderedCacheInfo> {
	const { body, etag, lastModified } = await renderNixCacheInfoObject(record);

	return { body, etag, lastModified };
}
