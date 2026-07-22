import {
	nixSha256HashSchema,
	rootNameSchema,
	sha256HexDigestSchema,
	storePathHashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { uploadIdSchema } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq, sql } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import { currentServer, resetTestServer } from '../test-support.ts';

import {
	MaintenanceEligibilityService,
	withMaintenanceEligibility
} from './maintenance-eligibility-service.ts';

const now = new Date('2026-01-01T00:00:00.000Z');

// A tenant with work due now stores a fixed past instant. Mirrors the service.
const wakeImmediately = new Date(0).toISOString();

class MaintenanceProjectionTestError extends Error {
	constructor(public readonly operation: 'delete' | 'insert') {
		super(`projection ${operation} failed`);
	}
}

function expectMaintenanceProjectionTestError(
	error: unknown
): asserts error is MaintenanceProjectionTestError {
	expect(error).toBeInstanceOf(MaintenanceProjectionTestError);
}

async function eligibilityRow(tenant: string = fixtureTenant) {
	const row = await drizzleD1(env.CUPBOARD_DB, {
		schema: {
			tenantMaintenanceEligibility: d1Schema.tenantMaintenanceEligibility
		}
	})
		.select()
		.from(d1Schema.tenantMaintenanceEligibility)
		.where(
			eq(
				d1Schema.tenantMaintenanceEligibility.tenant,
				tenantIdSchema.parse(tenant)
			)
		)
		.get();

	if (row === undefined) {
		return;
	}

	return {
		tenant: row.tenant,
		nextWakeAt: row.nextWakeAt ?? undefined,
		reconciledAt: row.reconciledAt
	};
}

describe('maintenance eligibility projection', () => {
	beforeEach(resetTestServer);

	it('records an idle tenant with no next maintenance time', async () => {
		await runInDurableObject(currentServer(), (instance) => {
			const service = new MaintenanceEligibilityService(instance.context);

			return service.reconcile(now);
		});

		expect(await eligibilityRow()).toStrictEqual({
			tenant: fixtureTenant,
			nextWakeAt: undefined,
			reconciledAt: now.toISOString()
		});
	});

	it('can invalidate an idle projection before deferred work is created', async () => {
		const projectionWriteFailure = new MaintenanceProjectionTestError('insert');

		await runInDurableObject(currentServer(), async (instance) => {
			const maintenanceEligibility = new MaintenanceEligibilityService(
				instance.context
			);
			await maintenanceEligibility.reconcile(now);
			const result = await withMaintenanceEligibility(
				maintenanceEligibility,
				async () => {
					try {
						await maintenanceEligibility.reconcile();
					} catch {
						// Eligibility is an admission hint; failed reconciliation fails open.
					}
				},
				() => {
					instance.context.db
						.insert(schema.pendingUploads)
						.values(
							pendingUpload(
								'verify-after-failed-refresh',
								now.toISOString(),
								'pending'
							)
						)
						.run();
					Object.defineProperty(instance.context, 'd1', {
						value: {
							insert() {
								throw projectionWriteFailure;
							}
						},
						configurable: true
					});

					return Promise.resolve('mutated');
				}
			);

			expect(result).toBe('mutated');
		});

		expect(await eligibilityRow()).toBeUndefined();
	});

	it('does not run a mutation when eligibility cannot be invalidated', async () => {
		const projectionDeleteFailure = new MaintenanceProjectionTestError(
			'delete'
		);

		const outcome = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const maintenanceEligibility = new MaintenanceEligibilityService(
					instance.context
				);
				Object.defineProperty(instance.context, 'd1', {
					value: {
						delete() {
							throw projectionDeleteFailure;
						}
					},
					configurable: true
				});
				let error: unknown;

				try {
					await withMaintenanceEligibility(
						maintenanceEligibility,
						async () => {
							await maintenanceEligibility.reconcile();
						},
						() => {
							instance.context.db
								.insert(schema.pendingUploads)
								.values(
									pendingUpload(
										'verify-after-failed-invalidation',
										now.toISOString(),
										'pending'
									)
								)
								.run();

							return Promise.resolve();
						}
					);
				} catch (error_: unknown) {
					error = error_;
				}

				expectMaintenanceProjectionTestError(error);

				return {
					error: { operation: error.operation },
					pendingUploads: instance.context.db
						.select({
							id: schema.pendingUploads.id
						})
						.from(schema.pendingUploads)
						.all()
				};
			}
		);

		expect(outcome).toStrictEqual({
			error: { operation: 'delete' },
			pendingUploads: []
		});
	});

	it('marks verification and deletion work due immediately', async () => {
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.insert(schema.pendingUploads)
				.values([
					pendingUpload('waiting-bytes', '2026-01-02T00:00:00.000Z'),
					pendingUpload('verify-a', '2026-01-03T00:00:00.000Z', 'pending'),
					pendingUpload('verify-b', '2026-01-04T00:00:00.000Z', 'committing')
				])
				.run();
			instance.context.db
				.insert(schema.narInfoDeletions)
				.values({
					cache: '',
					storePathHash: storePathHashSchema.parse('a'.repeat(32)),
					narHash: nixSha256HashSchema.parse(`sha256:${'0'.repeat(52)}`),
					generation: 0,
					createdAt: '2026-01-01T00:00:00.000Z'
				})
				.run();
			instance.context.db
				.insert(schema.retentionRoots)
				.values({
					cache: '',
					name: rootNameSchema.parse('release'),
					expiresAt: '2026-01-05T00:00:00.000Z',
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z'
				})
				.run();

			const service = new MaintenanceEligibilityService(instance.context);

			return service.reconcile(now);
		});

		expect(await eligibilityRow()).toStrictEqual({
			tenant: fixtureTenant,
			nextWakeAt: wakeImmediately,
			reconciledAt: now.toISOString()
		});
	});

	it('uses the earliest expiry when there is no immediate work', async () => {
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.insert(schema.pendingUploads)
				.values(pendingUpload('terminal', '2026-01-04T00:00:00.000Z'))
				.run();
			instance.context.db
				.insert(schema.retentionRoots)
				.values({
					cache: '',
					name: rootNameSchema.parse('release'),
					expiresAt: '2026-01-03T00:00:00.000Z',
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z'
				})
				.run();

			const service = new MaintenanceEligibilityService(instance.context);

			return service.reconcile(now);
		});

		expect(await eligibilityRow()).toStrictEqual({
			tenant: fixtureTenant,
			nextWakeAt: '2026-01-03T00:00:00.000Z',
			reconciledAt: now.toISOString()
		});
	});

	it('uses pending attestation expiry as deferred maintenance work', async () => {
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.insert(schema.pendingAttestations)
				.values(
					pendingAttestation('attestation-upload', '2026-01-02T00:00:00.000Z')
				)
				.run();

			const service = new MaintenanceEligibilityService(instance.context);

			return service.reconcile(now);
		});

		expect(await eligibilityRow()).toStrictEqual({
			tenant: fixtureTenant,
			nextWakeAt: '2026-01-02T00:00:00.000Z',
			reconciledAt: now.toISOString()
		});
	});

	it('uses a live grace deadline as deferred work when nothing else is due', async () => {
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.insert(schema.retentionGrace)
				.values({
					cache: '',
					storePathHash: storePathHashSchema.parse('a'.repeat(32)),
					retainUntil: '2026-01-02T00:00:00.000Z'
				})
				.run();

			const service = new MaintenanceEligibilityService(instance.context);

			return service.reconcile(now);
		});

		expect(await eligibilityRow()).toStrictEqual({
			tenant: fixtureTenant,
			nextWakeAt: '2026-01-02T00:00:00.000Z',
			reconciledAt: now.toISOString()
		});
	});

	it('wakes at the sooner of a grace deadline and a root expiry', async () => {
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.insert(schema.retentionGrace)
				.values({
					cache: '',
					storePathHash: storePathHashSchema.parse('a'.repeat(32)),
					retainUntil: '2026-01-05T00:00:00.000Z'
				})
				.run();
			instance.context.db
				.insert(schema.retentionRoots)
				.values({
					cache: '',
					name: rootNameSchema.parse('release'),
					expiresAt: '2026-01-03T00:00:00.000Z',
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z'
				})
				.run();

			const service = new MaintenanceEligibilityService(instance.context);

			return service.reconcile(now);
		});

		expect(await eligibilityRow()).toStrictEqual({
			tenant: fixtureTenant,
			nextWakeAt: '2026-01-03T00:00:00.000Z',
			reconciledAt: now.toISOString()
		});
	});

	it('uses the earliest unretired auth-key retirement as deferred work', async () => {
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.insert(schema.authKeys)
				.values([
					authKey({
						id: 'old-retired',
						kid: 'old-retired',
						scheduledRetireAt: '2026-01-02T00:00:00.000Z',
						retiredAt: '2026-01-02T00:01:00.000Z'
					}),
					authKey({
						id: 'old-live',
						kid: 'old-live',
						scheduledRetireAt: '2026-01-03T00:00:00.000Z'
					}),
					authKey({ id: 'active', kid: 'active' })
				])
				.run();

			const service = new MaintenanceEligibilityService(instance.context);

			return service.reconcile(now);
		});

		expect(await eligibilityRow()).toStrictEqual({
			tenant: fixtureTenant,
			nextWakeAt: '2026-01-03T00:00:00.000Z',
			reconciledAt: now.toISOString()
		});
	});
});

describe('maintenance wake conflict resolution', () => {
	beforeEach(resetTestServer);

	const earlier = '2026-01-01T00:00:00.000Z';
	const later = '2026-02-01T00:00:00.000Z';
	const soonFuture = '2026-03-01T00:00:00.000Z';
	const farFuture = '2026-09-01T00:00:00.000Z';

	// Each case seeds a stored projection row, then reconciles against Durable Object
	// state that drives the incoming wake (`immediate` from a pending upload, a future
	// deadline from a retention root, or none) with `now` setting its `reconciled_at`.
	// The conditional upsert decides which survives.
	const cases = [
		{
			name: 'keeps a fresher wake when a staler reconcile computes a later one',
			stored: { wake: soonFuture, reconciledAt: later },
			incoming: { work: { future: farFuture }, now: earlier },
			expected: { nextWakeAt: soonFuture, reconciledAt: later }
		},
		{
			name: 'takes a newer reconcile that moves the wake',
			stored: { wake: soonFuture, reconciledAt: earlier },
			incoming: { work: { future: farFuture }, now: later },
			expected: { nextWakeAt: farFuture, reconciledAt: later }
		},
		{
			name: 'lets a sooner wake win even from a staler reconcile',
			stored: { wake: farFuture, reconciledAt: later },
			incoming: { work: 'immediate', now: earlier },
			expected: { nextWakeAt: wakeImmediately, reconciledAt: earlier }
		},
		{
			name: 'lets a sooner future deadline win over a later one from a staler reconcile',
			stored: { wake: farFuture, reconciledAt: later },
			incoming: { work: { future: soonFuture }, now: earlier },
			expected: { nextWakeAt: soonFuture, reconciledAt: earlier }
		},
		{
			name: 'wakes an idle stored tenant that just became due, even from a staler reconcile',
			stored: { wake: undefined, reconciledAt: later },
			incoming: { work: 'immediate', now: earlier },
			expected: { nextWakeAt: wakeImmediately, reconciledAt: earlier }
		},
		{
			name: 'skips the write when the wake is unchanged',
			stored: { wake: wakeImmediately, reconciledAt: earlier },
			incoming: { work: 'immediate', now: later },
			expected: { nextWakeAt: wakeImmediately, reconciledAt: earlier }
		},
		{
			name: 'does not let a same-instant not-due reconcile overwrite a due row',
			stored: { wake: wakeImmediately, reconciledAt: later },
			incoming: { work: { future: farFuture }, now: later },
			expected: { nextWakeAt: wakeImmediately, reconciledAt: later }
		},
		{
			name: 'clears the wake to null when work has drained',
			stored: { wake: soonFuture, reconciledAt: earlier },
			incoming: { work: 'none', now: later },
			expected: { nextWakeAt: undefined, reconciledAt: later }
		}
	] as const;

	it.each(cases)('$name', async ({ stored, incoming, expected }) => {
		await seedEligibility(stored.wake, stored.reconciledAt);

		await runInDurableObject(currentServer(), async (instance) => {
			const { work } = incoming;

			if (work === 'immediate') {
				instance.context.db
					.insert(schema.pendingUploads)
					.values(pendingUpload('incoming', farFuture, 'pending'))
					.run();
			} else if (work !== 'none') {
				instance.context.db
					.insert(schema.retentionRoots)
					.values({
						cache: '',
						name: rootNameSchema.parse('incoming'),
						expiresAt: work.future,
						createdAt: earlier,
						updatedAt: earlier
					})
					.run();
			}

			await new MaintenanceEligibilityService(instance.context).reconcile(
				new Date(incoming.now)
			);
		});

		expect(await eligibilityRow()).toStrictEqual({
			tenant: fixtureTenant,
			nextWakeAt: expected.nextWakeAt,
			reconciledAt: expected.reconciledAt
		});
	});
});

async function seedEligibility(
	nextWakeAt: string | undefined,
	reconciledAt: string
): Promise<void> {
	await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
		.insert(d1Schema.tenantMaintenanceEligibility)
		.values({
			tenant: tenantIdSchema.parse(fixtureTenant),
			nextWakeAt,
			reconciledAt
		})
		.onConflictDoUpdate({
			target: d1Schema.tenantMaintenanceEligibility.tenant,
			set: { nextWakeAt: nextWakeAt ?? sql`null`, reconciledAt }
		})
		.run();
}

function pendingUpload(
	id: string,
	expiresAt: string,
	verdict?: typeof schema.pendingUploads.$inferSelect.verdict
): typeof schema.pendingUploads.$inferInsert {
	return {
		id: uploadIdSchema.parse(id),
		cache: '',
		narHash: nixSha256HashSchema.parse(`sha256:${'0'.repeat(52)}`),
		r2Key: `staging/${id}`,
		metadataJson: '{}',
		createdAt: '2026-01-01T00:00:00.000Z',
		expiresAt,
		verdict
	};
}

function pendingAttestation(
	id: string,
	expiresAt: string
): typeof schema.pendingAttestations.$inferInsert {
	return {
		id: uploadIdSchema.parse(id),
		cache: '',
		storePathHash: storePathHashSchema.parse('a'.repeat(32)),
		digest: sha256HexDigestSchema.parse('b'.repeat(64)),
		r2Key: `staging/attestations/${id}`,
		createdAt: '2026-01-01T00:00:00.000Z',
		expiresAt
	};
}

function authKey(
	overrides: Partial<typeof schema.authKeys.$inferInsert>
): typeof schema.authKeys.$inferInsert {
	return {
		id: 'key',
		kid: 'key',
		privateJwkJson: '{}',
		publicJwkJson: '{}',
		createdAt: '2026-01-01T00:00:00.000Z',
		...overrides
	};
}
