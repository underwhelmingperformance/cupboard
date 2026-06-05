import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { narInfoObjectKey, narObjectKey } from '../http/http.ts';
import { defaultTenant } from '../routing/tenant-routing.ts';
import {
	blobReferenceRows,
	blobStateNarHashes,
	clearBlobStorage,
	commitPath,
	deleteBlobReferenceEdge,
	deleteNarInfoRow,
	deletePath,
	initialise,
	narInfoDeletionRows,
	narInfoGeneration,
	reapBlobsPastGrace,
	resetTestServer,
	seedNarInfoDeletion,
	tenantBlobRows,
	uploadMetadata,
	verifiableNar
} from '../test-support.ts';

// The delete saga is row-first/edge-last with no timestamp phase columns: the
// `narinfo_deletion` row, carrying the captured `(nar_hash, generation)`, is the
// durable marker, and the GC flush is the repair pass. These tests plant the
// cross-store state a crash leaves at each phase and assert the repair converges,
// proving the replay is correct by captured-identity idempotency alone.

describe('delete-saga crash replay', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		await resetTestServer();

		await clearBlobStorage();
	});

	it('drives a delete crashed after the row transaction, before the edge and object go', async () => {
		const token = await initialise();
		const nar = await verifiableNar('phase-row-only');
		const metadata = uploadMetadata({
			storePathHash: 'a'.repeat(32),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		await commitPath(token, metadata, nar);

		// The state right after the delete's row transaction: the narinfo row is gone
		// and its marker is queued, but the edge, shared fact and R2 object survive.
		await deleteNarInfoRow(metadata.storePathHash);
		await seedNarInfoDeletion({
			storePathHash: metadata.storePathHash,
			narHash: nar.narHash,
			generation: 0
		});

		await reapBlobsPastGrace();

		expect({
			markers: await narInfoDeletionRows(),
			edges: await blobReferenceRows(),
			tenantBlobs: await tenantBlobRows(),
			blobState: await blobStateNarHashes(),
			objectPresent:
				(await env.BLOBS.head(
					narInfoObjectKey(defaultTenant, metadata.storePathHash)
				)) !== null
		}).toStrictEqual({
			markers: [],
			edges: [],
			tenantBlobs: [],
			blobState: [],
			objectPresent: false
		});
	});

	it('drives a delete crashed after retiring the edge, before deleting the object', async () => {
		const token = await initialise();
		const nar = await verifiableNar('phase-edge-gone');
		const metadata = uploadMetadata({
			storePathHash: 'b'.repeat(32),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		await commitPath(token, metadata, nar);

		// The edge was retired but the object delete and marker clear did not run.
		await deleteNarInfoRow(metadata.storePathHash);
		await deleteBlobReferenceEdge(metadata.storePathHash, 0);
		await seedNarInfoDeletion({
			storePathHash: metadata.storePathHash,
			narHash: nar.narHash,
			generation: 0
		});

		await reapBlobsPastGrace();

		expect({
			markers: await narInfoDeletionRows(),
			edges: await blobReferenceRows(),
			tenantBlobs: await tenantBlobRows(),
			blobState: await blobStateNarHashes(),
			objectPresent:
				(await env.BLOBS.head(
					narInfoObjectKey(defaultTenant, metadata.storePathHash)
				)) !== null
		}).toStrictEqual({
			markers: [],
			edges: [],
			tenantBlobs: [],
			blobState: [],
			objectPresent: false
		});
	});

	it('drives a delete crashed after deleting the object, before clearing the marker', async () => {
		const token = await initialise();
		const nar = await verifiableNar('phase-object-gone');
		const metadata = uploadMetadata({
			storePathHash: 'c'.repeat(32),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		await commitPath(token, metadata, nar);

		// Every step but the final marker clear ran: row, edge and object are gone.
		await deleteNarInfoRow(metadata.storePathHash);
		await deleteBlobReferenceEdge(metadata.storePathHash, 0);
		await env.BLOBS.delete(
			narInfoObjectKey(defaultTenant, metadata.storePathHash)
		);
		await seedNarInfoDeletion({
			storePathHash: metadata.storePathHash,
			narHash: nar.narHash,
			generation: 0
		});

		await reapBlobsPastGrace();

		expect({
			markers: await narInfoDeletionRows(),
			edges: await blobReferenceRows(),
			blobState: await blobStateNarHashes()
		}).toStrictEqual({ markers: [], edges: [], blobState: [] });
	});

	it('replays a stale deletion against a newer recommit without harming it', async () => {
		const token = await initialise();
		const nar = await verifiableNar('phase-recommit');
		const metadata = uploadMetadata({
			storePathHash: 'd'.repeat(32),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		// Commit, delete, recommit the same NAR hash: the live edge and object reach a
		// higher generation, while a stale marker from the first delete captured
		// generation 0. The delete drained the presence edge, so the recommit
		// re-uploads (oracle-safe) and the promote adopts the surviving canonical blob.
		await commitPath(token, metadata, nar);
		await deletePath(token, metadata.storePathHash);
		await commitPath(token, metadata, nar);
		await seedNarInfoDeletion({
			storePathHash: metadata.storePathHash,
			narHash: nar.narHash,
			generation: 0
		});

		// Replaying the stale generation-0 deletion retires no edge (only generation 1
		// exists) and, finding the path live, clears itself without touching the
		// servable generation-1 narinfo or its blob.
		await reapBlobsPastGrace();

		expect({
			markers: await narInfoDeletionRows(),
			edges: await blobReferenceRows(),
			tenantBlobs: await tenantBlobRows(),
			blobState: await blobStateNarHashes(),
			generation: await narInfoGeneration(metadata.storePathHash),
			objectPresent:
				(await env.BLOBS.head(
					narInfoObjectKey(defaultTenant, metadata.storePathHash)
				)) !== null,
			blobPresent: (await env.BLOBS.head(narObjectKey(nar.narHash))) !== null
		}).toStrictEqual({
			markers: [],
			edges: [
				{
					tenant: 'v1',
					cache: '',
					storePathHash: metadata.storePathHash,
					generation: 1,
					narHash: nar.narHash
				}
			],
			tenantBlobs: [
				{
					tenant: 'v1',
					narHash: nar.narHash,
					fileSize: nar.narBytes.byteLength
				}
			],
			blobState: [{ narHash: nar.narHash }],
			generation: 1,
			objectPresent: true,
			blobPresent: true
		});
	});
});
