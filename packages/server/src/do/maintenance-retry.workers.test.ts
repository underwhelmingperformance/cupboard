import { cacheNameSchema } from '@cupboard/nix-store/scalars';
import { type ParsedUploadPathMetadata } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import { pendingUploads } from '../db/schema.ts';
import { requestOriginSchema } from '../http/http.ts';
import {
	collectVerificationPasses,
	currentServer,
	deferFreshUpload,
	flakyD1,
	initialise,
	narBytes,
	pushPath,
	resetTestServer,
	syntheticStorePathHash,
	testBase,
	uploadMetadata,
	useTestServer
} from '../test-support.ts';

import { maintenanceRetryKey, noProgressRetryMs } from './alarm.ts';
import { boundedD1 } from './bounded-io.ts';
import { ReconcileQueueService } from './reconcile-queue-service.ts';
import { maintenancePassCursorKey } from './server.ts';

// Both passes read `blob_state`. The reconcile probe reads the current NAR
// incarnation, and verdict application reserves the same row. A failure while
// reading this table stalls either pass.
const sharedBlobRowTable = 'blob_state';

const buildsCache = cacheNameSchema.parse('builds');
const origin = requestOriginSchema.parse('https://cache.example');

const reconciledPath: ParsedUploadPathMetadata = uploadMetadata({
	storePathHash: syntheticStorePathHash(700),
	name: 'retry-reconcile',
	fileSize: narBytes.byteLength
});

// The result of one alarm. `maintenanceCursor` identifies the last pass that ran.
// If the cursor remains unchanged, the alarm found no eligible pass. Each wait
// value reports the time until that pass becomes eligible again. An undefined
// value means the pass has not stalled, and a negative value means its deadline
// has passed.
interface AlarmObservation {
	readonly maintenanceCursor: string;
	readonly reconcileWaitMs: number | undefined;
	readonly verdictDrainWaitMs: number | undefined;
}

interface StalledPassRun {
	readonly alarms: readonly AlarmObservation[];
	readonly retryAlarmsSetByIdlePass: readonly number[];
}

/**
 * Gives two maintenance passes work that they cannot finish. The reconcile
 * target fails during its probe, and the upload fails while applying its
 * recorded verdict.
 *
 * Runs four alarms and reports, for each one, the maintenance cursor it left
 * and how long each of the two passes must still wait. The second pass starts
 * waiting one second after the first, so their retry deadlines differ. The
 * third alarm arrives while both passes are waiting; its calls to `setAlarm`
 * show which deadline the scheduler preserves. Before the fourth alarm the
 * fixture puts both deadlines in the past, which is the state the passes reach
 * once their wait is over.
 *
 * The Durable Object alarm scheduler keeps real time while this test freezes
 * `Date`, so reading the stored alarm would race its delivery. The test instead
 * records the deadlines passed to `setAlarm` during the third handler.
 */
async function driveStalledPasses(server: string): Promise<StalledPassRun> {
	await useTestServer(server);

	const token = await initialise();
	await collectVerificationPasses();
	await pushPath(token, reconciledPath, 'builds');

	const upload = await deferFreshUpload(
		token,
		'retry-verdict',
		syntheticStorePathHash(701)
	);

	return runInDurableObject(currentServer(), async (instance, state) => {
		const claim = await instance.claimVerificationBatch(
			1,
			Number.MAX_SAFE_INTEGER
		);
		const local = drizzle(state.storage, { schema: { pendingUploads } });

		// Record a verdict without applying it. The consumer RPC leaves this state
		// for the verdict-drain pass after an application failure.
		local
			.update(pendingUploads)
			.set({
				recordedVerdictJson: JSON.stringify({
					owner: claim.owner,
					verdict: { kind: 'promoted' }
				})
			})
			.where(eq(pendingUploads.id, upload.uploadId))
			.run();

		await new ReconcileQueueService(instance.context).enqueue(origin, [
			{ cache: buildsCache, storePathHash: reconciledPath.storePathHash }
		]);

		const real = instance.context.d1;

		const stalling = flakyD1(env.CUPBOARD_DB, {
			failures: Number.MAX_SAFE_INTEGER,
			matches: (query) => query.includes(sharedBlobRowTable)
		});

		Object.defineProperty(instance.context, 'd1', {
			configurable: true,
			value: drizzleD1(boundedD1(stalling), { schema: d1Schema })
		});

		const waitMs = async (pass: string): Promise<number | undefined> => {
			const notBefore = await state.storage.get<number>(
				maintenanceRetryKey(pass)
			);

			return notBefore === undefined ? undefined : notBefore - Date.now();
		};
		const prepareAlarmAttempt = async (attempt: number): Promise<void> => {
			if (attempt === 1) {
				vi.setSystemTime(new Date(Date.now() + 1000));

				return;
			}

			if (attempt !== 3) {
				return;
			}

			const elapsed = Date.now() - 1;
			await state.storage.put(maintenanceRetryKey('reconcile'), elapsed);
			await state.storage.put(maintenanceRetryKey('verdict-drain'), elapsed);
		};

		try {
			await state.storage.delete(maintenancePassCursorKey);

			const alarms: AlarmObservation[] = [];
			let retryAlarmsSetByIdlePass: readonly number[] = [];
			const retryDeadlines = new Set([
				testBase.getTime() + noProgressRetryMs,
				testBase.getTime() + 1000 + noProgressRetryMs
			]);

			for (let attempt = 0; attempt < 4; attempt += 1) {
				await prepareAlarmAttempt(attempt);

				await state.storage.deleteAlarm();
				const setAlarm = vi.spyOn(state.storage, 'setAlarm');

				try {
					await instance.alarm();
				} finally {
					if (attempt === 2) {
						retryAlarmsSetByIdlePass = setAlarm.mock.calls
							.map(([at]) => (at instanceof Date ? at.getTime() : at))
							.filter((at) => retryDeadlines.has(at));
					}

					setAlarm.mockRestore();
				}

				alarms.push({
					maintenanceCursor:
						(await state.storage.get<string>(maintenancePassCursorKey)) ??
						'none',
					reconcileWaitMs: await waitMs('reconcile'),
					verdictDrainWaitMs: await waitMs('verdict-drain')
				});
			}

			return { alarms, retryAlarmsSetByIdlePass };
		} finally {
			Object.defineProperty(instance.context, 'd1', {
				configurable: true,
				value: real
			});
		}
	});
}

describe('stalled maintenance passes', () => {
	beforeEach(resetTestServer);

	it('keeps each stalled pass ineligible and preserves the earliest retry deadline', async () => {
		const driven = await driveStalledPasses('maintenance-retry-stall');

		// The reconcile pass stalls during the first alarm and starts waiting. The
		// verdict-drain pass remains eligible, so the second alarm runs it and it
		// also stalls. The third alarm finds both passes ineligible and preserves
		// the earlier retry deadline.
		// Once the deadlines have passed, the fourth alarm gives the reconcile
		// pass its turn again.
		expect(driven).toStrictEqual({
			alarms: [
				{
					maintenanceCursor: 'reconcile',
					reconcileWaitMs: noProgressRetryMs,
					verdictDrainWaitMs: undefined
				},
				{
					maintenanceCursor: 'verdict-drain',
					reconcileWaitMs: noProgressRetryMs - 1000,
					verdictDrainWaitMs: noProgressRetryMs
				},
				{
					maintenanceCursor: 'verdict-drain',
					reconcileWaitMs: noProgressRetryMs - 1000,
					verdictDrainWaitMs: noProgressRetryMs
				},
				{
					maintenanceCursor: 'reconcile',
					reconcileWaitMs: noProgressRetryMs,
					verdictDrainWaitMs: -1
				}
			],
			retryAlarmsSetByIdlePass: [testBase.getTime() + noProgressRetryMs]
		});
	}, 240_000);
});
