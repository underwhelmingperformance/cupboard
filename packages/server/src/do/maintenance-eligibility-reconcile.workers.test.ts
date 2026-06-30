import {
	nixSha256HashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	bootstrap,
	commitUpload,
	currentServer,
	expectSingleUploadDecision,
	initialise,
	narBytes,
	negotiateUploads,
	negotiateViaInstance,
	putNarBytes,
	resetTestServer,
	uploadMetadata
} from '../test-support.ts';

// Stored for a tenant with work due now: a fixed past instant, so the many mutations
// of a push leave the row unchanged. Mirrors the sentinel in the service.
const wakeImmediately = new Date(0).toISOString();

// The maintenance reconcile runs synchronously on each mutation, publishing the
// tenant's wake time to D1 before the request returns: an existence check plus
// index-backed lookups, cheap enough to run inline rather than on a debounce alarm.
// Running it inline narrows the window in which an eviction can strand a stale
// not-due row to the gap between the committed write and the trailing reconcile.
describe('maintenance reconcile', () => {
	beforeEach(resetTestServer);

	it('publishes the wake time synchronously on a mutation', async () => {
		const token = await initialise();
		await insertPendingUpload('pending');

		await runInDurableObject(currentServer(), (instance) =>
			negotiateViaInstance(instance, token, 'a'.repeat(32))
		);

		// The seeded upload awaits verification, so the tenant is due now and the row
		// is published immediately, with nothing deferred to an alarm.
		expect(await wakeTime()).toBe(wakeImmediately);
	});

	it('writes D1 once across a push whose wake time does not change', async () => {
		const token = await initialise();
		await insertPendingUpload('pending');

		await runInDurableObject(currentServer(), (instance) =>
			negotiateViaInstance(instance, token, 'a'.repeat(32))
		);
		const afterFirst = await reconciledAt();

		await runInDurableObject(currentServer(), (instance) =>
			negotiateViaInstance(instance, token, 'b'.repeat(32))
		);
		const afterSecond = await reconciledAt();

		// The wake time is still "now", so the second mutation skips the redundant
		// write and `reconciled_at` does not advance.
		expect({
			published: afterFirst !== undefined,
			unchanged: afterSecond === afterFirst
		}).toStrictEqual({ published: true, unchanged: true });
	});

	it('publishes the wake time even when the mutating body throws', async () => {
		const token = await initialise();
		await insertPendingUpload('pending');

		const status = await runInDurableObject(
			currentServer(),
			async (instance) => {
				// The negotiate's own write throws partway through, but the reconcile runs
				// in a `finally`, so the wake time is still published.
				Object.defineProperty(instance.context.db, 'insert', {
					value: () => {
						throw new Error('insert failed mid-body');
					},
					configurable: true
				});

				const response = await negotiateViaInstance(
					instance,
					token,
					'c'.repeat(32)
				);

				return response.status;
			}
		);

		expect({ status, wake: await wakeTime() }).toStrictEqual({
			status: StatusCodes.INTERNAL_SERVER_ERROR,
			wake: wakeImmediately
		});
	});

	it('drops the projection when the reconcile write fails (fail-open)', async () => {
		const token = await initialise();
		await insertPendingUpload('pending');

		// The projection exists before the failing reconcile, so its disappearance below
		// is an observable drop, not a row that configure never wrote.
		const before = await eligibilityRow();

		await runInDurableObject(currentServer(), async (instance) => {
			// The reconcile publishes through D1; make its write fail. The hook drops the
			// row instead, so the periodic sweep reads the tenant as due.
			const realD1 = instance.context.d1;
			Object.defineProperty(instance.context, 'd1', {
				value: {
					select: realD1.select.bind(realD1),
					insert: () => {
						throw new Error('eligibility write failed');
					},
					delete: realD1.delete.bind(realD1)
				},
				configurable: true
			});

			await negotiateViaInstance(instance, token, 'a'.repeat(32));
		});

		expect({
			present: before !== undefined,
			after: await eligibilityRow()
		}).toStrictEqual({ present: true, after: undefined });
	});

	it('republishes the wake time when a commit settles an upload', async () => {
		const { token } = await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const negotiate = await negotiateUploads(token, [metadata]);
		const upload = expectSingleUploadDecision(negotiate, metadata);
		await putNarBytes(upload.r2Key);

		// A stale projection left from before the commit: a sentinel wake no real state
		// produces, stamped far in the past. The commit's reconcile must overwrite it.
		const staleReconciledAt = '2000-01-01T00:00:00.000Z';
		await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
			.insert(d1Schema.tenantMaintenanceEligibility)
			.values({
				tenant: tenantIdSchema.parse(fixtureTenant),
				nextWakeAt: '2099-12-31T23:59:59.999Z',
				reconciledAt: staleReconciledAt
			})
			.onConflictDoUpdate({
				target: d1Schema.tenantMaintenanceEligibility.tenant,
				set: {
					nextWakeAt: '2099-12-31T23:59:59.999Z',
					reconciledAt: staleReconciledAt
				}
			})
			.run();

		await commitUpload(token, upload.uploadId);

		// The commit runs through `afterMutation`, so its reconcile republishes the wake
		// time: the settled upload leaves no immediate work, so the sentinel wake clears
		// to null and the timestamp advances off the seeded-stale value. Dropping the
		// commit's reconcile would leave the stale row untouched. `reconciledAt` is the
		// commit's wall-clock stamp, so assert it moved rather than its exact value.
		const row = await eligibilityRow();
		expect({
			tenant: row?.tenant,
			nextWakeAt: row?.nextWakeAt ?? undefined,
			advancedOffStale: row?.reconciledAt !== staleReconciledAt
		}).toStrictEqual({
			tenant: fixtureTenant,
			nextWakeAt: undefined,
			advancedOffStale: true
		});
	});
});

async function insertPendingUpload(
	verdict?: typeof schema.pendingUploads.$inferSelect.verdict
): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		instance.context.db
			.insert(schema.pendingUploads)
			.values({
				id: 'seed-upload',
				cache: '',
				narHash: nixSha256HashSchema.parse(`sha256:${'0'.repeat(52)}`),
				r2Key: 'staging/seed-upload',
				metadataJson: '{}',
				createdAt: '2026-01-01T00:00:00.000Z',
				expiresAt: '2026-06-01T00:00:00.000Z',
				verdict
			})
			.run();
	});
}

async function wakeTime(): Promise<string | undefined> {
	const row = await eligibilityRow();

	return row?.nextWakeAt ?? undefined;
}

async function reconciledAt(): Promise<string | undefined> {
	const row = await eligibilityRow();

	return row?.reconciledAt;
}

async function eligibilityRow(): Promise<
	typeof d1Schema.tenantMaintenanceEligibility.$inferSelect | undefined
> {
	return drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
		.select()
		.from(d1Schema.tenantMaintenanceEligibility)
		.where(
			eq(
				d1Schema.tenantMaintenanceEligibility.tenant,
				tenantIdSchema.parse(fixtureTenant)
			)
		)
		.get();
}
