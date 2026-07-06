import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeEach, describe, expect, it } from 'vitest';

import { pendingUploads } from '../db/schema.ts';
import { narObjectKey } from '../http/http.ts';
import {
	commitPath,
	commitUpload,
	currentServer,
	expectSingleCommitDecision,
	fetchNarInfo,
	initialise,
	listRoots,
	markUploadPendingVerification,
	narInfoGeneration,
	negotiateUploads,
	resetTestServer,
	seedReservedNarInfo,
	setRoot,
	uploadMetadata,
	verifiableNar
} from '../test-support.ts';

type PendingRow = typeof pendingUploads.$inferSelect;

async function snapshotPendingRow(uploadId: string): Promise<PendingRow> {
	const row = await runInDurableObject(currentServer(), (_instance, state) =>
		drizzle(state.storage, { schema: { pendingUploads } })
			.select()
			.from(pendingUploads)
			.where(eq(pendingUploads.id, uploadId))
			.get()
	);

	if (row === undefined) {
		throw new Error(`no pending row for ${uploadId}`);
	}

	return row;
}

async function replantStuckPending(row: PendingRow): Promise<void> {
	await runInDurableObject(currentServer(), (_instance, state) => {
		drizzle(state.storage, { schema: { pendingUploads } })
			.insert(pendingUploads)
			.values({ ...row, verdict: 'pending', claimedAt: undefined })
			.run();
	});
}

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

	it('keeps a rooted reuse path when a stale missing verdict loses to its commit', async () => {
		const token = await initialise();
		const nar = await verifiableNar('reuse-committed');
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
		// Snapshot the reuse's pending row, then commit it fully so its generation
		// materialises (its reference edge and object land).
		const staged = await snapshotPendingRow(reuse.uploadId);
		await commitUpload(token, reuse.uploadId);
		await setRoot(token, { name: 'main', targets: [second.storePath] });

		// A stale missing verdict re-drives the settled row: it must not prune the
		// root, because the generation already committed and the path serves.
		await replantStuckPending(staged);
		await currentServer().recordMissingObject(reuse.uploadId);

		const { roots } = await listRoots(token);
		expect(
			(roots.at(0)?.targets ?? []).map((target) => target.storePathHash)
		).toStrictEqual([second.storePathHash]);
	});
});
