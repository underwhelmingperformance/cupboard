import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { type UploadPathMetadata } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import { narInfoDeletions } from '../db/schema.ts';
import { narInfoObjectKey, requestOriginSchema } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	bootstrap,
	countingD1,
	currentServer,
	drainAttestationInheritance,
	flakyR2,
	type MeasuredInvocation,
	measureInvocations,
	namedCache,
	narBytes,
	pushPath,
	resetTestServer,
	resolvedCache,
	uploadMetadata,
	useTestServer,
	withDeployedSubrequestAllowance,
	withoutAlarmArming
} from '../test-support.ts';

import { boundedD1 } from './bounded-io.ts';
import {
	maxPathsTornDownPerRun,
	teardownEntryPrefix
} from './cache-admin-service.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';
import { ReconcileQueueService } from './reconcile-queue-service.ts';
import { gcContinuationKey, maintenancePassCursorKey } from './server.ts';
const buildsCache = namedCache('builds');
const origin = requestOriginSchema.parse('https://cache.example');
const storePathAlphabet = '0123456789abcdfghijklmnpqrsvwxyz';
const teardownAllowance = 200;
const committedPaths = maxPathsTornDownPerRun(teardownAllowance) + 1;
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

	await withoutAlarmArming(async () => {
		const { token } = await bootstrap({ caches: [{ scope: buildsCache }] });

		for (let index = 0; index < committedPaths; index += 1) {
			await pushPath(token, indexedMetadata(index), buildsCache);
		}
	});
	await drainAttestationInheritance();
}

/**
 * Deletes the cache, leaves a garbage-collection continuation beside the
 * teardown backlog, and runs alarms until both are drained. Reports which
 * maintenance pass ran and how many deletions remain.
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
	readonly subrequestAllowance: number;
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
		const teardownKey = `${teardownEntryPrefix}${String(cache.id)}`;
		const queueDepth = (): number =>
			drizzle(state.storage, { schema: { narInfoDeletions } })
				.select({ storePathHash: narInfoDeletions.storePathHash })
				.from(narInfoDeletions)
				.all().length;

		try {
			const driven = await withDeployedSubrequestAllowance(
				instance.context,
				teardownAllowance,
				async () => {
					await instance.runCacheTeardown(buildsCache, origin);
					await state.storage.put(gcContinuationKey, [{ scope: 'tenant' }]);

					const alarms = await measureInvocations(state, counting, {
						attempts: maxAlarms,
						isolation: 'disarmed-alarm',
						// Start the pass rotation from the first pass so this fixture can
						// assert which pass each explicitly driven alarm runs.
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

					return {
						alarms,
						subrequestAllowance: instance.context.subrequestsPerInvocation
					};
				}
			);

			return {
				...driven,
				teardownPending: await state.storage.get(teardownKey),
				collectionPending: await state.storage.get(gcContinuationKey),
				queuedDeletions: queueDepth()
			};
		} finally {
			Object.defineProperty(instance.context, 'd1', {
				configurable: true,
				value: real
			});
		}
	});
}

describe('alarm continuation', () => {
	beforeEach(resetTestServer);

	it('finishes both the teardown backlog and the collection continuation across successive alarms', async () => {
		const driven = await withoutAlarmArming(() =>
			driveAlarms('alarm-fairness', 12)
		);

		expect({
			queuedDeletionsAtFirstAlarm: driven.alarms[0]?.queuedDeletions,
			passes: [...new Set(driven.alarms.map((alarm) => alarm.pass))].toSorted(
				byCodeUnit
			),
			teardownPending: driven.teardownPending,
			collectionPending: driven.collectionPending,
			queuedDeletions: driven.queuedDeletions
		}).toStrictEqual({
			queuedDeletionsAtFirstAlarm: committedPaths,
			passes: ['garbage-collection', 'teardown'],
			teardownPending: undefined,
			collectionPending: undefined,
			queuedDeletions: 0
		});
	});
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

	for (const metadata of paths) {
		await pushPath(token, metadata, buildsCache);
	}

	const publication = vi.spyOn(
		NarInfoObjectsService.prototype,
		'putNarInfoObject'
	);
	const probePlan = {
		failures: fault === 'probe' ? 1 : 0,
		matches: (key: string): boolean => key === brokenKey
	};
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
					isolation: 'disarmed-alarm',
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
			const driven = await withoutAlarmArming(() =>
				driveReconcileWithFault(`alarm-reconcile-${fault}`, fault)
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
