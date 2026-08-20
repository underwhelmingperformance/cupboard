import { CodedError, UsageError } from '@cupboard/shared/errors';
import { z } from 'zod';

import {
	type BudgetedMetric,
	budgetedMetrics,
	combinedGroupKey,
	type RealisationMeasurement,
	realisationMeasurementSchema,
	type RealisationReport
} from './measurement.ts';

/**
Invalid gate input: an unreadable baseline or tolerance.
*/
export abstract class BudgetError extends UsageError {}

export class BaselineJsonError extends BudgetError {
	constructor(override readonly cause: SyntaxError) {
		super(`The baseline is not JSON: ${cause.message}`);
		this.name = 'BaselineJsonError';
	}
}

export class BaselineSchemaError extends BudgetError {
	constructor(override readonly cause: z.ZodError) {
		super(
			'The baseline does not contain the measurements required by the gate'
		);
		this.name = 'BaselineSchemaError';
	}
}

export class InvalidToleranceError extends BudgetError {
	constructor(readonly value: string) {
		super(`Tolerance must be a fraction of at least 0: ${value}`);
		this.name = 'InvalidToleranceError';
	}
}

const budgetEntrySchema = z.object({
	measurement: realisationMeasurementSchema
});

/**
 * Expected measurements for a gate, read from a previous report. Parsing
 * ignores all fields except target and group keys and their measurements, so
 * newer report fields do not invalidate existing baselines. A hand-written
 * baseline needs only those values.
 */
const keySchema = z.string().min(1);
const targetBudgetSchema = budgetEntrySchema.extend({ attr: keySchema });
const groupBudgetSchema = budgetEntrySchema.extend({ key: keySchema });

export const realisationBaselineSchema = z.object({
	targets: z.array(targetBudgetSchema),
	groups: z.array(groupBudgetSchema),
	combined: budgetEntrySchema.optional()
});
export type RealisationBaseline = z.output<typeof realisationBaselineSchema>;

export function parseBaseline(source: string): RealisationBaseline {
	let value: unknown;

	try {
		value = JSON.parse(source);
	} catch (error) {
		throw new BaselineJsonError(
			error instanceof SyntaxError ? error : new SyntaxError(String(error))
		);
	}

	const parsed = realisationBaselineSchema.safeParse(value);

	if (!parsed.success) {
		throw new BaselineSchemaError(parsed.error);
	}

	return parsed.data;
}

/**
The share by which a measurement may exceed its budget and still pass.
*/
export const defaultTolerance = 0.05;

export function parseTolerance(value: string): number {
	const trimmed = value.trim();
	const tolerance = Number(trimmed);

	if (trimmed === '' || !Number.isFinite(tolerance) || tolerance < 0) {
		throw new InvalidToleranceError(value);
	}

	return tolerance;
}

/**
Which part of a report a budget entry belongs to.
*/
export type BudgetScope = 'target' | 'group' | 'combined';

export interface BudgetBreach {
	readonly scope: BudgetScope;
	readonly key: string;
	readonly metric: BudgetedMetric;
	readonly expected: number;
	readonly allowed: number;
	readonly measured: number;
	readonly excess: number;
}

/**
A measurement the baseline sets no budget for, such as a new target.
*/
export interface UnbudgetedMeasurement {
	readonly scope: BudgetScope;
	readonly key: string;
}

export interface BudgetResult {
	readonly tolerance: number;
	readonly breaches: readonly BudgetBreach[];
	readonly unbudgeted: readonly UnbudgetedMeasurement[];
}

export interface BudgetOptions {
	readonly report: RealisationReport;
	readonly baseline: RealisationBaseline;
	readonly tolerance?: number;
}

/**
 * Compares report measurements with baseline budgets plus the tolerance. Each
 * breach records the metric, budget, measured value, and excess. Measurements
 * absent from the baseline are reported as unbudgeted but do not fail the gate,
 * which lets a new target establish a baseline on its first run.
 */
export function checkBudgets(options: BudgetOptions): BudgetResult {
	const tolerance = options.tolerance ?? defaultTolerance;
	const targetBudgets = new Map(
		options.baseline.targets.map((entry) => [entry.attr, entry.measurement])
	);
	const groupBudgets = new Map(
		options.baseline.groups.map((entry) => [entry.key, entry.measurement])
	);
	const breaches: BudgetBreach[] = [];
	const unbudgeted: UnbudgetedMeasurement[] = [];

	for (const target of options.report.targets) {
		collect(
			'target',
			target.attr,
			targetBudgets.get(target.attr),
			target.measurement,
			tolerance,
			breaches,
			unbudgeted
		);
	}

	for (const group of options.report.groups) {
		collect(
			'group',
			group.key,
			groupBudgets.get(group.key),
			group.measurement,
			tolerance,
			breaches,
			unbudgeted
		);
	}

	if (options.report.combined !== undefined) {
		collect(
			'combined',
			combinedGroupKey,
			options.baseline.combined?.measurement,
			options.report.combined.measurement,
			tolerance,
			breaches,
			unbudgeted
		);
	}

	return { tolerance, breaches, unbudgeted };
}

function collect(
	scope: BudgetScope,
	key: string,
	budget: RealisationMeasurement | undefined,
	measurement: RealisationMeasurement,
	tolerance: number,
	breaches: BudgetBreach[],
	unbudgeted: UnbudgetedMeasurement[]
): void {
	if (budget === undefined) {
		unbudgeted.push({ scope, key });

		return;
	}

	for (const metric of budgetedMetrics) {
		const expected = budget[metric];
		const measured = measurement[metric];
		const allowed = allowanceFor(expected, tolerance);

		if (measured <= allowed) {
			continue;
		}

		breaches.push({
			scope,
			key,
			metric,
			expected,
			allowed,
			measured,
			excess: measured - allowed
		});
	}
}

// Counts and byte totals are integers. Round the tolerated limit down so a
// fractional allowance cannot admit the next integer.
function allowanceFor(expected: number, tolerance: number): number {
	return Math.floor(expected * (1 + tolerance));
}

// A budget breach exits with EX_DATAERR (65) so callers can distinguish
// measured drift from an internal fixture failure.
export const budgetExitCode = 65;

/**
Raised when a gate run measured more than a baseline allows.
*/
export class BudgetBreachError extends CodedError {
	constructor(readonly breaches: readonly BudgetBreach[]) {
		super(
			`${String(breaches.length)} measurement(s) exceeded their budget: ` +
				breaches
					.map((breach) => `${breach.scope} ${breach.key} ${breach.metric}`)
					.join(', ')
		);
		this.name = 'BudgetBreachError';
	}

	override get exitCode(): number {
		return budgetExitCode;
	}
}
