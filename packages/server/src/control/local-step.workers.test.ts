import { rootLogger } from '@cupboard/logger';
import { type TenantId, tenantIdSchema } from '@cupboard/nix-store/scalars';
import {
	currentLocalStep,
	expansionLocalStep,
	type LocalStep,
	localStep,
	localStepSampleSize,
	localStepStallWindowMs
} from '@cupboard/protocol/deployment';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { describe, expect, it } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import { currentLocalSchemaVersion } from '../do/local-schema-run.ts';
import { recordLocalStep } from '../do/local-step.ts';
import { tenantServer } from '../routing/durable-object.ts';
import {
	asOneInvocation,
	offboardTenant,
	provisionNamedTenant,
	recordTransition,
	suspendTenant,
	testBase
} from '../test-support.ts';

import {
	controlLocalStepStatus,
	enqueueLocalStepWakes,
	type LocalStepWakeMessage,
	requiredLocalStep,
	wakeLocalStepTenants
} from './local-step.ts';

const logger = rootLogger();
const laterStep = localStep(currentLocalStep + 1);
const now = testBase.getTime();
const windowStart = now - localStepStallWindowMs;

class InjectedWakeFault extends Error {
	constructor() {
		super();
		this.name = 'InjectedWakeFault';
	}
}

interface LocalStepFacts {
	readonly localStep?: LocalStep;
	readonly schemaVersion?: number;
	readonly attemptedAt?: IsoTimestamp;
	readonly progressedAt?: IsoTimestamp;
	readonly error?: string;
}

function database(): ReturnType<typeof drizzleD1<typeof d1Schema>> {
	return drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
}

function tenant(name: string): TenantId {
	return tenantIdSchema.parse(name);
}

function at(ms: number): IsoTimestamp {
	return isoTimestamp(new Date(ms));
}

function writeFacts(name: string, facts: LocalStepFacts): Promise<unknown> {
	return database()
		.update(d1Schema.tenant)
		.set({
			localStep: facts.localStep,
			localSchemaVersion: facts.schemaVersion ?? currentLocalSchemaVersion,
			localStepAttemptedAt: facts.attemptedAt,
			localStepProgressedAt: facts.progressedAt,
			localStepError: facts.error
		})
		.where(eq(d1Schema.tenant.id, tenant(name)))
		.run();
}

// The tenant row's local-step columns. An empty column reads as undefined.
async function factsOf(name: string): Promise<LocalStepFacts> {
	const row = await database()
		.select({
			localStep: d1Schema.tenant.localStep,
			attemptedAt: d1Schema.tenant.localStepAttemptedAt,
			progressedAt: d1Schema.tenant.localStepProgressedAt,
			error: d1Schema.tenant.localStepError
		})
		.from(d1Schema.tenant)
		.where(eq(d1Schema.tenant.id, tenant(name)))
		.get();

	if (row === undefined) {
		throw new Error(`No tenant row for ${name}`);
	}

	return {
		...(row.localStep !== null && { localStep: row.localStep }),
		...(row.attemptedAt !== null && { attemptedAt: row.attemptedAt }),
		...(row.progressedAt !== null && { progressedAt: row.progressedAt }),
		...(row.error !== null && { error: row.error })
	};
}

// Provisions a tenant row with the given local-step columns. The tenant's
// object is never configured.
async function pendingTenant(
	name: string,
	facts?: LocalStepFacts
): Promise<void> {
	await provisionNamedTenant(name, { configure: false });

	if (facts !== undefined) {
		await writeFacts(name, facts);
	}
}

function queueCollector(
	sent: LocalStepWakeMessage[][]
): Pick<Queue<LocalStepWakeMessage>, 'sendBatch'> {
	return {
		sendBatch: (batch) => {
			sent.push(Array.from(batch, (entry) => entry.body));

			return Promise.resolve({
				metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } }
			});
		}
	};
}

describe('required local step', () => {
	it.each([
		{ name: 'no transition recorded', rows: [], step: expansionLocalStep },
		{
			name: 'cache-identity expanded',
			rows: [['cache-identity', 'expanded']],
			step: expansionLocalStep
		},
		{
			name: 'cache-identity complete',
			rows: [['cache-identity', 'complete']],
			step: currentLocalStep
		},
		{
			name: 'only a transition that this build does not define',
			rows: [['later-transition', 'complete']],
			step: expansionLocalStep
		},
		{
			name: 'cache-identity in a state that this build does not define',
			rows: [['cache-identity', 'later-state']],
			step: currentLocalStep
		}
	])('is $step with $name', async ({ rows, step }) => {
		for (const [id, state] of rows) {
			await env.CUPBOARD_DB.prepare(
				'INSERT INTO deployment_transition (id, state, updated_at) VALUES (?, ?, ?)'
			)
				.bind(id, state, '2026-01-01T00:00:00.000Z')
				.run();
		}

		await expect(requiredLocalStep(env)).resolves.toBe(step);
	});
});

describe('local step status', () => {
	it('reports and wakes a tenant that recorded step 5 before the new schema migrations', async () => {
		await recordTransition('cache-identity', 'complete');
		await pendingTenant('previous-final-step', {
			localStep: localStep(5),
			schemaVersion: 65
		});
		const sent: LocalStepWakeMessage[][] = [];
		const status = await controlLocalStepStatus(env);
		const response = await enqueueLocalStepWakes(env, queueCollector(sent));
		expect({ status, response, sent }).toStrictEqual({
			status: {
				current: currentLocalStep,
				required: currentLocalStep,
				ready: 0,
				pending: 1,
				working: 0,
				stalled: 0,
				unwoken: 1,
				stalledSample: [],
				workingSample: [],
				unwokenSample: [{ tenant: tenant('previous-final-step') }]
			},
			response: { required: currentLocalStep, enqueued: 1, pending: 1 },
			sent: [[{ kind: 'local-step', tenants: [tenant('previous-final-step')] }]]
		});
	});

	// A tenant with an attempt at the outstanding work is working while its
	// last progress is inside the window, even after a failed page, and while
	// it has not failed before its first progress. Without such an attempt it
	// is unwoken, and a failure or progress outside the window makes it stalled.
	it('classifies each pending tenant against the stall window', async () => {
		const error = 'InjectedPageFault';
		const recent = at(now - 60_000);
		const outside = at(windowStart - 1);

		await pendingTenant('ready', { localStep: expansionLocalStep });
		await pendingTenant('unwoken-never');
		await pendingTenant('unwoken-old', {
			attemptedAt: outside,
			progressedAt: outside
		});
		await pendingTenant('unwoken-after-recording', { progressedAt: recent });
		await pendingTenant('suspended');
		await suspendTenant('suspended');
		await provisionNamedTenant('offboarding');
		await offboardTenant('offboarding');
		await pendingTenant('working', {
			attemptedAt: at(windowStart),
			progressedAt: at(windowStart)
		});
		await pendingTenant('working-after-failure', {
			attemptedAt: recent,
			progressedAt: recent,
			error
		});
		await pendingTenant('working-before-progress', { attemptedAt: recent });
		await pendingTenant('stalled-old-error', {
			attemptedAt: outside,
			error
		});
		await pendingTenant('stalled-no-progress', {
			attemptedAt: recent,
			progressedAt: outside
		});
		await pendingTenant('stalled-never-progressed', {
			attemptedAt: recent,
			error
		});

		await expect(controlLocalStepStatus(env)).resolves.toStrictEqual({
			current: currentLocalStep,
			required: expansionLocalStep,
			ready: 1,
			pending: 10,
			working: 3,
			workingSample: [
				{
					tenant: tenant('working'),
					attemptedAt: at(windowStart),
					progressedAt: at(windowStart)
				},
				{
					tenant: tenant('working-after-failure'),
					attemptedAt: recent,
					progressedAt: recent
				},
				{ tenant: tenant('working-before-progress'), attemptedAt: recent }
			],
			stalled: 3,
			unwoken: 4,
			stalledSample: [
				{
					tenant: tenant('stalled-never-progressed'),
					attemptedAt: recent,
					error
				},
				{
					tenant: tenant('stalled-no-progress'),
					attemptedAt: recent,
					progressedAt: outside
				},
				{ tenant: tenant('stalled-old-error'), attemptedAt: outside, error }
			],
			unwokenSample: [
				{ tenant: tenant('suspended') },
				{ tenant: tenant('unwoken-after-recording') },
				{ tenant: tenant('unwoken-never') },
				{ tenant: tenant('unwoken-old'), attemptedAt: outside }
			]
		});
	});
});

describe('local step wake', () => {
	it('enqueues one message for every twenty tenants that are not working', async () => {
		const names = Array.from(
			{ length: localStepSampleSize + 2 },
			(_, index) => `wake-${String(index).padStart(2, '0')}`
		);

		for (const name of names) {
			await pendingTenant(name);
		}
		await pendingTenant('wake-working', {
			attemptedAt: at(now),
			progressedAt: at(now)
		});
		await pendingTenant('wake-ready', { localStep: expansionLocalStep });

		const sent: LocalStepWakeMessage[][] = [];
		const response = await enqueueLocalStepWakes(env, queueCollector(sent));
		const tenants = names.map((name) => tenant(name));

		expect({ response, sent }).toStrictEqual({
			response: {
				required: expansionLocalStep,
				enqueued: names.length,
				pending: names.length + 1
			},
			sent: [
				[
					{ kind: 'local-step', tenants: tenants.slice(0, 20) },
					{ kind: 'local-step', tenants: tenants.slice(20) }
				]
			]
		});
	});
});

describe('local step wake message', () => {
	it('records a failed wake when only the tenant schema is pending', async () => {
		await pendingTenant('schema-rejects', {
			localStep: expansionLocalStep,
			schemaVersion: currentLocalSchemaVersion - 1
		});

		await wakeLocalStepTenants(logger, env, [tenant('schema-rejects')], () =>
			Promise.reject(new InjectedWakeFault())
		);

		await expect(factsOf('schema-rejects')).resolves.toStrictEqual({
			localStep: expansionLocalStep,
			attemptedAt: at(now),
			error: 'InjectedWakeFault'
		});
	});

	it('lets a woken object record its step and its attempt', async () => {
		await recordTransition('cache-identity', 'complete');
		await provisionNamedTenant('woken');

		await wakeLocalStepTenants(logger, env, [tenant('woken')]);

		await expect(factsOf('woken')).resolves.toStrictEqual({
			localStep: currentLocalStep,
			progressedAt: at(now)
		});
	});

	// Recording a step clears the attempt time, so a tenant that recorded step 4
	// a moment ago is not counted as working once step 5 is required.
	it('wakes a tenant again once the required step rises above the step that it recorded', async () => {
		await provisionNamedTenant('raised');
		await wakeLocalStepTenants(logger, env, [tenant('raised')]);
		await recordTransition('cache-identity', 'complete');

		const sent: LocalStepWakeMessage[][] = [];
		const response = await enqueueLocalStepWakes(env, queueCollector(sent));

		expect({ response, sent }).toStrictEqual({
			response: { required: currentLocalStep, enqueued: 1, pending: 1 },
			sent: [[{ kind: 'local-step', tenants: [tenant('raised')] }]]
		});
	});

	it('records the error of a wake that rejects and skips tenants that are no longer pending', async () => {
		await pendingTenant('rejects', {
			attemptedAt: at(windowStart),
			progressedAt: at(windowStart)
		});
		await pendingTenant('already-ready', { localStep: expansionLocalStep });
		await provisionNamedTenant('offboarded');
		await offboardTenant('offboarded');
		const called: TenantId[] = [];

		await wakeLocalStepTenants(
			logger,
			env,
			[tenant('already-ready'), tenant('offboarded'), tenant('rejects')],
			(id) => {
				called.push(id);

				return Promise.reject(new InjectedWakeFault());
			}
		);

		expect({
			called,
			rejects: await factsOf('rejects'),
			alreadyReady: await factsOf('already-ready')
		}).toStrictEqual({
			called: [tenant('rejects')],
			rejects: {
				attemptedAt: at(now),
				progressedAt: at(windowStart),
				error: 'InjectedWakeFault'
			},
			alreadyReady: { localStep: expansionLocalStep }
		});
	});

	// The consumer can hear of a failed wake after the object has continued and
	// written a newer attempt, for example when the call rejects after the page
	// has run.
	it('leaves an attempt that the object wrote after the failed wake started', async () => {
		const later = at(now + 1000);
		await pendingTenant('continued', {
			attemptedAt: at(windowStart),
			progressedAt: at(windowStart)
		});

		await wakeLocalStepTenants(
			logger,
			env,
			[tenant('continued')],
			async (id) => {
				await writeFacts(id, { attemptedAt: later, progressedAt: later });

				throw new InjectedWakeFault();
			}
		);

		await expect(factsOf('continued')).resolves.toStrictEqual({
			attemptedAt: later,
			progressedAt: later
		});
	});

	// A page that started before the wake commits its attempt while the wake is
	// in flight, so the attempt time is older than the wake's start although
	// the write is newer.
	it('leaves an attempt that a page started before the failed wake wrote during it', async () => {
		const pageStartedAt = at(now - 1000);
		await pendingTenant('overlapped', {
			attemptedAt: at(windowStart),
			progressedAt: at(windowStart)
		});

		await wakeLocalStepTenants(
			logger,
			env,
			[tenant('overlapped')],
			async (id) => {
				await writeFacts(id, {
					attemptedAt: pageStartedAt,
					progressedAt: pageStartedAt
				});

				throw new InjectedWakeFault();
			}
		);

		await expect(factsOf('overlapped')).resolves.toStrictEqual({
			attemptedAt: pageStartedAt,
			progressedAt: pageStartedAt
		});
	});

	it('records an error for a tenant whose object is not configured', async () => {
		await pendingTenant('unconfigured');

		await wakeLocalStepTenants(logger, env, [tenant('unconfigured')]);
		const facts = await factsOf('unconfigured');

		// The error summary starts with the error's name.
		expect({
			...facts,
			error: facts.error?.split(':', 1)[0]
		}).toStrictEqual({
			attemptedAt: at(now),
			error: 'TenantNotConfiguredError'
		});
	});

	// A newer build records a higher step. Rolling back to this one must not
	// lower it, or the deploy would wake tenants again for work that is already
	// done.
	it('keeps a step that a newer build recorded when the object reports', async () => {
		await recordTransition('cache-identity', 'complete');
		const id = tenant('step-rolled-back');
		await provisionNamedTenant(id);
		await writeFacts(id, { localStep: laterStep });

		// A wake finds the step recorded and runs no page. A page that runs anyway,
		// as a pass does for a request made before the newer build recorded its
		// step, leaves the stored step where it is.
		const wake = await tenantServer(env, id).reportLocalStep(currentLocalStep);
		const page = await runInDurableObject(tenantServer(env, id), (instance) =>
			asOneInvocation(() =>
				recordLocalStep(
					instance.context,
					[],
					isoTimestamp(new Date()),
					currentLocalStep
				)
			)
		);

		expect({ wake, page, facts: await factsOf(id) }).toStrictEqual({
			wake: { kind: 'recorded', step: laterStep, progressed: false },
			page: { kind: 'recorded', step: currentLocalStep, progressed: false },
			facts: { localStep: laterStep, progressedAt: at(now) }
		});
	});
});
