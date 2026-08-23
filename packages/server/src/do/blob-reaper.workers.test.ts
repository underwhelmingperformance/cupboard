import { rootLogger } from '@cupboard/logger';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { lateWriteTombstoneHorizonMs } from '../blob/object-incarnation.ts';
import { blobReaperGraceMs, casObjectKey, narObjectKey } from '../http/http.ts';
import {
	afterGrace,
	blobReferenceRows,
	blobStateArmTimes,
	blobStateNarHashes,
	casObjectRows,
	clearBlobStorage,
	commitPath,
	currentNarObjectKey,
	deleteBlobState,
	deletePath,
	fetchNarInfo,
	flakyD1,
	initialise,
	readFetch,
	resetTestServer,
	runBlobReaperToCompletion as runBlobReaper,
	runCasReaperToCompletion as runCasReaper,
	seedBlobStates,
	seedCasObjects,
	syntheticCasDigest,
	syntheticNarHash,
	testBase,
	uploadMetadata,
	verifiableNar,
	verifiableNarStored
} from '../test-support.ts';

async function deletionMarkerCount(
	kind: 'nar' | 'cas',
	objectId: string
): Promise<number> {
	const row = await env.CUPBOARD_DB.prepare(
		'SELECT COUNT(*) AS count FROM object_deletion WHERE kind = ? AND object_id = ?'
	)
		.bind(kind, objectId)
		.first<{ count: number }>();

	return row?.count ?? 0;
}

function failD1Batch(database: D1Database, failureNumber: number): D1Database {
	let calls = 0;

	return {
		prepare: database.prepare.bind(database),
		batch(statements) {
			calls += 1;

			return calls === failureNumber
				? Promise.reject(new Error('D1 batch unavailable'))
				: database.batch(statements);
		},
		exec: database.exec.bind(database),
		withSession: database.withSession.bind(database),
		dump: () => Promise.reject(new Error('dump is not supported here'))
	};
}

async function removeLateWriteTombstones(): Promise<void> {
	try {
		vi.setSystemTime(
			new Date(testBase.getTime() + lateWriteTombstoneHorizonMs)
		);
		await runBlobReaper(rootLogger(), env);
	} finally {
		vi.setSystemTime(testBase);
	}
}

// The reaper first assigns a grace deadline to each unreferenced blob row. A
// later bounded pass removes rows whose deadlines elapsed and which remain
// unreferenced. A new reference clears the deadline.

describe('blob reaper', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(testBase);
		await resetTestServer();

		await clearBlobStorage();
	});

	it('arms an unreferenced blob and collects it only after the grace', async () => {
		const token = await initialise();
		const nar = await verifiableNar('reaper-basic');
		const metadata = uploadMetadata({
			storePathHash: 'a'.repeat(32),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		await commitPath(token, metadata, nar);
		await removeLateWriteTombstones();
		const key = await currentNarObjectKey(nar.narHash);
		await deletePath(token, metadata.storePathHash);

		await runBlobReaper(rootLogger(), env);

		expect({
			blobState: await blobStateNarHashes(),
			blobPresent: (await env.BLOBS.head(key)) !== null
		}).toStrictEqual({
			blobState: [{ narHash: nar.narHash }],
			blobPresent: true
		});

		vi.setSystemTime(afterGrace());
		await runBlobReaper(rootLogger(), env);

		expect({
			blobState: await blobStateNarHashes(),
			blobPresent: (await env.BLOBS.head(key)) !== null
		}).toStrictEqual({ blobState: [], blobPresent: false });
	});

	it('retries a NAR object delete after collection loses its first response', async () => {
		const token = await initialise();
		const nar = await verifiableNar('reaper-delete-retry');
		const metadata = uploadMetadata({
			storePathHash: 'a'.repeat(32),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		await commitPath(token, metadata, nar);
		await removeLateWriteTombstones();
		const key = await currentNarObjectKey(nar.narHash);
		await deletePath(token, metadata.storePathHash);
		await runBlobReaper(rootLogger(), env);
		vi.setSystemTime(afterGrace());

		const bucket: R2Bucket = {
			head: env.BLOBS.head.bind(env.BLOBS),
			get: env.BLOBS.get.bind(env.BLOBS),
			put: env.BLOBS.put.bind(env.BLOBS),
			delete: () => {
				throw new Error('R2 delete unavailable');
			},
			list: env.BLOBS.list.bind(env.BLOBS),
			createMultipartUpload: env.BLOBS.createMultipartUpload.bind(env.BLOBS),
			resumeMultipartUpload: env.BLOBS.resumeMultipartUpload.bind(env.BLOBS)
		};

		await expect(
			runBlobReaper(rootLogger(), { ...env, BLOBS: bucket })
		).rejects.toThrow('R2 delete unavailable');
		expect({
			markerCount: await deletionMarkerCount('nar', nar.narHash),
			objectPresent: (await env.BLOBS.head(key)) !== null
		}).toStrictEqual({ markerCount: 1, objectPresent: true });

		await runBlobReaper(rootLogger(), env);

		expect({
			markerCount: await deletionMarkerCount('nar', nar.narHash),
			objectPresent: (await env.BLOBS.head(key)) !== null
		}).toStrictEqual({ markerCount: 0, objectPresent: false });
	});

	it('keeps the blob_state row when its deletion transaction fails', async () => {
		const token = await initialise();
		const nar = await verifiableNar('reaper-deletion-transaction');
		const metadata = uploadMetadata({
			storePathHash: 'a'.repeat(32),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		await commitPath(token, metadata, nar);
		await removeLateWriteTombstones();
		const key = await currentNarObjectKey(nar.narHash);
		await deletePath(token, metadata.storePathHash);
		await runBlobReaper(rootLogger(), env);
		vi.setSystemTime(afterGrace());

		await expect(
			runBlobReaper(rootLogger(), {
				...env,
				CUPBOARD_DB: failD1Batch(env.CUPBOARD_DB, 1)
			})
		).rejects.toThrow('D1 batch unavailable');

		expect({
			blobStates: await blobStateNarHashes(),
			markerCount: await deletionMarkerCount('nar', nar.narHash),
			objectPresent: (await env.BLOBS.head(key)) !== null
		}).toStrictEqual({
			blobStates: [{ narHash: nar.narHash }],
			markerCount: 0,
			objectPresent: true
		});

		await runBlobReaper(rootLogger(), env);
	});

	it('retries marker cleanup after the physical delete succeeds', async () => {
		const token = await initialise();
		const nar = await verifiableNar('reaper-marker-cleanup');
		const metadata = uploadMetadata({
			storePathHash: 'a'.repeat(32),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		await commitPath(token, metadata, nar);
		await removeLateWriteTombstones();
		const key = await currentNarObjectKey(nar.narHash);
		await deletePath(token, metadata.storePathHash);
		await runBlobReaper(rootLogger(), env);
		vi.setSystemTime(afterGrace());

		await expect(
			runBlobReaper(rootLogger(), {
				...env,
				CUPBOARD_DB: flakyD1(env.CUPBOARD_DB, {
					failures: 1,
					message: 'D1 marker cleanup unavailable',
					matches: (query) => query.includes('delete from "object_deletion"')
				})
			})
		).rejects.toThrow('D1 marker cleanup unavailable');

		expect({
			blobStates: await blobStateNarHashes(),
			markerCount: await deletionMarkerCount('nar', nar.narHash),
			objectPresent: (await env.BLOBS.head(key)) !== null
		}).toStrictEqual({
			blobStates: [],
			markerCount: 1,
			objectPresent: false
		});

		await runBlobReaper(rootLogger(), env);
		expect(await deletionMarkerCount('nar', nar.narHash)).toBe(0);
	});

	it('retries a CAS object delete after collection loses its first response', async () => {
		const digest = syntheticCasDigest(1000);
		const key = casObjectKey(digest);

		await seedCasObjects([digest]);
		await env.BLOBS.put(key, 'bundle');
		await runCasReaper(rootLogger(), env);
		vi.setSystemTime(afterGrace());

		const bucket: R2Bucket = {
			head: env.BLOBS.head.bind(env.BLOBS),
			get: env.BLOBS.get.bind(env.BLOBS),
			put: env.BLOBS.put.bind(env.BLOBS),
			delete: () => {
				throw new Error('R2 delete unavailable');
			},
			list: env.BLOBS.list.bind(env.BLOBS),
			createMultipartUpload: env.BLOBS.createMultipartUpload.bind(env.BLOBS),
			resumeMultipartUpload: env.BLOBS.resumeMultipartUpload.bind(env.BLOBS)
		};

		await expect(
			runCasReaper(rootLogger(), { ...env, BLOBS: bucket })
		).rejects.toThrow('R2 delete unavailable');
		expect({
			markerCount: await deletionMarkerCount('cas', digest),
			objectPresent: (await env.BLOBS.head(key)) !== null
		}).toStrictEqual({ markerCount: 1, objectPresent: true });

		await runCasReaper(rootLogger(), env);

		expect({
			markerCount: await deletionMarkerCount('cas', digest),
			objectPresent: (await env.BLOBS.head(key)) !== null
		}).toStrictEqual({ markerCount: 0, objectPresent: false });
	});

	it('retries interrupted deletes without touching later NAR incarnations', async () => {
		const token = await initialise();
		const nar = await verifiableNar('reaper-repeated-delete-retry');
		const metadataFor = (hash: string, name: string) =>
			uploadMetadata({
				storePathHash: hash.repeat(32),
				name,
				narHash: nar.narHash,
				narSize: nar.narSize,
				fileHash: nar.fileHash,
				fileSize: nar.narBytes.byteLength
			});
		const first = metadataFor('a', 'first');
		const second = metadataFor('b', 'second');
		const third = metadataFor('c', 'third');
		const failingBucket = (): R2Bucket => ({
			head: env.BLOBS.head.bind(env.BLOBS),
			get: env.BLOBS.get.bind(env.BLOBS),
			put: env.BLOBS.put.bind(env.BLOBS),
			delete: vi.fn().mockRejectedValue(new Error('R2 delete unavailable')),
			list: env.BLOBS.list.bind(env.BLOBS),
			createMultipartUpload: env.BLOBS.createMultipartUpload.bind(env.BLOBS),
			resumeMultipartUpload: env.BLOBS.resumeMultipartUpload.bind(env.BLOBS)
		});

		await commitPath(token, first, nar);
		await removeLateWriteTombstones();
		const key = await currentNarObjectKey(nar.narHash);
		await deletePath(token, first.storePathHash);
		await runBlobReaper(rootLogger(), env);
		vi.setSystemTime(afterGrace());
		await expect(
			runBlobReaper(rootLogger(), { ...env, BLOBS: failingBucket() })
		).rejects.toThrow('R2 delete unavailable');

		const secondToken = await initialise();
		await commitPath(secondToken, second, nar);
		await runBlobReaper(rootLogger(), env);
		const retired = await env.BLOBS.head(key);
		const live = await env.BLOBS.head(narObjectKey(nar.narHash, 3));
		expect({
			retiredPresent: retired !== null,
			livePresent: live !== null
		}).toStrictEqual({ retiredPresent: false, livePresent: true });

		await deletePath(secondToken, second.storePathHash);
		await runBlobReaper(rootLogger(), env);
		vi.setSystemTime(new Date(afterGrace().getTime() + blobReaperGraceMs));
		await expect(
			runBlobReaper(rootLogger(), { ...env, BLOBS: failingBucket() })
		).rejects.toThrow('R2 delete unavailable');

		await commitPath(await initialise(), third, nar);
		await runBlobReaper(rootLogger(), env);
		const served = await fetchNarInfo(third.storePathHash);
		const firstObject = await env.BLOBS.head(narObjectKey(nar.narHash, 2));
		const secondObject = await env.BLOBS.head(narObjectKey(nar.narHash, 3));
		const thirdObject = await env.BLOBS.head(narObjectKey(nar.narHash, 4));

		expect({
			url: served.url,
			firstPresent: firstObject !== null,
			secondPresent: secondObject !== null,
			thirdPresent: thirdObject !== null
		}).toStrictEqual({
			url: narObjectKey(nar.narHash, 4),
			firstPresent: false,
			secondPresent: false,
			thirdPresent: true
		});
	});

	it('arms candidate batches beyond one D1 parameter chunk', async () => {
		const narHashes = Array.from({ length: 120 }, (_, index) =>
			syntheticNarHash(index)
		);
		const digests = Array.from({ length: 120 }, (_, index) =>
			syntheticCasDigest(index)
		);

		await seedBlobStates(narHashes);
		await seedCasObjects(digests);

		await runBlobReaper(rootLogger(), env);
		await runCasReaper(rootLogger(), env);

		const armedUntil = new Date(
			testBase.getTime() + blobReaperGraceMs
		).toISOString();

		expect({
			blobs: await blobStateArmTimes(),
			casObjects: await casObjectRows()
		}).toStrictEqual({
			blobs: narHashes
				.toSorted(byCodeUnit)
				.map((narHash) => ({ narHash, deleteAfter: armedUntil })),
			casObjects: digests
				.toSorted(byCodeUnit)
				.map((digest) => ({ digest, size: 1, deleteAfter: armedUntil }))
		});
	});

	it('spares a blob re-referenced by a reuse commit during the grace', async () => {
		const token = await initialise();
		const nar = await verifiableNar('reaper-reuse');
		const first = uploadMetadata({
			storePathHash: 'a'.repeat(32),
			name: 'first',
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		const second = uploadMetadata({
			storePathHash: 'b'.repeat(32),
			name: 'second',
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		await commitPath(token, first, nar);
		const key = await currentNarObjectKey(nar.narHash);
		await deletePath(token, first.storePathHash);

		// Arm the now-unreferenced blob, then bind a new narinfo to it. The delete
		// drained this tenant's presence edge, so negotiate is oracle-safe and tells
		// it to re-upload; the promote adopts the surviving canonical object and
		// clears the grace timer, re-referencing the hash.
		await runBlobReaper(rootLogger(), env);
		await commitPath(token, second, nar);

		vi.setSystemTime(afterGrace());
		await runBlobReaper(rootLogger(), env);

		const served = await fetchNarInfo(second.storePathHash);

		expect({
			narHash: served.narHash.toString(),
			blobState: await blobStateNarHashes(),
			blobPresent: (await env.BLOBS.head(key)) !== null
		}).toStrictEqual({
			narHash: nar.narHash,
			blobState: [{ narHash: nar.narHash }],
			blobPresent: true
		});
	});

	it('re-promotes after blob state was reaped before its old object', async () => {
		const token = await initialise();
		const nar = await verifiableNar('reaper-adopt');
		const first = uploadMetadata({
			storePathHash: 'a'.repeat(32),
			name: 'first',
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		const second = uploadMetadata({
			storePathHash: 'b'.repeat(32),
			name: 'second',
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		await commitPath(token, first, nar);
		const oldKey = await currentNarObjectKey(nar.narHash);
		await deletePath(token, first.storePathHash);

		// The residue of a reaper that deleted the `blob_state` fact (D1-first) but
		// crashed before the R2 delete: an orphan object, no fact, no edge.
		await deleteBlobState(nar.narHash);

		expect({
			edges: await blobReferenceRows(),
			blobState: await blobStateNarHashes(),
			blobPresent: (await env.BLOBS.head(oldKey)) !== null
		}).toStrictEqual({ edges: [], blobState: [], blobPresent: true });

		// A fresh commit uses a new physical incarnation. The deletion queue retains
		// the orphaned key until maintenance removes that exact incarnation.
		await commitPath(token, second, nar);
		const served = await fetchNarInfo(second.storePathHash);

		expect({
			narHash: served.narHash.toString(),
			blobState: await blobStateNarHashes(),
			oldObjectPresent: (await env.BLOBS.head(oldKey)) !== null
		}).toStrictEqual({
			narHash: nar.narHash,
			blobState: [{ narHash: nar.narHash }],
			oldObjectPresent: true
		});
	});

	it('gives a replacement encoding a distinct immutable NAR URL', async () => {
		const token = await initialise();
		const compressed = await verifiableNar('reaper-encoding-replacement');
		const stored = await verifiableNarStored('reaper-encoding-replacement');
		const second = uploadMetadata({
			storePathHash: 'b'.repeat(32),
			name: 'second',
			narHash: stored.narHash,
			narSize: stored.narSize,
			fileHash: stored.fileHash,
			fileSize: stored.narBytes.byteLength
		});
		const intermediary = new Map<string, Response>();
		const cachedRead = async (path: string): Promise<Response> => {
			const cached = intermediary.get(path);

			if (cached !== undefined) {
				return cached.clone();
			}

			const response = await readFetch(`/${path}`);
			intermediary.set(path, response.clone());

			return response;
		};

		const legacyUrl = narObjectKey(compressed.narHash);
		await env.BLOBS.put(legacyUrl, compressed.narBytes);
		intermediary.set(legacyUrl, new Response(compressed.narBytes));
		const firstResponse = await cachedRead(legacyUrl);
		await commitPath(token, second, stored);

		const secondInfo = await fetchNarInfo(second.storePathHash);
		const secondResponse = await cachedRead(secondInfo.url);

		expect({
			first: {
				url: legacyUrl,
				fileHash: compressed.fileHash,
				bytes: new Uint8Array(await firstResponse.arrayBuffer())
			},
			second: {
				url: secondInfo.url,
				fileHash: secondInfo.fileHash.toString(),
				bytes: new Uint8Array(await secondResponse.arrayBuffer())
			}
		}).toStrictEqual({
			first: {
				url: legacyUrl,
				fileHash: compressed.fileHash,
				bytes: compressed.narBytes
			},
			second: {
				url: narObjectKey(stored.narHash, 2),
				fileHash: stored.fileHash,
				bytes: stored.narBytes
			}
		});
	});

	it('does not delete an incarnation promoted after collection commits', async () => {
		const token = await initialise();
		const nar = await verifiableNar('reaper-promotion-race');
		const first = uploadMetadata({
			storePathHash: 'a'.repeat(32),
			name: 'first',
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		const second = uploadMetadata({
			...first,
			storePathHash: 'b'.repeat(32),
			name: 'second'
		});

		await commitPath(token, first, nar);
		await deletePath(token, first.storePathHash);
		await runBlobReaper(rootLogger(), env);
		vi.setSystemTime(afterGrace());
		const secondToken = await initialise();

		let isInterleaved = false;
		const bucket: R2Bucket = {
			head: env.BLOBS.head.bind(env.BLOBS),
			get: env.BLOBS.get.bind(env.BLOBS),
			put: env.BLOBS.put.bind(env.BLOBS),
			async delete(keys) {
				if (!isInterleaved) {
					isInterleaved = true;
					await commitPath(secondToken, second, nar);
				}

				return env.BLOBS.delete(keys);
			},
			list: env.BLOBS.list.bind(env.BLOBS),
			createMultipartUpload: env.BLOBS.createMultipartUpload.bind(env.BLOBS),
			resumeMultipartUpload: env.BLOBS.resumeMultipartUpload.bind(env.BLOBS)
		};

		await runBlobReaper(rootLogger(), { ...env, BLOBS: bucket });

		const narInfo = await fetchNarInfo(second.storePathHash);
		const response = await readFetch(`/${narInfo.url}`);
		expect({
			isInterleaved,
			status: response.status,
			bytes: await response.text()
		}).toStrictEqual({
			isInterleaved: true,
			status: StatusCodes.OK,
			bytes: new TextDecoder().decode(nar.narBytes)
		});
	});
});
