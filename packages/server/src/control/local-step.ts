import { type Logger } from '@cupboard/logger';
import { type TenantId } from '@cupboard/nix-store/scalars';
import {
	type LocalStepStatus,
	localStepStragglerSampleSize,
	type LocalStepWakeResponse
} from '@cupboard/protocol/deployment';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { and, asc, count, eq, gte, type SQL } from 'drizzle-orm';
import { drizzle as drizzleD1, type DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from '../db/d1-schema.ts';
import { belowCurrentLocalStep, currentLocalStep } from '../do/local-step.ts';
import { tenantServer } from '../routing/durable-object.ts';

type Database = DrizzleD1Database<typeof d1Schema>;

// Wake several objects at once without opening enough subrequests to exhaust
// the invocation's budget.
const wakeConcurrency = 4;

// Only active tenants count towards a step. A suspended or offboarding tenant's
// object is not woken, and its local state is not what a phase waits for.
const activeTenant = eq(d1Schema.tenant.status, 'active');

// An active tenant whose object has not reported the step this build asks for.
const straggler = and(activeTenant, belowCurrentLocalStep);

/**
 * Reports how many active tenants have reached the step this build asks for,
 * and names some of those that have not.
 */
export async function controlLocalStepStatus(
	env: Env
): Promise<LocalStepStatus> {
	const database = controlDatabase(env);
	const ready = await countTenants(
		database,
		and(activeTenant, gte(d1Schema.tenant.localStep, currentLocalStep))
	);
	const pending = await countTenants(database, straggler);
	const stragglers = await selectStragglers(
		database,
		localStepStragglerSampleSize
	);

	return {
		current: currentLocalStep,
		ready,
		pending,
		stragglers: stragglers.map(({ id }) => id)
	};
}

/**
 * Wakes up to `limit` tenants that have not reached the current step, so each
 * applies its pending migrations and records how far it has come.
 *
 * A tenant that records no step is counted as failed and left for the next
 * call. Nothing is lost by that: the tenant stays in the straggler list, and
 * its object records the step whenever it next runs.
 */
export async function controlLocalStepWake(
	logger: Logger,
	env: Env,
	limit: number
): Promise<LocalStepWakeResponse> {
	const stragglers = await selectStragglers(controlDatabase(env), limit);
	const outcomes = await mapWithConcurrency(
		stragglers,
		wakeConcurrency,
		async ({ id }) => wakeTenant(logger, env, id)
	);
	const woken = outcomes.filter((outcome) => outcome === 'woken').length;

	return {
		current: currentLocalStep,
		woken,
		failed: outcomes.length - woken
	};
}

type WakeOutcome = 'woken' | 'failed';

async function wakeTenant(
	logger: Logger,
	env: Env,
	tenant: TenantId
): Promise<WakeOutcome> {
	try {
		const step = await tenantServer(env, tenant).reportLocalStep();

		if (step === undefined) {
			// The registry holds a row whose Durable Object was never configured, so
			// a create failed part way through. Retrying the create repairs it.
			logger.warn('local step wake found an unconfigured tenant', { tenant });

			return 'failed';
		}

		return 'woken';
	} catch (error) {
		logger.warn('local step wake failed', { tenant, error });

		return 'failed';
	}
}

async function countTenants(
	database: Database,
	where: SQL | undefined
): Promise<number> {
	const [row] = await database
		.select({ tenants: count() })
		.from(d1Schema.tenant)
		.where(where);

	return row?.tenants ?? 0;
}

function selectStragglers(
	database: Database,
	limit: number
): Promise<{ id: TenantId }[]> {
	// Order by slug so repeated calls walk the same tenants in the same order and
	// a stuck one is named the same way each time.
	return database
		.select({ id: d1Schema.tenant.id })
		.from(d1Schema.tenant)
		.where(straggler)
		.orderBy(asc(d1Schema.tenant.id))
		.limit(limit)
		.all();
}

function controlDatabase(env: Env): Database {
	return drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
}
