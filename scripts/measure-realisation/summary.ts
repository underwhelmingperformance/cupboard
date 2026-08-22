import type { BudgetResult } from './budget.ts';
import {
	combinedGroupKey,
	type GroupMeasurement,
	type RealisationReport
} from './measurement.ts';

const binaryUnits = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

/**
 * A byte count in the units a person reads it in. The JSON carries the exact
 * number; this is for the summary alone.
 */
export function formatBytes(bytes: number): string {
	const sign = bytes < 0 ? '-' : '';
	let remaining = Math.abs(bytes);
	let unit = 0;

	while (remaining >= 1024 && unit < binaryUnits.length - 1) {
		remaining /= 1024;
		unit += 1;
	}

	const digits = unit === 0 || remaining >= 100 ? 0 : 1;

	return `${sign}${remaining.toFixed(digits)} ${binaryUnits[unit] ?? 'B'}`;
}

function formatCount(count: number, singular: string): string {
	return `${String(count)} ${singular}${count === 1 ? '' : 's'}`;
}

export function renderSummary(report: RealisationReport): string {
	const lines = [
		`Realising ${report.flake} in the diverted store`,
		`Substituters: ${report.substituters.join(' ') || '(none)'}`,
		'',
		'Per target:'
	];

	for (const target of report.targets) {
		lines.push(
			`  ${target.attr}: ${String(target.measurement.willBuild)} to build, ` +
				`${String(target.measurement.willSubstitute)} to fetch, ` +
				`${formatCount(target.measurement.unknown, 'unknown path')} ` +
				`(${formatBytes(target.measurement.downloadSize)} download, ` +
				`${formatBytes(target.measurement.narSize)} unpacked NAR bytes)`
		);
	}

	for (const group of report.groups) {
		lines.push('', ...groupLines(group.key, group));
	}

	if (report.combined !== undefined) {
		lines.push('', ...groupLines(combinedGroupKey, report.combined));
	}

	return lines.join('\n');
}

function groupLines(key: string, group: GroupMeasurement): readonly string[] {
	const { apart, together, saved } = group.comparison;

	return [
		`Group ${key} (${group.attrs.join(', ')}):`,
		`  together: ${String(together.willBuild)} to build, ` +
			`${String(together.willSubstitute)} to fetch, ` +
			`${formatCount(together.unknown, 'unknown path')} ` +
			`(${formatBytes(together.downloadSize)} download, ` +
			`${formatBytes(together.narSize)} unpacked NAR bytes)`,
		`  apart:    ${String(apart.willBuild)} to build, ` +
			`${String(apart.willSubstitute)} to fetch, ` +
			`${formatCount(apart.unknown, 'unknown path')} ` +
			`(${formatBytes(apart.downloadSize)} download, ` +
			`${formatBytes(apart.narSize)} unpacked NAR bytes)`,
		`  grouping saves ${formatCount(saved.willBuild, 'derivation')}, ` +
			`${formatCount(saved.unknown, 'unknown path')}, and ` +
			`${formatBytes(saved.narSize)} unpacked NAR bytes`
	];
}

export function renderBudgetResult(result: BudgetResult): string {
	const lines = [
		`Gate: tolerance ${(result.tolerance * 100).toFixed(1)}%`,
		...result.unbudgeted.map(
			(entry) => `  no budget for ${entry.scope} ${entry.key}`
		)
	];

	if (result.breaches.length === 0) {
		lines.push('  every budgeted measurement is within budget');

		return lines.join('\n');
	}

	for (const breach of result.breaches) {
		lines.push(
			`  ${breach.scope} ${breach.key}: ${breach.metric} is ` +
				`${String(breach.measured)}, budget ${String(breach.expected)}, ` +
				`allowed ${String(breach.allowed)}, over by ${String(breach.excess)}`
		);
	}

	return lines.join('\n');
}
