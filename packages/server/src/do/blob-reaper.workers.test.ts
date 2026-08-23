import { rootLogger } from '@cupboard/logger';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { blobReaperGraceMs, narObjectKey } from '../http/http.ts';
import { runBlobReaper, runCasReaper } from '../routing/scheduled.ts';
import {
	afterGrace,
	blobReferenceRows,
	blobStateArmTimes,
	blobStateNarHashes,
	casObjectRows,
	clearBlobStorage,
	commitPath,
	deleteBlobState,
	deletePath,
	fetchNarInfo,
	initialise,
	resetTestServer,
	seedBlobStates,
	seedCasObjects,
	syntheticCasDigest,
	syntheticNarHash,
	testBase,
	uploadMetadata,
	verifiableNar
} from '../test-support.ts';

// The reaper first gives each unreferenced `blob_state` row a grace deadline.
// A later pass deletes the object only if the deadline has elapsed and no
// `blob_ref` has appeared. A new reference clears the deadline.

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
		await deletePath(token, metadata.storePathHash);

		await runBlobReaper(rootLogger(), env);

		expect({
			blobState: await blobStateNarHashes(),
			blobPresent: (await env.BLOBS.head(narObjectKey(nar.narHash))) !== null
		}).toStrictEqual({
			blobState: [{ narHash: nar.narHash }],
			blobPresent: true
		});

		vi.setSystemTime(afterGrace());
		await runBlobReaper(rootLogger(), env);

		expect({
			blobState: await blobStateNarHashes(),
			blobPresent: (await env.BLOBS.head(narObjectKey(nar.narHash))) !== null
		}).toStrictEqual({ blobState: [], blobPresent: false });
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
			blobPresent: (await env.BLOBS.head(narObjectKey(nar.narHash))) !== null
		}).toStrictEqual({
			narHash: nar.narHash,
			blobState: [{ narHash: nar.narHash }],
			blobPresent: true
		});
	});

	it('re-promotes onto an orphan object whose blob_state was reaped mid-collection', async () => {
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
		await deletePath(token, first.storePathHash);

		// The residue of a reaper that deleted the `blob_state` fact (D1-first) but
		// crashed before the R2 delete: an orphan object, no fact, no edge.
		await deleteBlobState(nar.narHash);

		expect({
			edges: await blobReferenceRows(),
			blobState: await blobStateNarHashes(),
			blobPresent: (await env.BLOBS.head(narObjectKey(nar.narHash))) !== null
		}).toStrictEqual({ edges: [], blobState: [], blobPresent: true });

		// A fresh commit of the same hash re-promotes, adopting the orphan object and
		// re-recording its fact, so the path serves.
		await commitPath(token, second, nar);
		const served = await fetchNarInfo(second.storePathHash);

		expect({
			narHash: served.narHash.toString(),
			blobState: await blobStateNarHashes(),
			blobPresent: (await env.BLOBS.head(narObjectKey(nar.narHash))) !== null
		}).toStrictEqual({
			narHash: nar.narHash,
			blobState: [{ narHash: nar.narHash }],
			blobPresent: true
		});
	});
});
