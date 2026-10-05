import { capturingReporter } from '@cupboard/cli-ui/testing';
import {
	currentLocalStep,
	expansionLocalStep,
	localStepStallWindowMs,
	type LocalStepStatus
} from '@cupboard/protocol/deployment';
import type { Reporter } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import { isAbortError } from '../abort.ts';
import { LocalStepUnreachedError } from '../errors.ts';

import {
	localStepPollIntervalMs,
	type SettlementClient,
	settleTenants
} from './settlement.ts';

interface Counts {
	readonly ready: number;
	readonly working?: number;
	readonly stalled?: number;
	readonly unwoken?: number;
	readonly stalledSample?: LocalStepStatus['stalledSample'];
	readonly unwokenSample?: LocalStepStatus['unwokenSample'];
}

function status(counts: Counts): LocalStepStatus {
	const working = counts.working ?? 0;
	const stalled = counts.stalled ?? 0;
	const unwoken = counts.unwoken ?? 0;

	return {
		current: currentLocalStep,
		required: expansionLocalStep,
		ready: counts.ready,
		pending: working + stalled + unwoken,
		working,
		stalled,
		unwoken,
		stalledSample: counts.stalledSample ?? [],
		unwokenSample: counts.unwokenSample ?? []
	};
}

/**
 * A client that answers each status read with the next status in `statuses`,
 * repeating the last one, and records every call.
 */
function scriptedClient(
	statuses: readonly LocalStepStatus[],
	calls: string[]
): SettlementClient {
	let reads = 0;

	return {
		status: () => {
			calls.push('status');
			const next = statuses[Math.min(reads, statuses.length - 1)];
			reads += 1;

			return next === undefined
				? Promise.reject(new Error('no status scripted'))
				: Promise.resolve(next);
		},
		wake: () => {
			calls.push('wake');

			return Promise.resolve({
				required: expansionLocalStep,
				enqueued: 2,
				pending: 2
			});
		}
	};
}

// A clock that advances only when the settlement waits.
function fakeClock(): {
	readonly now: () => number;
	readonly delay: (ms: number) => Promise<void>;
	readonly delays: number[];
} {
	let now = 0;
	const delays: number[] = [];

	return {
		now: () => now,
		delay: (ms) => {
			now += ms;
			delays.push(ms);

			return Promise.resolve();
		},
		delays
	};
}

const ignore = (): undefined => undefined;

// Records the settlement's step log as lines.
function recordingReporter(lines: string[]): Reporter {
	return {
		...capturingReporter([]),
		steps: (_label, body) =>
			Promise.resolve(
				body({
					message: (message) => {
						lines.push(message);
					},
					group: () => ({ message: ignore, success: ignore, error: ignore }),
					warn: (label, value) => {
						lines.push(`${label}: ${value ?? ''}`);
					}
				})
			)
	};
}

async function caughtFrom(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}

	return undefined;
}

const polls = localStepStallWindowMs / localStepPollIntervalMs;

describe('tenant settlement', () => {
	it('returns without a wake when no tenant is pending', async () => {
		const calls: string[] = [];
		const ready = status({ ready: 2 });

		const result = await settleTenants(
			scriptedClient([ready], calls),
			recordingReporter([])
		);

		expect({ result, calls }).toStrictEqual({
			result: ready,
			calls: ['status']
		});
	});

	it('wakes once and polls until no tenant is pending', async () => {
		const calls: string[] = [];
		const lines: string[] = [];
		const clock = fakeClock();
		const final = status({ ready: 2 });

		const result = await settleTenants(
			scriptedClient(
				[
					status({ ready: 0, unwoken: 2 }),
					status({ ready: 0, working: 2 }),
					status({ ready: 0, working: 2 }),
					status({ ready: 1, working: 1 }),
					final
				],
				calls
			),
			recordingReporter(lines),
			{ now: clock.now, delay: clock.delay }
		);

		expect({ result, calls, delays: clock.delays, lines }).toStrictEqual({
			result: final,
			calls: ['status', 'wake', 'status', 'status', 'status', 'status'],
			delays: [
				localStepPollIntervalMs,
				localStepPollIntervalMs,
				localStepPollIntervalMs
			],
			lines: [
				'Enqueued wakes for 2 of 2 pending tenants',
				'Cancelling this command stops only the wait; tenant migrations continue on the server.',
				'Tenants: 0 ready, 2 migrating, 0 need attention, 0 waiting to start',
				'Tenants: 1 ready, 1 migrating, 0 need attention, 0 waiting to start',
				'Tenants: 2 ready, 0 migrating, 0 need attention, 0 waiting to start'
			]
		});
	});

	// A tenant that is working keeps the settlement waiting, however long the
	// wait has been.
	it('keeps waiting past the stall window while a tenant is working', async () => {
		const calls: string[] = [];
		const clock = fakeClock();
		const working = status({ ready: 0, working: 1 });
		const final = status({ ready: 1 });

		const result = await settleTenants(
			scriptedClient(
				[working, ...Array.from({ length: polls + 1 }, () => working), final],
				calls
			),
			recordingReporter([]),
			{ now: clock.now, delay: clock.delay }
		);

		expect({ result, delays: clock.delays.length }).toStrictEqual({
			result: final,
			delays: polls + 1
		});
	});

	it('fails with the stalled and unwoken samples once no tenant has worked for the stall window', async () => {
		const calls: string[] = [];
		const lines: string[] = [];
		const clock = fakeClock();
		const stalled = status({
			ready: 1,
			stalled: 1,
			unwoken: 1,
			stalledSample: [
				{
					tenant: 'acme',
					attemptedAt: '2026-01-01T00:20:00.000Z',
					progressedAt: '2026-01-01T00:02:00.000Z',
					error: 'InjectedPageFault'
				}
			],
			unwokenSample: [{ tenant: 'gamma' }]
		});

		const client = scriptedClient(
			[status({ ready: 1, unwoken: 2 }), stalled],
			calls
		);

		const caught = await caughtFrom(
			settleTenants(client, recordingReporter(lines), {
				now: clock.now,
				delay: clock.delay
			})
		);

		expect({
			caught,
			wakes: calls.filter((call) => call === 'wake').length,
			delays: clock.delays.length,
			warnings: lines.filter((line) => line.startsWith('Stalled'))
		}).toStrictEqual({
			caught: new LocalStepUnreachedError({ kind: 'stalled', status: stalled }),
			wakes: 1,
			delays: polls,
			warnings: [
				'Stalled: acme: attempted 2026-01-01 00:20 UTC, last progress 2026-01-01 00:02 UTC, InjectedPageFault'
			]
		});
	});

	it('fails when no wake has reached any tenant for the stall window', async () => {
		const clock = fakeClock();
		const unwoken = status({
			ready: 0,
			unwoken: 2,
			unwokenSample: [
				{ tenant: 'acme' },
				{ tenant: 'beta', attemptedAt: '2025-12-31T23:00:00.000Z' }
			]
		});

		const caught = await caughtFrom(
			settleTenants(scriptedClient([unwoken], []), recordingReporter([]), {
				now: clock.now,
				delay: clock.delay
			})
		);

		expect({ caught, delays: clock.delays.length }).toStrictEqual({
			caught: new LocalStepUnreachedError({ kind: 'stalled', status: unwoken }),
			delays: polls
		});
	});

	it('does not send a wake after cancellation', async () => {
		const controller = new AbortController();
		const calls: string[] = [];
		const client = scriptedClient([status({ ready: 0, unwoken: 1 })], calls);

		const caught = await caughtFrom(
			settleTenants(
				{
					...client,
					status: () => {
						controller.abort();

						return client.status();
					}
				},
				recordingReporter([]),
				{ signal: controller.signal }
			)
		);

		expect({ isAbort: isAbortError(caught), calls }).toStrictEqual({
			isAbort: true,
			calls: ['status']
		});
	});

	it('stops polling after cancellation once the server has accepted the wake', async () => {
		const controller = new AbortController();
		const calls: string[] = [];
		const client = scriptedClient(
			[status({ ready: 0, unwoken: 1 }), status({ ready: 0, working: 1 })],
			calls
		);
		const caught = await caughtFrom(
			settleTenants(client, capturingReporter([]), {
				signal: controller.signal,
				delay: () => {
					controller.abort();
					return Promise.resolve();
				}
			})
		);
		expect({ isAbort: isAbortError(caught), calls }).toStrictEqual({
			isAbort: true,
			calls: ['status', 'wake', 'status']
		});
	});
});
