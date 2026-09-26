import { capturingReporter as reporter } from '@cupboard/cli-ui/testing';
import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import {
	currentLocalStep,
	expansionLocalStep,
	type LocalStep,
	type LocalStepStatus,
	type LocalStepSweep,
	localStepSweepChainIdSchema,
	type ParsedDeploymentTransitionsResponse,
	requiredLocalStepFrom
} from '@cupboard/protocol/deployment';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import type { Reporter, ResultPayload, ResultRow } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import { LocalStepUnreachedError } from '../errors.ts';

import {
	type DeploymentClient,
	runDeploymentResume,
	runDeploymentStatus
} from './deployment.ts';

const tenant = tenantIdSchema.parse('acme');
const recorded = isoTimestampSchema.parse('2026-01-01T00:20:30.000Z');
const chain = localStepSweepChainIdSchema.parse(
	'00000000-0000-4000-8000-00000000000a'
);
const idle: LocalStepSweep = { state: 'idle' };

const expanded: ParsedDeploymentTransitionsResponse = {
	transitions: [
		{ id: 'cache-identity', state: 'expanded', updatedAt: recorded },
		{ id: 'deployment-transitions', state: 'complete', updatedAt: recorded },
		{ id: 'local-step-sweep', state: 'complete', updatedAt: recorded }
	],
	unrecognised: []
};
const complete: ParsedDeploymentTransitionsResponse = {
	transitions: [
		{ id: 'cache-identity', state: 'complete', updatedAt: recorded },
		{ id: 'deployment-transitions', state: 'complete', updatedAt: recorded },
		{ id: 'local-step-sweep', state: 'complete', updatedAt: recorded }
	],
	unrecognised: []
};

// The required local step that the server derives from the recorded states.
function requiredStepOf(
	response: ParsedDeploymentTransitionsResponse
): LocalStep {
	return requiredLocalStepFrom(
		new Map(
			response.transitions.map((transition) => [
				transition.id,
				transition.state
			])
		)
	);
}

function statusFor(
	required: number,
	pending: number,
	sweep: LocalStepSweep = idle
): LocalStepStatus {
	return {
		current: currentLocalStep,
		required,
		ready: 1,
		pending,
		stragglers: pending > 0 ? [tenant] : [],
		sweep
	};
}

// A client with `pending.count` pending tenants, which the first wake
// advances. The first status after the wake reports no pending tenant.
function client(
	transitions: ParsedDeploymentTransitionsResponse,
	calls: unknown[],
	pending: { count: number },
	sweep: LocalStepSweep = idle
): DeploymentClient {
	return {
		transitions: () => {
			calls.push('transitions');
			return Promise.resolve(transitions);
		},
		localStep: {
			status: (input) => {
				calls.push(input);
				return Promise.resolve(
					statusFor(
						input.requiredStep ?? requiredStepOf(transitions),
						pending.count,
						sweep
					)
				);
			},
			wake: (input) => {
				calls.push(input);
				pending.count = 0;
				return Promise.resolve({
					current: currentLocalStep,
					required: requiredStepOf(transitions),
					woken: 1,
					failed: 0,
					outcomes: [
						{
							tenant,
							kind: 'recorded',
							step: requiredStepOf(transitions),
							progressed: true
						}
					],
					chain: { kind: 'none' }
				});
			}
		}
	};
}

// A reporter that also keeps each result payload, so a test can assert the
// `data` that `--json` prints.
function payloadReporter(
	payloads: ResultPayload[],
	infos: string[] = []
): Reporter {
	const base = reporter([], infos);

	return {
		...base,
		result: (payload) => {
			payloads.push(payload);
			base.result(payload);
		}
	};
}

const since = 'since 2026-01-01 00:20 UTC';
const failedOutcome = {
	tenant,
	kind: 'failed' as const,
	error: 'Error: tenant object unavailable'
};
const resumeOptions = { limit: 20, delay: () => Promise.resolve() };

// Rows that this build does not define, and what each command prints for them.
const unrecognisedCases = [
	{
		name: 'an expanded transition',
		row: { id: 'later-transition', state: 'expanded' },
		value: `expanded ${since}; this build does not define this transition, and no contract migration of it has started, so cupboard deploy leaves it unchanged`,
		isRefused: false
	},
	{
		name: 'a complete transition without contract migrations',
		row: { id: 'later-transition', state: 'complete' },
		value: `complete ${since}; this build does not define this transition, and no contract migration of it has started, so cupboard deploy leaves it unchanged`,
		isRefused: false
	},
	{
		name: 'a contracted transition',
		row: {
			id: 'later-transition',
			state: 'complete',
			contractedAt: recorded
		},
		value: `complete ${since}; this build does not define this transition, and cupboard deploy stops because its contract migrations have started and may have removed schema that this build needs`,
		isRefused: true
	},
	{
		name: 'an expanded transition whose contract migrations have started',
		row: {
			id: 'later-transition',
			state: 'expanded',
			contractedAt: recorded
		},
		value: `expanded ${since}; this build does not define this transition, and cupboard deploy stops because its contract migrations have started and may have removed schema that this build needs`,
		isRefused: true
	},
	{
		name: 'a state of a defined transition',
		row: { id: 'cache-identity', state: 'later-state' },
		value: `later-state ${since}, which this build does not define; deploy a build that defines this transition and state`,
		isRefused: true
	}
];

describe('runDeploymentStatus', () => {
	it('reports each transition, the readiness at the required local step, and the sweep', async () => {
		const payloads: ResultPayload[] = [];
		const calls: unknown[] = [];

		await runDeploymentStatus(
			payloadReporter(payloads),
			client(expanded, calls, { count: 1 })
		);

		expect({ payloads, calls }).toStrictEqual({
			payloads: [
				{
					kind: 'deployment-status',
					data: {
						transitions: expanded.transitions,
						unrecognised: [],
						...statusFor(expansionLocalStep, 1)
					},
					rows: [
						{
							label: 'Transition cache-identity',
							value: `expanded ${since}`
						},
						{
							label: 'Transition deployment-transitions',
							value: `complete ${since}`
						},
						{
							label: 'Transition local-step-sweep',
							value: `complete ${since}`
						},
						{ label: 'Required local step', value: '4' },
						{ label: 'Ready tenants', value: '1' },
						{ label: 'Pending tenants', value: '1' },
						{ label: 'Pending sample', value: 'acme' },
						{ label: 'Sweep chain', value: 'idle' }
					]
				}
			],
			calls: ['transitions', {}]
		});
	});

	it.each(unrecognisedCases)(
		'lists $name that this build does not define',
		async ({ row, value }) => {
			const payloads: ResultPayload[] = [];
			const unrecognised = [{ ...row, updatedAt: recorded }];

			await runDeploymentStatus(
				payloadReporter(payloads),
				client({ ...complete, unrecognised }, [], { count: 0 })
			);

			expect(payloads).toStrictEqual([
				{
					kind: 'deployment-status',
					data: {
						transitions: complete.transitions,
						unrecognised,
						...statusFor(currentLocalStep, 0)
					},
					rows: [
						{
							label: 'Transition cache-identity',
							value: `complete ${since}`
						},
						{
							label: 'Transition deployment-transitions',
							value: `complete ${since}`
						},
						{
							label: 'Transition local-step-sweep',
							value: `complete ${since}`
						},
						{ label: `Transition ${row.id}`, value },
						{ label: 'Required local step', value: '5' },
						{ label: 'Ready tenants', value: '1' },
						{ label: 'Pending tenants', value: '0' },
						{ label: 'Pending sample', value: '(none)' },
						{ label: 'Sweep chain', value: 'idle' }
					]
				}
			]);
		}
	);

	it("reports 'none recorded' when no transition has been recorded", async () => {
		const results: ResultRow[][] = [];

		await runDeploymentStatus(
			reporter(results),
			client({ transitions: [], unrecognised: [] }, [], {
				count: 0
			})
		);

		expect(results).toStrictEqual([
			[
				{ label: 'Transitions', value: 'none recorded' },
				{ label: 'Required local step', value: '4' },
				{ label: 'Ready tenants', value: '1' },
				{ label: 'Pending tenants', value: '0' },
				{ label: 'Pending sample', value: '(none)' },
				{ label: 'Sweep chain', value: 'idle' }
			]
		]);
	});

	it.each([
		{
			name: 'a stalled chain',
			sweep: {
				state: 'stalled',
				chain,
				link: 3,
				updatedAt: recorded,
				batchAt: recorded,
				nextAt: isoTimestampSchema.parse('2026-01-01T00:21:10.000Z'),
				wokenWithoutWork: 5,
				stalledAt: recorded,
				outcomes: [
					{ tenant, kind: 'unconfigured' },
					{
						tenant: tenantIdSchema.parse('beta'),
						kind: 'failed',
						error: 'Error: tenant object unavailable'
					},
					{
						tenant: tenantIdSchema.parse('delta'),
						kind: 'advanced',
						projected: 0,
						progressed: false,
						step: 3
					},
					{
						tenant: tenantIdSchema.parse('epsilon'),
						kind: 'advanced',
						projected: 0,
						progressed: true
					},
					{
						tenant: tenantIdSchema.parse('gamma'),
						kind: 'recorded',
						step: expansionLocalStep,
						progressed: true
					}
				],
				failing: [
					{
						tenant: tenantIdSchema.parse('beta'),
						failures: 3,
						error: 'Error: tenant object unavailable'
					}
				]
			} satisfies LocalStepSweep,
			rows: [
				{
					label: 'Sweep chain',
					value: `stalled ${since} · chain ${chain} at link 3 · no work done in the last 5 tenant wakes · updated 2026-01-01 00:20 UTC · next batch 2026-01-01 00:21 UTC`
				},
				{
					label: 'Last batch',
					value:
						'2026-01-01 00:20 UTC · 1 unconfigured, 1 failed, 1 did no work, 1 did work, 1 recorded · acme unconfigured, beta failed (Error: tenant object unavailable), delta did no work (step 3 recorded)'
				},
				{
					label: 'Failing tenants',
					value:
						'beta failed 3 wakes in a row (Error: tenant object unavailable)'
				}
			]
		},
		{
			name: 'an idle sweep after a chain',
			sweep: {
				state: 'idle',
				last: {
					chain,
					link: 2,
					updatedAt: recorded,
					batchAt: recorded,
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
			} satisfies LocalStepSweep,
			rows: [
				{
					label: 'Sweep chain',
					value: `idle · last chain ${chain} at link 2 · updated 2026-01-01 00:20 UTC`
				},
				{ label: 'Last batch', value: '2026-01-01 00:20 UTC · 1 recorded' }
			]
		}
	])('describes $name', async ({ sweep, rows }) => {
		const results: ResultRow[][] = [];

		await runDeploymentStatus(
			reporter(results),
			client(expanded, [], { count: 1 }, sweep)
		);

		expect(results).toStrictEqual([
			[
				{ label: 'Transition cache-identity', value: `expanded ${since}` },
				{
					label: 'Transition deployment-transitions',
					value: `complete ${since}`
				},
				{ label: 'Transition local-step-sweep', value: `complete ${since}` },
				{ label: 'Required local step', value: '4' },
				{ label: 'Ready tenants', value: '1' },
				{ label: 'Pending tenants', value: '1' },
				{ label: 'Pending sample', value: 'acme' },
				...rows
			]
		]);
	});
});

describe('runDeploymentResume', () => {
	it.each([
		{
			name: 'every transition is complete',
			transitions: complete,
			step: currentLocalStep,
			info: 'Every active or suspended tenant has reached local step 5, and every schema transition is complete.'
		},
		{
			name: 'cache-identity is still expanded',
			transitions: expanded,
			step: expansionLocalStep,
			info: 'Every active or suspended tenant has reached local step 4. Re-run cupboard deploy to complete cache-identity.'
		}
	])(
		'wakes once and polls the sweep until each tenant has reached the required local step, and reports the next action when $name',
		async ({ transitions, step, info }) => {
			const payloads: ResultPayload[] = [];
			const infos: string[] = [];
			const calls: unknown[] = [];

			await runDeploymentResume(
				payloadReporter(payloads, infos),
				client(transitions, calls, { count: 1 }),
				resumeOptions
			);

			expect({ payloads, infos, calls }).toStrictEqual({
				payloads: [
					{
						kind: 'deployment-readiness',
						data: statusFor(step, 0),
						rows: [
							{ label: 'Ready tenants', value: '1' },
							{ label: 'Required local step', value: String(step) }
						]
					}
				],
				infos: [info],
				calls: [{}, { limit: 20 }, {}, 'transitions']
			});
		}
	);

	it.each(unrecognisedCases)(
		'lists $name that this build does not define and leaves it out of the transitions to complete',
		async ({ row, value, isRefused }) => {
			const payloads: ResultPayload[] = [];
			const infos: string[] = [];
			const transitions = {
				transitions: complete.transitions.filter(
					(transition) => transition.id !== row.id
				),
				unrecognised: [{ ...row, updatedAt: recorded }]
			};
			const step = requiredStepOf(transitions);

			await runDeploymentResume(
				payloadReporter(payloads, infos),
				client(transitions, [], { count: 0 }),
				resumeOptions
			);

			expect({ payloads, infos }).toStrictEqual({
				payloads: [
					{
						kind: 'deployment-readiness',
						data: statusFor(step, 0),
						rows: [
							{ label: 'Ready tenants', value: '1' },
							{ label: 'Required local step', value: String(step) },
							{ label: `Transition ${row.id}`, value }
						]
					}
				],
				infos: [
					isRefused
						? `Every active or suspended tenant has reached local step ${String(step)}. This build's cupboard deploy stops on ${row.id}, as listed above.`
						: `Every active or suspended tenant has reached local step ${String(step)}, and every schema transition is complete.`
				]
			});
		}
	);

	it('fails when the sweep reports a stall with tenants still below the step', async () => {
		const pending = { count: 1 };
		const stalled: LocalStepSweep = {
			state: 'stalled',
			chain,
			link: 2,
			updatedAt: recorded,
			batchAt: recorded,
			nextAt: isoTimestampSchema.parse('2026-01-01T00:20:50.000Z'),
			wokenWithoutWork: 2,
			stalledAt: recorded,
			outcomes: [failedOutcome],
			failing: [{ tenant, failures: 5, error: failedOutcome.error }]
		};
		const failing: DeploymentClient = {
			...client(expanded, [], pending),
			localStep: {
				status: (input) =>
					Promise.resolve(
						statusFor(
							input.requiredStep ?? requiredStepOf(expanded),
							pending.count,
							stalled
						)
					),
				wake: () =>
					Promise.resolve({
						current: currentLocalStep,
						required: expansionLocalStep,
						woken: 0,
						failed: 1,
						outcomes: [failedOutcome],
						chain: { kind: 'kept' }
					})
			}
		};

		let caught: unknown;

		try {
			await runDeploymentResume(reporter([]), failing, resumeOptions);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(LocalStepUnreachedError);
		expect({
			reason: caught instanceof LocalStepUnreachedError && caught.reason,
			pending: caught instanceof LocalStepUnreachedError && caught.pending,
			requiredStep:
				caught instanceof LocalStepUnreachedError && caught.requiredStep,
			stragglers: caught instanceof LocalStepUnreachedError && caught.stragglers
		}).toStrictEqual({
			reason: { kind: 'stalled', outcomes: [failedOutcome] },
			pending: 1,
			requiredStep: expansionLocalStep,
			stragglers: [tenant]
		});
	});
});
