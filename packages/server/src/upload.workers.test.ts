import { CacheInfo, NarInfo } from '@cupboard/shared';
import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildVersion } from './build-info.generated.ts';
import { narInfoObjectKey, narObjectKey } from './http.ts';
import {
	afterGrace,
	authorisedFetch,
	bootstrap,
	clearBlobStorage,
	commitPath,
	commitSharedPath,
	commitUpload,
	currentOrigin,
	deletePath,
	deleteTestBase,
	expectConditionalNotModified,
	expectDateConditionalNotModified,
	expectNarResponse,
	expectSingleCommitDecision,
	expectSingleUploadDecision,
	expectStats,
	expectStatsViaWorker,
	expectTextResponse,
	fetchNarInfo,
	fetchPath,
	initialise,
	initialiseViaWorker,
	listRoots,
	mintServerSignedToken,
	narBytes,
	narHash,
	negotiateUploads,
	negotiateViaWorker,
	nixSha256Hash,
	prepareUpload,
	prepareUploadViaWorker,
	putNarBytes,
	readFetch,
	readStoredNarInfo,
	removeRoot,
	resetTestServer,
	runGc,
	runGcFromInternalOrigin,
	runGcResult,
	scheduledController,
	setRoot,
	uploadBlobMetadata,
	uploadMetadata,
	useTestServer,
	verifyNarInfoSignature,
	workerFetch
} from './test-support.ts';
import worker from './worker.ts';

describe('upload flow', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		resetTestServer();

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

	it('bootstraps an admin token and keeps the signing key stable', async () => {
		const first = await bootstrap();
		const second = await bootstrap();

		expect(typeof first.token).toBe('string');
		expect(first.token).not.toBe('');
		expect(typeof first.publicKey).toBe('string');
		expect(first.publicKey).not.toBe('');

		expect({ url: first.url, publicKey: first.publicKey }).toStrictEqual({
			url: currentOrigin(),
			publicKey: first.publicKey
		});

		// A re-bootstrap mints a fresh token but never rotates the signing key.
		expect(second.token).not.toBe('');
		expect({ url: second.url, publicKey: second.publicKey }).toStrictEqual({
			url: currentOrigin(),
			publicKey: first.publicKey
		});

		await expectTextResponse('/pubkey', {
			body: `${first.publicKey}\n`,
			cacheControl: 'public, max-age=3600',
			contentType: 'text/plain; charset=utf-8',
			method: 'GET'
		});
	});

	it('rejects a bootstrap with the wrong or absent secret', async () => {
		const wrong = await fetchPath('/auth/bootstrap', {
			headers: { authorization: 'Bearer not-the-secret' },
			method: 'POST'
		});
		const missing = await fetchPath('/auth/bootstrap', { method: 'POST' });

		expect({
			wrong: { status: wrong.status, body: await wrong.text() },
			missing: { status: missing.status, body: await missing.text() }
		}).toStrictEqual({
			wrong: { status: StatusCodes.UNAUTHORIZED, body: 'Unauthorised\n' },
			missing: { status: StatusCodes.UNAUTHORIZED, body: 'Unauthorised\n' }
		});
	});

	it('rejects unauthenticated management requests', async () => {
		const stats = await fetchPath('/stats');
		const negotiate = await fetchPath('/uploads', {
			body: JSON.stringify({ paths: [] }),
			headers: {
				'content-type': 'application/json'
			},
			method: 'POST'
		});
		const commit = await fetchPath('/uploads/not-real/commit', {
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
			sigs: [expect.any(String)]
		});
		await expectTextResponse(
			`/${metadata.storePathHash}.narinfo`,
			{
				body: narInfo.render(),
				cacheControl: 'public, max-age=3600',
				contentType: 'text/x-nix-narinfo; charset=utf-8',
				method: 'HEAD'
			},
			readFetch
		);
		await expectConditionalNotModified(
			`/${metadata.storePathHash}.narinfo`,
			readFetch
		);
		await expectDateConditionalNotModified(
			`/${metadata.storePathHash}.narinfo`,
			readFetch
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
				sigs: [expect.any(String)]
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

	it('serves a narinfo from the Worker whose signature verifies', async () => {
		const init = await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(init.token, [metadata]),
			metadata
		);
		await prepareUpload(init.token, upload, metadata);
		await putNarBytes(upload.r2Key);
		await commitUpload(init.token, upload.uploadId);

		const narInfo = await fetchNarInfo(metadata.storePathHash);

		expect(await verifyNarInfoSignature(narInfo, init.publicKey)).toBe(true);
	});

	it('returns 404 for a narinfo that has not been committed', async () => {
		const response = await readFetch(`/${'a'.repeat(32)}.narinfo`);

		expect({
			status: response.status,
			body: await response.text()
		}).toStrictEqual({
			status: StatusCodes.NOT_FOUND,
			body: 'Not found\n'
		});
	});

	it('re-materialises a missing narinfo object on the next negotiate', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await prepareUpload(token, upload, metadata);
		await putNarBytes(upload.r2Key);
		await commitUpload(token, upload.uploadId);

		const original = await readStoredNarInfo(metadata.storePathHash);

		await env.BLOBS.delete(narInfoObjectKey(metadata.storePathHash));
		await expect(
			env.BLOBS.head(narInfoObjectKey(metadata.storePathHash))
		).resolves.toBeNull();

		const skip = await negotiateUploads(token, [metadata]);

		expect(skip.uploads).toStrictEqual([
			{
				action: 'skip',
				storePathHash: metadata.storePathHash,
				narHash: metadata.narHash
			}
		]);

		const healed = await readStoredNarInfo(metadata.storePathHash);

		expect(healed.body).toBe(original.body);
	});

	it('commits one of two concurrent commits and reports the other as already present', async () => {
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

		const [a, b] = await Promise.all([
			commitUpload(token, first.uploadId),
			commitUpload(token, second.uploadId)
		]);

		expect(
			[a, b].toSorted((left, right) => left.status.localeCompare(right.status))
		).toStrictEqual([
			{
				storePathHash: metadata.storePathHash,
				narHash: metadata.narHash,
				status: 'already-present'
			},
			{
				storePathHash: metadata.storePathHash,
				narHash: metadata.narHash,
				status: 'committed'
			}
		]);

		const stored = await readStoredNarInfo(metadata.storePathHash);

		expect(NarInfo.parse(stored.body).narHash).toBe(metadata.narHash);
	});

	it('clears the orphaned narinfo object when its NAR blob is gone', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await prepareUpload(token, upload, metadata);
		await putNarBytes(upload.r2Key);
		await commitUpload(token, upload.uploadId);

		await env.BLOBS.delete(narObjectKey(metadata.narHash));

		const retry = await negotiateUploads(token, [metadata]);

		expectSingleUploadDecision(retry, metadata);
		await expect(
			env.BLOBS.head(narInfoObjectKey(metadata.storePathHash))
		).resolves.toBeNull();
	});

	it('purges the cached narinfo when recovering from a missing NAR blob', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await prepareUpload(token, upload, metadata);
		await putNarBytes(upload.r2Key);
		await commitUpload(token, upload.uploadId);

		const cacheKey = new URL(
			`/${metadata.storePathHash}.narinfo`,
			currentOrigin()
		).toString();
		await readFetch(`/${metadata.storePathHash}.narinfo`);

		await expect(caches.default.match(cacheKey)).resolves.toBeInstanceOf(
			Response
		);

		await env.BLOBS.delete(narObjectKey(metadata.narHash));
		await negotiateUploads(token, [metadata]);

		await expect(caches.default.match(cacheKey)).resolves.toBeUndefined();
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

	it('keeps the shared blob accounting when an R2 head miss races a referencing path', async () => {
		const token = await initialise();
		const first = uploadMetadata({ fileSize: narBytes.byteLength });
		const second = uploadMetadata({
			fileSize: narBytes.byteLength,
			name: 'second',
			storePathHash: '22222222222222222222222222222222'
		});
		const third = uploadMetadata({
			fileSize: narBytes.byteLength,
			name: 'third',
			storePathHash: '33333333333333333333333333333333'
		});

		await commitPath(token, first);
		await commitSharedPath(token, second);

		// The blob object disappears, but two committed paths still reference it.
		await env.BLOBS.delete(narObjectKey(first.narHash));

		expectSingleUploadDecision(await negotiateUploads(token, [third]), third);

		await expectStats(token, {
			storePaths: 2,
			narBlobs: 1,
			pendingUploads: 1,
			totalFileSize: narBytes.byteLength
		});
	});

	it('purges a swept narinfo from the edge cache during GC', async () => {
		const token = await initialise();
		const kept = uploadMetadata({
			fileSize: narBytes.byteLength,
			name: 'kept'
		});
		const swept = uploadMetadata({
			fileSize: narBytes.byteLength,
			name: 'swept',
			storePathHash: '22222222222222222222222222222222',
			narHash: nixSha256Hash('2')
		});

		await commitPath(token, kept);
		await commitPath(token, swept);
		await setRoot(token, { name: 'main', targets: [kept.storePath] });

		const cacheKey = new URL(
			`/${swept.storePathHash}.narinfo`,
			currentOrigin()
		).toString();
		await readFetch(`/${swept.storePathHash}.narinfo`);

		await expect(caches.default.match(cacheKey)).resolves.toBeInstanceOf(
			Response
		);

		expect(await runGcResult()).toStrictEqual({
			ok: true,
			pendingUploadsDeleted: 0,
			rootsExpired: 0,
			pathsSwept: 1,
			narInfosDeleted: 1,
			blobsDeleted: 0
		});

		await expect(caches.default.match(cacheKey)).resolves.toBeUndefined();
	});

	it('does not purge the edge cache when GC runs from the internal cron origin', async () => {
		const token = await initialise();
		const kept = uploadMetadata({
			fileSize: narBytes.byteLength,
			name: 'kept'
		});
		const swept = uploadMetadata({
			fileSize: narBytes.byteLength,
			name: 'swept',
			storePathHash: '22222222222222222222222222222222',
			narHash: nixSha256Hash('2')
		});

		await commitPath(token, kept);
		await commitPath(token, swept);
		await setRoot(token, { name: 'main', targets: [kept.storePath] });

		const cacheKey = new URL(
			`/${swept.storePathHash}.narinfo`,
			currentOrigin()
		).toString();
		await readFetch(`/${swept.storePathHash}.narinfo`);

		await expect(caches.default.match(cacheKey)).resolves.toBeInstanceOf(
			Response
		);

		await runGcFromInternalOrigin();

		// The sweep removed the narinfo object, but a cron-origin GC cannot purge
		// the public edge cache, so the cached copy remains until its TTL lapses.
		await expect(
			env.BLOBS.head(narInfoObjectKey(swept.storePathHash))
		).resolves.toBeNull();
		await expect(caches.default.match(cacheKey)).resolves.toBeInstanceOf(
			Response
		);
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
			`/uploads/${upload.uploadId}/commit`,
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
		useTestServer('r2-config');

		try {
			const token = await initialise();
			const metadata = uploadMetadata({
				fileSize: narBytes.byteLength
			});
			const negotiate = await negotiateUploads(token, [metadata]);
			const upload = expectSingleUploadDecision(negotiate, metadata);
			const response = await authorisedFetch(
				`/uploads/${upload.uploadId}`,
				token,
				{
					body: JSON.stringify(uploadBlobMetadata(metadata)),
					headers: {
						'content-type': 'application/json'
					},
					method: 'PUT'
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
			`/uploads/${upload.uploadId}/commit`,
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
			`/uploads/${upload.uploadId}/commit`,
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

		const response = await authorisedFetch('/uploads', token, {
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
				`/uploads/${upload.uploadId}`,
				token,
				{
					body: JSON.stringify({
						...uploadBlobMetadata(metadata),
						...fields
					}),
					headers: {
						'content-type': 'application/json'
					},
					method: 'PUT'
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
		const response = await authorisedFetch('/uploads', token, {
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

		expect(await runGcResult()).toStrictEqual({
			ok: true,
			pendingUploadsDeleted: 1,
			rootsExpired: 0,
			pathsSwept: 0,
			narInfosDeleted: 0,
			blobsDeleted: 1
		});

		await expectStats(await initialise(), {
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

		expect(await runGcResult()).toStrictEqual({
			ok: true,
			pendingUploadsDeleted: 1,
			rootsExpired: 0,
			pathsSwept: 0,
			narInfosDeleted: 0,
			blobsDeleted: 0
		});

		await expectStats(await initialise(), {
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

		await expectStatsViaWorker(await initialiseViaWorker(), {
			storePaths: 0,
			narBlobs: 0,
			pendingUploads: 0,
			totalFileSize: 0
		});
		await expect(env.BLOBS.head(upload.r2Key)).resolves.toBeNull();
	});

	it('deletes a store path and defers the NAR deletion past the grace', async () => {
		vi.setSystemTime(deleteTestBase);

		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await commitPath(token, metadata);

		const served = await readFetch(`/${metadata.storePathHash}.narinfo`);

		expect(served.status).toBe(StatusCodes.OK);

		const deleted = await deletePath(token, metadata.storePathHash);

		expect(deleted).toStrictEqual({
			storePathHash: metadata.storePathHash,
			deleted: true,
			narScheduledForDeletion: true
		});

		const afterDelete = await readFetch(`/${metadata.storePathHash}.narinfo`);

		expect(afterDelete.status).toBe(StatusCodes.NOT_FOUND);
		await expectStats(token, {
			storePaths: 0,
			narBlobs: 0,
			pendingUploads: 0,
			totalFileSize: 0
		});

		await runGc();
		await expect(
			env.BLOBS.head(narObjectKey(metadata.narHash))
		).resolves.not.toBeNull();

		vi.setSystemTime(afterGrace());
		await runGc();
		await expect(
			env.BLOBS.head(narObjectKey(metadata.narHash))
		).resolves.toBeNull();
	});

	it('retains a NAR still referenced by another store path', async () => {
		vi.setSystemTime(deleteTestBase);

		const token = await initialise();
		const first = uploadMetadata({ fileSize: narBytes.byteLength });
		const second = uploadMetadata({
			fileSize: narBytes.byteLength,
			name: 'second',
			storePathHash: '22222222222222222222222222222222'
		});
		await commitPath(token, first);
		await commitSharedPath(token, second);

		const deletedFirst = await deletePath(token, first.storePathHash);

		expect(deletedFirst.narScheduledForDeletion).toBe(false);

		const secondServed = await readFetch(`/${second.storePathHash}.narinfo`);

		expect(secondServed.status).toBe(StatusCodes.OK);
		await expect(
			env.BLOBS.head(narObjectKey(first.narHash))
		).resolves.not.toBeNull();

		const deletedSecond = await deletePath(token, second.storePathHash);

		expect(deletedSecond.narScheduledForDeletion).toBe(true);

		vi.setSystemTime(afterGrace());
		await runGc();
		await expect(
			env.BLOBS.head(narObjectKey(second.narHash))
		).resolves.toBeNull();
	});

	it('is idempotent when deleting an absent store path', async () => {
		const token = await initialise();
		const result = await deletePath(token, '33333333333333333333333333333333');

		expect(result).toStrictEqual({
			storePathHash: '33333333333333333333333333333333',
			deleted: false,
			narScheduledForDeletion: false
		});
	});

	it('does not pull a scheduled NAR deletion forward', async () => {
		vi.setSystemTime(deleteTestBase);

		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await commitPath(token, metadata);
		await deletePath(token, metadata.storePathHash);

		// A fresh pending upload reuses the same r2Key, then expires, giving an
		// immediate (not_before = now) deletion trigger for the already-deferred
		// blob.
		expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);

		vi.setSystemTime(new Date(deleteTestBase.getTime() + 16 * 60 * 1000));
		await runGc();
		await expect(
			env.BLOBS.head(narObjectKey(metadata.narHash))
		).resolves.not.toBeNull();

		vi.setSystemTime(afterGrace());
		await runGc();
		await expect(
			env.BLOBS.head(narObjectKey(metadata.narHash))
		).resolves.toBeNull();
	});

	it('rejects an unauthenticated delete', async () => {
		const response = await fetchPath(
			'/paths/11111111111111111111111111111111',
			{
				method: 'DELETE'
			}
		);

		expect({
			status: response.status,
			body: await response.text()
		}).toStrictEqual({
			status: StatusCodes.UNAUTHORIZED,
			body: 'Unauthorised\n'
		});
	});

	it('rejects a malformed store path hash', async () => {
		const token = await initialise();
		const response = await authorisedFetch('/paths/not-a-valid-hash', token, {
			method: 'DELETE'
		});

		expect(response.status).toBe(StatusCodes.BAD_REQUEST);
	});

	it('recovers an interrupted narinfo deletion through GC', async () => {
		vi.setSystemTime(deleteTestBase);

		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await commitPath(token, metadata);

		const deleteSpy = vi
			.spyOn(env.BLOBS, 'delete')
			.mockRejectedValueOnce(new Error('simulated R2 outage'));

		const deleted = await deletePath(token, metadata.storePathHash);

		expect(deleted).toStrictEqual({
			storePathHash: metadata.storePathHash,
			deleted: true,
			narScheduledForDeletion: false
		});

		deleteSpy.mockRestore();

		// The row is gone, so the path is logically deleted, but the opportunistic
		// object cleanup failed: the narinfo object and its NAR both survive, and
		// the NAR is not scheduled yet.
		await expectStats(token, {
			storePaths: 0,
			narBlobs: 1,
			pendingUploads: 0,
			totalFileSize: narBytes.byteLength
		});
		await expect(
			env.BLOBS.head(narInfoObjectKey(metadata.storePathHash))
		).resolves.not.toBeNull();
		await expect(
			env.BLOBS.head(narObjectKey(metadata.narHash))
		).resolves.not.toBeNull();

		const recovered = await runGcResult();

		// GC flushed the durable queue: the narinfo object is gone and the NAR is
		// only now scheduled, with the grace starting from this removal.
		expect(recovered.narInfosDeleted).toBe(1);
		await expect(
			env.BLOBS.head(narInfoObjectKey(metadata.storePathHash))
		).resolves.toBeNull();
		await expect(
			env.BLOBS.head(narObjectKey(metadata.narHash))
		).resolves.not.toBeNull();

		vi.setSystemTime(afterGrace());
		await runGc();
		await expect(
			env.BLOBS.head(narObjectKey(metadata.narHash))
		).resolves.toBeNull();
	});

	it('retains a re-pushed path left dangling by an interrupted deletion', async () => {
		vi.setSystemTime(deleteTestBase);

		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await commitPath(token, metadata);

		const deleteSpy = vi
			.spyOn(env.BLOBS, 'delete')
			.mockRejectedValueOnce(new Error('simulated R2 outage'));
		await deletePath(token, metadata.storePathHash);
		deleteSpy.mockRestore();

		// The path is committed again before GC reaches the dangling queue entry.
		// Its blob and NAR survived the failed cleanup, so the commit reuses them.
		await commitSharedPath(token, metadata);

		const served = await readFetch(`/${metadata.storePathHash}.narinfo`);

		expect(served.status).toBe(StatusCodes.OK);

		const collected = await runGcResult();

		// The re-committed row owns a live object, so the stale entry is dropped
		// without deleting the object.
		expect(collected.narInfosDeleted).toBe(0);
		await expect(
			env.BLOBS.head(narInfoObjectKey(metadata.storePathHash))
		).resolves.not.toBeNull();

		const stillServed = await readFetch(`/${metadata.storePathHash}.narinfo`);

		expect(stillServed.status).toBe(StatusCodes.OK);
	});

	describe('retention roots', () => {
		const absentPath = '/nix/store/22222222222222222222222222222222-absent';

		it('creates a root with TTL expiry and target presence', async () => {
			vi.setSystemTime(deleteTestBase);

			const token = await initialise();
			const committed = uploadMetadata({ fileSize: narBytes.byteLength });
			await commitPath(token, committed);

			const summary = await setRoot(token, {
				name: 'github:owner/repo/main',
				targets: [committed.storePath, absentPath],
				ttlSeconds: 604_800
			});

			expect(summary).toStrictEqual({
				name: 'github:owner/repo/main',
				expiresAt: new Date(
					deleteTestBase.getTime() + 604_800 * 1000
				).toISOString(),
				expired: false,
				createdAt: deleteTestBase.toISOString(),
				updatedAt: deleteTestBase.toISOString(),
				targets: [
					{
						storePathHash: committed.storePathHash,
						storePath: committed.storePath,
						present: true
					},
					{
						storePathHash: '22222222222222222222222222222222',
						storePath: absentPath,
						present: false
					}
				]
			});
		});

		it('replaces the target set wholesale and resets the expiry', async () => {
			vi.setSystemTime(deleteTestBase);

			const token = await initialise();
			const first = '/nix/store/11111111111111111111111111111111-a';
			const second = '/nix/store/22222222222222222222222222222222-b';

			await setRoot(token, {
				name: 'pr-1',
				targets: [first],
				ttlSeconds: 604_800
			});

			const later = new Date(deleteTestBase.getTime() + 3600 * 1000);
			vi.setSystemTime(later);
			const summary = await setRoot(await initialise(), {
				name: 'pr-1',
				targets: [second]
			});

			expect(summary).toStrictEqual({
				name: 'pr-1',
				expired: false,
				createdAt: deleteTestBase.toISOString(),
				updatedAt: later.toISOString(),
				targets: [
					{
						storePathHash: '22222222222222222222222222222222',
						storePath: second,
						present: false
					}
				]
			});
		});

		it('deduplicates repeated targets instead of erroring', async () => {
			const token = await initialise();
			const path = '/nix/store/11111111111111111111111111111111-a';

			const summary = await setRoot(token, {
				name: 'main',
				targets: [path, path]
			});

			expect(summary.targets).toStrictEqual([
				{
					storePathHash: '11111111111111111111111111111111',
					storePath: path,
					present: false
				}
			]);
		});

		it('lists roots sorted by name and flags expired ones', async () => {
			vi.setSystemTime(deleteTestBase);

			const token = await initialise();
			const path = '/nix/store/11111111111111111111111111111111-a';

			await setRoot(token, { name: 'pr-9', targets: [path], ttlSeconds: 60 });
			await setRoot(token, { name: 'main', targets: [path] });

			vi.setSystemTime(new Date(deleteTestBase.getTime() + 120 * 1000));
			const { roots } = await listRoots(token);

			expect(
				roots.map((root) => ({
					name: root.name,
					expired: root.expired,
					expiresAt: root.expiresAt
				}))
			).toStrictEqual([
				{ name: 'main', expired: false, expiresAt: undefined },
				{
					name: 'pr-9',
					expired: true,
					expiresAt: new Date(deleteTestBase.getTime() + 60_000).toISOString()
				}
			]);
		});

		it('removes a root and is a no-op for an absent name', async () => {
			const token = await initialise();
			const path = '/nix/store/11111111111111111111111111111111-a';
			await setRoot(token, { name: 'pr-1', targets: [path] });

			const removed = await removeRoot(token, 'pr-1');
			const absent = await removeRoot(token, 'pr-1');
			const { roots } = await listRoots(token);

			expect({ removed, absent, roots }).toStrictEqual({
				removed: { name: 'pr-1', removed: true },
				absent: { name: 'pr-1', removed: false },
				roots: []
			});
		});

		it('requires auth for the root routes', async () => {
			const target = '/nix/store/11111111111111111111111111111111-a';
			const set = await fetchPath('/roots/main', {
				body: JSON.stringify({ targets: [target] }),
				headers: { 'content-type': 'application/json' },
				method: 'PUT'
			});
			const list = await fetchPath('/roots');
			const remove = await fetchPath('/roots/main', { method: 'DELETE' });

			expect([set.status, list.status, remove.status]).toStrictEqual([
				StatusCodes.UNAUTHORIZED,
				StatusCodes.UNAUTHORIZED,
				StatusCodes.UNAUTHORIZED
			]);
		});

		it('rejects a malformed root request', async () => {
			const token = await initialise();
			const response = await authorisedFetch('/roots/main', token, {
				body: JSON.stringify({ targets: [] }),
				headers: { 'content-type': 'application/json' },
				method: 'PUT'
			});

			expect(response.status).toBe(StatusCodes.BAD_REQUEST);
		});

		const hashA = '11111111111111111111111111111111';
		const hashB = '22222222222222222222222222222222';
		const hashC = '33333333333333333333333333333333';

		it('sweeps unreachable paths and keeps the rooted closure', async () => {
			vi.setSystemTime(deleteTestBase);

			const token = await initialise();
			const a = uploadMetadata({
				fileSize: narBytes.byteLength,
				name: 'a',
				storePathHash: hashA,
				narHash: nixSha256Hash('a'),
				references: [`${hashB}-b`]
			});
			const b = uploadMetadata({
				fileSize: narBytes.byteLength,
				name: 'b',
				storePathHash: hashB,
				narHash: nixSha256Hash('b'),
				references: []
			});
			const c = uploadMetadata({
				fileSize: narBytes.byteLength,
				name: 'c',
				storePathHash: hashC,
				narHash: nixSha256Hash('c'),
				references: []
			});
			await commitPath(token, a);
			await commitPath(token, b);
			await commitPath(token, c);
			await setRoot(token, { name: 'main', targets: [a.storePath] });

			expect(await runGcResult()).toStrictEqual({
				ok: true,
				pendingUploadsDeleted: 0,
				rootsExpired: 0,
				pathsSwept: 1,
				narInfosDeleted: 1,
				blobsDeleted: 0
			});

			await expect(env.BLOBS.head(narInfoObjectKey(hashC))).resolves.toBeNull();
			await expect(
				env.BLOBS.head(narInfoObjectKey(hashA))
			).resolves.not.toBeNull();
			await expect(
				env.BLOBS.head(narInfoObjectKey(hashB))
			).resolves.not.toBeNull();
		});

		it('skips the sweep when no root is defined', async () => {
			const token = await initialise();
			const path = uploadMetadata({ fileSize: narBytes.byteLength });
			await commitPath(token, path);

			expect(await runGcResult()).toStrictEqual({
				ok: true,
				pendingUploadsDeleted: 0,
				rootsExpired: 0,
				pathsSwept: 0,
				narInfosDeleted: 0,
				blobsDeleted: 0
			});
			await expect(
				env.BLOBS.head(narInfoObjectKey(path.storePathHash))
			).resolves.not.toBeNull();
		});

		it('skips the sweep when roots resolve to nothing committed', async () => {
			const token = await initialise();
			const committed = uploadMetadata({ fileSize: narBytes.byteLength });
			await commitPath(token, committed);
			await setRoot(token, {
				name: 'ghost',
				targets: ['/nix/store/99999999999999999999999999999999-absent']
			});

			expect(await runGcResult()).toStrictEqual({
				ok: true,
				pendingUploadsDeleted: 0,
				rootsExpired: 0,
				pathsSwept: 0,
				narInfosDeleted: 0,
				blobsDeleted: 0
			});
			await expect(
				env.BLOBS.head(narInfoObjectKey(committed.storePathHash))
			).resolves.not.toBeNull();
		});

		it('sweeps a path freed by an expired root while a live root remains', async () => {
			vi.setSystemTime(deleteTestBase);

			const token = await initialise();
			const a = uploadMetadata({
				fileSize: narBytes.byteLength,
				name: 'a',
				storePathHash: hashA,
				narHash: nixSha256Hash('a'),
				references: []
			});
			const b = uploadMetadata({
				fileSize: narBytes.byteLength,
				name: 'b',
				storePathHash: hashB,
				narHash: nixSha256Hash('b'),
				references: []
			});
			await commitPath(token, a);
			await commitPath(token, b);
			await setRoot(token, { name: 'keep', targets: [a.storePath] });
			await setRoot(token, {
				name: 'pr',
				targets: [b.storePath],
				ttlSeconds: 60
			});

			vi.setSystemTime(new Date(deleteTestBase.getTime() + 120_000));

			expect(await runGcResult()).toStrictEqual({
				ok: true,
				pendingUploadsDeleted: 0,
				rootsExpired: 1,
				pathsSwept: 1,
				narInfosDeleted: 1,
				blobsDeleted: 0
			});

			const { roots } = await listRoots(token);

			expect(roots.map((root) => root.name)).toStrictEqual(['keep']);
			await expect(env.BLOBS.head(narInfoObjectKey(hashB))).resolves.toBeNull();
			await expect(
				env.BLOBS.head(narInfoObjectKey(hashA))
			).resolves.not.toBeNull();
		});

		it('sweeps a path freed by the last expired root', async () => {
			vi.setSystemTime(deleteTestBase);

			const token = await initialise();
			const b = uploadMetadata({ fileSize: narBytes.byteLength });
			await commitPath(token, b);
			await setRoot(token, {
				name: 'pr',
				targets: [b.storePath],
				ttlSeconds: 60
			});

			vi.setSystemTime(new Date(deleteTestBase.getTime() + 120_000));

			expect(await runGcResult()).toStrictEqual({
				ok: true,
				pendingUploadsDeleted: 0,
				rootsExpired: 1,
				pathsSwept: 1,
				narInfosDeleted: 1,
				blobsDeleted: 0
			});

			const { roots } = await listRoots(token);

			expect(roots).toStrictEqual([]);
			await expect(
				env.BLOBS.head(narInfoObjectKey(b.storePathHash))
			).resolves.toBeNull();
		});

		it('keeps a NAR shared with a retained path', async () => {
			vi.setSystemTime(deleteTestBase);

			const token = await initialise();
			const a = uploadMetadata({
				fileSize: narBytes.byteLength,
				name: 'a',
				storePathHash: hashA,
				references: []
			});
			const c = uploadMetadata({
				fileSize: narBytes.byteLength,
				name: 'c',
				storePathHash: hashC,
				references: []
			});
			await commitPath(token, a);
			await commitSharedPath(token, c);
			await setRoot(token, { name: 'main', targets: [a.storePath] });

			vi.setSystemTime(afterGrace());

			expect(await runGcResult()).toStrictEqual({
				ok: true,
				pendingUploadsDeleted: 0,
				rootsExpired: 0,
				pathsSwept: 1,
				narInfosDeleted: 1,
				blobsDeleted: 0
			});

			await expect(env.BLOBS.head(narInfoObjectKey(hashC))).resolves.toBeNull();
			await expect(
				env.BLOBS.head(narObjectKey(narHash))
			).resolves.not.toBeNull();
			await expect(
				env.BLOBS.head(narInfoObjectKey(hashA))
			).resolves.not.toBeNull();
		});

		it('defers a swept path NAR until the grace elapses', async () => {
			vi.setSystemTime(deleteTestBase);

			const token = await initialise();
			const a = uploadMetadata({
				fileSize: narBytes.byteLength,
				name: 'a',
				storePathHash: hashA,
				narHash: nixSha256Hash('a'),
				references: []
			});
			const c = uploadMetadata({
				fileSize: narBytes.byteLength,
				name: 'c',
				storePathHash: hashC,
				narHash: nixSha256Hash('c'),
				references: []
			});
			await commitPath(token, a);
			await commitPath(token, c);
			await setRoot(token, { name: 'main', targets: [a.storePath] });

			expect(await runGcResult()).toStrictEqual({
				ok: true,
				pendingUploadsDeleted: 0,
				rootsExpired: 0,
				pathsSwept: 1,
				narInfosDeleted: 1,
				blobsDeleted: 0
			});
			await expect(
				env.BLOBS.head(narObjectKey(nixSha256Hash('c')))
			).resolves.not.toBeNull();

			vi.setSystemTime(afterGrace());

			expect(await runGcResult()).toStrictEqual({
				ok: true,
				pendingUploadsDeleted: 0,
				rootsExpired: 0,
				pathsSwept: 0,
				narInfosDeleted: 0,
				blobsDeleted: 1
			});
			await expect(
				env.BLOBS.head(narObjectKey(nixSha256Hash('c')))
			).resolves.toBeNull();
		});
	});

	describe('authentication', () => {
		it('accepts a bootstrap-minted admin token on each scope of route', async () => {
			const token = await initialise();
			const stats = await authorisedFetch('/stats', token);
			const setRootResponse = await authorisedFetch('/roots/main', token, {
				body: JSON.stringify({
					targets: ['/nix/store/11111111111111111111111111111111-a']
				}),
				headers: { 'content-type': 'application/json' },
				method: 'PUT'
			});

			expect([stats.status, setRootResponse.status]).toStrictEqual([
				StatusCodes.OK,
				StatusCodes.OK
			]);
		});

		it('refuses a write token on admin routes but accepts it on write routes', async () => {
			await initialise();
			const writeToken = await mintServerSignedToken('write');
			const target = '/nix/store/11111111111111111111111111111111-a';

			const setRoot = await authorisedFetch('/roots/main', writeToken, {
				body: JSON.stringify({ targets: [target] }),
				headers: { 'content-type': 'application/json' },
				method: 'PUT'
			});
			const stats = await authorisedFetch('/stats', writeToken);
			const removed = await authorisedFetch(
				'/paths/11111111111111111111111111111111',
				writeToken,
				{ method: 'DELETE' }
			);
			const gc = await authorisedFetch('/gc', writeToken, { method: 'POST' });

			expect({
				setRoot: setRoot.status,
				stats: { status: stats.status, body: await stats.text() },
				deletePath: removed.status,
				gc: gc.status
			}).toStrictEqual({
				setRoot: StatusCodes.OK,
				stats: { status: StatusCodes.FORBIDDEN, body: 'Forbidden\n' },
				deletePath: StatusCodes.FORBIDDEN,
				gc: StatusCodes.FORBIDDEN
			});
		});

		it.each([
			{
				name: 'a syntactically invalid token',
				token: () => Promise.resolve('not-a-jwt')
			},
			{
				name: 'a token signed by a foreign key',
				token: () => foreignKeyToken('admin')
			}
		])('rejects $name with 401', async ({ token }) => {
			const response = await authorisedFetch('/stats', await token());

			expect({
				status: response.status,
				body: await response.text()
			}).toStrictEqual({
				status: StatusCodes.UNAUTHORIZED,
				body: 'Unauthorised\n'
			});
		});

		it.each(['github:owner/repo/main', 'pr/123', 'a%b'])(
			'round-trips the root name %j through encode, route and decode',
			async (name) => {
				const token = await initialise();
				const target = '/nix/store/11111111111111111111111111111111-a';
				const set = await setRoot(token, { name, targets: [target] });

				expect(set.name).toBe(name);

				const { roots } = await listRoots(token);

				expect(roots.map((root) => root.name)).toStrictEqual([name]);

				const removed = await removeRoot(token, name);

				expect(removed).toStrictEqual({ name, removed: true });
			}
		);
	});
});

async function foreignKeyToken(scope: 'write' | 'admin'): Promise<string> {
	const { privateKey } = await generateKeyPair('EdDSA', { extractable: true });
	const issuedAt = Math.floor(Date.now() / 1000);

	return new SignJWT({ scope })
		.setProtectedHeader({ alg: 'EdDSA' })
		.setIssuer('cupboard')
		.setAudience('cupboard')
		.setSubject('attacker')
		.setIssuedAt(issuedAt)
		.setNotBefore(issuedAt)
		.setExpirationTime(issuedAt + 600)
		.sign(privateKey);
}
