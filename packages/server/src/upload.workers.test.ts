import {
	CacheInfo,
	type CommitResponse,
	type InitResponse,
	NarInfo,
	NixSha256Hash,
	type StatsResponse,
	type UploadNegotiateResponse,
	type UploadPathMetadataFields
} from '@cupboard/shared';
import {
	createExecutionContext,
	waitOnExecutionContext
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildVersion } from './build-info.generated.ts';
import { narInfoObjectKey } from './http.ts';
import type { CupboardServer } from './worker.ts';
import worker from './worker.ts';

const origin = 'https://cupboard.test';
const bootstrapToken = 'test-bootstrap';

const narBytes = new Uint8Array([40, 41, 42, 43]);
const narHash = nixSha256Hash('1');
const fileHash = NixSha256Hash.parse(
	'sha256:1m5g07jiajz7135sj3ap8h30s0n24nc6a2q3gsraqj3pfi0jw65l'
);
let nextTestServerId = 0;
let testServer = testServerFor('initial');

type UploadDecision = UploadNegotiateResponse['uploads'][number];
type UploadActionDecision = Extract<
	UploadDecision,
	{ readonly action: 'upload' }
>;
type CommitActionDecision = Extract<
	UploadDecision,
	{ readonly action: 'commit' }
>;

describe('upload flow', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		testServer = testServerFor(`test-${String(nextTestServerId)}`);
		nextTestServerId += 1;

		await clearBlobStorage();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('serves public cache metadata routes from the Worker', async () => {
		await expectTextResponse(
			'/nix-cache-info',
			{
				body: CacheInfo.default.render(),
				cacheControl: 'public, max-age=3600',
				contentType: 'text/x-nix-cache-info; charset=utf-8',
				method: 'GET'
			},
			readFetch
		);
		await expectTextResponse(
			'/nix-cache-info',
			{
				body: CacheInfo.default.render(),
				cacheControl: 'public, max-age=3600',
				contentType: 'text/x-nix-cache-info; charset=utf-8',
				method: 'HEAD'
			},
			readFetch
		);
		await expectTextResponse(
			'/_health',
			{
				body: 'ok\n',
				cacheControl: 'no-store',
				contentType: 'text/plain; charset=utf-8',
				method: 'GET'
			},
			readFetch
		);
		await expectTextResponse(
			'/_version',
			{
				body: `${buildVersion}\n`,
				cacheControl: 'no-store',
				contentType: 'text/plain; charset=utf-8',
				method: 'GET'
			},
			readFetch
		);
	});

	it('serves the public key from the Worker', async () => {
		const fromDurableObject = await workerFetch('/pubkey');
		const body = await fromDurableObject.text();
		const publicKey = body.trimEnd();

		expect(publicKey).not.toBe('');

		await expectTextResponse(
			'/pubkey',
			{
				body: `${publicKey}\n`,
				cacheControl: 'public, max-age=3600',
				contentType: 'text/plain; charset=utf-8',
				method: 'GET'
			},
			readFetch
		);
	});

	it('initialises once and keeps the signing key stable', async () => {
		const first = await initialiseRaw();
		const second = await initialiseRaw();

		expect(typeof first.token).toBe('string');
		expect(first.token).not.toBe('');
		expect(typeof first.publicKey).toBe('string');
		expect(first.publicKey).not.toBe('');

		expect(first).toStrictEqual({
			url: origin,
			token: first.token,
			publicKey: first.publicKey
		});
		expect(second).toStrictEqual({
			url: origin,
			token: '',
			publicKey: first.publicKey
		});

		await expectTextResponse('/pubkey', {
			body: `${first.publicKey}\n`,
			cacheControl: 'public, max-age=3600',
			contentType: 'text/plain; charset=utf-8',
			method: 'GET'
		});
	});

	it('rejects unauthorised admin requests', async () => {
		const stats = await fetchPath('/_stats');
		const negotiate = await fetchPath('/upload/negotiate', {
			body: JSON.stringify({ paths: [] }),
			headers: {
				'content-type': 'application/json'
			},
			method: 'POST'
		});
		const commit = await fetchPath('/upload/not-real/commit', {
			method: 'POST'
		});

		expect({
			stats: {
				status: stats.status,
				body: await stats.text()
			},
			negotiate: {
				status: negotiate.status,
				body: await negotiate.text()
			},
			commit: {
				status: commit.status,
				body: await commit.text()
			}
		}).toStrictEqual({
			stats: {
				status: StatusCodes.UNAUTHORIZED,
				body: 'Unauthorised\n'
			},
			negotiate: {
				status: StatusCodes.UNAUTHORIZED,
				body: 'Unauthorised\n'
			},
			commit: {
				status: StatusCodes.UNAUTHORIZED,
				body: 'Unauthorised\n'
			}
		});
	});

	it('negotiates, commits, serves narinfo and skips uploaded paths', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({
			fileSize: narBytes.byteLength
		});

		const negotiate = await negotiateUploads(token, [metadata]);
		const upload = expectSingleUploadDecision(negotiate, metadata);
		await prepareUpload(token, upload, metadata);
		await putNarBytes(upload.r2Key);

		const committed = await commitUpload(token, upload.uploadId);

		expect(committed).toStrictEqual({
			storePathHash: metadata.storePathHash,
			narHash: metadata.narHash,
			status: 'committed'
		});

		await expectStats(token, {
			storePaths: 1,
			narBlobs: 1,
			pendingUploads: 0,
			totalFileSize: narBytes.byteLength
		});

		const narInfo = await fetchNarInfo(metadata.storePathHash);
		const signature = narInfo.sig;

		expect(typeof signature).toBe('string');

		expect(narInfo.toFields()).toStrictEqual({
			storePath: metadata.storePath,
			url: `nar/${metadata.narHash}.nar.zst`,
			compression: 'zstd',
			fileHash: metadata.fileHash,
			fileSize: metadata.fileSize,
			narHash: metadata.narHash,
			narSize: metadata.narSize,
			references: metadata.references,
			deriver: undefined,
			ca: undefined,
			sig: signature
		});
		await expectTextResponse(`/${metadata.storePathHash}.narinfo`, {
			body: narInfo.render(),
			cacheControl: 'public, max-age=3600',
			contentType: 'text/x-nix-narinfo; charset=utf-8',
			method: 'HEAD'
		});
		await expectConditionalNotModified(`/${metadata.storePathHash}.narinfo`);
		await expectDateConditionalNotModified(
			`/${metadata.storePathHash}.narinfo`
		);

		const skip = await negotiateUploads(token, [metadata]);

		expect(skip.uploads).toStrictEqual([
			{
				action: 'skip',
				storePathHash: metadata.storePathHash,
				narHash: metadata.narHash
			}
		]);

		await expectNarResponse(metadata.narHash, 'GET');
		await expectNarResponse(metadata.narHash, 'HEAD');
		await expectNarResponse(metadata.narHash.replace(':', '%3A'), 'GET');
		await expectConditionalNotModified(
			`/nar/${metadata.narHash}.nar.zst`,
			readFetch
		);
		await expectDateConditionalNotModified(
			`/nar/${metadata.narHash}.nar.zst`,
			readFetch
		);
	});

	it('returns 404 for a valid NAR hash with no stored blob', async () => {
		const missing = await readFetch(`/nar/${nixSha256Hash('7')}.nar.zst`);

		expect({
			status: missing.status,
			body: await missing.text()
		}).toStrictEqual({
			status: StatusCodes.NOT_FOUND,
			body: 'Not found\n'
		});
	});

	it('materialises the signed narinfo to R2 once and never rewrites it', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		const first = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await prepareUpload(token, first, metadata);
		await putNarBytes(first.r2Key);

		const second = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await prepareUpload(token, second, metadata);

		const committed = await commitUpload(token, first.uploadId);

		expect(committed.status).toBe('committed');

		const stored = await readStoredNarInfo(metadata.storePathHash);
		const parsed = NarInfo.parse(stored.body);

		expect(typeof parsed.sig).toBe('string');
		expect({
			contentType: stored.contentType,
			cacheControl: stored.cacheControl,
			fields: parsed.toFields()
		}).toStrictEqual({
			contentType: 'text/x-nix-narinfo; charset=utf-8',
			cacheControl: 'public, max-age=3600',
			fields: {
				storePath: metadata.storePath,
				url: `nar/${metadata.narHash}.nar.zst`,
				compression: 'zstd',
				fileHash: metadata.fileHash,
				fileSize: metadata.fileSize,
				narHash: metadata.narHash,
				narSize: metadata.narSize,
				references: metadata.references,
				deriver: undefined,
				ca: undefined,
				sig: parsed.sig
			}
		});

		const recommit = await commitUpload(token, second.uploadId);

		expect(recommit.status).toBe('already-present');

		const after = await readStoredNarInfo(metadata.storePathHash);

		expect({ body: after.body, etag: after.etag }).toStrictEqual({
			body: stored.body,
			etag: stored.etag
		});
	});

	it('reuses an existing blob for another store path', async () => {
		const token = await initialise();
		const first = uploadMetadata({
			fileSize: narBytes.byteLength
		});
		const second = uploadMetadata({
			fileSize: narBytes.byteLength,
			name: 'second',
			storePathHash: '22222222222222222222222222222222'
		});

		const firstNegotiate = await negotiateUploads(token, [first]);
		const firstUpload = expectSingleUploadDecision(firstNegotiate, first);
		await prepareUpload(token, firstUpload, first);
		await putNarBytes(firstUpload.r2Key);
		await commitUpload(token, firstUpload.uploadId);

		const secondNegotiate = await negotiateUploads(token, [second]);
		const secondCommit = expectSingleCommitDecision(secondNegotiate, second);
		const committed = await commitUpload(token, secondCommit.uploadId);

		expect(committed).toStrictEqual({
			storePathHash: second.storePathHash,
			narHash: second.narHash,
			status: 'committed'
		});

		await expectStats(token, {
			storePaths: 2,
			narBlobs: 1,
			pendingUploads: 0,
			totalFileSize: narBytes.byteLength
		});
	});

	it('keeps an upload pending when the object size does not match metadata', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({
			fileSize: narBytes.byteLength + 1
		});
		const negotiate = await negotiateUploads(token, [metadata]);
		const upload = expectSingleUploadDecision(negotiate, metadata);
		await prepareUpload(token, upload, metadata);
		await putNarBytes(upload.r2Key);

		const response = await authorisedFetch(
			`/upload/${upload.uploadId}/commit`,
			token,
			{ method: 'POST' }
		);

		expect(response.status).toBe(StatusCodes.BAD_REQUEST);
		expect(await response.text()).toBe(
			'Uploaded object size does not match metadata\n'
		);

		await expectStats(token, {
			storePaths: 0,
			narBlobs: 0,
			pendingUploads: 1,
			totalFileSize: 0
		});
	});

	it('requires R2 presign configuration for upload decisions', async () => {
		const previousSecret = env.R2_SECRET_ACCESS_KEY;
		Object.assign(env, { R2_SECRET_ACCESS_KEY: '' });
		testServer = testServerFor(`r2-config-${String(nextTestServerId)}`);
		nextTestServerId += 1;

		try {
			const token = await initialise();
			const metadata = uploadMetadata({
				fileSize: narBytes.byteLength
			});
			const negotiate = await negotiateUploads(token, [metadata]);
			const upload = expectSingleUploadDecision(negotiate, metadata);
			const response = await authorisedFetch(
				`/upload/${upload.uploadId}/prepare`,
				token,
				{
					body: JSON.stringify(uploadBlobMetadata(metadata)),
					headers: {
						'content-type': 'application/json'
					},
					method: 'POST'
				}
			);

			expect({
				status: response.status,
				body: await response.text()
			}).toStrictEqual({
				status: StatusCodes.INTERNAL_SERVER_ERROR,
				body: 'R2 presign configuration is incomplete\n'
			});
		} finally {
			Object.assign(env, { R2_SECRET_ACCESS_KEY: previousSecret });
		}
	});

	it('keeps an upload pending when the object checksum does not match metadata', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({
			fileHash: nixSha256Hash('2'),
			fileSize: narBytes.byteLength
		});
		const negotiate = await negotiateUploads(token, [metadata]);
		const upload = expectSingleUploadDecision(negotiate, metadata);
		await prepareUpload(token, upload, metadata);
		await putNarBytes(upload.r2Key);

		const response = await authorisedFetch(
			`/upload/${upload.uploadId}/commit`,
			token,
			{ method: 'POST' }
		);

		expect({
			status: response.status,
			body: await response.text()
		}).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			body: 'Uploaded object SHA-256 checksum does not match metadata\n'
		});

		await expectStats(token, {
			storePaths: 0,
			narBlobs: 0,
			pendingUploads: 1,
			totalFileSize: 0
		});
	});

	it('keeps an upload pending when the object checksum is missing', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({
			fileSize: narBytes.byteLength
		});
		const negotiate = await negotiateUploads(token, [metadata]);
		const upload = expectSingleUploadDecision(negotiate, metadata);
		await prepareUpload(token, upload, metadata);
		await env.BLOBS.put(upload.r2Key, narBytes);

		const response = await authorisedFetch(
			`/upload/${upload.uploadId}/commit`,
			token,
			{ method: 'POST' }
		);

		expect({
			status: response.status,
			body: await response.text()
		}).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			body: 'Uploaded object SHA-256 checksum is missing\n'
		});

		await expectStats(token, {
			storePaths: 0,
			narBlobs: 0,
			pendingUploads: 1,
			totalFileSize: 0
		});
	});

	it.each([
		{
			fields: {
				narHash: 'sha256:not-a-valid-hash'
			},
			expectedBody:
				'Invalid upload metadata: NAR hash must be a sha256 Nix base32 hash\n'
		},
		{
			fields: {
				references: ['/nix/store/11111111111111111111111111111111-first']
			},
			expectedBody:
				'Invalid upload metadata: Invalid store path reference: /nix/store/11111111111111111111111111111111-first\n'
		}
	])('rejects invalid upload metadata', async ({ fields, expectedBody }) => {
		const token = await initialise();
		const metadata = uploadMetadata({
			fileSize: narBytes.byteLength,
			...fields
		});

		const response = await authorisedFetch('/upload/negotiate', token, {
			body: JSON.stringify({ paths: [metadata] }),
			headers: {
				'content-type': 'application/json'
			},
			method: 'POST'
		});

		expect({
			status: response.status,
			body: await response.text()
		}).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			body: expectedBody
		});

		await expectStats(token, {
			storePaths: 0,
			narBlobs: 0,
			pendingUploads: 0,
			totalFileSize: 0
		});
	});

	it.each([
		{
			fields: {
				fileHash: 'sha256:not-a-valid-hash'
			},
			expectedBody:
				'Invalid upload metadata: file hash must be a sha256 Nix base32 hash\n'
		},
		{
			fields: {
				fileSize: 0
			},
			expectedBody:
				'Invalid upload metadata: file size must be a positive integer\n'
		}
	])(
		'rejects invalid upload blob metadata',
		async ({ fields, expectedBody }) => {
			const token = await initialise();
			const metadata = uploadMetadata({
				fileSize: narBytes.byteLength
			});
			const upload = expectSingleUploadDecision(
				await negotiateUploads(token, [metadata]),
				metadata
			);
			const response = await authorisedFetch(
				`/upload/${upload.uploadId}/prepare`,
				token,
				{
					body: JSON.stringify({
						...uploadBlobMetadata(metadata),
						...fields
					}),
					headers: {
						'content-type': 'application/json'
					},
					method: 'POST'
				}
			);

			expect({
				status: response.status,
				body: await response.text()
			}).toStrictEqual({
				status: StatusCodes.BAD_REQUEST,
				body: expectedBody
			});

			await expectStats(token, {
				storePaths: 0,
				narBlobs: 0,
				pendingUploads: 1,
				totalFileSize: 0
			});
		}
	);

	it('rejects malformed JSON upload requests', async () => {
		const token = await initialise();
		const response = await authorisedFetch('/upload/negotiate', token, {
			body: '{',
			headers: {
				'content-type': 'application/json'
			},
			method: 'POST'
		});

		expect({
			status: response.status,
			body: await response.text()
		}).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			body: 'Invalid JSON request body\n'
		});
	});

	it('garbage-collects expired pending uploads', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

		const token = await initialise();
		const metadata = uploadMetadata({
			fileSize: narBytes.byteLength
		});

		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await prepareUpload(token, upload, metadata);
		await putNarBytes(upload.r2Key);

		await expect(env.BLOBS.head(upload.r2Key)).resolves.not.toBeNull();

		await expectStats(token, {
			storePaths: 0,
			narBlobs: 0,
			pendingUploads: 1,
			totalFileSize: 0
		});

		vi.setSystemTime(new Date('2026-01-01T00:16:00.000Z'));

		const response = await fetchPath('/_cron/gc', {
			method: 'POST'
		});

		expect(response.status).toBe(StatusCodes.OK);
		expect(
			await response.json<{
				readonly ok: true;
				readonly pendingUploadsDeleted: number;
				readonly blobsDeleted: number;
			}>()
		).toStrictEqual({
			ok: true,
			pendingUploadsDeleted: 1,
			blobsDeleted: 1
		});

		await expectStats(token, {
			storePaths: 0,
			narBlobs: 0,
			pendingUploads: 0,
			totalFileSize: 0
		});
		await expect(env.BLOBS.head(upload.r2Key)).resolves.toBeNull();
	});

	it('recovers stale committed metadata when the R2 object is missing', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({
			fileSize: narBytes.byteLength
		});
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await prepareUpload(token, upload, metadata);
		await putNarBytes(upload.r2Key);
		await commitUpload(token, upload.uploadId);
		await env.BLOBS.delete(upload.r2Key);

		const retry = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);

		expect(retry.r2Key).toBe(upload.r2Key);
		await expectStats(token, {
			storePaths: 0,
			narBlobs: 0,
			pendingUploads: 1,
			totalFileSize: 0
		});
	});

	it('keeps committed blobs when expired pending uploads reuse them', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

		const token = await initialise();
		const first = uploadMetadata({
			fileSize: narBytes.byteLength
		});
		const second = uploadMetadata({
			fileSize: narBytes.byteLength,
			name: 'second',
			storePathHash: '22222222222222222222222222222222'
		});
		const firstUpload = expectSingleUploadDecision(
			await negotiateUploads(token, [first]),
			first
		);
		await prepareUpload(token, firstUpload, first);
		await putNarBytes(firstUpload.r2Key);
		await commitUpload(token, firstUpload.uploadId);
		const secondCommit = expectSingleCommitDecision(
			await negotiateUploads(token, [second]),
			second
		);

		expect(secondCommit.uploadId).not.toBe('');

		await expectStats(token, {
			storePaths: 1,
			narBlobs: 1,
			pendingUploads: 1,
			totalFileSize: narBytes.byteLength
		});

		vi.setSystemTime(new Date('2026-01-01T00:16:00.000Z'));

		const response = await fetchPath('/_cron/gc', {
			method: 'POST'
		});

		expect(response.status).toBe(StatusCodes.OK);
		expect(
			await response.json<{
				readonly ok: true;
				readonly pendingUploadsDeleted: number;
				readonly blobsDeleted: number;
			}>()
		).toStrictEqual({
			ok: true,
			pendingUploadsDeleted: 1,
			blobsDeleted: 0
		});

		await expectStats(token, {
			storePaths: 1,
			narBlobs: 1,
			pendingUploads: 0,
			totalFileSize: narBytes.byteLength
		});
		await expectNarResponse(first.narHash, 'GET');
	});

	it('runs garbage collection from the scheduled Worker handler', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

		const token = await initialiseViaWorker();
		const metadata = uploadMetadata({
			fileSize: narBytes.byteLength,
			name: 'scheduled',
			storePathHash: '33333333333333333333333333333333'
		});
		const negotiation = await negotiateViaWorker(token, [metadata]);
		const upload = expectSingleUploadDecision(negotiation, metadata);
		await prepareUploadViaWorker(token, upload, metadata);
		await putNarBytes(upload.r2Key);

		await expectStatsViaWorker(token, {
			storePaths: 0,
			narBlobs: 0,
			pendingUploads: 1,
			totalFileSize: 0
		});

		vi.setSystemTime(new Date('2026-01-01T00:16:00.000Z'));
		await worker.scheduled(scheduledController(), env);

		await expectStatsViaWorker(token, {
			storePaths: 0,
			narBlobs: 0,
			pendingUploads: 0,
			totalFileSize: 0
		});
		await expect(env.BLOBS.head(upload.r2Key)).resolves.toBeNull();
	});
});

async function initialiseRaw(): Promise<InitResponse> {
	const response = await fetchPath('/admin/init', {
		headers: {
			authorization: `Bearer ${bootstrapToken}`
		},
		method: 'POST'
	});

	expect(response.status).toBe(StatusCodes.OK);

	return response.json<InitResponse>();
}

async function initialise(): Promise<string> {
	const body = await initialiseRaw();
	expect(body.token).toEqual(expect.any(String));
	expect(body.token).not.toBe('');

	return body.token;
}

async function negotiateUploads(
	token: string,
	paths: readonly UploadPathMetadataFields[]
): Promise<UploadNegotiateResponse> {
	const response = await authorisedFetch('/upload/negotiate', token, {
		body: JSON.stringify({ paths }),
		headers: {
			'content-type': 'application/json'
		},
		method: 'POST'
	});

	expect(response.status).toBe(StatusCodes.OK);

	return response.json<UploadNegotiateResponse>();
}

async function commitUpload(
	token: string,
	uploadId: string
): Promise<CommitResponse> {
	const response = await authorisedFetch(`/upload/${uploadId}/commit`, token, {
		method: 'POST'
	});

	expect(response.status).toBe(StatusCodes.OK);

	return response.json<CommitResponse>();
}

async function prepareUpload(
	token: string,
	decision: UploadActionDecision,
	metadata: UploadPathMetadataFields
): Promise<void> {
	const expectedExpiresAt = uploadExpiryFromNow();
	const response = await authorisedFetch(
		`/upload/${decision.uploadId}/prepare`,
		token,
		{
			body: JSON.stringify(uploadBlobMetadata(metadata)),
			headers: {
				'content-type': 'application/json'
			},
			method: 'POST'
		}
	);

	await expectPrepareUploadResponse(response, metadata, expectedExpiresAt);
}

async function fetchNarInfo(storePathHash: string): Promise<NarInfo> {
	const response = await fetchPath(`/${storePathHash}.narinfo`);

	expect(response.status).toBe(StatusCodes.OK);

	return NarInfo.parse(await response.text());
}

async function expectNarResponse(
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

async function expectConditionalNotModified(
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

async function expectDateConditionalNotModified(
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

async function expectTextResponse(
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

async function expectStats(
	token: string,
	expected: StatsResponse
): Promise<void> {
	const response = await authorisedFetch('/_stats', token);

	expect(response.status).toBe(StatusCodes.OK);
	expect(await response.json()).toStrictEqual(expected);
}

async function putNarBytes(r2Key: string): Promise<void> {
	await env.BLOBS.put(r2Key, narBytes, {
		sha256: fileHash.digestBytes()
	});
}

async function readStoredNarInfo(storePathHash: string): Promise<{
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

function uploadBlobMetadata(metadata: UploadPathMetadataFields) {
	return {
		fileHash: metadata.fileHash,
		fileSize: metadata.fileSize,
		compression: metadata.compression
	};
}

async function authorisedFetch(
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

function fetchPath(pathname: string, init?: RequestInit): Promise<Response> {
	return testServer.fetch(new URL(pathname, origin), init);
}

function workerFetch(pathname: string, init?: RequestInit): Promise<Response> {
	return defaultWorkerServer().fetch(new URL(pathname, origin), init);
}

async function readFetch(
	pathname: string,
	init?: RequestInit
): Promise<Response> {
	const ctx = createExecutionContext();
	const request = new Request<unknown, IncomingRequestCfProperties>(
		new URL(pathname, origin),
		init as RequestInit<IncomingRequestCfProperties>
	);
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);

	return response;
}

async function clearBlobStorage(): Promise<void> {
	const listed = await env.BLOBS.list();
	const keys = listed.objects.map((object) => object.key);

	await env.BLOBS.delete(keys);
}

function expectSingleUploadDecision(
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

async function expectPrepareUploadResponse(
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

async function initialiseViaWorker(): Promise<string> {
	const response = await workerFetch('/admin/init', {
		headers: {
			authorization: `Bearer ${bootstrapToken}`
		},
		method: 'POST'
	});

	expect(response.status).toBe(StatusCodes.OK);

	const body = await response.json<InitResponse>();
	expect(body.token).toEqual(expect.any(String));
	expect(body.token).not.toBe('');

	return body.token;
}

async function negotiateViaWorker(
	token: string,
	paths: readonly UploadPathMetadataFields[]
): Promise<UploadNegotiateResponse> {
	const response = await authorisedWorkerFetch('/upload/negotiate', token, {
		body: JSON.stringify({ paths }),
		headers: {
			'content-type': 'application/json'
		},
		method: 'POST'
	});

	expect(response.status).toBe(StatusCodes.OK);

	return response.json<UploadNegotiateResponse>();
}

async function prepareUploadViaWorker(
	token: string,
	decision: UploadActionDecision,
	metadata: UploadPathMetadataFields
): Promise<void> {
	const expectedExpiresAt = uploadExpiryFromNow();
	const response = await authorisedWorkerFetch(
		`/upload/${decision.uploadId}/prepare`,
		token,
		{
			body: JSON.stringify(uploadBlobMetadata(metadata)),
			headers: {
				'content-type': 'application/json'
			},
			method: 'POST'
		}
	);

	await expectPrepareUploadResponse(response, metadata, expectedExpiresAt);
}

function uploadExpiryFromNow(): string {
	return new Date(Date.now() + 15 * 60 * 1000).toISOString();
}

async function expectStatsViaWorker(
	token: string,
	expected: StatsResponse
): Promise<void> {
	const response = await authorisedWorkerFetch('/_stats', token);

	expect(response.status).toBe(StatusCodes.OK);
	expect(await response.json()).toStrictEqual(expected);
}

async function authorisedWorkerFetch(
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

function scheduledController(): ScheduledController {
	return {
		cron: '0 4 * * *',
		noRetry() {
			return;
		},
		scheduledTime: Date.now()
	};
}

function defaultWorkerServer(): DurableObjectStub<CupboardServer> {
	const id = env.CUPBOARD_DO.idFromName('v1');

	return env.CUPBOARD_DO.get(id);
}

function expectSingleCommitDecision(
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

function singleDecision(response: UploadNegotiateResponse): UploadDecision {
	expect(response.uploads).toHaveLength(1);

	const [decision] = response.uploads as readonly [UploadDecision];

	return decision;
}

function uploadMetadata(
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

function nixSha256Hash(character: string): string {
	return `sha256:${character.repeat(52)}`;
}

function testServerFor(name: string): DurableObjectStub<CupboardServer> {
	const id = env.CUPBOARD_DO.idFromName(name);

	return env.CUPBOARD_DO.get(id);
}
