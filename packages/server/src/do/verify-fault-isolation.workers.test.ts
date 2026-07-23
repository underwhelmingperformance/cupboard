import { rootLogger } from '@cupboard/logger';
import { type NixSha256HashString } from '@cupboard/nix-store/scalars';
import type { UploadId } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { narObjectKey } from '../http/http.ts';
import { OidcDiscoveryStore } from '../oidc/oidc.ts';
import { verifyTenant } from '../routing/scheduled.ts';
import {
	collectVerificationPasses,
	currentServer,
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
): Promise<{ uploadId: UploadId; narHash: NixSha256HashString }> {
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
			await verifyTenant(rootLogger(), env, currentServerTenant(), 10);
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

	it('survives a D1 fault inside the settle critical section', async () => {
		const token = await initialise();
		const upload = await deferUpload(token, 'd1-fault', 'c'.repeat(32));

		// An in-memory marker whose survival proves the instance was not broken:
		// the runtime replaces a broken object, and a fresh instance builds a
		// fresh discovery store.
		const marker = new OidcDiscoveryStore();
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.discovery = marker;
		});

		// Fail the D1 status re-check that runs inside the settle's critical
		// section. The runtime breaks the whole object when the gated callback
		// itself throws, so the fault must surface as an ordinary rejection the
		// caller's per-verdict isolation absorbs.
		const statusQuery = 'select "status" from "tenant"';
		const originalPrepare = env.CUPBOARD_DB.prepare.bind(env.CUPBOARD_DB);
		const prepare = vi
			.spyOn(env.CUPBOARD_DB, 'prepare')
			.mockImplementation((query) => {
				if (typeof query === 'string' && query.startsWith(statusQuery)) {
					throw new Error('simulated D1 outage');
				}

				return originalPrepare(query);
			});

		try {
			// The pass must not throw and must leave the upload for a retry.
			await verifyTenant(rootLogger(), env, currentServerTenant(), 10);
		} finally {
			prepare.mockRestore();
		}

		const isSameInstance = await runInDurableObject(
			currentServer(),
			(instance) => instance.context.discovery === marker
		);

		expect({
			verdict: await pendingUploadVerdict(upload.uploadId),
			isSameInstance
		}).toStrictEqual({ verdict: 'pending', isSameInstance: true });
	});

	it('settles uploads when the prefetch D1 batch faults and falls back to per-path probes', async () => {
		const token = await initialise();
		const upload = await deferUpload(token, 'prefetch-fault', 'a'.repeat(32));

		// Reject the first D1 batch call (the prefetch's blobState query) then
		// let subsequent calls through, so per-path probes succeed.
		const originalBatch = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const batch = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(() =>
				Promise.reject(new Error('simulated D1 prefetch fault'))
			)
			.mockImplementation(originalBatch);

		try {
			await currentServer().runVerification();
		} finally {
			batch.mockRestore();
		}

		// The pass degraded to per-path probes and still settled the upload.
		expect(await pendingUploadVerdict(upload.uploadId)).toBeUndefined();
	});

	it('backs off without a continuation when a full batch applies nothing', async () => {
		const token = await initialise();
		const first = await deferUpload(token, 'all-fail-a', 'a'.repeat(32));
		const second = await deferUpload(token, 'all-fail-b', 'b'.repeat(32));

		// Every upload's promote fails, in the consumer (falling each verdict back
		// to plain verified) and again in the settle, so a full batch reaches the
		// apply step but settles nothing.
		const failingKeys = new Set<string>([
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
			await verifyTenant(rootLogger(), env, currentServerTenant(), 2);
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
