import type { StorePathString } from '@cupboard/nix-store/scalars';
import {
	plannerPartitionSchema,
	substitutableSizesSchema
} from '@cupboard/protocol/build';
import { z } from 'zod';

import type { PublishTarget } from '../../actions/src/publish-plan.ts';
import type {
	NixDerivedPathString,
	NixMissingPartition
} from '../../packages/nix/src/index.ts';

import { declaredGroups, type TargetGroup } from './manifest.ts';

/**
 * The estimated cost of realising installables from an empty store: partition
 * counts plus the download and uncompressed NAR byte totals for substitutable
 * paths. Build receipts record the counts and sizes separately.
 */
export const realisationMeasurementSchema = plannerPartitionSchema
	.pick({ willBuild: true, willSubstitute: true, unknown: true })
	.extend(substitutableSizesSchema.shape);
export type RealisationMeasurement = z.output<
	typeof realisationMeasurementSchema
>;

/**
 * The metrics a budget covers. `unknown` counts paths for which no substituter
 * returned an offer. This depends on network state rather than the flake, so
 * `budgetedMetrics` excludes it.
 */
export const budgetedMetrics = [
	'willBuild',
	'willSubstitute',
	'downloadSize',
	'narSize'
] as const;
export type BudgetedMetric = (typeof budgetedMetrics)[number];

const comparedMetrics = [...budgetedMetrics, 'unknown'] as const;
type ComparedMetric = (typeof comparedMetrics)[number];

/**
The difference between two measurements, metric by metric.
*/
export type MeasurementDelta = Readonly<Record<ComparedMetric, number>>;

export interface ResolvedDerivation {
	readonly drvPath: StorePathString;
	readonly evaluationTimeMs: number;
}

export interface RealisationPlanner {
	resolve(target: PublishTarget): Promise<ResolvedDerivation>;
	/**
	 * Adds the derivations to the store so it can plan against them. A store
	 * without the derivations cannot plan the installables.
	 */
	seed(drvPaths: readonly StorePathString[]): Promise<void>;
	plan(
		installables: readonly NixDerivedPathString[]
	): Promise<NixMissingPartition>;
}

export type Clock = () => number;

export interface TargetTimings {
	readonly evaluationTimeMs: number;
	readonly planTimeMs: number;
}

export interface TargetMeasurement {
	readonly attr: string;
	readonly installable: string;
	readonly measurement: RealisationMeasurement;
	readonly timings: TargetTimings;
}

/**
 * Compares the cost of measuring group members together with the sum of
 * measuring each member separately. Shared closure paths count once in the
 * group measurement but once per member in the separate measurements.
 */
export interface GroupComparison {
	readonly apart: MeasurementDelta;
	readonly together: MeasurementDelta;
	readonly saved: MeasurementDelta;
}

export interface GroupMeasurement {
	readonly key: string;
	readonly attrs: readonly string[];
	readonly measurement: RealisationMeasurement;
	readonly timings: { readonly planTimeMs: number };
	readonly comparison: GroupComparison;
}

/**
 * Measurements from one run. `combined` is present when the manifest contains
 * more than one target. `groups` contains the declared cohorts with more than
 * one member.
 */
export interface RealisationReport {
	readonly flake: string;
	readonly substituters: readonly string[];
	readonly targets: readonly TargetMeasurement[];
	readonly groups: readonly GroupMeasurement[];
	readonly combined?: GroupMeasurement;
}

export interface MeasureOptions {
	readonly flake: string;
	readonly substituters: readonly string[];
	readonly targets: readonly PublishTarget[];
	readonly planner: RealisationPlanner;
	readonly now?: Clock;
}

const defaultClock: Clock = () => performance.now();

export const combinedGroupKey = 'all-targets';

/**
 * Measures each target separately and each multi-target group together against
 * the selected store. Every target is resolved before any derivation is seeded,
 * and all derivations are seeded before planning begins. Plans run sequentially
 * so the report retains each target's planning time.
 */
export async function measureRealisation(
	options: MeasureOptions
): Promise<RealisationReport> {
	const now = options.now ?? defaultClock;
	const resolutions = new Map<string, ResolvedDerivation>();

	for (const target of options.targets) {
		resolutions.set(target.attr, await options.planner.resolve(target));
	}

	await options.planner.seed(
		resolutions
			.values()
			.map((resolution) => resolution.drvPath)
			.toArray()
	);

	const installables = new Map<string, NixDerivedPathString>(
		options.targets.map((target) => [
			target.attr,
			installableFor(target, requireResolution(resolutions, target.attr))
		])
	);
	const targets: TargetMeasurement[] = [];

	for (const target of options.targets) {
		const installable = requireInstallable(installables, target.attr);
		const planned = await timedPlan(options.planner, [installable], now);

		targets.push({
			attr: target.attr,
			installable,
			measurement: planned.measurement,
			timings: {
				evaluationTimeMs: requireResolution(resolutions, target.attr)
					.evaluationTimeMs,
				planTimeMs: planned.planTimeMs
			}
		});
	}

	const byAttribute = new Map(
		targets.map((measured) => [measured.attr, measured.measurement])
	);
	const groups: GroupMeasurement[] = [];

	for (const group of declaredGroups(options.targets)) {
		groups.push(
			await measureGroup(options.planner, now, installables, byAttribute, group)
		);
	}

	const combined =
		options.targets.length > 1
			? await measureGroup(options.planner, now, installables, byAttribute, {
					key: combinedGroupKey,
					attrs: options.targets.map((target) => target.attr)
				})
			: undefined;

	return {
		flake: options.flake,
		substituters: options.substituters,
		targets,
		groups,
		...(combined !== undefined && { combined })
	};
}

async function measureGroup(
	planner: RealisationPlanner,
	now: Clock,
	installables: ReadonlyMap<string, NixDerivedPathString>,
	byAttribute: ReadonlyMap<string, RealisationMeasurement>,
	group: TargetGroup
): Promise<GroupMeasurement> {
	const planned = await timedPlan(
		planner,
		group.attrs.map((attribute) => requireInstallable(installables, attribute)),
		now
	);
	const apart = sumMeasurements(
		group.attrs.map((attribute) => requireMeasurement(byAttribute, attribute))
	);
	const together = deltaOf(planned.measurement);

	return {
		key: group.key,
		attrs: group.attrs,
		measurement: planned.measurement,
		timings: { planTimeMs: planned.planTimeMs },
		comparison: { apart, together, saved: subtract(apart, together) }
	};
}

interface PlannedMeasurement {
	readonly measurement: RealisationMeasurement;
	readonly planTimeMs: number;
}

async function timedPlan(
	planner: RealisationPlanner,
	installables: readonly NixDerivedPathString[],
	now: Clock
): Promise<PlannedMeasurement> {
	const started = now();
	const partition = await planner.plan(installables);

	return {
		measurement: measurementFrom(partition),
		planTimeMs: Math.round(now() - started)
	};
}

export function measurementFrom(
	partition: NixMissingPartition
): RealisationMeasurement {
	return realisationMeasurementSchema.parse({
		willBuild: partition.willBuild.length,
		willSubstitute: partition.willSubstitute.length,
		unknown: partition.unknown.length,
		downloadSize: partition.downloadSize,
		narSize: partition.narSize
	});
}

export function installableFor(
	target: PublishTarget,
	resolution: ResolvedDerivation
): NixDerivedPathString {
	return `${resolution.drvPath}^${target.outputs.join(',')}`;
}

export function deltaOf(measurement: RealisationMeasurement): MeasurementDelta {
	return {
		willBuild: measurement.willBuild,
		willSubstitute: measurement.willSubstitute,
		unknown: measurement.unknown,
		downloadSize: measurement.downloadSize,
		narSize: measurement.narSize
	};
}

export function sumMeasurements(
	measurements: readonly RealisationMeasurement[]
): MeasurementDelta {
	const total = {
		willBuild: 0,
		willSubstitute: 0,
		unknown: 0,
		downloadSize: 0,
		narSize: 0
	};

	for (const measurement of measurements) {
		for (const metric of comparedMetrics) {
			total[metric] += measurement[metric];
		}
	}

	return total;
}

function subtract(
	left: MeasurementDelta,
	right: MeasurementDelta
): MeasurementDelta {
	return {
		willBuild: left.willBuild - right.willBuild,
		willSubstitute: left.willSubstitute - right.willSubstitute,
		unknown: left.unknown - right.unknown,
		downloadSize: left.downloadSize - right.downloadSize,
		narSize: left.narSize - right.narSize
	};
}

// These maps are built from the target list immediately before lookup. A
// missing key therefore indicates an internal invariant violation, not caller
// input.
function requireResolution(
	resolutions: ReadonlyMap<string, ResolvedDerivation>,
	attribute: string
): ResolvedDerivation {
	const resolution = resolutions.get(attribute);

	if (resolution === undefined) {
		throw new Error(`No derivation was resolved for ${attribute}`);
	}

	return resolution;
}

function requireInstallable(
	installables: ReadonlyMap<string, NixDerivedPathString>,
	attribute: string
): NixDerivedPathString {
	const installable = installables.get(attribute);

	if (installable === undefined) {
		throw new Error(`No installable was built for ${attribute}`);
	}

	return installable;
}

function requireMeasurement(
	byAttribute: ReadonlyMap<string, RealisationMeasurement>,
	attribute: string
): RealisationMeasurement {
	const measurement = byAttribute.get(attribute);

	if (measurement === undefined) {
		throw new Error(`No measurement was taken for ${attribute}`);
	}

	return measurement;
}
