import {
	nixSha256HashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { isoTimestamp, isoTimestampSchema } from '@cupboard/protocol/scalars';
import { type UploadId, uploadIdSchema } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { r2ObjectKeySchema } from '../http/http.ts';
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
	resolvedCache,
	uploadMetadata,
	verifiableNar
} from '../test-support.ts';

const wakeImmediately = isoTimestamp(new Date(0));

// Mutations invalidate the projection before writing and reconcile it before
// returning. An eviction can therefore strand a stale projection only between
// the durable mutation and its trailing reconciliation.
describe('maintenance reconcile', () => {
	beforeEach(resetTestServer);

	it('publishes the wake time synchronously on a mutation', async () => {
		const token = await initialise();
		await insertPendingUpload('pending');

		await runInDurableObject(currentServer(), (instance) =>
			negotiateViaInstance(instance, token, 'a'.repeat(32))
		);

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

		const before = await eligibilityRow();

		await runInDurableObject(currentServer(), async (instance) => {
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

		// Use a wake time that current local state cannot produce, so the commit must
		// replace the seeded projection.
		const staleReconciledAt = isoTimestampSchema.parse(
			'2000-01-01T00:00:00.000Z'
		);
		await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
			.insert(d1Schema.tenantMaintenanceEligibility)
			.values({
				tenant: tenantIdSchema.parse(fixtureTenant),
				nextWakeAt: isoTimestampSchema.parse('2099-12-31T23:59:59.999Z'),
				reconciledAt: staleReconciledAt
			})
			.onConflictDoUpdate({
				target: d1Schema.tenantMaintenanceEligibility.tenant,
				set: {
					nextWakeAt: isoTimestampSchema.parse('2099-12-31T23:59:59.999Z'),
					reconciledAt: staleReconciledAt
				}
			})
			.run();

		await commitUpload(token, upload.uploadId);

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

async function ownedReuseDecision(): Promise<{
	token: string;
	uploadId: UploadId;
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

// Release this hold before teardown; a pending Durable Object promise can race
// the suite cleanup.
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

// Reuse commits settle without a verification pass, isolating the coalesced
// eligibility publication exercised here.
describe('coalesced maintenance reconcile', () => {
	beforeEach(resetTestServer);

	it('publishes the wake time behind a settled reuse commit', async () => {
		const { token, uploadId } = await ownedReuseDecision();

		// Current local state cannot produce this wake, so the asynchronous publish
		// must replace it.
		const staleReconciledAt = isoTimestampSchema.parse(
			'2000-01-01T00:00:00.000Z'
		);
		await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
			.insert(d1Schema.tenantMaintenanceEligibility)
			.values({
				tenant: tenantIdSchema.parse(fixtureTenant),
				nextWakeAt: isoTimestampSchema.parse('2099-12-31T23:59:59.999Z'),
				reconciledAt: staleReconciledAt
			})
			.onConflictDoUpdate({
				target: d1Schema.tenantMaintenanceEligibility.tenant,
				set: {
					nextWakeAt: isoTimestampSchema.parse('2099-12-31T23:59:59.999Z'),
					reconciledAt: staleReconciledAt
				}
			})
			.run();

		const response = await commitUpload(token, uploadId);

		expect(response.status).toBe('committed');

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
			// Hold the publication so a reply proves that the commit does not await it.
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
		const cacheId = resolvedCache(instance.context).id;

		instance.context.db
			.insert(schema.pendingUploads)
			.values({
				id: uploadIdSchema.parse('seed-upload'),
				cacheId,
				narHash: nixSha256HashSchema.parse(`sha256:${'0'.repeat(52)}`),
				r2Key: r2ObjectKeySchema.parse('staging/seed-upload'),
				metadataJson: '{}',
				createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
				expiresAt: isoTimestampSchema.parse('2026-06-01T00:00:00.000Z'),
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
