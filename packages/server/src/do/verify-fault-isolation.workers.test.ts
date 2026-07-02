import { type NixSha256HashString } from '@cupboard/nix-store/scalars';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { narObjectKey } from '../http/http.ts';
import { verifyTenant } from '../routing/scheduled.ts';
import {
	collectVerificationPasses,
	currentServerTenant,
	expectSingleUploadDecision,
	initialise,
	markUploadPendingVerification,
	negotiateUploads,
	pendingUploadVerdict,
	putNarBytes,
	resetTestServer,
	verifiablePath
} from '../test-support.ts';

async function deferUpload(
	token: string,
	seed: string,
	storePathHash: string
): Promise<{ uploadId: string; narHash: NixSha256HashString }> {
	const { metadata, nar } = await verifiablePath(seed, {
		storePathHash,
		name: seed
	});
	const upload = expectSingleUploadDecision(
		await negotiateUploads(token, [metadata]),
		metadata
	);
	await putNarBytes(upload.r2Key, nar);
	await markUploadPendingVerification(upload.uploadId);

	return { uploadId: upload.uploadId, narHash: metadata.narHash };
}

// The batched `recordVerifications` settles a whole verify pass in one RPC. Its
// per-verdict try/catch is what keeps one upload's apply failure from aborting
// the rest of the batch or failing the queue message, the isolation the
// per-upload RPCs had. This drives a batch where one upload's promote fails while
// a sibling's succeeds.
describe('batched verify fault isolation', () => {
	beforeEach(resetTestServer);

	it('commits the siblings of a verdict whose apply fails, leaving it for retry', async () => {
		const token = await initialise();
		const failing = await deferUpload(token, 'apply-fails', 'a'.repeat(32));
		const sibling = await deferUpload(token, 'apply-ok', 'b'.repeat(32));

		// Fail only the failing upload's promote: its canonical object write
		// throws, while every other R2 write (including the sibling's) goes
		// through. The consumer's decode still succeeds; its own promote fails on
		// the same write, so it falls back to the plain verified verdict, and the
		// settle's promote then fails the apply.
		const failingKey = narObjectKey(failing.narHash);
		const originalPut = env.BLOBS.put.bind(env.BLOBS);
		const put = vi
			.spyOn(env.BLOBS, 'put')
			.mockImplementation((key, value, options) =>
				key === failingKey
					? Promise.reject(new Error('simulated promote outage'))
					: originalPut(key, value, options)
			);

		try {
			// The pass must not throw, so a poison verdict cannot fail and retry the
			// whole message.
			await verifyTenant(env, currentServerTenant(), 10);
		} finally {
			put.mockRestore();
		}

		expect({
			sibling: await pendingUploadVerdict(sibling.uploadId),
			failing: await pendingUploadVerdict(failing.uploadId)
		}).toStrictEqual({
			// The sibling settled and its row cleared; the failing upload is left
			// pending for the next pass.
			sibling: undefined,
			failing: 'pending'
		});
	});

	it('backs off without a continuation when a full batch applies nothing', async () => {
		const token = await initialise();
		const first = await deferUpload(token, 'all-fail-a', 'a'.repeat(32));
		const second = await deferUpload(token, 'all-fail-b', 'b'.repeat(32));

		// Every upload's promote fails, in the consumer (falling each verdict back
		// to plain verified) and again in the settle, so a full batch reaches the
		// apply step but settles nothing.
		const failingKeys = new Set([
			narObjectKey(first.narHash),
			narObjectKey(second.narHash)
		]);
		const originalPut = env.BLOBS.put.bind(env.BLOBS);
		const put = vi
			.spyOn(env.BLOBS, 'put')
			.mockImplementation((key, value, options) =>
				failingKeys.has(key)
					? Promise.reject(new Error('simulated promote outage'))
					: originalPut(key, value, options)
			);

		const sent = await collectVerificationPasses();

		try {
			// A full batch of two whose applies all fail: the gate sees claims equal to
			// the batch size but nothing applied.
			await verifyTenant(env, currentServerTenant(), 2);
		} finally {
			put.mockRestore();
		}

		expect({
			sent: sent.length,
			first: await pendingUploadVerdict(first.uploadId),
			second: await pendingUploadVerdict(second.uploadId)
		}).toStrictEqual({
			// Nothing applied, so the pass backs off to the cron and chains no
			// continuation that would re-claim and re-fail the same rows.
			sent: 0,
			first: 'pending',
			second: 'pending'
		});
	});
});
