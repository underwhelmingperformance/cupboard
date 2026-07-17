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
	pathsSwept: 0,
	narInfosDeleted: 0,
	orphanStagingDeleted: 0
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
			await runInDurableObject(currentServer(), async (instance) => {
				await expect(instance.runGarbageCollection()).rejects.toBeInstanceOf(
					InjectedSweepError
				);
				await instance.runGarbageCollection();
			});

			expect(collect.mock.calls.length).toStrictEqual(2);
		} finally {
			collect.mockRestore();
		}
	});

	it('resumes a pending sweep from the alarm, running one bounded sweep', async () => {
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

					const continuation =
						await state.storage.get<number>(gcContinuationKey);
					await state.storage.deleteAlarm();

					return { continuation, calls: collect.mock.calls.length };
				}
			);

			expect(observed).toStrictEqual({ continuation: undefined, calls: 1 });
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

					const continuation =
						await state.storage.get<number>(gcContinuationKey);
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
