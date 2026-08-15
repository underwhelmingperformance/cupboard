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
 * What realising a set of installables against an empty store would cost:
 * the planner's own partition counts and the byte totals for the paths it
 * would substitute, the two halves a build receipt already records
 * separately.
 */
export const realisationMeasurementSchema = plannerPartitionSchema
	.pick({ willBuild: true, willSubstitute: true, unknown: true })
	.extend(substitutableSizesSchema.shape);
export type RealisationMeasurement = z.output<
	typeof realisationMeasurementSchema
>;

/**
 * The metrics a budget is set on. `unknown` is left out: it counts the paths
 * no substituter answered for, which is a property of the network the
 * measurement ran on rather than of the flake being measured.
 */
export const budgetedMetrics = [
	'willBuild',
	'willSubstitute',
	'downloadSize',
	'narSize'
] as const;
export type BudgetedMetric = (typeof budgetedMetrics)[number];

/**
The difference between two measurements, metric by metric.
*/
export type MeasurementDelta = Readonly<Record<BudgetedMetric, number>>;

/**
The derivation a target's attr evaluates to, and what evaluating cost.
*/
export interface ResolvedDerivation {
	readonly drvPath: StorePathString;
	readonly evaluationTimeMs: number;
}

/**
 * The store the fixture plans against. Split from the measurement itself so
 * the whole report can be produced from injected answers, with no Nix, no
 * store and no network.
 */
export interface RealisationPlanner {
	/**
	The derivation this target's attr names, evaluated if need be.
	*/
	resolve(target: PublishTarget): Promise<ResolvedDerivation>;
	/**
	 * Put the given derivations within the store's reach, so it can plan
	 * against them. A store with no derivations cannot plan at all.
	 */
	seed(drvPaths: readonly StorePathString[]): Promise<void>;
	/**
	What realising the given installables would require.
	*/
	plan(
		installables: readonly NixDerivedPathString[]
	): Promise<NixMissingPartition>;
}

/**
A monotonic millisecond reading, injected so timings are testable.
*/
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
 * What a group costs measured together against what its members cost
 * measured one at a time. The saving is the whole point of grouping: members
 * that share a closure pay for it once together and once each apart.
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
 * One run's numbers. `combined` measures every target in the manifest as a
 * single group, present whenever there is more than one target to combine;
 * `groups` measures each cohort the manifest declares with more than one
 * member.
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

/**
The key the whole manifest is reported under when measured as one group.
*/
export const combinedGroupKey = 'all-targets';

/**
 * Measures every target on its own and every group of targets together,
 * against a store that holds no realisation of any of them. Targets are
 * resolved and planned one at a time: the report carries each target's own
 * evaluation and planning times, which overlapping work would blur.
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

/**
The report's measurement of a partition the store answered with.
*/
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

/**
The derived path naming a target's outputs on its evaluated derivation.
*/
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
		downloadSize: 0,
		narSize: 0
	};

	for (const measurement of measurements) {
		for (const metric of budgetedMetrics) {
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
		downloadSize: left.downloadSize - right.downloadSize,
		narSize: left.narSize - right.narSize
	};
}

// Every attr in these lookups was put there from the same target list being
// walked, so an absent one is a defect in this module rather than anything a
// caller can cause.
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
