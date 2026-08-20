import { createHash } from 'node:crypto';

import { type Cohort, isBestEffortCohort } from './publish-plan.ts';

/**
 * `checkStoreCapacity` (packages/cli/src/plan/capacity.ts) applies this headroom
 * calculation to one build. Packing applies the same calculation to a candidate
 * group. `actions/` cannot import `packages/cli`, so the formula and its
 * provisional defaults are mirrored here rather than shared. Keep the defaults
 * here and in `capacity.ts` numerically identical until both can import the
 * formula from one package.
 */
export interface PackingHeadroom {
	readonly absoluteMinimum: number;
	readonly fraction: number;
}

export const defaultPackingHeadroomAbsoluteMinimum = 5 * 1024 ** 3;
export const defaultPackingHeadroomFraction = 0.1;

// Build scratch requirements do not scale with store size. The effective
// headroom is therefore the greater of the absolute minimum and the configured
// fraction. This matches `effectiveHeadroom` in capacity.ts.
function effectivePackingHeadroom(
	headroom: PackingHeadroom,
	capacity: number
): number {
	return Math.max(headroom.absoluteMinimum, headroom.fraction * capacity);
}

export interface PackCohortsOptions {
	/**
	When false, packing does not run and {@link packCohorts} returns `undefined`.
	The caller retains the cohorts from the manifest.
	*/
	readonly enabled: boolean;
	readonly cohorts: readonly Cohort[];
	/**
	Measured substitutable NAR size for each target, keyed by attr. A target
	without a measurement remains in its original cohort.
	*/
	readonly measurements: ReadonlyMap<string, number>;
	readonly capacity: number;
	readonly headroom?: Partial<PackingHeadroom>;
}

export interface PackingResult {
	/**
	The cohorts from the manifest after eligible single-target cohorts have been
	combined. Explicit multi-target cohorts remain unchanged.
	*/
	readonly cohorts: readonly Cohort[];
	/**
	The total measured size of each emitted cohort, keyed by the cohort's key. A cohort whose targets were not all measured has no entry.
	*/
	readonly measuredSizes: ReadonlyMap<string, number>;
}

interface SizedCohort {
	readonly cohort: Cohort;
	readonly size: number;
}

// A cohort's own execution context: cohorts sharing a job's runner, remote
// setting and failure tolerance are the only ones packing may combine, since
// a job runs under one label, one builder configuration and one
// continue-on-error. A best-effort target's failure is tolerated only where
// every member of its job tolerates failure, so the tolerance belongs in the
// context packing groups by.
function executionContextKey(cohort: Cohort): string {
	return JSON.stringify([
		cohort.system,
		cohort.os.toLowerCase(),
		cohort.remote,
		isBestEffortCohort(cohort.targets)
	]);
}

/**
 * Groups eligible single-target cohorts under a disk budget using first-fit
 * decreasing. It sorts targets by measured substitutable NAR size, then places
 * each target in the first group with enough capacity or starts a new group.
 * Ties retain the cohort order from the manifest.
 *
 * Packing combines targets only when they have the same execution context.
 * Failure tolerance is part of that context, so a best-effort target is never
 * packed alongside a required target.
 *
 * Packing does not split or merge an explicit multi-target cohort. A target
 * without a measurement remains in its original cohort because measured
 * packing has no basis for moving it.
 *
 * Returns `undefined` only when disabled. An enabled run returns a
 * `PackingResult` even when it combines no cohorts.
 */
export function packCohorts(
	options: PackCohortsOptions
): PackingResult | undefined {
	if (!options.enabled) {
		return undefined;
	}

	const headroom: PackingHeadroom = {
		absoluteMinimum:
			options.headroom?.absoluteMinimum ??
			defaultPackingHeadroomAbsoluteMinimum,
		fraction: options.headroom?.fraction ?? defaultPackingHeadroomFraction
	};
	const budget =
		options.capacity - effectivePackingHeadroom(headroom, options.capacity);

	const packable: SizedCohort[] = [];
	const untouched: Cohort[] = [];

	for (const cohort of options.cohorts) {
		const size = measuredSizeOf(cohort, options.measurements);

		if (size !== undefined && cohort.targets.length === 1) {
			packable.push({ cohort, size });
			continue;
		}

		untouched.push(cohort);
	}

	const measuredSizes = new Map<string, number>();

	for (const cohort of untouched) {
		const size = measuredSizeOf(cohort, options.measurements);

		if (size !== undefined) {
			measuredSizes.set(cohort.key, size);
		}
	}

	const packedCohorts: Cohort[] = [];

	for (const bin of packContext(packable, budget)) {
		const packed = mergeCohorts(bin.map((entry) => entry.cohort));

		packedCohorts.push(packed);
		measuredSizes.set(
			packed.key,
			bin.reduce((total, entry) => total + entry.size, 0)
		);
	}

	return { cohorts: [...packedCohorts, ...untouched], measuredSizes };
}

function measuredSizeOf(
	cohort: Cohort,
	measurements: ReadonlyMap<string, number>
): number | undefined {
	let total = 0;

	for (const target of cohort.targets) {
		const size = measurements.get(target.attr);

		if (size === undefined) {
			return undefined;
		}

		total += size;
	}

	return total;
}

// First-fit decreasing, run independently per execution context: a job runs
// under one runner label, one remote setting and one failure tolerance, so
// packing only ever combines cohorts that already share all three.
function packContext(
	candidates: readonly SizedCohort[],
	budget: number
): readonly SizedCohort[][] {
	const byContext = new Map<string, SizedCohort[]>();

	for (const candidate of candidates) {
		const key = executionContextKey(candidate.cohort);
		const group = byContext.get(key) ?? [];

		group.push(candidate);
		byContext.set(key, group);
	}

	return byContext
		.values()
		.flatMap((group) => firstFitDecreasing(group, budget))
		.toArray();
}

function firstFitDecreasing(
	candidates: readonly SizedCohort[],
	budget: number
): readonly SizedCohort[][] {
	const ordered = candidates
		.map((candidate, index) => ({ candidate, index }))
		.toSorted((left, right) =>
			right.candidate.size === left.candidate.size
				? left.index - right.index
				: right.candidate.size - left.candidate.size
		)
		.map((entry) => entry.candidate);

	const bins: { entries: SizedCohort[]; total: number }[] = [];

	for (const entry of ordered) {
		const bin = bins.find(
			(candidate) => candidate.total + entry.size <= budget
		);

		if (bin === undefined) {
			bins.push({ entries: [entry], total: entry.size });
			continue;
		}

		bin.entries.push(entry);
		bin.total += entry.size;
	}

	return bins.map((bin) => bin.entries);
}

function mergeCohorts(cohorts: readonly Cohort[]): Cohort {
	const [first, ...rest] = cohorts;

	if (first === undefined) {
		throw new Error('packContext produced an empty bin');
	}

	if (rest.length === 0) {
		return first;
	}

	const digest = createHash('sha256')
		.update(
			JSON.stringify(
				cohorts
					.map((cohort) => cohort.key)
					.toSorted((left, right) => left.localeCompare(right))
			)
		)
		.digest('hex')
		.slice(0, 16);
	const mode = first.remote ? 'remote' : 'local';

	return {
		key: `packed-${first.system}-${first.os.toLowerCase()}-${mode}-${digest}`,
		system: first.system,
		os: first.os,
		remote: first.remote,
		targets: cohorts.flatMap((cohort) => cohort.targets),
		installables: cohorts.flatMap((cohort) => cohort.installables)
	};
}
