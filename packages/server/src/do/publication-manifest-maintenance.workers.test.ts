import { cacheGenerationSchema } from '@cupboard/nix-store/scalars';
import { publicationCleanupMarginMs } from '@cupboard/protocol/publication';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	currentServer,
	initialise,
	resetTestServer,
	resolvedCache,
	testPushId,
	withoutAlarmArming
} from '../test-support.ts';

import { MaintenanceEligibilityService } from './maintenance-eligibility-service.ts';
import { PublicationManifestCleanup } from './publication-manifest-cleanup.ts';
import { withRowBudget } from './row-budget.ts';

const now = new Date('2026-01-01T00:00:00.000Z');
const future = isoTimestamp(new Date('2026-01-02T00:15:00.000Z'));

async function wake() {
	const row = await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
		.select()
		.from(d1Schema.tenantMaintenanceEligibility)
		.where(eq(d1Schema.tenantMaintenanceEligibility.tenant, fixtureTenant))
		.get();
	return row?.nextWakeAt;
}

beforeEach(resetTestServer);

describe('publication manifest maintenance scheduling', () => {
	it('schedules receipt pruning after the tombstone interval without moving the operation deadline', async () => {
		await withoutAlarmArming(async () => {
			await initialise();
			await runInDurableObject(currentServer(), (instance) => {
				const cache = resolvedCache(instance.context);
				instance.context.db
					.insert(schema.publicationManifestOperations)
					.values({
						id: 'tombstone',
						requestId: 'tombstone',
						kind: 'capture',
						cacheId: cache.id,
						cacheGeneration: cache.generation,
						canonicalJson: '{}',
						resultIdentityJson: '{}',
						origin: 'build-selection',
						expectedCount: 1,
						state: 'complete',
						expiresAt: future
					})
					.run();
				const operation = instance.context.db
					.select()
					.from(schema.publicationManifestOperations)
					.get();
				const cleanup = new PublicationManifestCleanup(instance.context.db);
				const deadline = isoTimestamp(
					new Date(Date.parse(future) + publicationCleanupMarginMs)
				);
				expect(cleanup.nextWake()).toBe(deadline);
				expect(withRowBudget(() => cleanup.collect(future, 64))).toBe(false);
				expect(
					instance.context.db
						.select()
						.from(schema.publicationManifestOperations)
						.get()
				).toEqual(operation);
				expect(withRowBudget(() => cleanup.collect(deadline, 64))).toBe(false);
				expect(
					instance.context.db
						.select()
						.from(schema.publicationManifestOperations)
						.all()
				).toEqual([]);
				expect(cleanup.nextWake()).toBeUndefined();
			});
		});
	});

	it('discovers lifecycle-only work through maintenance eligibility and drains it through the existing alarm', async () => {
		const pending = await withoutAlarmArming(async () => {
			await initialise();
			return runInDurableObject(currentServer(), async (instance) => {
				const cache = resolvedCache(instance.context);
				const operation = instance.context.db
					.insert(schema.publicationManifestOperations)
					.values({
						id: 'lifecycle-pending',
						requestId: 'lifecycle-pending',
						kind: 'ensure',
						cacheId: cache.id,
						cacheGeneration: cache.generation,
						canonicalJson: '{}',
						resultIdentityJson: '{}',
						origin: 'build-selection',
						expectedCount: 1,
						state: 'pending',
						expiresAt: future
					})
					.returning()
					.get();
				instance.context.db
					.update(schema.cacheIdentities)
					.set({ generation: cacheGenerationSchema.parse(2) })
					.run();
				const cleanup = new PublicationManifestCleanup(instance.context.db);
				expect(cleanup.hasWork(isoTimestamp(now))).toBe(true);
				instance.context.db
					.update(schema.garbageCollectionInputs)
					.set({ inputsChanged: false })
					.where(eq(schema.garbageCollectionInputs.cacheId, cache.id))
					.run();
				await new MaintenanceEligibilityService(instance.context).reconcile(
					now
				);
				return operation;
			});
		});
		expect(await wake()).toBe(new Date(0).toISOString());
		for (let pass = 0; pass < 10; pass += 1) {
			await runInDurableObject(currentServer(), (instance) => instance.alarm());
		}
		await runInDurableObject(currentServer(), (instance) => {
			expect(
				instance.context.db
					.select()
					.from(schema.publicationManifestOperations)
					.where(eq(schema.publicationManifestOperations.id, pending.id))
					.get()
			).toEqual({
				...pending,
				state: 'failed',
				failureJson: '{"kind":"failed","reason":"scope-changed"}'
			});
			expect(
				instance.context.db
					.select()
					.from(schema.garbageCollectionInputs)
					.where(eq(schema.garbageCollectionInputs.cacheId, pending.cacheId))
					.get()?.inputsChanged
			).toBe(true);
			expect(
				instance.context.db
					.select()
					.from(schema.publicationManifestLifecycleIntents)
					.all()
			).toEqual([]);
			expect(
				new PublicationManifestCleanup(instance.context.db).hasWork(
					isoTimestamp(now)
				)
			).toBe(false);
		});
	});

	it('publishes future admission cleanup and due retirement without advancing publication', async () => {
		await withoutAlarmArming(async () => {
			await runInDurableObject(currentServer(), async (instance) => {
				instance.context.db
					.insert(schema.publicationManifestAdmissions)
					.values({
						operationId: 'maintenance',
						destinationKind: 'default',
						cacheGeneration: cacheGenerationSchema.parse(1),
						canonicalJson: '{}',
						pushId: testPushId,
						expiresAt: isoTimestamp(new Date('2026-01-02T00:00:00.000Z')),
						pruneAfter: future
					})
					.run();
				const cleanup = new PublicationManifestCleanup(instance.context.db);
				expect(cleanup.hasWork(isoTimestamp(now))).toBe(false);
				expect(cleanup.nextWake()).toBe(future);
				await new MaintenanceEligibilityService(instance.context).reconcile(
					now
				);
			});
			expect(await wake()).toBe(future);
			await runInDurableObject(currentServer(), async (instance) => {
				instance.context.db
					.insert(schema.publicationManifestRetirements)
					.values({ materialisationId: 'due' })
					.run();
				expect(
					new PublicationManifestCleanup(instance.context.db).hasWork(
						isoTimestamp(now)
					)
				).toBe(true);
				await new MaintenanceEligibilityService(instance.context).reconcile(
					new Date(now.getTime() + 1)
				);
			});
			expect(await wake()).toBe(new Date(0).toISOString());
		});
	});
	it('drains due orphan mapping pages through the existing garbage-collection alarm job', async () => {
		await withoutAlarmArming(async () => {
			await runInDurableObject(currentServer(), (instance) => {
				instance.context.db
					.insert(schema.publicationManifestAdmissions)
					.values({
						operationId: 'alarm-orphan',
						destinationKind: 'default',
						cacheGeneration: cacheGenerationSchema.parse(1),
						canonicalJson: '{}',
						pushId: testPushId,
						expiresAt: isoTimestamp(new Date(0)),
						pruneAfter: isoTimestamp(new Date(1))
					})
					.run();
				for (let page = 0; page < 129; page += 1) {
					instance.context.db
						.insert(schema.publicationManifestOperationPages)
						.values({
							operationId: 'alarm-orphan',
							page,
							payloadDigest: 'digest',
							payloadJson: '{}'
						})
						.run();
				}
			});
			for (let pass = 0; pass < 10; pass += 1) {
				await runInDurableObject(currentServer(), (instance) =>
					instance.alarm()
				);
			}
			await runInDurableObject(currentServer(), (instance) => {
				expect(
					instance.context.db
						.select()
						.from(schema.publicationManifestAdmissions)
						.get()
				).toBeUndefined();
				expect(
					instance.context.db
						.select()
						.from(schema.publicationManifestOperationPages)
						.all()
				).toHaveLength(0);
			});
		});
	});
});
