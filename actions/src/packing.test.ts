import { describe, expect, it } from 'vitest';

import { packCohorts } from './packing.ts';
import type { Cohort, PublishTarget } from './publish-plan.ts';

function target(
	attribute: string,
	overrides: Partial<PublishTarget> = {}
): PublishTarget {
	return {
		attr: attribute,
		system: 'x86_64-linux',
		os: 'ubuntu-latest',
		remote: false,
		bestEffort: false,
		rootSuffix: attribute.replace('.#', ''),
		outputs: ['out'],
		...overrides
	};
}

function singleton(attribute: string, overrides: Partial<Cohort> = {}): Cohort {
	return {
		key: `cohort-${attribute.replace('.#', '')}`,
		system: 'x86_64-linux',
		os: 'ubuntu-latest',
		remote: false,
		targets: [target(attribute)],
		installables: [`${attribute}^out`],
		...overrides
	};
}

function measurements(
	entries: readonly (readonly [string, number])[]
): ReadonlyMap<string, number> {
	return new Map(entries);
}

describe('packCohorts', () => {
	it('yields nothing when disabled', () => {
		expect(
			packCohorts({
				enabled: false,
				cohorts: [singleton('.#a')],
				measurements: measurements([['.#a', 100]]),
				capacity: 1000
			})
		).toBeUndefined();
	});

	it('packs single-target cohorts first-fit decreasing by measured size', () => {
		const result = packCohorts({
			enabled: true,
			cohorts: [singleton('.#a'), singleton('.#b'), singleton('.#c')],
			measurements: measurements([
				['.#a', 60],
				['.#b', 50],
				['.#c', 40]
			]),
			capacity: 100,
			headroom: { absoluteMinimum: 0, fraction: 0 }
		});

		expect(
			result?.cohorts.map((cohort) => cohort.targets.map((entry) => entry.attr))
		).toStrictEqual([['.#a', '.#c'], ['.#b']]);
	});

	it('applies the configured headroom to the packing budget', () => {
		const cohorts = [singleton('.#a'), singleton('.#b'), singleton('.#c')];
		const sizes = measurements([
			['.#a', 60],
			['.#b', 50],
			['.#c', 40]
		]);

		const withoutHeadroom = packCohorts({
			enabled: true,
			cohorts,
			measurements: sizes,
			capacity: 100,
			headroom: { absoluteMinimum: 0, fraction: 0 }
		});
		const withHeadroom = packCohorts({
			enabled: true,
			cohorts,
			measurements: sizes,
			capacity: 100,
			headroom: { absoluteMinimum: 20, fraction: 0 }
		});

		expect({
			withoutHeadroom: withoutHeadroom?.cohorts.map((cohort) =>
				cohort.targets.map((entry) => entry.attr)
			),
			withHeadroom: withHeadroom?.cohorts.map((cohort) =>
				cohort.targets.map((entry) => entry.attr)
			)
		}).toStrictEqual({
			withoutHeadroom: [['.#a', '.#c'], ['.#b']],
			withHeadroom: [['.#a'], ['.#b'], ['.#c']]
		});
	});

	it('never splits or merges an explicit multi-target cohort', () => {
		const explicit = singleton('.#a', {
			key: 'cohort-group',
			targets: [target('.#a'), target('.#b')],
			installables: ['.#a^out', '.#b^out']
		});
		const single = singleton('.#c');

		const result = packCohorts({
			enabled: true,
			cohorts: [explicit, single],
			measurements: measurements([
				['.#a', 60],
				['.#b', 50],
				['.#c', 40]
			]),
			capacity: 1000
		});

		expect(result?.cohorts).toContainEqual(explicit);
	});

	it('leaves a target packing cannot price untouched, in its own cohort', () => {
		const unpriced = singleton('.#unpriced');

		const result = packCohorts({
			enabled: true,
			cohorts: [singleton('.#a'), unpriced],
			measurements: measurements([['.#a', 60]]),
			capacity: 1000
		});

		expect(result?.cohorts).toContainEqual(unpriced);
	});

	it('never combines cohorts across different execution contexts', () => {
		const remote = singleton('.#a', {
			remote: true,
			targets: [target('.#a', { remote: true })]
		});
		const local = singleton('.#b');

		const result = packCohorts({
			enabled: true,
			cohorts: [remote, local],
			measurements: measurements([
				['.#a', 10],
				['.#b', 10]
			]),
			capacity: 1000
		});

		expect(
			result?.cohorts
				.map((cohort) => cohort.targets.map((entry) => entry.attr))
				.toSorted((left, right) =>
					left.join(',').localeCompare(right.join(','))
				)
		).toStrictEqual([['.#a'], ['.#b']]);
	});

	it('carries every emitted cohort’s own measured size, structurally', () => {
		const explicit = singleton('.#group-a', {
			key: 'cohort-group',
			targets: [target('.#group-a'), target('.#group-b')],
			installables: ['.#group-a^out', '.#group-b^out']
		});
		const unpriced = singleton('.#unpriced');

		const result = packCohorts({
			enabled: true,
			cohorts: [singleton('.#a'), singleton('.#b'), explicit, unpriced],
			measurements: measurements([
				['.#a', 60],
				['.#b', 50],
				['.#group-a', 5],
				['.#group-b', 15]
			]),
			capacity: 1000,
			headroom: { absoluteMinimum: 0, fraction: 0 }
		});

		expect(result).not.toBeUndefined();

		if (result === undefined) {
			return;
		}

		const sizesByAttributes = new Map(
			result.cohorts.map((cohort) => [
				cohort.targets.map((entry) => entry.attr).join(','),
				result.measuredSizes.get(cohort.key)
			])
		);

		expect(Object.fromEntries(sizesByAttributes)).toStrictEqual({
			'.#a,.#b': 110,
			'.#group-a,.#group-b': 20,
			'.#unpriced': undefined
		});
	});
});
