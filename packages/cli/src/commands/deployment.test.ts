import { capturingReporter as reporter } from '@cupboard/cli-ui/testing';
import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import {
	currentLocalStep,
	expansionLocalStep,
	type LocalStepStatus,
	type LocalStepSweep,
	localStepSweepChainIdSchema,
	type ParsedDeploymentTransitionsResponse
} from '@cupboard/protocol/deployment';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import type { ResultRow } from '@cupboard/reporter';
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
		{ id: 'deployment-transitions', state: 'complete', updatedAt: recorded }
	],
	requiredLocalStep: expansionLocalStep
};
const complete: ParsedDeploymentTransitionsResponse = {
	transitions: [
		{ id: 'cache-identity', state: 'complete', updatedAt: recorded },
		{ id: 'deployment-transitions', state: 'complete', updatedAt: recorded }
	],
	requiredLocalStep: currentLocalStep
};

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

// A client whose one pending tenant the first wake advances; the settlement
// then observes one running poll before the status reports nothing pending.
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
					statusFor(input.requiredStep, pending.count, sweep)
				);
			},
			wake: (input) => {
				calls.push(input);
				pending.count = 0;
				return Promise.resolve({
					current: currentLocalStep,
					woken: 1,
					failed: 0,
					outcomes: [
						{ tenant, kind: 'recorded', step: transitions.requiredLocalStep }
					]
				});
			}
		}
	};
}

const resumeOptions = { limit: 20, delay: () => Promise.resolve() };

describe('runDeploymentStatus', () => {
	it('reports each transition, the readiness at the step they require, and the sweep', async () => {
		const results: ResultRow[][] = [];
		const calls: unknown[] = [];

		await runDeploymentStatus(
			reporter(results),
			client(expanded, calls, { count: 1 })
		);

		expect({ results, calls }).toStrictEqual({
			results: [
				[
					{
						label: 'Transition cache-identity',
						value: 'expanded since 2026-01-01 00:20 UTC'
					},
					{
						label: 'Transition deployment-transitions',
						value: 'complete since 2026-01-01 00:20 UTC'
					},
					{ label: 'Required local step', value: '4' },
					{ label: 'Ready tenants', value: '1' },
					{ label: 'Pending tenants', value: '1' },
					{ label: 'Pending sample', value: 'acme' },
					{ label: 'Sweep chain', value: 'idle' }
				]
			],
			calls: ['transitions', { requiredStep: expansionLocalStep }]
		});
	});

	it('says so when no transition has been recorded', async () => {
		const results: ResultRow[][] = [];

		await runDeploymentStatus(
			reporter(results),
			client({ transitions: [], requiredLocalStep: expansionLocalStep }, [], {
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
				nextAt: isoTimestampSchema.parse('2026-01-01T00:21:10.000Z'),
				outcomes: [
					{ tenant, kind: 'unconfigured' },
					{ tenant: tenantIdSchema.parse('beta'), kind: 'failed' },
					{
						tenant: tenantIdSchema.parse('gamma'),
						kind: 'recorded',
						step: expansionLocalStep
					}
				]
			} satisfies LocalStepSweep,
			rows: [
				{
					label: 'Sweep chain',
					value: `stalled · chain ${chain} at link 3 · 2026-01-01 00:20 UTC · next batch 2026-01-01 00:21 UTC`
				},
				{
					label: 'Last batch',
					value:
						'1 unconfigured, 1 failed, 1 recorded · acme unconfigured, beta failed'
				}
			]
		},
		{
			name: 'a chain that ended',
			sweep: {
				state: 'idle',
				last: {
					chain,
					link: 2,
					updatedAt: recorded,
					outcomes: [{ tenant, kind: 'recorded', step: expansionLocalStep }]
				}
			} satisfies LocalStepSweep,
			rows: [
				{
					label: 'Sweep chain',
					value: `idle · last chain ${chain} ended at link 2 · 2026-01-01 00:20 UTC`
				},
				{ label: 'Last batch', value: '1 recorded' }
			]
		}
	])('describes $name', async ({ sweep, rows }) => {
		const results: ResultRow[][] = [];

		await runDeploymentStatus(
			reporter(results),
			client(expanded, [], { count: 1 }, sweep)
		);

		expect(results[0]?.slice(-rows.length)).toStrictEqual(rows);
	});
});

describe('runDeploymentResume', () => {
	it('settles the tenants to the step the transitions require by observing the sweep', async () => {
		const results: ResultRow[][] = [];
		const infos: string[] = [];
		const calls: unknown[] = [];

		await runDeploymentResume(
			reporter(results, infos),
			client(complete, calls, { count: 1 }),
			resumeOptions
		);

		expect({ results, infos, calls }).toStrictEqual({
			results: [
				[
					{ label: 'Ready tenants', value: '1' },
					{ label: 'Local step', value: '5' }
				]
			],
			infos: [
				'Tenant work is complete for this transition. Re-run cupboard deploy to finish the deployment.'
			],
			calls: [
				'transitions',
				{ requiredStep: currentLocalStep },
				{ limit: 20 },
				{ requiredStep: currentLocalStep }
			]
		});
	});

	it('fails when the sweep stalls with tenants still behind', async () => {
		const pending = { count: 1 };
		const stalled: LocalStepSweep = {
			state: 'stalled',
			chain,
			link: 1,
			updatedAt: recorded,
			nextAt: recorded,
			outcomes: [{ tenant, kind: 'failed' }]
		};
		const failing: DeploymentClient = {
			...client(expanded, [], pending),
			localStep: {
				status: (input) =>
					Promise.resolve(
						statusFor(input.requiredStep, pending.count, stalled)
					),
				wake: () =>
					Promise.resolve({
						current: currentLocalStep,
						woken: 0,
						failed: 1,
						outcomes: [{ tenant, kind: 'failed' }]
					})
			}
		};

		await expect(
			runDeploymentResume(reporter([]), failing, resumeOptions)
		).rejects.toBeInstanceOf(LocalStepUnreachedError);
	});
});
