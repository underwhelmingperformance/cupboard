import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
	type StorePathBasename,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import type { ReporterResultEvent } from '@cupboard/reporter';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	buildCohortAction,
	runNixDerivationShow
} from '../../actions/src/commands/build-cohort.ts';
import type { runCupboard } from '../../actions/src/cupboard-run.ts';
import { defaultNixConfigEnvironment } from '../../packages/nix/src/store-config.ts';
import { makeWritable, temporaryRoot } from '../support/filesystem.ts';
import { isolatedEnvironment } from '../support/nix.ts';

interface Fixture {
	readonly root: string;
	readonly source: string;
	readonly planStoreRoot: string;
	readonly cohortStoreRoot: string;
	readonly planEnvironment: NodeJS.ProcessEnv;
	readonly cohortEnvironment: NodeJS.ProcessEnv;
}

const state: { fixture?: Fixture; hostEnvironment?: NodeJS.ProcessEnv } = {};

const isNixPresent =
	spawnSync('nix', ['--version'], { stdio: 'ignore' }).status === 0;

function fixture(): Fixture {
	const prepared = state.fixture;

	if (prepared === undefined) {
		throw new Error('The cohort job boundary fixture was not prepared');
	}

	return prepared;
}

function replaceProcessEnvironment(environment: NodeJS.ProcessEnv): void {
	for (const name of Object.keys(process.env)) {
		Reflect.deleteProperty(process.env, name);
	}

	Object.assign(process.env, environment);
}

function system(): string {
	const value = defaultNixConfigEnvironment.currentSystem();

	if (value === undefined) {
		throw new Error('Nix did not report a current system');
	}

	return value;
}

function absoluteDerivation(
	reported: StorePathBasename | StorePathString
): StorePathString {
	return storePathSchema.parse(
		reported.startsWith('/') ? reported : `/nix/store/${reported}`
	);
}

function storeFile(root: string, storePath: StorePathString): string {
	return path.join(root, storePath);
}

async function exists(file: string): Promise<boolean> {
	try {
		await access(file);
		return true;
	} catch {
		return false;
	}
}

beforeAll(async () => {
	if (!isNixPresent) {
		return;
	}

	state.hostEnvironment = { ...process.env };

	const root = await mkdtemp(
		path.join(temporaryRoot, 'cupboard-cohort-job-boundary-')
	);
	const source = path.join(root, 'source');
	const planStoreRoot = path.join(root, 'plan-store');
	const cohortStoreRoot = path.join(root, 'cohort-store');
	const planHome = path.join(root, 'plan-home');
	const cohortHome = path.join(root, 'cohort-home');
	await mkdir(source, { recursive: true });
	await mkdir(planStoreRoot, { recursive: true });
	await mkdir(cohortStoreRoot, { recursive: true });
	await writeFile(
		path.join(source, 'flake.nix'),
		`{
  outputs = { self }: {
    packages.${system()}.default = derivation {
      name = "cupboard-cohort-job-boundary";
      system = "${system()}";
      builder = "/bin/sh";
      args = [ "-c" "mkdir -p $out; echo boundary > $out/result" ];
    };
  };
}
`
	);

	const planEnvironment = {
		...(await isolatedEnvironment(planHome)),
		NIX_REMOTE: `local?root=${planStoreRoot}`
	};
	const cohortEnvironment = {
		...(await isolatedEnvironment(cohortHome)),
		NIX_REMOTE: `local?root=${cohortStoreRoot}`
	};

	state.fixture = {
		root,
		source,
		planStoreRoot,
		cohortStoreRoot,
		planEnvironment,
		cohortEnvironment
	};
}, 60_000);

afterAll(async () => {
	const hostEnvironment = state.hostEnvironment;

	if (hostEnvironment !== undefined) {
		replaceProcessEnvironment(hostEnvironment);
	}

	const prepared = state.fixture;

	if (prepared !== undefined) {
		await makeWritable(prepared.root);
		await rm(prepared.root, { force: true, recursive: true });
	}
}, 60_000);

describe.skipIf(!isNixPresent)('cohort job store isolation', () => {
	it('materialises the plan job derivation before querying a fresh cohort store', async () => {
		const prepared = fixture();
		const installable = `path:${prepared.source}#packages.${system()}.default^out`;

		replaceProcessEnvironment(prepared.planEnvironment);
		const planned = await runNixDerivationShow(
			[installable],
			undefined,
			false,
			{ evalStore: `local?root=${prepared.planStoreRoot}` }
		);
		const [reportedDerivation] = planned;

		if (reportedDerivation === undefined || planned.length !== 1) {
			throw new Error(
				`The plan store reported ${String(planned.length)} root derivations`
			);
		}

		const derivation = absoluteDerivation(reportedDerivation);
		const cohortDerivationFile = storeFile(
			prepared.cohortStoreRoot,
			derivation
		);
		expect(await exists(cohortDerivationFile)).toBe(false);

		replaceProcessEnvironment(prepared.cohortEnvironment);
		let wasMaterialisedWhenPlanned = false;
		const planResult: readonly ReporterResultEvent[] = [
			{
				kind: 'plan-cohort',
				data: {
					partition: {
						attachOnly: [],
						publishByReference: [],
						leftUpstream: [],
						alreadyValid: [],
						buildSet: [],
						counts: { willBuild: 0, willSubstitute: 0, unknown: 0 },
						downloadSize: 0,
						narSize: 0,
						unknownCount: 0,
						ceiling: { value: 0, source: 'configured' }
					},
					capacity: { available: 1, capacity: 1, headroom: 0 }
				}
			}
		];
		const runCupboardMock: typeof runCupboard = async () => {
			wasMaterialisedWhenPlanned = await exists(cohortDerivationFile);

			return planResult;
		};
		const runnerTemporary = path.join(prepared.root, 'runner');
		await mkdir(runnerTemporary, { recursive: true });

		await buildCohortAction(
			{
				cohortJson: JSON.stringify({
					key: 'cohort-job-boundary',
					attrs: [`packages.${system()}.default`],
					installables: [installable],
					queryInstallables: [`${derivation}^out`],
					// JSON.stringify writes this undefined entry as null, which is
					// the wire value the cohort schema expects for an unknown path.
					expectedPaths: [undefined],
					roots: ['github:owner/repo/main/cohort-job-boundary'],
					system: system(),
					os: 'local',
					remote: false,
					runsOn: 'local'
				}),
				url: 'https://cache.example.test/t/acme',
				cupboardPath: '/opt/cupboard/cupboard'
			},
			{
				RUNNER_TEMP: runnerTemporary,
				GITHUB_OUTPUT: path.join(runnerTemporary, 'github-output')
			},
			{
				runCupboard: runCupboardMock,
				runNixDerivationShow: (installables, signal, isRecursive) =>
					runNixDerivationShow(installables, signal, isRecursive, {
						evalStore: `local?root=${prepared.cohortStoreRoot}`
					}),
				// The default derivation-root store opens the host's Nix daemon.
				// This test must not touch the host store, so it does not
				// register roots.
				withLocalDerivationRoots: (_derivations, use) => use()
			}
		);

		expect({
			wasMaterialisedWhenPlanned,
			cohortDerivationExists: await exists(cohortDerivationFile)
		}).toStrictEqual({
			wasMaterialisedWhenPlanned: true,
			cohortDerivationExists: true
		});
	}, 60_000);
});
