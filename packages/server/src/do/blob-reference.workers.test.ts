import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { narInfoObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	blobReferenceRows,
	blobStateNarHashes,
	clearBlobStorage,
	commitPath,
	commitSharedPath,
	deletePath,
	initialise,
	narInfoGeneration,
	negotiateUploads,
	queueUnflushedNarInfoDeletion,
	reapBlobsPastGrace,
	resetTestServer,
	runGcResult,
	singleDecision,
	tenantBlobRows,
	uploadMetadata,
	verifiableNar
} from '../test-support.ts';

// `blob_ref`/`tenant_blob` are the D1 reference substrate: one edge per committed
// narinfo version (keyed by generation), and a per-tenant presence row per shared
// NAR hash. The single-tenant edges are written under tenant `v1`.

describe('blob_ref / tenant_blob reference edges', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		await resetTestServer();

		await clearBlobStorage();
	});

	it('tells a tenant to upload a hash it has no presence edge for, though the shared blob exists', async () => {
		const token = await initialise();
		const nar = await verifiableNar('oracle-safe');
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

		// Commit then delete the first path: its presence edge is gone, but the shared
		// `blob_state` fact and canonical object survive in the reaper grace. Negotiate
		// must still tell the tenant to upload the second path, never reuse on the
		// global fact, so it cannot learn the shared blob exists.
		await commitPath(token, first, nar);
		await deletePath(token, first.storePathHash);

		const decision = singleDecision(await negotiateUploads(token, [second]));

		expect({
			action: decision.action,
			sharedBlobs: await blobStateNarHashes(),
			presenceEdges: await tenantBlobRows()
		}).toStrictEqual({
			action: 'upload',
			sharedBlobs: [{ narHash: nar.narHash }],
			presenceEdges: []
		});
	});

	it('writes an edge at generation 0 and a tenant-blob presence row on commit', async () => {
		const token = await initialise();
		const nar = await verifiableNar('edge-first');
		const metadata = uploadMetadata({
			storePathHash: 'a'.repeat(32),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		await commitPath(token, metadata, nar);

		expect({
			edges: await blobReferenceRows(),
			tenantBlobs: await tenantBlobRows(),
			generation: await narInfoGeneration(metadata.storePathHash)
		}).toStrictEqual({
			edges: [
				{
					tenant: 'v1',
					cache: '',
					storePathHash: metadata.storePathHash,
					generation: 0,
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
			generation: 0
		});
	});

	it('removes the edge, the tenant-blob row and the shared fact on delete', async () => {
		const token = await initialise();
		const nar = await verifiableNar('edge-delete');
		const metadata = uploadMetadata({
			storePathHash: 'b'.repeat(32),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		await commitPath(token, metadata, nar);
		await deletePath(token, metadata.storePathHash);

		// The delete retires the edge and per-tenant presence at once; the now-
		// unreferenced shared fact is reclaimed by the reaper after its grace.
		await reapBlobsPastGrace();

		expect({
			edges: await blobReferenceRows(),
			tenantBlobs: await tenantBlobRows(),
			blobState: await blobStateNarHashes()
		}).toStrictEqual({ edges: [], tenantBlobs: [], blobState: [] });
	});

	it('advances the generation across a delete-then-recommit of the same NAR hash', async () => {
		const token = await initialise();
		const nar = await verifiableNar('regen');
		const metadata = uploadMetadata({
			storePathHash: 'c'.repeat(32),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		await commitPath(token, metadata, nar);
		await deletePath(token, metadata.storePathHash);
		// The delete drained this tenant's presence edge, so the recommit re-uploads
		// (oracle-safe negotiate) rather than reusing; the promote adopts the surviving
		// canonical object, and the generation advances past the deleted one.
		await commitPath(token, metadata, nar);

		// The replayed old-generation deletion can only have removed the old edge:
		// the recommit lands a strictly higher generation, so only it survives.
		expect({
			edges: await blobReferenceRows(),
			generation: await narInfoGeneration(metadata.storePathHash)
		}).toStrictEqual({
			edges: [
				{
					tenant: 'v1',
					cache: '',
					storePathHash: metadata.storePathHash,
					generation: 1,
					narHash: nar.narHash
				}
			],
			generation: 1
		});
	});

	it('charges a tenant-blob row once for two narinfos sharing a NAR hash and keeps it until the last edge goes', async () => {
		const token = await initialise();
		const nar = await verifiableNar('shared');
		const first = uploadMetadata({
			storePathHash: 'd'.repeat(32),
			name: 'first',
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		const second = uploadMetadata({
			storePathHash: 'f'.repeat(32),
			name: 'second',
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		await commitPath(token, first, nar);
		// The second path reuses the already-promoted blob (negotiate returns a
		// commit decision); only its edge is new.
		await commitSharedPath(token, second);

		const bothEdges = await blobReferenceRows();
		const afterBoth = {
			edges: bothEdges.map((edge) => edge.storePathHash),
			tenantBlobs: await tenantBlobRows()
		};

		await deletePath(token, first.storePathHash);
		const remainingEdges = await blobReferenceRows();
		const remainingTenantBlobs = await tenantBlobRows();
		const afterFirstDeleted = {
			edges: remainingEdges.map((edge) => edge.storePathHash),
			tenantBlobs: remainingTenantBlobs.length
		};

		await deletePath(token, second.storePathHash);
		const afterBothDeleted = {
			edges: await blobReferenceRows(),
			tenantBlobs: await tenantBlobRows()
		};

		expect({ afterBoth, afterFirstDeleted, afterBothDeleted }).toStrictEqual({
			afterBoth: {
				edges: [first.storePathHash, second.storePathHash],
				tenantBlobs: [
					{
						tenant: 'v1',
						narHash: nar.narHash,
						fileSize: nar.narBytes.byteLength
					}
				]
			},
			afterFirstDeleted: { edges: [second.storePathHash], tenantBlobs: 1 },
			afterBothDeleted: { edges: [], tenantBlobs: [] }
		});
	});

	it('flushes queued deletion rows for each captured generation', async () => {
		const token = await initialise();
		const nar = await verifiableNar('queued-generation-deletion');
		const metadata = uploadMetadata({
			storePathHash: 'g'.repeat(32),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		await commitPath(token, metadata, nar);
		await queueUnflushedNarInfoDeletion({
			storePathHash: metadata.storePathHash
		});
		await commitSharedPath(token, metadata);

		const beforeFlush = await blobReferenceRows();
		await deletePath(token, metadata.storePathHash);
		await runGcResult();

		expect({
			beforeFlush,
			edges: await blobReferenceRows(),
			tenantBlobs: await tenantBlobRows()
		}).toStrictEqual({
			beforeFlush: [
				{
					tenant: 'v1',
					cache: '',
					storePathHash: metadata.storePathHash,
					generation: 0,
					narHash: nar.narHash
				},
				{
					tenant: 'v1',
					cache: '',
					storePathHash: metadata.storePathHash,
					generation: 1,
					narHash: nar.narHash
				}
			],
			edges: [],
			tenantBlobs: []
		});
	});

	it('deletes a queued narinfo object before retiring its blob edge', async () => {
		const token = await initialise();
		const nar = await verifiableNar('queued-object-before-edge');
		const metadata = uploadMetadata({
			storePathHash: 'h'.repeat(32),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		await commitPath(token, metadata, nar);
		await queueUnflushedNarInfoDeletion({
			storePathHash: metadata.storePathHash
		});

		const objectKey = narInfoObjectKey(fixtureTenant, metadata.storePathHash);
		const deleteObject = env.BLOBS.delete.bind(env.BLOBS);
		let edgesAtObjectDelete:
			| Awaited<ReturnType<typeof blobReferenceRows>>
			| undefined;
		const deleteSpy = vi.spyOn(env.BLOBS, 'delete').mockImplementation((async (
			key: string
		) => {
			if (key === objectKey) {
				edgesAtObjectDelete = await blobReferenceRows();
			}

			return deleteObject(key);
		}) as typeof env.BLOBS.delete);

		try {
			await runGcResult();
		} finally {
			deleteSpy.mockRestore();
		}

		expect({
			edgesAtObjectDelete,
			afterReplay: {
				edges: await blobReferenceRows(),
				tenantBlobs: await tenantBlobRows()
			}
		}).toStrictEqual({
			edgesAtObjectDelete: [
				{
					tenant: fixtureTenant,
					cache: '',
					storePathHash: metadata.storePathHash,
					generation: 0,
					narHash: nar.narHash
				}
			],
			afterReplay: {
				edges: [],
				tenantBlobs: []
			}
		});
	});
});
