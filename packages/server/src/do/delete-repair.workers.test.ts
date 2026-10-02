import { env } from 'cloudflare:workers';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import { narInfoObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	blobReferenceRows,
	blobStateNarHashes,
	clearBlobStorage,
	commitPath,
	commitUpload,
	currentNarObjectKey,
	deleteBlobReferenceEdge,
	deleteNarInfoRow,
	deletePath,
	drainAttestationInheritance,
	initialise,
	narInfoDeletionRows,
	narInfoGeneration,
	negotiateUploads,
	putNarBytes,
	readFetch,
	reapBlobsPastGrace,
	resetTestServer,
	seedNarInfoDeletion,
	singleDecision,
	tenantBlobRows,
	uploadMetadata,
	verifiableNar
} from '../test-support.ts';

describe('delete marker replay', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		await resetTestServer();

		await clearBlobStorage();
	});

	it('finishes deletion after row removal when the edge and object remain', async () => {
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

		// Row removal queues the marker before the D1 edge and R2 object are
		// retired. Reproduce a crash at that boundary.
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
					narInfoObjectKey(fixtureTenant, metadata.storePathHash, {
						kind: 'default'
					})
				)) !== null
		}).toStrictEqual({
			markers: [],
			edges: [],
			tenantBlobs: [],
			blobState: [],
			objectPresent: false
		});
	});

	it('replays idempotently when the reference edge is already absent', async () => {
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
					narInfoObjectKey(fixtureTenant, metadata.storePathHash, {
						kind: 'default'
					})
				)) !== null
		}).toStrictEqual({
			markers: [],
			edges: [],
			tenantBlobs: [],
			blobState: [],
			objectPresent: false
		});
	});

	it('clears the marker when the row, edge and object are already absent', async () => {
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

		await deleteNarInfoRow(metadata.storePathHash);
		await deleteBlobReferenceEdge(metadata.storePathHash, 0);
		await env.BLOBS.delete(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash, {
				kind: 'default'
			})
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

	it('ignores a stale deletion marker after the path is recommitted', async () => {
		const token = await initialise();
		const nar = await verifiableNar('phase-recommit');
		const metadata = uploadMetadata({
			storePathHash: 'd'.repeat(32),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		// The deletion marker captures generation 0. Recommitting the same NAR
		// creates generation 1, which replay must leave servable.
		await commitPath(token, metadata, nar);
		await deletePath(token, metadata.storePathHash);
		await commitPath(token, metadata, nar);
		await seedNarInfoDeletion({
			storePathHash: metadata.storePathHash,
			narHash: nar.narHash,
			generation: 0
		});

		await drainAttestationInheritance();
		await reapBlobsPastGrace();

		expect({
			markers: await narInfoDeletionRows(),
			edges: await blobReferenceRows(),
			tenantBlobs: await tenantBlobRows(),
			blobState: await blobStateNarHashes(),
			generation: await narInfoGeneration(metadata.storePathHash),
			objectPresent:
				(await env.BLOBS.head(
					narInfoObjectKey(fixtureTenant, metadata.storePathHash, {
						kind: 'default'
					})
				)) !== null,
			blobPresent:
				(await env.BLOBS.head(await currentNarObjectKey(nar.narHash))) !== null
		}).toStrictEqual({
			markers: [],
			edges: [
				{
					tenant: 'v1',
					cache: { kind: 'default' },
					storePathHash: metadata.storePathHash,
					generation: 1,
					narHash: nar.narHash,
					cacheGeneration: 1
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

describe('explicit deletion', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		await resetTestServer();
		await clearBlobStorage();
	});

	it('stops serving a path while another upload of the same NAR is pending', async () => {
		const token = await initialise();
		const nar = await verifiableNar('delete-pending-recommit');
		const metadata = uploadMetadata({
			storePathHash: 'b'.repeat(32),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		const first = singleDecision(await negotiateUploads(token, [metadata]));
		const second = singleDecision(await negotiateUploads(token, [metadata]));

		if (first.action !== 'upload' || second.action !== 'upload') {
			throw new Error('both negotiations must plan an upload');
		}

		await putNarBytes(first.r2Key, nar);
		await commitUpload(token, first.uploadId);

		const deletion = await deletePath(token, metadata.storePathHash);
		const narInfo = await readFetch(`/${metadata.storePathHash}.narinfo`);

		expect({
			deletion,
			narInfoStatus: narInfo.status,
			edges: await blobReferenceRows(),
			authority: await drizzleD1(env.CUPBOARD_DB)
				.select({ generation: d1Schema.readableBlobReference.generation })
				.from(d1Schema.readableBlobReference)
		}).toStrictEqual({
			deletion: {
				storePathHash: metadata.storePathHash,
				deleted: true,
				narScheduledForDeletion: false
			},
			narInfoStatus: StatusCodes.NOT_FOUND,
			edges: [
				{
					tenant: 'v1',
					cache: { kind: 'default' },
					storePathHash: metadata.storePathHash,
					generation: 0,
					narHash: nar.narHash,
					cacheGeneration: 1
				}
			],
			authority: []
		});

		await putNarBytes(second.r2Key, nar);
		await commitUpload(token, second.uploadId);
		await drainAttestationInheritance();
		await reapBlobsPastGrace();

		const recommittedNarInfo = await readFetch(
			`/${metadata.storePathHash}.narinfo`
		);
		expect({
			markers: await narInfoDeletionRows(),
			edges: await blobReferenceRows(),
			authority: await drizzleD1(env.CUPBOARD_DB)
				.select({ generation: d1Schema.readableBlobReference.generation })
				.from(d1Schema.readableBlobReference),
			narInfoStatus: recommittedNarInfo.status
		}).toStrictEqual({
			markers: [],
			edges: [
				{
					tenant: 'v1',
					cache: { kind: 'default' },
					storePathHash: metadata.storePathHash,
					generation: 1,
					narHash: nar.narHash,
					cacheGeneration: 1
				}
			],
			authority: [{ generation: 1 }],
			narInfoStatus: StatusCodes.OK
		});
	});
});
