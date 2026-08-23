import { describe, expect, it } from 'vitest';

import {
	BaselineJsonError,
	BaselineSchemaError,
	checkBudgets,
	InvalidToleranceError,
	parseBaseline,
	parseTolerance
} from './budget.ts';
import type {
	BudgetedMetric,
	GroupMeasurement,
	RealisationMeasurement,
	RealisationReport,
	TargetMeasurement
} from './measurement.ts';

const budget: RealisationMeasurement = {
	willBuild: 100,
	willSubstitute: 200,
	unknown: 0,
	downloadSize: 1000,
	narSize: 2000
};

function targetMeasurement(
	attribute: string,
	measurement: RealisationMeasurement
): TargetMeasurement {
	return {
		attr: attribute,
		installable: `/nix/store/0123456789abcdfghijklmnpqrsvwxyz-${attribute}.drv^out`,
		measurement,
		timings: { evaluationTimeMs: 0, planTimeMs: 0 }
	};
}

function groupMeasurement(
	key: string,
	measurement: RealisationMeasurement
): GroupMeasurement {
	const together = {
		willBuild: measurement.willBuild,
		willSubstitute: measurement.willSubstitute,
		downloadSize: measurement.downloadSize,
		narSize: measurement.narSize
	};

	return {
		key,
		attrs: ['app', 'tool'],
		measurement,
		timings: { planTimeMs: 0 },
		comparison: {
			apart: together,
			together,
			saved: {
				willBuild: 0,
				willSubstitute: 0,
				downloadSize: 0,
				narSize: 0
			}
		}
	};
}

function reportOf(measurement: RealisationMeasurement): RealisationReport {
	return {
		flake: '.',
		substituters: [],
		targets: [targetMeasurement('app', measurement)],
		groups: [groupMeasurement('linux', measurement)],
		combined: groupMeasurement('all-targets', measurement)
	};
}

const baseline = {
	targets: [{ attr: 'app', measurement: budget }],
	groups: [{ key: 'linux', measurement: budget }],
	combined: { measurement: budget }
};

describe('parseBaseline', () => {
	it('accepts a prior report as a baseline', () => {
		const recorded = JSON.stringify(reportOf(budget));

		expect(parseBaseline(recorded)).toStrictEqual(baseline);
	});

	it.each([
		{
			name: 'a source that is not JSON',
			source: 'not json',
			expected: BaselineJsonError
		},
		{
			name: 'a baseline with no measurements',
			source: JSON.stringify({ targets: [{ attr: 'app' }], groups: [] }),
			expected: BaselineSchemaError
		}
	])('rejects $name', ({ source, expected }) => {
		expect(() => parseBaseline(source)).toThrow(expected);
	});
});

describe('parseTolerance', () => {
	it.each([
		{ value: '0', expected: 0 },
		{ value: '0.05', expected: 0.05 },
		{ value: '1.5', expected: 1.5 }
	])('reads $value', ({ value, expected }) => {
		expect(parseTolerance(value)).toBe(expected);
	});

	it.each([{ value: '-0.1' }, { value: 'plenty' }, { value: '' }])(
		'rejects $value',
		({ value }) => {
			expect(() => parseTolerance(value)).toThrow(InvalidToleranceError);
		}
	);
});

describe('checkBudgets', () => {
	it('passes a measurement inside its budget', () => {
		expect(
			checkBudgets({ report: reportOf(budget), baseline, tolerance: 0 })
		).toStrictEqual({ tolerance: 0, breaches: [], unbudgeted: [] });
	});

	it('passes a measurement inside the tolerance', () => {
		expect(
			checkBudgets({
				report: reportOf({ ...budget, narSize: 2100 }),
				baseline,
				tolerance: 0.05
			})
		).toStrictEqual({ tolerance: 0.05, breaches: [], unbudgeted: [] });
	});

	const overBudget: readonly {
		readonly metric: BudgetedMetric;
		readonly measured: number;
		readonly expected: number;
		readonly allowed: number;
	}[] = [
		{ metric: 'willBuild', measured: 106, expected: 100, allowed: 105 },
		{ metric: 'willSubstitute', measured: 211, expected: 200, allowed: 210 },
		{ metric: 'downloadSize', measured: 1051, expected: 1000, allowed: 1050 },
		{ metric: 'narSize', measured: 2101, expected: 2000, allowed: 2100 }
	];

	it.each(overBudget)('reports $metric over budget', (breach) => {
		const result = checkBudgets({
			report: reportOf({ ...budget, [breach.metric]: breach.measured }),
			baseline,
			tolerance: 0.05
		});

		const scopes = [
			{ scope: 'target', key: 'app' },
			{ scope: 'group', key: 'linux' },
			{ scope: 'combined', key: 'all-targets' }
		] as const;

		expect(result).toStrictEqual({
			tolerance: 0.05,
			unbudgeted: [],
			breaches: scopes.map((entry) => ({
				scope: entry.scope,
				key: entry.key,
				metric: breach.metric,
				expected: breach.expected,
				allowed: breach.allowed,
				measured: breach.measured,
				excess: breach.measured - breach.allowed
			}))
		});
	});

	it('does not budget the unknown-path count', () => {
		expect(
			checkBudgets({
				report: reportOf({ ...budget, unknown: 500 }),
				baseline,
				tolerance: 0
			})
		).toStrictEqual({ tolerance: 0, breaches: [], unbudgeted: [] });
	});

	it('reports a measurement the baseline has no entry for', () => {
		expect(
			checkBudgets({
				report: reportOf(budget),
				baseline: { targets: [], groups: [] },
				tolerance: 0
			})
		).toStrictEqual({
			tolerance: 0,
			breaches: [],
			unbudgeted: [
				{ scope: 'target', key: 'app' },
				{ scope: 'group', key: 'linux' },
				{ scope: 'combined', key: 'all-targets' }
			]
		});
	});
});
