import {
	type NixSha256HashString,
	type StorePathHash
} from '@cupboard/nix-store/scalars';
import type { UploadId } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { pendingUploads } from '../db/schema.ts';
import { narInfoObjectKey, narObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	currentServer,
	expectSingleUploadDecision,
	fileHash,
	initialise,
	markUploadPendingVerification,
	narBytes,
	narInfoGeneration,
	negotiateUploads,
	pendingUploadSnapshot,
	putNarBytes,
	resetTestServer,
	uploadMetadata
} from '../test-support.ts';

async function deferredUpload(): Promise<{
	uploadId: UploadId;
	storePathHash: StorePathHash;
	narHash: NixSha256HashString;
}> {
	const token = await initialise();
	const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
	const upload = expectSingleUploadDecision(
		await negotiateUploads(token, [metadata]),
		metadata
	);

	await putNarBytes(upload.r2Key);
	await markUploadPendingVerification(upload.uploadId);

	// The canonical object exists, as it does when a promote ran before the row
	// settled terminally (an over-quota rejection follows a successful promote),
	// so a straggler's own promote finds it and would carry on to materialise.
	await putNarBytes(narObjectKey(metadata.narHash));

	return {
		uploadId: upload.uploadId,
		storePathHash: metadata.storePathHash,
		narHash: metadata.narHash
	};
}

async function narInfoObjectPresent(
	storePathHash: StorePathHash
): Promise<boolean> {
	const object = await env.BLOBS.head(
		narInfoObjectKey(fixtureTenant, storePathHash)
	);

	return object !== null;
}

// A terminal verdict is retained through its observation window, and verify
// passes may overlap, so a straggling verdict can land on a row another pass
// already settled. The terminal verdict is the authority: nothing may be
// reopened, reserved or served on the straggler's account.
describe('terminal verdicts against straggling verifications', () => {
	beforeEach(resetTestServer);

	it('leaves a settled row untouched by a straggling good verdict', async () => {
		const upload = await deferredUpload();

		await currentServer().recordVerification(upload.uploadId, {
			ok: false,
			reason: 'nar-hash-mismatch',
			actualNarHash: upload.narHash
		});
		const settled = await pendingUploadSnapshot(upload.uploadId);

		expect(settled).toStrictEqual({
			verdict: 'mismatch',
			expiresAt: expect.any(String) as string
		});

		await currentServer().recordVerification(upload.uploadId, {
			ok: true,
			fileHash: fileHash.value,
			fileSize: narBytes.byteLength
		});

		// The row survives byte-for-byte (a straggler must not even re-extend the
		// observation window), no narinfo row was reserved, nothing is served.
		expect({
			row: await pendingUploadSnapshot(upload.uploadId),
			generation: await narInfoGeneration(upload.storePathHash),
			object: await narInfoObjectPresent(upload.storePathHash)
		}).toStrictEqual({
			row: settled,
			generation: undefined,
			object: false
		});
	});

	it('stops a verification whose row turned terminal mid-apply', async () => {
		const upload = await deferredUpload();

		// Hold the straggler at its promote (the canonical head is its first R2
		// read, one-shot so the resumed apply proceeds) while a competing pass
		// settles the row terminally: the straggler passes the entry check on the
		// still-pending row, so only the gate's re-read can stop it. The whole
		// interleave runs inside the Durable Object so no promise crosses request
		// contexts.
		const canonicalKey = narObjectKey(upload.narHash);
		const settled = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const snapshot = (): unknown =>
					drizzle(state.storage, { schema: { pendingUploads } })
						.select({
							verdict: pendingUploads.verdict,
							expiresAt: pendingUploads.expiresAt
						})
						.from(pendingUploads)
						.where(eq(pendingUploads.id, upload.uploadId))
						.get();
				const originalHead = env.BLOBS.head.bind(env.BLOBS);
				const {
					promise: held,
					resolve: releaseHead
				}: PromiseWithResolvers<void> = Promise.withResolvers();
				const {
					promise: promoteReached,
					resolve: reachedPromote
				}: PromiseWithResolvers<void> = Promise.withResolvers();
				let isHolding = true;
				const head = vi
					.spyOn(env.BLOBS, 'head')
					.mockImplementation(async (key: string) => {
						if (key === canonicalKey && isHolding) {
							isHolding = false;
							reachedPromote();
							await held;
						}

						return originalHead(key);
					});

				try {
					const straggler = instance.recordVerification(upload.uploadId, {
						ok: true,
						fileHash: fileHash.value,
						fileSize: narBytes.byteLength
					});

					await promoteReached;
					await instance.recordVerification(upload.uploadId, {
						ok: false,
						reason: 'nar-hash-mismatch',
						actualNarHash: upload.narHash
					});
					const terminal = snapshot();

					releaseHead();
					await straggler;

					return terminal;
				} finally {
					head.mockRestore();
				}
			}
		);

		expect(settled).toStrictEqual({
			verdict: 'mismatch',
			expiresAt: expect.any(String) as string
		});
		expect({
			row: await pendingUploadSnapshot(upload.uploadId),
			generation: await narInfoGeneration(upload.storePathHash),
			object: await narInfoObjectPresent(upload.storePathHash)
		}).toStrictEqual({
			row: settled,
			generation: undefined,
			object: false
		});
	});
});
