import {
	type CommitResponse,
	DEFAULT_CACHE,
	type DeletePathResponse,
	NarInfo,
	NixSha256Hash,
	type RootListResponse,
	type RootRemoveResponse,
	type RootSetBody,
	type RootSetResponse,
	type StatsResponse,
	type UploadNegotiateResponse,
	type UploadPathMetadataFields,
	zstdCompressionStream
} from '@cupboard/shared';
import {
	createExecutionContext,
	runInDurableObject,
	waitOnExecutionContext
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { count, eq, isNull, sql } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { StatusCodes } from 'http-status-codes';
import { expect } from 'vitest';

import migrations from '../drizzle/migrations.js';

import { type AccessScope, mintAccessJwt } from './auth.ts';
import { generateSigningKey } from './crypto.ts';
import { blobState } from './db/d1-schema.ts';
import {
	authKeys,
	narInfos,
	pendingUploads,
	signingKeys
} from './db/schema.ts';
import {
	internalOrigin,
	narInfoObjectKey,
	orphanBlobDeletionGraceMs,
	stagingObjectKey
} from './http.ts';
import type { CupboardServer } from './worker.ts';
import worker from './worker.ts';

// A real zstd frame: it decompresses to a 1234-byte payload (the bytes
// `i % 256`), so the server's verify-before-serve decompress-and-rehash accepts
// it. `narHash`/`fileHash` are that payload's and this frame's Nix SHA-256s.
export const narBytes = new Uint8Array([
	40, 181, 47, 253, 96, 210, 3, 85, 8, 0, 4, 16, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
	10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
	29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47,
	48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66,
	67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85,
	86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103,
	104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118,
	119, 120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133,
	134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148,
	149, 150, 151, 152, 153, 154, 155, 156, 157, 158, 159, 160, 161, 162, 163,
	164, 165, 166, 167, 168, 169, 170, 171, 172, 173, 174, 175, 176, 177, 178,
	179, 180, 181, 182, 183, 184, 185, 186, 187, 188, 189, 190, 191, 192, 193,
	194, 195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 208,
	209, 210, 211, 212, 213, 214, 215, 216, 217, 218, 219, 220, 221, 222, 223,
	224, 225, 226, 227, 228, 229, 230, 231, 232, 233, 234, 235, 236, 237, 238,
	239, 240, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250, 251, 252, 253,
	254, 255, 1, 0, 0, 207, 7, 170, 53, 5
]);
export const narHash =
	'sha256:1qjpr1bqmj286dkawd7rrzplp9g0zdp50syslw15kg13pf2ra347';
export const fileHash = NixSha256Hash.parse(
	'sha256:0wzw5pz9bciz84825admrb4b848maxa2fh1isbsw4547mvra9czv'
);
export const deleteTestBase = new Date('2026-01-01T00:00:00.000Z');

let origin = 'https://cupboard.test';
let server = testServerFor('initial');
let nextTestServerId = 0;

export type UploadDecision = UploadNegotiateResponse['uploads'][number];
export type UploadActionDecision = Extract<
	UploadDecision,
	{ readonly action: 'upload' }
>;
export type CommitActionDecision = Extract<
	UploadDecision,
	{ readonly action: 'commit' }
>;

export interface GcResult {
	readonly ok: true;
	readonly pendingUploadsDeleted: number;
	readonly rootsExpired: number;
	readonly pathsSwept: number;
	readonly narInfosDeleted: number;
	readonly blobsDeleted: number;
}

/**
 * Points the harness at a fresh, isolated Durable Object so each test starts
 * from empty state. The origin and the DO name share the same counter so the
 * URL and the stub agree.
 */
export function resetTestServer(): void {
	origin = `https://cupboard-${String(nextTestServerId)}.test`;
	server = testServerFor(`test-${String(nextTestServerId)}`);
	nextTestServerId += 1;
}

/** The origin the harness is currently targeting. */
export function currentOrigin(): string {
	return origin;
}

/**
 * Redirects the harness at a named server, e.g. for a test that needs a
 * distinct DO from the one {@link resetTestServer} assigned.
 */
export function useTestServer(name: string): void {
	origin = `https://cupboard-${name}.test`;
	server = testServerFor(name);
}

export function testServerFor(name: string): DurableObjectStub<CupboardServer> {
	const id = env.CUPBOARD_DO.idFromName(name);

	return env.CUPBOARD_DO.get(id);
}

/** The Durable Object stub the harness is currently targeting. */
export function currentServer(): DurableObjectStub<CupboardServer> {
	return server;
}

export interface InitialisedServer {
	readonly url: string;
	readonly publicKey: string;
	readonly token: string;
}

/**
 * Brings a server up the way a deployment is: it mints an owner-equivalent admin
 * token from the active auth key and reads the published signing key, standing
 * in for what the old bootstrap exchange returned.
 */
export async function bootstrap(): Promise<InitialisedServer> {
	const token = await mintServerSignedToken('admin');
	const response = await fetchPath('/pubkey');
	const body = await response.text();

	return { url: origin, publicKey: body.trim(), token };
}

/** An admin token against the current per-test server. */
export function initialise(): Promise<string> {
	return mintServerSignedToken('admin');
}

/** An admin token against the shared `v1` server the Worker routes to. */
export function initialiseViaWorker(): Promise<string> {
	return mintServerSignedTokenFor(defaultWorkerServer(), 'admin');
}

/**
 * Mints an access token signed by the active server key for an arbitrary
 * scope, so tests can prove scope enforcement (e.g. a write token refused by
 * an admin route). The active key is the newest one still in service, matching
 * what the server mints with, so a token stays valid across a rotation.
 */
export function mintServerSignedToken(
	scope: AccessScope,
	subject = 'scope-test',
	callbackRoots?: readonly string[]
): Promise<string> {
	return mintServerSignedTokenFor(server, scope, subject, callbackRoots);
}

async function mintServerSignedTokenFor(
	stub: DurableObjectStub<CupboardServer>,
	scope: AccessScope,
	subject = 'scope-test',
	callbackRoots?: readonly string[]
): Promise<string> {
	// The auth key is created on first use; a JWKS request creates it without
	// minting anything, so reading it straight after always finds a key.
	await stub.fetch(new URL('/.well-known/jwks.json', origin));

	const key = await runInDurableObject(stub, (_instance, state) => {
		const database = drizzle(state.storage, { schema: { authKeys } });
		const row = database
			.select()
			.from(authKeys)
			.where(isNull(authKeys.retiredAt))
			.orderBy(sql`rowid`)
			.all()
			.at(-1);

		if (row === undefined) {
			throw new Error('expected an active auth key to mint a scoped token');
		}

		return {
			kid: row.kid,
			privateJwk: JSON.parse(row.privateJwkJson) as JsonWebKey
		};
	});

	return mintAccessJwt(
		key.privateJwk,
		{
			issuer: 'cupboard',
			audience: 'cupboard',
			subject,
			scope,
			kid: key.kid,
			ttlSeconds: 600,
			cbRoots: callbackRoots
		},
		new Date()
	);
}

export function fetchPath(
	pathname: string,
	init?: RequestInit
): Promise<Response> {
	return server.fetch(new URL(pathname, origin), init);
}

export function workerFetch(
	pathname: string,
	init?: RequestInit
): Promise<Response> {
	return defaultWorkerServer().fetch(new URL(pathname, origin), init);
}

export async function readFetch(
	pathname: string,
	init?: RequestInit,
	envOverride: Readonly<Record<string, string>> = {}
): Promise<Response> {
	const ctx = createExecutionContext();
	const request = new Request<unknown, IncomingRequestCfProperties>(
		new URL(pathname, origin),
		init as RequestInit<IncomingRequestCfProperties>
	);
	// Inject a per-call env copy so a test can vary deployment vars (e.g. the
	// private-read credential) without mutating the shared workers-pool `env`.
	const response = await worker.fetch(
		request,
		Object.assign({}, env, envOverride),
		ctx
	);
	await waitOnExecutionContext(ctx);

	return response;
}

export async function authorisedFetch(
	pathname: string,
	token: string,
	init: RequestInit = {}
): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set('authorization', `Bearer ${token}`);

	return fetchPath(pathname, {
		...init,
		headers
	});
}

export async function authorisedWorkerFetch(
	pathname: string,
	token: string,
	init: RequestInit = {}
): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set('authorization', `Bearer ${token}`);

	return workerFetch(pathname, {
		...init,
		headers
	});
}

export async function clearBlobStorage(): Promise<void> {
	const listed = await env.BLOBS.list();
	const keys = listed.objects.map((object) => object.key);

	await env.BLOBS.delete(keys);
}

/** The shared `blob_state` rows in D1, sorted by NAR hash for deterministic assertions. */
export async function blobStateNarHashes(): Promise<{ narHash: string }[]> {
	const rows = await drizzleD1(env.CUPBOARD_DB, { schema: { blobState } })
		.select({ narHash: blobState.narHash })
		.from(blobState)
		.all();

	return rows.toSorted((left, right) =>
		left.narHash > right.narHash ? 1 : -1
	);
}

/** How many shared blobs D1 records as available. */
export async function blobStateCount(): Promise<number> {
	const row = await drizzleD1(env.CUPBOARD_DB, { schema: { blobState } })
		.select({ count: count() })
		.from(blobState)
		.get();

	return row?.count ?? 0;
}

export function scheduledController(): ScheduledController {
	return {
		cron: '0 4 * * *',
		noRetry() {
			return;
		},
		scheduledTime: Date.now()
	};
}

export function defaultWorkerServer(): DurableObjectStub<CupboardServer> {
	const id = env.CUPBOARD_DO.idFromName('v1');

	return env.CUPBOARD_DO.get(id);
}

/** Prepends `/cache/<name>` to a path-scoped route for a named cache. */
export function cacheScopedPath(cache: string, suffix: string): string {
	return cache === DEFAULT_CACHE ? suffix : `/cache/${cache}${suffix}`;
}

export async function negotiateUploads(
	token: string,
	paths: readonly UploadPathMetadataFields[],
	cache: string = DEFAULT_CACHE
): Promise<UploadNegotiateResponse> {
	const response = await authorisedFetch(
		cacheScopedPath(cache, '/uploads'),
		token,
		{
			body: JSON.stringify({
				paths: paths.map((path) => uploadPathNegotiation(path))
			}),
			headers: {
				'content-type': 'application/json'
			},
			method: 'POST'
		}
	);

	expect(response.status).toBe(StatusCodes.OK);

	return response.json<UploadNegotiateResponse>();
}

export async function negotiateViaWorker(
	token: string,
	paths: readonly UploadPathMetadataFields[]
): Promise<UploadNegotiateResponse> {
	const response = await authorisedWorkerFetch('/uploads', token, {
		body: JSON.stringify({
			paths: paths.map((path) => uploadPathNegotiation(path))
		}),
		headers: {
			'content-type': 'application/json'
		},
		method: 'POST'
	});

	expect(response.status).toBe(StatusCodes.OK);

	return response.json<UploadNegotiateResponse>();
}

/**
 * Runs a store path through negotiate, prepare, upload and commit. Unlike the
 * step helpers it asserts nothing time-dependent, so a test can push several
 * paths in sequence without tripping over the upload-expiry comparison.
 */
export async function pushPath(
	token: string,
	metadata: UploadPathMetadataFields,
	cache: string = DEFAULT_CACHE,
	nar?: VerifiableNar
): Promise<void> {
	const decision = singleDecision(
		await negotiateUploads(token, [metadata], cache)
	);

	if (decision.action === 'skip') {
		return;
	}

	if (decision.action === 'upload') {
		const prepared = await authorisedFetch(
			cacheScopedPath(cache, `/uploads/${decision.uploadId}`),
			token,
			{
				body: JSON.stringify(uploadBlobMetadata(metadata)),
				headers: { 'content-type': 'application/json' },
				method: 'PUT'
			}
		);
		expect(prepared.status).toBe(StatusCodes.OK);

		await putNarBytes(decision.r2Key, nar);
	}

	await commitUpload(token, decision.uploadId, cache);
}

export async function commitUpload(
	token: string,
	uploadId: string,
	cache: string = DEFAULT_CACHE
): Promise<CommitResponse> {
	const response = await authorisedFetch(
		cacheScopedPath(cache, `/uploads/${uploadId}/commit`),
		token,
		{ method: 'POST' }
	);

	expect(response.status).toBe(StatusCodes.OK);

	return response.json<CommitResponse>();
}

export async function prepareUpload(
	token: string,
	decision: UploadActionDecision,
	metadata: UploadPathMetadataFields
): Promise<void> {
	const expectedExpiresAt = uploadExpiryFromNow();
	const response = await authorisedFetch(
		`/uploads/${decision.uploadId}`,
		token,
		{
			body: JSON.stringify(uploadBlobMetadata(metadata)),
			headers: {
				'content-type': 'application/json'
			},
			method: 'PUT'
		}
	);

	await expectPrepareUploadResponse(
		response,
		metadata,
		expectedExpiresAt,
		decision.uploadId
	);
}

export async function prepareUploadViaWorker(
	token: string,
	decision: UploadActionDecision,
	metadata: UploadPathMetadataFields
): Promise<void> {
	const expectedExpiresAt = uploadExpiryFromNow();
	const response = await authorisedWorkerFetch(
		`/uploads/${decision.uploadId}`,
		token,
		{
			body: JSON.stringify(uploadBlobMetadata(metadata)),
			headers: {
				'content-type': 'application/json'
			},
			method: 'PUT'
		}
	);

	await expectPrepareUploadResponse(
		response,
		metadata,
		expectedExpiresAt,
		decision.uploadId
	);
}

export async function commitPath(
	token: string,
	metadata: UploadPathMetadataFields,
	nar?: VerifiableNar
): Promise<void> {
	const upload = expectSingleUploadDecision(
		await negotiateUploads(token, [metadata]),
		metadata
	);
	await prepareUpload(token, upload, metadata);
	await putNarBytes(upload.r2Key, nar);
	await commitUpload(token, upload.uploadId);
}

export async function commitSharedPath(
	token: string,
	metadata: UploadPathMetadataFields
): Promise<void> {
	const decision = expectSingleCommitDecision(
		await negotiateUploads(token, [metadata]),
		metadata
	);
	await commitUpload(token, decision.uploadId);
}

export async function deletePath(
	token: string,
	storePathHash: string
): Promise<DeletePathResponse> {
	const response = await authorisedFetch(`/paths/${storePathHash}`, token, {
		method: 'DELETE'
	});

	expect(response.status).toBe(StatusCodes.OK);

	return response.json<DeletePathResponse>();
}

export async function setRoot(
	token: string,
	fields: { readonly name: string } & RootSetBody
): Promise<RootSetResponse> {
	const { name, ...body } = fields;
	const response = await authorisedFetch(
		`/roots/${encodeURIComponent(name)}`,
		token,
		{
			body: JSON.stringify(body),
			headers: { 'content-type': 'application/json' },
			method: 'PUT'
		}
	);

	expect(response.status).toBe(StatusCodes.OK);

	return response.json<RootSetResponse>();
}

export async function listRoots(token: string): Promise<RootListResponse> {
	const response = await authorisedFetch('/roots', token);

	expect(response.status).toBe(StatusCodes.OK);

	return response.json<RootListResponse>();
}

export async function removeRoot(
	token: string,
	name: string
): Promise<RootRemoveResponse> {
	const response = await authorisedFetch(
		`/roots/${encodeURIComponent(name)}`,
		token,
		{
			method: 'DELETE'
		}
	);

	expect(response.status).toBe(StatusCodes.OK);

	return response.json<RootRemoveResponse>();
}

export async function runGc(): Promise<void> {
	const token = await initialise();
	const response = await authorisedFetch('/gc', token, { method: 'POST' });

	expect(response.status).toBe(StatusCodes.OK);
}

export async function runGcResult(): Promise<GcResult> {
	const token = await initialise();
	const response = await authorisedFetch('/gc', token, { method: 'POST' });

	expect(response.status).toBe(StatusCodes.OK);

	return response.json<GcResult>();
}

/** Runs GC the way the cron does: through the internal origin, which cannot purge the edge cache. */
export async function runGcFromInternalOrigin(): Promise<void> {
	const token = await initialise();
	const response = await server.fetch(new URL('/gc', internalOrigin), {
		headers: { authorization: `Bearer ${token}` },
		method: 'POST'
	});

	expect(response.status).toBe(StatusCodes.OK);
}

export function afterGrace(): Date {
	return new Date(
		deleteTestBase.getTime() + orphanBlobDeletionGraceMs + 60_000
	);
}

export async function fetchNarInfo(storePathHash: string): Promise<NarInfo> {
	const response = await readFetch(`/${storePathHash}.narinfo`);

	expect(response.status).toBe(StatusCodes.OK);

	return NarInfo.parse(await response.text());
}

export async function expectNarResponse(
	hash: string,
	method: 'GET' | 'HEAD'
): Promise<void> {
	const response = await readFetch(`/nar/${hash}.nar.zst`, { method });
	const etag = response.headers.get('etag');

	expect({
		status: response.status,
		cacheControl: response.headers.get('cache-control'),
		contentLength: response.headers.get('content-length'),
		contentType: response.headers.get('content-type'),
		etag: typeof etag,
		lastModified: typeof response.headers.get('last-modified')
	}).toStrictEqual({
		status: StatusCodes.OK,
		cacheControl: 'public, max-age=31536000, immutable',
		contentLength: String(narBytes.length),
		contentType: 'application/zstd',
		etag: 'string',
		lastModified: 'string'
	});

	const body = new Uint8Array(await response.arrayBuffer());

	expect([...body]).toStrictEqual(method === 'HEAD' ? [] : [...narBytes]);
}

export async function expectConditionalNotModified(
	pathname: string,
	fetcher: (
		pathname: string,
		init?: RequestInit
	) => Promise<Response> = fetchPath
): Promise<void> {
	const fresh = await fetcher(pathname);
	const etag = fresh.headers.get('etag');

	expect(typeof etag).toBe('string');

	const response = await fetcher(pathname, {
		headers: {
			'if-none-match': etag ?? ''
		}
	});

	expect({
		status: response.status,
		body: await response.text(),
		cacheControl: response.headers.get('cache-control'),
		contentLength: response.headers.get('content-length'),
		etag: response.headers.get('etag')
	}).toStrictEqual({
		status: StatusCodes.NOT_MODIFIED,
		body: '',
		cacheControl: fresh.headers.get('cache-control'),
		contentLength: fresh.headers.get('content-length'),
		etag
	});
}

export async function expectDateConditionalNotModified(
	pathname: string,
	fetcher: (
		pathname: string,
		init?: RequestInit
	) => Promise<Response> = fetchPath
): Promise<void> {
	const fresh = await fetcher(pathname);
	const lastModified = fresh.headers.get('last-modified');

	expect(typeof lastModified).toBe('string');

	const response = await fetcher(pathname, {
		headers: {
			'if-modified-since': lastModified ?? ''
		}
	});

	expect({
		status: response.status,
		body: await response.text(),
		cacheControl: response.headers.get('cache-control'),
		contentLength: response.headers.get('content-length'),
		lastModified: response.headers.get('last-modified')
	}).toStrictEqual({
		status: StatusCodes.NOT_MODIFIED,
		body: '',
		cacheControl: fresh.headers.get('cache-control'),
		contentLength: fresh.headers.get('content-length'),
		lastModified
	});
}

export async function expectTextResponse(
	pathname: string,
	expected: {
		readonly body: string;
		readonly cacheControl: string;
		readonly contentType: string;
		readonly method: 'GET' | 'HEAD';
	},
	fetcher: (
		pathname: string,
		init?: RequestInit
	) => Promise<Response> = fetchPath
): Promise<void> {
	const response = await fetcher(pathname, { method: expected.method });
	const body = await response.text();

	expect({
		status: response.status,
		body,
		cacheControl: response.headers.get('cache-control'),
		contentLength: response.headers.get('content-length'),
		contentType: response.headers.get('content-type'),
		etag: typeof response.headers.get('etag'),
		lastModified:
			response.headers.get('last-modified') === null
				? undefined
				: typeof response.headers.get('last-modified')
	}).toStrictEqual({
		status: StatusCodes.OK,
		body: expected.method === 'HEAD' ? '' : expected.body,
		cacheControl: expected.cacheControl,
		contentLength: String(new TextEncoder().encode(expected.body).length),
		contentType: expected.contentType,
		etag: 'string',
		lastModified: pathname.endsWith('.narinfo') ? 'string' : undefined
	});
}

export async function expectStats(
	token: string,
	expected: StatsResponse
): Promise<void> {
	const response = await authorisedFetch('/stats', token);

	expect(response.status).toBe(StatusCodes.OK);
	expect(await response.json()).toStrictEqual(expected);
}

export async function expectStatsViaWorker(
	token: string,
	expected: StatsResponse
): Promise<void> {
	const response = await authorisedWorkerFetch('/stats', token);

	expect(response.status).toBe(StatusCodes.OK);
	expect(await response.json()).toStrictEqual(expected);
}

export interface VerifiableNar {
	readonly narBytes: Uint8Array;
	readonly narHash: string;
	readonly narSize: number;
	readonly fileHash: string;
}

const defaultNar: VerifiableNar = {
	narBytes,
	narHash,
	narSize: 1234,
	fileHash: fileHash.toString()
};

export async function putNarBytes(
	r2Key: string,
	nar: VerifiableNar = defaultNar
): Promise<void> {
	await env.BLOBS.put(r2Key, nar.narBytes, {
		sha256: NixSha256Hash.parse(nar.fileHash).digestBytes()
	});
}

function singleChunkStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		}
	});
}

/**
 * A distinct, self-consistent NAR for a seed: real zstd bytes whose decompressed
 * payload hashes to `narHash`, so the server's verify-before-serve accepts it.
 * Tests that need several distinct blobs (reference graphs, per-blob GC) build one
 * per path with this rather than fabricating unrelated hashes.
 */
export async function verifiableNar(seed: string): Promise<VerifiableNar> {
	const uncompressed = new TextEncoder().encode(
		`cupboard-nar:${seed}\n`.repeat(64)
	);
	const compressed = new Uint8Array(
		await new Response(
			singleChunkStream(uncompressed).pipeThrough(zstdCompressionStream())
		).arrayBuffer()
	);
	const narHashValue = NixSha256Hash.fromDigest(
		new Uint8Array(await crypto.subtle.digest('SHA-256', uncompressed))
	).toString();
	const fileHashValue = NixSha256Hash.fromDigest(
		new Uint8Array(await crypto.subtle.digest('SHA-256', compressed))
	).toString();

	return {
		narBytes: compressed,
		narHash: narHashValue,
		narSize: uncompressed.byteLength,
		fileHash: fileHashValue
	};
}

// Wraps `payload` in a single uncompressed-block ("stored") zstd frame. It
// decompresses to `payload` unchanged, so it shares its NAR hash with a normally
// compressed frame of the same bytes, but its compressed bytes differ. Valid for a
// payload of 257..65791 bytes (the 2-byte frame-content-size encoding).
function storedZstdFrame(payload: Uint8Array): Uint8Array {
	const size = payload.byteLength;
	const contentSize = size - 256; // 2-byte Frame_Content_Size stores value − 256
	const blockHeader = (size << 3) | 0b001; // last block, Raw_Block, `size` bytes

	return new Uint8Array([
		0x28,
		0xb5,
		0x2f,
		0xfd, // magic
		0x60, // header descriptor: 2-byte FCS, single segment
		contentSize & 0xff,
		(contentSize >> 8) & 0xff,
		blockHeader & 0xff,
		(blockHeader >> 8) & 0xff,
		(blockHeader >> 16) & 0xff,
		...payload
	]);
}

/**
 * The same NAR payload as {@link verifiableNar} for a seed, but encoded as an
 * uncompressed "stored" zstd frame. It decompresses to the same bytes — so it
 * shares the seed's `narHash` — yet its compressed bytes (and thus `fileHash`)
 * differ, modelling a client that compressed the same NAR with other zstd settings.
 */
export async function verifiableNarStored(
	seed: string
): Promise<VerifiableNar> {
	const uncompressed = new TextEncoder().encode(
		`cupboard-nar:${seed}\n`.repeat(64)
	);
	const frame = storedZstdFrame(uncompressed);

	return {
		narBytes: frame,
		narHash: NixSha256Hash.fromDigest(
			new Uint8Array(await crypto.subtle.digest('SHA-256', uncompressed))
		).toString(),
		narSize: uncompressed.byteLength,
		fileHash: NixSha256Hash.fromDigest(
			new Uint8Array(await crypto.subtle.digest('SHA-256', frame))
		).toString()
	};
}

/**
 * Reads a pending upload's verification verdict: `undefined` if the row is gone,
 * otherwise the stored verdict (`null`, `'pending'`, or `'mismatch'`).
 */
export async function pendingUploadVerdict(
	uploadId: string
): Promise<string | null | undefined> {
	return runInDurableObject(currentServer(), (_instance, state) => {
		const row = drizzle(state.storage, { schema: { pendingUploads } })
			.select({ verdict: pendingUploads.verdict })
			.from(pendingUploads)
			.where(eq(pendingUploads.id, uploadId))
			.get();

		return row === undefined ? undefined : row.verdict;
	});
}

export async function verifiablePath(
	seed: string,
	fields: {
		readonly name?: string;
		readonly storePathHash?: string;
		readonly references?: string[];
	}
): Promise<{ metadata: UploadPathMetadataFields; nar: VerifiableNar }> {
	const nar = await verifiableNar(seed);
	const metadata = uploadMetadata({
		name: fields.name,
		storePathHash: fields.storePathHash,
		references: fields.references,
		narHash: nar.narHash,
		narSize: nar.narSize,
		fileHash: nar.fileHash,
		fileSize: nar.narBytes.byteLength
	});

	return { metadata, nar };
}

/**
 * Negotiates, uploads and commits a path backed by a distinct verifiable NAR for
 * the seed, returning its metadata. Use for the second and later paths in a test:
 * each needs its own NAR hash so negotiate returns an `upload` rather than reusing
 * an earlier blob.
 */
export async function commitVerifiablePath(
	token: string,
	seed: string,
	fields: {
		readonly name?: string;
		readonly storePathHash?: string;
		readonly references?: string[];
	}
): Promise<UploadPathMetadataFields> {
	const { metadata, nar } = await verifiablePath(seed, fields);
	await commitPath(token, metadata, nar);

	return metadata;
}

/**
 * Marks a negotiated upload `pending` background verification, the verdict a
 * commit records for a blob above the inline-verify budget. Lets a test exercise
 * the background verify-and-commit pass without a multi-megabyte fixture.
 */
export async function markUploadPendingVerification(
	uploadId: string
): Promise<void> {
	await runInDurableObject(currentServer(), (_instance, state) => {
		drizzle(state.storage, { schema: { pendingUploads } })
			.update(pendingUploads)
			.set({ verdict: 'pending' })
			.where(eq(pendingUploads.id, uploadId))
			.run();
	});
}

/**
 * Rewrites fields on a committed narinfo row directly, to plant a stored blob
 * that disagrees with the hash or size its narinfo signed — a state a normal
 * verified commit cannot produce, so that the deep storage check's NAR
 * re-derivation can be exercised.
 */
export async function corruptCommittedNarInfo(
	storePathHash: string,
	fields: Partial<{ narHash: string; narSize: number }>
): Promise<void> {
	await runInDurableObject(currentServer(), (_instance, state) => {
		drizzle(state.storage, { schema: { narInfos } })
			.update(narInfos)
			.set(fields)
			.where(eq(narInfos.storePathHash, storePathHash))
			.run();
	});
}

export async function verifyNarInfoSignature(
	narInfo: NarInfo,
	publicKey: string
): Promise<boolean> {
	if (narInfo.sigs.length === 0) {
		return false;
	}

	const key = parseNamedBytes(publicKey);
	const imported = await crypto.subtle.importKey(
		'raw',
		key.bytes,
		'Ed25519',
		false,
		['verify']
	);
	const fingerprint = new TextEncoder().encode(narInfo.fingerprint());

	const verifications = await Promise.all(
		narInfo.sigs.map((signature) =>
			crypto.subtle.verify(
				'Ed25519',
				imported,
				parseNamedBytes(signature).bytes,
				fingerprint
			)
		)
	);

	return verifications.some(Boolean);
}

function parseNamedBytes(value: string): { readonly bytes: Uint8Array } {
	const encoded = value.slice(value.indexOf(':') + 1);
	const decoded = atob(encoded);

	return {
		bytes: Uint8Array.from(
			decoded,
			(character) => character.codePointAt(0) ?? 0
		)
	};
}

export async function readStoredNarInfo(storePathHash: string): Promise<{
	readonly body: string;
	readonly etag: string;
	readonly contentType: string | undefined;
	readonly cacheControl: string | undefined;
}> {
	const object = await env.BLOBS.get(narInfoObjectKey(storePathHash));

	if (object === null) {
		throw new Error(`expected a stored narinfo object for ${storePathHash}`);
	}

	return {
		body: await object.text(),
		etag: object.httpEtag,
		contentType: object.httpMetadata?.contentType,
		cacheControl: object.httpMetadata?.cacheControl
	};
}

export function uploadBlobMetadata(metadata: UploadPathMetadataFields) {
	return {
		fileHash: metadata.fileHash,
		fileSize: metadata.fileSize,
		compression: metadata.compression
	};
}

export function uploadPathNegotiation(metadata: UploadPathMetadataFields) {
	return {
		storePathHash: metadata.storePathHash,
		storePath: metadata.storePath,
		narHash: metadata.narHash,
		narSize: metadata.narSize,
		references: metadata.references,
		deriver: metadata.deriver,
		ca: metadata.ca
	};
}

export function uploadMetadata(
	fields: Partial<UploadPathMetadataFields> & {
		readonly fileSize: number;
		readonly name?: string;
		readonly storePathHash?: string;
	}
): UploadPathMetadataFields {
	const storePathHash =
		fields.storePathHash ?? '11111111111111111111111111111111';
	const name = fields.name ?? 'first';

	return {
		storePathHash,
		storePath: `/nix/store/${storePathHash}-${name}`,
		narHash: fields.narHash ?? narHash,
		narSize: fields.narSize ?? 1234,
		fileHash: fields.fileHash ?? fileHash.toString(),
		fileSize: fields.fileSize,
		compression: 'zstd',
		references: fields.references ?? [`${storePathHash}-${name}`],
		deriver: fields.deriver,
		ca: fields.ca
	};
}

export function nixSha256Hash(character: string): string {
	return `sha256:${character.repeat(52)}`;
}

export function expectSingleUploadDecision(
	response: UploadNegotiateResponse,
	metadata: UploadPathMetadataFields
): UploadActionDecision {
	const decision = singleDecision(response) as UploadActionDecision;
	const expiresAt = uploadExpiryFromNow();

	expect(typeof decision.uploadId).toBe('string');

	expect(response.uploads).toStrictEqual([
		{
			action: 'upload',
			storePathHash: metadata.storePathHash,
			narHash: metadata.narHash,
			uploadId: decision.uploadId,
			r2Key: stagingObjectKey(decision.uploadId),
			expiresAt
		}
	]);

	return decision;
}

export function expectSingleCommitDecision(
	response: UploadNegotiateResponse,
	metadata: UploadPathMetadataFields
): CommitActionDecision {
	const decision = singleDecision(response) as CommitActionDecision;

	expect(typeof decision.uploadId).toBe('string');

	expect(response.uploads).toStrictEqual([
		{
			action: 'commit',
			storePathHash: metadata.storePathHash,
			narHash: metadata.narHash,
			uploadId: decision.uploadId
		}
	]);

	return decision;
}

export function singleDecision(
	response: UploadNegotiateResponse
): UploadDecision {
	expect(response.uploads).toHaveLength(1);

	const [decision] = response.uploads;

	if (decision === undefined) {
		throw new Error('expected exactly one upload decision');
	}

	return decision;
}

export async function expectPrepareUploadResponse(
	response: Response,
	metadata: UploadPathMetadataFields,
	expiresAt: string,
	uploadId: string
): Promise<void> {
	expect(response.status).toBe(StatusCodes.OK);

	const body = await response.json<{
		readonly uploadUrl: string;
		readonly uploadHeaders: Readonly<Record<string, string>>;
		readonly expiresAt: string;
	}>();
	const uploadUrl = new URL(body.uploadUrl);

	expect({
		protocol: uploadUrl.protocol,
		hostname: uploadUrl.hostname,
		path: uploadUrl.pathname
			.split('/')
			.map((segment) => decodeURIComponent(segment)),
		hasSignature: uploadUrl.searchParams.has('X-Amz-Signature'),
		uploadHeaders: body.uploadHeaders,
		expiresAt: body.expiresAt
	}).toStrictEqual({
		protocol: 'https:',
		hostname: 'test-account-id.r2.cloudflarestorage.com',
		path: ['', 'cupboard-blobs', 'staging', `${uploadId}.nar.zst`],
		hasSignature: true,
		uploadHeaders: {
			'x-amz-checksum-sha256': NixSha256Hash.parse(
				metadata.fileHash
			).digestBase64()
		},
		expiresAt
	});
}

export function uploadExpiryFromNow(): string {
	return new Date(Date.now() + 15 * 60 * 1000).toISOString();
}

/** The highest migration index registered in `drizzle/migrations.js`. */
export const latestMigrationIndex = Math.max(
	...migrations.journal.entries.map((entry) => entry.idx)
);

function migrationsThrough(throughIndex: number) {
	return {
		journal: {
			...migrations.journal,
			entries: migrations.journal.entries.filter(
				(entry) => entry.idx <= throughIndex
			)
		},
		migrations: Object.fromEntries(
			Object.entries(migrations.migrations).filter(
				([key]) => Number.parseInt(key.slice(1), 10) <= throughIndex
			)
		)
	};
}

/**
 * Applies the registered migrations up to and including `throughIndex` against
 * a Durable Object's raw storage. Calling it twice with seeding in between lets
 * a test plant rows in an older table shape and then assert how a later
 * migration backfills them; the migrator skips migrations already applied.
 */
export async function migrateThrough(
	state: DurableObjectState,
	throughIndex: number
): Promise<void> {
	await migrate(drizzle(state.storage), migrationsThrough(throughIndex));
}

export interface SigningKeySeed {
	readonly id: string;
	readonly name: string;
	readonly signing: boolean;
	readonly published: boolean;
}

export interface SeededSigningKey {
	readonly id: string;
	readonly name: string;
	readonly publicKey: string;
}

/**
 * Plants signing keys directly in the current Durable Object's storage so a
 * test can exercise multi-key signing without going through key rotation. Run
 * it before the DO first loads its keys — the load is cached for the DO's
 * lifetime — i.e. before the first bootstrap or read.
 */
export async function seedSigningKeys(
	seeds: readonly SigningKeySeed[]
): Promise<SeededSigningKey[]> {
	return runInDurableObject(server, async (_instance, state) => {
		await migrateThrough(state, latestMigrationIndex);

		const database = drizzle(state.storage, { schema: { signingKeys } });
		const seeded: SeededSigningKey[] = [];

		for (const seed of seeds) {
			const generated = await generateSigningKey(seed.name);

			database
				.insert(signingKeys)
				.values({
					id: seed.id,
					privateJwkJson: JSON.stringify(generated.privateJwk),
					publicKey: generated.publicKey,
					signing: seed.signing,
					published: seed.published,
					createdAt: new Date().toISOString()
				})
				.run();

			seeded.push({
				id: seed.id,
				name: seed.name,
				publicKey: generated.publicKey
			});
		}

		return seeded;
	});
}
