import { describe, expect, it } from 'vitest';

import type { RealisationReport } from './measurement.ts';
import { formatBytes, renderBudgetResult, renderSummary } from './summary.ts';

describe('formatBytes', () => {
	it.each([
		{ bytes: 0, expected: '0 B' },
		{ bytes: 512, expected: '512 B' },
		{ bytes: 1024, expected: '1.0 KiB' },
		{ bytes: 1_323_558, expected: '1.3 MiB' },
		{ bytes: 45_943_896, expected: '43.8 MiB' },
		{ bytes: 3_650_722_201, expected: '3.4 GiB' },
		{ bytes: -1_048_576, expected: '-1.0 MiB' }
	])('renders $bytes as $expected', ({ bytes, expected }) => {
		expect(formatBytes(bytes)).toBe(expected);
	});
});

const report: RealisationReport = {
	flake: 'nixpkgs',
	substituters: ['https://cache.nixos.org'],
	targets: [
		{
			attr: 'app',
			installable: '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app.drv^out',
			measurement: {
				willBuild: 3,
				willSubstitute: 10,
				unknown: 2,
				downloadSize: 1024,
				narSize: 2048
			},
			timings: { evaluationTimeMs: 5, planTimeMs: 7 }
		}
	],
	groups: [],
	combined: {
		key: 'all-targets',
		attrs: ['app', 'tool'],
		measurement: {
			willBuild: 5,
			willSubstitute: 15,
			unknown: 3,
			downloadSize: 3072,
			narSize: 4096
		},
		timings: { planTimeMs: 9 },
		comparison: {
			apart: {
				willBuild: 7,
				willSubstitute: 22,
				unknown: 5,
				downloadSize: 5120,
				narSize: 8192
			},
			together: {
				willBuild: 5,
				willSubstitute: 15,
				unknown: 3,
				downloadSize: 3072,
				narSize: 4096
			},
			saved: {
				willBuild: 2,
				willSubstitute: 7,
				unknown: 2,
				downloadSize: 2048,
				narSize: 4096
			}
		}
	}
};

describe('renderSummary', () => {
	it('renders every target and the combined group', () => {
		expect(renderSummary(report).split('\n')).toStrictEqual([
			'Realising nixpkgs in the diverted store',
			'Substituters: https://cache.nixos.org',
			'',
			'Per target:',
			'  app: 3 to build, 10 to fetch, 2 unknown paths (1.0 KiB download, 2.0 KiB unpacked NAR bytes)',
			'',
			'Group all-targets (app, tool):',
			'  together: 5 to build, 15 to fetch, 3 unknown paths (3.0 KiB download, 4.0 KiB unpacked NAR bytes)',
			'  apart:    7 to build, 22 to fetch, 5 unknown paths (5.0 KiB download, 8.0 KiB unpacked NAR bytes)',
			'  grouping saves 2 derivations, 2 unknown paths, and 4.0 KiB unpacked NAR bytes'
		]);
	});

	it('uses singular nouns for one saved derivation and unknown path', () => {
		if (report.combined === undefined) {
			throw new Error('the fixture must include a combined measurement');
		}

		const summary = renderSummary({
			...report,
			combined: {
				...report.combined,
				comparison: {
					...report.combined.comparison,
					saved: {
						...report.combined.comparison.saved,
						willBuild: 1,
						unknown: 1
					}
				}
			}
		});

		expect(summary.split('\n').at(-1)).toBe(
			'  grouping saves 1 derivation, 1 unknown path, and 4.0 KiB unpacked NAR bytes'
		);
	});

	it('renders an empty substituter list as (none)', () => {
		expect(
			renderSummary({ ...report, substituters: [] }).split('\n', 2)[1]
		).toBe('Substituters: (none)');
	});
});

describe('renderBudgetResult', () => {
	it('reports a clean gate run', () => {
		expect(
			renderBudgetResult({
				tolerance: 0.05,
				breaches: [],
				unbudgeted: []
			}).split('\n')
		).toStrictEqual([
			'Gate: tolerance 5.0%',
			'  every budgeted measurement is within budget'
		]);
	});

	it('reports what breached and by how much', () => {
		expect(
			renderBudgetResult({
				tolerance: 0.05,
				breaches: [
					{
						scope: 'combined',
						key: 'all-targets',
						metric: 'narSize',
						expected: 2000,
						allowed: 2100,
						measured: 2500,
						excess: 400
					}
				],
				unbudgeted: [{ scope: 'target', key: 'tool' }]
			}).split('\n')
		).toStrictEqual([
			'Gate: tolerance 5.0%',
			'  no budget for target tool',
			'  combined all-targets: narSize is 2500, budget 2000, allowed 2100, over by 400'
		]);
	});
});
