import { type Logger } from '@cupboard/logger';
import { type TenantId } from '@cupboard/nix-store/scalars';
import {
	currentLocalStep,
	type LocalStep,
	localStepSampleSize,
	localStepStallWindowMs,
	type LocalStepStatus,
	type LocalStepWakeResponse,
	requiredLocalStepFrom,
	tenantSchemaMigrationSchema
} from '@cupboard/protocol/deployment';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { chunk } from '@cupboard/shared/collections';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { and, asc, eq, inArray, isNull, or, type SQL, sql } from 'drizzle-orm';
import { drizzle as drizzleD1, type DrizzleD1Database } from 'drizzle-orm/d1';
import { z } from 'zod';

import * as d1Schema from '../db/d1-schema.ts';
import { readRecordedTransitions } from '../db/deployment-transitions.ts';
import { summariseLocalStepError } from '../db/local-step-attempts.ts';
import { batchNonEmpty } from '../do/bulk.ts';
import { jsonValueLists } from '../do/json-list.ts';
import { belowLocalSchema } from '../do/local-schema-run.ts';
import { belowLocalStep, type LocalStepOutcome } from '../do/local-step.ts';
import { TenantNotConfiguredError } from '../errors.ts';
import { queueSendBatchSize } from '../policy/queues.ts';
import { tenantServer } from '../routing/durable-object.ts';

type Database = DrizzleD1Database<typeof d1Schema>;

// Wake several objects at once without opening enough subrequests to exhaust
// the invocation's budget.
const wakeConcurrency = 4;

/**
 * The most tenants that one wake message lists.
 */
export const localStepWakeBatchSize = 20;

/**
 * A maintenance-queue message that wakes each listed tenant's object.
 */
export interface LocalStepWakeMessage {
	readonly kind: 'local-step';
	readonly tenants: readonly TenantId[];
}

/**
 * The pending tenants that a wake sends a message for: those that are stalled
 * or unwoken, in slug order.
 */
export interface LocalStepWakeSelection {
	readonly required: LocalStep;
	readonly pending: number;
	readonly tenants: readonly TenantId[];
}

/**
 * Calls one tenant object's `reportLocalStep`.
 */
export type ReportLocalStep = (
	tenant: TenantId,
	required: LocalStep
) => Promise<LocalStepOutcome>;

const { tenant } = d1Schema;

function pendingTenantWork(required: LocalStep): SQL {
	return sql`(${belowLocalStep(required)} OR ${belowLocalSchema()})`;
}

const resumableTenant = or(
	eq(tenant.status, 'active'),
	eq(tenant.status, 'suspended')
);

const statusCountsSchema = z.object({
	ready: z.number().int().nonnegative(),
	pending: z.number().int().nonnegative(),
	working: z.number().int().nonnegative(),
	stalled: z.number().int().nonnegative(),
	unwoken: z.number().int().nonnegative()
});

/**
 * The classes of a pending tenant, as `localStepStatusSchema` defines them,
 * for the stall window that starts at `since`. A tenant row matches exactly
 * one class. A row that has an attempt at the outstanding work is working or
 * stalled according to its last progress; a row without one is unwoken.
 */
function pendingClasses(since: IsoTimestamp): {
	readonly working: SQL;
	readonly stalled: SQL;
	readonly unwoken: SQL;
} {
	const attemptedAt = tenant.localStepAttemptedAt;
	const progressedAt = tenant.localStepProgressedAt;
	const error = tenant.localStepError;
	const unwoken = sql`(${attemptedAt} IS NULL OR (${attemptedAt} < ${since} AND ${error} IS NULL))`;

	return {
		working: sql`(NOT ${unwoken} AND (${progressedAt} >= ${since} OR (${progressedAt} IS NULL AND ${error} IS NULL)))`,
		stalled: sql`(NOT ${unwoken} AND (${progressedAt} < ${since} OR (${progressedAt} IS NULL AND ${error} IS NOT NULL)))`,
		unwoken
	};
}

function windowStart(now: Date): IsoTimestamp {
	return isoTimestamp(new Date(now.getTime() - localStepStallWindowMs));
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
 * Reports readiness for the required data step and this build's tenant schema.
 * It classifies pending tenants against the stall window before `now`, with
 * counts and samples for each class from one D1 batch.
 */
export async function controlLocalStepStatus(
	env: Env,
	now: Date = new Date()
): Promise<LocalStepStatus> {
	const database = controlDatabase(env);
	const required = await requiredLocalStep(env);
	const pending = pendingTenantWork(required);
	const classes = pendingClasses(windowStart(now));
	const counted = (condition: SQL): SQL<number> =>
		sql<number>`count(case when ${condition} then 1 end)`;
	const counts = database
		.select({
			ready: counted(sql`NOT ${pending}`),
			pending: counted(pending),
			working: counted(sql`${pending} AND ${classes.working}`),
			stalled: counted(sql`${pending} AND ${classes.stalled}`),
			unwoken: counted(sql`${pending} AND ${classes.unwoken}`)
		})
		.from(tenant)
		.where(resumableTenant);
	const stalledSample = database
		.select({
			tenant: tenant.id,
			attemptedAt: tenant.localStepAttemptedAt,
			progressedAt: tenant.localStepProgressedAt,
			error: tenant.localStepError
		})
		.from(tenant)
		.where(and(resumableTenant, pending, classes.stalled))
		.orderBy(asc(tenant.id))
		.limit(localStepSampleSize);
	const unwokenSample = database
		.select({ tenant: tenant.id, attemptedAt: tenant.localStepAttemptedAt })
		.from(tenant)
		.where(and(resumableTenant, pending, classes.unwoken))
		.orderBy(asc(tenant.id))
		.limit(localStepSampleSize);
	const workingSample = database
		.select({
			tenant: tenant.id,
			attemptedAt: tenant.localStepAttemptedAt,
			progressedAt: tenant.localStepProgressedAt,
			migration: tenant.localSchemaMigration
		})
		.from(tenant)
		.where(and(resumableTenant, pending, classes.working))
		.orderBy(asc(tenant.id))
		.limit(localStepSampleSize);
	const [countRows, stalledRows, unwokenRows, workingRows] =
		await database.batch([counts, stalledSample, unwokenSample, workingSample]);

	return {
		current: currentLocalStep,
		required,
		...statusCountsSchema.parse(countRows[0]),
		workingSample: workingRows.map((row) => ({
			tenant: row.tenant,
			...(row.attemptedAt !== null && { attemptedAt: row.attemptedAt }),
			...(row.progressedAt !== null && { progressedAt: row.progressedAt }),
			...(row.migration !== null && {
				migration: tenantSchemaMigrationSchema.parse(JSON.parse(row.migration))
			})
		})),
		stalledSample: stalledRows.map((row) => ({
			tenant: row.tenant,
			...(row.attemptedAt !== null && { attemptedAt: row.attemptedAt }),
			...(row.progressedAt !== null && { progressedAt: row.progressedAt }),
			...(row.error !== null && { error: row.error })
		})),
		unwokenSample: unwokenRows.map((row) => ({
			tenant: row.tenant,
			...(row.attemptedAt !== null && { attemptedAt: row.attemptedAt })
		}))
	};
}

/**
 * Selects the pending tenants to wake: every pending tenant that is not
 * working, measured against the stall window before `now`. One D1 statement
 * reads every pending tenant, so the selection also counts them.
 */
export async function selectLocalStepWakes(
	env: Env,
	now: Date = new Date()
): Promise<LocalStepWakeSelection> {
	const database = controlDatabase(env);
	const required = await requiredLocalStep(env);
	const { working } = pendingClasses(windowStart(now));
	const rows = await database
		.select({
			id: tenant.id,
			wake: sql<number>`case when ${working} then 0 else 1 end`
		})
		.from(tenant)
		.where(and(resumableTenant, pendingTenantWork(required)))
		.orderBy(asc(tenant.id))
		.all();

	return {
		required,
		pending: rows.length,
		tenants: rows.filter((row) => row.wake === 1).map((row) => row.id)
	};
}

/**
 * Enqueues a wake for every pending tenant that is not working, with up to
 * `localStepWakeBatchSize` tenants in each message. `localStep.wake` calls
 * this, and every cron tick enqueues the same selection.
 */
export async function enqueueLocalStepWakes(
	env: Env,
	queue: Pick<Queue<LocalStepWakeMessage>, 'sendBatch'> = env.MAINTENANCE_QUEUE
): Promise<LocalStepWakeResponse> {
	const selection = await selectLocalStepWakes(env);
	const messages = localStepWakeMessages(selection.tenants);

	for (const batch of chunk(messages, queueSendBatchSize)) {
		await queue.sendBatch(batch.map((body) => ({ body })));
	}

	return {
		required: selection.required,
		enqueued: selection.tenants.length,
		pending: selection.pending
	};
}

/**
 * The wake messages for `tenants`, each listing up to
 * `localStepWakeBatchSize` of them.
 */
export function localStepWakeMessages(
	tenants: readonly TenantId[]
): LocalStepWakeMessage[] {
	return chunk(tenants, localStepWakeBatchSize).map((batch) => ({
		kind: 'local-step',
		tenants: batch
	}));
}

/**
 * Wakes each listed tenant that is still below the required local step, with
 * `wakeConcurrency` wakes in flight. Each woken object runs a page of its
 * work, continues on its alarm, and writes its own attempts to its tenant row.
 * When a wake rejects, or finds an unconfigured object, this function writes
 * the failure itself, as soon as that wake ends. The write applies only while
 * the tenant is still pending and the row's attempt time is still the one
 * that this function read before the wake, so a failure does not replace an
 * attempt that the object wrote in the meantime.
 *
 * It throws only when D1 cannot be read or written, so the queue delivers
 * the message again.
 */
export async function wakeLocalStepTenants(
	logger: Logger,
	env: Env,
	tenants: readonly TenantId[],
	report: ReportLocalStep = (id, required) =>
		tenantServer(env, id).reportLocalStep(required)
): Promise<void> {
	const database = controlDatabase(env);
	const required = await requiredLocalStep(env);
	const selected = await batchNonEmpty(
		database,
		jsonValueLists(tenants).map((list) =>
			database
				.select({ id: tenant.id, attemptedAt: tenant.localStepAttemptedAt })
				.from(tenant)
				.where(
					and(
						inArray(tenant.id, list),
						resumableTenant,
						pendingTenantWork(required)
					)
				)
				.orderBy(asc(tenant.id))
		)
	);
	const pending = selected.flat();

	await mapWithConcurrency(pending, wakeConcurrency, async (row) => {
		const failure = await wakeTenant(logger, report, row.id, required);

		if (failure === undefined) {
			return;
		}

		await recordWakeFailure(database, row, required, failure);
	});
}

// Writes a failed wake's error to the tenant row, unless the tenant has
// reached `required` or the row's attempt time differs from the one read
// before the wake. An attempt that reached the row in between changes that
// time, whenever its page started.
async function recordWakeFailure(
	database: Database,
	row: { readonly id: TenantId; readonly attemptedAt: IsoTimestamp | null },
	required: LocalStep,
	error: string
): Promise<void> {
	const unchangedAttempt =
		row.attemptedAt === null
			? isNull(tenant.localStepAttemptedAt)
			: eq(tenant.localStepAttemptedAt, row.attemptedAt);

	await database
		.update(tenant)
		.set({
			localStepAttemptedAt: isoTimestamp(new Date()),
			localStepError: error
		})
		.where(
			and(eq(tenant.id, row.id), pendingTenantWork(required), unchangedAttempt)
		)
		.run();
}

// Returns the error of a wake that rejected or found an unconfigured object,
// or undefined when the object ran the wake.
async function wakeTenant(
	logger: Logger,
	report: ReportLocalStep,
	id: TenantId,
	required: LocalStep
): Promise<string | undefined> {
	try {
		const outcome = await report(id, required);

		if (outcome.kind !== 'unconfigured') {
			return undefined;
		}

		// The registry has a row whose Durable Object was never configured, so a
		// create failed part way through. Retrying the create repairs it.
		logger.warn('local step wake found an unconfigured tenant', { tenant: id });

		return summariseLocalStepError(new TenantNotConfiguredError());
	} catch (error) {
		logger.warn('local step wake failed', { tenant: id, error });

		return summariseLocalStepError(error);
	}
}

function controlDatabase(env: Env): Database {
	return drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
}
