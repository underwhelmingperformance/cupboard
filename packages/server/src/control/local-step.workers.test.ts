import { rootLogger } from '@cupboard/logger';
import { type TenantId, tenantIdSchema } from '@cupboard/nix-store/scalars';
import { currentLocalStep, localStep } from '@cupboard/protocol/deployment';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { describe, expect, it } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import { tenantServer } from '../routing/durable-object.ts';
import { provisionNamedTenant, suspendTenant } from '../test-support.ts';

import { controlLocalStepStatus, controlLocalStepWake } from './local-step.ts';

const logger = rootLogger();
const laterStep = localStep(currentLocalStep + 1);

function database(): ReturnType<typeof drizzleD1<typeof d1Schema>> {
	return drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
}

async function storedStep(name: string): Promise<number | null | undefined> {
	const row = await database()
		.select({ localStep: d1Schema.tenant.localStep })
		.from(d1Schema.tenant)
		.where(eq(d1Schema.tenant.id, tenantIdSchema.parse(name)))
		.get();

	return row?.localStep;
}

function setStoredStep(name: string, step: number): Promise<unknown> {
	return database()
		.update(d1Schema.tenant)
		.set({ localStep: localStep(step) })
		.where(eq(d1Schema.tenant.id, tenantIdSchema.parse(name)))
		.run();
}

function wake(limit: number): Promise<{
	current: number;
	woken: number;
	failed: number;
}> {
	return controlLocalStepWake(logger, env, limit);
}

function tenant(name: string): TenantId {
	return tenantIdSchema.parse(name);
}

describe('local step', () => {
	it('counts a tenant that has never reported as pending and names it', async () => {
		await provisionNamedTenant('step-unreported');

		await expect(controlLocalStepStatus(env)).resolves.toStrictEqual({
			current: currentLocalStep,
			ready: 0,
			pending: 1,
			stragglers: [tenant('step-unreported')]
		});
	});

	it('brings every active tenant to the current step without traffic', async () => {
		await provisionNamedTenant('step-one');
		await provisionNamedTenant('step-two');

		await expect(wake(10)).resolves.toStrictEqual({
			current: currentLocalStep,
			woken: 2,
			failed: 0
		});
		await expect(controlLocalStepStatus(env)).resolves.toStrictEqual({
			current: currentLocalStep,
			ready: 2,
			pending: 0,
			stragglers: []
		});
	});

	it('leaves an unconfigured tenant pending and counts the wake as failed', async () => {
		await provisionNamedTenant('step-unconfigured', { configure: false });

		await expect(wake(10)).resolves.toStrictEqual({
			current: currentLocalStep,
			woken: 0,
			failed: 1
		});
		await expect(storedStep('step-unconfigured')).resolves.toBeNull();
	});

	it('ignores a suspended tenant', async () => {
		await provisionNamedTenant('step-suspended');
		await suspendTenant('step-suspended');

		await expect(wake(10)).resolves.toStrictEqual({
			current: currentLocalStep,
			woken: 0,
			failed: 0
		});
		await expect(controlLocalStepStatus(env)).resolves.toStrictEqual({
			current: currentLocalStep,
			ready: 0,
			pending: 0,
			stragglers: []
		});
	});

	it('wakes no more tenants than the limit allows', async () => {
		await provisionNamedTenant('step-batch-a');
		await provisionNamedTenant('step-batch-b');

		await expect(wake(1)).resolves.toStrictEqual({
			current: currentLocalStep,
			woken: 1,
			failed: 0
		});
		await expect(controlLocalStepStatus(env)).resolves.toStrictEqual({
			current: currentLocalStep,
			ready: 1,
			pending: 1,
			stragglers: [tenant('step-batch-b')]
		});
	});

	it('does not select a tenant that is already past the current step', async () => {
		await provisionNamedTenant('step-ahead');
		await setStoredStep('step-ahead', laterStep);

		await expect(wake(10)).resolves.toStrictEqual({
			current: currentLocalStep,
			woken: 0,
			failed: 0
		});
		await expect(controlLocalStepStatus(env)).resolves.toStrictEqual({
			current: currentLocalStep,
			ready: 1,
			pending: 0,
			stragglers: []
		});
	});

	// A newer build records a higher step. Rolling back to this one must not
	// lower it, or a later phase would wait for work that is already done.
	it('keeps a step a newer build recorded when the object reports', async () => {
		const id = tenant('step-rolled-back');
		await provisionNamedTenant(id);
		await setStoredStep(id, laterStep);

		await expect(
			tenantServer(env, id).reportLocalStep()
		).resolves.toStrictEqual({ kind: 'recorded', step: currentLocalStep });
		await expect(storedStep(id)).resolves.toStrictEqual(laterStep);
	});
});
