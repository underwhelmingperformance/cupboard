import { signingKeyGenerationSchema } from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { type UploadPathMetadata } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq, ne, sql } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CacheId } from '../db/cache.ts';
import * as d1Schema from '../db/d1-schema.ts';
import {
	cachePurgeContinuations,
	narInfoDeletions,
	narInfos,
	pendingUploads,
	signingKeyBackfills,
	signingKeys
} from '../db/schema.ts';
import {
	d1StatementsPerInvocation,
	narInfoObjectKey,
	requestOriginSchema
} from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	authorisedFetch,
	bootstrap,
	collectVerificationPasses,
	commitPath,
	countingD1,
	currentServer,
	expectSingleCommitDecision,
	flakyR2,
	initialise,
	type MeasuredInvocation,
	measureInvocations,
	namedCache,
	narBytes,
	negotiateUploads,
	pushPath,
	resetTestServer,
	resolvedCache,
	syntheticStorePathHash,
	uploadMetadata,
	useTestServer,
	verifiableNar
} from '../test-support.ts';

import { boundedD1 } from './bounded-io.ts';
import { teardownEntryPrefix } from './cache-admin-service.ts';
import { verifyBackstopKey } from './commit-pipeline-service.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';
import {
	maxPathsReconciledPerRun,
	ReconcileQueueService
} from './reconcile-queue-service.ts';
import {
	gcContinuationKey,
	maintenancePassCursorKey,
	verifyBackstopReuseSettleLimit
} from './server.ts';
import { backfillEntriesPerPass } from './signing-keys-service.ts';

const buildsCache = namedCache('builds');
const origin = requestOriginSchema.parse('https://cache.example');
const storePathAlphabet = '0123456789abcdfghijklmnpqrsvwxyz';

// A Durable Object may hold six outgoing connections at once, so push in groups
// of that size to fill a large cache without queueing behind the cap.
const pushConcurrency = 6;

// More paths than one teardown pass can retire, so the drain stops on its
// statement allowance and later alarms have to resume it.
const committedPaths = 360;

// The scope a bounded collection pass leaves behind when it runs out of
// allowance.
const collectLimit = 100;

type AlarmObservation = MeasuredInvocation<{
	readonly pass: string;
	readonly queuedDeletions: number;
}>;

// Returns the maintenance pass recorded in the alarm cursor.
async function currentMaintenancePass(
	state: DurableObjectState
): Promise<string> {
	return (await state.storage.get<string>(maintenancePassCursorKey)) ?? 'none';
}

function indexedMetadata(index: number): UploadPathMetadata {
	const suffix =
		storePathAlphabet.charAt(Math.floor(index / 32)) +
		storePathAlphabet.charAt(index % 32);

	return uploadMetadata({
		storePathHash: `${'0'.repeat(30)}${suffix}`,
		name: `path-${suffix}`,
		fileSize: narBytes.byteLength
	});
}

async function publishCommittedPaths(server: string): Promise<void> {
	await useTestServer(server);

	const { token } = await bootstrap({ caches: [{ scope: buildsCache }] });

	for (let start = 0; start < committedPaths; start += pushConcurrency) {
		await Promise.all(
			Array.from({ length: pushConcurrency }, (_, offset) =>
				pushPath(token, indexedMetadata(start + offset), buildsCache)
			)
		);
	}
}

/**
 * Deletes the cache, leaves a garbage-collection continuation beside the
 * teardown backlog, and runs alarms until both are drained. Reports the D1
 * statement count, maintenance pass, and queued deletion count for each alarm.
 *
 * The alarms are complete handler calls, measured under the input gate.
 */
async function driveAlarms(
	server: string,
	maxAlarms: number
): Promise<{
	readonly alarms: readonly AlarmObservation[];
	readonly teardownPending: unknown;
	readonly collectionPending: unknown;
	readonly queuedDeletions: number;
}> {
	await publishCommittedPaths(server);

	const counting = countingD1(env.CUPBOARD_DB);

	return runInDurableObject(currentServer(), async (instance, state) => {
		const real = instance.context.d1;

		Object.defineProperty(instance.context, 'd1', {
			configurable: true,
			value: drizzleD1(boundedD1(counting.binding), { schema: d1Schema })
		});

		const cache = resolvedCache(instance.context, buildsCache);
		await instance.runCacheTeardown(buildsCache, origin);
		await state.storage.put(gcContinuationKey, [
			{ scope: 'tenant', collectLimit }
		]);

		const teardownKey = `${teardownEntryPrefix}${String(cache.id)}`;
		const queueDepth = (): number =>
			drizzle(state.storage, { schema: { narInfoDeletions } })
				.select({ storePathHash: narInfoDeletions.storePathHash })
				.from(narInfoDeletions)
				.all().length;

		const alarms = await measureInvocations(state, counting, {
			attempts: maxAlarms,
			// Filling the cache runs alarms of its own, which leave the maintenance
			// pass cursor wherever they finished. This fixture asserts which pass
			// each alarm runs, so start the rotation from the first pass.
			prepare: () => state.storage.delete(maintenancePassCursorKey),
			isDue: async () =>
				(await state.storage.get(teardownKey)) !== undefined ||
				(await state.storage.get(gcContinuationKey)) !== undefined,
			run: async () => {
				const queuedDeletions = queueDepth();
				await instance.alarm();

				return {
					pass: await currentMaintenancePass(state),
					queuedDeletions
				};
			}
		});

		Object.defineProperty(instance.context, 'd1', {
			configurable: true,
			value: real
		});

		return {
			alarms,
			teardownPending: await state.storage.get(teardownKey),
			collectionPending: await state.storage.get(gcContinuationKey),
			queuedDeletions: queueDepth()
		};
	});
}

describe('alarm D1 statement allowance', () => {
	beforeEach(resetTestServer);

	it('keeps teardown and garbage-collection alarms within the 50-statement D1 limit', async () => {
		const driven = await driveAlarms('alarm-allowance-cap', 12);

		// A teardown drain and a collection pass each size their page for a whole
		// invocation, so an alarm that runs both together would exceed the limit.
		// Counting whole invocations means a costlier pass fails here instead of
		// on Workers Free.
		//
		// The first alarm issues 44 statements: one to invalidate maintenance
		// eligibility, six for each of seven retirement chunks, and one to
		// reconcile eligibility afterwards. Each later count depends on the rows
		// processed earlier, so assert only that it does not exceed the allowance.
		expect({
			queuedDeletionsAtFirstAlarm: driven.alarms[0]?.queuedDeletions,
			firstAlarmStatements: driven.alarms[0]?.statements,
			overAllowanceAlarms: driven.alarms.filter(
				(alarm) => alarm.statements > d1StatementsPerInvocation
			),
			statementAllowance: d1StatementsPerInvocation,
			passes: [...new Set(driven.alarms.map((alarm) => alarm.pass))].toSorted(
				byCodeUnit
			),
			teardownPending: driven.teardownPending,
			collectionPending: driven.collectionPending,
			queuedDeletions: driven.queuedDeletions
		}).toStrictEqual({
			queuedDeletionsAtFirstAlarm: committedPaths,
			firstAlarmStatements: 44,
			overAllowanceAlarms: [],
			statementAllowance: 50,
			// Only teardown and garbage collection are due in this fixture. Any
			// other value identifies unrelated maintenance work that ran during the
			// alarm loop.
			passes: ['garbage-collection', 'teardown'],
			teardownPending: undefined,
			collectionPending: undefined,
			queuedDeletions: 0
		});
	}, 240_000);

	it('finishes both the teardown backlog and the collection continuation across successive alarms', async () => {
		const driven = await driveAlarms('alarm-allowance-fairness', 12);

		// Each alarm starts its search after the maintenance pass recorded by the
		// previous alarm, so garbage collection runs before teardown finishes.
		// Given 360 queued deletions and the configured pass limits, both work
		// sources complete in the three alarms asserted below.
		expect({
			queuedDeletionsAtFirstAlarm: driven.alarms[0]?.queuedDeletions,
			passes: driven.alarms.map((alarm) => alarm.pass),
			teardownPending: driven.teardownPending,
			collectionPending: driven.collectionPending,
			queuedDeletions: driven.queuedDeletions
		}).toStrictEqual({
			queuedDeletionsAtFirstAlarm: committedPaths,
			passes: ['teardown', 'garbage-collection', 'teardown'],
			teardownPending: undefined,
			collectionPending: undefined,
			queuedDeletions: 0
		});
	}, 240_000);
});

// More queued reconcile targets than one pass can probe within its statement
// allowance, so the queue only drains across successive alarms.
const reconciledPaths = 100;

// The fixture removes this many published narinfo objects before it queues the
// paths. Each missing object requires two repair statements after the probe.
const brokenNarInfoObjects = 6;

// More deferred rows than one backstop pass settles, so the pass limit applies
// and later alarms have to settle the rest.
const deferredReuseRows = 8;

type ReconcileAlarmObservation = MeasuredInvocation<{
	readonly pass: string;
	readonly queuedTargets: number;
}>;

type BackstopAlarmObservation = MeasuredInvocation<{
	readonly pass: string;
	readonly pendingRows: number;
}>;

/**
 * Commits `reconciledPaths` paths and returns their metadata. The caller queues
 * them for reconciliation itself.
 */
async function commitReconcilePaths(
	server: string
): Promise<readonly UploadPathMetadata[]> {
	await useTestServer(server);

	const { token } = await bootstrap({ caches: [{ scope: buildsCache }] });
	const paths = Array.from({ length: reconciledPaths }, (_, index) =>
		indexedMetadata(index)
	);

	for (let start = 0; start < reconciledPaths; start += pushConcurrency) {
		await Promise.all(
			paths
				.slice(start, start + pushConcurrency)
				.map((metadata) => pushPath(token, metadata, buildsCache))
		);
	}

	return paths;
}

/**
 * Queues every committed path for reconciliation and removes the published
 * narinfo object of the first `brokenNarInfoObjects` of them, so the queue holds
 * both healthy targets and targets that need a repair.
 *
 * A negotiation also queues these targets and arms an alarm. That alarm could
 * run before the fixture removes the objects or counts the queue. The caller
 * therefore queues the targets while it holds the input gate, then measures the
 * same queue state that the manual alarms receive.
 */
async function queueReconcileTargets(
	queue: ReconcileQueueService,
	cacheId: CacheId,
	paths: readonly UploadPathMetadata[]
): Promise<void> {
	for (const metadata of paths.slice(0, brokenNarInfoObjects)) {
		await env.BLOBS.delete(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash, buildsCache)
		);
	}

	await queue.enqueue(
		origin,
		paths.map((metadata) => ({
			cacheId,
			storePathHash: metadata.storePathHash
		}))
	);
}

/**
 * Runs alarms until the reconcile queue drains, and reports the D1 statement
 * count, maintenance pass and queue depth of each one.
 *
 * The alarms are complete handler calls, measured under the input gate.
 */
async function driveReconcileAlarms(
	server: string,
	maxAlarms: number
): Promise<{
	readonly alarms: readonly ReconcileAlarmObservation[];
	readonly queuedTargets: number;
	readonly restoredObjects: number;
}> {
	const paths = await commitReconcilePaths(server);

	const counting = countingD1(env.CUPBOARD_DB);

	const driven = await runInDurableObject(
		currentServer(),
		async (instance, state) => {
			const real = instance.context.d1;

			Object.defineProperty(instance.context, 'd1', {
				configurable: true,
				value: drizzleD1(boundedD1(counting.binding), { schema: d1Schema })
			});

			const queue = new ReconcileQueueService(instance.context);
			const cache = resolvedCache(instance.context, buildsCache);
			const queueDepth = async (): Promise<number> => {
				const queuedTargets = await queue.claimChunk(reconciledPaths + 1);

				return queuedTargets.size;
			};

			const alarms = await measureInvocations(state, counting, {
				attempts: maxAlarms,
				prepare: () => queueReconcileTargets(queue, cache.id, paths),
				isDue: () => queue.hasPending(),
				run: async () => {
					const queuedTargets = await queueDepth();
					await instance.alarm();

					return {
						pass: await currentMaintenancePass(state),
						queuedTargets
					};
				}
			});

			Object.defineProperty(instance.context, 'd1', {
				configurable: true,
				value: real
			});

			return { alarms, queuedTargets: await queueDepth() };
		}
	);

	const restored = await Promise.all(
		Array.from({ length: brokenNarInfoObjects }, (_, index) =>
			env.BLOBS.head(
				narInfoObjectKey(
					fixtureTenant,
					indexedMetadata(index).storePathHash,
					buildsCache
				)
			)
		)
	);

	return {
		...driven,
		restoredObjects: restored.filter((object) => object !== null).length
	};
}

/**
 * Commits one path, then negotiates `deferredReuseRows` further paths that reuse
 * its NAR. Each negotiation leaves an uncommitted row, which the caller marks as
 * pending. The backstop settles these rows from the committed NAR without
 * decoding it again.
 */
async function queueBackstopReuseRows(server: string): Promise<void> {
	await useTestServer(server);

	const token = await initialise();
	const nar = await verifiableNar('backstop-reuse');
	const committed = uploadMetadata({
		name: 'canonical',
		storePathHash: 'a'.repeat(32),
		narHash: nar.narHash,
		fileHash: nar.fileHash,
		fileSize: nar.narBytes.byteLength,
		narSize: nar.narSize
	});

	await commitPath(token, committed, nar);

	// Record follow-up verification requests instead of sending them to a real
	// queue.
	await collectVerificationPasses();

	for (let index = 0; index < deferredReuseRows; index += 1) {
		const metadata = uploadMetadata({
			name: `reuse-${String(index)}`,
			storePathHash: syntheticStorePathHash(index),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});
		expectSingleCommitDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
	}
}

/**
 * Defers every negotiated row, marks the backstop deadline past, and runs alarms
 * until the backstop settles them. Reports the D1 statement count, maintenance
 * pass and remaining row count of each alarm.
 *
 * The deferral, the deadline and the alarm loop share one Durable Object
 * invocation. An armed alarm is delivered at any await between them, and a
 * backstop pass that ran there would settle the rows before the loop observed
 * them.
 */
async function driveBackstopAlarms(
	server: string,
	maxAlarms: number
): Promise<{
	readonly alarms: readonly BackstopAlarmObservation[];
	readonly pendingRows: number;
}> {
	await queueBackstopReuseRows(server);
	const counting = countingD1(env.CUPBOARD_DB);

	return runInDurableObject(currentServer(), async (instance, state) => {
		const real = instance.context.d1;

		Object.defineProperty(instance.context, 'd1', {
			configurable: true,
			value: drizzleD1(boundedD1(counting.binding), { schema: d1Schema })
		});

		const pendingDepth = (): number =>
			drizzle(state.storage, { schema: { pendingUploads } })
				.select({ id: pendingUploads.id })
				.from(pendingUploads)
				.all().length;

		const alarms = await measureInvocations(state, counting, {
			attempts: maxAlarms,
			prepare: () => {
				drizzle(state.storage, { schema: { pendingUploads } })
					.update(pendingUploads)
					.set({ verdict: 'pending' })
					.run();
			},
			isDue: () => pendingDepth() > 0,
			run: async () => {
				// Asking the queue for another verification pass postpones the
				// backstop deadline by a minute. Put the deadline back in the past
				// before each manual alarm, to reproduce the due state in which the
				// scheduler invokes the pass.
				await state.storage.put(verifyBackstopKey, Date.now() - 1);

				const pendingRows = pendingDepth();
				await instance.alarm();

				return { pass: await currentMaintenancePass(state), pendingRows };
			}
		});

		Object.defineProperty(instance.context, 'd1', {
			configurable: true,
			value: real
		});

		return { alarms, pendingRows: pendingDepth() };
	});
}

describe('reconcile alarm D1 statement allowance', () => {
	beforeEach(resetTestServer);

	it('keeps every reconcile alarm within the 50-statement D1 limit', async () => {
		const driven = await driveReconcileAlarms('alarm-allowance-reconcile', 12);

		// The first alarm spends 49 of the 50 statements: one to invalidate
		// maintenance eligibility, 38 for the probes, one for the committed
		// reference edge query, eight to restore four objects, and one to reconcile
		// eligibility afterwards. Earlier repairs change the later statement counts,
		// so assert only that every later alarm stays within the allowance.
		expect({
			queuedAtFirstAlarm: driven.alarms[0]?.queuedTargets,
			firstAlarmStatements: driven.alarms[0]?.statements,
			overAllowanceAlarms: driven.alarms.filter(
				(alarm) => alarm.statements > d1StatementsPerInvocation
			),
			statementAllowance: d1StatementsPerInvocation,
			passes: [...new Set(driven.alarms.map((alarm) => alarm.pass))].toSorted(
				byCodeUnit
			),
			queuedTargets: driven.queuedTargets,
			restoredObjects: driven.restoredObjects
		}).toStrictEqual({
			queuedAtFirstAlarm: reconciledPaths,
			firstAlarmStatements: 50,
			overAllowanceAlarms: [],
			statementAllowance: 50,
			passes: ['reconcile'],
			queuedTargets: 0,
			restoredObjects: brokenNarInfoObjects
		});
	}, 240_000);

	it('leaves the targets the allowance does not cover queued for the next pass', async () => {
		const driven = await driveReconcileAlarms(
			'alarm-allowance-reconcile-page',
			12
		);

		// Each pass keeps enough statement allowance for lifecycle admission and
		// leaves the targets it cannot process at the front of the queue.
		expect({
			pageSize: maxPathsReconciledPerRun,
			queueDepths: driven.alarms.map((alarm) => alarm.queuedTargets),
			queuedTargets: driven.queuedTargets
		}).toStrictEqual({
			pageSize: 38,
			queueDepths: [100, 70, 38, 4],
			queuedTargets: 0
		});
	}, 240_000);
});

// A reconcile backlog small enough for one pass to probe all of it. The fixture
// removes one published narinfo object and leaves the other two intact.
const faultyReconcilePaths = 3;

// Where a reconcile can fail on a target that still needs repairing: the R2
// probe of its published narinfo object, and the publication that restores it.
type ReconcileFault = 'probe' | 'publication';

type ReconcileFaultObservation = MeasuredInvocation<{
	readonly keys: readonly string[];
	readonly restored: boolean;
}>;

async function isObjectPresent(key: string): Promise<boolean> {
	const object = await env.BLOBS.head(key);

	return object !== null;
}

/**
 * Commits three paths, then queues them for reconciliation and removes the
 * published narinfo object of the first, so that one target needs a restore.
 * Injects `fault` for the first attempt at that target, runs two alarms, and
 * reports the queue and the object after each.
 *
 * The queueing, the removal and both alarm handler calls happen under the input
 * gate. A negotiation would also arm an alarm, which could reconcile the targets
 * before the fixture removes the object that the pass must repair.
 */
async function driveReconcileWithFault(
	server: string,
	fault: ReconcileFault
): Promise<{
	readonly alarms: readonly ReconcileFaultObservation[];
	readonly narInfoPublications: number;
	readonly unusedProbeFaults: number;
	readonly queueKey: string;
}> {
	await useTestServer(server);

	const { token } = await bootstrap({ caches: [{ scope: buildsCache }] });
	const paths = Array.from({ length: faultyReconcilePaths }, (_, index) =>
		indexedMetadata(index)
	);
	const broken = indexedMetadata(0);
	const brokenKey = narInfoObjectKey(
		fixtureTenant,
		broken.storePathHash,
		buildsCache
	);

	await Promise.all(
		paths.map((metadata) => pushPath(token, metadata, buildsCache))
	);

	const publication = vi.spyOn(
		NarInfoObjectsService.prototype,
		'putNarInfoObject'
	);
	const probePlan = {
		failures: fault === 'probe' ? 1 : 0,
		matches: (key: string): boolean => key === brokenKey
	};
	// The assertions use the repairs from each alarm. The measured run also
	// reports the statement count.
	const counting = countingD1(env.CUPBOARD_DB);

	try {
		return await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const queue = new ReconcileQueueService(instance.context);
				const cache = resolvedCache(instance.context, buildsCache);
				const queuedKeys = async (): Promise<string[]> => {
					const queued = await queue.claimChunk(faultyReconcilePaths + 1);

					return queued.keys().toArray().toSorted(byCodeUnit);
				};

				const alarms = await measureInvocations(state, counting, {
					attempts: 2,
					prepare: async () => {
						await env.BLOBS.delete(brokenKey);
						await queue.enqueue(
							origin,
							paths.map((metadata) => ({
								cacheId: cache.id,
								storePathHash: metadata.storePathHash
							}))
						);

						instance.context.env = {
							...instance.context.env,
							BLOBS: flakyR2(instance.context.env.BLOBS, probePlan)
						};

						if (fault === 'publication') {
							publication.mockImplementationOnce(() =>
								Promise.reject(new Error('transient publication fault'))
							);
						}
					},
					run: async () => {
						await instance.alarm();

						return {
							keys: await queuedKeys(),
							restored: await isObjectPresent(brokenKey)
						};
					}
				});

				return {
					alarms,
					narInfoPublications: publication.mock.calls.length,
					unusedProbeFaults: probePlan.failures,
					queueKey: queue.entryKey({
						cacheId: cache.id,
						storePathHash: broken.storePathHash
					})
				};
			}
		);
	} finally {
		publication.mockRestore();
	}
}

describe('reconcile queue retention', () => {
	beforeEach(resetTestServer);

	// A pass that clears the key of a target it did not repair loses the durable
	// record of the repair. Nothing else knows that the object is missing until
	// an unrelated scan reaches the path.
	it.each([
		// The probe fault is spent on the first alarm, so the second alarm makes
		// the only publication.
		{ fault: 'probe' as const, narInfoPublications: 1 },
		// The first alarm's publication is rejected and the second alarm's
		// succeeds.
		{ fault: 'publication' as const, narInfoPublications: 2 }
	])(
		'keeps a target queued when its $fault fails, and repairs it on the next alarm',
		async ({ fault, narInfoPublications }) => {
			const driven = await driveReconcileWithFault(
				`alarm-allowance-reconcile-${fault}`,
				fault
			);
			const queueKey = driven.queueKey;

			expect({
				alarms: driven.alarms.map(({ keys, restored }) => ({
					keys,
					restored
				})),
				narInfoPublications: driven.narInfoPublications,
				unusedProbeFaults: driven.unusedProbeFaults
			}).toStrictEqual({
				alarms: [
					{ keys: [queueKey], restored: false },
					{ keys: [], restored: true }
				],
				narInfoPublications,
				unusedProbeFaults: 0
			});
		},
		240_000
	);
});

describe('verify backstop alarm D1 statement allowance', () => {
	beforeEach(resetTestServer);

	it('keeps every backstop alarm within the 50-statement D1 limit', async () => {
		const driven = await driveBackstopAlarms('alarm-allowance-backstop', 12);

		// Each alarm settles two rows. Lifecycle admission, maintenance eligibility
		// and the per-row work all count towards the same invocation allowance.
		// This fixture does not spend the over-quota reserve because every row
		// settles.
		expect({
			pendingAtFirstAlarm: driven.alarms[0]?.pendingRows,
			settleLimit: verifyBackstopReuseSettleLimit,
			alarmStatements: driven.alarms.map((alarm) => alarm.statements),
			overAllowanceAlarms: driven.alarms.filter(
				(alarm) => alarm.statements > d1StatementsPerInvocation
			),
			statementAllowance: d1StatementsPerInvocation,
			passes: [...new Set(driven.alarms.map((alarm) => alarm.pass))].toSorted(
				byCodeUnit
			),
			pendingRows: driven.pendingRows
		}).toStrictEqual({
			pendingAtFirstAlarm: deferredReuseRows,
			settleLimit: 2,
			alarmStatements: [32, 24, 24, 24, 24, 24, 24],
			overAllowanceAlarms: [],
			statementAllowance: 50,
			passes: ['verify-backstop'],
			pendingRows: 0
		});
	}, 240_000);
});

// One full staging batch of paths to re-sign. Publishing every entry of a batch
// in one alarm would issue two statements for each of them, which is more than
// the invocation allowance covers.
const resignedPaths = 32;

type BackfillAlarmObservation = MeasuredInvocation<{
	readonly pass: string;
	readonly resigned: number;
}>;

/**
 * Commits `resignedPaths` paths and rotates the signing key, which leaves every
 * committed narinfo carrying a signature from the superseded key.
 */
async function queueSigningKeyBackfill(server: string): Promise<void> {
	await useTestServer(server);

	const { token } = await bootstrap({ caches: [{ scope: buildsCache }] });
	const paths = Array.from({ length: resignedPaths }, (_, index) =>
		indexedMetadata(index)
	);

	for (let start = 0; start < resignedPaths; start += pushConcurrency) {
		await Promise.all(
			paths
				.slice(start, start + pushConcurrency)
				.map((metadata) => pushPath(token, metadata, buildsCache))
		);
	}

	const rotation = await authorisedFetch('/keys/rotate', token, {
		method: 'POST'
	});

	if (!rotation.ok) {
		throw new Error(
			`Rotating the signing key returned ${String(rotation.status)}.`
		);
	}
}

/**
 * Runs alarms until the backfill completes, and reports the D1 statement count,
 * maintenance pass and re-signed path count of each one.
 *
 * The alarms are complete handler calls, measured under the input gate.
 */
async function driveBackfillAlarms(
	server: string,
	maxAlarms: number
): Promise<{
	readonly alarms: readonly BackfillAlarmObservation[];
	readonly resigned: number;
	readonly pendingBackfills: number;
}> {
	await queueSigningKeyBackfill(server);

	const counting = countingD1(env.CUPBOARD_DB);

	return runInDurableObject(currentServer(), async (instance, state) => {
		const real = instance.context.d1;

		Object.defineProperty(instance.context, 'd1', {
			configurable: true,
			value: drizzleD1(boundedD1(counting.binding), { schema: d1Schema })
		});

		const local = drizzle(state.storage, {
			schema: {
				cachePurgeContinuations,
				narInfos,
				signingKeyBackfills,
				signingKeys
			}
		});
		const targetGeneration = signingKeyGenerationSchema.parse(
			Math.max(
				...local
					.select({ generation: signingKeys.generation })
					.from(signingKeys)
					.all()
					.map((key) => key.generation)
			)
		);
		const supersededGeneration = signingKeyGenerationSchema.parse(
			targetGeneration - 1
		);
		const resignedCount = (): number =>
			local
				.select({ storePathHash: narInfos.storePathHash })
				.from(narInfos)
				.where(eq(narInfos.signatureGeneration, targetGeneration))
				.all().length;
		const pendingBackfills = (): number =>
			local
				.select({ keyId: signingKeyBackfills.keyId })
				.from(signingKeyBackfills)
				.where(ne(signingKeyBackfills.state, 'complete'))
				.all().length;
		const alarms = await measureInvocations(state, counting, {
			attempts: maxAlarms,
			// Rotating the key arms an alarm, which can stage the first batch before
			// measurement starts. Restore the rows and continuation to their state
			// immediately after rotation so the first measured alarm stages the batch.
			prepare: async () => {
				await state.storage.delete(maintenancePassCursorKey);
				local
					.delete(cachePurgeContinuations)
					.where(eq(cachePurgeContinuations.kind, 'backfill'))
					.run();
				local
					.update(narInfos)
					.set({
						signatureGeneration: supersededGeneration,
						pendingSignatureGeneration: sql`null`
					})
					.run();
				local.update(signingKeyBackfills).set({ state: 'running' }).run();
			},
			isDue: () => pendingBackfills() > 0,
			run: async () => {
				const resigned = resignedCount();
				await instance.alarm();

				return { pass: await currentMaintenancePass(state), resigned };
			}
		});

		Object.defineProperty(instance.context, 'd1', {
			configurable: true,
			value: real
		});

		return {
			alarms,
			resigned: resignedCount(),
			pendingBackfills: pendingBackfills()
		};
	});
}

describe('signing key backfill alarm D1 statement allowance', () => {
	beforeEach(resetTestServer);

	it('keeps every backfill alarm within the 50-statement D1 limit', async () => {
		const driven = await driveBackfillAlarms('alarm-allowance-backfill', 12);

		// The first alarm stages the whole batch, which writes only to the Durable
		// Object's own database. Each later alarm publishes nine entries while the
		// lifecycle and maintenance statements remain within the same allowance.
		expect({
			entriesPerPass: backfillEntriesPerPass,
			alarmStatements: driven.alarms.map((alarm) => alarm.statements),
			overAllowanceAlarms: driven.alarms.filter(
				(alarm) => alarm.statements > d1StatementsPerInvocation
			),
			statementAllowance: d1StatementsPerInvocation,
			passes: [...new Set(driven.alarms.map((alarm) => alarm.pass))].toSorted(
				byCodeUnit
			),
			resignedBeforeEachAlarm: driven.alarms.map((alarm) => alarm.resigned),
			resigned: driven.resigned,
			pendingBackfills: driven.pendingBackfills
		}).toStrictEqual({
			entriesPerPass: 9,
			alarmStatements: [0, 31, 31, 31, 23],
			overAllowanceAlarms: [],
			statementAllowance: 50,
			passes: ['signing-key-backfill'],
			resignedBeforeEachAlarm: [0, 0, 9, 18, 27],
			resigned: resignedPaths,
			pendingBackfills: 0
		});
	}, 240_000);
});
