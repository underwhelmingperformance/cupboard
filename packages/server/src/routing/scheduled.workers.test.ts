import { env } from 'cloudflare:workers';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
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

	it('skips active tenants with current idle eligibility', async () => {
		await provisionNamedTenant('acme');
		await provisionNamedTenant('beta');
		await suspendTenant('v1');
		await writeEligibility('acme', {
			reconciledAt: '2026-01-01T00:00:00.000Z'
		});
		await writeEligibility('beta', {
			reconciledAt: '2026-01-01T00:00:00.000Z'
		});

		const seen: string[] = [];
		await runWithClock('2026-01-01T00:00:00.000Z', () =>
			runCronSweep(env, 10, (_env, id) => {
				seen.push(id);

				return Promise.resolve();
			})
		);

		expect(seen).toStrictEqual([]);
	});

	it('schedules tenants whose eligibility is missing or stale', async () => {
		await provisionNamedTenant('acme');
		await provisionNamedTenant('beta');
		await provisionNamedTenant('current');
		await suspendTenant('v1');
		await writeEligibility('beta', {
			reconciledAt: '2025-12-31T17:59:59.000Z'
		});
		await writeEligibility('current', {
			reconciledAt: '2026-01-01T00:00:00.000Z'
		});

		const seen: string[] = [];
		await runWithClock('2026-01-01T00:00:00.000Z', () =>
			runCronSweep(env, 10, (_env, id) => {
				seen.push(id);

				return Promise.resolve();
			})
		);

		expect(seen).toStrictEqual(['acme', 'beta']);
	});

	it('schedules tenants with due eligibility signals', async () => {
		await provisionNamedTenant('delete');
		await provisionNamedTenant('idle');
		await provisionNamedTenant('root');
		await provisionNamedTenant('upload');
		await provisionNamedTenant('verify');
		await suspendTenant('v1');
		await writeEligibility('delete', {
			queuedNarInfoDeletionCount: 1,
			nextMaintenanceAt: '2026-01-01T00:00:00.000Z',
			reconciledAt: '2026-01-01T00:00:00.000Z'
		});
		await writeEligibility('idle', {
			reconciledAt: '2026-01-01T00:00:00.000Z'
		});
		await writeEligibility('root', {
			earliestRootExpiry: '2026-01-01T00:00:00.000Z',
			nextMaintenanceAt: '2026-01-01T00:00:00.000Z',
			reconciledAt: '2026-01-01T00:00:00.000Z'
		});
		await writeEligibility('upload', {
			earliestUploadExpiry: '2026-01-01T00:00:00.000Z',
			nextMaintenanceAt: '2026-01-01T00:00:00.000Z',
			reconciledAt: '2026-01-01T00:00:00.000Z'
		});
		await writeEligibility('verify', {
			pendingVerificationCount: 1,
			nextMaintenanceAt: '2026-01-01T00:00:00.000Z',
			reconciledAt: '2026-01-01T00:00:00.000Z'
		});

		const seen: string[] = [];
		await runWithClock('2026-01-01T00:00:00.000Z', () =>
			runCronSweep(env, 10, (_env, id) => {
				seen.push(id);

				return Promise.resolve();
			})
		);

		expect(seen).toStrictEqual(['delete', 'root', 'upload', 'verify']);
	});

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
			await deleteEligibility(tenant);
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

async function writeEligibility(
	tenant: string,
	fields: Partial<
		Omit<typeof d1Schema.tenantMaintenanceEligibility.$inferInsert, 'tenant'>
	>
): Promise<void> {
	await drizzleD1(env.CUPBOARD_DB, {
		schema: {
			tenantMaintenanceEligibility: d1Schema.tenantMaintenanceEligibility
		}
	})
		.insert(d1Schema.tenantMaintenanceEligibility)
		.values({
			tenant,
			reconciledAt: '2026-01-01T00:00:00.000Z',
			...fields
		})
		.run();
}

async function runWithClock<T>(
	now: string,
	body: () => Promise<T>
): Promise<T> {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(now));

	try {
		return await body();
	} finally {
		vi.useRealTimers();
	}
}
