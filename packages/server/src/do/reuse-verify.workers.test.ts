import type { UploadId } from '@cupboard/protocol/upload';
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
	listRootTargets,
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

async function snapshotPendingRow(uploadId: UploadId): Promise<PendingRow> {
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

// A reuse row points to canonical bytes that other paths also use, not to a
// private staging object. Clearing the pending row must never delete those bytes.
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

	it('reclaims a reserved row after a reuse commit crashes and its canonical object disappears', async () => {
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

		// Reserve the narinfo row before deleting the canonical object. The crash
		// state exists only while the reservation remains and the object is missing.
		await seedReservedNarInfo(second, 0);
		await env.BLOBS.delete(narObjectKey(nar.narHash));

		await currentServer().recordMissingObject(reuse.uploadId);

		expect(await narInfoGeneration(second.storePathHash)).toBeUndefined();
	});

	it('does not prune a rooted reuse path after a stale missing-object report', async () => {
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
		// Restore the captured pending row only after the generation and its root
		// have committed. This reproduces a delayed report against a rooted path.
		const staged = await snapshotPendingRow(reuse.uploadId);
		await commitUpload(token, reuse.uploadId);
		await setRoot(token, { name: 'main', targets: [second.storePath] });

		await replantStuckPending(staged);
		await currentServer().recordMissingObject(reuse.uploadId);

		const { targets } = await listRootTargets(token, 'main');
		expect(targets.map((target) => target.storePathHash)).toStrictEqual([
			second.storePathHash
		]);
	});
});
