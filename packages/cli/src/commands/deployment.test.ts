import { capturingReporter as reporter } from '@cupboard/cli-ui/testing';
import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import {
	currentLocalStep,
	expansionLocalStep,
	type LocalStepStatus,
	type ParsedDeploymentPhaseResponse
} from '@cupboard/protocol/deployment';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import type { Reporter, ResultPayload } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import { LocalStepUnreachedError } from '../errors.ts';

import {
	type DeploymentClient,
	runDeploymentResume,
	runDeploymentStatus
} from './deployment.ts';

const tenant = tenantIdSchema.parse('acme');
const updatedAt = isoTimestampSchema.parse('2026-01-01T00:20:30.000Z');

const unrecorded: ParsedDeploymentPhaseResponse = {};
const nativeReads: ParsedDeploymentPhaseResponse = {
	phase: {
		name: 'native-reads',
		requiredLocalStep: expansionLocalStep,
		updatedAt
	}
};
const contracted: ParsedDeploymentPhaseResponse = {
	phase: { name: 'contracted', requiredLocalStep: currentLocalStep, updatedAt }
};

function statusFor(pending: number): LocalStepStatus {
	return {
		current: currentLocalStep,
		ready: 1,
		pending,
		stragglers: pending > 0 ? [tenant] : []
	};
}

function client(
	phase: ParsedDeploymentPhaseResponse,
	calls: unknown[],
	pending: { count: number }
): DeploymentClient {
	return {
		phase: () => {
			calls.push('phase');
			return Promise.resolve(phase);
		},
		localStep: {
			status: (input) => {
				calls.push(input);
				return Promise.resolve(statusFor(pending.count));
			},
			wake: (input) => {
				calls.push(input);
				pending.count = 0;
				return Promise.resolve({
					current: currentLocalStep,
					woken: 1,
					failed: 0,
					outcomes: [{ tenant, kind: 'recorded', step: currentLocalStep }]
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

const phases = [
	{ name: 'no phase', phase: unrecorded, label: 'not recorded', step: 4 },
	{ name: 'native-reads', phase: nativeReads, label: 'native-reads', step: 4 },
	{ name: 'contracted', phase: contracted, label: 'contracted', step: 5 }
] as const;

describe('runDeploymentStatus', () => {
	it.each(phases)(
		'reports the readiness at the step that $name requires',
		async ({ phase, label, step }) => {
			const payloads: ResultPayload[] = [];
			const calls: unknown[] = [];

			await runDeploymentStatus(
				payloadReporter(payloads),
				client(phase, calls, { count: 1 })
			);

			expect({ payloads, calls }).toStrictEqual({
				payloads: [
					{
						kind: 'deployment-status',
						data: { ...phase, ...statusFor(1) },
						rows: [
							{ label: 'Phase', value: label },
							{ label: 'Required local step', value: String(step) },
							{ label: 'Ready tenants', value: '1' },
							{ label: 'Pending tenants', value: '1' },
							{ label: 'Pending sample', value: 'acme' }
						]
					}
				],
				calls: ['phase', { requiredStep: step }]
			});
		}
	);
});

describe('runDeploymentResume', () => {
	it.each(phases)(
		'wakes tenants to the step that $name requires',
		async ({ phase, step }) => {
			const payloads: ResultPayload[] = [];
			const infos: string[] = [];
			const calls: unknown[] = [];

			await runDeploymentResume(
				payloadReporter(payloads, infos),
				client(phase, calls, { count: 1 }),
				{ limit: 20, maxPasses: 3 }
			);

			expect({ payloads, infos, calls }).toStrictEqual({
				payloads: [
					{
						kind: 'deployment-readiness',
						data: statusFor(0),
						rows: [
							{ label: 'Ready tenants', value: '1' },
							{ label: 'Local step', value: '5' }
						]
					}
				],
				infos: [
					'Tenant work is complete for this phase. Re-run cupboard deploy to finish the deployment.'
				],
				calls: [
					'phase',
					{ requiredStep: step },
					{ limit: 20 },
					{ requiredStep: step }
				]
			});
		}
	);

	it('fails when tenants remain below the step after the last pass', async () => {
		const failing: DeploymentClient = {
			...client(unrecorded, [], { count: 1 }),
			localStep: {
				status: () => Promise.resolve(statusFor(1)),
				wake: () =>
					Promise.resolve({
						current: currentLocalStep,
						woken: 0,
						failed: 1,
						outcomes: [{ tenant, kind: 'failed' }]
					})
			}
		};

		let caught: unknown;

		try {
			await runDeploymentResume(reporter([]), failing, {
				limit: 20,
				maxPasses: 2
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toStrictEqual(
			new LocalStepUnreachedError(1, expansionLocalStep, [tenant])
		);
	});
});
