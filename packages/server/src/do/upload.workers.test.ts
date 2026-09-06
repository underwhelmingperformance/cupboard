import { rootLogger } from '@cupboard/logger';
import { startCapture } from '@cupboard/logger/testing';
import { CacheInfo } from '@cupboard/nix-store/cache-info';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	narInfoGenerationSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import {
	type DeletePathResponseInput,
	type UploadId,
	uploadIdSchema
} from '@cupboard/protocol/upload';
import {
	commitCapabilitiesHeader,
	commitCapabilitiesValue,
	type CommitSessionFrame
} from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { buildVersion } from '../build-info.generated.ts';
import * as schema from '../db/schema.ts';
import { narCacheTag, narInfoCacheTag } from '../http/cache-tags.ts';
import {
	narInfoObjectKey,
	narObjectKey,
	r2ObjectKeySchema,
	verifiableMaxBytes
} from '../http/http.ts';
import {
	enqueueMaintenanceJobs,
	executeMaintenanceQueueMessage,
	type MaintenanceQueueMessage,
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
	currentNarObjectKey,
	currentOrigin,
	currentServer,
	currentServerTenant,
	defaultCache,
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
	isNarInfoSignatureValid,
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
	recordClaimedMissingObject,
	recordClaimedVerification,
	removeRoot,
	resetTestServer,
	resolvedCache,
	runBlobReaperToCompletion as runBlobReaper,
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
	verifyCurrentTenant,
	workerFetch
} from '../test-support.ts';

import { NarInfoObjectsService } from './narinfo-objects-service.ts';

function byUploadId(
	left: { readonly uploadId: string },
	right: { readonly uploadId: string }
): number {
	return left.uploadId.localeCompare(right.uploadId);
}

// Use an empty upload ID for connection-level frames in order-insensitive
// comparisons.
function frameIdentity(frame: CommitSessionFrame): {
	readonly ev: string;
	readonly uploadId: string;
} {
	return {
		ev: frame.ev,
		uploadId: 'uploadId' in frame ? frame.uploadId : ''
	};
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

// The test pool does not dispatch request-armed alarms, so invoke the Durable
// Object alarm directly to run negotiated reconciliation.
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

// Validation messages can change between schema-library versions. Compare the
// stable code, status, issue code, and path.
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
		vi.restoreAllMocks();
	});

	it('serves cache metadata without caching its mutable priority', async () => {
		await expectTextResponse(
			'/nix-cache-info',
			{
				body: CacheInfo.default.render(),
				cacheControl: 'no-store',
				contentType: 'text/x-nix-cache-info; charset=utf-8',
				method: 'GET'
			},
			readFetch
		);
		await expectTextResponse(
			'/nix-cache-info',
			{
				body: CacheInfo.default.render(),
				cacheControl: 'no-store',
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
			publicKey: { name: 'cupboard-v1-1', rawBytes: 32 }
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
				publicKey: { name: 'cupboard-v1-1', rawBytes: 32 },
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
		const negotiate = await fetchPath('/uploads', {
			body: JSON.stringify({ pushId: testPushId, paths: [] }),
			headers: {
				'content-type': 'application/json'
			},
			method: 'POST'
		});
		const commit = await fetchPath('/commit', {
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
			url: narObjectKey(metadata.narHash, 2),
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
		const cachedNarInfo = await readFetch(`/${metadata.storePathHash}.narinfo`);
		expect({
			signatureVerified: await isNarInfoSignatureValid(narInfo, init.publicKey),
			cacheTag: cachedNarInfo.headers.get('cache-tag')
		}).toStrictEqual({
			signatureVerified: true,
			cacheTag: `narinfo:v1:default:${metadata.storePathHash}`
		});
		const objectKey = narInfoObjectKey(fixtureTenant, metadata.storePathHash, {
			kind: 'default'
		});
		const storedNarInfo = await env.BLOBS.get(objectKey);

		if (storedNarInfo === null) {
			throw new Error('Expected the committed narinfo object');
		}

		await env.BLOBS.put(objectKey, await storedNarInfo.arrayBuffer(), {
			customMetadata: storedNarInfo.customMetadata,
			httpMetadata: {
				contentType: 'text/x-nix-narinfo; charset=utf-8',
				cacheControl: 'public, max-age=3600'
			}
		});
		const legacyMetadata = await readFetch(
			`/${metadata.storePathHash}.narinfo`
		);

		expect(legacyMetadata.headers.get('cache-control')).toBe(
			'public, max-age=3600, must-revalidate'
		);
		await expectTextResponse(
			`/${metadata.storePathHash}.narinfo`,
			{
				body: narInfo.render(),
				cacheControl: 'public, max-age=3600, must-revalidate',
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
		const narPath = `/${await currentNarObjectKey(metadata.narHash)}`;
		await expectConditionalNotModified(narPath, readFetch);
		await expectDateConditionalNotModified(narPath, readFetch);
	});

	it('logs the row cost of the cold start and a settled commit', async () => {
		const capture = startCapture();

		try {
			// Reset inside the capture so it observes the cold-start migration.
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

		// Migration and commit bypass `fetch`, so each must create its own metered
		// request context. Their exact row counts depend on migration history and
		// closure size; assert only that accounting occurred.
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

		// Exercise skip, reuse, and fresh-upload decisions in one bulk request so a
		// result cannot be associated with the wrong path.
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

	it('serves a NAR only through tenants that reference it', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await commitPath(token, metadata);
		await provisionNamedTenant('acme');

		const narPath = `/${await currentNarObjectKey(metadata.narHash)}`;
		const owner = await readFetch(narPath);
		const intruder = await handlerFetch(`/t/acme${narPath}`);

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
		// The compressed hash matches, but the bytes decode to a different NAR.
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
			env.BLOBS.head(
				narInfoObjectKey(fixtureTenant, metadata.storePathHash, {
					kind: 'default'
				})
			)
		).resolves.toBeNull();
		await expect(env.BLOBS.head(upload.r2Key)).resolves.toBeNull();
	});

	it('rejects corrupt, undecompressable bytes at verification', async () => {
		const token = await initialise();
		// The compressed hash matches, but the bytes are not a zstd frame.
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
			env.BLOBS.head(
				narInfoObjectKey(fixtureTenant, metadata.storePathHash, {
					kind: 'default'
				})
			)
		).resolves.toBeNull();
		await expect(env.BLOBS.head(upload.r2Key)).resolves.toBeNull();
	});

	it('still accepts a correct upload of a narHash a bad upload was rejected for', async () => {
		const token = await initialise();
		const good = await verifiableNar('isolation-good');
		const wrong = await verifiableNar('isolation-wrong');

		// The compressed hash matches the staged bytes, but their NAR hash differs.
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
		const blob = await env.BLOBS.head(await currentNarObjectKey(good.narHash));

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

		// Use two compressed encodings of the same NAR with different file hashes.
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

		// Negotiate both encodings before either commit so they race to establish
		// the canonical object.
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

		const firstInfo = await fetchNarInfo(first.storePathHash);
		const secondInfo = await fetchNarInfo(second.storePathHash);
		const canonical = await env.BLOBS.head(
			await currentNarObjectKey(compressed.narHash)
		);
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

		await verifyCurrentTenant();

		// A terminal verdict remains readable during the observation window after
		// the staging bytes are deleted.
		expect(await pendingUploadVerdict(upload.uploadId)).toBe('mismatch');
		await expect(env.BLOBS.head(upload.r2Key)).resolves.toBeNull();
		await expect(
			env.BLOBS.head(
				narInfoObjectKey(fixtureTenant, metadata.storePathHash, {
					kind: 'default'
				})
			)
		).resolves.toBeNull();

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

		// Reuse must take narSize from the verified canonical object rather than
		// from the new path's untrusted metadata.
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

		// Every fresh upload remains pending until the background pass verifies its
		// staged bytes.
		await markUploadPendingVerification(upload.uploadId);

		await expect(
			env.BLOBS.head(
				narInfoObjectKey(fixtureTenant, metadata.storePathHash, {
					kind: 'default'
				})
			)
		).resolves.toBeNull();

		// Pending verification survives the ordinary upload expiry.
		vi.setSystemTime(new Date('2026-01-01T00:16:00.000Z'));
		await currentServer().runGarbageCollection();
		await verifyCurrentTenant();

		const narInfo = await fetchNarInfo(metadata.storePathHash);

		expect(narInfo.narHash.toString()).toBe(metadata.narHash);
		await expect(
			env.BLOBS.head(
				narInfoObjectKey(fixtureTenant, metadata.storePathHash, {
					kind: 'default'
				})
			)
		).resolves.not.toBeNull();
	});

	it('re-drives a commit that crashed after writing its committing marker', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(upload.r2Key);

		// Reproduce a crash after the durable marker and before narinfo reservation.
		await markUploadCommitting(upload.uploadId);

		await expect(
			env.BLOBS.head(
				narInfoObjectKey(fixtureTenant, metadata.storePathHash, {
					kind: 'default'
				})
			)
		).resolves.toBeNull();

		await verifyCurrentTenant();

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

		// GC and verification have no guaranteed relative order. A `committing`
		// upload must survive expiry until verification can resume it.
		vi.setSystemTime(new Date('2026-01-01T00:16:00.000Z'));
		await currentServer().runGarbageCollection();

		expect(await pendingUploadVerdict(upload.uploadId)).toBe('committing');
		await expect(env.BLOBS.head(upload.r2Key)).resolves.not.toBeNull();

		await verifyCurrentTenant();

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

		// The durable marker must precede reservation and verification so an
		// interruption leaves work that a later pass can resume.
		const deferred = await commitUpload(
			token,
			upload.uploadId,
			defaultCache(),
			{
				wait: false
			}
		);

		expect({
			status: deferred.status,
			verdict: await pendingUploadVerdict(upload.uploadId)
		}).toStrictEqual({ status: 'pending', verdict: 'committing' });

		await verifyCurrentTenant();

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
		await commitUpload(token, upload.uploadId, defaultCache(), { wait: false });

		// The queue consumer claims the deferred upload (a read on the DO), decodes
		// the bytes off the DO thread, then reports the verdict back.
		const claim = await currentServer().claimVerificationBatch(
			10,
			Number.MAX_SAFE_INTEGER
		);
		expect(claim.claims).toStrictEqual([
			{
				uploadId: upload.uploadId,
				r2Key: upload.r2Key,
				narHash: metadata.narHash,
				narSize: metadata.narSize,
				reuse: false
			}
		]);

		// The off-DO consumer reports the file hash and size it computed while
		// decoding. Promotion stores that metadata for the served narinfo.
		await currentServer().recordVerifications(claim.owner, [
			{
				uploadId: upload.uploadId,
				verdict: {
					kind: 'verified',
					verification: {
						ok: true,
						fileHash: fileHash.value,
						fileSize: narBytes.byteLength
					}
				}
			}
		]);

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
		await commitUpload(token, upload.uploadId, defaultCache(), { wait: false });

		await recordClaimedVerification(upload.uploadId, {
			ok: false,
			reason: 'nar-hash-mismatch',
			actualNarHash: metadata.narHash
		});

		expect(await pendingUploadVerdict(upload.uploadId)).toBe('mismatch');
		await expect(
			env.BLOBS.head(
				narInfoObjectKey(fixtureTenant, metadata.storePathHash, {
					kind: 'default'
				})
			)
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
		await commitUpload(token, upload.uploadId, defaultCache(), { wait: false });

		await recordClaimedMissingObject(upload.uploadId);

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

		const session = await openCommitSession(token);
		session.send({ op: 'commit', uploadId: a.uploadId });
		session.send({ op: 'commit', uploadId: b.uploadId });
		const frames = [await session.nextFrame(), await session.nextFrame()];
		session.socket.close();

		expect(
			frames.map((frame) => frameIdentity(frame)).toSorted(byUploadId)
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

		const first = await openCommitSession(token);
		first.send({ op: 'commit', uploadId: upload.uploadId });
		const deferred = await first.nextFrame();
		expect(deferred.ev).toBe('deferred');
		first.socket.close();

		const second = await openCommitSession(token);
		second.send({ op: 'subscribe', uploadIds: [upload.uploadId] });
		const replay = await second.nextFrame();
		expect(frameIdentity(replay)).toStrictEqual({
			ev: 'deferred',
			uploadId: upload.uploadId
		});

		await verifyCurrentTenant();
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

		const committed = await commitUpload(token, upload.uploadId);
		expect(committed.status).toBe('committed');

		// The legacy ID-only subscription cannot distinguish a committed upload
		// from one whose row expired. For this committed path it returns servable.
		const session = await openCommitSession(token);
		session.send({ op: 'subscribe', uploadIds: [upload.uploadId] });
		const replay = await session.nextFrame();
		session.socket.close();

		expect(frameIdentity(replay)).toStrictEqual({
			ev: 'verdict',
			uploadId: upload.uploadId
		});
	});

	it('advertises commit-batch and subscribe-identity on the session upgrade', async () => {
		const token = await initialise();
		const response = await fetchPath('/commit', {
			headers: {
				authorization: `Bearer ${token}`,
				upgrade: 'websocket'
			}
		});
		response.webSocket?.accept();
		response.webSocket?.close();

		expect({
			status: response.status,
			capabilities: response.headers.get(commitCapabilitiesHeader)
		}).toStrictEqual({
			status: StatusCodes.SWITCHING_PROTOCOLS,
			capabilities: commitCapabilitiesValue
		});
	});

	it.each([
		{
			name: 'a missing credential',
			authorization: undefined,
			status: StatusCodes.UNAUTHORIZED,
			challenge: 'Bearer realm="cupboard"'
		},
		{
			name: 'an invalid access token',
			authorization: 'Bearer invalid',
			status: StatusCodes.UNAUTHORIZED,
			challenge: 'Bearer realm="cupboard", error="invalid_token"'
		},
		{
			name: 'an insufficiently scoped token',
			authorization: 'under-scoped',
			status: StatusCodes.FORBIDDEN,
			challenge: 'Bearer realm="cupboard", error="insufficient_scope"'
		}
	])(
		'refuses $name on the raw commit route without caching it',
		async ({ authorization, status, challenge }) => {
			await initialise();
			const underScopedToken = await issueServerSignedToken([
				{ type: 'cupboard_domain', actions: ['cache:list'] }
			]);
			const resolvedAuthorization =
				authorization === 'under-scoped'
					? `Bearer ${underScopedToken}`
					: authorization;
			const response = await fetchPath('/commit', {
				headers: {
					upgrade: 'websocket',
					...(resolvedAuthorization !== undefined && {
						authorization: resolvedAuthorization
					})
				}
			});

			expect({
				status: response.status,
				challenge: response.headers.get('www-authenticate'),
				cacheControl: response.headers.get('cache-control')
			}).toStrictEqual({ status, challenge, cacheControl: 'no-store' });
		}
	);

	it('advertises both capabilities through the worker hop', async () => {
		const token = await initialiseViaWorker();
		const response = await handlerFetch(`/t/${fixtureTenant}/commit`, {
			headers: {
				authorization: `Bearer ${token}`,
				upgrade: 'websocket'
			}
		});
		response.webSocket?.accept();
		response.webSocket?.close();

		expect({
			status: response.status,
			capabilities: response.headers.get(commitCapabilitiesHeader)
		}).toStrictEqual({
			status: StatusCodes.SWITCHING_PROTOCOLS,
			capabilities: commitCapabilitiesValue
		});
	});

	it('returns one frame for every entry in a batched commit', async () => {
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
		const [a, b] = [metaA, metaB].map((metadata) =>
			expectSingleUploadDecision(
				{
					uploads: negotiated.uploads.filter(
						(decision) => decision.storePathHash === metadata.storePathHash
					)
				},
				metadata
			)
		);

		if (a === undefined || b === undefined) {
			throw new Error('both uploads must negotiate');
		}

		await putNarBytes(a.r2Key);
		await putNarBytes(b.r2Key);

		const session = await openCommitSession(token);
		session.send({
			op: 'commit-batch',
			commits: [
				{
					uploadId: a.uploadId,
					storePathHash: metaA.storePathHash,
					narHash: metaA.narHash
				},
				{
					uploadId: b.uploadId,
					storePathHash: metaB.storePathHash,
					narHash: metaB.narHash
				}
			]
		});
		const frames = [await session.nextFrame(), await session.nextFrame()];
		session.socket.close();

		expect(
			frames.map((frame) => frameIdentity(frame)).toSorted(byUploadId)
		).toStrictEqual(
			[
				{ ev: 'deferred', uploadId: a.uploadId },
				{ ev: 'deferred', uploadId: b.uploadId }
			].toSorted(byUploadId)
		);
	});

	it('commits both batch entries durably when the client closes mid-batch', async () => {
		const token = await initialise();
		const { metadata: metaA, nar: narA } = await verifiablePath(
			'dead-socket-a',
			{
				storePathHash: 'a'.repeat(32),
				name: 'a'
			}
		);
		const { metadata: metaB, nar: narB } = await verifiablePath(
			'dead-socket-b',
			{
				storePathHash: 'b'.repeat(32),
				name: 'b'
			}
		);
		const negotiated = await negotiateUploads(token, [metaA, metaB]);
		const [a, b] = [metaA, metaB].map((metadata) =>
			expectSingleUploadDecision(
				{
					uploads: negotiated.uploads.filter(
						(decision) => decision.storePathHash === metadata.storePathHash
					)
				},
				metadata
			)
		);

		if (a === undefined || b === undefined) {
			throw new Error('both uploads must negotiate');
		}

		await putNarBytes(a.r2Key, narA);
		await putNarBytes(b.r2Key, narB);

		// Close the server-side socket before handling the batch. Awaiting the
		// handler then proves durability without depending on frame timing.
		await openCommitSession(token);

		const batchMessage = JSON.stringify({
			op: 'commit-batch',
			commits: [
				{
					uploadId: a.uploadId,
					storePathHash: metaA.storePathHash,
					narHash: metaA.narHash
				},
				{
					uploadId: b.uploadId,
					storePathHash: metaB.storePathHash,
					narHash: metaB.narHash
				}
			]
		});

		await runInDurableObject(currentServer(), async (instance, state) => {
			const [serverSocket] = state.getWebSockets();

			if (serverSocket === undefined) {
				throw new Error('the session left no server-side socket');
			}

			serverSocket.close();
			await instance.webSocketMessage(serverSocket, batchMessage);
		});

		await verifyCurrentTenant();

		expect({
			a: await pendingUploadVerdict(a.uploadId),
			b: await pendingUploadVerdict(b.uploadId)
		}).toStrictEqual({ a: undefined, b: undefined });
	});

	it('commits entries from two back-to-back batch messages', async () => {
		const token = await initialise();
		const metaA = uploadMetadata({
			storePathHash: 'n'.repeat(32),
			name: 'batch-bound-a',
			narHash: nixSha256Hash('n'),
			fileSize: narBytes.byteLength
		});
		const metaB = uploadMetadata({
			storePathHash: 'p'.repeat(32),
			name: 'batch-bound-b',
			narHash: nixSha256Hash('p'),
			fileSize: narBytes.byteLength
		});
		const negotiated = await negotiateUploads(token, [metaA, metaB]);
		const [a, b] = [metaA, metaB].map((metadata) =>
			expectSingleUploadDecision(
				{
					uploads: negotiated.uploads.filter(
						(decision) => decision.storePathHash === metadata.storePathHash
					)
				},
				metadata
			)
		);

		if (a === undefined || b === undefined) {
			throw new Error('both uploads must negotiate');
		}

		await putNarBytes(a.r2Key);
		await putNarBytes(b.r2Key);

		// The per-Durable-Object semaphore must queue the second message without
		// dropping its entries.
		const session = await openCommitSession(token);
		session.send({
			op: 'commit-batch',
			commits: [
				{
					uploadId: a.uploadId,
					storePathHash: metaA.storePathHash,
					narHash: metaA.narHash
				}
			]
		});
		session.send({
			op: 'commit-batch',
			commits: [
				{
					uploadId: b.uploadId,
					storePathHash: metaB.storePathHash,
					narHash: metaB.narHash
				}
			]
		});

		const frames = [await session.nextFrame(), await session.nextFrame()];
		session.socket.close();

		expect(
			frames.map((frame) => frameIdentity(frame)).toSorted(byUploadId)
		).toStrictEqual(
			[
				{ ev: 'deferred', uploadId: a.uploadId },
				{ ev: 'deferred', uploadId: b.uploadId }
			].toSorted(byUploadId)
		);
	});

	it('commits a burst of per-ID operations within the shared entry bound', async () => {
		const token = await initialise();
		const alphabet = '0123456789abcdfghijklmnpqrsvwxyz';
		const metadatas = Array.from({ length: 10 }, (_, index) =>
			uploadMetadata({
				storePathHash: alphabet.charAt(index).repeat(32),
				name: `per-id-${String(index)}`,
				narHash: nixSha256Hash(alphabet.charAt(index)),
				fileSize: narBytes.byteLength
			})
		);
		const negotiated = await negotiateUploads(token, metadatas);
		const uploads = metadatas.map((metadata) =>
			expectSingleUploadDecision(
				{
					uploads: negotiated.uploads.filter(
						(decision) => decision.storePathHash === metadata.storePathHash
					)
				},
				metadata
			)
		);

		for (const upload of uploads) {
			await putNarBytes(upload.r2Key);
		}

		// A client without batching can send many per-ID operations. The shared
		// entry bound must queue excess work without dropping a response.
		const session = await openCommitSession(token);

		for (const upload of uploads) {
			session.send({ op: 'commit', uploadId: upload.uploadId });
		}

		const frames = [];

		for (const _upload of uploads) {
			frames.push(await session.nextFrame());
		}

		session.socket.close();

		expect(
			frames.map((frame) => frameIdentity(frame)).toSorted(byUploadId)
		).toStrictEqual(
			uploads
				.map((upload) => ({ ev: 'deferred', uploadId: upload.uploadId }))
				.toSorted(byUploadId)
		);
	});

	it('returns unsupported for an unknown operation and keeps the session open', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(upload.r2Key);
		const committed = await commitUpload(token, upload.uploadId);
		expect(committed.status).toBe('committed');

		const session = await openCommitSession(token);
		session.socket.send(JSON.stringify({ op: 'compress-all', level: 19 }));
		const reply = await session.nextFrame();

		session.send({ op: 'subscribe', uploadIds: [upload.uploadId] });
		const replay = await session.nextFrame();
		session.socket.close();

		expect({ reply, replayed: frameIdentity(replay) }).toStrictEqual({
			reply: { ev: 'unsupported', op: 'compress-all' },
			replayed: { ev: 'verdict', uploadId: upload.uploadId }
		});
	});

	it('resolves a re-sent batched entry whose row cleared as already-present', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(upload.r2Key);

		// Clear the pending row before replay to reproduce a lost settled frame.
		const committed = await commitUpload(token, upload.uploadId);
		expect(committed.status).toBe('committed');

		const session = await openCommitSession(token);
		session.send({
			op: 'commit-batch',
			commits: [
				{
					uploadId: upload.uploadId,
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash
				}
			]
		});
		const frame = await session.nextFrame();
		session.socket.close();

		expect(frame).toStrictEqual({
			ev: 'settled',
			uploadId: upload.uploadId,
			response: {
				storePathHash: metadata.storePathHash,
				narHash: metadata.narHash,
				status: 'already-present'
			}
		});
	});

	it('does not resolve a replay from a stale servability proof', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(upload.r2Key);
		await commitUpload(token, upload.uploadId);

		const committedNarInfoRow = await runInDurableObject(
			currentServer(),
			(instance) =>
				new NarInfoObjectsService(instance.context).committedNarInfoRow(
					resolvedCache(instance.context),
					metadata.storePathHash
				)
		);

		if (committedNarInfoRow === undefined) {
			throw new Error('expected a committed narinfo row');
		}

		const spy = vi
			.spyOn(NarInfoObjectsService.prototype, 'committedNarInfoRow')
			.mockResolvedValue({
				...committedNarInfoRow,
				generation: narInfoGenerationSchema.parse(
					committedNarInfoRow.generation + 1
				)
			});

		const session = await openCommitSession(token);
		session.send({
			op: 'commit-batch',
			commits: [
				{
					uploadId: upload.uploadId,
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash
				}
			]
		});
		const frame = await session.nextFrame();
		session.socket.close();
		spy.mockRestore();

		expect(frame).toStrictEqual({
			ev: 'verdict',
			uploadId: upload.uploadId,
			status: 'absent'
		});
	});

	it('returns absent for a replay whose committed NAR is missing', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(upload.r2Key);
		await commitUpload(token, upload.uploadId);
		await env.BLOBS.delete(await currentNarObjectKey(metadata.narHash));

		const session = await openCommitSession(token);
		session.send({
			op: 'commit-batch',
			commits: [
				{
					uploadId: upload.uploadId,
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash
				}
			]
		});
		const frame = await session.nextFrame();
		session.socket.close();

		expect(frame).toStrictEqual({
			ev: 'verdict',
			uploadId: upload.uploadId,
			status: 'absent'
		});
	});

	it('repairs a lost narinfo object before settling a re-sent entry', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(upload.r2Key);
		await commitUpload(token, upload.uploadId);
		const objectKey = narInfoObjectKey(fixtureTenant, metadata.storePathHash, {
			kind: 'default'
		});
		await env.BLOBS.delete(objectKey);

		const session = await openCommitSession(token);
		session.send({
			op: 'commit-batch',
			commits: [
				{
					uploadId: upload.uploadId,
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash
				}
			]
		});
		const frame = await session.nextFrame();
		session.socket.close();

		expect({
			frame,
			repaired: (await env.BLOBS.head(objectKey)) !== null
		}).toStrictEqual({
			frame: {
				ev: 'settled',
				uploadId: upload.uploadId,
				response: {
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash,
					status: 'already-present'
				}
			},
			repaired: true
		});
	});

	it('returns absent for a batched entry whose row and path are both missing', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({
			storePathHash: 'f'.repeat(32),
			name: 'gone',
			narHash: nixSha256Hash('g'),
			fileSize: narBytes.byteLength
		});

		const session = await openCommitSession(token);
		session.send({
			op: 'commit-batch',
			commits: [
				{
					uploadId: 'never-existed',
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash
				}
			]
		});
		const frame = await session.nextFrame();
		session.socket.close();

		expect(frame).toStrictEqual({
			ev: 'verdict',
			uploadId: 'never-existed',
			status: 'absent'
		});
	});

	it('returns absent for a repeated commit when the pending row is gone and only a reservation remains', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({
			storePathHash: 'c'.repeat(32),
			name: 'reserved-only',
			narHash: nixSha256Hash('c'),
			fileSize: narBytes.byteLength
		});

		// Reserve the narinfo row without a D1 reference edge.
		await seedReservedNarInfo(metadata);

		const session = await openCommitSession(token);
		session.send({
			op: 'commit-batch',
			commits: [
				{
					uploadId: 'reservation-only-upload',
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash
				}
			]
		});
		const frame = await session.nextFrame();
		session.socket.close();

		// A matching narinfo row without a current reference edge is not a
		// committed upload.
		expect(frame).toStrictEqual({
			ev: 'verdict',
			uploadId: 'reservation-only-upload',
			status: 'absent'
		});
	});

	it('subscribe-identity returns already-present for a committed path with no pending row', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(upload.r2Key);

		const committed = await commitUpload(token, upload.uploadId);
		expect(committed.status).toBe('committed');

		const session = await openCommitSession(token);
		session.send({
			op: 'subscribe-identity',
			entries: [
				{
					uploadId: upload.uploadId,
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash
				}
			]
		});
		const frame = await session.nextFrame();
		session.socket.close();

		expect(frame).toStrictEqual({
			ev: 'settled',
			uploadId: upload.uploadId,
			response: {
				storePathHash: metadata.storePathHash,
				narHash: metadata.narHash,
				status: 'already-present'
			}
		});
	});

	it('subscribe-identity returns absent for an uncommitted reservation with no pending row', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({
			storePathHash: 'd'.repeat(32),
			name: 'sub-identity-reserved',
			narHash: nixSha256Hash('d'),
			fileSize: narBytes.byteLength
		});

		await seedReservedNarInfo(metadata);

		const session = await openCommitSession(token);
		session.send({
			op: 'subscribe-identity',
			entries: [
				{
					uploadId: 'sub-identity-gone-upload',
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash
				}
			]
		});
		const frame = await session.nextFrame();
		session.socket.close();

		expect(frame).toStrictEqual({
			ev: 'verdict',
			uploadId: 'sub-identity-gone-upload',
			status: 'absent'
		});
	});

	it('subscribe-identity replays a pending entry and sends its verdict to the new socket', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(upload.r2Key);

		const first = await openCommitSession(token);
		first.send({ op: 'commit', uploadId: upload.uploadId });
		const deferred = await first.nextFrame();
		expect(deferred.ev).toBe('deferred');
		first.socket.close();

		const second = await openCommitSession(token);
		second.send({
			op: 'subscribe-identity',
			entries: [
				{
					uploadId: upload.uploadId,
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash
				}
			]
		});
		const replay = await second.nextFrame();
		expect(frameIdentity(replay)).toStrictEqual({
			ev: 'deferred',
			uploadId: upload.uploadId
		});

		await verifyCurrentTenant();
		const verdict = await second.nextFrame();
		second.socket.close();

		if (verdict.ev !== 'verdict') {
			throw new Error(`expected a verdict frame, got ${verdict.ev}`);
		}

		expect(verdict.status).toBe('servable');
	});

	it('does not strand a reserved row when an in-flight commit is retried', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(upload.r2Key);

		// Reproduce a crash after reservation and before publication.
		await seedReservedNarInfo(metadata);
		await markUploadCommitting(upload.uploadId);

		// Retry must preserve the staged bytes and defer; the reservation alone is
		// not proof that the path is already present.
		const retry = await commitUpload(token, upload.uploadId, defaultCache(), {
			wait: false
		});

		expect(retry.status).toBe('pending');
		await expect(env.BLOBS.head(upload.r2Key)).resolves.not.toBeNull();
		await expect(
			env.BLOBS.head(
				narInfoObjectKey(fixtureTenant, metadata.storePathHash, {
					kind: 'default'
				})
			)
		).resolves.toBeNull();

		await verifyCurrentTenant();

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

		// Reproduce a reuse commit that crashed before requesting verification.
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

		const commit = await commitUpload(token, upload.uploadId, defaultCache(), {
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

		// Deferrals before a pass starts share one outstanding verification request.
		await commitUpload(token, upload.uploadId, defaultCache(), { wait: false });
		await commitUpload(token, upload.uploadId, defaultCache(), { wait: false });
		expect(sent).toStrictEqual([
			{ kind: 'tenant-verify', tenant: fixtureTenant }
		]);

		// A pass starts (the queue consumer claims the rows), re-arming the guard.
		await currentServer().claimVerificationBatch(10, Number.MAX_SAFE_INTEGER);

		// Once a pass has claimed its snapshot, a later deferral needs another
		// request.
		await commitUpload(token, upload.uploadId, defaultCache(), { wait: false });
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

		// Seed a live competing upload that reserved the path without committing a
		// reference edge. A distinct racer must enter verification; an orphaned
		// reservation would instead be reclaimed immediately.
		await seedReservedNarInfo(metadata);
		await runInDurableObject(currentServer(), (instance) => {
			const cacheId = resolvedCache(instance.context).id;

			instance.context.db
				.insert(schema.pendingUploads)
				.values({
					id: uploadIdSchema.parse('rival-upload'),
					cacheId,
					narHash: metadata.narHash,
					r2Key: r2ObjectKeySchema.parse('staging/rival-upload'),
					metadataJson: '{}',
					createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
					expiresAt: isoTimestampSchema.parse('2099-01-01T00:00:00.000Z')
				})
				.run();
		});

		const committed = await commitUpload(
			token,
			loser.uploadId,
			defaultCache(),
			{
				wait: false
			}
		);

		expect({
			status: committed.status,
			verdict: await pendingUploadVerdict(loser.uploadId),
			staged: (await env.BLOBS.head(loser.r2Key)) !== null
		}).toStrictEqual({ status: 'pending', verdict: 'pending', staged: true });

		await verifyCurrentTenant();

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

		// Negotiate the dishonest path before a shared blob exists so it must upload
		// and verify its own staged bytes.
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

		// Commit an honest path with the same declared NAR hash before verifying the
		// dishonest upload.
		const honest = uploadMetadata({
			name: 'honest',
			storePathHash: 'b'.repeat(32),
			narHash: good.narHash,
			fileHash: good.fileHash,
			fileSize: good.narBytes.byteLength,
			narSize: good.narSize
		});
		await commitPath(token, honest, good);

		// An existing canonical blob must not let fresh staged bytes bypass
		// verification.
		await markUploadPendingVerification(liarUpload.uploadId);
		await verifyCurrentTenant();

		expect(await pendingUploadVerdict(liarUpload.uploadId)).toBe('mismatch');
		await expect(
			env.BLOBS.head(
				narInfoObjectKey(fixtureTenant, liar.storePathHash, { kind: 'default' })
			)
		).resolves.toBeNull();

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
			env.BLOBS.head(
				narInfoObjectKey(fixtureTenant, reserved.storePathHash, {
					kind: 'default'
				})
			)
		).resolves.toBeNull();

		await env.BLOBS.put(
			narInfoObjectKey(fixtureTenant, reserved.storePathHash, {
				kind: 'default'
			}),
			'accidental'
		);
		await verifyCurrentTenant();

		expect(await pendingUploadVerdict(reservedUpload.uploadId)).toBe(
			'mismatch'
		);
		await expect(
			env.BLOBS.head(
				narInfoObjectKey(fixtureTenant, reserved.storePathHash, {
					kind: 'default'
				})
			)
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

		// A transient staging read failure must leave the upload pending and retain
		// its bytes for retry.
		const getSpy = vi
			.spyOn(env.BLOBS, 'get')
			.mockRejectedValueOnce(new Error('transient R2 read'));

		await verifyCurrentTenant();
		getSpy.mockRestore();

		expect(await pendingUploadVerdict(upload.uploadId)).toBe('pending');
		await expect(env.BLOBS.head(upload.r2Key)).resolves.not.toBeNull();

		await verifyCurrentTenant();

		expect(await pendingUploadVerdict(upload.uploadId)).toBeUndefined();
		const narInfo = await fetchNarInfo(metadata.storePathHash);
		expect(narInfo.narHash.toString()).toBe(metadata.narHash);
	});

	it('chains a verify pass that fills its batch and drains the rest, stopping on a short batch', async () => {
		const token = await initialise();

		// Three deferred uploads require two passes when the claim limit is two.
		const uploadIds: UploadId[] = [];
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

		// Collect continuation requests sent through the Durable Object's queue.
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

		const servableCount = async (): Promise<number> => {
			const verdicts = await Promise.all(
				uploadIds.map((uploadId) => pendingUploadVerdict(uploadId))
			);

			return verdicts.filter((verdict) => verdict === undefined).length;
		};

		await verifyTenant(rootLogger(), env, tenant, 2);
		expect({
			sent: sent.length,
			servable: await servableCount()
		}).toStrictEqual({ sent: 1, servable: 2 });

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

		await verifyCurrentTenant();

		// Verification clears the pending row after publishing the verdict.
		expect(await pendingUploadVerdict(upload.uploadId)).toBeUndefined();
		await expect(
			env.BLOBS.head(
				narInfoObjectKey(fixtureTenant, metadata.storePathHash, {
					kind: 'default'
				})
			)
		).resolves.not.toBeNull();

		await deletePath(token, metadata.storePathHash);
		await verifyCurrentTenant();

		await expect(
			env.BLOBS.head(
				narInfoObjectKey(fixtureTenant, metadata.storePathHash, {
					kind: 'default'
				})
			)
		).resolves.toBeNull();
	});

	it('records a durable mismatch for an undecodable deferred blob, not a retried pending upload', async () => {
		const token = await initialise();
		// The compressed hash matches, but decompression fails. This is a terminal
		// mismatch rather than a transient pending verdict.
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

		await verifyCurrentTenant();

		expect(await pendingUploadVerdict(upload.uploadId)).toBe('mismatch');
		await expect(env.BLOBS.head(upload.r2Key)).resolves.toBeNull();
		await expect(
			env.BLOBS.head(
				narInfoObjectKey(fixtureTenant, metadata.storePathHash, {
					kind: 'default'
				})
			)
		).resolves.toBeNull();
	});

	it('leaves no orphaned canonical blob after one of two competing NAR hashes loses', async () => {
		const token = await initialise();
		const narX = await verifiableNar('race-x');
		const narY = await verifiableNar('race-y');
		const storePathHash = storePathHashSchema.parse('a'.repeat(32));

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

		// Whichever upload verifies first wins the narinfo row. The losing NAR hash
		// must have no canonical object left after both verdicts are applied.
		await verifyCurrentTenant();

		const served = await fetchNarInfo(storePathHash);
		const winner = served.narHash.toString() === narX.narHash ? narX : narY;
		const loser = winner === narX ? narY : narX;
		const winnerKey = await currentNarObjectKey(winner.narHash);
		const loserKey = narObjectKey(loser.narHash, 2);

		await currentServer().runGarbageCollection();

		await expect(env.BLOBS.head(loserKey)).resolves.toBeNull();
		await expect(env.BLOBS.head(winnerKey)).resolves.not.toBeNull();
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

		// A definitively missing staging object is terminal; leaving it pending
		// would retry the same absent object on every pass.
		await env.BLOBS.delete(upload.r2Key);
		await verifyCurrentTenant();

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

		// A terminal verdict starts a new observation window after the upload TTL.
		vi.setSystemTime(new Date('2026-01-01T00:16:00.000Z'));
		await verifyCurrentTenant();

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
			env.BLOBS.head(
				narInfoObjectKey(fixtureTenant, metadata.storePathHash, {
					kind: 'default'
				})
			)
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

		const commit = await commitUpload(token, upload.uploadId, defaultCache(), {
			wait: false
		});

		expect({ status: commit.status, sent }).toStrictEqual({
			status: 'pending',
			sent: [{ kind: 'tenant-verify', tenant: fixtureTenant }]
		});
		await expect(
			env.BLOBS.head(
				narInfoObjectKey(fixtureTenant, metadata.storePathHash, {
					kind: 'default'
				})
			)
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

		// Both private staging objects must be deleted before their upload rows are
		// cleared; GC cannot discover a staging key after that point.
		await expect(env.BLOBS.head(first.r2Key)).resolves.toBeNull();
		await expect(env.BLOBS.head(second.r2Key)).resolves.toBeNull();
		await expect(
			env.BLOBS.head(await currentNarObjectKey(metadata.narHash))
		).resolves.not.toBeNull();
	});

	it('finalises and reclaims staging when the canonical blob was already promoted', async () => {
		// Reproduce a crash after promotion and before commit. Retry must adopt the
		// canonical object and clean up staging without copying it again.
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);

		await putNarBytes(upload.r2Key);
		await putNarBytes(narObjectKey(metadata.narHash, 2));

		const commit = await commitUpload(token, upload.uploadId);

		expect(commit.status).toBe('committed');

		await expect(env.BLOBS.head(upload.r2Key)).resolves.toBeNull();
		await expect(
			env.BLOBS.head(await currentNarObjectKey(metadata.narHash))
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
			cacheControl: 'public, max-age=3600, must-revalidate',
			fields: {
				storePath: metadata.storePath,
				url: narObjectKey(metadata.narHash, 2),
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
			signatureVerified: await isNarInfoSignatureValid(parsed, init.publicKey)
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
			signatureVerified: await isNarInfoSignatureValid(narInfo, init.publicKey)
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

		// Remove only the narinfo object; keep the canonical NAR available for
		// repair.
		await env.BLOBS.delete(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash, {
				kind: 'default'
			})
		);
		await expect(
			env.BLOBS.head(
				narInfoObjectKey(fixtureTenant, metadata.storePathHash, {
					kind: 'default'
				})
			)
		).resolves.toBeNull();

		// Negotiation queues reconciliation but does not repair the object on the
		// request path.
		const skip = await negotiateUploads(token, [metadata]);

		expect(skip.uploads).toStrictEqual([
			{
				action: 'skip',
				storePathHash: metadata.storePathHash,
				narHash: metadata.narHash
			}
		]);

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

		await env.BLOBS.delete(await currentNarObjectKey(metadata.narHash));

		// Leave `blob_state` present so negotiation queues reconciliation. The
		// missing canonical object then makes reconciliation retire the narinfo.
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
			env.BLOBS.head(
				narInfoObjectKey(fixtureTenant, metadata.storePathHash, {
					kind: 'default'
				})
			)
		).resolves.toBeNull();

		expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
	});

	it('removes the narinfo when reconcile finds its NAR missing', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await commitPath(token, metadata);

		await env.BLOBS.delete(await currentNarObjectKey(metadata.narHash));
		await negotiateUploads(token, [metadata]);
		await fireReconcile();

		await expect(
			env.BLOBS.head(
				narInfoObjectKey(fixtureTenant, metadata.storePathHash, {
					kind: 'default'
				})
			)
		).resolves.toBeNull();
		const missingNarInfo = await readFetch(
			`/${metadata.storePathHash}.narinfo`
		);
		expect(missingNarInfo.status).toBe(StatusCodes.NOT_FOUND);
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

		// Remove the physical object shared by two committed paths.
		await env.BLOBS.delete(await currentNarObjectKey(first.narHash));

		// Reconciliation retires both reference edges but credits the shared blob
		// only once.
		await negotiateUploads(token, [first, second]);
		await fireReconcile();

		await expectStats(token, {
			storePaths: 0,
			narBlobs: 0,
			pendingUploads: 0,
			totalFileSize: 0
		});

		expectSingleUploadDecision(await negotiateUploads(token, [third]), third);
	});

	it('removes a collected narinfo during GC', async () => {
		const token = await initialise();
		const kept = uploadMetadata({
			fileSize: narBytes.byteLength,
			name: 'kept'
		});
		const collected = await commitVerifiablePath(token, 'collected', {
			name: 'collected',
			storePathHash: '22222222222222222222222222222222'
		});

		await commitPath(token, kept);
		await setRoot(token, { name: 'main', targets: [kept.storePath] });

		expect(await runGcResult()).toStrictEqual({
			ok: true,
			pendingUploadsDeleted: 0,
			pendingAttestationsDeleted: 0,
			rootsExpired: 0,
			pathsCollected: 1,
			narInfosDeleted: 1,
			orphanStagingDeleted: 0
		});

		await expect(
			env.BLOBS.head(
				narInfoObjectKey(fixtureTenant, collected.storePathHash, {
					kind: 'default'
				})
			)
		).resolves.toBeNull();
	});

	it('removes a collected narinfo when GC runs from cron', async () => {
		const token = await initialise();
		const kept = uploadMetadata({
			fileSize: narBytes.byteLength,
			name: 'kept'
		});
		const collected = await commitVerifiablePath(token, 'collected', {
			name: 'collected',
			storePathHash: '22222222222222222222222222222222'
		});

		await commitPath(token, kept);
		await setRoot(token, { name: 'main', targets: [kept.storePath] });

		await runGcFromInternalOrigin();

		await expect(
			env.BLOBS.head(
				narInfoObjectKey(fixtureTenant, collected.storePathHash, {
					kind: 'default'
				})
			)
		).resolves.toBeNull();
	});

	it('spares an in-flight reserved narinfo row from collection', async () => {
		const token = await initialise();
		const kept = await commitVerifiablePath(token, 'kept', { name: 'kept' });

		await setRoot(token, { name: 'main', targets: [kept.storePath] });

		// The reserved narinfo row is not yet reachable from a root. Its active
		// upload must protect it from collection.
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

		await verifyCurrentTenant();
		const narInfo = await fetchNarInfo(reserved.storePathHash);

		expect({ result, narHash: narInfo.narHash.toString() }).toStrictEqual({
			result: {
				ok: true,
				pendingUploadsDeleted: 0,
				pendingAttestationsDeleted: 0,
				rootsExpired: 0,
				pathsCollected: 0,
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

		const response = await authorisedFetch('/uploads', token, {
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
		await putNarBytes(upload.r2Key);

		await expect(env.BLOBS.head(upload.r2Key)).resolves.not.toBeNull();

		await expectStats(token, {
			storePaths: 0,
			narBlobs: 0,
			pendingUploads: 1,
			totalFileSize: 0
		});

		vi.setSystemTime(new Date('2026-01-01T00:16:00.000Z'));

		// Reaping the pending row must delete its private staging object directly;
		// the global blob reaper has no `blob_state` row for it.
		expect(await runGcResult()).toStrictEqual({
			ok: true,
			pendingUploadsDeleted: 1,
			pendingAttestationsDeleted: 0,
			rootsExpired: 0,
			pathsCollected: 0,
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
		await env.BLOBS.delete(await currentNarObjectKey(metadata.narHash));

		// Leave `blob_state` present so negotiation queues reconciliation before the
		// missing canonical object retires the narinfo.
		await negotiateUploads(token, [metadata]);
		await fireReconcile();

		// Tenant usage is credited when its edge is retired, before the global
		// `blob_state` row is reaped.
		await expectStats(token, {
			storePaths: 0,
			narBlobs: 0,
			pendingUploads: 0,
			totalFileSize: 0
		});

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
			pathsCollected: 0,
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

		// Remove the published narinfo object but keep its committed row and NAR.
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
			narInfoObjectKey(fixtureTenant, committed.storePathHash, {
				kind: 'default'
			})
		);

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
			narInfoObjectKey(fixtureTenant, committed.storePathHash, {
				kind: 'default'
			})
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
		const objectKey = await currentNarObjectKey(metadata.narHash);

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
		// Path deletion retires tenant ownership immediately. The unreferenced
		// shared blob remains until the reaper's grace period expires.
		await expectStats(token, {
			storePaths: 0,
			narBlobs: 0,
			pendingUploads: 0,
			totalFileSize: 0
		});

		await runBlobReaper(rootLogger(), env);
		await expect(env.BLOBS.head(objectKey)).resolves.not.toBeNull();

		vi.setSystemTime(afterGrace());
		await runBlobReaper(rootLogger(), env);
		await expect(env.BLOBS.head(objectKey)).resolves.toBeNull();
	});

	it('refuses the NAR of a deleted path even when its cleanup fails', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await commitPath(token, metadata);
		const narPath = `/${await currentNarObjectKey(metadata.narHash)}`;
		const beforeDelete = await readFetch(narPath);

		// The narinfo object survives the failed cleanup and the queue entry stays
		// for garbage collection, but the reference edge is already retired.
		const failingDelete = vi
			.spyOn(env.BLOBS, 'delete')
			.mockImplementation(() => Promise.reject(new Error('R2 unavailable')));
		let deleted: DeletePathResponseInput;

		try {
			deleted = await deletePath(token, metadata.storePathHash);
		} finally {
			failingDelete.mockRestore();
		}

		const afterDelete = await readFetch(narPath);

		expect({
			beforeDelete: beforeDelete.status,
			deleted,
			afterDelete: afterDelete.status
		}).toStrictEqual({
			beforeDelete: StatusCodes.OK,
			deleted: {
				storePathHash: metadata.storePathHash,
				deleted: true,
				narScheduledForDeletion: false
			},
			afterDelete: StatusCodes.NOT_FOUND
		});
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
		const objectKey = await currentNarObjectKey(second.narHash);

		const deletedFirst = await deletePath(token, first.storePathHash);

		expect(deletedFirst.narScheduledForDeletion).toBe(false);

		const secondServed = await readFetch(`/${second.storePathHash}.narinfo`);

		expect(secondServed.status).toBe(StatusCodes.OK);
		await expect(
			env.BLOBS.head(await currentNarObjectKey(first.narHash))
		).resolves.not.toBeNull();

		const deletedSecond = await deletePath(token, second.storePathHash);

		expect(deletedSecond.narScheduledForDeletion).toBe(true);

		await runBlobReaper(rootLogger(), env);
		vi.setSystemTime(afterGrace());
		await runBlobReaper(rootLogger(), env);
		await expect(env.BLOBS.head(objectKey)).resolves.toBeNull();
	});

	it('purges a cached NAR when its last public reference is retired', async () => {
		const token = await initialise();
		const first = uploadMetadata({ fileSize: narBytes.byteLength });
		const second = uploadMetadata({
			fileSize: narBytes.byteLength,
			name: 'second',
			storePathHash: '22222222222222222222222222222222'
		});
		await commitPath(token, first);
		await commitSharedPath(token, second);
		const purge = await runInDurableObject(currentServer(), (instance) =>
			vi.spyOn(instance.context, 'purgeCacheTags').mockResolvedValue(undefined)
		);
		// Each pass purges one queued batch. Run more passes than the deletions
		// queue so the queue is empty whatever order the batches were written in.
		const drainQueuedPurges = async (): Promise<string[]> => {
			for (let pass = 0; pass < 4; pass += 1) {
				await runInDurableObject(currentServer(), (instance) =>
					instance.alarm()
				);
			}

			const tags = purge.mock.calls
				.flatMap(([batch]) => [...batch])
				.toSorted(byCodeUnit);
			purge.mockClear();

			return tags;
		};

		try {
			await deletePath(token, first.storePathHash);
			const afterFirst = await drainQueuedPurges();

			await deletePath(token, second.storePathHash);
			const afterSecond = await drainQueuedPurges();

			expect({ afterFirst, afterSecond }).toStrictEqual({
				afterFirst: [
					narInfoCacheTag(fixtureTenant, defaultCache(), first.storePathHash)
				],
				afterSecond: [
					narCacheTag(fixtureTenant, defaultCache(), second.narHash),
					narInfoCacheTag(fixtureTenant, defaultCache(), second.storePathHash)
				].toSorted(byCodeUnit)
			});
		} finally {
			purge.mockRestore();
		}
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
		const objectKey = await currentNarObjectKey(metadata.narHash);
		await deletePath(token, metadata.storePathHash);

		await runBlobReaper(rootLogger(), env);

		vi.setSystemTime(new Date(testBase.getTime() + 16 * 60 * 1000));
		await runBlobReaper(rootLogger(), env);
		await expect(env.BLOBS.head(objectKey)).resolves.not.toBeNull();

		vi.setSystemTime(afterGrace());
		await runBlobReaper(rootLogger(), env);
		await expect(env.BLOBS.head(objectKey)).resolves.toBeNull();
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
		vi.setSystemTime(testBase);

		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await commitPath(token, metadata);
		const objectKey = await currentNarObjectKey(metadata.narHash);

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

		// Reproduce a crash after retiring the reference edge, which the deletion
		// does before it reports success, but before removing the published
		// narinfo object.
		await expectStats(token, {
			storePaths: 0,
			narBlobs: 0,
			narFileSize: 0,
			pendingUploads: 0,
			totalFileSize: 0
		});
		await expect(
			env.BLOBS.head(
				narInfoObjectKey(fixtureTenant, metadata.storePathHash, {
					kind: 'default'
				})
			)
		).resolves.not.toBeNull();
		await expect(env.BLOBS.head(objectKey)).resolves.not.toBeNull();

		const recovered = await runGcResult();

		// Replaying the deletion marker removes the object the failed pass left
		// behind.
		expect(recovered.narInfosDeleted).toBe(1);
		await expect(
			env.BLOBS.head(
				narInfoObjectKey(fixtureTenant, metadata.storePathHash, {
					kind: 'default'
				})
			)
		).resolves.toBeNull();
		await expect(env.BLOBS.head(objectKey)).resolves.not.toBeNull();

		await runBlobReaper(rootLogger(), env);
		vi.setSystemTime(afterGrace());
		await runBlobReaper(rootLogger(), env);
		await expect(env.BLOBS.head(objectKey)).resolves.toBeNull();
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

		// Recommit the path before deletion-marker replay reaches it. The deletion
		// retired the tenant's reference to the NAR, so the recommit uploads it
		// again.
		await commitPath(token, metadata);

		const served = await readFetch(`/${metadata.storePathHash}.narinfo`);

		expect(served.status).toBe(StatusCodes.OK);

		const collected = await runGcResult();

		// The generation check must discard the stale marker without deleting the
		// replacement object.
		const stillServed = await readFetch(`/${metadata.storePathHash}.narinfo`);

		expect({
			narInfosDeleted: collected.narInfosDeleted,
			narInfoStored:
				(await env.BLOBS.head(
					narInfoObjectKey(fixtureTenant, metadata.storePathHash, {
						kind: 'default'
					})
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

			// Root replacement is atomic: an unservable target must leave the existing
			// target set intact.
			const response = await authorisedFetch('/roots/main', token, {
				body: JSON.stringify({ targets: [committed.storePath, absentPath] }),
				headers: { 'content-type': 'application/json' },
				method: 'PUT'
			});
			const { roots } = await listRoots(token);

			expect({ status: response.status, roots }).toStrictEqual({
				status: StatusCodes.CONFLICT,
				roots: [
					{
						name: original.name,
						expired: original.expired,
						createdAt: original.createdAt,
						updatedAt: original.updatedAt,
						targetCount: original.targets.length
					}
				]
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

		it('ensures and renews an already servable target without rebuilding', async () => {
			vi.setSystemTime(testBase);

			const token = await initialise();
			const committed = uploadMetadata({ fileSize: narBytes.byteLength });
			await commitPath(token, committed);

			const response = await authorisedFetch('/roots/pr-1/ensure', token, {
				body: JSON.stringify({
					targets: [committed.storePath],
					ttlSeconds: 604_800
				}),
				headers: { 'content-type': 'application/json' },
				method: 'POST'
			});
			const body = await response.json();
			const expiresAt = new Date(testBase.getTime() + 604_800 * 1000);

			expect({ status: response.status, body }).toStrictEqual({
				status: StatusCodes.OK,
				body: {
					status: 'retained',
					root: {
						name: 'pr-1',
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
					}
				}
			});
		});

		it('reports a build requirement without replacing the existing root', async () => {
			const token = await initialise();
			const committed = uploadMetadata({ fileSize: narBytes.byteLength });
			await commitPath(token, committed);
			const original = await setRoot(token, {
				name: 'main',
				targets: [committed.storePath]
			});

			const response = await authorisedFetch('/roots/main/ensure', token, {
				body: JSON.stringify({ targets: [absentPath] }),
				headers: { 'content-type': 'application/json' },
				method: 'POST'
			});
			const body = await response.json();
			const { roots } = await listRoots(token);

			expect({ status: response.status, body, roots }).toStrictEqual({
				status: StatusCodes.OK,
				body: { status: 'build-required', unavailable: [absentPath] },
				roots: [
					{
						name: original.name,
						expired: original.expired,
						createdAt: original.createdAt,
						updatedAt: original.updatedAt,
						targetCount: original.targets.length
					}
				]
			});
		});

		// Path deletion removes the row before the narinfo object. Recheck the row
		// inside the root write gate so the surviving object cannot prove
		// servability.
		it('reports a build requirement for a target whose narinfo row is gone but whose object survives', async () => {
			const token = await initialise();
			const orphaned = uploadMetadata({ fileSize: narBytes.byteLength });
			await env.BLOBS.put(
				narInfoObjectKey(fixtureTenant, orphaned.storePathHash, {
					kind: 'default'
				}),
				'orphaned'
			);

			const response = await authorisedFetch('/roots/main/ensure', token, {
				body: JSON.stringify({ targets: [orphaned.storePath] }),
				headers: { 'content-type': 'application/json' },
				method: 'POST'
			});
			const body = await response.json();
			const { roots } = await listRoots(token);

			expect({ status: response.status, body, roots }).toStrictEqual({
				status: StatusCodes.OK,
				body: {
					status: 'build-required',
					unavailable: [orphaned.storePath]
				},
				roots: []
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
			const set = await fetchPath('/roots/main', {
				body: JSON.stringify({ targets: [target] }),
				headers: { 'content-type': 'application/json' },
				method: 'PUT'
			});
			const list = await fetchPath('/roots');
			const ensure = await fetchPath('/roots/main/ensure', {
				body: JSON.stringify({ targets: [target] }),
				headers: { 'content-type': 'application/json' },
				method: 'POST'
			});
			const remove = await fetchPath('/roots/main', {
				method: 'DELETE'
			});

			expect([
				set.status,
				ensure.status,
				list.status,
				remove.status
			]).toStrictEqual([
				StatusCodes.UNAUTHORIZED,
				StatusCodes.UNAUTHORIZED,
				StatusCodes.UNAUTHORIZED,
				StatusCodes.UNAUTHORIZED
			]);
		});

		// Setting an empty target list clears a root. Ensuring a root requires at
		// least one target because it reports which targets need a build.
		it.each([
			{
				name: 'a target that is not a store path',
				path: '/roots/main',
				method: 'PUT',
				body: { targets: ['not-a-store-path'] }
			},
			{
				name: 'an ensure over no targets',
				path: '/roots/main/ensure',
				method: 'POST',
				body: { targets: [] }
			}
		])('rejects $name', async ({ path, method, body }) => {
			const token = await initialise();
			const response = await authorisedFetch(path, token, {
				body: JSON.stringify(body),
				headers: { 'content-type': 'application/json' },
				method
			});

			expect(response.status).toBe(StatusCodes.BAD_REQUEST);
		});

		const hashA = storePathHashSchema.parse('11111111111111111111111111111111');
		const hashB = storePathHashSchema.parse('22222222222222222222222222222222');
		const hashC = storePathHashSchema.parse('33333333333333333333333333333333');

		it('collects unreachable paths and keeps the rooted closure', async () => {
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
				pathsCollected: 1,
				narInfosDeleted: 1,
				orphanStagingDeleted: 0
			});

			await expect(
				env.BLOBS.head(
					narInfoObjectKey(fixtureTenant, hashC, { kind: 'default' })
				)
			).resolves.toBeNull();
			await expect(
				env.BLOBS.head(
					narInfoObjectKey(fixtureTenant, hashA, { kind: 'default' })
				)
			).resolves.not.toBeNull();
			await expect(
				env.BLOBS.head(
					narInfoObjectKey(fixtureTenant, hashB, { kind: 'default' })
				)
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
				pathsCollected: 1,
				narInfosDeleted: 1,
				orphanStagingDeleted: 0
			});

			for (const hash of [hashA, hashB, hashC]) {
				await expect(
					env.BLOBS.head(
						narInfoObjectKey(fixtureTenant, hash, { kind: 'default' })
					)
				).resolves.not.toBeNull();
			}
			await expect(
				env.BLOBS.head(
					narInfoObjectKey(fixtureTenant, hashD, { kind: 'default' })
				)
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
				pathsCollected: 1,
				narInfosDeleted: 1,
				orphanStagingDeleted: 0
			});

			for (const hash of [hashA, hashB]) {
				await expect(
					env.BLOBS.head(
						narInfoObjectKey(fixtureTenant, hash, { kind: 'default' })
					)
				).resolves.not.toBeNull();
			}
			await expect(
				env.BLOBS.head(
					narInfoObjectKey(fixtureTenant, hashD, { kind: 'default' })
				)
			).resolves.toBeNull();
		});

		it('skips collection when no root is defined', async () => {
			const token = await initialise();
			const path = uploadMetadata({ fileSize: narBytes.byteLength });
			await commitPath(token, path);

			expect(await runGcResult()).toStrictEqual({
				ok: true,
				pendingUploadsDeleted: 0,
				pendingAttestationsDeleted: 0,
				rootsExpired: 0,
				pathsCollected: 0,
				narInfosDeleted: 0,
				orphanStagingDeleted: 0
			});
			await expect(
				env.BLOBS.head(
					narInfoObjectKey(fixtureTenant, path.storePathHash, {
						kind: 'default'
					})
				)
			).resolves.not.toBeNull();
		});

		it('skips collection when no root target remains committed', async () => {
			const token = await initialise();
			const committed = uploadMetadata({ fileSize: narBytes.byteLength });
			await commitPath(token, committed);

			// A target can be deleted after root activation. If no root target remains
			// committed, skip collection for the entire cache.
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
				pathsCollected: 0,
				narInfosDeleted: 0,
				orphanStagingDeleted: 0
			});
			await expect(
				env.BLOBS.head(
					narInfoObjectKey(fixtureTenant, committed.storePathHash, {
						kind: 'default'
					})
				)
			).resolves.not.toBeNull();
		});

		it('collects a path freed by an expired root while a live root remains', async () => {
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
				pathsCollected: 1,
				narInfosDeleted: 1,
				orphanStagingDeleted: 0
			});

			const { roots } = await listRoots(token);

			expect(roots.map((root) => root.name)).toStrictEqual(['keep']);
			await expect(
				env.BLOBS.head(
					narInfoObjectKey(fixtureTenant, hashB, { kind: 'default' })
				)
			).resolves.toBeNull();
			await expect(
				env.BLOBS.head(
					narInfoObjectKey(fixtureTenant, hashA, { kind: 'default' })
				)
			).resolves.not.toBeNull();
		});

		it('collects a path freed by the last expired root', async () => {
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
				pathsCollected: 1,
				narInfosDeleted: 1,
				orphanStagingDeleted: 0
			});

			const { roots } = await listRoots(token);

			expect(roots).toStrictEqual([]);
			await expect(
				env.BLOBS.head(
					narInfoObjectKey(fixtureTenant, b.storePathHash, { kind: 'default' })
				)
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
				pathsCollected: 1,
				narInfosDeleted: 1,
				orphanStagingDeleted: 0
			});

			await expect(
				env.BLOBS.head(
					narInfoObjectKey(fixtureTenant, hashC, { kind: 'default' })
				)
			).resolves.toBeNull();
			await expect(
				env.BLOBS.head(await currentNarObjectKey(narHash))
			).resolves.not.toBeNull();
			await expect(
				env.BLOBS.head(
					narInfoObjectKey(fixtureTenant, hashA, { kind: 'default' })
				)
			).resolves.not.toBeNull();
		});

		it('defers a collected path NAR until the grace elapses', async () => {
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
			const cObjectKey = await currentNarObjectKey(cNar.narHash);
			await setRoot(token, { name: 'main', targets: [a.storePath] });

			// Tenant GC retires the unreachable path's edge. The global reaper handles
			// the resulting unreferenced blob separately.
			expect(await runGcResult()).toStrictEqual({
				ok: true,
				pendingUploadsDeleted: 0,
				pendingAttestationsDeleted: 0,
				rootsExpired: 0,
				pathsCollected: 1,
				narInfosDeleted: 1,
				orphanStagingDeleted: 0
			});

			expect({
				deleted: await runBlobReaper(rootLogger(), env),
				stored: (await env.BLOBS.head(cObjectKey)) !== null
			}).toStrictEqual({
				deleted: 0,
				stored: true
			});

			vi.setSystemTime(afterGrace());

			expect(await runBlobReaper(rootLogger(), env)).toBe(1);
			await expect(env.BLOBS.head(cObjectKey)).resolves.toBeNull();
		});
	});

	describe('authentication', () => {
		it('accepts a bootstrap-issued admin token on each scope of route', async () => {
			const token = await initialise();
			await pushPath(
				token,
				uploadMetadata({ fileSize: narBytes.byteLength, name: 'a' })
			);
			const stats = await authorisedFetch(defaultCacheStatsPath, token);
			const rootResponse = await authorisedFetch('/roots/main', token, {
				body: JSON.stringify({
					targets: ['/nix/store/11111111111111111111111111111111-a']
				}),
				headers: { 'content-type': 'application/json' },
				method: 'PUT'
			});

			expect([stats.status, rootResponse.status]).toStrictEqual([
				StatusCodes.OK,
				StatusCodes.OK
			]);
		});

		it('refuses a write token on admin routes but accepts it on write routes', async () => {
			const admin = await initialise();
			const target = '/nix/store/11111111111111111111111111111111-a';
			await pushPath(
				admin,
				uploadMetadata({ fileSize: narBytes.byteLength, name: 'a' })
			);
			const writeToken = await issueServerSignedToken(
				cacheWriteGrants(['main']),
				'ci'
			);

			const rootResponse = await authorisedFetch('/roots/main', writeToken, {
				body: JSON.stringify({ targets: [target] }),
				headers: { 'content-type': 'application/json' },
				method: 'PUT'
			});
			const stats = await authorisedFetch(defaultCacheStatsPath, writeToken);
			const removed = await authorisedFetch(
				'/paths/11111111111111111111111111111111',
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
