import {
	type BootstrapResponse,
	type CommitResponse,
	type DeletePathResponse,
	NarInfo,
	NixSha256Hash,
	type RootListResponse,
	type RootRemoveResponse,
	type RootSetBody,
	type RootSetResponse,
	type StatsResponse,
	type UploadNegotiateResponse,
	type UploadPathMetadataFields
} from '@cupboard/shared';
import {
	createExecutionContext,
	runInDurableObject,
	waitOnExecutionContext
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { StatusCodes } from 'http-status-codes';
import { expect } from 'vitest';

import migrations from '../drizzle/migrations.js';

import { type AccessScope, mintAccessJwt } from './auth.ts';
import { generateSigningKey } from './crypto.ts';
import { authKeys, signingKeys } from './db/schema.ts';
import {
	internalOrigin,
	narInfoObjectKey,
	orphanBlobDeletionGraceMs
} from './http.ts';
import type { CupboardServer } from './worker.ts';
import worker from './worker.ts';

export const bootstrapSecret = 'test-bootstrap';

export const narBytes = new Uint8Array([40, 41, 42, 43]);
export const narHash = nixSha256Hash('1');
export const fileHash = NixSha256Hash.parse(
	'sha256:1m5g07jiajz7135sj3ap8h30s0n24nc6a2q3gsraqj3pfi0jw65l'
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

export async function bootstrap(): Promise<BootstrapResponse> {
	const response = await fetchPath('/auth/bootstrap', {
		headers: {
			authorization: `Bearer ${bootstrapSecret}`
		},
		method: 'POST'
	});

	expect(response.status).toBe(StatusCodes.OK);

	return response.json<BootstrapResponse>();
}

export async function initialise(): Promise<string> {
	const body = await bootstrap();
	expect(body.token).toEqual(expect.any(String));
	expect(body.token).not.toBe('');

	return body.token;
}

export async function initialiseViaWorker(): Promise<string> {
	const response = await workerFetch('/auth/bootstrap', {
		headers: {
			authorization: `Bearer ${bootstrapSecret}`
		},
		method: 'POST'
	});

	expect(response.status).toBe(StatusCodes.OK);

	const body = await response.json<BootstrapResponse>();
	expect(body.token).toEqual(expect.any(String));
	expect(body.token).not.toBe('');

	return body.token;
}

/**
 * Mints an access token signed by the active server key for an arbitrary
 * scope, so tests can prove scope enforcement (e.g. a write token refused by
 * an admin route). The bootstrap exchange only ever mints admin tokens, so the
 * private key is read straight from the DO's SQLite.
 */
export async function mintServerSignedToken(
	scope: AccessScope,
	subject = 'scope-test'
): Promise<string> {
	const privateJwk = await runInDurableObject(server, (_instance, state) => {
		const database = drizzle(state.storage, { schema: { authKeys } });
		const row = database
			.select()
			.from(authKeys)
			.where(eq(authKeys.id, 'active'))
			.get();

		if (row === undefined) {
			throw new Error('expected an active auth key to mint a scoped token');
		}

		return JSON.parse(row.privateJwkJson) as JsonWebKey;
	});

	return mintAccessJwt(
		privateJwk,
		{
			issuer: 'cupboard',
			audience: 'cupboard',
			subject,
			scope,
			ttlSeconds: 600
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

export async function negotiateUploads(
	token: string,
	paths: readonly UploadPathMetadataFields[]
): Promise<UploadNegotiateResponse> {
	const response = await authorisedFetch('/uploads', token, {
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

export async function commitUpload(
	token: string,
	uploadId: string
): Promise<CommitResponse> {
	const response = await authorisedFetch(`/uploads/${uploadId}/commit`, token, {
		method: 'POST'
	});

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

	await expectPrepareUploadResponse(response, metadata, expectedExpiresAt);
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

	await expectPrepareUploadResponse(response, metadata, expectedExpiresAt);
}

export async function commitPath(
	token: string,
	metadata: UploadPathMetadataFields
): Promise<void> {
	const upload = expectSingleUploadDecision(
		await negotiateUploads(token, [metadata]),
		metadata
	);
	await prepareUpload(token, upload, metadata);
	await putNarBytes(upload.r2Key);
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

export async function putNarBytes(r2Key: string): Promise<void> {
	await env.BLOBS.put(r2Key, narBytes, {
		sha256: fileHash.digestBytes()
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
			r2Key: `nar/${metadata.narHash}.nar.zst`,
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
	expiresAt: string
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
		path: ['', 'cupboard-blobs', 'nar', `${metadata.narHash}.nar.zst`],
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
