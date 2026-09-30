import { capturingReporter as reporter } from '@cupboard/cli-ui/testing';
import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import {
	currentLocalStep,
	expansionLocalStep,
	type LocalStep,
	type LocalStepStatus,
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

const expanded: ParsedDeploymentTransitionsResponse = {
	transitions: [
		{ id: 'cache-identity', state: 'expanded', updatedAt: recorded },
		{ id: 'deployment-transitions', state: 'complete', updatedAt: recorded },
		{ id: 'attestation-path-index', state: 'expanded', updatedAt: recorded },
		{ id: 'local-step-attempts', state: 'complete', updatedAt: recorded },
		{ id: 'publication-identity', state: 'complete', updatedAt: recorded }
	],
	unrecognised: []
};
const complete: ParsedDeploymentTransitionsResponse = {
	transitions: [
		{ id: 'cache-identity', state: 'complete', updatedAt: recorded },
		{ id: 'deployment-transitions', state: 'complete', updatedAt: recorded },
		{ id: 'attestation-path-index', state: 'complete', updatedAt: recorded },
		{ id: 'local-step-attempts', state: 'complete', updatedAt: recorded },
		{ id: 'publication-identity', state: 'complete', updatedAt: recorded }
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

// A status in which every pending tenant is unwoken.
function statusFor(required: number, pending: number): LocalStepStatus {
	return {
		current: currentLocalStep,
		required,
		ready: 1,
		pending,
		working: 0,
		stalled: 0,
		unwoken: pending,
		stalledSample: [],
		unwokenSample: pending > 0 ? [{ tenant }] : []
	};
}

function client(
	transitions: ParsedDeploymentTransitionsResponse,
	calls: unknown[],
	pending: { count: number }
): DeploymentClient {
	return {
		transitions: () => {
			calls.push('transitions');
			return Promise.resolve(transitions);
		},
		localStep: {
			status: () => {
				calls.push('status');
				return Promise.resolve(
					statusFor(requiredStepOf(transitions), pending.count)
				);
			},
			wake: () => {
				calls.push('wake');
				const woken = pending.count;
				pending.count = 0;
				return Promise.resolve({
					required: requiredStepOf(transitions),
					enqueued: woken,
					pending: woken
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

// Rows that this build does not define, and what each command prints for them.
const unrecognisedCases = [
	{
		name: 'a later-release row in state expanded',
		row: { id: 'later-transition', state: 'expanded' },
		value: `expanded ${since}; this build does not define this transition, and no contract migration of it has started, so cupboard deploy leaves it unchanged`,
		isRefused: false
	},
	{
		name: 'a later-release row in state complete, with no contract migration started',
		row: { id: 'later-transition', state: 'complete' },
		value: `complete ${since}; this build does not define this transition, and no contract migration of it has started, so cupboard deploy leaves it unchanged`,
		isRefused: false
	},
	{
		name: 'a later-release row in state complete, with its contract migrations started',
		row: {
			id: 'later-transition',
			state: 'complete',
			contractedAt: recorded
		},
		value: `complete ${since}; this build does not define this transition, and cupboard deploy stops because its contract migrations have started and may have removed schema that this build needs`,
		isRefused: true
	},
	{
		name: 'a later-release row in state expanded, with its contract migrations started',
		row: {
			id: 'later-transition',
			state: 'expanded',
			contractedAt: recorded
		},
		value: `expanded ${since}; this build does not define this transition, and cupboard deploy stops because its contract migrations have started and may have removed schema that this build needs`,
		isRefused: true
	},
	{
		name: 'an unknown state of cache-identity',
		row: { id: 'cache-identity', state: 'later-state' },
		value: `later-state ${since}; this build defines the transition but not state 'later-state', so cupboard deploy stops; deploy a build that defines that state`,
		isRefused: true
	},
	{
		name: 'a later-release row in an unknown state',
		row: { id: 'later-transition', state: 'later-state' },
		value: `later-state ${since}; this build defines neither the transition nor the state, so cupboard deploy stops; deploy a build that defines both`,
		isRefused: true
	}
];

describe('runDeploymentStatus', () => {
	it('reports each transition and the readiness at the required local step', async () => {
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
							label: 'Transition attestation-path-index',
							value: `expanded ${since}`
						},
						{
							label: 'Transition local-step-attempts',
							value: `complete ${since}`
						},
						{
							label: 'Transition publication-identity',
							value: `complete ${since}`
						},
						{ label: 'Required local step', value: '4' },
						{ label: 'Ready tenants', value: '1' },
						{
							label: 'Pending tenants',
							value: '1 (working 0, stalled 0, unwoken 1)'
						},
						{
							label: 'Not yet woken',
							value: 'acme: no attempt at the outstanding work'
						}
					]
				}
			],
			calls: ['transitions', 'status']
		});
	});

	it.each(unrecognisedCases)('lists $name', async ({ row, value }) => {
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
						label: 'Transition attestation-path-index',
						value: `complete ${since}`
					},
					{
						label: 'Transition local-step-attempts',
						value: `complete ${since}`
					},
					{
						label: 'Transition publication-identity',
						value: `complete ${since}`
					},
					{ label: `Transition ${row.id}`, value },
					{ label: 'Required local step', value: '5' },
					{ label: 'Ready tenants', value: '1' },
					{
						label: 'Pending tenants',
						value: '0 (working 0, stalled 0, unwoken 0)'
					}
				]
			}
		]);
	});

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
				{
					label: 'Pending tenants',
					value: '0 (working 0, stalled 0, unwoken 0)'
				}
			]
		]);
	});

	it('lists the sampled stalled and unwoken tenants and counts the others', async () => {
		const results: ResultRow[][] = [];
		const status: LocalStepStatus = {
			current: currentLocalStep,
			required: expansionLocalStep,
			ready: 4,
			pending: 4,
			working: 1,
			stalled: 2,
			unwoken: 1,
			stalledSample: [
				{
					tenant: 'acme',
					attemptedAt: '2026-01-01T00:31:04.000Z',
					progressedAt: '2026-01-01T00:02:11.000Z',
					error: 'InjectedPageFault'
				}
			],
			unwokenSample: [{ tenant: 'gamma' }]
		};

		await runDeploymentStatus(reporter(results), {
			...client(expanded, [], { count: 0 }),
			localStep: {
				status: () => Promise.resolve(status),
				wake: () => Promise.reject(new Error('status does not wake'))
			}
		});

		expect(results).toStrictEqual([
			[
				{ label: 'Transition cache-identity', value: `expanded ${since}` },
				{
					label: 'Transition deployment-transitions',
					value: `complete ${since}`
				},
				{
					label: 'Transition attestation-path-index',
					value: `expanded ${since}`
				},
				{ label: 'Transition local-step-attempts', value: `complete ${since}` },
				{
					label: 'Transition publication-identity',
					value: `complete ${since}`
				},
				{ label: 'Required local step', value: '4' },
				{ label: 'Ready tenants', value: '4' },
				{
					label: 'Pending tenants',
					value: '4 (working 1, stalled 2, unwoken 1)'
				},
				{
					label: 'Stalled',
					value:
						'acme: attempted 2026-01-01 00:31 UTC, last progress 2026-01-01 00:02 UTC, InjectedPageFault'
				},
				{
					label: 'Not yet woken',
					value: 'gamma: no attempt at the outstanding work'
				},
				{ label: 'Not listed', value: '1 more stalled or unwoken tenants' }
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
			info: 'Every active or suspended tenant has reached local step 4. Re-run cupboard deploy to complete cache-identity, attestation-path-index.'
		}
	])(
		'wakes tenants to the required local step and reports the next action when $name',
		async ({ transitions, step, info }) => {
			const payloads: ResultPayload[] = [];
			const infos: string[] = [];
			const calls: unknown[] = [];

			await runDeploymentResume(
				payloadReporter(payloads, infos),
				client(transitions, calls, { count: 1 }),
				{}
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
				calls: ['status', 'wake', 'status', 'transitions']
			});
		}
	);

	it.each(unrecognisedCases)(
		'lists $name and leaves it out of the transitions to complete',
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
				{}
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

	it('fails when no tenant has worked for the stall window after the wake', async () => {
		let now = 0;
		const stalled = statusFor(expansionLocalStep, 1);
		const failing: DeploymentClient = {
			...client(expanded, [], { count: 1 }),
			localStep: {
				status: () => Promise.resolve(stalled),
				wake: () =>
					Promise.resolve({
						required: expansionLocalStep,
						enqueued: 1,
						pending: 1
					})
			}
		};

		let caught: unknown;

		try {
			await runDeploymentResume(reporter([]), failing, {
				now: () => now,
				delay: (ms) => {
					now += ms;

					return Promise.resolve();
				}
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toStrictEqual(
			new LocalStepUnreachedError({ kind: 'stalled', status: stalled })
		);
	});
});
