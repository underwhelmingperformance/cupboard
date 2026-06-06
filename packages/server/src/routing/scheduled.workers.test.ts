import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	offboardTenant,
	provisionNamedTenant,
	resetTestServer,
	suspendTenant,
	tenantMaintained,
	tenantMaintenanceFailureRow
} from '../test-support.ts';

import { runCronSweep, runOffboardSweep } from './scheduled.ts';

describe('scheduled tenant pass failure records', () => {
	beforeEach(resetTestServer);

	it('records maintenance failures durably while maintaining later tenants', async () => {
		await provisionNamedTenant('acme');
		await provisionNamedTenant('beta');
		await suspendTenant('v1');

		const seen: string[] = [];
		const firstFailure = new Error('maintenance failed');
		const error = await runCronSweep(env, 2, (_env, id) => {
			seen.push(id);

			if (id === 'acme') {
				return Promise.reject(firstFailure);
			}

			return Promise.resolve();
		}).catch((error_: unknown) => error_);
		const afterFailure = {
			acme: await tenantMaintenanceFailureRow('acme', 'maintenance'),
			beta: await tenantMaintenanceFailureRow('beta', 'maintenance'),
			acmeMaintained: await tenantMaintained('acme'),
			betaMaintained: await tenantMaintained('beta')
		};

		await runCronSweep(env, 1, () => Promise.resolve());
		const afterSuccess = await tenantMaintenanceFailureRow(
			'acme',
			'maintenance'
		);

		expect({
			error: error instanceof AggregateError,
			seen,
			afterFailure: {
				acme: {
					consecutiveFailures: afterFailure.acme?.consecutiveFailures,
					lastError: afterFailure.acme?.lastError,
					failed: afterFailure.acme?.lastFailedAt !== undefined,
					succeeded: afterFailure.acme?.lastSuccessAt !== undefined
				},
				beta: {
					consecutiveFailures: afterFailure.beta?.consecutiveFailures,
					lastError: afterFailure.beta?.lastError,
					failed: afterFailure.beta?.lastFailedAt !== undefined,
					succeeded: afterFailure.beta?.lastSuccessAt !== undefined
				},
				acmeMaintained: afterFailure.acmeMaintained,
				betaMaintained: afterFailure.betaMaintained
			},
			afterSuccess: {
				consecutiveFailures: afterSuccess?.consecutiveFailures,
				lastError: afterSuccess?.lastError,
				failed: afterSuccess?.lastFailedAt !== undefined,
				succeeded: afterSuccess?.lastSuccessAt !== undefined
			}
		}).toStrictEqual({
			error: true,
			seen: ['acme', 'beta'],
			afterFailure: {
				acme: {
					consecutiveFailures: 1,
					lastError: 'Error: maintenance failed',
					failed: true,
					succeeded: false
				},
				beta: {
					consecutiveFailures: 0,
					lastError: undefined,
					failed: false,
					succeeded: true
				},
				acmeMaintained: true,
				betaMaintained: true
			},
			afterSuccess: {
				consecutiveFailures: 0,
				lastError: 'Error: maintenance failed',
				failed: true,
				succeeded: true
			}
		});
	});

	it('bounds concurrent tenant maintenance passes', async () => {
		for (const tenant of ['acme', 'beta', 'gamma', 'delta', 'epsilon']) {
			await provisionNamedTenant(tenant);
		}
		await suspendTenant('v1');

		let active = 0;
		let maxActive = 0;
		const seen: string[] = [];

		await runCronSweep(env, 5, async (_env, id) => {
			seen.push(id);
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, 0));
			active -= 1;
		});

		expect({ seen, maxActive }).toStrictEqual({
			seen: ['acme', 'beta', 'delta', 'epsilon', 'gamma'],
			maxActive: 4
		});
	});

	it('records offboard failures durably and resets them after success', async () => {
		await provisionNamedTenant('acme');
		await provisionNamedTenant('beta');
		await offboardTenant('acme');
		await offboardTenant('beta');

		const seen: string[] = [];
		const error = await runOffboardSweep(env, 2, 1, 1, (_env, id) => {
			seen.push(id);

			if (id === 'acme') {
				return Promise.reject(new TypeError('offboard failed'));
			}

			return Promise.resolve();
		}).catch((error_: unknown) => error_);
		const afterFailure = {
			acme: await tenantMaintenanceFailureRow('acme', 'offboard'),
			beta: await tenantMaintenanceFailureRow('beta', 'offboard')
		};

		await runOffboardSweep(env, 1, 1, 1, () => Promise.resolve());
		const afterSuccess = await tenantMaintenanceFailureRow('acme', 'offboard');

		expect({
			error: error instanceof AggregateError,
			seen,
			afterFailure: {
				acme: {
					consecutiveFailures: afterFailure.acme?.consecutiveFailures,
					lastError: afterFailure.acme?.lastError,
					failed: afterFailure.acme?.lastFailedAt !== undefined,
					succeeded: afterFailure.acme?.lastSuccessAt !== undefined
				},
				beta: {
					consecutiveFailures: afterFailure.beta?.consecutiveFailures,
					lastError: afterFailure.beta?.lastError,
					failed: afterFailure.beta?.lastFailedAt !== undefined,
					succeeded: afterFailure.beta?.lastSuccessAt !== undefined
				}
			},
			afterSuccess: {
				consecutiveFailures: afterSuccess?.consecutiveFailures,
				lastError: afterSuccess?.lastError,
				failed: afterSuccess?.lastFailedAt !== undefined,
				succeeded: afterSuccess?.lastSuccessAt !== undefined
			}
		}).toStrictEqual({
			error: true,
			seen: ['acme', 'beta'],
			afterFailure: {
				acme: {
					consecutiveFailures: 1,
					lastError: 'TypeError: offboard failed',
					failed: true,
					succeeded: false
				},
				beta: {
					consecutiveFailures: 0,
					lastError: undefined,
					failed: false,
					succeeded: true
				}
			},
			afterSuccess: {
				consecutiveFailures: 0,
				lastError: 'TypeError: offboard failed',
				failed: true,
				succeeded: true
			}
		});
	});
});
