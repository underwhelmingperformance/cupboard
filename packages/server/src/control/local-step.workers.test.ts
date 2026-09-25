import { rootLogger } from '@cupboard/logger';
import { type TenantId, tenantIdSchema } from '@cupboard/nix-store/scalars';
import {
	currentLocalStep,
	expansionLocalStep,
	localStep
} from '@cupboard/protocol/deployment';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { describe, expect, it } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import { tenantServer } from '../routing/durable-object.ts';
import {
	provisionNamedTenant,
	recordTransition,
	suspendTenant
} from '../test-support.ts';

import {
	controlLocalStepStatus,
	controlLocalStepWake,
	requiredLocalStep
} from './local-step.ts';

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

describe('required local step', () => {
	it.each([
		{
			name: 'no transition recorded',
			record: undefined,
			step: expansionLocalStep
		},
		{
			name: 'cache-identity expanded',
			record: 'expanded' as const,
			step: expansionLocalStep
		},
		{
			name: 'cache-identity complete',
			record: 'complete' as const,
			step: currentLocalStep
		}
	])('is $step with $name', async ({ record, step }) => {
		if (record !== undefined) {
			await recordTransition('cache-identity', record);
		}

		await expect(requiredLocalStep(env)).resolves.toBe(step);
	});
});

describe('local step', () => {
	it('counts a tenant that has never reported as pending and names it', async () => {
		await provisionNamedTenant('step-unreported');

		await expect(controlLocalStepStatus(env)).resolves.toStrictEqual({
			current: currentLocalStep,
			required: expansionLocalStep,
			ready: 0,
			pending: 1,
			stragglers: [tenant('step-unreported')],
			sweep: { state: 'idle' }
		});
	});

	it('brings every active tenant to the current step without traffic', async () => {
		await recordTransition('cache-identity', 'complete');
		await provisionNamedTenant('step-one');
		await provisionNamedTenant('step-two');

		await expect(wake(10)).resolves.toStrictEqual({
			current: currentLocalStep,
			woken: 2,
			failed: 0,
			outcomes: [
				{
					tenant: tenant('step-one'),
					kind: 'recorded',
					step: currentLocalStep
				},
				{ tenant: tenant('step-two'), kind: 'recorded', step: currentLocalStep }
			]
		});
		await expect(controlLocalStepStatus(env)).resolves.toStrictEqual({
			current: currentLocalStep,
			required: currentLocalStep,
			ready: 2,
			pending: 0,
			stragglers: [],
			sweep: { state: 'idle' }
		});
	});

	// Before the contraction an object reports at most the expansion step, so
	// a tenant there has reached everything the transitions require of it now.
	// Counting it as pending would keep a settlement waiting for the contraction
	// that itself waits on the settlement.
	it('counts a tenant at the expansion step as ready before the contraction', async () => {
		await provisionNamedTenant('step-expanded');

		const first = await wake(10);
		const status = await controlLocalStepStatus(env);
		const second = await wake(10);

		expect({ first, status, second }).toStrictEqual({
			first: {
				current: currentLocalStep,
				woken: 1,
				failed: 0,
				outcomes: [
					{
						tenant: tenant('step-expanded'),
						kind: 'recorded',
						step: expansionLocalStep
					}
				]
			},
			status: {
				current: currentLocalStep,
				required: expansionLocalStep,
				ready: 1,
				pending: 0,
				stragglers: [],
				sweep: { state: 'idle' }
			},
			second: { current: currentLocalStep, woken: 0, failed: 0, outcomes: [] }
		});
	});

	it('counts against the step the caller asks about', async () => {
		await provisionNamedTenant('step-asked');
		await wake(10);

		await expect(
			controlLocalStepStatus(env, currentLocalStep)
		).resolves.toStrictEqual({
			current: currentLocalStep,
			required: currentLocalStep,
			ready: 0,
			pending: 1,
			stragglers: [tenant('step-asked')],
			sweep: { state: 'idle' }
		});
	});

	it('leaves an unconfigured tenant pending and counts the wake as failed', async () => {
		await provisionNamedTenant('step-unconfigured', { configure: false });

		await expect(wake(10)).resolves.toStrictEqual({
			current: currentLocalStep,
			woken: 0,
			failed: 1,
			outcomes: [{ tenant: tenant('step-unconfigured'), kind: 'unconfigured' }]
		});
		await expect(storedStep('step-unconfigured')).resolves.toBeNull();
	});

	it('advances past a failed tenant on the next bounded wake', async () => {
		await recordTransition('cache-identity', 'complete');
		await provisionNamedTenant('step-a-failed', { configure: false });
		await provisionNamedTenant('step-b-ready');
		const first = await wake(1);
		const second = await wake(1);
		expect({
			first,
			second,
			step: await storedStep('step-b-ready')
		}).toStrictEqual({
			first: {
				current: currentLocalStep,
				woken: 0,
				failed: 1,
				outcomes: [{ tenant: tenant('step-a-failed'), kind: 'unconfigured' }]
			},
			second: {
				current: currentLocalStep,
				woken: 1,
				failed: 0,
				outcomes: [
					{
						tenant: tenant('step-b-ready'),
						kind: 'recorded',
						step: currentLocalStep
					}
				]
			},
			step: currentLocalStep
		});
	});

	it('wakes a suspended tenant before it resumes', async () => {
		await recordTransition('cache-identity', 'complete');
		await provisionNamedTenant('step-suspended');
		await suspendTenant('step-suspended');

		const before = await controlLocalStepStatus(env);
		const result = await wake(10);

		expect({
			before,
			result,
			after: await controlLocalStepStatus(env)
		}).toStrictEqual({
			before: {
				current: currentLocalStep,
				required: currentLocalStep,
				ready: 0,
				pending: 1,
				stragglers: [tenant('step-suspended')],
				sweep: { state: 'idle' }
			},
			result: {
				current: currentLocalStep,
				woken: 1,
				failed: 0,
				outcomes: [
					{
						tenant: tenant('step-suspended'),
						kind: 'recorded',
						step: currentLocalStep
					}
				]
			},
			after: {
				current: currentLocalStep,
				required: currentLocalStep,
				ready: 1,
				pending: 0,
				stragglers: [],
				sweep: { state: 'idle' }
			}
		});
	});

	it('wakes no more tenants than the limit allows', async () => {
		await recordTransition('cache-identity', 'complete');
		await provisionNamedTenant('step-batch-a');
		await provisionNamedTenant('step-batch-b');

		await expect(wake(1)).resolves.toStrictEqual({
			current: currentLocalStep,
			woken: 1,
			failed: 0,
			outcomes: [
				{
					tenant: tenant('step-batch-a'),
					kind: 'recorded',
					step: currentLocalStep
				}
			]
		});
		await expect(controlLocalStepStatus(env)).resolves.toStrictEqual({
			current: currentLocalStep,
			required: currentLocalStep,
			ready: 1,
			pending: 1,
			stragglers: [tenant('step-batch-b')],
			sweep: { state: 'idle' }
		});
	});

	it('does not select a tenant that is already past the current step', async () => {
		await provisionNamedTenant('step-ahead');
		await setStoredStep('step-ahead', laterStep);

		await expect(wake(10)).resolves.toStrictEqual({
			current: currentLocalStep,
			woken: 0,
			failed: 0,
			outcomes: []
		});
		await expect(controlLocalStepStatus(env)).resolves.toStrictEqual({
			current: currentLocalStep,
			required: expansionLocalStep,
			ready: 1,
			pending: 0,
			stragglers: [],
			sweep: { state: 'idle' }
		});
	});

	// A newer build records a higher step. Rolling back to this one must not
	// lower it, or a later transition would wait for work that is already done.
	it('keeps a step a newer build recorded when the object reports', async () => {
		await recordTransition('cache-identity', 'complete');
		const id = tenant('step-rolled-back');
		await provisionNamedTenant(id);
		await setStoredStep(id, laterStep);

		await expect(
			tenantServer(env, id).reportLocalStep()
		).resolves.toStrictEqual({ kind: 'recorded', step: currentLocalStep });
		await expect(storedStep(id)).resolves.toStrictEqual(laterStep);
	});
});
