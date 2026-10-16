import { rootLogger } from '@cupboard/logger';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import {
	type UploadId,
	type UploadPathMetadata
} from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq, sql } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { firstVersionedObjectIncarnation } from '../blob/object-incarnation.ts';
import { resumeTenant } from '../control/tenant-registry.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { pendingUploads } from '../db/schema.ts';
import { narObjectKey, requestOriginSchema } from '../http/http.ts';
import { runScheduledMaintenance } from '../routing/scheduled.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	collectVerificationPasses,
	currentServer,
	deferFreshUpload,
	drainAttestationInheritance,
	flakyD1,
	initialise,
	namedCache,
	narBytes,
	pendingUploadVerdict,
	pushPath,
	putTestCache,
	readStoredNarInfo,
	resetTestServer,
	resolvedCache,
	suspendTenant,
	syntheticStorePathHash,
	takeStalledMaintenancePasses,
	tenantUsageRow,
	testBase,
	uploadMetadata,
	uploadStateOf,
	useTestServer,
	verificationOf,
	waitUntilReached,
	withoutAlarmArming
} from '../test-support.ts';

import { maintenanceRetryKey, noProgressRetryMs } from './alarm.ts';
import { boundedD1 } from './bounded-io.ts';
import { ServerContext } from './context.ts';
import { ReconcileQueueService } from './reconcile-queue-service.ts';
import { RetryClockService } from './retry-clock-service.ts';
import { type CupboardServer, maintenancePassCursorKey } from './server.ts';
import {
	subrequestsAvailable,
	withSubrequestSlice
} from './subrequest-slice.ts';
import {
	recordedVerdictCursorKey,
	type RecordedVerdictPage
} from './verification-service.ts';

// Both passes read `blob_state`. The reconcile probe reads the current NAR
// incarnation, and verdict application reserves the same row. A failure while
// reading this table stalls either pass.
const sharedBlobRowTable = 'blob_state';

const buildsCache = namedCache('builds');
const origin = requestOriginSchema.parse('https://cache.example');

const reconciledPath: UploadPathMetadata = uploadMetadata({
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
	await putTestCache(token, buildsCache);
	await collectVerificationPasses();
	await pushPath(token, reconciledPath, buildsCache);

	const upload = await deferFreshUpload(
		token,
		'retry-verdict',
		syntheticStorePathHash(701)
	);

	return runInDurableObject(currentServer(), async (instance, state) => {
		const cache = resolvedCache(instance.context, buildsCache);
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
			{ cacheId: cache.id, storePathHash: reconciledPath.storePathHash }
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
			if (pass === 'verdict-drain') {
				const row = local
					.select({ retryAfter: pendingUploads.settleRetryAfter })
					.from(pendingUploads)
					.where(eq(pendingUploads.id, upload.uploadId))
					.get();
				return row?.retryAfter == undefined
					? undefined
					: Date.parse(row.retryAfter) - Date.now();
			}

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
			local
				.update(pendingUploads)
				.set({ settleRetryAfter: isoTimestamp(new Date(elapsed)) })
				.where(eq(pendingUploads.id, upload.uploadId))
				.run();
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

type ParkedEnding = 'finish' | 'fail' | 'abort';

class ParkedVerdictFailure extends Error {
	constructor(public readonly uploadId: UploadId) {
		super(`The parked application of upload ${uploadId} failed.`);
		this.name = 'ParkedVerdictFailure';
	}
}

interface ParkedVerdict {
	readonly release: () => void;
	readonly finished: Promise<unknown>;
	readonly restore: () => void;
}

/**
 * Starts applying the recorded verdicts and parks the application of
 * `uploadId` until `release` is called. Applying a verdict first refreshes
 * the upload's NAR markers, so the application parks in that call. The alarm
 * refreshes every upload's markers without an upload ID, and a later
 * application of the same verdict does not park.
 *
 * With `fail`, the parked refresh throws when it is released, which the
 * application records as a failure of that verdict. With `abort`, releasing
 * aborts the application's signal, so the whole application throws.
 */
async function parkVerdict(
	instance: CupboardServer,
	uploadId: UploadId,
	ending: ParkedEnding = 'finish'
): Promise<ParkedVerdict> {
	const uploadState = uploadStateOf(instance);
	const refresh = uploadState.migratePendingNarRefreshMarkers.bind(uploadState);
	const started = Promise.withResolvers<undefined>();
	const release = Promise.withResolvers<undefined>();
	const abort = new AbortController();
	let isParked = false;
	const refreshSpy = vi
		.spyOn(uploadState, 'migratePendingNarRefreshMarkers')
		.mockImplementation(async (refreshed) => {
			if (refreshed === uploadId && !isParked) {
				isParked = true;
				started.resolve(undefined);
				await release.promise;

				if (ending === 'fail') {
					throw new ParkedVerdictFailure(uploadId);
				}
			}

			await refresh(refreshed);
		});
	const finished = verificationOf(instance).applyRecordedVerdicts(
		rootLogger(),
		abort.signal
	);
	await waitUntilReached(
		started.promise,
		finished,
		`the parked application of upload ${uploadId}`
	);

	return {
		release: () => {
			if (ending === 'abort') {
				abort.abort();
			}

			release.resolve(undefined);
		},
		finished,
		restore: () => {
			release.resolve(undefined);
			refreshSpy.mockRestore();
		}
	};
}

async function settlement(
	promise: Promise<unknown>
): Promise<'fulfilled' | 'rejected'> {
	try {
		await promise;

		return 'fulfilled';
	} catch {
		return 'rejected';
	}
}

// Records a verified verdict with the compressed hash and size of the staged
// NAR, so applying it promotes the upload.
function recordVerdict(
	storage: DurableObjectStorage,
	upload: {
		readonly uploadId: UploadId;
		readonly metadata: UploadPathMetadata;
	},
	owner: string
): void {
	drizzle(storage, { schema: { pendingUploads } })
		.update(pendingUploads)
		.set({
			recordedVerdictJson: JSON.stringify({
				owner,
				verdict: {
					kind: 'verified',
					verification: {
						ok: true,
						fileHash: upload.metadata.fileHash,
						fileSize: upload.metadata.fileSize
					}
				}
			})
		})
		.where(eq(pendingUploads.id, upload.uploadId))
		.run();
}

function uploadsWithRecordedVerdicts(
	storage: DurableObjectStorage,
	names: ReadonlyMap<string, string>
): string[] {
	return drizzle(storage, { schema: { pendingUploads } })
		.select({
			id: pendingUploads.id,
			recordedVerdictJson: pendingUploads.recordedVerdictJson
		})
		.from(pendingUploads)
		.all()
		.filter((row) => row.recordedVerdictJson !== null)
		.map((row) => names.get(row.id) ?? row.id)
		.toSorted(byCodeUnit);
}

// When the verdict drain was due as an alarm began, and what the alarm left
// behind.
interface ParkedAlarmObservation {
	readonly atMs: number;
	readonly verdictDrainDueInMs: number | undefined;
	readonly recorded: readonly string[];
	readonly verdictDrainWaitMs: number | undefined;
}

async function observeAlarm(
	instance: CupboardServer,
	storage: DurableObjectStorage,
	atMs: number,
	names: ReadonlyMap<string, string>
): Promise<ParkedAlarmObservation> {
	const dueAt = verificationOf(instance).recordedVerdictDueAt();
	const verdictDrainDueInMs =
		dueAt === undefined ? undefined : dueAt - Date.now();
	await storage.delete(maintenancePassCursorKey);
	await instance.alarm();

	const notBefore = await storage.get<number>(
		maintenanceRetryKey('verdict-drain')
	);

	return {
		atMs,
		verdictDrainDueInMs,
		recorded: uploadsWithRecordedVerdicts(storage, names),
		verdictDrainWaitMs:
			notBefore === undefined ? undefined : notBefore - Date.now()
	};
}

// The publication state of the named uploads. A promoted fresh upload leaves
// no pending row, and a mismatch keeps its row with the `mismatch` verdict.
// A new NAR is stored as its first numbered version, which the published
// narinfo's URL names.
async function publicationOutcome(
	uploads: ReadonlyMap<
		string,
		{ readonly uploadId: UploadId; readonly metadata: UploadPathMetadata }
	>
) {
	const pending: { name: string; verdict: string | null }[] = [];
	const publishedNarUrls: Record<string, string | undefined> = {};

	for (const [name, { uploadId, metadata }] of uploads) {
		const verdict = await pendingUploadVerdict(uploadId);

		if (verdict !== undefined) {
			pending.push({ name, verdict });
		}

		const { body } = await readStoredNarInfo(metadata.storePathHash);
		publishedNarUrls[name] = body
			.split('\n')
			.find((line) => line.startsWith('URL: '))
			?.slice('URL: '.length);
	}

	return {
		pending,
		publishedNarUrls,
		narinfos: await runInDurableObject(currentServer(), (instance) =>
			instance.context.db
				.select({ storePathHash: schema.narInfos.storePathHash })
				.from(schema.narInfos)
				.all()
				.map((row) => row.storePathHash)
				.toSorted(byCodeUnit)
		),
		usage: await tenantUsageRow()
	};
}

/**
 * Parks the application of one recorded verdict, records an unrelated ready
 * verdict, and runs alarms as time advances well past the no-progress retry
 * delay. The parked application continues only after the alarms have run.
 */
async function driveAlarmsAroundParkedVerdict(server: string) {
	await useTestServer(server);

	const token = await initialise();
	await collectVerificationPasses();

	const held = await deferFreshUpload(
		token,
		'retry-held',
		syntheticStorePathHash(704)
	);
	const ready = await deferFreshUpload(
		token,
		'retry-ready',
		syntheticStorePathHash(705)
	);
	const names = new Map([
		[held.uploadId, 'held'],
		[ready.uploadId, 'ready']
	]);

	const run = await runInDurableObject(
		currentServer(),
		async (instance, state) => {
			const claim = await instance.claimVerificationBatch(
				2,
				Number.MAX_SAFE_INTEGER
			);
			recordVerdict(state.storage, held, claim.owner);
			const startedAt = Date.now();
			const parked = await parkVerdict(instance, held.uploadId);

			try {
				recordVerdict(state.storage, ready, claim.owner);
				const alarms: ParkedAlarmObservation[] = [];

				for (const atMs of [0, noProgressRetryMs, 2 * noProgressRetryMs]) {
					vi.setSystemTime(startedAt + atMs);
					alarms.push(await observeAlarm(instance, state.storage, atMs, names));
				}

				parked.release();

				return {
					alarms,
					parkedOutcome: await settlement(parked.finished)
				};
			} finally {
				parked.restore();
			}
		}
	);

	return {
		...run,
		outcome: await publicationOutcome(
			new Map([
				['held', held],
				['ready', ready]
			])
		),
		storePathHashes: [held, ready]
			.map((upload) => upload.metadata.storePathHash)
			.toSorted(byCodeUnit),
		narHashes: { held: held.metadata.narHash, ready: ready.metadata.narHash },
		bytes: held.metadata.fileSize + ready.metadata.fileSize
	};
}

/**
 * Parks the application of one recorded verdict, ends it with `ending`, and
 * then runs alarms at once and after the no-progress retry delay.
 */
async function driveAlarmsAfterParkedFailure(
	server: string,
	ending: ParkedEnding
) {
	await useTestServer(server);

	const token = await initialise();
	await collectVerificationPasses();

	const held = await deferFreshUpload(
		token,
		'retry-failed-application',
		syntheticStorePathHash(708)
	);
	const names = new Map([[held.uploadId, 'held']]);

	const run = await runInDurableObject(
		currentServer(),
		async (instance, state) => {
			const claim = await instance.claimVerificationBatch(
				1,
				Number.MAX_SAFE_INTEGER
			);
			recordVerdict(state.storage, held, claim.owner);
			const startedAt = Date.now();
			const parked = await parkVerdict(instance, held.uploadId, ending);

			try {
				parked.release();
				const parkedOutcome = await settlement(parked.finished);
				const alarms: ParkedAlarmObservation[] = [];

				for (const atMs of [0, noProgressRetryMs]) {
					vi.setSystemTime(startedAt + atMs);
					alarms.push(await observeAlarm(instance, state.storage, atMs, names));
				}

				return { parkedOutcome, alarms };
			} finally {
				parked.restore();
			}
		}
	);

	return {
		...run,
		outcome: await publicationOutcome(new Map([['held', held]])),
		storePathHash: held.metadata.storePathHash,
		narHash: held.metadata.narHash,
		bytes: held.metadata.fileSize
	};
}

// What a verdict-drain alarm left behind after the page that it reported.
interface DrainDecision {
	readonly maintenanceCursor: string;
	readonly verdictDrainWaitMs: number | undefined;
}

/**
 * Runs one verdict-drain alarm while a recorded verdict is due, with the
 * verdict page replaced by `page`.
 */
async function driveDrainDecision(
	server: string,
	page: RecordedVerdictPage
): Promise<DrainDecision> {
	await useTestServer(server);

	const token = await initialise();
	await collectVerificationPasses();

	const upload = await deferFreshUpload(
		token,
		'retry-decision',
		syntheticStorePathHash(706)
	);

	return runInDurableObject(currentServer(), async (instance, state) => {
		const claim = await instance.claimVerificationBatch(
			1,
			Number.MAX_SAFE_INTEGER
		);
		recordVerdict(state.storage, upload, claim.owner);
		const applySpy = vi
			.spyOn(verificationOf(instance), 'applyRecordedVerdicts')
			.mockResolvedValueOnce(page);

		try {
			await state.storage.delete(maintenancePassCursorKey);
			await instance.alarm();
		} finally {
			applySpy.mockRestore();
		}

		const notBefore = await state.storage.get<number>(
			maintenanceRetryKey('verdict-drain')
		);

		return {
			maintenanceCursor:
				(await state.storage.get<string>(maintenancePassCursorKey)) ?? 'none',
			verdictDrainWaitMs:
				notBefore === undefined ? undefined : notBefore - Date.now()
		};
	});
}

describe('stalled maintenance passes', () => {
	beforeEach(resetTestServer);

	it('applies other verdicts while one is being applied, and never applies that one twice', async () => {
		const driven = await driveAlarmsAroundParkedVerdict(
			'maintenance-retry-held'
		);

		expect(driven).toStrictEqual({
			alarms: [
				{
					atMs: 0,
					verdictDrainDueInMs: 0,
					recorded: ['held'],
					verdictDrainWaitMs: undefined
				},
				{
					atMs: noProgressRetryMs,
					verdictDrainDueInMs: undefined,
					recorded: ['held'],
					verdictDrainWaitMs: undefined
				},
				{
					atMs: 2 * noProgressRetryMs,
					verdictDrainDueInMs: undefined,
					recorded: ['held'],
					verdictDrainWaitMs: undefined
				}
			],
			parkedOutcome: 'fulfilled',
			outcome: {
				pending: [],
				publishedNarUrls: {
					held: narObjectKey(
						driven.narHashes.held,
						firstVersionedObjectIncarnation
					),
					ready: narObjectKey(
						driven.narHashes.ready,
						firstVersionedObjectIncarnation
					)
				},
				narinfos: driven.storePathHashes,
				usage: {
					bytes: driven.bytes,
					narinfos: 2,
					blobs: 2,
					casBytes: 0,
					casBlobs: 0,
					quotaBytes: undefined
				}
			},
			storePathHashes: driven.storePathHashes,
			narHashes: driven.narHashes,
			bytes: driven.bytes
		});
	});

	// A failed verdict waits for its retry time. An aborted application leaves
	// its verdict due at once.
	it.each([
		{
			ending: 'fail',
			parkedOutcome: 'fulfilled',
			alarms: [
				{
					atMs: 0,
					verdictDrainDueInMs: noProgressRetryMs,
					recorded: ['held'],
					verdictDrainWaitMs: undefined
				},
				{
					atMs: noProgressRetryMs,
					verdictDrainDueInMs: 0,
					recorded: [],
					verdictDrainWaitMs: undefined
				}
			]
		},
		{
			ending: 'abort',
			parkedOutcome: 'rejected',
			alarms: [
				{
					atMs: 0,
					verdictDrainDueInMs: 0,
					recorded: [],
					verdictDrainWaitMs: undefined
				},
				{
					atMs: noProgressRetryMs,
					verdictDrainDueInMs: undefined,
					recorded: [],
					verdictDrainWaitMs: undefined
				}
			]
		}
	] as const)(
		'applies a verdict once after its application ends with $ending',
		async ({ ending, parkedOutcome, alarms }) => {
			const driven = await driveAlarmsAfterParkedFailure(
				`maintenance-retry-${ending}`,
				ending
			);

			expect(driven).toStrictEqual({
				parkedOutcome,
				alarms,
				outcome: {
					pending: [],
					publishedNarUrls: {
						held: narObjectKey(driven.narHash, firstVersionedObjectIncarnation)
					},
					narinfos: [driven.storePathHash],
					usage: {
						bytes: driven.bytes,
						narinfos: 1,
						blobs: 1,
						casBytes: 0,
						casBlobs: 0,
						quotaBytes: undefined
					}
				},
				storePathHash: driven.storePathHash,
				narHash: driven.narHash,
				bytes: driven.bytes
			});
		}
	);

	// The recorded verdict stays due after each page, so only the page decides
	// whether the drain stalls.
	it.each([
		{
			page: 'a failed verdict',
			beingApplied: 0,
			unresolved: 1,
			verdictDrainWaitMs: noProgressRetryMs,
			stalled: [{ pass: 'verdict-drain', waitMs: noProgressRetryMs }]
		},
		{
			page: 'a failed verdict beside one that is being applied',
			beingApplied: 1,
			unresolved: 1,
			verdictDrainWaitMs: noProgressRetryMs,
			stalled: [{ pass: 'verdict-drain', waitMs: noProgressRetryMs }]
		},
		{
			page: 'only verdicts that are being applied',
			beingApplied: 1,
			unresolved: 0,
			verdictDrainWaitMs: undefined,
			stalled: []
		}
	])(
		'decides whether the drain stalls after a page with $page',
		async ({ beingApplied, unresolved, verdictDrainWaitMs, stalled }) => {
			const decision = await driveDrainDecision('maintenance-retry-decision', {
				applied: 0,
				resolved: 0,
				unresolved,
				beingApplied
			});

			expect({
				...decision,
				stalled: await takeStalledMaintenancePasses()
			}).toStrictEqual({
				maintenanceCursor: 'verdict-drain',
				verdictDrainWaitMs,
				stalled
			});
		}
	);

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

describe('pre-existing retry clocks', () => {
	beforeEach(resetTestServer);

	it('expands the actual retry-clock migration without rewriting pre-existing tenants', async () => {
		const migration = env.TEST_MIGRATIONS.find(
			(candidate) => candidate.name === '0037_tenant_retry_clock.sql'
		);
		if (migration === undefined) {
			throw new Error('The retry clock migration must be registered');
		}
		await env.CUPBOARD_DB.batch([
			env.CUPBOARD_DB.prepare('DROP TRIGGER tenant_retry_clock_insert'),
			env.CUPBOARD_DB.prepare('DROP TRIGGER tenant_retry_clock_status'),
			env.CUPBOARD_DB.prepare(
				'ALTER TABLE tenant DROP COLUMN retry_active_since_ms'
			),
			env.CUPBOARD_DB.prepare(
				'ALTER TABLE tenant DROP COLUMN retry_active_elapsed_ms'
			)
		]);
		let isExpanded = false;
		try {
			await env.CUPBOARD_DB.batch(
				['active', 'suspended'].map((status) =>
					env.CUPBOARD_DB.prepare(
						"INSERT INTO tenant (id,status,owner_issuer,owner_subject,owner_audience,config_version,created_at) VALUES (?, ?, 'https://owner.example', 'owner', 'https://owner.example', 1, '2026-01-01T00:00:00.000Z')"
					).bind(`pre-existing-${status}`, status)
				)
			);
			const beforeQuery = await env.CUPBOARD_DB.prepare(
				'SELECT * FROM tenant ORDER BY id'
			).all();
			const before = beforeQuery.results.map((row) =>
				Object.fromEntries(
					Object.entries(row).map(([column, value]) => [
						column,
						value ?? undefined
					])
				)
			);
			await env.CUPBOARD_DB.batch(
				migration.queries.map((query) => env.CUPBOARD_DB.prepare(query))
			);
			isExpanded = true;
			const afterQuery = await env.CUPBOARD_DB.prepare(
				'SELECT * FROM tenant ORDER BY id'
			).all();
			const after = afterQuery.results.map((row) =>
				Object.fromEntries(
					Object.entries(row).map(([column, value]) => [
						column,
						value ?? undefined
					])
				)
			);
			expect(after).toStrictEqual(
				before.map((row) => ({
					...row,
					retry_active_elapsed_ms: 0,
					retry_active_since_ms: undefined
				}))
			);
		} finally {
			if (!isExpanded) {
				await env.CUPBOARD_DB.batch(
					migration.queries.map((query) => env.CUPBOARD_DB.prepare(query))
				);
			}
		}
	});

	it.each(['active', 'suspended'] as const)(
		'initialises a pre-existing %s tenant on first eligible read',
		async (status) => {
			await withoutAlarmArming(async () => {
				await initialise();
				const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
				await database
					.update(d1Schema.tenant)
					.set({ status })
					.where(eq(d1Schema.tenant.id, fixtureTenant));
				await database
					.update(d1Schema.tenant)
					.set({ retryActiveSinceMs: sql`null`, retryActiveElapsedMs: 5000 })
					.where(eq(d1Schema.tenant.id, fixtureTenant));
				const result = await runInDurableObject(
					currentServer(),
					async (instance) => {
						const service = new RetryClockService(instance.context);
						const first = await service.read();
						vi.setSystemTime(new Date(testBase.getTime() + 1000));
						const repeated = await service.read();
						const row = await database
							.select({
								elapsed: d1Schema.tenant.retryActiveElapsedMs,
								since: d1Schema.tenant.retryActiveSinceMs
							})
							.from(d1Schema.tenant)
							.where(eq(d1Schema.tenant.id, fixtureTenant))
							.get();
						return {
							first: first?.elapsedAt(testBase.getTime()),
							repeated: repeated?.elapsedAt(Date.now()),
							row:
								row === undefined
									? undefined
									: { ...row, since: row.since ?? undefined },
							blocked: service.isBlocked()
						};
					}
				);
				expect(result).toStrictEqual({
					first: 5000,
					repeated: status === 'active' ? 6000 : 5000,
					row: {
						elapsed: 5000,
						since: status === 'active' ? testBase.getTime() : undefined
					},
					blocked: status !== 'active'
				});
			});
		}
	);

	it.each([0, 1, 2, 3])(
		'reserves the first-read race budget in a slice of %i calls',
		async (subrequests) => {
			await withoutAlarmArming(async () => {
				await initialise();
				const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
				await database
					.update(d1Schema.tenant)
					.set({ retryActiveSinceMs: sql`null`, retryActiveElapsedMs: 5000 })
					.where(eq(d1Schema.tenant.id, fixtureTenant));
				const result = await runInDurableObject(
					currentServer(),
					async (instance) => {
						const measured = await withSubrequestSlice(
							async () => {
								const clock = await new RetryClockService(
									instance.context
								).read();
								return {
									elapsed: clock?.elapsedAt(Date.now()),
									remaining: subrequestsAvailable()
								};
							},
							{ subrequests, reserve: 0 }
						);
						const row = await database
							.select({ since: d1Schema.tenant.retryActiveSinceMs })
							.from(d1Schema.tenant)
							.where(eq(d1Schema.tenant.id, fixtureTenant))
							.get();
						return {
							...measured,
							row:
								row === undefined
									? undefined
									: { ...row, since: row.since ?? undefined }
						};
					}
				);
				expect(result).toStrictEqual({
					elapsed: subrequests === 3 ? 5000 : undefined,
					remaining:
						subrequests === 0 ? 0 : subrequests === 3 ? 1 : subrequests - 1,
					row: { since: subrequests === 3 ? testBase.getTime() : undefined }
				});
			});
		}
	);

	it.each([
		'unchanged',
		'suspended',
		'offboarding',
		'concurrent-reader'
	] as const)(
		'keeps first-read initialisation atomic when %s',
		async (race) => {
			await withoutAlarmArming(async () => {
				await initialise();
				const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
				await database
					.update(d1Schema.tenant)
					.set({ retryActiveSinceMs: sql`null`, retryActiveElapsedMs: 5000 })
					.where(eq(d1Schema.tenant.id, fixtureTenant));
				const result = await runInDurableObject(
					currentServer(),
					async (instance, state) => {
						const costs: { read: number; written: number }[] = [];
						const wrap = (
							statement: D1PreparedStatement,
							query: string
						): D1PreparedStatement =>
							new Proxy(statement, {
								get(source, field) {
									if (field === 'bind') {
										return (...values: unknown[]) =>
											wrap(source.bind(...values), query);
									}
									if (field === 'raw') {
										return async () => {
											if (
												race !== 'unchanged' &&
												query.startsWith('update "tenant"')
											) {
												await database
													.update(d1Schema.tenant)
													.set(
														race === 'concurrent-reader'
															? {
																	retryActiveSinceMs: testBase.getTime() - 1000
																}
															: { status: race }
													)
													.where(eq(d1Schema.tenant.id, fixtureTenant));
											}
											const response = await source.all();
											costs.push({
												read: response.meta.rows_read,
												written: response.meta.rows_written
											});
											return response.results.map((row) => Object.values(row));
										};
									}
									const value: unknown = Reflect.get(source, field, source);
									return typeof value === 'function'
										? (...arguments_: unknown[]): unknown =>
												Reflect.apply(value, source, arguments_)
										: value;
								}
							});
						const binding = new Proxy(env.CUPBOARD_DB, {
							get(target, field) {
								if (field === 'prepare') {
									return (query: string) => wrap(target.prepare(query), query);
								}
								const value: unknown = Reflect.get(target, field, target);
								return typeof value === 'function'
									? (...arguments_: unknown[]): unknown =>
											Reflect.apply(value, target, arguments_)
									: value;
							}
						});
						const context = new ServerContext(state, {
							...instance.context.env,
							CUPBOARD_DB: binding
						});
						const clock = await new RetryClockService(context).read();
						const row = await database
							.select({
								elapsed: d1Schema.tenant.retryActiveElapsedMs,
								since: d1Schema.tenant.retryActiveSinceMs
							})
							.from(d1Schema.tenant)
							.where(eq(d1Schema.tenant.id, fixtureTenant))
							.get();
						return {
							elapsed: clock?.elapsedAt(Date.now()),
							row:
								row === undefined
									? undefined
									: { ...row, since: row.since ?? undefined },
							blocked: new RetryClockService(context).isBlocked(),
							costs
						};
					}
				);
				expect(result).toStrictEqual({
					elapsed: race === 'concurrent-reader' ? 6000 : 5000,
					row: {
						elapsed: 5000,
						since:
							race === 'unchanged'
								? testBase.getTime()
								: race === 'concurrent-reader'
									? testBase.getTime() - 1000
									: undefined
					},
					blocked: race === 'suspended' || race === 'offboarding',
					costs:
						race === 'unchanged'
							? [
									{ read: 1, written: 0 },
									{ read: 2, written: 1 }
								]
							: [
									{ read: 1, written: 0 },
									{ read: 2, written: 0 },
									{ read: 1, written: 0 }
								]
				});
			});
		}
	);
});

describe('retry resumption after suspension', () => {
	beforeEach(resetTestServer);

	it.each(['recorded verdict', 'exhausted cleanup', 'inheritance'] as const)(
		'refreshes eligibility for %s through actual resume, cron and alarms',
		async (phase) => {
			await withoutAlarmArming(async () => {
				const token = await initialise();
				let uploadId: UploadId | undefined;
				if (phase === 'inheritance') {
					await pushPath(token, reconciledPath);
					await suspendTenant(fixtureTenant);
					await drainAttestationInheritance();
				} else {
					const upload = await deferFreshUpload(
						token,
						'resume-only',
						syntheticStorePathHash(704)
					);
					uploadId = upload.uploadId;
					const claim = await currentServer().claimVerificationBatch(
						1,
						Number.MAX_SAFE_INTEGER
					);
					await suspendTenant(fixtureTenant);
					await currentServer().recordVerifications(claim.owner, [
						{ uploadId, verdict: { kind: 'missing' } }
					]);
					if (phase === 'exhausted cleanup') {
						await runInDurableObject(currentServer(), (instance) => {
							instance.context.db
								.update(schema.pendingUploads)
								.set({
									recordedVerdictJson: sql`null`,
									claimOwner: sql`null`,
									claimedAt: sql`null`,
									settleFailures: 12,
									settleExhaustion: 'attempt-limit',
									settleRetryAfter: sql`null`
								})
								.where(eq(schema.pendingUploads.id, upload.uploadId))
								.run();
						});
					}
				}
				const paused = await runInDurableObject(currentServer(), (instance) =>
					instance.context.db.select().from(schema.retryEligibility).all()
				);
				expect(paused).toStrictEqual([{ id: 'tenant', isEligible: false }]);
				await resumeTenant(
					drizzleD1(env.CUPBOARD_DB, { schema: d1Schema }),
					fixtureTenant
				);
				await runScheduledMaintenance(
					() => currentServer().runGarbageCollection(),
					() => currentServer().runVerification()
				);
				for (let pass = 0; pass < 8; pass += 1) {
					await runInDurableObject(currentServer(), (instance) =>
						instance.alarm()
					);
				}
				const observed = await runInDurableObject(
					currentServer(),
					(instance) => {
						const stored =
							uploadId === undefined
								? undefined
								: instance.context.db
										.select({
											verdict: schema.pendingUploads.verdict,
											recorded: schema.pendingUploads.recordedVerdictJson,
											exhaustion: schema.pendingUploads.settleExhaustion,
											failures: schema.pendingUploads.settleFailures
										})
										.from(schema.pendingUploads)
										.where(eq(schema.pendingUploads.id, uploadId))
										.get();
						return {
							eligibility: instance.context.db
								.select()
								.from(schema.retryEligibility)
								.all(),
							upload:
								stored === undefined
									? undefined
									: {
											...stored,
											recorded: stored.recorded ?? undefined,
											exhaustion: stored.exhaustion ?? undefined
										},
							inheritance: instance.context.db
								.select({ attempts: schema.attestationInheritances.attempts })
								.from(schema.attestationInheritances)
								.all()
						};
					}
				);
				expect(observed).toStrictEqual({
					eligibility: [{ id: 'tenant', isEligible: true }],
					upload:
						phase === 'recorded verdict'
							? {
									verdict: 'mismatch',
									recorded: undefined,
									exhaustion: undefined,
									failures: 0
								}
							: undefined,
					inheritance: []
				});
			});
		}
	);
});
