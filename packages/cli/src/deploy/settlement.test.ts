import { capturingReporter } from '@cupboard/cli-ui/testing';
import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import {
	currentLocalStep,
	expansionLocalStep,
	type LocalStepStatus,
	type LocalStepSweep,
	localStepSweepChainIdSchema,
	localStepSweepPaceSeconds,
	type LocalStepWakeOutcomes,
	type LocalStepWakeResponse
} from '@cupboard/protocol/deployment';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { describe, expect, it } from 'vitest';

import { LocalStepUnreachedError } from '../errors.ts';

import {
	maxChainRestarts,
	type SettlementClient,
	settleTenants
} from './settlement.ts';

const tenant = tenantIdSchema.parse('pending');
const chain = localStepSweepChainIdSchema.parse(
	'00000000-0000-4000-8000-00000000000a'
);
const at = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');
const idle: LocalStepSweep = { state: 'idle' };

function running(outcomes: LocalStepWakeOutcomes = []): LocalStepSweep {
	return {
		state: 'running',
		chain,
		link: 1,
		updatedAt: at,
		nextAt: at,
		outcomes
	};
}

function stalled(outcomes: LocalStepWakeOutcomes): LocalStepSweep {
	return {
		state: 'stalled',
		chain,
		link: 1,
		updatedAt: at,
		nextAt: at,
		outcomes
	};
}

function status(pending: number, sweep: LocalStepSweep): LocalStepStatus {
	return {
		current: currentLocalStep,
		required: expansionLocalStep,
		ready: 1 - pending,
		pending,
		stragglers: pending === 0 ? [] : [tenant],
		sweep
	};
}

const woke: LocalStepWakeResponse = {
	current: currentLocalStep,
	woken: 1,
	failed: 0,
	outcomes: [{ tenant, kind: 'advanced', projected: 3 }]
};

// A client that answers each status poll from a script, in order, and records
// every request and every delay the settlement waits out.
function scriptedClient(
	statuses: readonly LocalStepStatus[],
	requests: unknown[]
): SettlementClient {
	let polls = 0;

	return {
		status: (input) => {
			requests.push(input);
			const next = statuses[polls];
			polls += 1;

			if (next === undefined) {
				return Promise.reject(new Error('the settlement polled too often'));
			}

			return Promise.resolve(next);
		},
		wake: (input) => {
			requests.push(input);

			return Promise.resolve(woke);
		}
	};
}

// The wake requests among those the client recorded.
function wakesIn(requests: readonly unknown[]): number {
	return requests.filter(
		(request) =>
			typeof request === 'object' && request !== null && 'limit' in request
	).length;
}

function settle(
	client: SettlementClient,
	delays: number[],
	warns: string[] = [],
	signal?: AbortSignal
): Promise<LocalStepStatus> {
	return settleTenants(client, capturingReporter([], [], warns), {
		requiredStep: expansionLocalStep,
		limit: 20,
		delay: (ms) => {
			delays.push(ms);

			return Promise.resolve();
		},
		...(signal !== undefined && { signal })
	});
}

describe('tenant settlement', () => {
	it('returns at once when nothing is pending', async () => {
		const requests: unknown[] = [];
		const delays: number[] = [];

		const actual = await settle(
			scriptedClient([status(0, idle)], requests),
			delays
		);

		expect({ actual, requests, delays }).toStrictEqual({
			actual: status(0, idle),
			requests: [{ requiredStep: expansionLocalStep }],
			delays: []
		});
	});

	it('wakes once, then observes the chain at its pace until nothing is pending', async () => {
		const requests: unknown[] = [];
		const delays: number[] = [];
		const client = scriptedClient(
			[
				status(1, idle),
				status(1, running()),
				status(1, running()),
				status(0, idle)
			],
			requests
		);

		const actual = await settle(client, delays);

		expect({ actual, requests, delays }).toStrictEqual({
			actual: status(0, idle),
			requests: [
				{ requiredStep: expansionLocalStep },
				{ limit: 20 },
				{ requiredStep: expansionLocalStep },
				{ requiredStep: expansionLocalStep },
				{ requiredStep: expansionLocalStep }
			],
			delays: [
				localStepSweepPaceSeconds * 1000,
				localStepSweepPaceSeconds * 1000,
				localStepSweepPaceSeconds * 1000
			]
		});
	});

	it("fails when the chain stalls, naming the stragglers and the last batch's outcomes", async () => {
		const requests: unknown[] = [];
		const warns: string[] = [];
		const outcomes: LocalStepWakeOutcomes = [
			{ tenant, kind: 'unconfigured' },
			{ tenant: tenantIdSchema.parse('broken'), kind: 'failed' }
		];
		const client = scriptedClient(
			[status(1, idle), status(1, running()), status(1, stalled(outcomes))],
			requests
		);

		let caught: unknown;

		try {
			await settle(client, [], warns);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(LocalStepUnreachedError);
		expect({
			pending: caught instanceof LocalStepUnreachedError && caught.pending,
			stragglers:
				caught instanceof LocalStepUnreachedError && caught.stragglers,
			outcomes: caught instanceof LocalStepUnreachedError && caught.outcomes,
			namesBatch:
				caught instanceof LocalStepUnreachedError &&
				caught.message.includes(
					'The last batch: pending unconfigured, broken failed.'
				),
			warns,
			wakes: wakesIn(requests)
		}).toStrictEqual({
			pending: 1,
			stragglers: [tenant],
			outcomes,
			namesBatch: true,
			warns: [
				'pending: Tenant creation is incomplete. Repeat its creation with the original configuration.',
				'broken: Tenant migration failed. Inspect the tenant Worker logs before retrying.'
			],
			wakes: 1
		});
	});

	it('restarts a dead chain up to three times, then fails', async () => {
		const requests: unknown[] = [];
		const last = { chain, link: 4, updatedAt: at, outcomes: [] };
		const dead: LocalStepSweep = { state: 'idle', last };
		const client = scriptedClient(
			[
				status(1, idle),
				status(1, running()),
				status(1, dead),
				status(1, dead),
				status(1, running()),
				status(1, dead),
				status(1, dead)
			],
			requests
		);

		await expect(settle(client, [])).rejects.toBeInstanceOf(
			LocalStepUnreachedError
		);
		expect({ wakes: wakesIn(requests), maxChainRestarts }).toStrictEqual({
			wakes: 1 + maxChainRestarts,
			maxChainRestarts
		});
	});

	it('reports each failing tenant once across the batches it observes', async () => {
		const warns: string[] = [];
		const failed: LocalStepWakeOutcomes = [{ tenant, kind: 'failed' }];
		const client = scriptedClient(
			[
				status(1, idle),
				status(1, running(failed)),
				status(1, running(failed)),
				status(0, {
					state: 'idle',
					last: {
						chain,
						link: 3,
						updatedAt: at,
						outcomes: [{ tenant, kind: 'recorded', step: expansionLocalStep }]
					}
				})
			],
			[]
		);

		await settle(client, [], warns);

		expect(warns).toStrictEqual([
			'pending: Tenant migration failed. Inspect the tenant Worker logs before retrying.'
		]);
	});

	it('does not send a wake after cancellation', async () => {
		const controller = new AbortController();
		let wakes = 0;
		const client: SettlementClient = {
			status: () => {
				controller.abort();

				return Promise.resolve(status(1, idle));
			},
			wake: () => {
				wakes++;

				return Promise.resolve(woke);
			}
		};

		await expect(settle(client, [], [], controller.signal)).rejects.toThrow();
		expect(wakes).toBe(0);
	});
});
