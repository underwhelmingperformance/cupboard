import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import { env } from 'cloudflare:workers';
import { eq, sql } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { finaliseOffboardedTenant } from '../control/tenant-registry.ts';
import * as d1Schema from '../db/d1-schema.ts';
import {
	offboardTenant,
	provisionNamedTenant,
	resetTestServer,
	scheduledController,
	suspendTenant,
	tenantMaintained,
	tenantMaintenanceFailureRow
} from '../test-support.ts';
import worker from '../worker.ts';

import {
	enqueueMaintenanceJobs,
	executeMaintenanceQueueMessage,
	type MaintenanceQueueMessage,
	QueueBatchSendError,
	runCronSweep,
	runOffboardSweep,
	sendQueueMessages
} from './scheduled.ts';

function aggregateErrorShape(error: unknown): {
	readonly name: string;
	readonly errors: readonly unknown[];
} {
	if (!(error instanceof AggregateError)) {
		throw error;
	}

	return {
		name: error.name,
		errors: error.errors
	};
}

function queueBatchSendErrorShape(error: unknown): {
	readonly name: string;
	readonly errors: readonly unknown[];
} {
	if (!(error instanceof QueueBatchSendError)) {
		throw error;
	}

	return {
		name: error.name,
		errors: error.errors
	};
}

// The logged Zod issue carries a human message that varies with the library
// version; the structural fields are what the test pins, so the message is
// dropped before asserting.
function loggedIssueShape(issue: unknown): Readonly<Record<string, unknown>> {
	if (typeof issue !== 'object' || issue === null) {
		throw new TypeError('logged issue was not an object');
	}

	return Object.fromEntries(
		Object.entries(issue).filter(([key]) => key !== 'message')
	);
}

// The rejected-message warning detail, with each issue's version-dependent
// message dropped so the structural fields can be asserted deterministically.
function warningDetailShape(
	details: unknown
): Readonly<Record<string, unknown>> {
	if (typeof details !== 'object' || details === null) {
		throw new TypeError('logged warning detail was not an object');
	}

	const fields: Record<string, unknown> = Object.fromEntries(
		Object.entries(details)
	);
	const { issues } = fields;

	if (!Array.isArray(issues)) {
		throw new TypeError('logged warning detail had no issues array');
	}

	return { ...fields, issues: issues.map((issue) => loggedIssueShape(issue)) };
}

describe('scheduled tenant pass failure records', () => {
	beforeEach(resetTestServer);

	it('plans bounded queue jobs without recording tenant outcomes', async () => {
		await provisionNamedTenant('acme');
		await provisionNamedTenant('beta');
		await provisionNamedTenant('current');
		await provisionNamedTenant('retiring');
		await deleteEligibility('acme');
		await writeEligibility('beta', {
			nextMaintenanceAt: '2026-01-01T00:00:00.000Z',
			reconciledAt: '2026-01-01T00:00:00.000Z'
		});
		await writeEligibility('current', {
			reconciledAt: '2026-01-01T00:00:00.000Z'
		});
		await offboardTenant('retiring');

		const sent: MaintenanceQueueMessage[][] = [];
		const messages = await runWithClock('2026-01-01T00:00:00.000Z', () =>
			enqueueMaintenanceJobs(env, {
				sendBatch: (batch) => {
					sent.push(Array.from(batch, (entry) => entry.body));

					return Promise.resolve(queueSendBatchResponse());
				}
			})
		);

		expect({
			messages,
			sent,
			acmeOutcome: await tenantMaintenanceFailureRow('acme', 'maintenance'),
			retiringOutcome: await tenantMaintenanceFailureRow(
				'retiring',
				'offboard'
			),
			acmeMaintained: await tenantMaintained('acme')
		}).toStrictEqual({
			messages: [
				{ kind: 'tenant-maintenance', tenant: tenantIdSchema.parse('acme') },
				{ kind: 'tenant-maintenance', tenant: 'beta' },
				{ kind: 'offboard', tenant: 'retiring' },
				{ kind: 'blob-reaper' },
				{ kind: 'cas-reaper' },
				{ kind: 'blob-demote' },
				{ kind: 'cas-demote' },
				{ kind: 'control-key-retirement' }
			],
			sent: [
				[
					{ kind: 'tenant-maintenance', tenant: tenantIdSchema.parse('acme') },
					{ kind: 'tenant-maintenance', tenant: 'beta' },
					{ kind: 'offboard', tenant: 'retiring' },
					{ kind: 'blob-reaper' },
					{ kind: 'cas-reaper' },
					{ kind: 'blob-demote' },
					{ kind: 'cas-demote' },
					{ kind: 'control-key-retirement' }
				]
			],
			acmeOutcome: undefined,
			retiringOutcome: undefined,
			acmeMaintained: false
		});
	});

	it('attempts every batch when an earlier one fails, surfacing a typed error', async () => {
		// More than one batch of messages: a tenant-maintenance message per tenant
		// followed by a trailing global pass, the order a live tick produces.
		const messages: MaintenanceQueueMessage[] = [
			...Array.from(
				{ length: 120 },
				(_, index): MaintenanceQueueMessage => ({
					kind: 'tenant-maintenance',
					tenant: tenantIdSchema.parse(`tenant-${String(index)}`)
				})
			),
			{ kind: 'blob-reaper' }
		];
		const attempted: MaintenanceQueueMessage[] = [];
		const rejection = new Error('queue unavailable');
		let call = 0;

		const sending = sendQueueMessages(
			{
				sendBatch: (batch) => {
					call += 1;
					attempted.push(...Array.from(batch, (entry) => entry.body));

					return call === 1
						? Promise.reject(rejection)
						: Promise.resolve(queueSendBatchResponse());
				}
			},
			messages
		);

		let outcome: { sent: boolean } | { error: unknown };
		try {
			await sending;
			outcome = { sent: true };
		} catch (error: unknown) {
			outcome = { error: queueBatchSendErrorShape(error) };
		}

		// The trailing batch was still handed to the queue despite the first failing.
		expect({ outcome, attempted }).toStrictEqual({
			outcome: {
				error: { name: QueueBatchSendError.name, errors: [rejection] }
			},
			attempted: messages
		});
	});

	it('aggregates a failure from every batch in send order', async () => {
		// 150 messages span two batches (100 then 50); both sends fail.
		const messages: MaintenanceQueueMessage[] = Array.from(
			{ length: 150 },
			(_, index): MaintenanceQueueMessage => ({
				kind: 'tenant-maintenance',
				tenant: tenantIdSchema.parse(`tenant-${String(index)}`)
			})
		);
		const failures = [
			new Error('first batch down'),
			new Error('second batch down')
		];
		const attempted: MaintenanceQueueMessage[][] = [];
		let call = 0;

		const sending = sendQueueMessages(
			{
				sendBatch: (batch) => {
					attempted.push(Array.from(batch, (entry) => entry.body));
					const failure = failures.at(call);
					call += 1;

					return failure === undefined
						? Promise.resolve(queueSendBatchResponse())
						: Promise.reject(failure);
				}
			},
			messages
		);

		let outcome: { sent: boolean } | { error: unknown };
		try {
			await sending;
			outcome = { sent: true };
		} catch (error: unknown) {
			outcome = { error: queueBatchSendErrorShape(error) };
		}

		// Both batches are attempted and their failures are aggregated in send order,
		// so the accumulation keeps every failure rather than only the last.
		expect({ outcome, attempted }).toStrictEqual({
			outcome: {
				error: { name: QueueBatchSendError.name, errors: failures }
			},
			attempted: [messages.slice(0, 100), messages.slice(100)]
		});
	});

	it('scheduled entrypoint enqueues bounded maintenance jobs', async () => {
		await provisionNamedTenant('acme');
		await provisionNamedTenant('current');
		await provisionNamedTenant('retiring');
		await deleteEligibility('acme');
		await writeEligibility('current', {
			reconciledAt: '2026-01-01T00:00:00.000Z'
		});
		await offboardTenant('retiring');

		const sent: MaintenanceQueueMessage[] = [];
		await runWithClock('2026-01-01T00:00:00.000Z', () =>
			worker.scheduled(scheduledController(), {
				...env,
				MAINTENANCE_QUEUE: queueCollector(sent)
			})
		);

		expect({
			sent,
			acmeOutcome: await tenantMaintenanceFailureRow('acme', 'maintenance'),
			retiringOutcome: await tenantMaintenanceFailureRow('retiring', 'offboard')
		}).toStrictEqual({
			sent: [
				{ kind: 'tenant-maintenance', tenant: tenantIdSchema.parse('acme') },
				{ kind: 'offboard', tenant: 'retiring' },
				{ kind: 'blob-reaper' },
				{ kind: 'cas-reaper' },
				{ kind: 'blob-demote' },
				{ kind: 'cas-demote' },
				{ kind: 'control-key-retirement' }
			],
			acmeOutcome: undefined,
			retiringOutcome: undefined
		});
	});

	it('executes stale tenant maintenance messages as no-ops', async () => {
		await provisionNamedTenant('acme');
		await writeEligibility('acme', {
			reconciledAt: '2026-01-01T00:00:00.000Z'
		});

		const seen: string[] = [];
		const decision = await runWithClock('2026-01-01T00:00:00.000Z', () =>
			executeMaintenanceQueueMessage(
				env,
				{ kind: 'tenant-maintenance', tenant: tenantIdSchema.parse('acme') },
				{
					maintainTenant: (_env, id) => {
						seen.push(id);

						return Promise.resolve();
					}
				}
			)
		);

		expect({
			decision,
			seen,
			outcome: await tenantMaintenanceFailureRow('acme', 'maintenance'),
			maintained: await tenantMaintained('acme')
		}).toStrictEqual({
			decision: { action: 'ack' },
			seen: [],
			outcome: undefined,
			maintained: false
		});
	});

	it('runs a tenant-verify message regardless of the maintenance cadence', async () => {
		await provisionNamedTenant('acme');
		// Freshly maintained, so an ordinary maintenance message would be a
		// stale no-op; the verify pass was asked for by a commit and runs anyway.
		await writeEligibility('acme', {
			reconciledAt: '2026-01-01T00:00:00.000Z'
		});

		const seen: string[] = [];
		const decision = await runWithClock('2026-01-01T00:00:00.000Z', () =>
			executeMaintenanceQueueMessage(
				env,
				{ kind: 'tenant-verify', tenant: tenantIdSchema.parse('acme') },
				{
					verifyTenant: (_env, id) => {
						seen.push(id);

						return Promise.resolve();
					}
				}
			)
		);

		expect({ decision, seen }).toStrictEqual({
			decision: { action: 'ack' },
			seen: ['acme']
		});
	});

	it('retries a tenant-verify message whose pass fails', async () => {
		const decision = await executeMaintenanceQueueMessage(
			env,
			{ kind: 'tenant-verify', tenant: tenantIdSchema.parse('acme') },
			{ verifyTenant: () => Promise.reject(new Error('verify failed')) }
		);

		expect(decision).toStrictEqual({
			action: 'retry',
			delaySeconds: 60,
			reason: 'Error: verify failed'
		});
	});

	it('records tenant maintenance queue outcomes after an actual attempt', async () => {
		await provisionNamedTenant('acme');
		await deleteEligibility('acme');

		const decision = await runWithClock('2026-01-02T00:00:00.000Z', () =>
			executeMaintenanceQueueMessage(
				env,
				{ kind: 'tenant-maintenance', tenant: tenantIdSchema.parse('acme') },
				{
					maintainTenant: () =>
						Promise.reject(new Error('queue maintenance failed'))
				}
			)
		);
		const outcome = await tenantMaintenanceFailureRow('acme', 'maintenance');

		expect({
			decision,
			outcome,
			maintained: await tenantMaintained('acme')
		}).toStrictEqual({
			decision: { action: 'ack' },
			outcome: {
				consecutiveFailures: 1,
				lastError: 'Error: queue maintenance failed',
				lastFailedAt: '2026-01-02T00:00:00.000Z',
				lastSuccessAt: undefined
			},
			maintained: true
		});
	});

	it('retries global queue work when the bounded pass fails', async () => {
		const decision = await executeMaintenanceQueueMessage(
			env,
			{ kind: 'blob-reaper' },
			{ runBlobReaper: () => Promise.reject(new Error('r2 unavailable')) }
		);

		expect(decision).toStrictEqual({
			action: 'retry',
			delaySeconds: 60,
			reason: 'Error: r2 unavailable'
		});
	});

	it('acks an already-offboarded queue message without recording a fresh outcome', async () => {
		await provisionNamedTenant('retiring');
		await finaliseOffboardedTenant(
			drizzleD1(env.CUPBOARD_DB, { schema: d1Schema }),
			tenantIdSchema.parse('retiring')
		);

		const decision = await executeMaintenanceQueueMessage(env, {
			kind: 'offboard',
			tenant: tenantIdSchema.parse('retiring')
		});

		expect({
			decision,
			outcome: await tenantMaintenanceFailureRow('retiring', 'offboard')
		}).toStrictEqual({
			decision: { action: 'ack' },
			outcome: undefined
		});
	});

	it('acks stale offboard messages for tenants that are not offboarding', async () => {
		await provisionNamedTenant('active');
		await provisionNamedTenant('suspended');
		await suspendTenant('suspended');

		const seen: string[] = [];
		const decisions = await Promise.all(
			['active', 'suspended', 'absent'].map((tenant) =>
				executeMaintenanceQueueMessage(
					env,
					{ kind: 'offboard', tenant: tenantIdSchema.parse(tenant) },
					{
						drainTenant: (_env, id) => {
							seen.push(id);

							return Promise.resolve();
						}
					}
				)
			)
		);

		expect({
			decisions,
			seen,
			activeOutcome: await tenantMaintenanceFailureRow('active', 'offboard'),
			suspendedOutcome: await tenantMaintenanceFailureRow(
				'suspended',
				'offboard'
			),
			absentOutcome: await tenantMaintenanceFailureRow('absent', 'offboard')
		}).toStrictEqual({
			decisions: [{ action: 'ack' }, { action: 'ack' }, { action: 'ack' }],
			seen: [],
			activeOutcome: undefined,
			suspendedOutcome: undefined,
			absentOutcome: undefined
		});
	});

	it('queue entrypoint acks, retries, and logs messages independently', async () => {
		const actions: QueueMessageAction[] = [];
		const batch = queueBatch(
			[
				queueMessage('success', { kind: 'control-key-retirement' }, actions),
				queueMessage('retry', { kind: 'blob-demote' }, actions),
				queueMessage('invalid', { kind: 'unknown' }, actions)
			],
			actions
		);
		const warnings: unknown[][] = [];
		const errors: unknown[][] = [];
		const warn = vi
			.spyOn(console, 'warn')
			.mockImplementation((...logArguments: unknown[]) => {
				warnings.push(logArguments);
			});
		const error = vi
			.spyOn(console, 'error')
			.mockImplementation((...logArguments: unknown[]) => {
				errors.push(logArguments);
			});

		try {
			await worker.queue(batch, {
				...env,
				CRON_STATE: {
					...env.CRON_STATE,
					get: () => Promise.reject(new Error('kv unavailable'))
				}
			});
		} finally {
			warn.mockRestore();
			error.mockRestore();
		}
		const warningLogs = warnings.map(([message, details]) => [
			message,
			warningDetailShape(details)
		]);

		expect({
			actions,
			warnings: warningLogs,
			errors
		}).toStrictEqual({
			actions: [
				{ target: 'message', id: 'success', action: 'ack' },
				{
					target: 'message',
					id: 'retry',
					action: 'retry',
					delaySeconds: 60
				},
				{ target: 'message', id: 'invalid', action: 'ack' }
			],
			warnings: [
				[
					'maintenance queue message rejected',
					{
						queue: 'cupboard-maintenance',
						messageId: 'invalid',
						attempts: 1,
						issues: [
							{
								code: 'invalid_union',
								discriminator: 'kind',
								errors: [],
								note: 'No matching discriminator',
								options: [
									'tenant-maintenance',
									'tenant-verify',
									'offboard',
									'blob-reaper',
									'cas-reaper',
									'blob-demote',
									'cas-demote',
									'control-key-retirement'
								],
								path: ['kind']
							}
						]
					}
				]
			],
			errors: [
				[
					'maintenance queue message retrying',
					{
						queue: 'cupboard-maintenance',
						messageId: 'retry',
						attempts: 1,
						delaySeconds: 60,
						kind: 'blob-demote',
						reason: 'Error: kv unavailable'
					}
				]
			]
		});
	});

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
			runCronSweep(env, 10, (_env, tenant) => {
				seen.push(tenant);

				return Promise.resolve();
			})
		);

		expect({
			seen,
			acme: await tenantMaintained('acme'),
			beta: await tenantMaintained('beta'),
			fixture: await tenantMaintained('v1')
		}).toStrictEqual({
			seen: [],
			acme: false,
			beta: false,
			fixture: false
		});
	});

	it('schedules tenants whose eligibility is missing or stale', async () => {
		await provisionNamedTenant('acme');
		await provisionNamedTenant('beta');
		await provisionNamedTenant('current');
		await suspendTenant('v1');
		await deleteEligibility('acme');
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
		await deleteEligibility('acme');
		await deleteEligibility('beta');

		const seen: string[] = [];
		const firstFailure = new Error('maintenance failed');
		const error = await runWithClock('2026-01-02T00:00:00.000Z', async () => {
			try {
				await runCronSweep(env, 2, (_env, id) => {
					seen.push(id);

					if (id === 'acme') {
						return Promise.reject(firstFailure);
					}

					return Promise.resolve();
				});
				return;
			} catch (error_: unknown) {
				return error_;
			}
		});
		const afterFailure = {
			acme: await tenantMaintenanceFailureRow('acme', 'maintenance'),
			beta: await tenantMaintenanceFailureRow('beta', 'maintenance'),
			acmeMaintained: await tenantMaintained('acme'),
			betaMaintained: await tenantMaintained('beta')
		};

		await runWithClock('2026-01-03T00:00:00.000Z', () =>
			runCronSweep(env, 1, () => Promise.resolve())
		);
		const afterSuccess = await tenantMaintenanceFailureRow(
			'acme',
			'maintenance'
		);
		expect({
			error: aggregateErrorShape(error),
			seen,
			afterFailure: {
				acme: afterFailure.acme,
				beta: afterFailure.beta,
				acmeMaintained: afterFailure.acmeMaintained,
				betaMaintained: afterFailure.betaMaintained
			},
			afterSuccess
		}).toStrictEqual({
			error: {
				name: 'AggregateError',
				errors: [firstFailure]
			},
			seen: ['acme', 'beta'],
			afterFailure: {
				acme: {
					consecutiveFailures: 1,
					lastError: 'Error: maintenance failed',
					lastFailedAt: '2026-01-02T00:00:00.000Z',
					lastSuccessAt: undefined
				},
				beta: {
					consecutiveFailures: 0,
					lastError: undefined,
					lastFailedAt: undefined,
					lastSuccessAt: '2026-01-02T00:00:00.000Z'
				},
				acmeMaintained: true,
				betaMaintained: true
			},
			afterSuccess: {
				consecutiveFailures: 0,
				lastError: 'Error: maintenance failed',
				lastFailedAt: '2026-01-02T00:00:00.000Z',
				lastSuccessAt: '2026-01-03T00:00:00.000Z'
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
		const firstFailure = new TypeError('offboard failed');
		const error = await runWithClock('2026-01-02T00:00:00.000Z', async () => {
			try {
				await runOffboardSweep(env, 2, 1, 1, (_env, id) => {
					seen.push(id);

					if (id === 'acme') {
						return Promise.reject(firstFailure);
					}

					return Promise.resolve();
				});
				return;
			} catch (error_: unknown) {
				return error_;
			}
		});
		const afterFailure = {
			acme: await tenantMaintenanceFailureRow('acme', 'offboard'),
			beta: await tenantMaintenanceFailureRow('beta', 'offboard')
		};

		await runWithClock('2026-01-03T00:00:00.000Z', () =>
			runOffboardSweep(env, 1, 1, 1, () => Promise.resolve())
		);
		const afterSuccess = await tenantMaintenanceFailureRow('acme', 'offboard');

		expect({
			error: aggregateErrorShape(error),
			seen,
			afterFailure: {
				acme: afterFailure.acme,
				beta: afterFailure.beta
			},
			afterSuccess
		}).toStrictEqual({
			error: {
				name: 'AggregateError',
				errors: [firstFailure]
			},
			seen: ['acme', 'beta'],
			afterFailure: {
				acme: {
					consecutiveFailures: 1,
					lastError: 'TypeError: offboard failed',
					lastFailedAt: '2026-01-02T00:00:00.000Z',
					lastSuccessAt: undefined
				},
				beta: {
					consecutiveFailures: 0,
					lastError: undefined,
					lastFailedAt: undefined,
					lastSuccessAt: '2026-01-02T00:00:00.000Z'
				}
			},
			afterSuccess: {
				consecutiveFailures: 0,
				lastError: 'TypeError: offboard failed',
				lastFailedAt: '2026-01-02T00:00:00.000Z',
				lastSuccessAt: '2026-01-03T00:00:00.000Z'
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
			tenant: tenantIdSchema.parse(tenant),
			reconciledAt: '2026-01-01T00:00:00.000Z',
			...fields
		})
		.onConflictDoUpdate({
			target: d1Schema.tenantMaintenanceEligibility.tenant,
			set: {
				pendingVerificationCount: fields.pendingVerificationCount ?? 0,
				earliestUploadExpiry: fields.earliestUploadExpiry ?? sql`null`,
				queuedNarInfoDeletionCount: fields.queuedNarInfoDeletionCount ?? 0,
				earliestRootExpiry: fields.earliestRootExpiry ?? sql`null`,
				nextMaintenanceAt: fields.nextMaintenanceAt ?? sql`null`,
				reconciledAt: fields.reconciledAt ?? '2026-01-01T00:00:00.000Z'
			}
		})
		.run();
}

async function deleteEligibility(tenant: string): Promise<void> {
	await drizzleD1(env.CUPBOARD_DB, {
		schema: {
			tenantMaintenanceEligibility: d1Schema.tenantMaintenanceEligibility
		}
	})
		.delete(d1Schema.tenantMaintenanceEligibility)
		.where(
			eq(
				d1Schema.tenantMaintenanceEligibility.tenant,
				tenantIdSchema.parse(tenant)
			)
		)
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

type QueueMessageAction =
	| {
			readonly target: 'message';
			readonly id: string;
			readonly action: 'ack' | 'retry';
			readonly delaySeconds?: number;
	  }
	| {
			readonly target: 'batch';
			readonly action: 'ack' | 'retry';
	  };

function queueBatch(
	messages: readonly Message[],
	actions: QueueMessageAction[]
): MessageBatch {
	return {
		messages,
		queue: 'cupboard-maintenance',
		metadata: {
			metrics: {
				backlogBytes: 0,
				backlogCount: 0
			}
		},
		ackAll: () => {
			actions.push({ target: 'batch', action: 'ack' });
		},
		retryAll: () => {
			actions.push({ target: 'batch', action: 'retry' });
		}
	};
}

function queueMessage(
	id: string,
	body: unknown,
	actions: QueueMessageAction[]
): Message {
	return {
		id,
		timestamp: new Date('2026-01-01T00:00:00.000Z'),
		attempts: 1,
		body,
		ack: () => {
			actions.push({ target: 'message', id, action: 'ack' });
		},
		retry: (options) => {
			actions.push({
				target: 'message',
				id,
				action: 'retry',
				delaySeconds: options?.delaySeconds
			});
		}
	};
}

function queueSendBatchResponse(): QueueSendBatchResponse {
	return {
		metadata: {
			metrics: {
				backlogBytes: 0,
				backlogCount: 0
			}
		}
	};
}

function queueSendResponse(): QueueSendResponse {
	return {
		metadata: {
			metrics: {
				backlogBytes: 0,
				backlogCount: 0
			}
		}
	};
}

function queueCollector(
	sent: MaintenanceQueueMessage[]
): Queue<MaintenanceQueueMessage> {
	return {
		metrics: () =>
			Promise.resolve({
				backlogBytes: 0,
				backlogCount: 0
			}),
		send: (message) => {
			sent.push(message);

			return Promise.resolve(queueSendResponse());
		},
		sendBatch: (batch) => {
			sent.push(...Array.from(batch, (entry) => entry.body));

			return Promise.resolve(queueSendBatchResponse());
		}
	};
}
