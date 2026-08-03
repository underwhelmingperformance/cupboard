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
				unknown: 0,
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
			unknown: 0,
			downloadSize: 3072,
			narSize: 4096
		},
		timings: { planTimeMs: 9 },
		comparison: {
			apart: {
				willBuild: 7,
				willSubstitute: 22,
				downloadSize: 5120,
				narSize: 8192
			},
			together: {
				willBuild: 5,
				willSubstitute: 15,
				downloadSize: 3072,
				narSize: 4096
			},
			saved: {
				willBuild: 2,
				willSubstitute: 7,
				downloadSize: 2048,
				narSize: 4096
			}
		}
	}
};

describe('renderSummary', () => {
	it('reads out every target and the combined group', () => {
		expect(renderSummary(report).split('\n')).toStrictEqual([
			'Realising nixpkgs against an empty store',
			'Substituters: https://cache.nixos.org',
			'',
			'Per target:',
			'  app: 3 to build, 10 to fetch (1.0 KiB download, 2.0 KiB unpacked)',
			'',
			'Group all-targets (app, tool):',
			'  together: 5 to build, 15 to fetch (3.0 KiB download, 4.0 KiB unpacked)',
			'  apart:    7 to build, 22 to fetch (5.0 KiB download, 8.0 KiB unpacked)',
			'  grouping saves 2 derivation(s) and 4.0 KiB unpacked'
		]);
	});

	it('names an empty substituter list', () => {
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
