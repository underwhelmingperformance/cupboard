import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { narInfoObjectKey, narObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	collectVerificationPasses,
	commitPath,
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
	// Request-armed alarms do not fire through `runDurableObjectAlarm` in this
	// pool, so the handler is driven directly.
	return runInDurableObject(currentServer(), (instance) => instance.alarm());
}

describe('verify alarm backstop', () => {
	// Anchored at the real current instant: the runtime clamps an alarm set in
	// the past to now and fires it at once, so a base in the past would have
	// every armed backstop auto-fire mid-test.
	let base: Date;

	beforeEach(async () => {
		// A mocked clock can leak in from an earlier suite in this isolate, so
		// the real instant is read only after restoring real timers.
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

		// Past the delay the request is stale, so the backstop's re-request is a
		// real send, and its arming starts the next cycle.
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
			// A fresh row never settles here: decode belongs to the queue consumer.
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

		// Installed after the seeding commit, whose own deferral traffic is not
		// under test here.
		const sent = await collectVerificationPasses();

		await currentServer().requestVerificationPass();

		vi.setSystemTime(new Date(base.getTime() + verifyBackstopDelayMs));
		await fireAlarm();

		expect({
			sent: sent.length,
			verdict: await pendingUploadVerdict(reuse.uploadId),
			servable:
				(await env.BLOBS.head(
					narInfoObjectKey(fixtureTenant, second.storePathHash)
				)) !== null
		}).toStrictEqual({
			sent: 2,
			verdict: undefined,
			servable: true
		});
	});

	it('answers absent for a reuse whose canonical object vanished', async () => {
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

		// The canonical object was collected before the backstop fired. It cannot
		// reappear, so the settle must answer the waiter terminally rather than
		// retry the same vanished object every firing.
		await env.BLOBS.delete(narObjectKey(nar.narHash));

		vi.setSystemTime(new Date(base.getTime() + verifyBackstopDelayMs));
		await fireAlarm();

		expect({
			verdict: await pendingUploadVerdict(reuse.uploadId),
			servable:
				(await env.BLOBS.head(
					narInfoObjectKey(fixtureTenant, second.storePathHash)
				)) !== null
		}).toStrictEqual({
			verdict: undefined,
			servable: false
		});
	});

	it('leaves reuse rows a consumer claim holds alone', async () => {
		const token = await initialise();
		const nar = await verifiableNar('backstop-reuse-claimed');
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
		await collectVerificationPasses();

		// A consumer pass holds the claim; the backstop's settle must stay off
		// its rows rather than race the in-flight promote.
		await currentServer().claimVerificationBatch(10, Number.MAX_SAFE_INTEGER);
		await currentServer().requestVerificationPass();

		vi.setSystemTime(new Date(base.getTime() + verifyBackstopDelayMs));
		await fireAlarm();

		expect(await pendingUploadVerdict(reuse.uploadId)).toBe('pending');
	});
});
