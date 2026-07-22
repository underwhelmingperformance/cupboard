import { DEFAULT_CACHE } from '@cupboard/nix-store/scalars';
import type { UploadId } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { pendingUploads, retentionRootTargets } from '../db/schema.ts';
import { narInfoObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	authorisedFetch,
	clearBlobStorage,
	commitUpload,
	currentServer,
	deferFreshUpload,
	deleteBlobState,
	expectSingleUploadDecision,
	initialise,
	listRoots,
	markUploadPendingVerification,
	narBytes,
	narInfoGeneration,
	negotiateUploads,
	pushPath,
	putNarBytes,
	resetTestServer,
	setRoot,
	suspendTenant,
	testBase,
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

// Re-plants a cleared pending row as still awaiting its verdict, the state an
// eviction leaves when the object published but the clear-marker step never ran.
async function replantStuckPending(row: PendingRow): Promise<void> {
	await runInDurableObject(currentServer(), (_instance, state) => {
		drizzle(state.storage, { schema: { pendingUploads } })
			.insert(pendingUploads)
			.values({ ...row, verdict: 'pending', claimedAt: undefined })
			.run();
	});
}

// A retention root may reference any target backed by a committed narinfo row,
// including one still verifying, so a push records retention before the background
// pass materialises the path. A target with no row at all is rejected. `present`
// reflects the serve predicate (the materialised narinfo object, repairing a
// merely-lost one first), so it reads false until the target verifies.

describe('root activation gating', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(testBase);
		await resetTestServer();
		await clearBlobStorage();
	});

	it('refuses to root a target with no committed narinfo row', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(upload.r2Key);
		// Negotiated and staged, but never committed, so no narinfo row backs the
		// path: a root cannot reference it.
		await markUploadPendingVerification(upload.uploadId);

		const response = await authorisedFetch(
			'/cache/_default/roots/main',
			token,
			{
				body: JSON.stringify({ targets: [metadata.storePath] }),
				headers: { 'content-type': 'application/json' },
				method: 'PUT'
			}
		);
		const { roots } = await listRoots(token);

		expect({ status: response.status, roots }).toStrictEqual({
			status: StatusCodes.CONFLICT,
			roots: []
		});
	});

	it('roots a still-verifying deferred commit, present once it materialises', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(upload.r2Key);
		// A deferred commit reserves the narinfo row before verification, so the
		// root binds now and the target reads `present: false` until the pass
		// materialises the object.
		await commitUpload(token, upload.uploadId, DEFAULT_CACHE, { wait: false });

		const reserved = await setRoot(token, {
			name: 'main',
			targets: [metadata.storePath]
		});

		await currentServer().runVerification();
		const { roots: activated } = await listRoots(token);

		const target = {
			storePathHash: metadata.storePathHash,
			storePath: metadata.storePath
		};
		expect({
			reserved: reserved.targets,
			activated: activated.at(0)?.targets
		}).toStrictEqual({
			reserved: [{ ...target, present: false }],
			activated: [{ ...target, present: true }]
		});
	});

	it('keeps a rooted still-verifying path through a GC sweep', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(upload.r2Key);
		await commitUpload(token, upload.uploadId, DEFAULT_CACHE, { wait: false });
		await setRoot(token, { name: 'main', targets: [metadata.storePath] });

		// A sweep landing in the verify window must spare the reserved,
		// still-unmaterialised row: the root reaches it and its upload is in flight.
		// This is the regression for a rooted path being collected before it served.
		await currentServer().runGarbageCollection();
		await currentServer().runVerification();

		const served = await env.BLOBS.head(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash)
		);
		const { roots } = await listRoots(token);

		expect({
			served: served !== null,
			present: roots.at(0)?.targets.at(0)?.present
		}).toStrictEqual({ served: true, present: true });
	});

	it('prunes a rooted target whose verification fails', async () => {
		const token = await initialise();
		const good = await verifiableNar('prune-good');
		const wrong = await verifiableNar('prune-wrong');
		// Bytes whose checksum matches the declared fileHash but which decompress to a
		// different NAR than the declared narHash: a background mismatch.
		const metadata = uploadMetadata({
			storePathHash: 'a'.repeat(32),
			narHash: good.narHash,
			narSize: good.narSize,
			fileHash: wrong.fileHash,
			fileSize: wrong.narBytes.byteLength
		});
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(upload.r2Key, wrong);
		await commitUpload(token, upload.uploadId, DEFAULT_CACHE, { wait: false });
		await setRoot(token, { name: 'main', targets: [metadata.storePath] });

		// The NAR-hash check fails, so the target can never become servable and is
		// dropped from the root.
		await currentServer().runVerification();

		const { roots } = await listRoots(token);
		expect(roots.at(0)?.targets ?? []).toStrictEqual([]);
	});

	it('keeps a rooted target when a straggling mismatch loses to its own commit', async () => {
		const token = await initialise();
		const upload = await deferFreshUpload(token, 'straggler', 'c'.repeat(32));
		const staged = await snapshotPendingRow(upload.uploadId);

		await currentServer().runVerification();
		await setRoot(token, {
			name: 'main',
			targets: [upload.metadata.storePath]
		});

		// Delete only the narinfo object, so the already-committed short-circuit
		// (which needs the object present) does not fire; the reference edge still
		// proves the path committed. A straggling mismatch verdict on the re-planted
		// row must not retire the row's root, since these bytes are servable.
		await env.BLOBS.delete(
			narInfoObjectKey(fixtureTenant, upload.metadata.storePathHash)
		);
		await replantStuckPending(staged);

		await currentServer().recordVerification(upload.uploadId, {
			ok: false,
			reason: 'nar-hash-mismatch',
			actualNarHash: upload.nar.narHash
		});

		const { roots } = await listRoots(token);
		expect({
			generation: await narInfoGeneration(upload.metadata.storePathHash),
			targets: (roots.at(0)?.targets ?? []).map(
				(target) => target.storePathHash
			)
		}).toStrictEqual({
			generation: 0,
			targets: [upload.metadata.storePathHash]
		});
	});

	it('prunes a rooted pending path whose tenant goes inactive before verification', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'd'.repeat(32)
		});
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(upload.r2Key);
		await commitUpload(token, upload.uploadId, DEFAULT_CACHE, { wait: false });
		await setRoot(token, { name: 'main', targets: [metadata.storePath] });

		// The tenant is suspended before the deferred path verifies, so it can never
		// materialise; its root target must be pruned, not left dangling.
		await suspendTenant(fixtureTenant);
		await currentServer().runVerification();

		const targets = await runInDurableObject(
			currentServer(),
			(_instance, state) =>
				drizzle(state.storage, { schema: { retentionRootTargets } })
					.select({ storePathHash: retentionRootTargets.storePathHash })
					.from(retentionRootTargets)
					.all()
		);
		expect(targets).toStrictEqual([]);
	});

	it('accepts a root whose narinfo object is missing but repairable', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await pushPath(token, metadata);
		// Lose only the materialised object: the row and the shared blob remain, so
		// the path is still servable once the object is re-materialised.
		await env.BLOBS.delete(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash)
		);

		const summary = await setRoot(token, {
			name: 'main',
			targets: [metadata.storePath]
		});
		const repaired = await env.BLOBS.head(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash)
		);

		expect({
			targets: summary.targets,
			repaired: repaired !== null
		}).toStrictEqual({
			targets: [
				{
					storePathHash: metadata.storePathHash,
					storePath: metadata.storePath,
					present: true
				}
			],
			repaired: true
		});
	});

	it('reports present false for a rooted path whose blob was demoted', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await pushPath(token, metadata);
		const original = await setRoot(token, {
			name: 'main',
			targets: [metadata.storePath]
		});

		// Demote: drop the shared fact and the materialised object, leaving the
		// narinfo row. The row exists, but the path is no longer servable.
		await deleteBlobState(metadata.narHash);
		await env.BLOBS.delete(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash)
		);
		const { roots } = await listRoots(token);

		expect({
			whenRooted: original.targets,
			afterDemote: roots
		}).toStrictEqual({
			whenRooted: [
				{
					storePathHash: metadata.storePathHash,
					storePath: metadata.storePath,
					present: true
				}
			],
			afterDemote: [
				{
					name: 'main',
					expired: false,
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z',
					targets: [
						{
							storePathHash: metadata.storePathHash,
							storePath: metadata.storePath,
							present: false
						}
					]
				}
			]
		});
	});
});
