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

describe('batched verify fault isolation', () => {
	beforeEach(resetTestServer);

	it('settles a sibling when another verdict fails and leaves the failed upload pending', async () => {
		const token = await initialise();
		const failing = await deferUpload(token, 'apply-fails', 'a'.repeat(32));
		const sibling = await deferUpload(token, 'apply-ok', 'b'.repeat(32));

		// Fail this upload's canonical write in both the consumer and the settle.
		// The consumer therefore reports a verified verdict, whose application also
		// fails, while the sibling can still settle.
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
			await verifyTenant(rootLogger(), env, currentServerTenant(), 10);
		} finally {
			put.mockRestore();
		}

		expect({
			sibling: await pendingUploadVerdict(sibling.uploadId),
			failing: await pendingUploadVerdict(failing.uploadId)
		}).toStrictEqual({
			sibling: undefined,
			failing: 'pending'
		});
	});

	it('keeps the Durable Object instance usable and the upload pending when D1 rejects inside the settle gate', async () => {
		const token = await initialise();
		const upload = await deferUpload(token, 'd1-fault', 'c'.repeat(32));

		// The runtime replaces a Durable Object whose gated callback throws. This
		// marker survives only if the current instance remains usable.
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
			await verifyTenant(rootLogger(), env, currentServerTenant(), 2);
		} finally {
			put.mockRestore();
		}

		expect({
			sent: sent.length,
			first: await pendingUploadVerdict(first.uploadId),
			second: await pendingUploadVerdict(second.uploadId)
		}).toStrictEqual({
			sent: 0,
			first: 'pending',
			second: 'pending'
		});
	});
});
