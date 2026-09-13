import { rootLogger } from '@cupboard/logger';
import { env } from 'cloudflare:workers';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { promoteVerifiedBlob } from '../blob/promote-blob.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { narInfoObjectKey, r2ObjectKeySchema } from '../http/http.ts';
import { verifyTenant } from '../routing/scheduled.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	blobStateNarHashes,
	commitPath,
	currentNarObjectKey,
	currentServer,
	currentServerTenant,
	deferFreshUpload,
	expectSingleCommitDecision,
	expectSingleUploadDecision,
	initialise,
	markUploadPendingVerification,
	negotiateUploads,
	pendingUploadVerdict,
	putNarBytes,
	resetTestServer,
	testBase,
	uploadMetadata,
	verifiableNar,
	verifiablePath
} from '../test-support.ts';

// An older consumer can report `promoted` after it has written the canonical
// object and `blob_state` row. The current Durable Object must still record that
// verdict without repeating the promotion during a rolling deployment.
describe('recording an older promoted verdict', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(testBase);
		await resetTestServer();
	});

	it('settles the upload without re-promoting', async () => {
		const token = await initialise();
		const { metadata, nar } = await verifiablePath('promoted-verdict', {
			storePathHash: 'a'.repeat(32),
			name: 'promoted-verdict'
		});
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(upload.r2Key, nar);
		await markUploadPendingVerification(upload.uploadId);

		// Reproduce the shared writes an older queue consumer performed.
		const d1 = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
		await promoteVerifiedBlob(
			d1,
			env.BLOBS,
			r2ObjectKeySchema.parse(upload.r2Key),
			{ narHash: metadata.narHash, narSize: metadata.narSize },
			{ fileHash: nar.fileHash, fileSize: nar.narBytes.byteLength }
		);
		const promotedAt = new Date().toISOString();

		// A settle that promoted again would advance `verified_at` past this.
		vi.setSystemTime(new Date(testBase.getTime() + 60_000));
		const claim = await currentServer().claimVerificationBatch(
			10,
			Number.MAX_SAFE_INTEGER
		);

		const applied = await currentServer().recordVerifications(claim.owner, [
			{ uploadId: upload.uploadId, verdict: { kind: 'promoted' } }
		]);

		const blobState = await d1
			.select({
				narHash: d1Schema.blobState.narHash,
				verifiedAt: d1Schema.blobState.verifiedAt
			})
			.from(d1Schema.blobState)
			.all();

		expect({
			applied,
			verdict: await pendingUploadVerdict(upload.uploadId),
			servable:
				(await env.BLOBS.head(
					narInfoObjectKey(fixtureTenant, metadata.storePathHash, {
						kind: 'default'
					})
				)) !== null,
			stagingGone: (await env.BLOBS.head(upload.r2Key)) === null,
			blobState
		}).toStrictEqual({
			applied: 1,
			verdict: undefined,
			servable: true,
			stagingGone: true,
			blobState: [{ narHash: metadata.narHash, verifiedAt: promotedAt }]
		});
	});
});

// The queue consumer's pass end to end: it decodes and reports off the Durable
// Object thread. The Durable Object promotes only while it owns the claim.
describe('consumer verify pass', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(testBase);
		await resetTestServer();
	});

	it('records a fresh deferred upload through an owner-checked promotion', async () => {
		const token = await initialise();
		const { metadata, nar } = await verifiablePath('consumer-promotes', {
			storePathHash: 'a'.repeat(32),
			name: 'consumer-promotes'
		});
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(upload.r2Key, nar);
		await markUploadPendingVerification(upload.uploadId);

		await verifyTenant(rootLogger(), env, currentServerTenant(), 10);

		expect({
			verdict: await pendingUploadVerdict(upload.uploadId),
			blobState: await blobStateNarHashes(),
			servable:
				(await env.BLOBS.head(
					narInfoObjectKey(fixtureTenant, metadata.storePathHash, {
						kind: 'default'
					})
				)) !== null,
			stagingGone: (await env.BLOBS.head(upload.r2Key)) === null
		}).toStrictEqual({
			verdict: undefined,
			blobState: [{ narHash: metadata.narHash }],
			servable: true,
			stagingGone: true
		});
	});

	it('keeps the first upload complete when decoding the second upload fails', async () => {
		const token = await initialise();
		const first = await deferFreshUpload(token, 'progress-a', 'a'.repeat(32));
		const second = await deferFreshUpload(token, 'progress-b', 'b'.repeat(32));

		// The second upload's staging read fails before it produces a verdict. The
		// first upload's verdict was already recorded and remains complete.
		const originalGet = env.BLOBS.get.bind(env.BLOBS);
		const get = vi
			.spyOn(env.BLOBS, 'get')
			.mockImplementation((key, options) =>
				key === second.r2Key
					? Promise.reject(new Error('simulated staging outage'))
					: originalGet(key, options)
			);

		try {
			await verifyTenant(rootLogger(), env, currentServerTenant(), 10);
		} finally {
			get.mockRestore();
		}

		expect({
			first: await pendingUploadVerdict(first.uploadId),
			second: await pendingUploadVerdict(second.uploadId)
		}).toStrictEqual({ first: undefined, second: 'pending' });

		await verifyTenant(rootLogger(), env, currentServerTenant(), 10);

		expect({
			first: await pendingUploadVerdict(first.uploadId),
			second: await pendingUploadVerdict(second.uploadId)
		}).toStrictEqual({ first: undefined, second: undefined });
	});

	it('settles a deferred reuse row without reading any bytes', async () => {
		const token = await initialise();
		const nar = await verifiableNar('consumer-reuse');
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

		// A reuse claim may head the canonical object but must not fetch any object
		// body.
		const get = vi.spyOn(env.BLOBS, 'get');

		try {
			await verifyTenant(rootLogger(), env, currentServerTenant(), 10);
		} finally {
			get.mockRestore();
		}

		expect({
			reads: get.mock.calls.length,
			verdict: await pendingUploadVerdict(reuse.uploadId),
			servable:
				(await env.BLOBS.head(
					narInfoObjectKey(fixtureTenant, second.storePathHash, {
						kind: 'default'
					})
				)) !== null,
			canonicalPresent:
				(await env.BLOBS.head(await currentNarObjectKey(nar.narHash))) !== null
		}).toStrictEqual({
			reads: 0,
			verdict: undefined,
			servable: true,
			canonicalPresent: true
		});
	});

	it('clears a deferred reuse row when its canonical object is missing', async () => {
		const token = await initialise();
		const nar = await verifiableNar('reuse-vanished');
		const first = uploadMetadata({
			name: 'first',
			storePathHash: 'c'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});

		await commitPath(token, first, nar);

		const second = uploadMetadata({
			name: 'second',
			storePathHash: 'd'.repeat(32),
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

		// The object was collected between negotiation and this pass. The server must
		// record a terminal result and tell the waiter to upload it again.
		await env.BLOBS.delete(await currentNarObjectKey(nar.narHash));

		await verifyTenant(rootLogger(), env, currentServerTenant(), 10);

		expect({
			verdict: await pendingUploadVerdict(reuse.uploadId),
			servable:
				(await env.BLOBS.head(
					narInfoObjectKey(fixtureTenant, second.storePathHash, {
						kind: 'default'
					})
				)) !== null
		}).toStrictEqual({
			verdict: undefined,
			servable: false
		});
	});

	it('releases a reuse claim after a transient promotion fault', async () => {
		const token = await initialise();
		const nar = await verifiableNar('reuse-transient');
		const first = uploadMetadata({
			name: 'first',
			storePathHash: 'g'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});

		await commitPath(token, first, nar);

		const second = uploadMetadata({
			name: 'second',
			storePathHash: 'h'.repeat(32),
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

		// The promote's canonical head fails transiently; the pass abandons the
		// claim, and abandoning must free the lease so the next pass retries at
		// at once.
		const canonicalKey = await currentNarObjectKey(nar.narHash);
		const originalHead = env.BLOBS.head.bind(env.BLOBS);
		let shouldFail = true;
		const head = vi
			.spyOn(env.BLOBS, 'head')
			.mockImplementation(async (key: string) => {
				if (key === canonicalKey && shouldFail) {
					shouldFail = false;
					throw new Error('simulated canonical outage');
				}

				return originalHead(key);
			});

		try {
			await verifyTenant(rootLogger(), env, currentServerTenant(), 10);

			expect(await pendingUploadVerdict(reuse.uploadId)).toBe('pending');

			await verifyTenant(rootLogger(), env, currentServerTenant(), 10);
		} finally {
			head.mockRestore();
		}

		expect({
			verdict: await pendingUploadVerdict(reuse.uploadId),
			servable:
				(await env.BLOBS.head(
					narInfoObjectKey(fixtureTenant, second.storePathHash, {
						kind: 'default'
					})
				)) !== null
		}).toStrictEqual({
			verdict: undefined,
			servable: true
		});
	});
});
