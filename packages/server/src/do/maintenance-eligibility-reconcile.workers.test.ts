import {
	nixSha256HashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	bootstrap,
	commitPath,
	commitUpload,
	currentServer,
	expectSingleCommitDecision,
	expectSingleUploadDecision,
	initialise,
	narBytes,
	negotiateUploads,
	negotiateViaInstance,
	putNarBytes,
	resetTestServer,
	uploadMetadata,
	verifiableNar
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

// A commit replies without waiting on the eligibility publish: the publish
// runs behind the reply, with concurrent requests coalescing onto a shared
// drain. These drive it through a reuse commit, which settles with no
// verification pass, so the trailing coalesced publish is the only reconcile
// in play.
// A tenant owning a hash, plus a fresh reuse decision for it: the commit
// settles synchronously from the canonical object.
async function ownedReuseDecision(): Promise<{
	token: string;
	uploadId: string;
}> {
	const token = await initialise();
	const nar = await verifiableNar('coalesced-reconcile');
	const first = uploadMetadata({
		name: 'first',
		storePathHash: 'a'.repeat(32),
		narHash: nar.narHash,
		fileHash: nar.fileHash,
		fileSize: nar.narBytes.byteLength,
		narSize: nar.narSize
	});

	await commitPath(token, first, nar);

	const reuse = uploadMetadata({
		name: 'reuse',
		storePathHash: 'b'.repeat(32),
		narHash: nar.narHash,
		fileHash: nar.fileHash,
		fileSize: nar.narBytes.byteLength,
		narSize: nar.narSize
	});
	const decision = expectSingleCommitDecision(
		await negotiateUploads(token, [reuse]),
		reuse
	);

	return { token, uploadId: decision.uploadId };
}

// A hold the wedged eligibility publish parks on, so the test observes the
// reply not waiting on it. Released before the test ends: a promise left
// pending inside the Durable Object races the suite's final teardown.
function parkUntilReleased(): {
	readonly park: () => Promise<void>;
	readonly release: () => void;
} {
	const { promise, resolve } = Promise.withResolvers<undefined>();

	return {
		park: async () => {
			await promise;
		},
		release: () => {
			resolve(undefined);
		}
	};
}

// A commit replies without waiting on the eligibility publish: the publish
// runs behind the reply, with concurrent requests coalescing onto a shared
// drain. These drive it through a reuse commit, which settles with no
// verification pass, so the trailing coalesced publish is the only reconcile
// in play.
describe('coalesced maintenance reconcile', () => {
	beforeEach(resetTestServer);

	it('publishes the wake time behind a settled reuse commit', async () => {
		const { token, uploadId } = await ownedReuseDecision();

		// A stale projection with a sentinel wake no real state produces. The
		// commit's coalesced publish must overwrite it after the reply.
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

		const response = await commitUpload(token, uploadId);

		expect(response.status).toBe('committed');

		// The publish is not awaited by the reply, so observe it land.
		await vi.waitFor(async () => {
			const row = await eligibilityRow();

			expect({
				nextWakeAt: row?.nextWakeAt ?? undefined,
				advancedOffStale: row?.reconciledAt !== staleReconciledAt
			}).toStrictEqual({ nextWakeAt: undefined, advancedOffStale: true });
		});
	});

	it('replies to a commit without waiting on the eligibility publish', async () => {
		const { token, uploadId } = await ownedReuseDecision();
		const hold = parkUntilReleased();

		try {
			// Wedge every eligibility publish on the hold. The commit must still
			// reply, since the publish runs behind it.
			await runInDurableObject(currentServer(), (instance) => {
				const realD1 = instance.context.d1;

				Object.defineProperty(instance.context, 'd1', {
					configurable: true,
					value: {
						select: realD1.select.bind(realD1),
						update: realD1.update.bind(realD1),
						delete: realD1.delete.bind(realD1),
						batch: realD1.batch.bind(realD1),
						insert: (table: Parameters<typeof realD1.insert>[0]) =>
							table === d1Schema.tenantMaintenanceEligibility
								? {
										values: () => ({
											onConflictDoUpdate: () => ({
												run: () => hold.park()
											})
										})
									}
								: realD1.insert(table)
					}
				});
			});

			const response = await commitUpload(token, uploadId);

			expect(response.status).toBe('committed');
		} finally {
			hold.release();
		}
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
