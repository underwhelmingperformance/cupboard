import {
	nixSha256HashSchema,
	rootNameSchema,
	sha256HexDigestSchema,
	storePathHashSchema,
	tenantIdSchema
} from '@cupboard/nix/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
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

function eligibilityRow(tenant: string = fixtureTenant) {
	return drizzleD1(env.CUPBOARD_DB, {
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
		.get()
		.then((row) =>
			row === undefined
				? undefined
				: {
						tenant: row.tenant,
						pendingVerificationCount: row.pendingVerificationCount,
						earliestUploadExpiry: row.earliestUploadExpiry ?? undefined,
						queuedNarInfoDeletionCount: row.queuedNarInfoDeletionCount,
						earliestRootExpiry: row.earliestRootExpiry ?? undefined,
						nextMaintenanceAt: row.nextMaintenanceAt ?? undefined,
						reconciledAt: row.reconciledAt
					}
		);
}

describe('maintenance eligibility projection', () => {
	beforeEach(resetTestServer);

	it('records an idle tenant with no next maintenance time', async () => {
		const snapshot = await runInDurableObject(currentServer(), (instance) =>
			new MaintenanceEligibilityService(instance.context).reconcile(now)
		);

		expect({ snapshot, row: await eligibilityRow() }).toStrictEqual({
			snapshot: {
				tenant: fixtureTenant,
				pendingVerificationCount: 0,
				earliestUploadExpiry: undefined,
				queuedNarInfoDeletionCount: 0,
				earliestRootExpiry: undefined,
				nextMaintenanceAt: undefined,
				reconciledAt: now.toISOString()
			},
			row: {
				tenant: fixtureTenant,
				pendingVerificationCount: 0,
				earliestUploadExpiry: undefined,
				queuedNarInfoDeletionCount: 0,
				earliestRootExpiry: undefined,
				nextMaintenanceAt: undefined,
				reconciledAt: now.toISOString()
			}
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
				const error = await withMaintenanceEligibility(
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
				).catch((error_: unknown) => error_);

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
		const snapshot = await runInDurableObject(currentServer(), (instance) => {
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

			return new MaintenanceEligibilityService(instance.context).reconcile(now);
		});

		expect({ snapshot, row: await eligibilityRow() }).toStrictEqual({
			snapshot: {
				tenant: fixtureTenant,
				pendingVerificationCount: 2,
				earliestUploadExpiry: '2026-01-02T00:00:00.000Z',
				queuedNarInfoDeletionCount: 1,
				earliestRootExpiry: '2026-01-05T00:00:00.000Z',
				nextMaintenanceAt: now.toISOString(),
				reconciledAt: now.toISOString()
			},
			row: {
				tenant: fixtureTenant,
				pendingVerificationCount: 2,
				earliestUploadExpiry: '2026-01-02T00:00:00.000Z',
				queuedNarInfoDeletionCount: 1,
				earliestRootExpiry: '2026-01-05T00:00:00.000Z',
				nextMaintenanceAt: now.toISOString(),
				reconciledAt: now.toISOString()
			}
		});
	});

	it('uses the earliest expiry when there is no immediate work', async () => {
		const snapshot = await runInDurableObject(currentServer(), (instance) => {
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

			return new MaintenanceEligibilityService(instance.context).reconcile(now);
		});

		expect(snapshot).toStrictEqual({
			tenant: fixtureTenant,
			pendingVerificationCount: 0,
			earliestUploadExpiry: '2026-01-04T00:00:00.000Z',
			queuedNarInfoDeletionCount: 0,
			earliestRootExpiry: '2026-01-03T00:00:00.000Z',
			nextMaintenanceAt: '2026-01-03T00:00:00.000Z',
			reconciledAt: now.toISOString()
		});
	});

	it('uses pending attestation expiry as deferred maintenance work', async () => {
		const snapshot = await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.insert(schema.pendingAttestations)
				.values(
					pendingAttestation('attestation-upload', '2026-01-02T00:00:00.000Z')
				)
				.run();

			return new MaintenanceEligibilityService(instance.context).reconcile(now);
		});

		expect(snapshot).toStrictEqual({
			tenant: fixtureTenant,
			pendingVerificationCount: 0,
			earliestUploadExpiry: '2026-01-02T00:00:00.000Z',
			queuedNarInfoDeletionCount: 0,
			earliestRootExpiry: undefined,
			nextMaintenanceAt: '2026-01-02T00:00:00.000Z',
			reconciledAt: now.toISOString()
		});
	});

	it('uses the earliest unretired auth-key retirement as deferred work', async () => {
		const snapshot = await runInDurableObject(currentServer(), (instance) => {
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

			return new MaintenanceEligibilityService(instance.context).reconcile(now);
		});

		expect(snapshot).toStrictEqual({
			tenant: fixtureTenant,
			pendingVerificationCount: 0,
			earliestUploadExpiry: undefined,
			queuedNarInfoDeletionCount: 0,
			earliestRootExpiry: undefined,
			nextMaintenanceAt: '2026-01-03T00:00:00.000Z',
			reconciledAt: now.toISOString()
		});
	});
});

function pendingUpload(
	id: string,
	expiresAt: string,
	verdict?: typeof schema.pendingUploads.$inferSelect.verdict
): typeof schema.pendingUploads.$inferInsert {
	return {
		id,
		cache: '',
		narHash: nixSha256HashSchema.parse(`sha256:${'0'.repeat(52)}`),
		r2Key: `staging/${id}`,
		expectedSize: 0,
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
		id,
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
