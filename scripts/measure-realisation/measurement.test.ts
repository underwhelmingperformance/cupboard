import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import type { PublishTarget } from '../../actions/src/publish-plan.ts';
import type {
	NixDerivedPathString,
	NixMissingPartition
} from '../../packages/nix/src/index.ts';

import {
	type Clock,
	measureRealisation,
	type RealisationPlanner,
	type ResolvedDerivation,
	sumMeasurements
} from './measurement.ts';

const appDrv = storePathSchema.parse(
	'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app.drv'
);
const toolDrv = storePathSchema.parse(
	'/nix/store/1123456789abcdfghijklmnpqrsvwxyz-tool.drv'
);

const unlabelledApp: PublishTarget = {
	attr: 'app',
	system: 'x86_64-linux',
	os: 'ubuntu-latest',
	remote: false,
	bestEffort: false,
	rootSuffix: 'app',
	outputs: ['out']
};
const app: PublishTarget = { ...unlabelledApp, cohort: 'linux' };
const tool: PublishTarget = {
	...app,
	attr: 'tool',
	rootSuffix: 'tool',
	outputs: ['out', 'lib']
};

const appInstallable = `${appDrv}^out`;
const toolInstallable = `${toolDrv}^out,lib`;
const groupInstallables = [appInstallable, toolInstallable].join(' ');

interface RecordedPlan {
	readonly installables: readonly NixDerivedPathString[];
}

class ScriptedPlanner implements RealisationPlanner {
	readonly plans: RecordedPlan[] = [];

	seeded: readonly StorePathString[] = [];

	constructor(
		private readonly derivations: Readonly<Record<string, StorePathString>>,
		private readonly partitions: Readonly<Record<string, NixMissingPartition>>
	) {}

	resolve(target: PublishTarget): Promise<ResolvedDerivation> {
		const drvPath = this.derivations[target.attr];

		if (drvPath === undefined) {
			throw new Error(`No scripted derivation for ${target.attr}`);
		}

		return Promise.resolve({ drvPath, evaluationTimeMs: 0 });
	}

	seed(drvPaths: readonly StorePathString[]): Promise<void> {
		this.seeded = drvPaths;

		return Promise.resolve();
	}

	plan(
		installables: readonly NixDerivedPathString[]
	): Promise<NixMissingPartition> {
		this.plans.push({ installables });

		const partition = this.partitions[installables.join(' ')];

		if (partition === undefined) {
			throw new Error(`No scripted partition for ${installables.join(' ')}`);
		}

		return Promise.resolve(partition);
	}
}

function partition(options: {
	readonly willBuild: number;
	readonly willSubstitute: number;
	readonly downloadSize: number;
	readonly narSize: number;
}): NixMissingPartition {
	return {
		willBuild: Array.from({ length: options.willBuild }, (_, index) =>
			storePathSchema.parse(
				`/nix/store/${String(index).padStart(32, 'b')}-build.drv`
			)
		),
		willSubstitute: Array.from({ length: options.willSubstitute }, (_, index) =>
			storePathSchema.parse(
				`/nix/store/${String(index).padStart(32, 'c')}-fetch`
			)
		),
		unknown: [],
		downloadSize: options.downloadSize,
		narSize: options.narSize
	};
}

function steppingClock(): Clock {
	let reading = 0;

	return () => {
		reading += 1;

		return reading;
	};
}

describe('measureRealisation', () => {
	it('measures every target on its own and the group together', async () => {
		const planner = new ScriptedPlanner(
			{ app: appDrv, tool: toolDrv },
			{
				[appInstallable]: partition({
					willBuild: 3,
					willSubstitute: 10,
					downloadSize: 1000,
					narSize: 5000
				}),
				[toolInstallable]: partition({
					willBuild: 4,
					willSubstitute: 12,
					downloadSize: 1200,
					narSize: 6000
				}),
				[groupInstallables]: partition({
					willBuild: 5,
					willSubstitute: 15,
					downloadSize: 1500,
					narSize: 7000
				})
			}
		);

		const report = await measureRealisation({
			flake: 'nixpkgs',
			substituters: ['https://cache.nixos.org'],
			targets: [app, tool],
			planner,
			now: steppingClock()
		});

		expect(report).toStrictEqual({
			flake: 'nixpkgs',
			substituters: ['https://cache.nixos.org'],
			targets: [
				{
					attr: 'app',
					installable: appInstallable,
					measurement: {
						willBuild: 3,
						willSubstitute: 10,
						unknown: 0,
						downloadSize: 1000,
						narSize: 5000
					},
					timings: { evaluationTimeMs: 0, planTimeMs: 1 }
				},
				{
					attr: 'tool',
					installable: toolInstallable,
					measurement: {
						willBuild: 4,
						willSubstitute: 12,
						unknown: 0,
						downloadSize: 1200,
						narSize: 6000
					},
					timings: { evaluationTimeMs: 0, planTimeMs: 1 }
				}
			],
			groups: [
				{
					key: 'linux',
					attrs: ['app', 'tool'],
					measurement: {
						willBuild: 5,
						willSubstitute: 15,
						unknown: 0,
						downloadSize: 1500,
						narSize: 7000
					},
					timings: { planTimeMs: 1 },
					comparison: {
						apart: {
							willBuild: 7,
							willSubstitute: 22,
							downloadSize: 2200,
							narSize: 11_000
						},
						together: {
							willBuild: 5,
							willSubstitute: 15,
							downloadSize: 1500,
							narSize: 7000
						},
						saved: {
							willBuild: 2,
							willSubstitute: 7,
							downloadSize: 700,
							narSize: 4000
						}
					}
				}
			],
			combined: {
				key: 'all-targets',
				attrs: ['app', 'tool'],
				measurement: {
					willBuild: 5,
					willSubstitute: 15,
					unknown: 0,
					downloadSize: 1500,
					narSize: 7000
				},
				timings: { planTimeMs: 1 },
				comparison: {
					apart: {
						willBuild: 7,
						willSubstitute: 22,
						downloadSize: 2200,
						narSize: 11_000
					},
					together: {
						willBuild: 5,
						willSubstitute: 15,
						downloadSize: 1500,
						narSize: 7000
					},
					saved: {
						willBuild: 2,
						willSubstitute: 7,
						downloadSize: 700,
						narSize: 4000
					}
				}
			}
		});
	});

	it('seeds every derivation before planning anything', async () => {
		const planner = new ScriptedPlanner(
			{ app: appDrv, tool: toolDrv },
			{
				[appInstallable]: partition({
					willBuild: 0,
					willSubstitute: 0,
					downloadSize: 0,
					narSize: 0
				}),
				[toolInstallable]: partition({
					willBuild: 0,
					willSubstitute: 0,
					downloadSize: 0,
					narSize: 0
				}),
				[groupInstallables]: partition({
					willBuild: 0,
					willSubstitute: 0,
					downloadSize: 0,
					narSize: 0
				})
			}
		);

		await measureRealisation({
			flake: '.',
			substituters: [],
			targets: [app, tool],
			planner,
			now: steppingClock()
		});

		expect({
			seeded: planner.seeded,
			plans: planner.plans.map((recorded) => recorded.installables)
		}).toStrictEqual({
			seeded: [appDrv, toolDrv],
			plans: [
				[appInstallable],
				[toolInstallable],
				[appInstallable, toolInstallable],
				[appInstallable, toolInstallable]
			]
		});
	});

	it('omits group measurements when the manifest has one target', async () => {
		const planner = new ScriptedPlanner(
			{ app: appDrv },
			{
				[appInstallable]: partition({
					willBuild: 1,
					willSubstitute: 2,
					downloadSize: 30,
					narSize: 40
				})
			}
		);

		const report = await measureRealisation({
			flake: '.',
			substituters: [],
			targets: [unlabelledApp],
			planner,
			now: steppingClock()
		});

		expect({ groups: report.groups, combined: report.combined }).toStrictEqual({
			groups: [],
			combined: undefined
		});
	});
});

describe('sumMeasurements', () => {
	it('totals only the budgeted metrics', () => {
		expect(
			sumMeasurements([
				{
					willBuild: 1,
					willSubstitute: 2,
					unknown: 3,
					downloadSize: 4,
					narSize: 5
				},
				{
					willBuild: 10,
					willSubstitute: 20,
					unknown: 30,
					downloadSize: 40,
					narSize: 50
				}
			])
		).toStrictEqual({
			willBuild: 11,
			willSubstitute: 22,
			downloadSize: 44,
			narSize: 55
		});
	});
});
