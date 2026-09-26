import { type Logger } from '@cupboard/logger';
import { type TenantId } from '@cupboard/nix-store/scalars';
import {
	currentLocalStep,
	type LocalStep,
	type LocalStepStatus,
	localStepStragglerSampleSize,
	type LocalStepWakeOutcome,
	type LocalStepWakeResponse,
	requiredLocalStepFrom
} from '@cupboard/protocol/deployment';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { and, asc, count, eq, gt, gte, lte, or, type SQL } from 'drizzle-orm';
import { drizzle as drizzleD1, type DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from '../db/d1-schema.ts';
import { readRecordedTransitions } from '../db/deployment-transitions.ts';
import { belowLocalStep } from '../do/local-step.ts';
import { tenantServer } from '../routing/durable-object.ts';

type Database = DrizzleD1Database<typeof d1Schema>;

// Wake several objects at once without opening enough subrequests to exhaust
// the invocation's budget.
const wakeConcurrency = 4;

const resumableTenant = or(
	eq(d1Schema.tenant.status, 'active'),
	eq(d1Schema.tenant.status, 'suspended')
);

// The tenants that a wake selects: those that can still be woken and have not
// reached the required local step.
function stragglerFilter(requiredStep: LocalStep): SQL | undefined {
	return and(resumableTenant, belowLocalStep(requiredStep));
}

/**
 * Returns the required local step for the recorded transitions, as
 * `requiredLocalStepFrom` defines it.
 */
export async function requiredLocalStep(env: Env): Promise<LocalStep> {
	return requiredLocalStepFrom(
		await readRecordedTransitions(controlDatabase(env))
	);
}

/**
 * Reports how many active or suspended tenants have reached the required step,
 * and lists some of those that have not. The step is the one in the caller's
 * query, or else the required local step.
 */
export async function controlLocalStepStatus(
	env: Env,
	requiredStep?: LocalStep
): Promise<LocalStepStatus> {
	const database = controlDatabase(env);
	const required = requiredStep ?? (await requiredLocalStep(env));
	const ready = await countTenants(
		database,
		and(resumableTenant, gte(d1Schema.tenant.localStep, required))
	);
	const pendingFilter = stragglerFilter(required);
	const pending = await countTenants(database, pendingFilter);
	const stragglers = await selectStragglers(
		database,
		localStepStragglerSampleSize,
		pendingFilter
	);

	return {
		current: currentLocalStep,
		required,
		ready,
		pending,
		stragglers: stragglers.map(({ id }) => id)
	};
}

/**
 * Wakes up to `limit` tenants that have not reached the required step, so each
 * applies its pending migrations and records how far it has come.
 *
 * A tenant that records no step is counted as failed. It stays in the
 * straggler list, so the next call retries it.
 */
export async function controlLocalStepWake(
	logger: Logger,
	env: Env,
	limit: number
): Promise<LocalStepWakeResponse> {
	const database = controlDatabase(env);
	const required = await requiredLocalStep(env);
	const straggler = stragglerFilter(required);
	const previous = await database
		.select()
		.from(d1Schema.localStepWakeCursor)
		.where(eq(d1Schema.localStepWakeCursor.id, 1))
		.get();
	const after = previous?.afterTenant;
	const first = await selectStragglers(
		database,
		limit,
		straggler,
		after === undefined ? undefined : gt(d1Schema.tenant.id, after)
	);
	const wrapped =
		after === undefined || first.length === limit
			? []
			: await selectStragglers(
					database,
					limit - first.length,
					straggler,
					lte(d1Schema.tenant.id, after)
				);
	const stragglers = [...first, ...wrapped];
	const last = stragglers.at(-1);
	if (last !== undefined) {
		if (after === undefined) {
			await database
				.insert(d1Schema.localStepWakeCursor)
				.values({ id: 1, afterTenant: last.id })
				.onConflictDoNothing()
				.run();
		} else {
			await database
				.update(d1Schema.localStepWakeCursor)
				.set({ afterTenant: last.id })
				.where(
					and(
						eq(d1Schema.localStepWakeCursor.id, 1),
						eq(d1Schema.localStepWakeCursor.afterTenant, after)
					)
				)
				.run();
		}
	}
	const outcomes = await mapWithConcurrency(
		stragglers,
		wakeConcurrency,
		async ({ id }) => wakeTenant(logger, env, id)
	);
	const woken = outcomes.filter(
		(outcome) => outcome.kind === 'recorded' || outcome.kind === 'advanced'
	).length;

	return {
		current: currentLocalStep,
		required,
		woken,
		failed: outcomes.length - woken,
		outcomes
	};
}

async function wakeTenant(
	logger: Logger,
	env: Env,
	tenant: TenantId
): Promise<LocalStepWakeOutcome> {
	try {
		const outcome = await tenantServer(env, tenant).reportLocalStep();

		if (outcome.kind === 'unconfigured') {
			// The registry holds a row whose Durable Object was never configured, so
			// a create failed part way through. Retrying the create repairs it.
			logger.warn('local step wake found an unconfigured tenant', { tenant });

			return { tenant, kind: 'unconfigured' };
		}

		if (outcome.kind === 'incomplete') {
			// The object made progress but has more work than one invocation
			// allows, so it left its step unrecorded. It stays a straggler and a
			// later pass wakes it again.
			logger.info('local step wake made partial progress', {
				tenant,
				projected: outcome.projected
			});
			return { tenant, kind: 'advanced', projected: outcome.projected };
		}

		return { tenant, kind: 'recorded', step: outcome.step };
	} catch (error) {
		logger.warn('local step wake failed', { tenant, error });

		return { tenant, kind: 'failed' };
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
	limit: number,
	filter: SQL | undefined,
	position?: SQL
): Promise<{ id: TenantId }[]> {
	// A stable order lets the persisted cursor resume after the last attempted tenant.
	return database
		.select({ id: d1Schema.tenant.id })
		.from(d1Schema.tenant)
		.where(and(filter, position))
		.orderBy(asc(d1Schema.tenant.id))
		.limit(limit)
		.all();
}

function controlDatabase(env: Env): Database {
	return drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
}
