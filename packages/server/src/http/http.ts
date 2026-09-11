import {
	type CacheGeneration,
	type CacheScope,
	firstCacheGeneration,
	nixSha256HashSchema,
	type NixSha256HashString,
	type Sha256HexDigest,
	sha256HexDigestSchema,
	type StorePathHash,
	storePathHashSchema,
	type TenantId
} from '@cupboard/nix-store/scalars';
import type { PushId, UploadId } from '@cupboard/protocol/upload';
import { isWeakEtagMatch, parseHttpDate } from '@cupboard/shared/http-fields';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';

import { sha256HexBytes } from '../crypto/crypto.ts';

const textHeaders = {
	'cache-control': 'public, max-age=3600',
	'x-content-type-options': 'nosniff'
};

export const r2ObjectKeySchema = z.string().brand('R2ObjectKey');
export type R2ObjectKey = z.infer<typeof r2ObjectKeySchema>;

// Preserve the request's public origin across queued reconcile and teardown
// work. Those passes use it to construct public URLs and purge entries from the
// same edge-cache origin.
export const requestOriginSchema = z.string().brand('RequestOrigin');
export type RequestOrigin = z.infer<typeof requestOriginSchema>;

// Scheduled requests use this internal origin to reach the Durable Object. They
// cannot identify the public edge-cache origin, so they must not request a purge.
export const internalOrigin = requestOriginSchema.parse(
	'https://cupboard.local'
);

// `GET /check` is a bounded one-shot scan. Its response reports when more
// committed narinfos remain. A scan probes every row's narinfo object and every
// distinct NAR, and a deep scan also reads each NAR back, so a batch of 1,000
// makes at most 3,000 R2 requests, which `subrequest-budget.test.ts` checks
// against `subrequestsPerInvocation`.
export const checkBatchSize = 1000;

// Each `POST /verify` pass advances one cursor batch and wraps after the final
// row.
export const verificationBatchSize = 500;

// Verification decompresses and hashes the NAR, so this limit applies to
// `narSize`, not compressed `fileSize`. Every commit waits for verification.
// The limit must therefore fit one Worker invocation; a larger NAR is rejected
// because it could never become servable.
export const verifiableMaxBytes = 4 * 1024 * 1024 * 1024;

// Bound each claim by both row count and cumulative uncompressed NAR size.
// Reused objects require no decoding and add no bytes. Always admit the first
// fresh row so one NAR at the verification ceiling cannot starve.
export const verifyClaimBatchSize = 32;
export const verifyClaimMaxNarBytes = verifiableMaxBytes;

// Cross-deployment verification RPCs accept at most one ordinary maintenance
// batch. This bounds both the SQLite result materialised by a claim and the
// verdict array retained while the Durable Object applies it.
export const maxVerificationRpcRows = verificationBatchSize;

// A claim lease lasts longer than the Worker's five-minute CPU allowance.
// Active passes renew it halfway through, so network waits cannot let another
// pass claim the same row. A crashed pass releases its rows when the lease
// expires.
export const verifyClaimLeaseMs = 6 * 60 * 1000;

export const maxAttestationBundleBytes = 1024 * 1024;

export const narInfoCacheTtlSeconds = 3600;

export const narInfoCacheControl = `public, max-age=${String(narInfoCacheTtlSeconds)}, must-revalidate`;

// NAR bytes are content-addressed, so a stored response stays valid for as long
// as the cache keeps it. A deletion invalidates it by purging its tag, and a
// queued purge stays queued for the whole of this lifetime.
export const narCacheTtlSeconds = 31_536_000;

export const narCacheControl = `public, max-age=${String(narCacheTtlSeconds)}, immutable`;

// An edge can serve a deleted narinfo until its cache TTL expires. Keep an
// unreferenced NAR for the TTL plus a margin for propagation and clock skew.
export const blobReaperGraceMs = (narInfoCacheTtlSeconds + 600) * 1000;

export const blobReaperBatchSize = 500;

/**
 * How many object deletions one invocation flushes. The pass reads the due
 * markers with one statement and deletes each object with another, so the batch
 * leaves one statement of `statementAllowance` for the read.
 */
export function objectDeletionBatchSize(statementAllowance: number): number {
	return statementAllowance - 1;
}

/**
 * How many abandoned promotion reservations one invocation recovers. The pass
 * reads the stale reservations with one statement and spends three more on each
 * reservation it repairs.
 */
export function objectRecoveryBatchSize(statementAllowance: number): number {
	return Math.floor((statementAllowance - 1) / 3);
}

// Verification SQL reconstructs NAR object keys from `nar_hash`. Keep these
// fragments in sync with that query.
export const narObjectKeyPrefix = 'nar/';
export const narObjectKeySuffix = '.nar.zst';

export function narObjectKey(
	narHash: NixSha256HashString,
	incarnation = 1
): R2ObjectKey {
	const version = incarnation === 1 ? '' : `.${String(incarnation)}`;

	return r2ObjectKeySchema.parse(
		`${narObjectKeyPrefix}${narHash}${version}${narObjectKeySuffix}`
	);
}

export function casObjectKey(
	digest: Sha256HexDigest,
	incarnation = 1
): R2ObjectKey {
	const version = incarnation === 1 ? '' : `.${String(incarnation)}`;

	return r2ObjectKeySchema.parse(`cas/${digest}${version}`);
}

export function attestationListCachePath(
	tenant: TenantId,
	storePathHash: StorePathHash,
	cache: CacheScope
): string {
	const suffix =
		cache.kind === 'default'
			? `/attestations/${storePathHash}`
			: `/cache/${cache.name}/attestations/${storePathHash}`;

	return `/t/${tenant}${suffix}`;
}

export function attestationListObjectPrefix(tenant: TenantId): string {
	return `t/${tenant}/attestations/`;
}

export function attestationListObjectKey(
	tenant: TenantId,
	storePathHash: StorePathHash,
	cache: CacheScope,
	generation: CacheGeneration = firstCacheGeneration
): R2ObjectKey {
	return r2ObjectKeySchema.parse(
		`${cacheObjectPrefix(attestationListObjectPrefix(tenant), cache, generation)}${storePathHash}`
	);
}

// Clients upload to a push-specific staging key. Verification promotes
// confirmed bytes to the shared content-addressed NAR key, which clients never
// write directly.
export function stagingObjectKey(
	pushId: PushId,
	uploadId: UploadId
): R2ObjectKey {
	return r2ObjectKeySchema.parse(`staging/${pushId}/${uploadId}.nar.zst`);
}

export const stagingPrefix = 'staging/';

// Keep the trailing slash so a credential for one push cannot write beneath a
// longer push ID with the same prefix.
export function stagingPushPrefix(pushId: PushId): string {
	return `${stagingPrefix}${pushId}/`;
}

export function attestationStagingObjectKey(
	pushId: PushId,
	uploadId: UploadId
): R2ObjectKey {
	return r2ObjectKeySchema.parse(`staging/${pushId}/attestations/${uploadId}`);
}

// Keep narinfos tenant-scoped because tenants can trust different signatures
// for the same store path. NAR bytes remain shared by content hash. Named caches
// add one segment; store-path hashes contain no slash, so the key shapes cannot
// collide.
export function narInfoObjectPrefix(tenant: TenantId): string {
	return `t/${tenant}/narinfo/`;
}

export function narInfoObjectKey(
	tenant: TenantId,
	storePathHash: StorePathHash,
	cache: CacheScope,
	generation: CacheGeneration = firstCacheGeneration
): R2ObjectKey {
	return r2ObjectKeySchema.parse(
		`${cacheObjectPrefix(narInfoObjectPrefix(tenant), cache, generation)}${storePathHash}`
	);
}

/**
 * Where one cache keeps its path-keyed objects of a family, below that family's
 * own prefix: the cache's generation, then its name.
 *
 * A cache that has never been deleted stays at the keys it has always had, so
 * nothing has to be rewritten for it. From the second generation onwards the
 * key carries `generation/<n>/`, which is what separates one registration of a
 * cache name from the next: the objects of a deleted cache are not where its
 * successor reads.
 *
 * The two shapes cannot collide, even for a cache named `generation`. A
 * first-generation key has at most two segments below the family prefix, and a
 * later one has at least three.
 */
export function cacheObjectPrefix(
	familyPrefix: string,
	cache: CacheScope,
	generation: CacheGeneration = firstCacheGeneration
): string {
	const incarnation =
		generation === firstCacheGeneration
			? ''
			: `generation/${String(generation)}/`;
	const name = cache.kind === 'default' ? '' : `${cache.name}/`;

	return `${familyPrefix}${incarnation}${name}`;
}

export interface NarObjectName {
	readonly narHash: NixSha256HashString;
	readonly incarnation: number;
}

export function parseNarName(name: string): NarObjectName | undefined {
	const suffix = narObjectKeySuffix;

	if (!name.endsWith(suffix)) {
		return undefined;
	}

	const stem = name.slice(0, -suffix.length);
	const separator = stem.lastIndexOf('.');
	const hash = separator === -1 ? stem : stem.slice(0, separator);
	const incarnationText = separator === -1 ? '1' : stem.slice(separator + 1);
	const parsed = nixSha256HashSchema.safeParse(hash);
	const incarnation = Number(incarnationText);

	return parsed.success &&
		Number.isSafeInteger(incarnation) &&
		incarnation > 0 &&
		String(incarnation) === incarnationText
		? { narHash: parsed.data, incarnation }
		: undefined;
}

export function parseNarInfoName(name: string): StorePathHash | undefined {
	const suffix = '.narinfo';

	if (!name.endsWith(suffix)) {
		return undefined;
	}

	const parsed = storePathHashSchema.safeParse(name.slice(0, -suffix.length));

	return parsed.success ? parsed.data : undefined;
}

export function parseAttestationDigestName(
	name: string
): Sha256HexDigest | undefined {
	const parsed = sha256HexDigestSchema.safeParse(name);

	return parsed.success ? parsed.data : undefined;
}

export function isNotModified(request: Request, headers: Headers): boolean {
	const ifNoneMatch = request.headers.get('if-none-match');

	// RFC 7232: when If-None-Match is present it alone decides the result;
	// If-Modified-Since is only consulted in its absence.
	if (ifNoneMatch !== null) {
		return isIfNoneMatchSatisfied(ifNoneMatch, headers.get('etag'));
	}

	const lastModified = headers.get('last-modified');
	const ifModifiedSince = request.headers.get('if-modified-since');

	if (lastModified === null || ifModifiedSince === null) {
		return false;
	}

	const parsedIfModifiedSince = parseHttpDate(ifModifiedSince);
	const parsedLastModified = parseHttpDate(lastModified);

	return (
		parsedIfModifiedSince !== undefined &&
		parsedLastModified !== undefined &&
		parsedIfModifiedSince >= parsedLastModified
	);
}

function isIfNoneMatchSatisfied(
	ifNoneMatch: string,
	etag: string | null
): boolean {
	return isWeakEtagMatch(ifNoneMatch, etag);
}

export function notFoundResponse(): Response {
	return new Response('Not found\n', {
		status: StatusCodes.NOT_FOUND,
		headers: { 'content-type': 'text/plain; charset=utf-8' }
	});
}

/**
 * Returns a 404 that authenticated and mutable reads cannot retain.
 */
export function uncachedNotFoundResponse(): Response {
	const response = notFoundResponse();
	response.headers.set('cache-control', 'no-store');

	return response;
}

export async function textResponse(
	request: Request,
	body: string | TextBody,
	headers: Record<string, string>
): Promise<Response> {
	const responseHeaders = new Headers({ ...textHeaders, ...headers });
	const metadata =
		typeof body === 'string'
			? await textBodyMetadata(body)
			: await body.metadata();
	const text = typeof body === 'string' ? body : body.value;
	responseHeaders.set('etag', metadata.etag);
	responseHeaders.set('content-length', metadata.contentLength);

	if (isNotModified(request, responseHeaders)) {
		return new Response(undefined, {
			status: StatusCodes.NOT_MODIFIED,
			headers: responseHeaders
		});
	}

	return new Response(request.method === 'HEAD' ? undefined : text, {
		headers: responseHeaders
	});
}

interface TextBodyMetadata {
	readonly etag: string;
	readonly contentLength: string;
}

async function textBodyMetadata(body: string): Promise<TextBodyMetadata> {
	const encoder = new TextEncoder();
	const bytes = encoder.encode(body);

	return {
		etag: `"sha256:${await sha256HexBytes(bytes)}"`,
		contentLength: String(bytes.byteLength)
	};
}

export class TextBody {
	private metadataPromise: Promise<TextBodyMetadata> | undefined;

	constructor(public readonly value: string) {}

	metadata(): Promise<TextBodyMetadata> {
		this.metadataPromise ??= textBodyMetadata(this.value);

		return this.metadataPromise;
	}
}
