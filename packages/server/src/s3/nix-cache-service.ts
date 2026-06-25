import { CacheInfo } from '@cupboard/nix-store/cache-info';
import { fromNixBase32 } from '@cupboard/nix-store/hash';
import { parseNarInfo } from '@cupboard/nix-store/narinfo';
import type {
	NixSha256HashString,
	StorePathHash
} from '@cupboard/nix-store/scalars';
import {
	type ParsedUploadPathMetadata,
	uploadPathMetadataSchema
} from '@cupboard/protocol/upload';
import {
	CommittedNarInfoUnreadableError,
	MalformedNarInfoError,
	NarChecksumMismatchError,
	NarInfoMismatchError,
	NarInfoNotCommittableError,
	NarInfoTooLargeError,
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
import { narInfoObjectKey } from '../http/http.ts';

import type { BlobStore } from './blob-store.ts';
import { type NixCacheObject } from './nix-cache-keys.ts';
import type {
	NixCacheBackend,
	RenderedCacheInfo
} from './nix-cache-object-store.ts';
import { renderUploadOrigin } from './upload-origin.ts';

/** A staged narinfo commit settles to one of these outcomes. */
export type CommitOutcome =
	| { readonly kind: 'settled' }
	| { readonly kind: 'deferred' };

/**
 * The terminal outcome of settling one upload: `servable` once the path is
 * verified and served; `mismatch` when the NAR fails its hash check or was never
 * staged; `over-quota` when the canonical size exceeds the tenant's quota;
 * `pending` when verification has not yet reached a verdict; `absent` when a
 * different version won the path.
 */
export type UploadSettlement =
	| 'servable'
	| 'mismatch'
	| 'over-quota'
	| 'pending'
	| 'absent';

/** A pending-upload row, as the commit pipeline consumes it. */
export interface PendingUploadRow {
	readonly id: string;
	readonly cache: string;
	readonly narHash: NixSha256HashString;
	readonly r2Key: string;
	readonly expectedSize: number;
	readonly metadataJson: string;
	readonly origin: string | undefined;
	readonly createdAt: string;
	readonly expiresAt: string;
}

/**
 * The commit pipeline, narrowed to what S3 ingestion drives: register a staged
 * upload, commit it, and settle a deferred verification synchronously so the
 * narinfo PUT only returns once the path is servable (S3 read-after-write).
 */
export interface IngestPipeline {
	registerPending(row: PendingUploadRow): void;
	commit(cache: string, uploadId: string): Promise<CommitOutcome>;
	settleUpload(uploadId: string): Promise<UploadSettlement>;
}

export interface CacheRecord {
	readonly priority: number;
	readonly createdAt: string;
}

export interface CacheRecords {
	find(cache: string): Promise<CacheRecord | undefined>;
}

export interface CacheAuthorizer {
	read(cache: string, principal: S3Principal | undefined): Promise<void>;
	write(cache: string, principal: S3Principal | undefined): Promise<void>;
}

export interface CacheListing {
	list(cache: string, query: ListObjectsQuery): Promise<ListObjectsResult>;
}

export interface CacheRemover {
	remove(
		cache: string,
		object: NixCacheObject,
		principal: S3Principal | undefined
	): Promise<void>;
}

export interface NarResolver {
	resolveServableNar(
		hash: NixSha256HashString
	): Promise<NixSha256HashString | undefined>;
}

export interface NixCacheServiceDeps {
	readonly tenant: string;
	readonly blobStore: BlobStore;
	readonly pipeline: IngestPipeline;
	readonly caches: CacheRecords;
	readonly authorizer: CacheAuthorizer;
	readonly listing: CacheListing;
	readonly remover: CacheRemover;
	readonly nars: NarResolver;
	readonly now: () => Date;
	readonly newId: () => string;
}

// A narinfo is a few hundred bytes of text; a body past this is refused before
// it is buffered into a string in the single-threaded Durable Object.
const maxNarInfoBodyBytes = 64 * 1024;

const stagingTtlMs = 15 * 60 * 1000;

function s3NarStagingKey(fileHash: NixSha256HashString): string {
	return `staging/s3/${fileHash}.nar.zst`;
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
	const bytes = fromNixBase32(fileHash.slice(sha256Prefix.length));
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isChecksumMismatch(error: unknown): boolean {
	return error instanceof Error && /sha-?256|checksum/i.test(error.message);
}

/**
 * The production {@link NixCacheBackend}: it stages NAR bytes in R2, drives the
 * existing verify/sign/commit pipeline for narinfo, and renders `nix-cache-info`
 * from the cache record. Reads, listing, authorisation and removal are delegated
 * to the injected collaborators.
 */
export function createNixCacheService(
	deps: NixCacheServiceDeps
): NixCacheBackend {
	async function stageNar(
		fileHash: NixSha256HashString,
		body: ReadableStream<Uint8Array>,
		meta: PutObjectMeta
	): Promise<PutObjectResult> {
		// The nar object is named by its file hash, so record it as the staged
		// object's SHA-256: R2 verifies the body against it and the commit pipeline
		// reads it back as the blob's file hash.
		try {
			return await deps.blobStore.put(
				s3NarStagingKey(fileHash),
				body,
				meta,
				sha256HexOf(fileHash)
			);
		} catch (error) {
			// R2 rejects a body that does not hash to the requested SHA-256: the
			// client uploaded bytes that do not match the file hash in the key.
			if (isChecksumMismatch(error)) {
				throw new NarChecksumMismatchError();
			}
			throw error;
		}
	}

	async function commitNarinfo(
		cache: string,
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

		const uploadId = deps.newId();
		const issued = deps.now();
		deps.pipeline.registerPending({
			id: uploadId,
			cache,
			narHash: metadata.narHash,
			r2Key: s3NarStagingKey(metadata.fileHash),
			expectedSize: metadata.fileSize,
			metadataJson: JSON.stringify(metadata),
			origin: renderUploadOrigin(principal),
			createdAt: issued.toISOString(),
			expiresAt: new Date(issued.getTime() + stagingTtlMs).toISOString()
		});

		let settlement: UploadSettlement;
		try {
			const outcome = await deps.pipeline.commit(cache, uploadId);
			settlement =
				outcome.kind === 'settled'
					? 'servable'
					: await deps.pipeline.settleUpload(uploadId);
		} catch (error) {
			translatePipelineError(error);
		}

		if (settlement !== 'servable') {
			throw settlementError(settlement);
		}

		const stat = await deps.blobStore.head(
			narInfoObjectKey(deps.tenant, storePathHash, cache)
		);

		// A servable verdict guarantees the served object exists; a missing one
		// here would be an internal inconsistency, not a client error.
		if (stat === undefined) {
			throw new CommittedNarInfoUnreadableError();
		}

		return { etag: stat.etag };
	}

	return {
		authorizeRead: (cache, principal) => deps.authorizer.read(cache, principal),
		authorizeWrite: (cache, principal) =>
			deps.authorizer.write(cache, principal),

		cacheExists: async (cache) => (await deps.caches.find(cache)) !== undefined,

		resolveServableNar: (hash) => deps.nars.resolveServableNar(hash),

		async cacheInfo(cache) {
			const record = await deps.caches.find(cache);
			if (record === undefined) {
				return;
			}
			return renderCacheInfo(record);
		},

		list: (cache, query) => deps.listing.list(cache, query),

		stageNar,
		beginNarUpload: (fileHash, meta) =>
			deps.blobStore.createMultipartUpload(s3NarStagingKey(fileHash), meta),
		uploadNarPart: (fileHash, uploadId, partNumber, body) =>
			deps.blobStore.uploadPart(
				s3NarStagingKey(fileHash),
				uploadId,
				partNumber,
				body
			),
		completeNarUpload: (fileHash, uploadId, parts) =>
			deps.blobStore.completeMultipartUpload(
				s3NarStagingKey(fileHash),
				uploadId,
				parts
			),
		abortNarUpload: (fileHash, uploadId) =>
			deps.blobStore.abortMultipartUpload(s3NarStagingKey(fileHash), uploadId),

		commitNarinfo,
		remove: (cache, object, principal) =>
			deps.remover.remove(cache, object, principal)
	};
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
	const body = new TextEncoder().encode(
		new CacheInfo('/nix/store', true, record.priority).render()
	);
	const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(body));
	const etag = [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');

	return { body, etag, lastModified: new Date(record.createdAt) };
}
