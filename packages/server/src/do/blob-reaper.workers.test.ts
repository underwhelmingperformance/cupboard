import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { narObjectKey } from '../http/http.ts';
import { runBlobReaper } from '../routing/scheduled.ts';
import {
	afterGrace,
	blobReferenceRows,
	blobStateNarHashes,
	clearBlobStorage,
	commitPath,
	deleteBlobState,
	deletePath,
	deleteTestBase,
	fetchNarInfo,
	initialise,
	resetTestServer,
	uploadMetadata,
	verifiableNar
} from '../test-support.ts';

// The reaper works the shared `blob_state` facts in two bounded passes: arm
// every blob no `blob_ref` references with a grace timer, then collect those whose
// grace has elapsed and that are still unreferenced. A commit that re-references a
// hash clears the timer, sparing the blob.

describe('blob reaper', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(deleteTestBase);
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

		// The first pass arms the now-unreferenced blob but, the grace not yet
		// elapsed, leaves both the fact and the object in place.
		await runBlobReaper(env);

		expect({
			blobState: await blobStateNarHashes(),
			blobPresent: (await env.BLOBS.head(narObjectKey(nar.narHash))) !== null
		}).toStrictEqual({
			blobState: [{ narHash: nar.narHash }],
			blobPresent: true
		});

		// Past the grace, the second pass collects the fact and then the object.
		vi.setSystemTime(afterGrace());
		await runBlobReaper(env);

		expect({
			blobState: await blobStateNarHashes(),
			blobPresent: (await env.BLOBS.head(narObjectKey(nar.narHash))) !== null
		}).toStrictEqual({ blobState: [], blobPresent: false });
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
		await runBlobReaper(env);
		await commitPath(token, second, nar);

		// Past the original grace, the reaper must not collect it: it is referenced
		// again, and its timer was cleared.
		vi.setSystemTime(afterGrace());
		await runBlobReaper(env);

		const served = await fetchNarInfo(second.storePathHash);

		expect({
			narHash: served.narHash,
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
			narHash: served.narHash,
			blobState: await blobStateNarHashes(),
			blobPresent: (await env.BLOBS.head(narObjectKey(nar.narHash))) !== null
		}).toStrictEqual({
			narHash: nar.narHash,
			blobState: [{ narHash: nar.narHash }],
			blobPresent: true
		});
	});
});
