import { capturingReporter } from '@cupboard/cli-ui/testing';
import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import {
	expansionLocalStep,
	type LocalStepStatus
} from '@cupboard/protocol/deployment';
import { describe, expect, it } from 'vitest';

import { LocalStepUnreachedError } from '../errors.ts';

import { type SettlementClient, settleTenants } from './settlement.ts';

const tenant = tenantIdSchema.parse('pending');
const pending: LocalStepStatus = {
	current: expansionLocalStep,
	ready: 0,
	pending: 1,
	stragglers: [tenant]
};
const ready: LocalStepStatus = {
	current: expansionLocalStep,
	ready: 1,
	pending: 0,
	stragglers: []
};

describe('tenant settlement', () => {
	it('stops after readiness and queries the pre-contraction step', async () => {
		const requests: unknown[] = [];
		let status = pending;
		const client: SettlementClient = {
			status: (input) => {
				requests.push(input);
				return Promise.resolve(status);
			},
			wake: (input) => {
				requests.push(input);
				status = ready;
				return Promise.resolve({
					current: expansionLocalStep,
					woken: 1,
					failed: 0,
					outcomes: [{ tenant, kind: 'recorded', step: expansionLocalStep }]
				});
			}
		};
		const actual = await settleTenants(client, capturingReporter([]), {
			requiredStep: expansionLocalStep,
			limit: 20,
			maxPasses: 3
		});
		expect({ actual, requests }).toStrictEqual({
			actual: ready,
			requests: [
				{ requiredStep: expansionLocalStep },
				{ limit: 20 },
				{ requiredStep: expansionLocalStep }
			]
		});
	});

	it('bounds retries for a tenant which does not advance', async () => {
		let wakes = 0;
		const client: SettlementClient = {
			status: () => Promise.resolve(pending),
			wake: () => {
				wakes++;
				return Promise.resolve({
					current: expansionLocalStep,
					woken: 0,
					failed: 1,
					outcomes: [{ tenant, kind: 'unconfigured' }]
				});
			}
		};
		await expect(
			settleTenants(client, capturingReporter([]), {
				requiredStep: expansionLocalStep,
				limit: 20,
				maxPasses: 2
			})
		).rejects.toThrow(LocalStepUnreachedError);
		expect(wakes).toBe(2);
	});

	it('does not send a wake after cancellation', async () => {
		const controller = new AbortController();
		let wakes = 0;
		const client: SettlementClient = {
			status: () => {
				controller.abort();
				return Promise.resolve(pending);
			},
			wake: () => {
				wakes++;
				return Promise.resolve({
					current: expansionLocalStep,
					woken: 0,
					failed: 0,
					outcomes: []
				});
			}
		};
		await expect(
			settleTenants(client, capturingReporter([]), {
				requiredStep: expansionLocalStep,
				limit: 20,
				maxPasses: 2,
				signal: controller.signal
			})
		).rejects.toThrow();
		expect(wakes).toBe(0);
	});
});
