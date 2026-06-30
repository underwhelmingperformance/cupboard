import {
	DEFAULT_CACHE,
	nixSha256HashSchema,
	type NixSha256HashString,
	type Sha256HexDigest,
	sha256HexDigestSchema,
	type StorePathHash,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { StatusCodes } from 'http-status-codes';

import { sha256HexBytes } from '../crypto/crypto.ts';

const textHeaders = {
	'cache-control': 'public, max-age=3600',
	'x-content-type-options': 'nosniff'
};

// The origin the scheduled (cron) handler uses to reach the Durable Object. It
// is internal, so GC triggered through it cannot know the public URL clients
// cached under and must not attempt to purge the edge cache.
export const internalOrigin = 'https://cupboard.local';

// The most committed narinfo rows a single `GET /check` examines. The check is
// a bounded one-shot scan; its report flags when the cache held more than this.
export const checkBatchSize = 1000;

// The most committed narinfo rows a single `POST /verify` pass reconciles. The
// cron tick advances a cursor by one batch per run, wrapping at the end.
export const verificationBatchSize = 500;

// The verify-before-serve ceiling, keyed on the uncompressed NAR size
// (`narSize`, the cost of decompress-and-hash), not the compressed
// `fileSize`. Every commit defers to the verification pass; a blob above this
// bound cannot be decompressed within the worker CPU budget in any single
// pass, so the commit is rejected, since it could never be served.
//
// PROVISIONAL: awaits the step-1 runtime benchmark (real workerd throughput
// and whether the Durable Object honours `cpu_ms = 300000`); see PLAN.md V5
// step 1. The mechanism is correct at any value; only the bound is unmeasured.
export const verifiableMaxBytes = 4 * 1024 * 1024 * 1024;
export const maxAttestationBundleBytes = 1024 * 1024;

export const narInfoCacheTtlSeconds = 3600;

export const narInfoCacheControl = `public, max-age=${String(narInfoCacheTtlSeconds)}`;

// A deleted narinfo can still be served from a warm edge for up to its TTL, so a
// NAR it points at must outlive any such cached copy. The reaper arms an
// unreferenced blob for this long before collecting it, adding a margin over the
// TTL for edge propagation and clock skew.
export const blobReaperGraceMs = (narInfoCacheTtlSeconds + 600) * 1000;

// The most blobs the reaper arms or collects in a single bounded pass.
export const blobReaperBatchSize = 500;

export function narObjectKey(narHash: NixSha256HashString): string {
	return `nar/${narHash}.nar.zst`;
}

export function casObjectKey(digest: Sha256HexDigest): string {
	return `cas/${digest}`;
}

export function attestationListCachePath(
	tenant: string,
	storePathHash: StorePathHash,
	cache: string = DEFAULT_CACHE
): string {
	const suffix =
		cache === DEFAULT_CACHE
			? `/attestations/${storePathHash}`
			: `/cache/${cache}/attestations/${storePathHash}`;

	return `/t/${tenant}${suffix}`;
}

export function attestationListObjectKey(
	tenant: string,
	storePathHash: StorePathHash,
	cache: string = DEFAULT_CACHE
): string {
	const suffix =
		cache === DEFAULT_CACHE
			? `attestations/${storePathHash}`
			: `attestations/${cache}/${storePathHash}`;

	return `t/${tenant}/${suffix}`;
}

// Where a client uploads unverified bytes, private to one upload and grouped
// under its push so a credential scoped to `staging/<pushId>/` covers the whole
// push. The server verifies the bytes here, then promotes them into the shared
// `nar/<narHash>` key, so the canonical object only ever holds confirmed content
// and no client ever writes it directly.
export function stagingObjectKey(pushId: string, uploadId: string): string {
	return `staging/${pushId}/${uploadId}.nar.zst`;
}

// The prefix a push's staging objects share, the scope of its upload credential.
export function stagingPushPrefix(pushId: string): string {
	return `staging/${pushId}/`;
}

export function attestationStagingObjectKey(
	pushId: string,
	uploadId: string
): string {
	return `staging/${pushId}/attestations/${uploadId}`;
}

// The request path a narinfo is served and edge-cached under: under the tenant
// prefix, bare for the default cache and namespaced under `/cache/<cache>/` for a
// named one. The read path's edge-cache key and the deletion purge both build on
// this, so a narinfo's cached copy is keyed per tenant and two tenants sharing a
// host never collide on the same store-path hash.
export function narInfoCachePath(
	tenant: string,
	storePathHash: StorePathHash,
	cache: string = DEFAULT_CACHE
): string {
	const suffix =
		cache === DEFAULT_CACHE
			? `/${storePathHash}.narinfo`
			: `/cache/${cache}/${storePathHash}.narinfo`;

	return `/t/${tenant}${suffix}`;
}

// The sole narinfo-key constructor: never inline the prefix elsewhere. A narinfo's
// materialised R2 object is tenant-namespaced, so distrusting tenants never share a
// narinfo object even for the same store-path hash; the NAR bytes it points at stay
// in the shared, content-addressed `nar/<narHash>` namespace. A named cache nests a
// further segment. Store path hashes never contain a slash, so the shapes cannot
// collide.
export function narInfoObjectKey(
	tenant: string,
	storePathHash: StorePathHash,
	cache: string = DEFAULT_CACHE
): string {
	const suffix =
		cache === DEFAULT_CACHE
			? `narinfo/${storePathHash}`
			: `narinfo/${cache}/${storePathHash}`;

	return `t/${tenant}/${suffix}`;
}

export function parseNarName(name: string): NixSha256HashString | undefined {
	const suffix = '.nar.zst';

	if (!name.endsWith(suffix)) {
		return undefined;
	}

	const parsed = nixSha256HashSchema.safeParse(name.slice(0, -suffix.length));

	return parsed.success ? parsed.data : undefined;
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

	return Date.parse(ifModifiedSince) >= Date.parse(lastModified);
}

function isIfNoneMatchSatisfied(
	ifNoneMatch: string,
	etag: string | null
): boolean {
	const candidates = ifNoneMatch.split(',').map((value) => value.trim());

	// `*` matches whenever a representation exists, which it always does where
	// this is evaluated.
	if (candidates.includes('*')) {
		return true;
	}

	if (etag === null) {
		return false;
	}

	// If-None-Match uses weak comparison: a `W/` prefix on either side is
	// ignored, only the opaque tag is compared.
	const target = withoutWeakPrefix(etag);

	return candidates.some(
		(candidate) => withoutWeakPrefix(candidate) === target
	);
}

function withoutWeakPrefix(etag: string): string {
	return etag.startsWith('W/') ? etag.slice(2) : etag;
}

/** The deployment-wide plain-text 404. */
export function notFoundResponse(): Response {
	return new Response('Not found\n', {
		status: StatusCodes.NOT_FOUND,
		headers: { 'content-type': 'text/plain; charset=utf-8' }
	});
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
