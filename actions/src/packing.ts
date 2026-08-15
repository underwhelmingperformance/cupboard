import { createHash } from 'node:crypto';

import { type Cohort, isBestEffortCohort } from './publish-plan.ts';

/**
 * The headroom shape `checkStoreCapacity` (packages/cli/src/plan/capacity.ts)
 * already prices a single build against. Packing prices a grouping the same
 * way, but `actions/` cannot import `packages/cli`, so the formula and its
 * provisional defaults are mirrored here rather than shared; keep the defaults
 * here and in `capacity.ts` numerically identical by hand until the formula
 * lives in a package both sides can import.
 */
export interface PackingHeadroom {
	readonly absoluteMinimum: number;
	readonly fraction: number;
}

export const defaultPackingHeadroomAbsoluteMinimum = 5 * 1024 ** 3;
export const defaultPackingHeadroomFraction = 0.1;

// Build scratch does not scale with store size: a fraction alone is generous
// on a large store and negligible on a small one, so the effective headroom
// is whichever of the two the store's own capacity makes larger. Identical to
// capacity.ts's own effectiveHeadroom; see the module comment above.
function effectivePackingHeadroom(
	headroom: PackingHeadroom,
	capacity: number
): number {
	return Math.max(headroom.absoluteMinimum, headroom.fraction * capacity);
}

export interface PackCohortsOptions {
	/** Off by default. When false, packing does not run and {@link packCohorts} returns `undefined`, so the caller keeps the manifest's own cohorts. */
	readonly enabled: boolean;
	readonly cohorts: readonly Cohort[];
	/** Each target's own measured substitutable NAR size, keyed by attr. A target with no entry here cannot be priced, so packing never repartitions it: it keeps its manifest-declared cohort untouched. */
	readonly measurements: ReadonlyMap<string, number>;
	readonly capacity: number;
	readonly headroom?: Partial<PackingHeadroom>;
}

export interface PackingResult {
	/** The manifest's cohorts, with packable ones replaced by packed groupings; an explicit multi-target cohort is never split or merged, and always appears here exactly as declared. */
	readonly cohorts: readonly Cohort[];
	/** The total measured size of each emitted cohort, keyed by the cohort's key. A cohort whose targets were not all measured has no entry. */
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
 * Groups the manifest's own single-target cohorts into packed cohorts under a
 * disk budget (the given capacity less a configured headroom), first-fit
 * decreasing over each target's own measured substitutable NAR size: sort
 * candidates largest first, place each into the first packed group with
 * room, or open a new one. Deterministic from the measurements alone, never a
 * heuristic over derivation counts or manifest order; a tie in size breaks by
 * the manifest's own cohort order, never at random.
 *
 * Candidates are packed within one execution context only, and a cohort's
 * failure tolerance is part of that context: a best-effort target keeps the
 * `continue-on-error` its manifest asked for because it is never packed
 * alongside a required one.
 *
 * An explicit multi-target cohort (the manifest's own `cohort` label) is
 * never split or merged: it is not a candidate for packing at all, and
 * passes through untouched. A single-target cohort whose target has no
 * entry in `measurements` cannot be priced, and is left untouched the same
 * way: an unpriced repartition would be a heuristic, not a measurement.
 *
 * Returns `undefined` when disabled, so a caller can tell "packing found
 * nothing worth combining" (an empty set of packed groups, still a
 * `PackingResult`) apart from "packing did not run at all".
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
