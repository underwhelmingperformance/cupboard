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
import type { Reporter } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import { CliAbortError, LocalStepUnreachedError } from '../errors.ts';

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

function running(
	outcomes: LocalStepWakeOutcomes = [],
	wokenWithoutWork = 0
): LocalStepSweep {
	return {
		state: 'running',
		chain,
		link: 1,
		updatedAt: at,
		batchAt: at,
		nextAt: at,
		wokenWithoutWork,
		outcomes,
		failing: []
	};
}

// A sweep whose chain has confirmed a stall.
function stalled(outcomes: LocalStepWakeOutcomes): LocalStepSweep {
	return {
		state: 'stalled',
		chain,
		link: 2,
		updatedAt: at,
		batchAt: at,
		nextAt: at,
		wokenWithoutWork: 1,
		stalledAt: at,
		outcomes,
		failing: []
	};
}

function status(
	pending: number,
	sweep: LocalStepSweep,
	total = 1
): LocalStepStatus {
	return {
		current: currentLocalStep,
		required: expansionLocalStep,
		ready: total - pending,
		pending,
		stragglers: pending === 0 ? [] : [tenant],
		sweep
	};
}

const woke: LocalStepWakeResponse = {
	current: currentLocalStep,
	required: expansionLocalStep,
	woken: 1,
	failed: 0,
	outcomes: [
		{ tenant, kind: 'advanced', projected: 3, progressed: true, step: 3 }
	],
	chain: { kind: 'started', chain }
};

const wakeError = 'Error: tenant object unavailable';

// A client that answers each status poll from a script, in order, and records
// every request.
function scriptedClient(
	statuses: readonly LocalStepStatus[],
	requests: unknown[],
	wakes: readonly LocalStepWakeResponse[] = [woke]
): SettlementClient {
	let polls = 0;
	let woken = 0;

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
			const next = wakes[Math.min(woken, wakes.length - 1)] ?? woke;
			woken += 1;

			return Promise.resolve(next);
		}
	};
}

function emptyWake(): LocalStepWakeResponse {
	return {
		current: currentLocalStep,
		required: expansionLocalStep,
		woken: 0,
		failed: 0,
		outcomes: [],
		chain: { kind: 'none' }
	};
}

// The wake requests among those the client recorded.
function wakesIn(requests: readonly unknown[]): number {
	return requests.filter(
		(request) =>
			typeof request === 'object' && request !== null && 'limit' in request
	).length;
}

interface StepOutput {
	readonly messages: string[];
	readonly warns: string[];
}

const ignore = (): void => {
	// The settlement writes no step groups.
};

// Records the messages and warnings that the settlement writes to its step
// log.
function stepReporter(output: StepOutput): Reporter {
	return {
		...capturingReporter([]),
		steps: (_label, body) =>
			Promise.resolve(
				body({
					message: (message) => {
						output.messages.push(message);
					},
					group: () => ({ message: ignore, success: ignore, error: ignore }),
					warn: (label, value) => {
						output.warns.push(
							value === undefined ? label : `${label}: ${value}`
						);
					}
				})
			)
	};
}

function settle(
	client: SettlementClient,
	delays: number[],
	output?: StepOutput,
	signal?: AbortSignal
): Promise<LocalStepStatus> {
	return settleTenants(
		client,
		stepReporter(output ?? { messages: [], warns: [] }),
		{
			requiredStep: expansionLocalStep,
			limit: 20,
			delay: (ms) => {
				delays.push(ms);

				return Promise.resolve();
			},
			...(signal !== undefined && { signal })
		}
	);
}

async function settlementFailure(
	client: SettlementClient,
	output?: StepOutput
): Promise<unknown> {
	try {
		await settle(client, [], output);
	} catch (error) {
		return error;
	}

	return undefined;
}

// The error's fields other than its message.
function unreached(error: unknown) {
	if (!(error instanceof LocalStepUnreachedError)) {
		return error;
	}

	return {
		reason: error.reason,
		pending: error.pending,
		requiredStep: error.requiredStep,
		stragglers: error.stragglers
	};
}

describe('tenant settlement', () => {
	it('returns at once when no tenant is pending', async () => {
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

	it('wakes once, then polls the status every ten seconds until no tenant is pending', async () => {
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

	it('reports progress for each poll that changes the pending count, the sweep state or the wakes without work', async () => {
		const output: StepOutput = { messages: [], warns: [] };
		const idleTenant: LocalStepWakeOutcomes = [
			{ tenant, kind: 'advanced', projected: 0, progressed: false, step: 3 }
		];
		const client = scriptedClient(
			[
				status(3, idle, 3),
				status(3, running(), 3),
				status(3, running(), 3),
				status(3, running(idleTenant, 1), 3),
				status(2, running(), 3),
				status(0, idle, 3)
			],
			[]
		);

		await settle(client, [], output);

		expect(output).toStrictEqual({
			messages: [
				`3 of 3 tenants below local step 4 · sweep running, chain ${chain} at link 1`,
				`3 of 3 tenants below local step 4 · sweep running, chain ${chain} at link 1 · no work done in the last tenant wake · pending did no work (step 3 recorded)`,
				`2 of 3 tenants below local step 4 · sweep running, chain ${chain} at link 1`,
				'0 of 3 tenants below local step 4 · sweep idle'
			],
			warns: []
		});
	});

	it('keeps polling while the chain has woken tenants without work but has not confirmed a stall', async () => {
		const requests: unknown[] = [];
		const failed: LocalStepWakeOutcomes = [
			{ tenant, kind: 'failed', error: wakeError }
		];
		const client = scriptedClient(
			[
				status(40, idle, 40),
				status(40, running(failed, 20), 40),
				status(40, running(failed, 39), 40),
				status(0, idle, 40)
			],
			requests
		);

		const actual = await settle(client, []);

		expect({ actual, wakes: wakesIn(requests) }).toStrictEqual({
			actual: status(0, idle, 40),
			wakes: 1
		});
	});

	it("fails once the sweep reports a stall, with the stragglers and the last batch's outcomes", async () => {
		const requests: unknown[] = [];
		const output: StepOutput = { messages: [], warns: [] };
		const outcomes: LocalStepWakeOutcomes = [
			{ tenant, kind: 'unconfigured' },
			{
				tenant: tenantIdSchema.parse('broken'),
				kind: 'failed',
				error: wakeError
			},
			{
				tenant: tenantIdSchema.parse('idle'),
				kind: 'advanced',
				projected: 0,
				progressed: false
			}
		];
		const client = scriptedClient(
			[status(1, idle), status(1, running()), status(1, stalled(outcomes))],
			requests
		);

		const failure = await settlementFailure(client, output);

		expect(failure).toBeInstanceOf(LocalStepUnreachedError);
		expect({
			failure: unreached(failure),
			output,
			wakes: wakesIn(requests)
		}).toStrictEqual({
			failure: {
				reason: { kind: 'stalled', outcomes },
				pending: 1,
				requiredStep: expansionLocalStep,
				stragglers: [tenant]
			},
			output: {
				messages: [
					`1 of 1 tenants below local step 4 · sweep running, chain ${chain} at link 1`,
					`1 of 1 tenants below local step 4 · sweep stalled, chain ${chain} at link 2 · no work done in the last tenant wake · pending unconfigured, broken failed (Error: tenant object unavailable), idle did no work (no step recorded)`
				],
				warns: [
					'pending: Tenant creation is incomplete. Repeat its creation with the original configuration.',
					'broken: Tenant migration failed. Inspect the tenant Worker logs before retrying.'
				]
			},
			wakes: 1
		});
	});

	// A tenant with many legacy caches reports more work on each wake while its
	// schema migrations and catalogue reconciliation run in pages. None of those
	// wakes projects a cache, but each one saves progress.
	it('keeps polling while a tenant does work on every wake without projecting any caches', async () => {
		const requests: unknown[] = [];
		const migrating: LocalStepWakeOutcomes = [
			{ tenant, kind: 'advanced', projected: 0, progressed: true }
		];
		const client = scriptedClient(
			[
				status(1, idle),
				...Array.from({ length: 15 }, () => status(1, running(migrating))),
				status(0, idle)
			],
			requests
		);

		const actual = await settle(client, []);

		expect({ actual, wakes: wakesIn(requests) }).toStrictEqual({
			actual: status(0, idle),
			wakes: 1
		});
	});

	it('restarts a stopped chain up to three times, then fails', async () => {
		const requests: unknown[] = [];
		const outcomes: LocalStepWakeOutcomes = [
			{ tenant, kind: 'advanced', projected: 1, progressed: true, step: 3 }
		];
		const stopped: LocalStepSweep = {
			state: 'idle',
			last: {
				chain,
				link: 4,
				updatedAt: at,
				batchAt: at,
				outcomes,
				failing: []
			}
		};
		const client = scriptedClient(
			[
				status(1, idle),
				status(1, running()),
				status(1, stopped),
				status(1, stopped),
				status(1, running()),
				status(1, stopped),
				status(1, stopped)
			],
			requests
		);

		const failure = await settlementFailure(client);

		expect(failure).toBeInstanceOf(LocalStepUnreachedError);
		expect({
			failure: unreached(failure),
			wakes: wakesIn(requests)
		}).toStrictEqual({
			failure: {
				reason: { kind: 'chain-stopped', outcomes },
				pending: 1,
				requiredStep: expansionLocalStep,
				stragglers: [tenant]
			},
			wakes: 1 + maxChainRestarts
		});
	});

	it('counts the restarts again after the pending count falls', async () => {
		const requests: unknown[] = [];
		const stopped: LocalStepSweep = {
			state: 'idle',
			last: {
				chain,
				link: 4,
				updatedAt: at,
				batchAt: at,
				outcomes: [],
				failing: []
			}
		};
		const client = scriptedClient(
			[
				status(3, idle, 3),
				status(3, stopped, 3),
				status(3, stopped, 3),
				status(3, stopped, 3),
				status(2, running(), 3),
				status(2, stopped, 3),
				status(0, idle, 3)
			],
			requests
		);

		const actual = await settle(client, []);

		expect({ actual, wakes: wakesIn(requests) }).toStrictEqual({
			actual: status(0, idle, 3),
			wakes: 5
		});
	});

	it('reports each failing tenant once across all polls', async () => {
		const output: StepOutput = { messages: [], warns: [] };
		const failed: LocalStepWakeOutcomes = [
			{ tenant, kind: 'failed', error: wakeError }
		];
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
						batchAt: at,
						outcomes: [
							{
								tenant,
								kind: 'recorded',
								step: expansionLocalStep,
								progressed: true
							}
						],
						failing: []
					}
				})
			],
			[]
		);

		await settle(client, [], output);

		expect(output).toStrictEqual({
			messages: [
				`1 of 1 tenants below local step 4 · sweep running, chain ${chain} at link 1 · pending failed (Error: tenant object unavailable)`,
				'0 of 1 tenants below local step 4 · sweep idle'
			],
			warns: [
				'pending: Tenant migration failed. Inspect the tenant Worker logs before retrying.'
			]
		});
	});

	// The wake selects tenants below the server's required local step, so it
	// can select none while tenants are still below a higher step that the
	// caller counts against. It also selects none when another wake or a chain
	// has recorded the last pending tenants since the settlement read the
	// status.
	it.each([
		{
			name: 'fails when the pending tenants are not below the server step',
			afterWake: { ...status(1, idle), required: currentLocalStep },
			result: {
				reason: { kind: 'above-required' },
				pending: 1,
				requiredStep: currentLocalStep,
				stragglers: [tenant]
			}
		},
		{
			name: 'succeeds when the last pending tenant reaches the step before the wake',
			afterWake: status(0, idle),
			result: status(0, idle)
		}
	])('$name', async ({ afterWake, result }) => {
		const requests: unknown[] = [];
		const client = scriptedClient([status(1, idle), afterWake], requests, [
			emptyWake()
		]);
		let outcome: unknown;

		try {
			outcome = await settle(client, []);
		} catch (error) {
			outcome = unreached(error);
		}

		expect({ outcome, requests }).toStrictEqual({
			outcome: result,
			requests: [
				{ requiredStep: expansionLocalStep },
				{ limit: 20 },
				{ requiredStep: expansionLocalStep }
			]
		});
	});

	it('warns when the wake could not start the sweep chain', async () => {
		const output: StepOutput = { messages: [], warns: [] };
		const client = scriptedClient(
			[status(1, idle), status(0, idle)],
			[],
			[
				{
					...woke,
					chain: { kind: 'failed', error: 'D1FaultError: injected D1 fault' }
				}
			]
		);

		await settle(client, [], output);

		expect(output).toStrictEqual({
			messages: ['0 of 1 tenants below local step 4 · sweep idle'],
			warns: [
				'Sweep chain: The control Worker could not start or end the sweep chain: D1FaultError: injected D1 fault'
			]
		});
	});

	it('does not send a wake after cancellation', async () => {
		const controller = new AbortController();
		const reason = new CliAbortError();
		let wakes = 0;
		const client: SettlementClient = {
			status: () => {
				controller.abort(reason);

				return Promise.resolve(status(1, idle));
			},
			wake: () => {
				wakes++;

				return Promise.resolve(woke);
			}
		};

		await expect(settle(client, [], undefined, controller.signal)).rejects.toBe(
			reason
		);
		expect(wakes).toBe(0);
	});
});
