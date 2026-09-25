import { capturingReporter as reporter } from '@cupboard/cli-ui/testing';
import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import {
	currentLocalStep,
	expansionLocalStep,
	type LocalStepStatus,
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

function statusFor(required: number, pending: number): LocalStepStatus {
	return {
		current: currentLocalStep,
		required,
		ready: 1,
		pending,
		stragglers: pending > 0 ? [tenant] : []
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
			status: (input) => {
				calls.push(input);
				return Promise.resolve(statusFor(input.requiredStep, pending.count));
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

describe('runDeploymentStatus', () => {
	it('reports each transition and the readiness at the step they require', async () => {
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
					{ label: 'Pending sample', value: 'acme' }
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
				{ label: 'Pending sample', value: '(none)' }
			]
		]);
	});
});

describe('runDeploymentResume', () => {
	it('settles the tenants to the step the transitions require', async () => {
		const results: ResultRow[][] = [];
		const infos: string[] = [];
		const calls: unknown[] = [];

		await runDeploymentResume(
			reporter(results, infos),
			client(complete, calls, { count: 1 }),
			{ limit: 20, maxPasses: 3 }
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

	it('fails once the passes are spent with tenants still behind', async () => {
		const pending = { count: 1 };
		const failing: DeploymentClient = {
			...client(expanded, [], pending),
			localStep: {
				status: (input) =>
					Promise.resolve(statusFor(input.requiredStep, pending.count)),
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
			runDeploymentResume(reporter([]), failing, { limit: 20, maxPasses: 2 })
		).rejects.toBeInstanceOf(LocalStepUnreachedError);
	});
});
