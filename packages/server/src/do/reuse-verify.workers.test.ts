import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import { narObjectKey } from '../http/http.ts';
import {
	commitPath,
	currentServer,
	expectSingleCommitDecision,
	fetchNarInfo,
	initialise,
	markUploadPendingVerification,
	narInfoGeneration,
	negotiateUploads,
	resetTestServer,
	seedReservedNarInfo,
	uploadMetadata,
	verifiableNar
} from '../test-support.ts';

// A reuse upload binds a new store path to a blob already in the verified CAS, so
// its pending row points at the shared canonical key, not a private staging
// object. When such a row settles through the deferred verify pass, clearing it
// must not delete the canonical object other paths still reference.

describe('deferred reuse verification', () => {
	beforeEach(resetTestServer);

	it('keeps the shared canonical object when a deferred reuse row settles', async () => {
		const token = await initialise();
		const nar = await verifiableNar('reuse-deferred');
		const first = uploadMetadata({
			name: 'first',
			storePathHash: 'a'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});

		await commitPath(token, first, nar);

		// A second store path reuses the same blob, so its pending row points at the
		// shared canonical key. Deferring it pushes the reuse through the background
		// verify pass.
		const second = uploadMetadata({
			name: 'second',
			storePathHash: 'b'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});
		const reuse = expectSingleCommitDecision(
			await negotiateUploads(token, [second]),
			second
		);

		await markUploadPendingVerification(reuse.uploadId);
		await currentServer().runVerification();

		const servedFirst = await fetchNarInfo(first.storePathHash);
		const servedSecond = await fetchNarInfo(second.storePathHash);

		// Settling the reuse must not delete the canonical object both paths share.
		expect({
			canonicalPresent:
				(await env.BLOBS.head(narObjectKey(nar.narHash))) !== null,
			firstNarHash: servedFirst.narHash.toString(),
			secondNarHash: servedSecond.narHash.toString()
		}).toStrictEqual({
			canonicalPresent: true,
			firstNarHash: nar.narHash,
			secondNarHash: nar.narHash
		});
	});

	it('reclaims a crashed reuse commit’s reserved row when its canonical object is gone', async () => {
		const token = await initialise();
		const nar = await verifiableNar('reuse-orphan');
		const first = uploadMetadata({
			name: 'first',
			storePathHash: 'a'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});
		await commitPath(token, first, nar);

		const second = uploadMetadata({
			name: 'second',
			storePathHash: 'b'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});
		const reuse = expectSingleCommitDecision(
			await negotiateUploads(token, [second]),
			second
		);
		await markUploadPendingVerification(reuse.uploadId);

		// A reuse commit that crashed after reserving second's narinfo row, then the
		// shared canonical object vanished, so the reuse can never materialise.
		await seedReservedNarInfo(second, 0);
		await env.BLOBS.delete(narObjectKey(nar.narHash));

		await currentServer().recordMissingObject(reuse.uploadId);

		// The stranded reserved row is reclaimed, so no root can reference a dead
		// target and no reconcile pass has to clean it up later.
		expect(await narInfoGeneration(second.storePathHash)).toBeUndefined();
	});
});
