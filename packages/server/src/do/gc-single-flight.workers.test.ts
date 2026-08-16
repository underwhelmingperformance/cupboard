import { type VerifyReport } from '@cupboard/protocol/reports';
import { verifyReportSchema } from '@cupboard/protocol/reports';
import { runInDurableObject } from 'cloudflare:test';
import { StatusCodes } from 'http-status-codes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	clearAbandonedAlarms,
	currentOrigin,
	currentServer,
	initialise,
	resetTestServer
} from '../test-support.ts';

import {
	GarbageCollectionService,
	maxPathsSweptPerRun
} from './garbage-collection-service.ts';
import { gcContinuationKey } from './server.ts';
import { VerificationService } from './verification-service.ts';

const gcOutcome = {
	pendingUploadsDeleted: 0,
	pendingAttestationsDeleted: 0,
	rootsExpired: 0,
	pathsCollected: 0,
	hasMoreExpiredRoots: false,
	hasMoreWork: false,
	narInfosDeleted: 0,
	orphanStagingDeleted: 0
};
const tenantWideContinuation = {
	scope: 'tenant',
	collectLimit: maxPathsSweptPerRun
};
const scopedContinuation = (cache: string) => ({
	scope: 'cache',
	cache,
	collectLimit: maxPathsSweptPerRun
});
const cappedGcOutcome = {
	...gcOutcome,
	pathsCollected: maxPathsSweptPerRun,
	hasMoreWork: true
};

const verifyReport = {
	scanned: 0,
	narInfoObjectsRestored: 0,
	danglingNarInfosRemoved: 0,
	cursor: '',
	cursorCache: '',
	wrapped: true
} satisfies VerifyReport;

// The DO alarm, the cron/queue RPCs and the interactive admin path can all drive
// maintenance on the same instance. A cron tick coalesces against a cron pass
// already queued or running; the alarm resume and interactive drivers serialise
// through the per-kind chain rather than skipping, so every pass runs.
describe('garbage-collection maintenance serialisation', () => {
	beforeEach(resetTestServer);
	afterEach(clearAbandonedAlarms);

	it.each([{ drivers: 2 }, { drivers: 3 }])(
		'coalesces $drivers concurrent cron drivers into one sweep',
		async ({ drivers }) => {
			await initialise();

			const started = Promise.withResolvers<boolean>();
			const blocked = Promise.withResolvers<boolean>();

			const collect = vi
				.spyOn(GarbageCollectionService.prototype, 'collectGarbage')
				.mockImplementation(async () => {
					started.resolve(true);
					await blocked.promise;

					return gcOutcome;
				});

			try {
				await runInDurableObject(currentServer(), async (instance) => {
					const first = instance.runGarbageCollection();

					// The first driver is now inside the sweep, holding the 'gc' chain.
					await started.promise;

					const rest = Array.from({ length: drivers - 1 }, () =>
						instance.runGarbageCollection()
					);

					blocked.resolve(true);
					await Promise.all([first, ...rest]);
				});

				expect(collect.mock.calls).toHaveLength(1);
			} finally {
				collect.mockRestore();
			}
		}
	);

	it('runs an interactive sweep serialised after a blocked cron sweep', async () => {
		const token = await initialise();

		const events: string[] = [];
		const firstStarted = Promise.withResolvers<boolean>();
		const release = Promise.withResolvers<boolean>();
		let call = 0;

		const collect = vi
			.spyOn(GarbageCollectionService.prototype, 'collectGarbage')
			.mockImplementation(async () => {
				const index = call;
				call += 1;

				if (index === 0) {
					events.push('first-start');
					firstStarted.resolve(true);
					await release.promise;
					events.push('first-end');

					return gcOutcome;
				}

				events.push('second-start', 'second-end');

				return gcOutcome;
			});

		try {
			let status = 0;

			await runInDurableObject(currentServer(), async (instance) => {
				const cron = instance.runGarbageCollection();
				await firstStarted.promise;

				const request = new Request(new URL('/gc', currentOrigin()), {
					method: 'POST',
					headers: { authorization: `Bearer ${token}` }
				});
				const interactive = instance.fetch(request);

				release.resolve(true);
				const response = await interactive;
				await cron;
				status = response.status;
			});

			expect({
				events,
				status,
				calls: collect.mock.calls.length
			}).toStrictEqual({
				events: ['first-start', 'first-end', 'second-start', 'second-end'],
				status: StatusCodes.OK,
				calls: 2
			});
		} finally {
			collect.mockRestore();
		}
	});

	// A failing pass surfaces only to its own driver: the per-kind chain
	// resolves its marker in the finally and the cron coalescing marker is
	// cleared, so the next cron tick runs a fresh sweep instead of wedging
	// behind the failure or coalescing into it.
	it('recovers from a failing sweep, running the next cron pass', async () => {
		await initialise();

		class InjectedSweepError extends Error {}

		const collect = vi
			.spyOn(GarbageCollectionService.prototype, 'collectGarbage')
			.mockRejectedValueOnce(new InjectedSweepError())
			.mockResolvedValueOnce(gcOutcome);

		try {
			const observed = await runInDurableObject(
				currentServer(),
				async (instance, state) => {
					await expect(instance.runGarbageCollection()).rejects.toBeInstanceOf(
						InjectedSweepError
					);
					const afterFailure = {
						continuation: await state.storage.get(gcContinuationKey),
						alarmArmed: (await state.storage.getAlarm()) !== null
					};

					await instance.runGarbageCollection();

					return {
						afterFailure,
						afterRecovery: {
							continuation: await state.storage.get(gcContinuationKey),
							calls: collect.mock.calls.length
						}
					};
				}
			);

			expect(observed).toStrictEqual({
				afterFailure: {
					continuation: [tenantWideContinuation],
					alarmArmed: true
				},
				afterRecovery: { continuation: undefined, calls: 2 }
			});
		} finally {
			collect.mockRestore();
		}
	});

	it('resumes a legacy numeric continuation tenant-wide', async () => {
		await initialise();

		const collect = vi
			.spyOn(GarbageCollectionService.prototype, 'collectGarbage')
			.mockResolvedValue(gcOutcome);

		try {
			const observed = await runInDurableObject(
				currentServer(),
				async (instance, state) => {
					await state.storage.put(gcContinuationKey, maxPathsSweptPerRun);
					await instance.alarm();

					const continuation = await state.storage.get(gcContinuationKey);
					await state.storage.deleteAlarm();

					return {
						continuation,
						calls: collect.mock.calls.map(
							([_logger, cache, purgeOrigin, collectLimit]) => ({
								cache,
								purgeOrigin,
								collectLimit
							})
						)
					};
				}
			);

			expect(observed).toStrictEqual({
				continuation: undefined,
				calls: [
					{
						cache: undefined,
						purgeOrigin: undefined,
						collectLimit: maxPathsSweptPerRun
					}
				]
			});
		} finally {
			collect.mockRestore();
		}
	});

	it('resumes a continuation stored under the retired limit key', async () => {
		await initialise();

		const collect = vi
			.spyOn(GarbageCollectionService.prototype, 'collectGarbage')
			.mockResolvedValue(gcOutcome);

		try {
			const observed = await runInDurableObject(
				currentServer(),
				async (instance, state) => {
					// The shape an earlier build wrote for a cache-scoped run that
					// stopped at its cap.
					await state.storage.put(gcContinuationKey, [
						{
							scope: 'cache',
							cache: 'builds',
							sweepLimit: maxPathsSweptPerRun
						}
					]);
					await instance.alarm();

					const continuation = await state.storage.get(gcContinuationKey);
					await state.storage.deleteAlarm();

					return {
						continuation,
						calls: collect.mock.calls.map(
							([_logger, cache, _purgeOrigin, collectLimit]) => ({
								cache,
								collectLimit
							})
						)
					};
				}
			);

			expect(observed).toStrictEqual({
				continuation: undefined,
				calls: [{ cache: 'builds', collectLimit: maxPathsSweptPerRun }]
			});
		} finally {
			collect.mockRestore();
		}
	});

	it('keeps a cache-scoped continuation on failure and resumes that cache', async () => {
		const token = await initialise();

		class InjectedScopedSweepError extends Error {}

		const collect = vi
			.spyOn(GarbageCollectionService.prototype, 'collectGarbage')
			.mockRejectedValueOnce(new InjectedScopedSweepError())
			.mockResolvedValueOnce(gcOutcome);
		const request = new Request(new URL('/cache/builds/gc', currentOrigin()), {
			method: 'POST',
			headers: { authorization: `Bearer ${token}` }
		});

		try {
			const observed = await runInDurableObject(
				currentServer(),
				async (instance, state) => {
					const response = await instance.fetch(request);
					const afterFailure = {
						status: response.status,
						continuation: await state.storage.get(gcContinuationKey),
						alarmArmed: (await state.storage.getAlarm()) !== null
					};

					await instance.alarm();
					await state.storage.deleteAlarm();

					return {
						afterFailure,
						afterRecovery: {
							continuation: await state.storage.get(gcContinuationKey),
							cacheScopes: collect.mock.calls.map(([_logger, cache]) => cache)
						}
					};
				}
			);

			expect(observed).toStrictEqual({
				afterFailure: {
					status: StatusCodes.INTERNAL_SERVER_ERROR,
					continuation: [
						{
							scope: 'cache',
							cache: 'builds',
							collectLimit: maxPathsSweptPerRun
						}
					],
					alarmArmed: true
				},
				afterRecovery: {
					continuation: undefined,
					cacheScopes: ['builds', 'builds']
				}
			});
		} finally {
			collect.mockRestore();
		}
	});

	it('preserves another cache continuation when a scoped sweep drains', async () => {
		const token = await initialise();
		const collect = vi
			.spyOn(GarbageCollectionService.prototype, 'collectGarbage')
			.mockResolvedValue(gcOutcome);
		const request = new Request(new URL('/cache/b/gc', currentOrigin()), {
			method: 'POST',
			headers: { authorization: `Bearer ${token}` }
		});

		try {
			const observed = await runInDurableObject(
				currentServer(),
				async (instance, state) => {
					await state.storage.put(gcContinuationKey, [scopedContinuation('a')]);
					const response = await instance.fetch(request);
					const continuation = await state.storage.get(gcContinuationKey);
					await state.storage.deleteAlarm();

					return {
						status: response.status,
						continuation,
						cacheScopes: collect.mock.calls.map(([_logger, cache]) => cache)
					};
				}
			);

			expect(observed).toStrictEqual({
				status: StatusCodes.OK,
				continuation: [scopedContinuation('a')],
				cacheScopes: ['b']
			});
		} finally {
			collect.mockRestore();
		}
	});

	it('queues distinct cache continuations and settles only the resumed scope', async () => {
		const token = await initialise();
		const collect = vi
			.spyOn(GarbageCollectionService.prototype, 'collectGarbage')
			.mockResolvedValueOnce(cappedGcOutcome)
			.mockResolvedValue(gcOutcome);
		const request = new Request(new URL('/cache/b/gc', currentOrigin()), {
			method: 'POST',
			headers: { authorization: `Bearer ${token}` }
		});

		try {
			const observed = await runInDurableObject(
				currentServer(),
				async (instance, state) => {
					await state.storage.put(gcContinuationKey, [scopedContinuation('a')]);
					const response = await instance.fetch(request);
					const queued = await state.storage.get(gcContinuationKey);

					await instance.alarm();
					const afterA = await state.storage.get(gcContinuationKey);
					await instance.alarm();
					const afterB = await state.storage.get(gcContinuationKey);
					await state.storage.deleteAlarm();

					return {
						status: response.status,
						queued,
						afterA,
						afterB,
						cacheScopes: collect.mock.calls.map(([_logger, cache]) => cache)
					};
				}
			);

			expect(observed).toStrictEqual({
				status: StatusCodes.OK,
				queued: [scopedContinuation('a'), scopedContinuation('b')],
				afterA: [scopedContinuation('b')],
				afterB: undefined,
				cacheScopes: ['b', 'a', 'b']
			});
		} finally {
			collect.mockRestore();
		}
	});

	it('keeps one tenant-wide continuation when scopes overlap', async () => {
		const token = await initialise();
		const collect = vi
			.spyOn(GarbageCollectionService.prototype, 'collectGarbage')
			.mockResolvedValue(cappedGcOutcome);
		const request = new Request(new URL('/cache/b/gc', currentOrigin()), {
			method: 'POST',
			headers: { authorization: `Bearer ${token}` }
		});

		try {
			const observed = await runInDurableObject(
				currentServer(),
				async (instance, state) => {
					await state.storage.put(gcContinuationKey, [scopedContinuation('a')]);
					await instance.runGarbageCollection();
					const widened = await state.storage.get(gcContinuationKey);

					const response = await instance.fetch(request);
					const afterScopedSweep = await state.storage.get(gcContinuationKey);
					await state.storage.deleteAlarm();

					return {
						status: response.status,
						widened,
						afterScopedSweep
					};
				}
			);

			expect(observed).toStrictEqual({
				status: StatusCodes.OK,
				widened: [tenantWideContinuation],
				afterScopedSweep: [tenantWideContinuation]
			});
		} finally {
			collect.mockRestore();
		}
	});

	it('migrates and re-arms a legacy numeric continuation when resume fails', async () => {
		await initialise();

		class InjectedContinuationError extends Error {}

		const collect = vi
			.spyOn(GarbageCollectionService.prototype, 'collectGarbage')
			.mockRejectedValue(new InjectedContinuationError());

		try {
			const observed = await runInDurableObject(
				currentServer(),
				async (instance, state) => {
					await state.storage.put(gcContinuationKey, maxPathsSweptPerRun);

					await expect(instance.alarm()).rejects.toBeInstanceOf(
						InjectedContinuationError
					);

					const alarm = await state.storage.getAlarm();

					return {
						continuation: await state.storage.get(gcContinuationKey),
						alarmArmed: alarm !== null
					};
				}
			);

			expect(observed).toStrictEqual({
				continuation: [tenantWideContinuation],
				alarmArmed: true
			});
		} finally {
			collect.mockRestore();
		}
	});

	it('bails from the alarm resume when a concurrent sweep already drained the marker', async () => {
		await initialise();

		const started = Promise.withResolvers<boolean>();
		const blocked = Promise.withResolvers<boolean>();

		const collect = vi
			.spyOn(GarbageCollectionService.prototype, 'collectGarbage')
			.mockImplementation(async () => {
				started.resolve(true);
				await blocked.promise;

				return gcOutcome;
			});

		try {
			const observed = await runInDurableObject(
				currentServer(),
				async (instance, state) => {
					await state.storage.put(gcContinuationKey, maxPathsSweptPerRun);

					const cron = instance.runGarbageCollection();
					await started.promise;

					// The alarm's resume reads the marker, then chains behind the sweep
					// in flight. That sweep drains the marker, so the resume's body finds
					// nothing left and does not sweep a second time.
					const alarm = instance.alarm();

					blocked.resolve(true);
					await Promise.all([cron, alarm]);

					const continuation = await state.storage.get(gcContinuationKey);
					await state.storage.deleteAlarm();

					return { continuation, calls: collect.mock.calls.length };
				}
			);

			expect(observed).toStrictEqual({ continuation: undefined, calls: 1 });
		} finally {
			collect.mockRestore();
		}
	});
});

describe('verification maintenance serialisation', () => {
	beforeEach(resetTestServer);
	afterEach(clearAbandonedAlarms);

	it('serialises an interactive verify after a blocked cron verify', async () => {
		const token = await initialise();

		const events: string[] = [];
		const cronStarted = Promise.withResolvers<boolean>();
		const release = Promise.withResolvers<boolean>();
		let call = 0;

		const verifyBatch = vi
			.spyOn(VerificationService.prototype, 'verifyBatch')
			.mockImplementation(async () => {
				const index = call;
				call += 1;

				if (index === 0) {
					events.push('cron-start');
					cronStarted.resolve(true);
					await release.promise;
					events.push('cron-end');

					return verifyReport;
				}

				events.push('interactive-start', 'interactive-end');

				return verifyReport;
			});

		try {
			let interactiveReport: VerifyReport | undefined;

			await runInDurableObject(currentServer(), async (instance) => {
				const cron = instance.runVerification();
				await cronStarted.promise;

				const request = new Request(new URL('/verify', currentOrigin()), {
					method: 'POST',
					headers: {
						authorization: `Bearer ${token}`,
						'content-type': 'application/json'
					},
					body: JSON.stringify({})
				});
				const interactive = instance.fetch(request);

				release.resolve(true);
				const response = await interactive;
				await cron;

				expect(response.status).toBe(StatusCodes.OK);
				interactiveReport = verifyReportSchema.parse(await response.json());
			});

			expect({
				events,
				interactiveReport,
				calls: verifyBatch.mock.calls.length
			}).toStrictEqual({
				events: [
					'cron-start',
					'cron-end',
					'interactive-start',
					'interactive-end'
				],
				interactiveReport: verifyReport,
				calls: 2
			});
		} finally {
			verifyBatch.mockRestore();
		}
	});
});
