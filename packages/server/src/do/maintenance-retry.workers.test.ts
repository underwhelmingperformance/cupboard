import { cacheNameSchema } from '@cupboard/nix-store/scalars';
import {
	type ParsedUploadPathMetadata,
	type UploadId
} from '@cupboard/protocol/upload';
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
	takeStalledMaintenancePasses,
	testBase,
	uploadMetadata,
	useTestServer
} from '../test-support.ts';

import { maintenanceRetryKey, noProgressRetryMs } from './alarm.ts';
import { boundedD1 } from './bounded-io.ts';
import { ReconcileQueueService } from './reconcile-queue-service.ts';
import { maintenancePassCursorKey } from './server.ts';
import { recordedVerdictCursorKey } from './verification-service.ts';

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

// What one verdict-drain pass left behind. `heldUploads` names the uploads whose
// verdict the pass did not apply, and `verdictDrainWaitMs` is the time the pass
// must wait before it may run again.
interface ConcurrentDrainRun {
	readonly heldUploads: readonly string[];
	readonly verdictDrainWaitMs: number | undefined;
}

/**
 * Runs one verdict-drain pass that applies every verdict in its page while a
 * commit records another verdict during the pass.
 *
 * The commit lands while the pass holds the page it read, so the number of held
 * verdicts is no lower when the pass ends than when it started. The pass
 * finished its page all the same, and must stay eligible so the next alarm
 * applies the verdict the commit recorded.
 */
async function driveDrainDuringCommit(
	server: string
): Promise<ConcurrentDrainRun> {
	await useTestServer(server);

	const token = await initialise();
	await collectVerificationPasses();

	const drained = await deferFreshUpload(
		token,
		'retry-drained',
		syntheticStorePathHash(702)
	);
	const recorded = await deferFreshUpload(
		token,
		'retry-recorded',
		syntheticStorePathHash(703)
	);

	return runInDurableObject(currentServer(), async (instance, state) => {
		const claim = await instance.claimVerificationBatch(
			2,
			Number.MAX_SAFE_INTEGER
		);
		const local = drizzle(state.storage, { schema: { pendingUploads } });
		const holdVerdict = (uploadId: UploadId): void => {
			local
				.update(pendingUploads)
				.set({
					recordedVerdictJson: JSON.stringify({
						owner: claim.owner,
						verdict: { kind: 'verified', verification: { ok: true } }
					})
				})
				.where(eq(pendingUploads.id, uploadId))
				.run();
		};

		holdVerdict(drained.uploadId);

		// The pass saves its cursor once it has read its page, so a verdict
		// recorded here arrives while the pass is applying that page.
		const storagePut = state.storage.put.bind(state.storage);
		Object.defineProperty(state.storage, 'put', {
			configurable: true,
			value: async (
				key: string,
				value: unknown,
				options?: DurableObjectPutOptions
			): Promise<void> => {
				if (key === recordedVerdictCursorKey) {
					holdVerdict(recorded.uploadId);
				}

				await storagePut(key, value, options);
			}
		});

		try {
			await state.storage.delete(maintenancePassCursorKey);
			await instance.alarm();
		} finally {
			Object.defineProperty(state.storage, 'put', {
				configurable: true,
				value: storagePut
			});
		}

		const names = new Map([
			[drained.uploadId, 'drained'],
			[recorded.uploadId, 'recorded']
		]);
		const heldUploads = local
			.select({
				id: pendingUploads.id,
				recordedVerdictJson: pendingUploads.recordedVerdictJson
			})
			.from(pendingUploads)
			.all()
			.filter((row) => row.recordedVerdictJson !== null)
			.map((row) => names.get(row.id) ?? row.id);
		const notBefore = await state.storage.get<number>(
			maintenanceRetryKey('verdict-drain')
		);

		return {
			heldUploads,
			verdictDrainWaitMs:
				notBefore === undefined ? undefined : notBefore - Date.now()
		};
	});
}

describe('stalled maintenance passes', () => {
	beforeEach(resetTestServer);

	it('keeps the verdict drain eligible when a commit records a verdict during a pass', async () => {
		const driven = await driveDrainDuringCommit('maintenance-retry-concurrent');

		// The pass applied the verdict it read and left only the verdict the
		// commit recorded during it. That verdict waits for the next alarm, so the
		// pass must carry no retry deadline.
		expect(driven).toStrictEqual({
			heldUploads: ['recorded'],
			verdictDrainWaitMs: undefined
		});
	});

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

		// This test ends with the reconcile pass parked on purpose, so take that
		// deadline here. The shared teardown fails the test for any deadline it
		// still finds.
		await expect(takeStalledMaintenancePasses()).resolves.toStrictEqual([
			{ pass: 'reconcile', waitMs: noProgressRetryMs }
		]);
	}, 240_000);
});
