import {
	authKeyIdSchema,
	narInfoGenerationSchema,
	nixSha256HashSchema,
	rootNameSchema,
	sha256HexDigestSchema,
	storePathHashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import {
	type IsoTimestamp,
	isoTimestamp,
	isoTimestampSchema
} from '@cupboard/protocol/scalars';
import { uploadIdSchema } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq, sql } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { r2ObjectKeySchema } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	currentServer,
	resetTestServer,
	resolvedCache,
	waitUntilReached
} from '../test-support.ts';

import type { ServerContext } from './context.ts';
import {
	MaintenanceEligibilityService,
	withMaintenanceEligibility
} from './maintenance-eligibility-service.ts';

const now = new Date('2026-01-01T00:00:00.000Z');

const previousReconciliation = isoTimestampSchema.parse(
	'2025-12-01T00:00:00.000Z'
);

const wakeImmediately = isoTimestamp(new Date(0));

const passInProgress = isoTimestamp(new Date(-1));

class MaintenanceProjectionTestError extends Error {
	constructor(public readonly operation: 'mark') {
		super(`projection ${operation} failed`);
	}
}

function expectMaintenanceProjectionTestError(
	error: unknown
): asserts error is MaintenanceProjectionTestError {
	expect(error).toBeInstanceOf(MaintenanceProjectionTestError);
}

async function eligibilityRow() {
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
				tenantIdSchema.parse(fixtureTenant)
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

	it('schedules a deferred upload at its retry deadline while a fresh row remains due', async () => {
		const retryAt = isoTimestampSchema.parse('2026-01-01T00:05:00.000Z');
		const expired = isoTimestampSchema.parse('2020-01-01T00:00:00.000Z');

		await runInDurableObject(currentServer(), async (instance) => {
			const service = new MaintenanceEligibilityService(instance.context);
			instance.context.db
				.insert(schema.pendingUploads)
				.values({
					...pendingUpload(instance.context, 'deferred', expired, 'committing'),
					settleRetryAfter: retryAt
				})
				.run();
			await service.reconcile(now);
		});
		expect(await eligibilityRow()).toStrictEqual({
			tenant: fixtureTenant,
			nextWakeAt: retryAt,
			reconciledAt: now.toISOString()
		});

		await runInDurableObject(currentServer(), async (instance) => {
			instance.context.db
				.insert(schema.pendingUploads)
				.values(pendingUpload(instance.context, 'fresh', expired, 'pending'))
				.run();
			await new MaintenanceEligibilityService(instance.context).reconcile(
				new Date(now.getTime() + 1000)
			);
		});
		expect(await eligibilityRow()).toStrictEqual({
			tenant: fixtureTenant,
			nextWakeAt: wakeImmediately,
			reconciledAt: '2026-01-01T00:00:01.000Z'
		});
	});

	it.each(['queue', 'diagnostic'] as const)(
		'projects the earliest inheritance %s deadline even after a paused pass',
		async (kind) => {
			const deadline = isoTimestampSchema.parse('2026-01-01T00:05:00.000Z');
			await runInDurableObject(currentServer(), async (instance) => {
				const cache = resolvedCache(instance.context);
				instance.context.db
					.insert(schema.retryEligibility)
					.values({ id: 'tenant', isEligible: false })
					.run();
				const identity = {
					cacheId: cache.id,
					storePathHash: storePathHashSchema.parse('a'.repeat(32)),
					generation: narInfoGenerationSchema.parse(0)
				};
				switch (kind) {
					case 'queue': {
						instance.context.db
							.insert(schema.attestationInheritances)
							.values({
								...identity,
								narHash: nixSha256HashSchema.parse(`sha256:${'0'.repeat(52)}`),
								notBefore: deadline
							})
							.run();
						break;
					}
					case 'diagnostic': {
						instance.context.db
							.insert(schema.attestationInheritanceFailures)
							.values({
								...identity,
								category: 'inheritance-failed',
								exhaustion: 'attempt-limit',
								failures: 12,
								exhaustedAt: isoTimestamp(now),
								expiresAt: deadline
							})
							.run();
						break;
					}
				}
				await new MaintenanceEligibilityService(instance.context).reconcile(
					now
				);
			});
			const deferred = await eligibilityRow();
			const later = new Date(now.getTime() + 6 * 60_000);
			await runInDurableObject(currentServer(), (instance) =>
				new MaintenanceEligibilityService(instance.context).reconcile(later)
			);
			expect({ deferred, due: await eligibilityRow() }).toStrictEqual({
				deferred: {
					tenant: fixtureTenant,
					nextWakeAt: deadline,
					reconciledAt: now.toISOString()
				},
				due: {
					tenant: fixtureTenant,
					nextWakeAt: wakeImmediately,
					reconciledAt: later.toISOString()
				}
			});
		}
	);

	// The pass stops after its body and before its trailing reconciliation, as
	// it does when the isolate is evicted.
	it.each([
		{ row: 'absent', stored: 'absent', expected: undefined },
		{
			row: 'idle',
			stored: undefined,
			expected: {
				nextWakeAt: passInProgress,
				reconciledAt: previousReconciliation
			}
		},
		{
			row: 'future',
			stored: isoTimestampSchema.parse('2026-02-01T00:00:00.000Z'),
			expected: {
				nextWakeAt: passInProgress,
				reconciledAt: previousReconciliation
			}
		},
		{
			row: 'due',
			stored: wakeImmediately,
			expected: {
				nextWakeAt: wakeImmediately,
				reconciledAt: previousReconciliation
			}
		}
	] as const)(
		'leaves a $row tenant due when a fresh pass stops before reconciling',
		async ({ stored, expected }) => {
			await (stored === 'absent'
				? deleteEligibility()
				: seedEligibility(stored, previousReconciliation));

			await runInDurableObject(currentServer(), (instance) =>
				withMaintenanceEligibility(
					new MaintenanceEligibilityService(instance.context),
					() => Promise.resolve(),
					'fresh',
					() => {
						queueNarInfoDeletion(instance.context);

						return Promise.resolve();
					}
				)
			);

			expect(await eligibilityRow()).toStrictEqual(
				expected === undefined
					? undefined
					: { tenant: fixtureTenant, ...expected }
			);
		}
	);

	// Each case lets another writer reconcile while a fresh pass runs, and then
	// stops the pass before its own reconciliation. The other writer would
	// publish an idle or later wake for a tenant that now has due work.
	it.each([
		{
			writer: 'another fresh pass',
			stored: isoTimestampSchema.parse('2026-02-01T00:00:00.000Z'),
			expected: passInProgress,
			interfere: (service: MaintenanceEligibilityService) =>
				withMaintenanceEligibility(
					service,
					(change) => service.reconcile(now, change),
					'fresh',
					() => Promise.resolve()
				)
		},
		{
			writer: 'a mutation',
			stored: wakeImmediately,
			expected: wakeImmediately,
			interfere: (service: MaintenanceEligibilityService) =>
				service.reconcile(now)
		}
	])(
		'keeps the tenant due when $writer reconciles during a fresh pass',
		async ({ stored, expected, interfere }) => {
			await seedEligibility(stored, previousReconciliation);

			await runInDurableObject(currentServer(), (instance) => {
				const service = new MaintenanceEligibilityService(instance.context);

				return withMaintenanceEligibility(
					service,
					() => Promise.resolve(),
					'fresh',
					async () => {
						await interfere(service);
						queueNarInfoDeletion(instance.context);
					}
				);
			});

			expect(await eligibilityRow()).toStrictEqual({
				tenant: fixtureTenant,
				nextWakeAt: expected,
				reconciledAt: previousReconciliation
			});
		}
	);

	it('marks the row only after a reconciliation in flight has finished', async () => {
		const events = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const service = new MaintenanceEligibilityService(instance.context);
				const realD1 = instance.context.d1;
				const recorded: string[] = [];
				const held = Promise.withResolvers<undefined>();
				const publishing = Promise.withResolvers<undefined>();
				Object.defineProperty(instance.context, 'd1', {
					configurable: true,
					value: {
						insert: () => ({
							values: () => ({
								onConflictDoUpdate: () => ({
									run: async () => {
										recorded.push('publish');
										publishing.resolve(undefined);
										await held.promise;
										recorded.push('published');
									}
								})
							})
						}),
						update: (table: Parameters<typeof realD1.update>[0]) => {
							recorded.push('mark');

							return realD1.update(table);
						}
					}
				});

				const reconciliation = service.reconcile(now);
				await waitUntilReached(
					publishing.promise,
					reconciliation,
					"the reconciliation's D1 write"
				);
				const pass = withMaintenanceEligibility(
					service,
					() => Promise.resolve(),
					'fresh',
					() => {
						recorded.push('body');

						return Promise.resolve();
					}
				);
				setTimeout(() => {
					held.resolve(undefined);
				}, 0);
				await Promise.all([reconciliation, pass]);

				return recorded;
			}
		);

		expect(events).toStrictEqual(['publish', 'published', 'mark', 'body']);
	});

	// The pass's final write, an idle wake, is delayed until the mutation has
	// queued its work and started its own reconciliation. That reconciliation
	// waits for the delayed write and then publishes the due wake.
	it("keeps the tenant due when a mutation reconciles during a pass's final publication", async () => {
		await seedEligibility(
			isoTimestampSchema.parse('2026-02-01T00:00:00.000Z'),
			previousReconciliation
		);

		await runInDurableObject(currentServer(), async (instance) => {
			const service = new MaintenanceEligibilityService(instance.context);
			const realD1 = instance.context.d1;
			type Table = typeof d1Schema.tenantMaintenanceEligibility;
			type Insert = ReturnType<typeof realD1.insert<Table>>;
			type Values = Parameters<Insert['values']>[0];
			type Conflict = Parameters<
				ReturnType<Insert['values']>['onConflictDoUpdate']
			>[0];
			const publishing = Promise.withResolvers<undefined>();
			const release = Promise.withResolvers<undefined>();
			let isHeld = false;
			Object.defineProperty(instance.context, 'd1', {
				configurable: true,
				value: {
					update: realD1.update.bind(realD1),
					insert: (insertTable: Table) => {
						const insert = realD1.insert(insertTable);

						if (isHeld) {
							return insert;
						}

						isHeld = true;

						return {
							values: (values: Values) => ({
								onConflictDoUpdate: (conflict: Conflict) => ({
									run: async () => {
										publishing.resolve(undefined);
										await release.promise;

										return insert
											.values(values)
											.onConflictDoUpdate(conflict)
											.run();
									}
								})
							})
						};
					}
				}
			});

			const pass = withMaintenanceEligibility(
				service,
				(change) => service.reconcile(now, change),
				'fresh',
				() => Promise.resolve()
			);
			await waitUntilReached(
				publishing.promise,
				pass,
				"the pass's final D1 write"
			);

			queueNarInfoDeletion(instance.context);
			const mutation = service.reconcile(new Date(now.getTime() + 1000));
			await Promise.race([
				mutation,
				new Promise((resolve) => {
					setTimeout(resolve, 50);
				})
			]);
			release.resolve(undefined);
			await Promise.all([pass, mutation]);
		});

		expect(await eligibilityRow()).toStrictEqual({
			tenant: fixtureTenant,
			nextWakeAt: wakeImmediately,
			reconciledAt: '2026-01-01T00:00:01.000Z'
		});
	});

	it('does not run a pass when its mark cannot be written', async () => {
		const projectionMarkFailure = new MaintenanceProjectionTestError('mark');

		const outcome = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const maintenanceEligibility = new MaintenanceEligibilityService(
					instance.context
				);
				Object.defineProperty(instance.context, 'd1', {
					value: {
						update() {
							throw projectionMarkFailure;
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
						'fresh',
						() => {
							instance.context.db
								.insert(schema.pendingUploads)
								.values(
									pendingUpload(
										instance.context,
										'verify-after-failed-invalidation',
										isoTimestamp(now),
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
			error: { operation: 'mark' },
			pendingUploads: []
		});
	});

	it('marks verification and deletion work due immediately', async () => {
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.insert(schema.pendingUploads)
				.values([
					pendingUpload(
						instance.context,
						'waiting-bytes',
						isoTimestampSchema.parse('2026-01-02T00:00:00.000Z')
					),
					pendingUpload(
						instance.context,
						'verify-a',
						isoTimestampSchema.parse('2026-01-03T00:00:00.000Z'),
						'pending'
					),
					pendingUpload(
						instance.context,
						'verify-b',
						isoTimestampSchema.parse('2026-01-04T00:00:00.000Z'),
						'committing'
					)
				])
				.run();
			instance.context.db
				.insert(schema.narInfoDeletions)
				.values({
					cacheId: resolvedCache(instance.context).id,
					storePathHash: storePathHashSchema.parse('a'.repeat(32)),
					narHash: nixSha256HashSchema.parse(`sha256:${'0'.repeat(52)}`),
					generation: narInfoGenerationSchema.parse(0),
					createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z')
				})
				.run();
			instance.context.db
				.insert(schema.retentionRoots)
				.values({
					cacheId: resolvedCache(instance.context).id,
					name: rootNameSchema.parse('release'),
					expiresAt: isoTimestampSchema.parse('2026-01-05T00:00:00.000Z'),
					createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
					updatedAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z')
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
				.values(
					pendingUpload(
						instance.context,
						'terminal',
						isoTimestampSchema.parse('2026-01-04T00:00:00.000Z')
					)
				)
				.run();
			instance.context.db
				.insert(schema.retentionRoots)
				.values({
					cacheId: resolvedCache(instance.context).id,
					name: rootNameSchema.parse('release'),
					expiresAt: isoTimestampSchema.parse('2026-01-03T00:00:00.000Z'),
					createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
					updatedAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z')
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
					pendingAttestation(
						instance.context,
						'attestation-upload',
						isoTimestampSchema.parse('2026-01-02T00:00:00.000Z')
					)
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
					cacheId: resolvedCache(instance.context).id,
					storePathHash: storePathHashSchema.parse('a'.repeat(32)),
					retainUntil: isoTimestampSchema.parse('2026-01-02T00:00:00.000Z')
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
					cacheId: resolvedCache(instance.context).id,
					storePathHash: storePathHashSchema.parse('a'.repeat(32)),
					retainUntil: isoTimestampSchema.parse('2026-01-05T00:00:00.000Z')
				})
				.run();
			instance.context.db
				.insert(schema.retentionRoots)
				.values({
					cacheId: resolvedCache(instance.context).id,
					name: rootNameSchema.parse('release'),
					expiresAt: isoTimestampSchema.parse('2026-01-03T00:00:00.000Z'),
					createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
					updatedAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z')
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
						kid: authKeyIdSchema.parse('old-retired'),
						scheduledRetireAt: isoTimestampSchema.parse(
							'2026-01-02T00:00:00.000Z'
						),
						retiredAt: isoTimestampSchema.parse('2026-01-02T00:01:00.000Z')
					}),
					authKey({
						id: 'old-live',
						kid: authKeyIdSchema.parse('old-live'),
						scheduledRetireAt: isoTimestampSchema.parse(
							'2026-01-03T00:00:00.000Z'
						)
					}),
					authKey({ id: 'active', kid: authKeyIdSchema.parse('active') })
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

	it('uses the earliest consumed-nonce expiry as deferred work', async () => {
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.insert(schema.consumedSubjectNonces)
				.values([
					{
						nonce: 'later',
						expiresAt: isoTimestampSchema.parse('2026-01-02T00:00:00.000Z')
					},
					{
						nonce: 'sooner',
						expiresAt: isoTimestampSchema.parse('2026-01-01T00:05:30.000Z')
					}
				])
				.run();

			const service = new MaintenanceEligibilityService(instance.context);

			return service.reconcile(now);
		});

		expect(await eligibilityRow()).toStrictEqual({
			tenant: fixtureTenant,
			nextWakeAt: '2026-01-01T00:05:30.000Z',
			reconciledAt: now.toISOString()
		});
	});
});

describe('maintenance wake conflict resolution', () => {
	beforeEach(resetTestServer);

	const earlier = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');
	const later = isoTimestampSchema.parse('2026-02-01T00:00:00.000Z');
	const soonFuture = isoTimestampSchema.parse('2026-03-01T00:00:00.000Z');
	const farFuture = isoTimestampSchema.parse('2026-09-01T00:00:00.000Z');

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
					.values(
						pendingUpload(instance.context, 'incoming', farFuture, 'pending')
					)
					.run();
			} else if (work !== 'none') {
				instance.context.db
					.insert(schema.retentionRoots)
					.values({
						cacheId: resolvedCache(instance.context).id,
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

	// The tenant has no work, so each reconcile computes an idle wake.
	it.each([
		{
			name: 'keeps the in-progress mark against a newer reconcile',
			stored: { wake: passInProgress, reconciledAt: earlier },
			change: 'any',
			expected: { nextWakeAt: passInProgress, reconciledAt: earlier }
		},
		{
			name: 'replaces the in-progress mark at the end of a pass at the same instant',
			stored: { wake: passInProgress, reconciledAt: later },
			change: 'pass',
			expected: { nextWakeAt: undefined, reconciledAt: later }
		},
		{
			name: 'does not move the wake later from a sooner-only reconcile',
			stored: { wake: soonFuture, reconciledAt: earlier },
			change: 'sooner',
			expected: { nextWakeAt: soonFuture, reconciledAt: earlier }
		}
	] as const)('$name', async ({ stored, change, expected }) => {
		await seedEligibility(stored.wake, stored.reconciledAt);

		await runInDurableObject(currentServer(), (instance) =>
			new MaintenanceEligibilityService(instance.context).reconcile(
				new Date(later),
				change
			)
		);

		expect(await eligibilityRow()).toStrictEqual({
			tenant: fixtureTenant,
			...expected
		});
	});
});

async function seedEligibility(
	nextWakeAt: IsoTimestamp | undefined,
	reconciledAt: IsoTimestamp
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

async function deleteEligibility(): Promise<void> {
	await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
		.delete(d1Schema.tenantMaintenanceEligibility)
		.where(
			eq(
				d1Schema.tenantMaintenanceEligibility.tenant,
				tenantIdSchema.parse(fixtureTenant)
			)
		)
		.run();
}

function queueNarInfoDeletion(context: ServerContext): void {
	context.db
		.insert(schema.narInfoDeletions)
		.values({
			cacheId: resolvedCache(context).id,
			storePathHash: storePathHashSchema.parse('a'.repeat(32)),
			narHash: nixSha256HashSchema.parse(`sha256:${'0'.repeat(52)}`),
			generation: narInfoGenerationSchema.parse(0),
			createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z')
		})
		.run();
}

function pendingUpload(
	context: ServerContext,
	id: string,
	expiresAt: IsoTimestamp,
	verdict?: typeof schema.pendingUploads.$inferSelect.verdict
): typeof schema.pendingUploads.$inferInsert {
	return {
		id: uploadIdSchema.parse(id),
		cacheId: resolvedCache(context).id,
		narHash: nixSha256HashSchema.parse(`sha256:${'0'.repeat(52)}`),
		r2Key: r2ObjectKeySchema.parse(`staging/${id}`),
		metadataJson: '{}',
		createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
		expiresAt,
		verdict
	};
}

function pendingAttestation(
	context: ServerContext,
	id: string,
	expiresAt: IsoTimestamp
): typeof schema.pendingAttestations.$inferInsert {
	return {
		id: uploadIdSchema.parse(id),
		cacheId: resolvedCache(context).id,
		storePathHash: storePathHashSchema.parse('a'.repeat(32)),
		digest: sha256HexDigestSchema.parse('b'.repeat(64)),
		r2Key: r2ObjectKeySchema.parse(`staging/attestations/${id}`),
		createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
		expiresAt
	};
}

function authKey(
	overrides: Partial<typeof schema.authKeys.$inferInsert>
): typeof schema.authKeys.$inferInsert {
	return {
		id: 'key',
		kid: authKeyIdSchema.parse('key'),
		privateJwkJson: '{}',
		publicJwkJson: '{}',
		createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
		...overrides
	};
}
