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
	defaultCache,
	deferFreshUpload,
	deleteBlobState,
	expectSingleUploadDecision,
	initialise,
	listRoots,
	listRootTargets,
	markUploadPendingVerification,
	narBytes,
	narInfoGeneration,
	negotiateUploads,
	pushPath,
	putNarBytes,
	recordClaimedVerification,
	resetTestServer,
	setRoot,
	suspendTenant,
	testBase,
	uploadMetadata,
	verifiableNar,
	verifyCurrentTenant
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

// Replant the pending row to reproduce a crash after publication and before the
// marker was cleared.
async function replantStuckPending(row: PendingRow): Promise<void> {
	await runInDurableObject(currentServer(), (_instance, state) => {
		drizzle(state.storage, { schema: { pendingUploads } })
			.insert(pendingUploads)
			.values({ ...row, verdict: 'pending', claimedAt: undefined })
			.run();
	});
}

// A root can reference a reserved narinfo row before verification materialises
// the path. A target with no row is rejected. `present` reports whether the
// target is currently servable, after repairing a missing narinfo object when
// possible.

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
		await markUploadPendingVerification(upload.uploadId);

		const response = await authorisedFetch('/roots/main', token, {
			body: JSON.stringify({ targets: [metadata.storePath] }),
			headers: { 'content-type': 'application/json' },
			method: 'PUT'
		});
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
		// The deferred commit has reserved the narinfo row, but verification has
		// not made the target servable yet.
		await commitUpload(token, upload.uploadId, defaultCache(), { wait: false });

		const reserved = await setRoot(token, {
			name: 'main',
			targets: [metadata.storePath]
		});

		await verifyCurrentTenant();
		const activated = await listRootTargets(token, 'main');

		const target = {
			storePathHash: metadata.storePathHash,
			storePath: metadata.storePath
		};
		expect({
			reserved: reserved.targets,
			activated: activated.targets
		}).toStrictEqual({
			reserved: [{ ...target, present: false }],
			activated: [{ ...target, present: true }]
		});
	});

	it('keeps a rooted still-verifying path through a GC pass', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(upload.r2Key);
		await commitUpload(token, upload.uploadId, defaultCache(), { wait: false });
		await setRoot(token, { name: 'main', targets: [metadata.storePath] });

		// The root protects the reserved row while verification is still using its
		// staged upload.
		await currentServer().runGarbageCollection();
		await verifyCurrentTenant();

		const served = await env.BLOBS.head(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash, {
				kind: 'default'
			})
		);
		const { targets } = await listRootTargets(token, 'main');

		expect({
			served: served !== null,
			present: targets.at(0)?.present
		}).toStrictEqual({ served: true, present: true });
	});

	it('prunes a rooted target whose verification fails', async () => {
		const token = await initialise();
		const good = await verifiableNar('prune-good');
		const wrong = await verifiableNar('prune-wrong');
		// The compressed hash matches, but the bytes decode to a different NAR.
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
		await commitUpload(token, upload.uploadId, defaultCache(), { wait: false });
		await setRoot(token, { name: 'main', targets: [metadata.storePath] });

		await verifyCurrentTenant();

		const { targets } = await listRootTargets(token, 'main');
		expect(targets).toStrictEqual([]);
	});

	it('keeps a rooted target when a straggling mismatch loses to its own commit', async () => {
		const token = await initialise();
		const upload = await deferFreshUpload(token, 'straggler', 'c'.repeat(32));
		const staged = await snapshotPendingRow(upload.uploadId);

		await verifyCurrentTenant();
		await setRoot(token, {
			name: 'main',
			targets: [upload.metadata.storePath]
		});

		// Delete only the narinfo object so verification cannot take the
		// already-committed short circuit. The current reference edge still proves
		// that the path was committed, so a stale mismatch must not remove its root.
		await env.BLOBS.delete(
			narInfoObjectKey(fixtureTenant, upload.metadata.storePathHash, {
				kind: 'default'
			})
		);
		await replantStuckPending(staged);

		await recordClaimedVerification(upload.uploadId, {
			ok: false,
			reason: 'nar-hash-mismatch',
			actualNarHash: upload.nar.narHash
		});

		const page = await listRootTargets(token, 'main');
		expect({
			generation: await narInfoGeneration(upload.metadata.storePathHash),
			targets: page.targets.map((target) => target.storePathHash)
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
		await commitUpload(token, upload.uploadId, defaultCache(), { wait: false });
		await setRoot(token, { name: 'main', targets: [metadata.storePath] });

		await suspendTenant(fixtureTenant);
		await verifyCurrentTenant();

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
		// Keep the row and shared blob so ensureRoot can restore the missing narinfo
		// object.
		await env.BLOBS.delete(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash, {
				kind: 'default'
			})
		);

		const summary = await setRoot(token, {
			name: 'main',
			targets: [metadata.storePath]
		});
		const repaired = await env.BLOBS.head(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash, {
				kind: 'default'
			})
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

		// Keep the narinfo row while removing its shared blob and published object.
		await deleteBlobState(metadata.narHash);
		await env.BLOBS.delete(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash, {
				kind: 'default'
			})
		);
		const { roots } = await listRoots(token);
		const afterDemote = await listRootTargets(token, 'main');

		expect({
			whenRooted: original.targets,
			listed: roots,
			afterDemote: afterDemote.targets
		}).toStrictEqual({
			whenRooted: [
				{
					storePathHash: metadata.storePathHash,
					storePath: metadata.storePath,
					present: true
				}
			],
			listed: [
				{
					name: 'main',
					expired: false,
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z',
					targetCount: 1
				}
			],
			afterDemote: [
				{
					storePathHash: metadata.storePathHash,
					storePath: metadata.storePath,
					present: false
				}
			]
		});
	});
});
