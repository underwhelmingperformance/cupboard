import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { narInfoObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	collectVerificationPasses,
	commitPath,
	currentNarObjectKey,
	currentServer,
	deferFreshUpload,
	expectSingleCommitDecision,
	initialise,
	markUploadPendingVerification,
	negotiateUploads,
	pendingUploadVerdict,
	resetTestServer,
	uploadMetadata,
	verifiableNar
} from '../test-support.ts';

import {
	verifyBackstopDelayMs,
	verifyBackstopKey
} from './commit-pipeline-service.ts';

const request = { kind: 'tenant-verify', tenant: fixtureTenant };

async function backstopState(): Promise<{
	marker: number | undefined;
	alarm: number | null;
}> {
	return runInDurableObject(currentServer(), async (_instance, state) => ({
		marker: await state.storage.get<number>(verifyBackstopKey),
		alarm: await state.storage.getAlarm()
	}));
}

function fireAlarm(): Promise<void> {
	return runInDurableObject(currentServer(), (instance) => instance.alarm());
}

describe('verify alarm backstop', () => {
	// The runtime clamps a past alarm to the current time and fires it immediately.
	// Use a real current instant so no backstop fires unexpectedly during setup.
	let base: Date;

	beforeEach(async () => {
		// Fake timers can leak from an earlier suite in this isolate. Restore real
		// timers before reading the base time.
		vi.useRealTimers();
		base = new Date();
		vi.useFakeTimers();
		vi.setSystemTime(base);
		await resetTestServer();
	});

	it('arms a durable marker and the alarm on a verify request', async () => {
		await initialise();
		const sent = await collectVerificationPasses();

		await currentServer().requestVerificationPass();

		const dueAt = base.getTime() + verifyBackstopDelayMs;

		expect({ sent, ...(await backstopState()) }).toStrictEqual({
			sent: [request],
			marker: dueAt,
			alarm: dueAt
		});
	});

	it('routes scheduled fresh verification through the queue consumer', async () => {
		const token = await initialise();
		const upload = await deferFreshUpload(token, 'cron-queue', 'q'.repeat(32));
		const sent = await collectVerificationPasses();
		const originalGet = env.BLOBS.get.bind(env.BLOBS);
		const stagingReads: string[] = [];
		const get = vi
			.spyOn(env.BLOBS, 'get')
			.mockImplementation((key, options) => {
				if (key === upload.r2Key) {
					stagingReads.push(key);
				}

				return originalGet(key, options);
			});

		try {
			await currentServer().runVerification();
		} finally {
			get.mockRestore();
		}

		expect({
			sent,
			stagingReads,
			verdict: await pendingUploadVerdict(upload.uploadId)
		}).toStrictEqual({
			sent: [request],
			stagingReads: [],
			verdict: 'pending'
		});
	});

	it('never delays an already-set sooner alarm', async () => {
		await initialise();
		await collectVerificationPasses();

		const sooner = base.getTime() + 30_000;
		await runInDurableObject(currentServer(), (_instance, state) =>
			state.storage.setAlarm(sooner)
		);

		await currentServer().requestVerificationPass();

		expect(await backstopState()).toStrictEqual({
			marker: base.getTime() + verifyBackstopDelayMs,
			alarm: sooner
		});
	});

	it('re-arms without acting when fired before it is due', async () => {
		await initialise();
		const sent = await collectVerificationPasses();

		await currentServer().requestVerificationPass();

		vi.setSystemTime(new Date(base.getTime() + 10_000));
		await fireAlarm();

		const dueAt = base.getTime() + verifyBackstopDelayMs;

		expect({ sent, ...(await backstopState()) }).toStrictEqual({
			sent: [request],
			marker: dueAt,
			alarm: dueAt
		});
	});

	it('clears the marker when nothing is pending', async () => {
		await initialise();
		const sent = await collectVerificationPasses();

		await currentServer().requestVerificationPass();

		vi.setSystemTime(new Date(base.getTime() + verifyBackstopDelayMs));
		await fireAlarm();

		const { marker } = await backstopState();

		expect({ sent, marker }).toStrictEqual({
			sent: [request],
			marker: undefined
		});
	});

	it('re-requests a pass for pending rows once due', async () => {
		const token = await initialise();
		const sent = await collectVerificationPasses();

		await currentServer().requestVerificationPass();
		const upload = await deferFreshUpload(
			token,
			'backstop-fresh',
			'a'.repeat(32)
		);

		const firedAt = base.getTime() + verifyBackstopDelayMs;
		vi.setSystemTime(new Date(firedAt));
		await fireAlarm();

		const { marker } = await backstopState();

		expect({
			sent,
			verdict: await pendingUploadVerdict(upload.uploadId),
			marker
		}).toStrictEqual({
			sent: [request, request],
			verdict: 'pending',
			marker: firedAt + verifyBackstopDelayMs
		});
	});

	it('settles decode-free reuse rows locally once due', async () => {
		const token = await initialise();
		const nar = await verifiableNar('backstop-reuse');
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

		// Install the collector after the seeding commit because the commit also
		// sends verification requests. Those requests are unrelated to the backstop.
		const sent = await collectVerificationPasses();

		await currentServer().requestVerificationPass();

		vi.setSystemTime(new Date(base.getTime() + verifyBackstopDelayMs));
		await fireAlarm();

		expect({
			sent: sent.length,
			verdict: await pendingUploadVerdict(reuse.uploadId),
			servable:
				(await env.BLOBS.head(
					narInfoObjectKey(fixtureTenant, second.storePathHash, {
						kind: 'default'
					})
				)) !== null
		}).toStrictEqual({
			sent: 2,
			verdict: undefined,
			servable: true
		});
	});

	it('clears a pending reuse row when its canonical object is missing', async () => {
		const token = await initialise();
		const nar = await verifiableNar('backstop-reuse-vanished');
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
		await collectVerificationPasses();
		await currentServer().requestVerificationPass();

		// The object was collected before the backstop fired. The server must report
		// a terminal result to the waiter.
		await env.BLOBS.delete(await currentNarObjectKey(nar.narHash));

		vi.setSystemTime(new Date(base.getTime() + verifyBackstopDelayMs));
		await fireAlarm();

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

	it('does not settle a fresh row leased to a consumer', async () => {
		const token = await initialise();
		const upload = await deferFreshUpload(
			token,
			'backstop-fresh-claimed',
			'g'.repeat(32)
		);
		await collectVerificationPasses();

		// The consumer lease must exclude this row from the backstop pass.
		const claimed = await currentServer().claimVerificationBatch(
			10,
			Number.MAX_SAFE_INTEGER
		);
		await currentServer().requestVerificationPass();

		vi.setSystemTime(new Date(base.getTime() + verifyBackstopDelayMs));
		await fireAlarm();

		expect({
			claimed: claimed.claims.map((claim) => claim.uploadId),
			verdict: await pendingUploadVerdict(upload.uploadId)
		}).toStrictEqual({ claimed: [upload.uploadId], verdict: 'pending' });
	});
});
