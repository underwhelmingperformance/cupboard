import { rootLogger } from '@cupboard/logger';
import { startCapture } from '@cupboard/logger/testing';
import { CacheInfo } from '@cupboard/nix-store/cache-info';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	DEFAULT_CACHE,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { buildVersion } from '../build-info.generated.ts';
import * as schema from '../db/schema.ts';
import {
	narInfoCachePath,
	narInfoObjectKey,
	narObjectKey,
	verifiableMaxBytes
} from '../http/http.ts';
import {
	enqueueMaintenanceJobs,
	executeMaintenanceQueueMessage,
	type MaintenanceQueueMessage,
	runBlobReaper,
	verifyTenant
} from '../routing/scheduled.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	afterGrace,
	authorisedFetch,
	bootstrap,
	cacheWriteGrants,
	clearBlobStorage,
	commitPath,
	commitSharedPath,
	CommitSocketError,
	commitUpload,
	commitUploadViaWorker,
	CommitVerdictError,
	commitVerifiablePath,
	currentOrigin,
	currentServer,
	currentServerTenant,
	defaultCacheStatsPath,
	deletePath,
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
	handlerFetch,
	initialise,
	initialiseViaWorker,
	issueServerSignedToken,
	listRoots,
	markUploadCommitting,
	markUploadPendingVerification,
	narBytes,
	narHash,
	negotiateUploads,
	negotiateViaWorker,
	nixSha256Hash,
	openCommitSession,
	pendingUploadVerdict,
	provisionNamedTenant,
	pushPath,
	putNarBytes,
	readFetch,
	readStoredNarInfo,
	removeRoot,
	resetTestServer,
	runGcFromInternalOrigin,
	runGcResult,
	seedReservedNarInfo,
	setRoot,
	testBase,
	testPushId,
	uploadMetadata,
	uploadPathNegotiation,
	verifiableNar,
	verifiableNarStored,
	verifiablePath,
	verifyNarInfoSignature,
	workerFetch
} from '../test-support.ts';

function byUploadId(
	left: { readonly uploadId: string },
	right: { readonly uploadId: string }
): number {
	return left.uploadId.localeCompare(right.uploadId);
}

function publicKeyShape(publicKey: string): {
	readonly name: string;
	readonly rawBytes: number;
} {
	const [name, encoded] = z
		.tuple([z.string(), z.string()])
		.parse(publicKey.split(':'));

	return {
		name,
		rawBytes: Uint8Array.from(
			atob(encoded),
			(character) => character.codePointAt(0) ?? 0
		).byteLength
	};
}

async function cachedResponseShape(
	cacheKey: string
): Promise<{ readonly cached: boolean; readonly status: number | undefined }> {
	const response = await caches.default.match(cacheKey);

	return {
		cached: response !== undefined,
		status: response?.status
	};
}

// Drives the DO alarm directly so the negotiated reconcile runs: the test pool
// does not deliver the request-armed alarm negotiate sets, so the handler is
// invoked the way the GC continuation tests invoke it.
async function fireReconcile(): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => instance.alarm());
}

type ErrorConstructor<T extends Error> = abstract new (
	...arguments_: never[]
) => T;

function expectError<T extends Error>(
	error: unknown,
	errorClass: ErrorConstructor<T>
): asserts error is T {
	expect(error).toBeInstanceOf(errorClass);
}

// Projects an oRPC validation error body down to the fields a schema-mismatch
// test pins: the code, status, and each issue's code and path. The per-issue
// message is human-readable and version-dependent, so it is dropped.
function badRequestBodyShape(body: unknown): {
	readonly code: unknown;
	readonly status: unknown;
	readonly issues: readonly {
		readonly code: unknown;
		readonly path: unknown;
	}[];
} {
	if (typeof body !== 'object' || body === null) {
		throw new TypeError('error body was not an object');
	}

	const fields: Record<string, unknown> = Object.fromEntries(
		Object.entries(body)
	);
	const data = fields.data;

	if (typeof data !== 'object' || data === null || !('issues' in data)) {
		throw new TypeError('error body had no data.issues');
	}

	const { issues } = data;

	if (!Array.isArray(issues)) {
		throw new TypeError('error body issues was not an array');
	}

	return {
		code: fields.code,
		status: fields.status,
		issues: issues.map((issue: unknown) => {
			if (typeof issue !== 'object' || issue === null) {
				throw new TypeError('issue was not an object');
			}

			const issueFields: Record<string, unknown> = Object.fromEntries(
				Object.entries(issue)
			);

			return { code: issueFields.code, path: issueFields.path };
		})
	};
}

async function rejectedBy<T extends Error>(
	promise: Promise<unknown>,
	errorClass: ErrorConstructor<T>
): Promise<T> {
	let rejection: unknown;

	try {
		await promise;
	} catch (error) {
		rejection = error;
	}

	expectError(rejection, errorClass);

	return rejection;
}

const methodLineSchema = z.object({
	method: z.string(),
	rowsRead: z.number(),
	rowsWritten: z.number()
});

describe('upload flow', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		await resetTestServer();

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

		expect({
			status: fromDurableObject.status,
			publicKey: publicKeyShape(publicKey)
		}).toStrictEqual({
			status: StatusCodes.OK,
			publicKey: { name: 'cupboard-1', rawBytes: 32 }
		});

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
		const firstStats = await authorisedFetch(
			defaultCacheStatsPath,
			first.token
		);
		const secondStats = await authorisedFetch(
			defaultCacheStatsPath,
			second.token
		);

		// A re-bootstrap issues a fresh token but never rotates the signing key.
		expect({
			firstToken: first.token.length > 0,
			secondToken: second.token.length > 0,
			stablePublicKey: second.publicKey,
			first: {
				url: first.url,
				publicKey: publicKeyShape(first.publicKey),
				stats: firstStats.status
			},
			second: {
				url: second.url,
				publicKey: publicKeyShape(second.publicKey),
				stats: secondStats.status
			}
		}).toStrictEqual({
			firstToken: true,
			secondToken: true,
			stablePublicKey: first.publicKey,
			first: {
				url: currentOrigin(),
				publicKey: { name: 'cupboard-1', rawBytes: 32 },
				stats: StatusCodes.OK
			},
			second: {
				url: currentOrigin(),
				publicKey: publicKeyShape(first.publicKey),
				stats: StatusCodes.OK
			}
		});

		await expectTextResponse('/pubkey', {
			body: `${first.publicKey}\n`,
			cacheControl: 'no-cache',
			contentType: 'text/plain; charset=utf-8',
			method: 'GET'
		});
	});

	it('rejects unauthenticated management requests', async () => {
		const stats = await fetchPath(defaultCacheStatsPath);
		const negotiate = await fetchPath('/cache/_default/uploads', {
			body: JSON.stringify({ pushId: testPushId, paths: [] }),
			headers: {
				'content-type': 'application/json'
			},
			method: 'POST'
		});
		const commit = await fetchPath('/cache/_default/commit', {
			headers: { upgrade: 'websocket' }
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
		const init = await bootstrap();
		const metadata = uploadMetadata({
			fileSize: narBytes.byteLength
		});

		const negotiate = await negotiateUploads(init.token, [metadata]);
		const upload = expectSingleUploadDecision(negotiate, metadata);
		await putNarBytes(upload.r2Key);

		const committed = await commitUpload(init.token, upload.uploadId);

		expect(committed).toStrictEqual({
			storePathHash: metadata.storePathHash,
			narHash: metadata.narHash,
			status: 'committed'
		});

		await expectStats(init.token, {
			storePaths: 1,
			narBlobs: 1,
			pendingUploads: 0,
			totalFileSize: narBytes.byteLength
		});

		const narInfo = await fetchNarInfo(metadata.storePathHash);
		const [signature] = z.tuple([z.string()]).parse(narInfo.sigs);

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
			sigs: [signature]
		});
		expect({
			signatureVerified: await verifyNarInfoSignature(narInfo, init.publicKey)
		}).toStrictEqual({ signatureVerified: true });
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

		const skip = await negotiateUploads(init.token, [metadata]);

		expect(skip.uploads).toStrictEqual([
			{
				action: 'skip',
				storePathHash: metadata.storePathHash,
				narHash: metadata.narHash
			}
		]);

		await expectNarResponse(metadata.narHash, 'GET');
		await expectNarResponse(metadata.narHash, 'HEAD');
		await expectNarResponse(
			NixSha256Hash.parse(metadata.narHash).toUrlSegment(),
			'GET'
		);
		await expectConditionalNotModified(
			`/nar/${metadata.narHash}.nar.zst`,
			readFetch
		);
		await expectDateConditionalNotModified(
			`/nar/${metadata.narHash}.nar.zst`,
			readFetch
		);
	});

	it('logs the row cost of the cold start and a settled commit', async () => {
		const capture = startCapture();

		try {
			// `beforeEach` already initialised a server, so reset again under the
			// capture: the fresh server's first request runs the cold-start migration
			// where the log line is visible.
			await resetTestServer();
			const init = await bootstrap();
			const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
			const negotiate = await negotiateUploads(init.token, [metadata]);
			const upload = expectSingleUploadDecision(negotiate, metadata);
			await putNarBytes(upload.r2Key);
			await commitUpload(init.token, upload.uploadId);
		} finally {
			capture.stop();
		}

		// The cold-start migration and the commit are the row-heavy entrypoints that
		// bypass `fetch`, so each logs its own cost line. Neither is on the fetch path
		// the request-cost test covers, so without this the `metered()` plumbing could
		// regress unseen. Both are asserted as a present, non-zero cost: the cold-start
		// total tracks the whole DO migration history and the commit total tracks the
		// closure, neither a stable behavioural quantity.
		// The meter's row accounting is pinned exactly by the fetch-path and reconcile
		// cost tests instead.
		const byMethod = capture.logs
			.filter((entry) => entry.message === 'method finished')
			.map((entry) => methodLineSchema.parse(entry.properties));
		const coldStart = byMethod.find((line) => line.method === 'initialise');
		const commit = byMethod.find((line) => line.method === 'commit');

		expect({
			coldStartMeasured: (coldStart?.rowsWritten ?? 0) > 0,
			commitMeasured:
				(commit?.rowsRead ?? 0) > 0 || (commit?.rowsWritten ?? 0) > 0
		}).toStrictEqual({ coldStartMeasured: true, commitMeasured: true });
	});

	it('routes a mixed closure through one batched negotiate', async () => {
		const init = await bootstrap();

		// One negotiate must route every path from its bulk reads without crossing
		// their decisions: a committed path skips, a hash this tenant already owns
		// reuses at a new store path, and a brand-new path uploads.
		const committedPath = await commitVerifiablePath(init.token, 'skip-me', {
			name: 'skip',
			storePathHash: '22222222222222222222222222222222'
		});
		const ownedPath = await commitVerifiablePath(init.token, 'reuse-me', {
			name: 'reuse',
			storePathHash: '33333333333333333333333333333333'
		});

		const reuseStorePathHash = '44444444444444444444444444444444';
		const reuseMetadata = uploadMetadata({
			name: 'reuse-again',
			storePathHash: reuseStorePathHash,
			narHash: ownedPath.narHash,
			narSize: ownedPath.narSize,
			fileHash: ownedPath.fileHash,
			fileSize: ownedPath.fileSize
		});

		const { metadata: freshMetadata } = await verifiablePath('upload-me', {
			name: 'fresh',
			storePathHash: '55555555555555555555555555555555'
		});

		const negotiate = await negotiateUploads(init.token, [
			committedPath,
			reuseMetadata,
			freshMetadata
		]);

		expect(
			negotiate.uploads.map((decision) => ({
				action: decision.action,
				storePathHash: decision.storePathHash,
				narHash: decision.narHash
			}))
		).toStrictEqual([
			{
				action: 'skip',
				storePathHash: committedPath.storePathHash,
				narHash: committedPath.narHash
			},
			{
				action: 'commit',
				storePathHash: reuseStorePathHash,
				narHash: ownedPath.narHash
			},
			{
				action: 'upload',
				storePathHash: freshMetadata.storePathHash,
				narHash: freshMetadata.narHash
			}
		]);
	});

	it('serves a tenant its own cached NAR but never one it does not reference', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await commitPath(token, metadata);
		await provisionNamedTenant('acme');

		// The owning tenant reads its NAR, populating its tenant-scoped edge cache.
		const first = await readFetch(`/nar/${metadata.narHash}.nar.zst`);
		expect([...new Uint8Array(await first.arrayBuffer())]).toStrictEqual([
			...narBytes
		]);

		// With the R2 object gone, the owner is still served from its edge cache,
		// but a tenant that never referenced the hash gets a 404, not the shared
		// bytes: the NAR namespace is content-addressed but read access is per
		// tenant.
		await env.BLOBS.delete(narObjectKey(metadata.narHash));
		const owner = await readFetch(`/nar/${metadata.narHash}.nar.zst`);
		const intruder = await handlerFetch(
			`/t/acme/nar/${metadata.narHash}.nar.zst`
		);

		expect({
			ownerStatus: owner.status,
			ownerCacheControl: owner.headers.get('cache-control'),
			ownerBody: [...new Uint8Array(await owner.arrayBuffer())],
			intruderStatus: intruder.status
		}).toStrictEqual({
			ownerStatus: StatusCodes.OK,
			ownerCacheControl: 'public, max-age=31536000, immutable',
			ownerBody: [...narBytes],
			intruderStatus: StatusCodes.NOT_FOUND
		});
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
		await putNarBytes(upload.r2Key);

		const error = await rejectedBy(
			commitUpload(token, upload.uploadId),
			CommitVerdictError
		);

		expect({ name: error.name, verdict: error.verdict }).toStrictEqual({
			name: 'CommitVerdictError',
			verdict: 'mismatch'
		});
		await expect(
			env.BLOBS.head(narInfoObjectKey(fixtureTenant, metadata.storePathHash))
		).resolves.toBeNull();
		await expect(env.BLOBS.head(upload.r2Key)).resolves.toBeNull();
	});

	it('rejects corrupt, undecompressable bytes at verification', async () => {
		const token = await initialise();
		// Bytes that are not a valid zstd frame but whose declared compressed hash
		// matches, so only the decompress step can reject them. The error it raises
		// must surface as a clean 422, not a 500, and must reclaim the staging blob.
		const garbage = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
		const garbageFileHash = NixSha256Hash.fromDigest(
			new Uint8Array(await crypto.subtle.digest('SHA-256', garbage))
		).value;
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
		await putNarBytes(upload.r2Key, {
			narBytes: garbage,
			narHash: metadata.narHash,
			narSize: 100,
			fileHash: garbageFileHash
		});

		const error = await rejectedBy(
			commitUpload(token, upload.uploadId),
			CommitVerdictError
		);

		expect({ name: error.name, verdict: error.verdict }).toStrictEqual({
			name: 'CommitVerdictError',
			verdict: 'mismatch'
		});
		await expect(
			env.BLOBS.head(narInfoObjectKey(fixtureTenant, metadata.storePathHash))
		).resolves.toBeNull();
		await expect(env.BLOBS.head(upload.r2Key)).resolves.toBeNull();
	});

	it('still accepts a correct upload of a narHash a bad upload was rejected for', async () => {
		const token = await initialise();
		const good = await verifiableNar('isolation-good');
		const wrong = await verifiableNar('isolation-wrong');

		// A bad upload claims `good`'s narHash but stages `wrong`'s bytes, whose own
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
		await putNarBytes(bad.r2Key, wrong);

		const error = await rejectedBy(
			commitUpload(token, bad.uploadId),
			CommitVerdictError
		);

		expect({ name: error.name, verdict: error.verdict }).toStrictEqual({
			name: 'CommitVerdictError',
			verdict: 'mismatch'
		});

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
		await putNarBytes(goodUpload.r2Key, good);

		const goodCommit = await commitUpload(token, goodUpload.uploadId);
		const served = await readFetch(`/${goodMetadata.storePathHash}.narinfo`);
		const blob = await env.BLOBS.head(narObjectKey(good.narHash));

		expect({
			commitStatus: goodCommit.status,
			servedStatus: served.status,
			blobStored: blob !== null
		}).toStrictEqual({
			commitStatus: 'committed',
			servedStatus: StatusCodes.OK,
			blobStored: true
		});
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

		// Both negotiate as fresh uploads before either commits, the only window in
		// which two distinct encodings of one hash race.
		const firstUpload = expectSingleUploadDecision(
			await negotiateUploads(token, [first]),
			first
		);
		const secondUpload = expectSingleUploadDecision(
			await negotiateUploads(token, [second]),
			second
		);

		await putNarBytes(firstUpload.r2Key, compressed);
		await putNarBytes(secondUpload.r2Key, stored);

		await commitUpload(token, firstUpload.uploadId);
		await commitUpload(token, secondUpload.uploadId);

		// Both narinfos advertise the canonical object's fileHash (the one promoted
		// first), so a substituter fetching either downloads bytes whose hash matches.
		const firstInfo = await fetchNarInfo(first.storePathHash);
		const secondInfo = await fetchNarInfo(second.storePathHash);
		const canonical = await env.BLOBS.head(narObjectKey(compressed.narHash));
		const canonicalChecksum = z
			.instanceof(ArrayBuffer)
			.parse(canonical?.checksums.sha256);

		const canonicalFileHash = NixSha256Hash.fromDigest(
			new Uint8Array(canonicalChecksum)
		).value;

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

		await putNarBytes(upload.r2Key, wrong);
		await markUploadPendingVerification(upload.uploadId);

		await currentServer().runVerification();

		// Background verification failed: it deleted the bad staging bytes but kept a
		// durable `mismatch` verdict (readable later by `push --wait`), committing
		// nothing servable.
		expect(await pendingUploadVerdict(upload.uploadId)).toBe('mismatch');
		await expect(env.BLOBS.head(upload.r2Key)).resolves.toBeNull();
		await expect(
			env.BLOBS.head(narInfoObjectKey(fixtureTenant, metadata.storePathHash))
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

	it('verifies and commits a deferred pending upload in the background pass', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(upload.r2Key);

		// A blob too large to verify inline commits as `pending`: stored, but not
		// servable until the background pass confirms its bytes. Simulate that
		// verdict without a multi-megabyte fixture.
		await markUploadPendingVerification(upload.uploadId);

		await expect(
			env.BLOBS.head(narInfoObjectKey(fixtureTenant, metadata.storePathHash))
		).resolves.toBeNull();

		// Past the 15-minute upload expiry: GC must not reap a pending upload, and
		// the background verify pass must then confirm and commit it.
		vi.setSystemTime(new Date('2026-01-01T00:16:00.000Z'));
		await currentServer().runGarbageCollection();
		await currentServer().runVerification();

		const narInfo = await fetchNarInfo(metadata.storePathHash);

		expect(narInfo.narHash.toString()).toBe(metadata.narHash);
		await expect(
			env.BLOBS.head(narInfoObjectKey(fixtureTenant, metadata.storePathHash))
		).resolves.not.toBeNull();
	});

	it('re-drives an inline commit crashed mid-saga from its committing marker', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(upload.r2Key);

		// An inline commit that crashed after marking itself in progress but before
		// reserving the row: the staging bytes are present, the upload carries the
		// `committing` marker, and nothing is servable yet.
		await markUploadCommitting(upload.uploadId);

		await expect(
			env.BLOBS.head(narInfoObjectKey(fixtureTenant, metadata.storePathHash))
		).resolves.toBeNull();

		// The verify pass re-drives it through the same reserve→verify→promote→
		// materialise path a deferred upload takes, then clears the marker.
		await currentServer().runVerification();

		expect(await pendingUploadVerdict(upload.uploadId)).toBeUndefined();
		const narInfo = await fetchNarInfo(metadata.storePathHash);
		expect(narInfo.narHash.toString()).toBe(metadata.narHash);
	});

	it('does not reap a committing saga row past its upload TTL before the verify pass runs', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
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
		expect(narInfo.narHash.toString()).toBe(metadata.narHash);
	});

	it('marks a fresh deferred commit committing before verification runs', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(upload.r2Key);

		// A fresh upload defers for verify-before-serve. The commit must leave a
		// durable `committing` marker before any reserve/verify work, so the verify
		// pass re-drives it and an interruption never strands a null-verdict row.
		const deferred = await commitUpload(token, upload.uploadId, DEFAULT_CACHE, {
			wait: false
		});

		expect({
			status: deferred.status,
			verdict: await pendingUploadVerdict(upload.uploadId)
		}).toStrictEqual({ status: 'pending', verdict: 'committing' });

		await currentServer().runVerification();

		expect(await pendingUploadVerdict(upload.uploadId)).toBeUndefined();
		const narInfo = await fetchNarInfo(metadata.storePathHash);
		expect(narInfo.narHash.toString()).toBe(metadata.narHash);
	});

	it('claims a deferred upload, then records its verdict to servable', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(upload.r2Key);
		await commitUpload(token, upload.uploadId, DEFAULT_CACHE, { wait: false });

		// The queue consumer claims the deferred upload (a read on the DO), decodes
		// the bytes off the DO thread, then reports the verdict back.
		expect(await currentServer().claimPendingVerifications(10)).toStrictEqual([
			{
				uploadId: upload.uploadId,
				r2Key: upload.r2Key,
				narHash: metadata.narHash,
				narSize: metadata.narSize,
				reuse: false
			}
		]);

		// The off-DO consumer reports the file hash and size it computed while
		// decoding, the facts the promote records for the served narinfo.
		await currentServer().recordVerification(upload.uploadId, {
			ok: true,
			fileHash: fileHash.value,
			fileSize: narBytes.byteLength
		});

		expect(await pendingUploadVerdict(upload.uploadId)).toBeUndefined();
		const narInfo = await fetchNarInfo(metadata.storePathHash);
		expect(narInfo.narHash.toString()).toBe(metadata.narHash);
	});

	it('records a terminal mismatch verdict from an off-DO verification', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(upload.r2Key);
		await commitUpload(token, upload.uploadId, DEFAULT_CACHE, { wait: false });

		await currentServer().recordVerification(upload.uploadId, {
			ok: false,
			reason: 'nar-hash-mismatch',
			actualNarHash: metadata.narHash
		});

		expect(await pendingUploadVerdict(upload.uploadId)).toBe('mismatch');
		await expect(
			env.BLOBS.head(narInfoObjectKey(fixtureTenant, metadata.storePathHash))
		).resolves.toBeNull();
	});

	it('records a terminal mismatch when the staging object has vanished', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(upload.r2Key);
		await commitUpload(token, upload.uploadId, DEFAULT_CACHE, { wait: false });

		await currentServer().recordMissingObject(upload.uploadId);

		expect(await pendingUploadVerdict(upload.uploadId)).toBe('mismatch');
	});

	it('multiplexes commits for many uploads over one session socket', async () => {
		const token = await initialise();
		const metaA = uploadMetadata({
			storePathHash: 'a'.repeat(32),
			name: 'a',
			narHash: nixSha256Hash('a'),
			fileSize: narBytes.byteLength
		});
		const metaB = uploadMetadata({
			storePathHash: 'b'.repeat(32),
			name: 'b',
			narHash: nixSha256Hash('b'),
			fileSize: narBytes.byteLength
		});
		const negotiated = await negotiateUploads(token, [metaA, metaB]);
		const decisionFor = (storePathHash: string) => {
			const decision = negotiated.uploads.find(
				(candidate) => candidate.storePathHash === storePathHash
			);

			if (decision?.action !== 'upload') {
				throw new Error(`expected an upload decision for ${storePathHash}`);
			}

			return decision;
		};
		const a = decisionFor(metaA.storePathHash);
		const b = decisionFor(metaB.storePathHash);
		await putNarBytes(a.r2Key);
		await putNarBytes(b.r2Key);

		// Both commits ride one socket and each gets its own per-id frame.
		const session = await openCommitSession(token);
		session.send({ op: 'commit', uploadId: a.uploadId });
		session.send({ op: 'commit', uploadId: b.uploadId });
		const frames = [await session.nextFrame(), await session.nextFrame()];
		session.socket.close();

		expect(
			frames
				.map((frame) => ({ ev: frame.ev, uploadId: frame.uploadId }))
				.toSorted(byUploadId)
		).toStrictEqual(
			[
				{ ev: 'deferred', uploadId: a.uploadId },
				{ ev: 'deferred', uploadId: b.uploadId }
			].toSorted(byUploadId)
		);
	});

	it('replays a deferred upload to a reconnected session and routes its verdict there', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(upload.r2Key);

		// Commit on one session; it defers, then that socket drops.
		const first = await openCommitSession(token);
		first.send({ op: 'commit', uploadId: upload.uploadId });
		const deferred = await first.nextFrame();
		expect(deferred.ev).toBe('deferred');
		first.socket.close();

		// A reconnected session re-subscribes and is replayed the deferral.
		const second = await openCommitSession(token);
		second.send({ op: 'subscribe', uploadIds: [upload.uploadId] });
		const replay = await second.nextFrame();
		expect({ ev: replay.ev, uploadId: replay.uploadId }).toStrictEqual({
			ev: 'deferred',
			uploadId: upload.uploadId
		});

		// The verdict routes to the reconnected socket.
		await currentServer().runVerification();
		const verdict = await second.nextFrame();
		second.socket.close();

		if (verdict.ev !== 'verdict') {
			throw new Error(`expected a verdict frame, got ${verdict.ev}`);
		}

		expect(verdict.status).toBe('servable');
	});

	it('replays a committed-and-cleared upload as servable', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(upload.r2Key);

		// Commit fully, so its pending row is cleared.
		const committed = await commitUpload(token, upload.uploadId);
		expect(committed.status).toBe('committed');

		// A later subscribe to the cleared row replays servable: a cleared row is
		// always a committed path.
		const session = await openCommitSession(token);
		session.send({ op: 'subscribe', uploadIds: [upload.uploadId] });
		const replay = await session.nextFrame();
		session.socket.close();

		expect({ ev: replay.ev, uploadId: replay.uploadId }).toStrictEqual({
			ev: 'verdict',
			uploadId: upload.uploadId
		});
	});

	it('does not strand a reserved row when an in-flight commit is retried', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(upload.r2Key);

		// The state a crashed inline commit leaves: the row reserved at generation 0,
		// the upload marked committing, the staged bytes still present, and nothing
		// servable.
		await seedReservedNarInfo(metadata);
		await markUploadCommitting(upload.uploadId);

		// A client retry must not concede `already-present` for the not-yet-servable
		// row, nor delete the staged bytes the re-drive needs: it defers, leaving
		// the marker and bytes intact.
		const retry = await commitUpload(token, upload.uploadId, DEFAULT_CACHE, {
			wait: false
		});

		expect(retry.status).toBe('pending');
		await expect(env.BLOBS.head(upload.r2Key)).resolves.not.toBeNull();
		await expect(
			env.BLOBS.head(narInfoObjectKey(fixtureTenant, metadata.storePathHash))
		).resolves.toBeNull();

		// The verify pass re-drives the preserved saga to servable.
		await currentServer().runVerification();

		expect(await pendingUploadVerdict(upload.uploadId)).toBeUndefined();
		const narInfo = await fetchNarInfo(metadata.storePathHash);
		expect(narInfo.narHash.toString()).toBe(metadata.narHash);
	});

	it('requests a prompt verification pass when an in-flight commit is retried', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(upload.r2Key);

		// A crashed inline reuse saga: reserved row, marked committing, never settled
		// and never requested a prompt pass.
		await seedReservedNarInfo(metadata);
		await markUploadCommitting(upload.uploadId);

		const sent: unknown[] = [];
		const metrics = { backlogCount: 0, backlogBytes: 0 };
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.env = {
				...instance.context.env,
				MAINTENANCE_QUEUE: {
					send: (message: unknown) => {
						sent.push(message);
						return Promise.resolve({ metadata: { metrics } });
					},
					sendBatch: () => Promise.resolve({ metadata: { metrics } }),
					metrics: () => Promise.resolve(metrics)
				}
			};
			return Promise.resolve();
		});

		// Retrying the commit re-drives the saga through a prompt pass, so the socket
		// settles within its wait window.
		const commit = await commitUpload(token, upload.uploadId, DEFAULT_CACHE, {
			wait: false
		});

		expect({ status: commit.status, sent }).toStrictEqual({
			status: 'pending',
			sent: [{ kind: 'tenant-verify', tenant: fixtureTenant }]
		});
	});

	it('sends one verify request per push, re-arming when a pass starts', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(upload.r2Key);

		const sent: unknown[] = [];
		const metrics = { backlogCount: 0, backlogBytes: 0 };
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.env = {
				...instance.context.env,
				MAINTENANCE_QUEUE: {
					send: (message: unknown) => {
						sent.push(message);
						return Promise.resolve({ metadata: { metrics } });
					},
					sendBatch: () => Promise.resolve({ metadata: { metrics } }),
					metrics: () => Promise.resolve(metrics)
				}
			};
			return Promise.resolve();
		});

		// Two deferrals before any pass starts coalesce onto one outstanding
		// request: the pass it triggers will claim both rows.
		await commitUpload(token, upload.uploadId, DEFAULT_CACHE, { wait: false });
		await commitUpload(token, upload.uploadId, DEFAULT_CACHE, { wait: false });
		expect(sent).toStrictEqual([
			{ kind: 'tenant-verify', tenant: fixtureTenant }
		]);

		// A pass starts (the queue consumer claims the rows), re-arming the guard.
		await currentServer().claimPendingVerifications(10);

		// A deferral after the snapshot asks for a fresh pass; the one that has
		// already chosen its rows will not see it.
		await commitUpload(token, upload.uploadId, DEFAULT_CACHE, { wait: false });
		expect(sent).toStrictEqual([
			{ kind: 'tenant-verify', tenant: fixtureTenant },
			{ kind: 'tenant-verify', tenant: fixtureTenant }
		]);
	});

	it('tracks the loser of a commit race for verification rather than parking its socket', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const loser = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(loser.r2Key);

		// A rival commit reserved the path but has not committed its reference yet:
		// the narinfo row exists, unmaterialised, with no D1 edge or R2 object, and
		// the rival's own upload row is live (mid-saga, unexpired). This upload's
		// verdict is still null, so it is a distinct racer, not a retry, and the
		// live rival is what routes it to the verification pass; a reservation with
		// no live upload behind it is reclaimed at commit instead.
		await seedReservedNarInfo(metadata);
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.insert(schema.pendingUploads)
				.values({
					id: 'rival-upload',
					cache: '',
					narHash: metadata.narHash,
					r2Key: 'staging/rival-upload',
					metadataJson: '{}',
					createdAt: '2026-01-01T00:00:00.000Z',
					expiresAt: '2099-01-01T00:00:00.000Z'
				})
				.run();
		});

		const committed = await commitUpload(token, loser.uploadId, DEFAULT_CACHE, {
			wait: false
		});

		// There is nothing committed to concede to; the loser is marked pending
		// and staged for the prompt verification pass.
		expect({
			status: committed.status,
			verdict: await pendingUploadVerdict(loser.uploadId),
			staged: (await env.BLOBS.head(loser.r2Key)) !== null
		}).toStrictEqual({ status: 'pending', verdict: 'pending', staged: true });

		// The pass drives the tracked loser to servable, the terminal verdict its
		// socket would have carried.
		await currentServer().runVerification();

		const narInfo = await fetchNarInfo(metadata.storePathHash);

		expect({
			verdict: await pendingUploadVerdict(loser.uploadId),
			narHash: narInfo.narHash.toString()
		}).toStrictEqual({ verdict: undefined, narHash: metadata.narHash });
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
			env.BLOBS.head(narInfoObjectKey(fixtureTenant, liar.storePathHash))
		).resolves.toBeNull();

		// The honest path is unaffected and still serves.
		const served = await fetchNarInfo(honest.storePathHash);
		expect(served.narHash.toString()).toBe(good.narHash);
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
			env.BLOBS.head(narInfoObjectKey(fixtureTenant, reserved.storePathHash))
		).resolves.toBeNull();

		await env.BLOBS.put(
			narInfoObjectKey(fixtureTenant, reserved.storePathHash),
			'accidental'
		);
		await currentServer().runVerification();

		expect(await pendingUploadVerdict(reservedUpload.uploadId)).toBe(
			'mismatch'
		);
		await expect(
			env.BLOBS.head(narInfoObjectKey(fixtureTenant, reserved.storePathHash))
		).resolves.toBeNull();
	});

	it('keeps a deferred upload pending on a transient verify error, then commits on retry', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);

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

		// The next pass reads cleanly, commits, and clears the settled upload.
		await currentServer().runVerification();

		expect(await pendingUploadVerdict(upload.uploadId)).toBeUndefined();
		const narInfo = await fetchNarInfo(metadata.storePathHash);
		expect(narInfo.narHash.toString()).toBe(metadata.narHash);
	});

	it('chains a verify pass that fills its batch and drains the rest, stopping on a short batch', async () => {
		const token = await initialise();

		// Three distinct deferred uploads: more than one pass holds at a batch of two.
		const uploadIds: string[] = [];
		for (const index of [0, 1, 2]) {
			const seed = `drain-${String(index)}`;
			const { metadata, nar } = await verifiablePath(seed, {
				storePathHash: String(index + 1).repeat(32),
				name: seed
			});
			const upload = expectSingleUploadDecision(
				await negotiateUploads(token, [metadata]),
				metadata
			);
			await putNarBytes(upload.r2Key, nar);
			await markUploadPendingVerification(upload.uploadId);
			uploadIds.push(upload.uploadId);
		}

		// The continuation routes through the object's single-flight, so it sends on
		// the object's own queue binding; collect those sends.
		const sent: unknown[] = [];
		const metrics = { backlogCount: 0, backlogBytes: 0 };
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.env = {
				...instance.context.env,
				MAINTENANCE_QUEUE: {
					send: (message: unknown) => {
						sent.push(message);

						return Promise.resolve({ metadata: { metrics } });
					},
					sendBatch: () => Promise.resolve({ metadata: { metrics } }),
					metrics: () => Promise.resolve(metrics)
				}
			};

			return Promise.resolve();
		});
		const tenant = currentServerTenant();

		// A committed upload clears its row, so a gone verdict counts as servable.
		const servableCount = async (): Promise<number> => {
			const verdicts = await Promise.all(
				uploadIds.map((uploadId) => pendingUploadVerdict(uploadId))
			);

			return verdicts.filter((verdict) => verdict === undefined).length;
		};

		// A full batch leaves a row pending, so the pass chains one continuation.
		await verifyTenant(rootLogger(), env, tenant, 2);
		expect({
			sent: sent.length,
			servable: await servableCount()
		}).toStrictEqual({ sent: 1, servable: 2 });

		// The continuation claims a short batch (the last row): it drains it and
		// sends no further request.
		await verifyTenant(rootLogger(), env, tenant, 2);
		expect({
			sent: sent.length,
			servable: await servableCount()
		}).toStrictEqual({ sent: 1, servable: 3 });
	});

	it('marks a deferred upload servable on commit, and a later delete is not undone', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);

		await putNarBytes(upload.r2Key);
		await markUploadPendingVerification(upload.uploadId);

		await currentServer().runVerification();

		// The background commit settles the upload completely: the waiters held
		// the verdict, so no row remains to re-drive.
		expect(await pendingUploadVerdict(upload.uploadId)).toBeUndefined();
		await expect(
			env.BLOBS.head(narInfoObjectKey(fixtureTenant, metadata.storePathHash))
		).resolves.not.toBeNull();

		// Deleting the committed path is not undone by a later verify pass:
		// nothing of the settled upload survives to re-promote it.
		await deletePath(token, metadata.storePathHash);
		await currentServer().runVerification();

		await expect(
			env.BLOBS.head(narInfoObjectKey(fixtureTenant, metadata.storePathHash))
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
		).value;
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
			env.BLOBS.head(narInfoObjectKey(fixtureTenant, metadata.storePathHash))
		).resolves.toBeNull();
	});

	it('reaps a canonical blob orphaned by losing the commit race at a different narHash', async () => {
		const token = await initialise();
		const narX = await verifiableNar('race-x');
		const narY = await verifiableNar('race-y');
		const storePathHash = storePathHashSchema.parse('a'.repeat(32));

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
		await putNarBytes(xUpload.r2Key, narX);
		await markUploadPendingVerification(xUpload.uploadId);

		// Defer a second upload of the SAME path P at a different narHash Y.
		const y = uploadMetadata({
			name: 'p',
			storePathHash,
			narHash: narY.narHash,
			fileHash: narY.fileHash,
			fileSize: narY.narBytes.byteLength,
			narSize: narY.narSize
		});
		const yUpload = expectSingleUploadDecision(
			await negotiateUploads(token, [y]),
			y
		);
		await putNarBytes(yUpload.r2Key, narY);
		await markUploadPendingVerification(yUpload.uploadId);

		// One pass settles both: whichever verifies first wins the narinfo row,
		// the other loses it, and anything the loser staged or promoted that no
		// edge references are reaped.
		await currentServer().runVerification();
		await currentServer().runGarbageCollection();

		const served = await fetchNarInfo(storePathHash);
		const winner = served.narHash.toString() === narX.narHash ? narX : narY;
		const loser = winner === narX ? narY : narX;

		await expect(
			env.BLOBS.head(narObjectKey(loser.narHash))
		).resolves.toBeNull();
		await expect(
			env.BLOBS.head(narObjectKey(winner.narHash))
		).resolves.not.toBeNull();
	});

	it('terminally fails a deferred upload whose staging object has vanished', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);

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
		await putNarBytes(upload.r2Key);

		const error = await rejectedBy(
			commitUpload(token, upload.uploadId),
			CommitSocketError
		);

		expect({ name: error.name, status: error.status }).toStrictEqual({
			name: 'CommitSocketError',
			status: StatusCodes.REQUEST_TOO_LONG
		});
		await expect(
			env.BLOBS.head(narInfoObjectKey(fixtureTenant, metadata.storePathHash))
		).resolves.toBeNull();
		await expect(env.BLOBS.head(upload.r2Key)).resolves.toBeNull();
	});

	it('defers every fresh upload to verification, asking for a prompt pass', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(upload.r2Key);

		// The deferral must trigger a prompt verification pass.
		const sent: unknown[] = [];
		const metrics = { backlogCount: 0, backlogBytes: 0 };
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.env = {
				...instance.context.env,
				MAINTENANCE_QUEUE: {
					send: (message: unknown) => {
						sent.push(message);
						return Promise.resolve({ metadata: { metrics } });
					},
					sendBatch: () => Promise.resolve({ metadata: { metrics } }),
					metrics: () => Promise.resolve(metrics)
				}
			};
			return Promise.resolve();
		});

		const commit = await commitUpload(token, upload.uploadId, DEFAULT_CACHE, {
			wait: false
		});

		expect({ status: commit.status, sent }).toStrictEqual({
			status: 'pending',
			sent: [{ kind: 'tenant-verify', tenant: fixtureTenant }]
		});
		await expect(
			env.BLOBS.head(narInfoObjectKey(fixtureTenant, metadata.storePathHash))
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

		await putNarBytes(first.r2Key);
		await putNarBytes(second.r2Key);

		const firstCommit = await commitUpload(token, first.uploadId);
		const secondCommit = await commitUpload(token, second.uploadId);

		expect(firstCommit.status).toBe('committed');
		expect(secondCommit.status).toBe('already-present');

		// Both private staging objects are reclaimed (the winner's on commit and
		// the loser's on the already-present path), leaving only the canonical blob.
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
		const init = await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		const first = expectSingleUploadDecision(
			await negotiateUploads(init.token, [metadata]),
			metadata
		);
		await putNarBytes(first.r2Key);

		const second = expectSingleUploadDecision(
			await negotiateUploads(init.token, [metadata]),
			metadata
		);

		const committed = await commitUpload(init.token, first.uploadId);

		expect(committed.status).toBe('committed');

		const stored = await readStoredNarInfo(metadata.storePathHash);
		const parsed = NarInfo.parse(stored.body);
		const [signature] = z.tuple([z.string()]).parse(parsed.sigs);

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
				sigs: [signature]
			}
		});
		expect({
			signatureVerified: await verifyNarInfoSignature(parsed, init.publicKey)
		}).toStrictEqual({ signatureVerified: true });

		const recommit = await commitUpload(init.token, second.uploadId);

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
		await putNarBytes(upload.r2Key);
		await commitUpload(init.token, upload.uploadId);

		const narInfo = await fetchNarInfo(metadata.storePathHash);

		expect({
			signatureVerified: await verifyNarInfoSignature(narInfo, init.publicKey)
		}).toStrictEqual({ signatureVerified: true });
	});

	it('returns 404 for a narinfo that has not been committed', async () => {
		const response = await readFetch(`/${'a'.repeat(32)}.narinfo`);

		expect(response.status).toBe(StatusCodes.NOT_FOUND);
	});

	it('restores a missing narinfo object through the negotiated reconcile', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await commitPath(token, metadata);

		const original = await readStoredNarInfo(metadata.storePathHash);

		// The common breakage: the narinfo object is gone but its NAR is intact.
		await env.BLOBS.delete(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash)
		);
		await expect(
			env.BLOBS.head(narInfoObjectKey(fixtureTenant, metadata.storePathHash))
		).resolves.toBeNull();

		// Negotiate skips on the lingering blob_state row and queues the path; it
		// does not heal on the hot path.
		const skip = await negotiateUploads(token, [metadata]);

		expect(skip.uploads).toStrictEqual([
			{
				action: 'skip',
				storePathHash: metadata.storePathHash,
				narHash: metadata.narHash
			}
		]);

		// The reconcile restores the object, so the path serves again after the one
		// re-push.
		await fireReconcile();

		const healed = await readStoredNarInfo(metadata.storePathHash);
		const served = await readFetch(`/${metadata.storePathHash}.narinfo`);

		expect({ body: healed.body, served: served.status }).toStrictEqual({
			body: original.body,
			served: StatusCodes.OK
		});
	});

	it('clears the orphaned narinfo object when its NAR blob is gone', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await commitPath(token, metadata);

		await env.BLOBS.delete(narObjectKey(metadata.narHash));

		// The blob_state row still backs the hash, so negotiate skips and queues the
		// path; the reconcile then finds the NAR truly gone and removes the narinfo.
		const skip = await negotiateUploads(token, [metadata]);

		expect(skip.uploads).toStrictEqual([
			{
				action: 'skip',
				storePathHash: metadata.storePathHash,
				narHash: metadata.narHash
			}
		]);

		await fireReconcile();

		await expect(
			env.BLOBS.head(narInfoObjectKey(fixtureTenant, metadata.storePathHash))
		).resolves.toBeNull();

		// With the dangling narinfo gone, the next re-push re-uploads the NAR.
		expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
	});

	it('purges the cached narinfo when the reconcile removes a missing NAR blob', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await commitPath(token, metadata);

		const cacheKeyUrl = new URL(
			narInfoCachePath(fixtureTenant, metadata.storePathHash),
			currentOrigin()
		);
		const cacheKey = cacheKeyUrl.href;
		await readFetch(`/${metadata.storePathHash}.narinfo`);

		await expect(cachedResponseShape(cacheKey)).resolves.toStrictEqual({
			cached: true,
			status: StatusCodes.OK
		});

		// Negotiate records the push origin with the queued path, so the reconcile
		// purges the edge cache the request populated when it removes the narinfo.
		await env.BLOBS.delete(narObjectKey(metadata.narHash));
		await negotiateUploads(token, [metadata]);
		await fireReconcile();

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

	it('keeps the shared blob accounting consistent when the reconcile removes a lost NAR', async () => {
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

		// Two committed paths share one blob; its object disappears.
		await env.BLOBS.delete(narObjectKey(first.narHash));

		// Negotiate skips both committed paths (the blob_state row still backs the
		// hash) and queues them. The reconcile finds the NAR gone and retires both
		// edges, crediting the shared blob exactly once: the per-tenant counters stay
		// consistent and non-negative across the two removals.
		await negotiateUploads(token, [first, second]);
		await fireReconcile();

		await expectStats(token, {
			storePaths: 0,
			narBlobs: 0,
			pendingUploads: 0,
			totalFileSize: 0
		});

		// A genuinely lost NAR re-plans an upload on the next push.
		expectSingleUploadDecision(await negotiateUploads(token, [third]), third);
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

		const cacheKeyUrl = new URL(
			narInfoCachePath(fixtureTenant, swept.storePathHash),
			currentOrigin()
		);
		const cacheKey = cacheKeyUrl.href;
		await readFetch(`/${swept.storePathHash}.narinfo`);

		await expect(cachedResponseShape(cacheKey)).resolves.toStrictEqual({
			cached: true,
			status: StatusCodes.OK
		});

		expect(await runGcResult()).toStrictEqual({
			ok: true,
			pendingUploadsDeleted: 0,
			pendingAttestationsDeleted: 0,
			rootsExpired: 0,
			pathsSwept: 1,
			narInfosDeleted: 1,
			orphanStagingDeleted: 0
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

		const cacheKeyUrl = new URL(
			narInfoCachePath(fixtureTenant, swept.storePathHash),
			currentOrigin()
		);
		const cacheKey = cacheKeyUrl.href;
		await readFetch(`/${swept.storePathHash}.narinfo`);

		await expect(cachedResponseShape(cacheKey)).resolves.toStrictEqual({
			cached: true,
			status: StatusCodes.OK
		});

		await runGcFromInternalOrigin();

		// The sweep removed the narinfo object, but a cron-origin GC cannot purge
		// the public edge cache, so the cached copy remains until its TTL lapses.
		await expect(
			env.BLOBS.head(narInfoObjectKey(fixtureTenant, swept.storePathHash))
		).resolves.toBeNull();
		await expect(cachedResponseShape(cacheKey)).resolves.toStrictEqual({
			cached: true,
			status: StatusCodes.OK
		});
	});

	it('spares an in-flight reserved narinfo row from the reachability sweep', async () => {
		const token = await initialise();
		// A distinct NAR so the in-flight upload below stays a genuine upload rather
		// than a reuse of this committed path's blob.
		const kept = await commitVerifiablePath(token, 'kept', { name: 'kept' });

		await setRoot(token, { name: 'main', targets: [kept.storePath] });

		// An in-flight commit saga: its narinfo row is reserved but unmaterialised, so
		// it is unreachable from the root and a sweep landing now would delete it.
		const reserved = uploadMetadata({
			fileSize: narBytes.byteLength,
			name: 'reserved',
			storePathHash: '33333333333333333333333333333333'
		});
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [reserved]),
			reserved
		);
		await putNarBytes(upload.r2Key);
		await seedReservedNarInfo(reserved);
		await markUploadCommitting(upload.uploadId);

		const result = await runGcResult();

		// The sweep spared the reserved row, so the verify pass still drives the
		// preserved saga to servable.
		await currentServer().runVerification();
		const narInfo = await fetchNarInfo(reserved.storePathHash);

		expect({ result, narHash: narInfo.narHash.toString() }).toStrictEqual({
			result: {
				ok: true,
				pendingUploadsDeleted: 0,
				pendingAttestationsDeleted: 0,
				rootsExpired: 0,
				pathsSwept: 0,
				narInfosDeleted: 0,
				orphanStagingDeleted: 0
			},
			narHash: reserved.narHash
		});
	});

	it.each([
		{
			name: 'a malformed NAR hash',
			fields: { narHash: 'sha256:not-a-valid-hash' },
			issues: [{ code: 'invalid_format', path: ['paths', 0, 'narHash'] }]
		},
		{
			name: 'a full store path reference',
			fields: {
				references: ['/nix/store/11111111111111111111111111111111-first']
			},
			issues: [{ code: 'invalid_format', path: ['paths', 0, 'references', 0] }]
		}
	])('rejects upload negotiation with $name', async ({ fields, issues }) => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		const response = await authorisedFetch('/cache/_default/uploads', token, {
			body: JSON.stringify({
				pushId: testPushId,
				paths: [{ ...uploadPathNegotiation(metadata), ...fields }]
			}),
			headers: {
				'content-type': 'application/json'
			},
			method: 'POST'
		});

		const body = badRequestBodyShape(await response.json());

		expect({
			status: response.status,
			body: {
				code: body.code,
				status: body.status,
				issues: body.issues
			}
		}).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			body: {
				code: 'BAD_REQUEST',
				status: StatusCodes.BAD_REQUEST,
				issues
			}
		});

		await expectStats(token, {
			storePaths: 0,
			narBlobs: 0,
			pendingUploads: 0,
			totalFileSize: 0
		});
	});

	it('rejects malformed JSON upload requests', async () => {
		const token = await initialise();
		const response = await authorisedFetch('/cache/_default/uploads', token, {
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
		await putNarBytes(upload.r2Key);

		await expect(env.BLOBS.head(upload.r2Key)).resolves.not.toBeNull();

		await expectStats(token, {
			storePaths: 0,
			narBlobs: 0,
			pendingUploads: 1,
			totalFileSize: 0
		});

		vi.setSystemTime(new Date('2026-01-01T00:16:00.000Z'));

		// The abandoned upload's private staging object is reclaimed directly when the
		// upload is reaped; it has no `blob_state` row, so the reaper collects nothing.
		expect(await runGcResult()).toStrictEqual({
			ok: true,
			pendingUploadsDeleted: 1,
			pendingAttestationsDeleted: 0,
			rootsExpired: 0,
			pathsSwept: 0,
			narInfosDeleted: 0,
			orphanStagingDeleted: 0
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
		await commitPath(token, metadata);
		await env.BLOBS.delete(narObjectKey(metadata.narHash));

		// Negotiate skips on the lingering blob_state row and queues the path; the
		// reconcile finds the NAR gone and removes the stale narinfo.
		await negotiateUploads(token, [metadata]);
		await fireReconcile();

		// The reconcile credited the tenant's presence back even though the shared
		// fact lingers for the reaper.
		await expectStats(token, {
			storePaths: 0,
			narBlobs: 0,
			pendingUploads: 0,
			totalFileSize: 0
		});

		// The next push re-plans an upload for the genuinely lost NAR.
		expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
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
		await putNarBytes(firstUpload.r2Key);
		await commitUpload(token, firstUpload.uploadId);
		expectSingleCommitDecision(await negotiateUploads(token, [second]), second);

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
			pendingAttestationsDeleted: 0,
			rootsExpired: 0,
			pathsSwept: 0,
			narInfosDeleted: 0,
			orphanStagingDeleted: 0
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
		await putNarBytes(upload.r2Key);

		await expectStatsViaWorker(token, {
			storePaths: 0,
			narBlobs: 0,
			pendingUploads: 1,
			totalFileSize: 0
		});

		vi.setSystemTime(new Date('2026-01-01T00:16:00.000Z'));
		await runQueuedMaintenanceTick();

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
		await putNarBytes(committedUpload.r2Key);
		const commit = await commitUploadViaWorker(token, committedUpload.uploadId);
		expect(commit.status).toBe('committed');
		await env.BLOBS.delete(
			narInfoObjectKey(fixtureTenant, committed.storePathHash)
		);

		// A distinct pending upload left to expire: GC must sweep it.
		const stale = uploadMetadata({
			fileSize: narBytes.byteLength,
			name: 'stale',
			storePathHash: '22222222222222222222222222222222',
			narHash: nixSha256Hash('2')
		});
		const staleNegotiation = await negotiateViaWorker(token, [stale]);
		const staleUpload = expectSingleUploadDecision(staleNegotiation, stale);

		vi.setSystemTime(new Date('2026-01-01T00:16:00.000Z'));
		await runQueuedMaintenanceTick();

		const restored = await env.BLOBS.head(
			narInfoObjectKey(fixtureTenant, committed.storePathHash)
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
		vi.setSystemTime(testBase);

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
		// The narinfo is gone immediately; the tenant's presence is gone even though
		// the now-unreferenced shared fact persists until the reaper collects it.
		await expectStats(token, {
			storePaths: 0,
			narBlobs: 0,
			pendingUploads: 0,
			totalFileSize: 0
		});

		// The first reaper pass arms the unreferenced blob but does not collect it.
		await runBlobReaper(rootLogger(), env);
		await expect(
			env.BLOBS.head(narObjectKey(metadata.narHash))
		).resolves.not.toBeNull();

		vi.setSystemTime(afterGrace());
		await runBlobReaper(rootLogger(), env);
		await expect(
			env.BLOBS.head(narObjectKey(metadata.narHash))
		).resolves.toBeNull();
	});

	it('retains a NAR still referenced by another store path', async () => {
		vi.setSystemTime(testBase);

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

		// The first reaper pass arms the now-unreferenced blob; the pass past the
		// grace collects it.
		await runBlobReaper(rootLogger(), env);
		vi.setSystemTime(afterGrace());
		await runBlobReaper(rootLogger(), env);
		await expect(
			env.BLOBS.head(narObjectKey(second.narHash))
		).resolves.toBeNull();
	});

	it('is idempotent when deleting an absent store path', async () => {
		const token = await initialise();
		const result = await deletePath(
			token,
			storePathHashSchema.parse('33333333333333333333333333333333')
		);

		expect(result).toStrictEqual({
			storePathHash: '33333333333333333333333333333333',
			deleted: false,
			narScheduledForDeletion: false
		});
	});

	it('does not collect an armed NAR before its grace elapses', async () => {
		vi.setSystemTime(testBase);

		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await commitPath(token, metadata);
		await deletePath(token, metadata.storePathHash);

		// Arm the now-unreferenced blob, fixing its grace window.
		await runBlobReaper(rootLogger(), env);

		// A later reaper pass before the grace elapses must not collect it.
		vi.setSystemTime(new Date(testBase.getTime() + 16 * 60 * 1000));
		await runBlobReaper(rootLogger(), env);
		await expect(
			env.BLOBS.head(narObjectKey(metadata.narHash))
		).resolves.not.toBeNull();

		vi.setSystemTime(afterGrace());
		await runBlobReaper(rootLogger(), env);
		await expect(
			env.BLOBS.head(narObjectKey(metadata.narHash))
		).resolves.toBeNull();
	});

	it('rejects an unauthenticated delete', async () => {
		const response = await fetchPath(
			'/cache/_default/paths/11111111111111111111111111111111',
			{
				method: 'DELETE'
			}
		);

		expect(response.status).toBe(StatusCodes.UNAUTHORIZED);
	});

	it('rejects a malformed store path hash', async () => {
		const token = await initialise();
		const response = await authorisedFetch(
			'/cache/_default/paths/not-a-valid-hash',
			token,
			{
				method: 'DELETE'
			}
		);

		expect(response.status).toBe(StatusCodes.BAD_REQUEST);
	});

	it('recovers an interrupted narinfo deletion through GC', async () => {
		vi.setSystemTime(testBase);

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
		// object cleanup failed: the narinfo object, its NAR edge and its NAR all
		// survive, so tenant-scoped usage is still charged.
		await expectStats(token, {
			storePaths: 0,
			narBlobs: 1,
			narFileSize: narBytes.byteLength,
			pendingUploads: 0,
			totalFileSize: narBytes.byteLength
		});
		await expect(
			env.BLOBS.head(narInfoObjectKey(fixtureTenant, metadata.storePathHash))
		).resolves.not.toBeNull();
		await expect(
			env.BLOBS.head(narObjectKey(metadata.narHash))
		).resolves.not.toBeNull();

		const recovered = await runGcResult();

		// GC flushed the durable queue: the narinfo object is gone and the NAR is
		// only now scheduled, with the grace starting from this removal.
		expect(recovered.narInfosDeleted).toBe(1);
		await expect(
			env.BLOBS.head(narInfoObjectKey(fixtureTenant, metadata.storePathHash))
		).resolves.toBeNull();
		await expect(
			env.BLOBS.head(narObjectKey(metadata.narHash))
		).resolves.not.toBeNull();

		// The edge is retired, so the blob is now unreferenced; the reaper arms it,
		// then collects it past the grace.
		await runBlobReaper(rootLogger(), env);
		vi.setSystemTime(afterGrace());
		await runBlobReaper(rootLogger(), env);
		await expect(
			env.BLOBS.head(narObjectKey(metadata.narHash))
		).resolves.toBeNull();
	});

	it('retains a re-pushed path left dangling by an interrupted deletion', async () => {
		vi.setSystemTime(testBase);

		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await commitPath(token, metadata);

		const deleteSpy = vi
			.spyOn(env.BLOBS, 'delete')
			.mockRejectedValueOnce(new Error('simulated R2 outage'));
		await deletePath(token, metadata.storePathHash);
		deleteSpy.mockRestore();

		// The path is committed again before GC reaches the dangling queue entry.
		// The failed object cleanup leaves this tenant's presence edge charged, so the
		// recommit reuses the tenant-held hash.
		await commitSharedPath(token, metadata);

		const served = await readFetch(`/${metadata.storePathHash}.narinfo`);

		expect(served.status).toBe(StatusCodes.OK);

		const collected = await runGcResult();

		// The re-committed row owns a live object, so the stale entry is dropped
		// without deleting the object.
		const stillServed = await readFetch(`/${metadata.storePathHash}.narinfo`);

		expect({
			narInfosDeleted: collected.narInfosDeleted,
			narInfoStored:
				(await env.BLOBS.head(
					narInfoObjectKey(fixtureTenant, metadata.storePathHash)
				)) !== null,
			stillServedStatus: stillServed.status
		}).toStrictEqual({
			narInfosDeleted: 0,
			narInfoStored: true,
			stillServedStatus: StatusCodes.OK
		});
	});

	describe('retention roots', () => {
		const absentPath = '/nix/store/22222222222222222222222222222222-absent';

		it('creates a root with TTL expiry over a servable target', async () => {
			vi.setSystemTime(testBase);

			const token = await initialise();
			const committed = uploadMetadata({ fileSize: narBytes.byteLength });
			await commitPath(token, committed);

			const summary = await setRoot(token, {
				name: 'github:owner/repo/main',
				targets: [committed.storePath],
				ttlSeconds: 604_800
			});
			const expiresAt = new Date(testBase.getTime() + 604_800 * 1000);

			expect(summary).toStrictEqual({
				name: 'github:owner/repo/main',
				expiresAt: expiresAt.toISOString(),
				expired: false,
				createdAt: testBase.toISOString(),
				updatedAt: testBase.toISOString(),
				targets: [
					{
						storePathHash: committed.storePathHash,
						storePath: committed.storePath,
						present: true
					}
				]
			});
		});

		it('refuses to activate a root with an unservable target, leaving any existing root intact', async () => {
			vi.setSystemTime(testBase);

			const token = await initialise();
			const committed = uploadMetadata({ fileSize: narBytes.byteLength });
			await commitPath(token, committed);
			const original = await setRoot(token, {
				name: 'main',
				targets: [committed.storePath]
			});

			// Re-setting the same root with a not-yet-servable target must be refused
			// wholesale, so the channel keeps its previous, servable target set.
			const response = await authorisedFetch(
				'/cache/_default/roots/main',
				token,
				{
					body: JSON.stringify({ targets: [committed.storePath, absentPath] }),
					headers: { 'content-type': 'application/json' },
					method: 'PUT'
				}
			);
			const { roots } = await listRoots(token);

			expect({ status: response.status, roots }).toStrictEqual({
				status: StatusCodes.CONFLICT,
				roots: [original]
			});
		});

		it('replaces the target set wholesale and resets the expiry', async () => {
			vi.setSystemTime(testBase);

			const token = await initialise();
			const first = await commitVerifiablePath(token, 'replace-a', {
				name: 'a',
				storePathHash: hashA
			});
			const second = await commitVerifiablePath(token, 'replace-b', {
				name: 'b',
				storePathHash: hashB
			});

			await setRoot(token, {
				name: 'pr-1',
				targets: [first.storePath],
				ttlSeconds: 604_800
			});

			const later = new Date(testBase.getTime() + 3600 * 1000);
			vi.setSystemTime(later);
			const summary = await setRoot(await initialise(), {
				name: 'pr-1',
				targets: [second.storePath]
			});

			expect(summary).toStrictEqual({
				name: 'pr-1',
				expired: false,
				createdAt: testBase.toISOString(),
				updatedAt: later.toISOString(),
				targets: [
					{
						storePathHash: hashB,
						storePath: second.storePath,
						present: true
					}
				]
			});
		});

		it('deduplicates repeated targets instead of erroring', async () => {
			const token = await initialise();
			const committed = uploadMetadata({
				fileSize: narBytes.byteLength,
				name: 'a'
			});
			await commitPath(token, committed);
			const path = committed.storePath;

			const summary = await setRoot(token, {
				name: 'main',
				targets: [path, path]
			});

			expect(summary.targets).toStrictEqual([
				{
					storePathHash: committed.storePathHash,
					storePath: path,
					present: true
				}
			]);
		});

		it('lists roots sorted by name and flags expired ones', async () => {
			vi.setSystemTime(testBase);

			const token = await initialise();
			const committed = uploadMetadata({
				fileSize: narBytes.byteLength,
				name: 'a'
			});
			await commitPath(token, committed);
			const path = committed.storePath;

			await setRoot(token, { name: 'pr-9', targets: [path], ttlSeconds: 60 });
			await setRoot(token, { name: 'main', targets: [path] });

			vi.setSystemTime(new Date(testBase.getTime() + 120 * 1000));
			const { roots } = await listRoots(token);
			const pr9ExpiresAt = new Date(testBase.getTime() + 60_000);

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
					expiresAt: pr9ExpiresAt.toISOString()
				}
			]);
		});

		it('removes a root and is a no-op for an absent name', async () => {
			const token = await initialise();
			const committed = uploadMetadata({
				fileSize: narBytes.byteLength,
				name: 'a'
			});
			await commitPath(token, committed);
			await setRoot(token, { name: 'pr-1', targets: [committed.storePath] });

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
			const set = await fetchPath('/cache/_default/roots/main', {
				body: JSON.stringify({ targets: [target] }),
				headers: { 'content-type': 'application/json' },
				method: 'PUT'
			});
			const list = await fetchPath('/cache/_default/roots');
			const remove = await fetchPath('/cache/_default/roots/main', {
				method: 'DELETE'
			});

			expect([set.status, list.status, remove.status]).toStrictEqual([
				StatusCodes.UNAUTHORIZED,
				StatusCodes.UNAUTHORIZED,
				StatusCodes.UNAUTHORIZED
			]);
		});

		it('rejects a malformed root request', async () => {
			const token = await initialise();
			const response = await authorisedFetch(
				'/cache/_default/roots/main',
				token,
				{
					body: JSON.stringify({ targets: [] }),
					headers: { 'content-type': 'application/json' },
					method: 'PUT'
				}
			);

			expect(response.status).toBe(StatusCodes.BAD_REQUEST);
		});

		const hashA = storePathHashSchema.parse('11111111111111111111111111111111');
		const hashB = storePathHashSchema.parse('22222222222222222222222222222222');
		const hashC = storePathHashSchema.parse('33333333333333333333333333333333');

		it('sweeps unreachable paths and keeps the rooted closure', async () => {
			vi.setSystemTime(testBase);

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
				pendingAttestationsDeleted: 0,
				rootsExpired: 0,
				pathsSwept: 1,
				narInfosDeleted: 1,
				orphanStagingDeleted: 0
			});

			await expect(
				env.BLOBS.head(narInfoObjectKey(fixtureTenant, hashC))
			).resolves.toBeNull();
			await expect(
				env.BLOBS.head(narInfoObjectKey(fixtureTenant, hashA))
			).resolves.not.toBeNull();
			await expect(
				env.BLOBS.head(narInfoObjectKey(fixtureTenant, hashB))
			).resolves.not.toBeNull();
		});

		it('keeps a transitively-referenced closure a -> b -> c', async () => {
			vi.setSystemTime(testBase);
			const hashD = storePathHashSchema.parse(
				'44444444444444444444444444444444'
			);

			const token = await initialise();
			const a = await commitVerifiablePath(token, 'a', {
				name: 'a',
				storePathHash: hashA,
				references: [`${hashB}-b`]
			});
			await commitVerifiablePath(token, 'b', {
				name: 'b',
				storePathHash: hashB,
				references: [`${hashC}-c`]
			});
			await commitVerifiablePath(token, 'c', {
				name: 'c',
				storePathHash: hashC,
				references: []
			});
			await commitVerifiablePath(token, 'd', {
				name: 'd',
				storePathHash: hashD,
				references: []
			});
			await setRoot(token, { name: 'main', targets: [a.storePath] });

			expect(await runGcResult()).toStrictEqual({
				ok: true,
				pendingUploadsDeleted: 0,
				pendingAttestationsDeleted: 0,
				rootsExpired: 0,
				pathsSwept: 1,
				narInfosDeleted: 1,
				orphanStagingDeleted: 0
			});

			for (const hash of [hashA, hashB, hashC]) {
				await expect(
					env.BLOBS.head(narInfoObjectKey(fixtureTenant, hash))
				).resolves.not.toBeNull();
			}
			await expect(
				env.BLOBS.head(narInfoObjectKey(fixtureTenant, hashD))
			).resolves.toBeNull();
		});

		it('keeps a cyclic closure a <-> b and still terminates', async () => {
			vi.setSystemTime(testBase);
			const hashD = storePathHashSchema.parse(
				'44444444444444444444444444444444'
			);

			const token = await initialise();
			const a = await commitVerifiablePath(token, 'a', {
				name: 'a',
				storePathHash: hashA,
				references: [`${hashB}-b`]
			});
			await commitVerifiablePath(token, 'b', {
				name: 'b',
				storePathHash: hashB,
				references: [`${hashA}-a`]
			});
			await commitVerifiablePath(token, 'd', {
				name: 'd',
				storePathHash: hashD,
				references: []
			});
			await setRoot(token, { name: 'main', targets: [a.storePath] });

			expect(await runGcResult()).toStrictEqual({
				ok: true,
				pendingUploadsDeleted: 0,
				pendingAttestationsDeleted: 0,
				rootsExpired: 0,
				pathsSwept: 1,
				narInfosDeleted: 1,
				orphanStagingDeleted: 0
			});

			for (const hash of [hashA, hashB]) {
				await expect(
					env.BLOBS.head(narInfoObjectKey(fixtureTenant, hash))
				).resolves.not.toBeNull();
			}
			await expect(
				env.BLOBS.head(narInfoObjectKey(fixtureTenant, hashD))
			).resolves.toBeNull();
		});

		it('skips the sweep when no root is defined', async () => {
			const token = await initialise();
			const path = uploadMetadata({ fileSize: narBytes.byteLength });
			await commitPath(token, path);

			expect(await runGcResult()).toStrictEqual({
				ok: true,
				pendingUploadsDeleted: 0,
				pendingAttestationsDeleted: 0,
				rootsExpired: 0,
				pathsSwept: 0,
				narInfosDeleted: 0,
				orphanStagingDeleted: 0
			});
			await expect(
				env.BLOBS.head(narInfoObjectKey(fixtureTenant, path.storePathHash))
			).resolves.not.toBeNull();
		});

		it('skips the sweep when roots resolve to nothing committed', async () => {
			const token = await initialise();
			const committed = uploadMetadata({ fileSize: narBytes.byteLength });
			await commitPath(token, committed);

			// Activation only allows a servable target, but that target can later be
			// deleted, leaving the root resolving to nothing committed. The sweep must
			// then skip the rest of the cache.
			const ghost = await commitVerifiablePath(token, 'ghost', {
				name: 'ghost',
				storePathHash: '99999999999999999999999999999999'
			});
			await setRoot(token, { name: 'ghost', targets: [ghost.storePath] });
			await deletePath(token, ghost.storePathHash);

			expect(await runGcResult()).toStrictEqual({
				ok: true,
				pendingUploadsDeleted: 0,
				pendingAttestationsDeleted: 0,
				rootsExpired: 0,
				pathsSwept: 0,
				narInfosDeleted: 0,
				orphanStagingDeleted: 0
			});
			await expect(
				env.BLOBS.head(narInfoObjectKey(fixtureTenant, committed.storePathHash))
			).resolves.not.toBeNull();
		});

		it('sweeps a path freed by an expired root while a live root remains', async () => {
			vi.setSystemTime(testBase);

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

			vi.setSystemTime(new Date(testBase.getTime() + 120_000));

			expect(await runGcResult()).toStrictEqual({
				ok: true,
				pendingUploadsDeleted: 0,
				pendingAttestationsDeleted: 0,
				rootsExpired: 1,
				pathsSwept: 1,
				narInfosDeleted: 1,
				orphanStagingDeleted: 0
			});

			const { roots } = await listRoots(token);

			expect(roots.map((root) => root.name)).toStrictEqual(['keep']);
			await expect(
				env.BLOBS.head(narInfoObjectKey(fixtureTenant, hashB))
			).resolves.toBeNull();
			await expect(
				env.BLOBS.head(narInfoObjectKey(fixtureTenant, hashA))
			).resolves.not.toBeNull();
		});

		it('sweeps a path freed by the last expired root', async () => {
			vi.setSystemTime(testBase);

			const token = await initialise();
			const b = uploadMetadata({ fileSize: narBytes.byteLength });
			await commitPath(token, b);
			await setRoot(token, {
				name: 'pr',
				targets: [b.storePath],
				ttlSeconds: 60
			});

			vi.setSystemTime(new Date(testBase.getTime() + 120_000));

			expect(await runGcResult()).toStrictEqual({
				ok: true,
				pendingUploadsDeleted: 0,
				pendingAttestationsDeleted: 0,
				rootsExpired: 1,
				pathsSwept: 1,
				narInfosDeleted: 1,
				orphanStagingDeleted: 0
			});

			const { roots } = await listRoots(token);

			expect(roots).toStrictEqual([]);
			await expect(
				env.BLOBS.head(narInfoObjectKey(fixtureTenant, b.storePathHash))
			).resolves.toBeNull();
		});

		it('keeps a NAR shared with a retained path', async () => {
			vi.setSystemTime(testBase);

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
				pendingAttestationsDeleted: 0,
				rootsExpired: 0,
				pathsSwept: 1,
				narInfosDeleted: 1,
				orphanStagingDeleted: 0
			});

			await expect(
				env.BLOBS.head(narInfoObjectKey(fixtureTenant, hashC))
			).resolves.toBeNull();
			await expect(
				env.BLOBS.head(narObjectKey(narHash))
			).resolves.not.toBeNull();
			await expect(
				env.BLOBS.head(narInfoObjectKey(fixtureTenant, hashA))
			).resolves.not.toBeNull();
		});

		it('defers a swept path NAR until the grace elapses', async () => {
			vi.setSystemTime(testBase);

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

			// The per-tenant sweep removes the unreachable path c and retires its
			// edge; the now-unreferenced blob is reaped separately, Worker-side.
			expect(await runGcResult()).toStrictEqual({
				ok: true,
				pendingUploadsDeleted: 0,
				pendingAttestationsDeleted: 0,
				rootsExpired: 0,
				pathsSwept: 1,
				narInfosDeleted: 1,
				orphanStagingDeleted: 0
			});

			// The reaper arms the unreferenced blob; the grace not yet elapsed, the
			// object stays.
			expect({
				deleted: await runBlobReaper(rootLogger(), env),
				stored: (await env.BLOBS.head(narObjectKey(cNar.narHash))) !== null
			}).toStrictEqual({
				deleted: 0,
				stored: true
			});

			vi.setSystemTime(afterGrace());

			// Past the grace the reaper collects the fact and then the object.
			expect(await runBlobReaper(rootLogger(), env)).toBe(1);
			await expect(
				env.BLOBS.head(narObjectKey(cNar.narHash))
			).resolves.toBeNull();
		});
	});

	describe('authentication', () => {
		it('accepts a bootstrap-issued admin token on each scope of route', async () => {
			const token = await initialise();
			// Root activation gates on servability, so commit the target first.
			await pushPath(
				token,
				uploadMetadata({ fileSize: narBytes.byteLength, name: 'a' })
			);
			const stats = await authorisedFetch(defaultCacheStatsPath, token);
			const rootResponse = await authorisedFetch(
				'/cache/_default/roots/main',
				token,
				{
					body: JSON.stringify({
						targets: ['/nix/store/11111111111111111111111111111111-a']
					}),
					headers: { 'content-type': 'application/json' },
					method: 'PUT'
				}
			);

			expect([stats.status, rootResponse.status]).toStrictEqual([
				StatusCodes.OK,
				StatusCodes.OK
			]);
		});

		it('refuses a write token on admin routes but accepts it on write routes', async () => {
			const admin = await initialise();
			const target = '/nix/store/11111111111111111111111111111111-a';
			// Root activation gates on servability, so commit the target first.
			await pushPath(
				admin,
				uploadMetadata({ fileSize: narBytes.byteLength, name: 'a' })
			);
			const writeToken = await issueServerSignedToken(
				cacheWriteGrants(['main']),
				'ci'
			);

			const rootResponse = await authorisedFetch(
				'/cache/_default/roots/main',
				writeToken,
				{
					body: JSON.stringify({ targets: [target] }),
					headers: { 'content-type': 'application/json' },
					method: 'PUT'
				}
			);
			const stats = await authorisedFetch(defaultCacheStatsPath, writeToken);
			const removed = await authorisedFetch(
				'/cache/_default/paths/11111111111111111111111111111111',
				writeToken,
				{ method: 'DELETE' }
			);
			const gc = await authorisedFetch('/gc', writeToken, { method: 'POST' });

			expect({
				setRoot: rootResponse.status,
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
			const response = await authorisedFetch(
				defaultCacheStatsPath,
				await token()
			);

			expect(response.status).toBe(StatusCodes.UNAUTHORIZED);
		});

		it.each(['github:owner/repo/main', 'pr/123', 'a%b'])(
			'round-trips the root name %j through encode, route and decode',
			async (name) => {
				const token = await initialise();
				const committed = uploadMetadata({
					fileSize: narBytes.byteLength,
					name: 'a'
				});
				await commitPath(token, committed);
				const target = committed.storePath;
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
	const signer = new SignJWT({ scope });

	return signer
		.setProtectedHeader({ alg: 'EdDSA' })
		.setIssuer('cupboard')
		.setAudience('cupboard')
		.setSubject('attacker')
		.setIssuedAt(issuedAt)
		.setNotBefore(issuedAt)
		.setExpirationTime(issuedAt + 600)
		.sign(privateKey);
}

async function runQueuedMaintenanceTick(): Promise<void> {
	// The eligibility projection is already current: each mutation reconciles it
	// synchronously, so the cron tick reads a fresh wake time with nothing deferred.
	const messages = await enqueueMaintenanceJobs(env, queueCollector());

	for (const message of messages) {
		await executeMaintenanceQueueMessage(rootLogger(), env, message);
	}
}

function queueCollector(): {
	readonly sendBatch: (
		batch: Iterable<{ readonly body: MaintenanceQueueMessage }>
	) => Promise<QueueSendBatchResponse>;
} {
	return { sendBatch: () => Promise.resolve(queueSendBatchResponse()) };
}

function queueSendBatchResponse(): QueueSendBatchResponse {
	return {
		metadata: {
			metrics: {
				backlogBytes: 0,
				backlogCount: 0
			}
		}
	};
}
