import { CacheInfo, NarInfo, NixSha256Hash } from '@cupboard/shared';
import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildVersion } from './build-info.generated.ts';
import {
	inlineVerifyMaxBytes,
	narInfoObjectKey,
	narObjectKey,
	verifiableMaxBytes
} from './http.ts';
import {
	afterGrace,
	authorisedFetch,
	authorisedWorkerFetch,
	bootstrap,
	clearBlobStorage,
	commitPath,
	commitSharedPath,
	commitUpload,
	commitVerifiablePath,
	currentOrigin,
	currentServer,
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
	fileHash,
	initialise,
	initialiseViaWorker,
	listRoots,
	markUploadCommitting,
	markUploadPendingVerification,
	mintServerSignedToken,
	narBytes,
	narHash,
	negotiateUploads,
	negotiateViaWorker,
	nixSha256Hash,
	pendingUploadVerdict,
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
	seedReservedNarInfo,
	setRoot,
	uploadBlobMetadata,
	uploadMetadata,
	uploadPathNegotiation,
	useTestServer,
	verifiableNar,
	verifiableNarStored,
	verifiablePath,
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
				cacheControl: 'no-cache',
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
			cacheControl: 'no-cache',
			contentType: 'text/plain; charset=utf-8',
			method: 'GET'
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
			stats: stats.status,
			negotiate: negotiate.status,
			commit: commit.status
		}).toStrictEqual({
			stats: StatusCodes.UNAUTHORIZED,
			negotiate: StatusCodes.UNAUTHORIZED,
			commit: StatusCodes.UNAUTHORIZED
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

	it('rejects an upload whose bytes do not match the declared NAR hash', async () => {
		const token = await initialise();
		// The declared narHash is not what the stored bytes decompress to, but the
		// compressed fileHash does match, so only the server-side decompress-verify
		// can catch it. Verify-before-serve must reject it and leave nothing servable.
		const metadata = uploadMetadata({
			name: 'tampered',
			storePathHash: '99999999999999999999999999999999',
			narHash: nixSha256Hash('9'),
			fileHash: fileHash.toString(),
			fileSize: narBytes.byteLength
		});
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await prepareUpload(token, upload, metadata);
		await putNarBytes(upload.r2Key);

		const commit = await authorisedFetch(
			`/uploads/${upload.uploadId}/commit`,
			token,
			{ method: 'POST' }
		);

		expect(commit.status).toBe(StatusCodes.UNPROCESSABLE_ENTITY);
		await expect(
			env.BLOBS.head(narInfoObjectKey(metadata.storePathHash))
		).resolves.toBeNull();
		await expect(env.BLOBS.head(upload.r2Key)).resolves.toBeNull();
	});

	it('rejects an inline upload of corrupt, undecompressable bytes as a 422', async () => {
		const token = await initialise();
		// Bytes that are not a valid zstd frame but whose declared compressed hash
		// matches, so only the decompress step can reject them. The error it raises
		// must surface as a clean 422, not a 500, and must reclaim the staging blob.
		const garbage = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
		const garbageFileHash = NixSha256Hash.fromDigest(
			new Uint8Array(await crypto.subtle.digest('SHA-256', garbage))
		).toString();
		const metadata = uploadMetadata({
			name: 'corrupt',
			storePathHash: 'f'.repeat(32),
			narHash: nixSha256Hash('1'),
			fileHash: garbageFileHash,
			fileSize: garbage.byteLength,
			narSize: 100
		});
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await prepareUpload(token, upload, metadata);
		await putNarBytes(upload.r2Key, {
			narBytes: garbage,
			narHash: metadata.narHash,
			narSize: 100,
			fileHash: garbageFileHash
		});

		const commit = await authorisedFetch(
			`/uploads/${upload.uploadId}/commit`,
			token,
			{ method: 'POST' }
		);

		expect(commit.status).toBe(StatusCodes.UNPROCESSABLE_ENTITY);
		await expect(
			env.BLOBS.head(narInfoObjectKey(metadata.storePathHash))
		).resolves.toBeNull();
		await expect(env.BLOBS.head(upload.r2Key)).resolves.toBeNull();
	});

	it('still accepts a correct upload of a narHash a bad upload was rejected for', async () => {
		const token = await initialise();
		const good = await verifiableNar('isolation-good');
		const wrong = await verifiableNar('isolation-wrong');

		// A bad upload claims `good`'s narHash but stages `wrong`'s bytes — whose own
		// compressed hash matches, so only the decompress-verify catches it.
		const badMetadata = uploadMetadata({
			name: 'bad',
			storePathHash: 'a'.repeat(32),
			narHash: good.narHash,
			fileHash: wrong.fileHash,
			fileSize: wrong.narBytes.byteLength,
			narSize: good.narSize
		});
		const bad = expectSingleUploadDecision(
			await negotiateUploads(token, [badMetadata]),
			badMetadata
		);
		await prepareUpload(token, bad, badMetadata);
		await putNarBytes(bad.r2Key, wrong);

		const badCommit = await authorisedFetch(
			`/uploads/${bad.uploadId}/commit`,
			token,
			{ method: 'POST' }
		);

		expect(badCommit.status).toBe(StatusCodes.UNPROCESSABLE_ENTITY);

		// The hash is not poisoned: a correct upload of `good` for another store path
		// still negotiates as an upload, verifies, commits, and is served.
		const goodMetadata = uploadMetadata({
			name: 'good',
			storePathHash: 'b'.repeat(32),
			narHash: good.narHash,
			fileHash: good.fileHash,
			fileSize: good.narBytes.byteLength,
			narSize: good.narSize
		});
		const goodUpload = expectSingleUploadDecision(
			await negotiateUploads(token, [goodMetadata]),
			goodMetadata
		);
		await prepareUpload(token, goodUpload, goodMetadata);
		await putNarBytes(goodUpload.r2Key, good);

		const goodCommit = await commitUpload(token, goodUpload.uploadId);
		const served = await readFetch(`/${goodMetadata.storePathHash}.narinfo`);

		expect(goodCommit.status).toBe('committed');
		expect(served.status).toBe(StatusCodes.OK);
		await expect(
			env.BLOBS.head(narObjectKey(good.narHash))
		).resolves.not.toBeNull();
	});

	it('makes two encodings of one NAR advertise the canonical stored object', async () => {
		const token = await initialise();
		const compressed = await verifiableNar('shared-encoding');
		const stored = await verifiableNarStored('shared-encoding');

		// Same NAR content, two distinct compressed encodings (so different fileHash).
		expect(compressed.narHash).toBe(stored.narHash);
		expect(compressed.fileHash).not.toBe(stored.fileHash);

		const first = uploadMetadata({
			name: 'first',
			storePathHash: 'a'.repeat(32),
			narHash: compressed.narHash,
			fileHash: compressed.fileHash,
			fileSize: compressed.narBytes.byteLength,
			narSize: compressed.narSize
		});
		const second = uploadMetadata({
			name: 'second',
			storePathHash: 'b'.repeat(32),
			narHash: stored.narHash,
			fileHash: stored.fileHash,
			fileSize: stored.narBytes.byteLength,
			narSize: stored.narSize
		});

		// Both negotiate as fresh uploads before either commits — the only window in
		// which two distinct encodings of one hash race.
		const firstUpload = expectSingleUploadDecision(
			await negotiateUploads(token, [first]),
			first
		);
		const secondUpload = expectSingleUploadDecision(
			await negotiateUploads(token, [second]),
			second
		);

		await prepareUpload(token, firstUpload, first);
		await putNarBytes(firstUpload.r2Key, compressed);
		await prepareUpload(token, secondUpload, second);
		await putNarBytes(secondUpload.r2Key, stored);

		await commitUpload(token, firstUpload.uploadId);
		await commitUpload(token, secondUpload.uploadId);

		// Both narinfos advertise the canonical object's fileHash — the one promoted
		// first — so a substituter fetching either downloads bytes whose hash matches.
		const firstInfo = await fetchNarInfo(first.storePathHash);
		const secondInfo = await fetchNarInfo(second.storePathHash);
		const canonical = await env.BLOBS.head(narObjectKey(compressed.narHash));

		if (canonical?.checksums.sha256 === undefined) {
			throw new Error('expected a canonical object with a checksum');
		}

		const canonicalFileHash = NixSha256Hash.fromDigest(
			new Uint8Array(canonical.checksums.sha256)
		).toString();

		expect(firstInfo.toFields().fileHash).toBe(compressed.fileHash);
		expect(secondInfo.toFields().fileHash).toBe(compressed.fileHash);
		expect(canonicalFileHash).toBe(compressed.fileHash);
	});

	it('records a durable mismatch verdict when background verification fails', async () => {
		const token = await initialise();
		const good = await verifiableNar('bg-good');
		const wrong = await verifiableNar('bg-wrong');
		const metadata = uploadMetadata({
			name: 'bg-fail',
			storePathHash: 'c'.repeat(32),
			narHash: good.narHash,
			fileHash: wrong.fileHash,
			fileSize: wrong.narBytes.byteLength,
			narSize: good.narSize
		});
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);

		await prepareUpload(token, upload, metadata);
		await putNarBytes(upload.r2Key, wrong);
		await markUploadPendingVerification(upload.uploadId);

		await currentServer().runVerification();

		// Background verification failed: it deleted the bad staging bytes but kept a
		// durable `mismatch` verdict (readable later by `push --wait`), committing
		// nothing servable.
		expect(await pendingUploadVerdict(upload.uploadId)).toBe('mismatch');
		await expect(env.BLOBS.head(upload.r2Key)).resolves.toBeNull();
		await expect(
			env.BLOBS.head(narInfoObjectKey(metadata.storePathHash))
		).resolves.toBeNull();

		// The terminal row is reaped once its observation window has passed.
		vi.setSystemTime(new Date('2026-01-01T00:16:00.000Z'));
		await currentServer().runGarbageCollection();

		expect(await pendingUploadVerdict(upload.uploadId)).toBeUndefined();
	});

	it('signs the canonical narSize on reuse, not a forged client value', async () => {
		const token = await initialise();
		const nar = await verifiableNar('reuse-narsize');
		const first = uploadMetadata({
			name: 'first',
			storePathHash: 'a'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});

		await commitPath(token, first, nar);

		// A second store path declares the same narHash but a forged, larger narSize.
		// The blob is reused (no re-upload), so the server must sign the verified
		// canonical narSize, not the unchecked declared one.
		const forged = uploadMetadata({
			name: 'forged',
			storePathHash: 'b'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize + 999_999
		});
		const reuse = expectSingleCommitDecision(
			await negotiateUploads(token, [forged]),
			forged
		);
		const commit = await commitUpload(token, reuse.uploadId);

		expect(commit.status).toBe('committed');

		const served = await fetchNarInfo(forged.storePathHash);

		expect(served.toFields().narSize).toBe(nar.narSize);
	});

	it('rejects preparing a reuse upload and leaves the canonical object untouched', async () => {
		const token = await initialise();
		const first = uploadMetadata({ fileSize: narBytes.byteLength });

		await commitPath(token, first);

		// A second store path negotiates a reuse decision for the same narHash.
		const second = uploadMetadata({
			name: 'second',
			storePathHash: '22222222222222222222222222222222',
			narHash: first.narHash,
			fileHash: first.fileHash,
			fileSize: narBytes.byteLength
		});
		const reuse = expectSingleCommitDecision(
			await negotiateUploads(token, [second]),
			second
		);

		// Preparing a reuse upload must be rejected outright: its r2Key is the shared
		// canonical key, so presigning it would hand out a direct write to the CAS
		// object that the reuse commit does not re-verify.
		const prepare = await authorisedFetch(`/uploads/${reuse.uploadId}`, token, {
			body: JSON.stringify(uploadBlobMetadata(second)),
			headers: { 'content-type': 'application/json' },
			method: 'PUT'
		});

		expect(prepare.status).toBe(StatusCodes.CONFLICT);
		await expect(
			env.BLOBS.head(narObjectKey(first.narHash))
		).resolves.not.toBeNull();
	});

	it('verifies and commits a deferred pending upload in the background pass', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await prepareUpload(token, upload, metadata);
		await putNarBytes(upload.r2Key);

		// A blob too large to verify inline commits as `pending`: stored, but not
		// servable until the background pass confirms its bytes. Simulate that
		// verdict without a multi-megabyte fixture.
		await markUploadPendingVerification(upload.uploadId);

		await expect(
			env.BLOBS.head(narInfoObjectKey(metadata.storePathHash))
		).resolves.toBeNull();

		// Past the 15-minute upload expiry: GC must not reap a pending upload, and
		// the background verify pass must then confirm and commit it.
		vi.setSystemTime(new Date('2026-01-01T00:16:00.000Z'));
		await currentServer().runGarbageCollection();
		await currentServer().runVerification();

		const narInfo = await fetchNarInfo(metadata.storePathHash);

		expect(narInfo.narHash).toBe(metadata.narHash);
		await expect(
			env.BLOBS.head(narInfoObjectKey(metadata.storePathHash))
		).resolves.not.toBeNull();
	});

	it('re-drives an inline commit crashed mid-saga from its committing marker', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await prepareUpload(token, upload, metadata);
		await putNarBytes(upload.r2Key);

		// An inline commit that crashed after marking itself in progress but before
		// reserving the row: the staging bytes are present, the upload carries the
		// `committing` marker, and nothing is servable yet.
		await markUploadCommitting(upload.uploadId);

		await expect(
			env.BLOBS.head(narInfoObjectKey(metadata.storePathHash))
		).resolves.toBeNull();

		// The verify pass re-drives it through the same reserve→verify→promote→
		// materialise path a deferred upload takes, then clears the marker.
		await currentServer().runVerification();

		expect(await pendingUploadVerdict(upload.uploadId)).toBeUndefined();
		const narInfo = await fetchNarInfo(metadata.storePathHash);
		expect(narInfo.narHash).toBe(metadata.narHash);
	});

	it('does not reap a committing saga row past its upload TTL before the verify pass runs', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await prepareUpload(token, upload, metadata);
		await putNarBytes(upload.r2Key);
		await markUploadCommitting(upload.uploadId);

		// Past the 15-minute upload expiry, GC runs before verification (their cron
		// ordering is not guaranteed). A `committing` upload is a live saga, not an
		// abandoned upload, so GC must leave it and its staged bytes alone.
		vi.setSystemTime(new Date('2026-01-01T00:16:00.000Z'));
		await currentServer().runGarbageCollection();

		expect(await pendingUploadVerdict(upload.uploadId)).toBe('committing');
		await expect(env.BLOBS.head(upload.r2Key)).resolves.not.toBeNull();

		// The verify pass then still re-drives it to servable.
		await currentServer().runVerification();

		expect(await pendingUploadVerdict(upload.uploadId)).toBeUndefined();
		const narInfo = await fetchNarInfo(metadata.storePathHash);
		expect(narInfo.narHash).toBe(metadata.narHash);
	});

	it('does not strand a reserved row when an in-flight commit is retried', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await prepareUpload(token, upload, metadata);
		await putNarBytes(upload.r2Key);

		// The state a crashed inline commit leaves: the row reserved at generation 0,
		// the upload marked committing, the staged bytes still present, and nothing
		// servable.
		await seedReservedNarInfo(metadata);
		await markUploadCommitting(upload.uploadId);

		// A client retry must not concede `already-present` for the not-yet-servable
		// row, nor delete the staged bytes the re-drive needs: it reports the saga in
		// progress and leaves the marker and bytes intact.
		const retry = await commitUpload(token, upload.uploadId);

		expect(retry.status).toBe('pending');
		await expect(env.BLOBS.head(upload.r2Key)).resolves.not.toBeNull();
		await expect(
			env.BLOBS.head(narInfoObjectKey(metadata.storePathHash))
		).resolves.toBeNull();

		// The verify pass re-drives the preserved saga to servable.
		await currentServer().runVerification();

		expect(await pendingUploadVerdict(upload.uploadId)).toBeUndefined();
		const narInfo = await fetchNarInfo(metadata.storePathHash);
		expect(narInfo.narHash).toBe(metadata.narHash);
	});

	it('verifies staged bytes on commit even when the shared blob already exists', async () => {
		const token = await initialise();
		const good = await verifiableNar('reuse-verify-good');
		const wrong = await verifiableNar('reuse-verify-wrong');

		// Stage a second upload for a different path that claims `good`'s narHash but
		// holds `wrong`'s bytes (whose own compressed hash matches). Negotiate while
		// no shared blob exists, so it is an upload decision, not a reuse.
		const liar = uploadMetadata({
			name: 'liar',
			storePathHash: 'a'.repeat(32),
			narHash: good.narHash,
			fileHash: wrong.fileHash,
			fileSize: wrong.narBytes.byteLength,
			narSize: good.narSize
		});
		const liarUpload = expectSingleUploadDecision(
			await negotiateUploads(token, [liar]),
			liar
		);
		await prepareUpload(token, liarUpload, liar);
		await putNarBytes(liarUpload.r2Key, wrong);

		// A correct upload of `good` for another path commits first, so `blob_state`
		// now holds `good`'s narHash and the canonical object exists.
		const honest = uploadMetadata({
			name: 'honest',
			storePathHash: 'b'.repeat(32),
			narHash: good.narHash,
			fileHash: good.fileHash,
			fileSize: good.narBytes.byteLength,
			narSize: good.narSize
		});
		await commitPath(token, honest, good);

		// The liar's deferred verify must re-derive its own staged bytes, not bind to
		// the shared blob because `blob_state` already holds the hash: its bytes are
		// `wrong`, so it fails terminally and never becomes servable.
		await markUploadPendingVerification(liarUpload.uploadId);
		await currentServer().runVerification();

		expect(await pendingUploadVerdict(liarUpload.uploadId)).toBe('mismatch');
		await expect(
			env.BLOBS.head(narInfoObjectKey(liar.storePathHash))
		).resolves.toBeNull();

		// The honest path is unaffected and still serves.
		const served = await fetchNarInfo(honest.storePathHash);
		expect(served.narHash).toBe(good.narHash);
	});

	it('does not serve a reserved row just because its blob already exists', async () => {
		const token = await initialise();
		const good = await verifiableNar('reserved-row-good');
		const wrong = await verifiableNar('reserved-row-wrong');
		const reserved = uploadMetadata({
			name: 'reserved',
			storePathHash: 'c'.repeat(32),
			narHash: good.narHash,
			fileHash: wrong.fileHash,
			fileSize: wrong.narBytes.byteLength,
			narSize: good.narSize
		});
		const reservedUpload = expectSingleUploadDecision(
			await negotiateUploads(token, [reserved]),
			reserved
		);
		await prepareUpload(token, reservedUpload, reserved);
		await putNarBytes(reservedUpload.r2Key, wrong);

		const honest = uploadMetadata({
			name: 'reserved-honest',
			storePathHash: 'd'.repeat(32),
			narHash: good.narHash,
			fileHash: good.fileHash,
			fileSize: good.narBytes.byteLength,
			narSize: good.narSize
		});
		await commitPath(token, honest, good);

		await seedReservedNarInfo(reserved);
		await markUploadCommitting(reservedUpload.uploadId);

		const retry = expectSingleCommitDecision(
			await negotiateUploads(token, [reserved]),
			reserved
		);

		expect({ ...retry, uploadId: typeof retry.uploadId }).toStrictEqual({
			action: 'commit',
			storePathHash: reserved.storePathHash,
			narHash: reserved.narHash,
			uploadId: 'string'
		});
		await expect(
			env.BLOBS.head(narInfoObjectKey(reserved.storePathHash))
		).resolves.toBeNull();

		await env.BLOBS.put(narInfoObjectKey(reserved.storePathHash), 'accidental');
		await currentServer().runVerification();

		expect(await pendingUploadVerdict(reservedUpload.uploadId)).toBe(
			'mismatch'
		);
		await expect(
			env.BLOBS.head(narInfoObjectKey(reserved.storePathHash))
		).resolves.toBeNull();
	});

	it('keeps a deferred upload pending on a transient verify error, then commits on retry', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);

		await prepareUpload(token, upload, metadata);
		await putNarBytes(upload.r2Key);
		await markUploadPendingVerification(upload.uploadId);

		// A transient read failure during the background verify must not fail the
		// upload terminally: the row stays `pending` and its staging bytes survive.
		const getSpy = vi
			.spyOn(env.BLOBS, 'get')
			.mockRejectedValueOnce(new Error('transient R2 read'));

		await currentServer().runVerification();
		getSpy.mockRestore();

		expect(await pendingUploadVerdict(upload.uploadId)).toBe('pending');
		await expect(env.BLOBS.head(upload.r2Key)).resolves.not.toBeNull();

		// The next pass reads cleanly, commits, and clears the pending row.
		await currentServer().runVerification();

		expect(await pendingUploadVerdict(upload.uploadId)).toBeUndefined();
		const narInfo = await fetchNarInfo(metadata.storePathHash);
		expect(narInfo.narHash).toBe(metadata.narHash);
	});

	it('clears the pending row with the commit so a later delete is not undone', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);

		await prepareUpload(token, upload, metadata);
		await putNarBytes(upload.r2Key);
		await markUploadPendingVerification(upload.uploadId);

		await currentServer().runVerification();

		// The background commit cleared the pending row in the same transaction, so
		// no `pending` row survives the committed narinfo.
		expect(await pendingUploadVerdict(upload.uploadId)).toBeUndefined();
		await expect(
			env.BLOBS.head(narInfoObjectKey(metadata.storePathHash))
		).resolves.not.toBeNull();

		// Deleting the committed path is not undone by a later verify pass: there is
		// no stale pending row to re-promote and re-commit it.
		await deletePath(token, metadata.storePathHash);
		await currentServer().runVerification();

		await expect(
			env.BLOBS.head(narInfoObjectKey(metadata.storePathHash))
		).resolves.toBeNull();
	});

	it('records a durable mismatch for an undecodable deferred blob, not a pending zombie', async () => {
		const token = await initialise();
		// Bytes that are not a valid zstd frame, but whose declared compressed hash
		// matches (so R2 and verifyUploadedObject accept them); only decompression
		// fails. A decode failure is terminal, never an endlessly-retried `pending`.
		const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
		const garbageFileHash = NixSha256Hash.fromDigest(
			new Uint8Array(await crypto.subtle.digest('SHA-256', garbage))
		).toString();
		const metadata = uploadMetadata({
			name: 'undecodable',
			storePathHash: 'f'.repeat(32),
			narHash: nixSha256Hash('1'),
			fileHash: garbageFileHash,
			fileSize: garbage.byteLength,
			narSize: 4242
		});
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);

		await prepareUpload(token, upload, metadata);
		await putNarBytes(upload.r2Key, {
			narBytes: garbage,
			narHash: metadata.narHash,
			narSize: 4242,
			fileHash: garbageFileHash
		});
		await markUploadPendingVerification(upload.uploadId);

		await currentServer().runVerification();

		expect(await pendingUploadVerdict(upload.uploadId)).toBe('mismatch');
		await expect(env.BLOBS.head(upload.r2Key)).resolves.toBeNull();
		await expect(
			env.BLOBS.head(narInfoObjectKey(metadata.storePathHash))
		).resolves.toBeNull();
	});

	it('reaps a canonical blob orphaned by losing the commit race at a different narHash', async () => {
		const token = await initialise();
		const narX = await verifiableNar('race-x');
		const narY = await verifiableNar('race-y');
		const storePathHash = 'a'.repeat(32);

		// Defer an upload of path P at narHash X (awaiting background verification).
		const x = uploadMetadata({
			name: 'p',
			storePathHash,
			narHash: narX.narHash,
			fileHash: narX.fileHash,
			fileSize: narX.narBytes.byteLength,
			narSize: narX.narSize
		});
		const xUpload = expectSingleUploadDecision(
			await negotiateUploads(token, [x]),
			x
		);
		await prepareUpload(token, xUpload, x);
		await putNarBytes(xUpload.r2Key, narX);
		await markUploadPendingVerification(xUpload.uploadId);

		// Commit the SAME path P at a different narHash Y — the winner.
		const y = uploadMetadata({
			name: 'p',
			storePathHash,
			narHash: narY.narHash,
			fileHash: narY.fileHash,
			fileSize: narY.narBytes.byteLength,
			narSize: narY.narSize
		});
		await commitPath(token, y, narY);

		// X's deferred verify loses the narinfo race; the nar/X it promoted is now
		// orphaned and must be enqueued for orphan deletion and reaped, while the
		// winner Y survives and P serves Y.
		await currentServer().runVerification();
		await currentServer().runGarbageCollection();

		const served = await fetchNarInfo(storePathHash);

		expect(served.narHash).toBe(narY.narHash);
		await expect(
			env.BLOBS.head(narObjectKey(narX.narHash))
		).resolves.toBeNull();
		await expect(
			env.BLOBS.head(narObjectKey(narY.narHash))
		).resolves.not.toBeNull();
	});

	it('terminally fails a deferred upload whose staging object has vanished', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);

		await prepareUpload(token, upload, metadata);
		await putNarBytes(upload.r2Key);
		await markUploadPendingVerification(upload.uploadId);

		// The staging object is gone for good (R2 loss / external delete). The
		// background pass must terminally fail it, not retry forever as a `pending`
		// zombie that re-reads an absent object every cron tick.
		await env.BLOBS.delete(upload.r2Key);
		await currentServer().runVerification();

		expect(await pendingUploadVerdict(upload.uploadId)).toBe('mismatch');
	});

	it('keeps a mismatch verdict observable past the original upload TTL', async () => {
		const token = await initialise();
		const good = await verifiableNar('ttl-good');
		const wrong = await verifiableNar('ttl-wrong');
		const metadata = uploadMetadata({
			name: 'ttl',
			storePathHash: 'a'.repeat(32),
			narHash: good.narHash,
			fileHash: wrong.fileHash,
			fileSize: wrong.narBytes.byteLength,
			narSize: good.narSize
		});
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);

		await prepareUpload(token, upload, metadata);
		await putNarBytes(upload.r2Key, wrong);
		await markUploadPendingVerification(upload.uploadId);

		// The verify pass runs after the original 15-minute upload TTL; the recorded
		// mismatch refreshes the window, so a GC pass right after does not reap it.
		vi.setSystemTime(new Date('2026-01-01T00:16:00.000Z'));
		await currentServer().runVerification();

		expect(await pendingUploadVerdict(upload.uploadId)).toBe('mismatch');

		await currentServer().runGarbageCollection();

		expect(await pendingUploadVerdict(upload.uploadId)).toBe('mismatch');
	});

	it('rejects an upload whose declared NAR size exceeds the verifiable budget', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({
			name: 'huge',
			storePathHash: '88888888888888888888888888888888',
			narSize: verifiableMaxBytes + 1,
			fileSize: narBytes.byteLength
		});
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await prepareUpload(token, upload, metadata);
		await putNarBytes(upload.r2Key);

		const commit = await authorisedFetch(
			`/uploads/${upload.uploadId}/commit`,
			token,
			{ method: 'POST' }
		);

		expect(commit.status).toBe(StatusCodes.REQUEST_TOO_LONG);
		await expect(
			env.BLOBS.head(narInfoObjectKey(metadata.storePathHash))
		).resolves.toBeNull();
		await expect(env.BLOBS.head(upload.r2Key)).resolves.toBeNull();
	});

	it('defers a blob above the inline budget to background verification', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({
			name: 'large',
			storePathHash: '77777777777777777777777777777777',
			narSize: inlineVerifyMaxBytes + 1,
			fileSize: narBytes.byteLength
		});
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await prepareUpload(token, upload, metadata);
		await putNarBytes(upload.r2Key);

		const commit = await commitUpload(token, upload.uploadId);

		expect(commit.status).toBe('pending');
		await expect(
			env.BLOBS.head(narInfoObjectKey(metadata.storePathHash))
		).resolves.toBeNull();
	});

	it('reclaims the staging object when a fresh upload commits as already-present', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		const first = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		const second = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);

		await prepareUpload(token, first, metadata);
		await putNarBytes(first.r2Key);
		await prepareUpload(token, second, metadata);
		await putNarBytes(second.r2Key);

		const firstCommit = await commitUpload(token, first.uploadId);
		const secondCommit = await commitUpload(token, second.uploadId);

		expect(firstCommit.status).toBe('committed');
		expect(secondCommit.status).toBe('already-present');

		// Both private staging objects are reclaimed — the winner's on commit and
		// the loser's on the already-present path — leaving only the canonical blob.
		// GC never has a handle to a staging key once its upload is cleared.
		await expect(env.BLOBS.head(first.r2Key)).resolves.toBeNull();
		await expect(env.BLOBS.head(second.r2Key)).resolves.toBeNull();
		await expect(
			env.BLOBS.head(narObjectKey(metadata.narHash))
		).resolves.not.toBeNull();
	});

	it('finalises and reclaims staging when the canonical blob was already promoted', async () => {
		// Simulates recovery after a crash that promoted the blob but had not yet
		// committed: the canonical object exists, the upload is still staged, and a
		// retried commit must finalise from it without failing or re-copying.
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);

		await prepareUpload(token, upload, metadata);
		await putNarBytes(upload.r2Key);
		await putNarBytes(narObjectKey(metadata.narHash));

		const commit = await commitUpload(token, upload.uploadId);

		expect(commit.status).toBe('committed');

		await expect(env.BLOBS.head(upload.r2Key)).resolves.toBeNull();
		await expect(
			env.BLOBS.head(narObjectKey(metadata.narHash))
		).resolves.not.toBeNull();
		await expectNarResponse(metadata.narHash, 'GET');
	});

	it('returns 404 for a valid NAR hash with no stored blob', async () => {
		const missing = await readFetch(`/nar/${nixSha256Hash('7')}.nar.zst`);

		expect(missing.status).toBe(StatusCodes.NOT_FOUND);
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

		expect(response.status).toBe(StatusCodes.NOT_FOUND);
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
		const swept = await commitVerifiablePath(token, 'swept', {
			name: 'swept',
			storePathHash: '22222222222222222222222222222222'
		});

		await commitPath(token, kept);
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
		const swept = await commitVerifiablePath(token, 'swept', {
			name: 'swept',
			storePathHash: '22222222222222222222222222222222'
		});

		await commitPath(token, kept);
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

			expect(response.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
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

		expect(response.status).toBe(StatusCodes.BAD_REQUEST);

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

		expect(response.status).toBe(StatusCodes.BAD_REQUEST);

		await expectStats(token, {
			storePaths: 0,
			narBlobs: 0,
			pendingUploads: 1,
			totalFileSize: 0
		});
	});

	it.each([
		{
			name: 'a malformed NAR hash',
			fields: { narHash: 'sha256:not-a-valid-hash' }
		},
		{
			name: 'a full store path reference',
			fields: {
				references: ['/nix/store/11111111111111111111111111111111-first']
			}
		}
	])('rejects upload negotiation with $name', async ({ fields }) => {
		const token = await initialise();
		const metadata = uploadMetadata({
			fileSize: narBytes.byteLength,
			...fields
		});

		const response = await authorisedFetch('/uploads', token, {
			body: JSON.stringify({ paths: [uploadPathNegotiation(metadata)] }),
			headers: {
				'content-type': 'application/json'
			},
			method: 'POST'
		});

		const body = await response.text();

		expect({
			status: response.status,
			hasDiagnostics: body.length > 0
		}).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			hasDiagnostics: true
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
			name: 'a malformed file hash',
			fields: { fileHash: 'sha256:not-a-valid-hash' }
		},
		{ name: 'a non-positive file size', fields: { fileSize: 0 } }
	])('rejects upload preparation with $name', async ({ fields }) => {
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

		const body = await response.text();

		expect({
			status: response.status,
			hasDiagnostics: body.length > 0
		}).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			hasDiagnostics: true
		});

		await expectStats(token, {
			storePaths: 0,
			narBlobs: 0,
			pendingUploads: 1,
			totalFileSize: 0
		});
	});

	it('rejects malformed JSON upload requests', async () => {
		const token = await initialise();
		const response = await authorisedFetch('/uploads', token, {
			body: '{',
			headers: {
				'content-type': 'application/json'
			},
			method: 'POST'
		});

		expect(response.status).toBe(StatusCodes.BAD_REQUEST);
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
		await env.BLOBS.delete(narObjectKey(metadata.narHash));

		expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);

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

	it('runs both garbage collection and verification from the scheduled handler', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

		const token = await initialiseViaWorker();

		// A committed path whose narinfo object we then lose out of band:
		// verification must re-materialise it from the row.
		const committed = uploadMetadata({
			fileSize: narBytes.byteLength,
			name: 'committed',
			storePathHash: '11111111111111111111111111111111'
		});
		const committedNegotiation = await negotiateViaWorker(token, [committed]);
		const committedUpload = expectSingleUploadDecision(
			committedNegotiation,
			committed
		);
		await prepareUploadViaWorker(token, committedUpload, committed);
		await putNarBytes(committedUpload.r2Key);
		const commit = await authorisedWorkerFetch(
			`/uploads/${committedUpload.uploadId}/commit`,
			token,
			{ method: 'POST' }
		);
		expect(commit.status).toBe(StatusCodes.OK);
		await env.BLOBS.delete(narInfoObjectKey(committed.storePathHash));

		// A distinct pending upload left to expire: GC must sweep it.
		const stale = uploadMetadata({
			fileSize: narBytes.byteLength,
			name: 'stale',
			storePathHash: '22222222222222222222222222222222',
			narHash: nixSha256Hash('2')
		});
		const staleNegotiation = await negotiateViaWorker(token, [stale]);
		const staleUpload = expectSingleUploadDecision(staleNegotiation, stale);
		await prepareUploadViaWorker(token, staleUpload, stale);

		vi.setSystemTime(new Date('2026-01-01T00:16:00.000Z'));
		await worker.scheduled(scheduledController(), env);

		const restored = await env.BLOBS.head(
			narInfoObjectKey(committed.storePathHash)
		);
		const staleObject = await env.BLOBS.head(staleUpload.r2Key);

		expect({
			restored: restored !== null,
			staleGone: staleObject === null
		}).toStrictEqual({ restored: true, staleGone: true });
		await expectStatsViaWorker(await initialiseViaWorker(), {
			storePaths: 1,
			narBlobs: 1,
			pendingUploads: 0,
			totalFileSize: narBytes.byteLength
		});
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

		expect(response.status).toBe(StatusCodes.UNAUTHORIZED);
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
			const a = await commitVerifiablePath(token, 'a', {
				name: 'a',
				storePathHash: hashA,
				references: [`${hashB}-b`]
			});
			await commitVerifiablePath(token, 'b', {
				name: 'b',
				storePathHash: hashB,
				references: []
			});
			await commitVerifiablePath(token, 'c', {
				name: 'c',
				storePathHash: hashC,
				references: []
			});
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
			const a = await commitVerifiablePath(token, 'a', {
				name: 'a',
				storePathHash: hashA,
				references: []
			});
			const b = await commitVerifiablePath(token, 'b', {
				name: 'b',
				storePathHash: hashB,
				references: []
			});
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
				references: []
			});
			const { metadata: c, nar: cNar } = await verifiablePath('c', {
				name: 'c',
				storePathHash: hashC,
				references: []
			});
			await commitPath(token, a);
			await commitPath(token, c, cNar);
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
				env.BLOBS.head(narObjectKey(cNar.narHash))
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
				env.BLOBS.head(narObjectKey(cNar.narHash))
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
			const writeToken = await mintServerSignedToken('write', 'ci', ['main']);
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
				stats: stats.status,
				deletePath: removed.status,
				gc: gc.status
			}).toStrictEqual({
				setRoot: StatusCodes.OK,
				stats: StatusCodes.FORBIDDEN,
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

			expect(response.status).toBe(StatusCodes.UNAUTHORIZED);
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
