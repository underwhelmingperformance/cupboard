import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { defaultTenant } from '../routing/tenant-routing.ts';
import { currentServer, resetTestServer } from '../test-support.ts';

import { MaintenanceEligibilityService } from './maintenance-eligibility-service.ts';

const now = new Date('2026-01-01T00:00:00.000Z');

function eligibilityRow(tenant: string = defaultTenant) {
	return drizzleD1(env.CUPBOARD_DB, {
		schema: {
			tenantMaintenanceEligibility: d1Schema.tenantMaintenanceEligibility
		}
	})
		.select()
		.from(d1Schema.tenantMaintenanceEligibility)
		.where(eq(d1Schema.tenantMaintenanceEligibility.tenant, tenant))
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
				tenant: defaultTenant,
				pendingVerificationCount: 0,
				earliestUploadExpiry: undefined,
				queuedNarInfoDeletionCount: 0,
				earliestRootExpiry: undefined,
				nextMaintenanceAt: undefined,
				reconciledAt: now.toISOString()
			},
			row: {
				tenant: defaultTenant,
				pendingVerificationCount: 0,
				earliestUploadExpiry: undefined,
				queuedNarInfoDeletionCount: 0,
				earliestRootExpiry: undefined,
				nextMaintenanceAt: undefined,
				reconciledAt: now.toISOString()
			}
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
					storePathHash: 'a'.repeat(32),
					narHash: 'sha256:nar',
					generation: 0,
					createdAt: '2026-01-01T00:00:00.000Z'
				})
				.run();
			instance.context.db
				.insert(schema.retentionRoots)
				.values({
					cache: '',
					name: 'release',
					expiresAt: '2026-01-05T00:00:00.000Z',
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z'
				})
				.run();

			return new MaintenanceEligibilityService(instance.context).reconcile(now);
		});

		expect({ snapshot, row: await eligibilityRow() }).toStrictEqual({
			snapshot: {
				tenant: defaultTenant,
				pendingVerificationCount: 2,
				earliestUploadExpiry: '2026-01-02T00:00:00.000Z',
				queuedNarInfoDeletionCount: 1,
				earliestRootExpiry: '2026-01-05T00:00:00.000Z',
				nextMaintenanceAt: now.toISOString(),
				reconciledAt: now.toISOString()
			},
			row: {
				tenant: defaultTenant,
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
					name: 'release',
					expiresAt: '2026-01-03T00:00:00.000Z',
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z'
				})
				.run();

			return new MaintenanceEligibilityService(instance.context).reconcile(now);
		});

		expect(snapshot).toStrictEqual({
			tenant: defaultTenant,
			pendingVerificationCount: 0,
			earliestUploadExpiry: '2026-01-04T00:00:00.000Z',
			queuedNarInfoDeletionCount: 0,
			earliestRootExpiry: '2026-01-03T00:00:00.000Z',
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
		narHash: `sha256:${id}`,
		r2Key: `staging/${id}`,
		expectedSize: 0,
		metadataJson: '{}',
		createdAt: '2026-01-01T00:00:00.000Z',
		expiresAt,
		verdict
	};
}
