import { createHash } from 'node:crypto';

import { type Cohort, isBestEffortCohort } from './publish-plan.ts';

export interface PackingHeadroom {
	readonly absoluteMinimum: number;
	readonly fraction: number;
}

// `actions/` cannot import the CLI implementation of store-capacity headroom,
// so packing mirrors its formula and defaults. Keep this code identical to
// `packages/cli/src/plan/capacity.ts` until both packages can import one shared
// implementation.
export const defaultPackingHeadroomAbsoluteMinimum = 5 * 1024 ** 3;
export const defaultPackingHeadroomFraction = 0.1;

function effectivePackingHeadroom(
	headroom: PackingHeadroom,
	capacity: number
): number {
	return Math.max(headroom.absoluteMinimum, headroom.fraction * capacity);
}

export interface PackCohortsOptions {
	readonly enabled: boolean;
	readonly cohorts: readonly Cohort[];
	readonly measurements: ReadonlyMap<string, number>;
	readonly capacity: number;
	readonly headroom?: Partial<PackingHeadroom>;
}

export interface PackingResult {
	readonly cohorts: readonly Cohort[];
	readonly measuredSizes: ReadonlyMap<string, number>;
}

interface SizedCohort {
	readonly cohort: Cohort;
	readonly size: number;
}

// A job has one runner label, one builder configuration and one
// continue-on-error value. Pack cohorts together only when all three match. In
// particular, a best-effort target cannot share a job with a required target.
function executionContextKey(cohort: Cohort): string {
	return JSON.stringify([
		cohort.system,
		cohort.os.toLowerCase(),
		cohort.remote,
		isBestEffortCohort(cohort.targets)
	]);
}

/**
 * Pack measured single-target cohorts within each execution context using
 * first-fit decreasing. Sort by measured substitutable NAR size and preserve
 * manifest order when sizes match.
 *
 * Never split or merge an explicit multi-target cohort. Leave a target in its
 * original cohort when it has no measurement. Return `undefined` only when
 * packing is disabled; an enabled run returns a result even if nothing moves.
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
