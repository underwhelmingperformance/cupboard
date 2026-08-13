import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { NixBuildResult, NixDerivedPathString } from '@cupboard/nix';
import {
	storePathBasenameSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { canonicalHref } from '@cupboard/nix-store/url';
import type { Reporter, ReporterResultEvent } from '@cupboard/reporter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runCupboard } from '../cupboard-run.ts';
import {
	CohortPlanCommandError,
	CohortPlanRefusedError,
	CohortPlanResultInvalidError,
	CohortPlanResultMissingError,
	CupboardReportedError,
	InvalidInputError,
	MissingInputError
} from '../errors.ts';
import type { Environment } from '../inputs.ts';

import {
	buildAndRootNixResults,
	buildCohortAction,
	type BuildCohortInputs,
	type BuildCohortOptions,
	cohortReceiptPushArguments,
	nixBuildArguments,
	nixCopyArguments,
	nixDerivationShowArguments,
	parseNixDerivationShow,
	planReprobeArguments,
	remoteBuildSetOptions,
	resolveBuildCohortInputs,
	rootGroups,
	withdrawFromPartition
} from './build-cohort.ts';

const appPath = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app';
const appQueryInstallable =
	'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app.drv^out';
const libraryQueryInstallable =
	'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib.drv^out';
const floatingQueryInstallable =
	'/nix/store/4123456789abcdfghijklmnpqrsvwxyz-float.drv^out';
const libraryBuiltPath = '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib';
const floatingBuiltPath = '/nix/store/4123456789abcdfghijklmnpqrsvwxyz-float';
const referencePath = '/nix/store/5123456789abcdfghijklmnpqrsvwxyz-ref';
const leftUpstreamPath = '/nix/store/6123456789abcdfghijklmnpqrsvwxyz-up';

function derivedPath(value: string): NixDerivedPathString {
	const selection = value.indexOf('^');

	if (selection === -1) {
		return storePathSchema.parse(value);
	}

	const storePath = storePathSchema.parse(value.slice(0, selection));

	return `${storePath}^${value.slice(selection + 1)}`;
}

function remoteResult(
	kind: 'built' | 'substituted' | 'already-valid',
	target = libraryQueryInstallable,
	output = libraryBuiltPath
): NixBuildResult {
	return {
		target: derivedPath(target),
		outcome: {
			kind,
			outputs: { out: storePathSchema.parse(output) }
		},
		timesBuilt: kind === 'built' ? 1 : 0,
		nonDeterministic: false,
		startTime: 1,
		stopTime: 2
	};
}

function remoteFailure(
	target = libraryQueryInstallable,
	kind: 'permanent-failure' | 'dependency-failed' = 'permanent-failure'
): NixBuildResult {
	return {
		target: derivedPath(target),
		outcome: { kind, message: `could not build ${target}` },
		timesBuilt: 0,
		nonDeterministic: false,
		startTime: 1,
		stopTime: 2
	};
}

function cohortObject(
	overrides: Record<string, unknown> = {}
): Record<string, unknown> {
	return {
		key: 'cohort-x86_64-linux-ubuntu-latest-remote-abc123',
		attrs: [
			'.#packages.x86_64-linux.app',
			'.#packages.x86_64-linux.lib',
			'.#packages.x86_64-linux.floating'
		],
		installables: [
			'.#packages.x86_64-linux.app^out',
			'.#packages.x86_64-linux.lib^out',
			'.#packages.x86_64-linux.floating^out'
		],
		queryInstallables: [
			appQueryInstallable,
			libraryQueryInstallable,
			undefined
		],
		expectedPaths: [appPath, undefined, undefined],
		roots: [
			'github:owner/repo/main/app',
			'github:owner/repo/main/lib',
			'github:owner/repo/main/floating'
		],
		system: 'x86_64-linux',
		os: 'ubuntu-latest',
		remote: true,
		runsOn: 'ubuntu-latest',
		...overrides
	};
}

function cohortJson(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify(cohortObject(overrides));
}

function remotelyQueryableCohortJson(
	overrides: Record<string, unknown> = {}
): string {
	return cohortJson({
		queryInstallables: [
			appQueryInstallable,
			libraryQueryInstallable,
			floatingQueryInstallable
		],
		...overrides
	});
}

// Where the cohort's out-links land under a given RUNNER_TEMP: the job
// removes exactly this directory to make the built closure collectable.
function outLinkDirectory(runnerTemporary: string): string {
	return path.join(
		runnerTemporary,
		'cupboard-out-links-cohort-x86_64-linux-ubuntu-latest-remote-abc123'
	);
}

function baseOptions(): BuildCohortOptions {
	return {
		cohortJson: cohortJson(),
		url: 'https://cache.example.test/t/acme',
		cupboardPath: '/opt/cupboard/cupboard'
	};
}

describe('resolveBuildCohortInputs', () => {
	it('parses a cohort-matrix entry into resolved inputs', () => {
		const inputs = resolveBuildCohortInputs(baseOptions(), {
			RUNNER_TEMP: '/tmp'
		});

		expect({
			key: inputs.cohort.key,
			attrs: inputs.cohort.attrs,
			url: inputs.url.href,
			cupboardPath: inputs.cupboardPath,
			cache: inputs.cache,
			reuseView: inputs.reuseView,
			ttl: inputs.ttl,
			readUser: inputs.readUser,
			readPassword: inputs.readPassword,
			store: inputs.store
		}).toStrictEqual({
			key: 'cohort-x86_64-linux-ubuntu-latest-remote-abc123',
			attrs: [
				'.#packages.x86_64-linux.app',
				'.#packages.x86_64-linux.lib',
				'.#packages.x86_64-linux.floating'
			],
			url: 'https://cache.example.test/t/acme',
			cupboardPath: '/opt/cupboard/cupboard',
			cache: '',
			reuseView: '',
			ttl: '',
			readUser: '',
			readPassword: '',
			store: ''
		});
	});

	it('passes the remote store through', () => {
		const inputs = resolveBuildCohortInputs(
			{ ...baseOptions(), store: 'ssh-ng://build@example.test' },
			{ RUNNER_TEMP: '/tmp' }
		);

		expect(inputs.store).toBe('ssh-ng://build@example.test');
	});

	it('requires cohort-json', () => {
		expect(() =>
			resolveBuildCohortInputs(
				{ ...baseOptions(), cohortJson: undefined },
				{ RUNNER_TEMP: '/tmp' }
			)
		).toThrow(MissingInputError);
	});

	it('rejects cohort-json that is not valid JSON', () => {
		expect(() =>
			resolveBuildCohortInputs(
				{ ...baseOptions(), cohortJson: '{not json' },
				{ RUNNER_TEMP: '/tmp' }
			)
		).toThrow(InvalidInputError);
	});

	it('rejects a cohort-matrix entry whose member arrays disagree in length', () => {
		const malformed = cohortJson({ roots: ['github:owner/repo/main/app'] });

		expect(() =>
			resolveBuildCohortInputs(
				{ ...baseOptions(), cohortJson: malformed },
				{ RUNNER_TEMP: '/tmp' }
			)
		).toThrow(InvalidInputError);
	});

	it('requires url', () => {
		expect(() =>
			resolveBuildCohortInputs(
				{ ...baseOptions(), url: undefined },
				{ RUNNER_TEMP: '/tmp' }
			)
		).toThrow(MissingInputError);
	});

	it('requires cupboard-path', () => {
		expect(() =>
			resolveBuildCohortInputs(
				{ ...baseOptions(), cupboardPath: undefined },
				{ RUNNER_TEMP: '/tmp' }
			)
		).toThrow(MissingInputError);
	});

	it.each([
		{ readUser: 'alice', readPassword: undefined },
		{ readUser: undefined, readPassword: 'secret' }
	])(
		'rejects a read credential supplied only half (readUser: $readUser, readPassword: $readPassword)',
		({ readUser, readPassword }) => {
			expect(() =>
				resolveBuildCohortInputs(
					{ ...baseOptions(), readUser, readPassword },
					{ RUNNER_TEMP: '/tmp' }
				)
			).toThrow(InvalidInputError);
		}
	);

	it.each([
		{ maxJobs: '4294967295', accepted: true },
		{ maxJobs: '4294967296', accepted: false }
	])('bounds max-jobs $maxJobs to uint32', ({ maxJobs, accepted }) => {
		const resolve = (): BuildCohortInputs =>
			resolveBuildCohortInputs(
				{ ...baseOptions(), maxJobs },
				{ RUNNER_TEMP: '/tmp' }
			);

		if (accepted) {
			expect(resolve().maxJobs).toBe(maxJobs);
			return;
		}

		expect(resolve).toThrow(InvalidInputError);
	});
});

describe('nixBuildArguments', () => {
	const outLinks = '/tmp/cupboard-out-links-cohort';

	it('keeps the out-links in the directory it is given, with no --no-link', () => {
		expect(
			nixBuildArguments(['.#a^out', '.#b^out'], '', '', outLinks)
		).toStrictEqual([
			'build',
			'--keep-going',
			'--print-out-paths',
			'--out-link',
			'/tmp/cupboard-out-links-cohort/result',
			'--',
			'.#a^out',
			'.#b^out'
		]);
	});

	it('carries an explicit max-jobs through', () => {
		expect(nixBuildArguments(['.#a^out'], '4', '', outLinks)).toStrictEqual([
			'build',
			'--keep-going',
			'--print-out-paths',
			'--out-link',
			'/tmp/cupboard-out-links-cohort/result',
			'--max-jobs',
			'4',
			'--',
			'.#a^out'
		]);
	});

	it('builds into the remote store while evaluating on the runner', () => {
		expect(
			nixBuildArguments(
				['.#a^out'],
				'',
				'ssh-ng://build@example.test',
				outLinks
			)
		).toStrictEqual([
			'build',
			'--keep-going',
			'--print-out-paths',
			'--out-link',
			'/tmp/cupboard-out-links-cohort/result',
			'--store',
			'ssh-ng://build@example.test',
			'--eval-store',
			'auto',
			'--',
			'.#a^out'
		]);
	});
});

describe('nixCopyArguments', () => {
	it('copies the complete local derivation closures to the exact remote store', () => {
		expect(
			nixCopyArguments(
				[
					storePathSchema.parse(
						'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib.drv'
					),
					storePathSchema.parse(
						'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app.drv'
					)
				],
				'ssh-ng://build@example.test?remote-store=/srv/nix'
			)
		).toStrictEqual([
			'copy',
			'--to',
			'ssh-ng://build@example.test?remote-store=/srv/nix',
			'--',
			'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib.drv',
			'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app.drv'
		]);
	});
});

describe('nixDerivationShowArguments', () => {
	it('materialises the complete local derivation graph', () => {
		expect(
			nixDerivationShowArguments([
				'.#packages.x86_64-linux.lib^out',
				'.#packages.x86_64-linux.app^out'
			])
		).toStrictEqual([
			'derivation',
			'show',
			'--recursive',
			'--eval-store',
			'auto',
			'--no-pretty',
			'--',
			'.#packages.x86_64-linux.lib^out',
			'.#packages.x86_64-linux.app^out'
		]);
	});
});

describe('parseNixDerivationShow', () => {
	const appDerivation = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app.drv';
	const libraryDerivation =
		'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib.drv';

	it('resolves the basename keys in the version 4 derivation envelope', () => {
		expect(
			parseNixDerivationShow(
				JSON.stringify({
					version: 4,
					derivations: {
						'3123456789abcdfghijklmnpqrsvwxyz-lib.drv': {},
						'0123456789abcdfghijklmnpqrsvwxyz-app.drv': {}
					}
				})
			)
		).toStrictEqual([
			storePathBasenameSchema.parse('3123456789abcdfghijklmnpqrsvwxyz-lib.drv'),
			storePathBasenameSchema.parse('0123456789abcdfghijklmnpqrsvwxyz-app.drv')
		]);
	});

	it('retains the legacy flat graph with absolute derivation keys', () => {
		expect(
			parseNixDerivationShow(
				JSON.stringify({
					[appDerivation]: {},
					[libraryDerivation]: {}
				})
			)
		).toStrictEqual([
			storePathSchema.parse(appDerivation),
			storePathSchema.parse(libraryDerivation)
		]);
	});
});

describe('remoteBuildSetOptions', () => {
	it.each([
		{ maxJobs: '', expected: { keepGoing: true } },
		{ maxJobs: '0', expected: { keepGoing: true, maxBuildJobs: 0 } },
		{ maxJobs: '3', expected: { keepGoing: true, maxBuildJobs: 3 } }
	])('preserves keep-going and max-jobs $maxJobs', ({ maxJobs, expected }) => {
		expect(remoteBuildSetOptions(maxJobs)).toStrictEqual(expected);
	});
});

describe('buildAndRootNixResults', () => {
	it('keeps mixed failures while rooting every survivor before publication', async () => {
		const results = [
			remoteResult('built'),
			remoteResult('substituted', floatingQueryInstallable, floatingBuiltPath),
			remoteResult('already-valid', appQueryInstallable, appPath),
			remoteFailure(floatingQueryInstallable, 'dependency-failed')
		];
		const events: string[] = [];

		await buildAndRootNixResults(
			{
				buildPathsWithResults: (targets) => {
					events.push(`build ${targets.join(' ')}`);

					return Promise.resolve(results);
				},
				addTempRoot: (storePath) => {
					events.push(`root ${storePath}`);

					return Promise.resolve();
				}
			},
			[derivedPath(libraryQueryInstallable)],
			(builds) => {
				events.push(`publish ${String(builds.length)}`);

				return Promise.resolve();
			}
		);

		expect(events).toStrictEqual([
			`build ${libraryQueryInstallable}`,
			`root ${appPath}`,
			`root ${libraryBuiltPath}`,
			`root ${floatingBuiltPath}`,
			'publish 4'
		]);
	});

	it('refuses an all-failed batch without rooting or publishing', async () => {
		const events: string[] = [];
		const run = buildAndRootNixResults(
			{
				buildPathsWithResults: () =>
					Promise.resolve([
						remoteFailure(),
						remoteFailure(floatingQueryInstallable, 'dependency-failed')
					]),
				addTempRoot: (storePath) => {
					events.push(`root ${storePath}`);

					return Promise.resolve();
				}
			},
			[
				derivedPath(libraryQueryInstallable),
				derivedPath(floatingQueryInstallable)
			],
			() => {
				events.push('publish');

				return Promise.resolve();
			}
		);

		await expect(run).rejects.toMatchObject({
			name: 'RemoteCohortBuildFailedError',
			failures: [
				{
					target: derivedPath(libraryQueryInstallable),
					outcome: 'permanent-failure',
					message: `could not build ${libraryQueryInstallable}`
				},
				{
					target: derivedPath(floatingQueryInstallable),
					outcome: 'dependency-failed',
					message: `could not build ${floatingQueryInstallable}`
				}
			]
		});
		expect(events).toStrictEqual([]);
	});
});

function parseJson(text: string): unknown {
	return JSON.parse(text);
}

const measuredCapacity = { available: 1000, capacity: 2000, headroom: 100 };

function planCohortSuccess(
	capacity: unknown = measuredCapacity,
	buildSet: readonly string[] = [libraryQueryInstallable]
): readonly ReporterResultEvent[] {
	return [
		{
			kind: 'plan-cohort',
			data: {
				partition: {
					attachOnly: [appPath],
					publishByReference: [referencePath],
					leftUpstream: [leftUpstreamPath],
					alreadyValid: [appPath],
					buildSet,
					counts: { willBuild: 1, willSubstitute: 0, unknown: 0 },
					downloadSize: 100,
					narSize: 200,
					unknownCount: 0,
					ceiling: { value: 5, source: 'configured' }
				},
				capacity
			}
		}
	];
}

function planReprobeSuccess(
	withdrawn: readonly Record<string, unknown>[] = [],
	buildSet: readonly string[] = [libraryQueryInstallable]
): readonly ReporterResultEvent[] {
	return [{ kind: 'plan-reprobe', data: { buildSet, withdrawn } }];
}

// Answers each cupboard invocation with the results that command reports, so a
// test drives the plan and the confirmation that follows it independently.
function cupboardStub(
	answers: {
		readonly plan?: readonly ReporterResultEvent[];
		readonly reprobe?: readonly ReporterResultEvent[];
	} = {}
): typeof runCupboard {
	return (_binaryPath, arguments_) => {
		if (arguments_[1] !== 'plan') {
			return Promise.resolve([]);
		}

		return Promise.resolve(
			arguments_[2] === 'cohort'
				? (answers.plan ?? planCohortSuccess())
				: (answers.reprobe ?? planReprobeSuccess())
		);
	};
}

function noop(): void {
	/* test double: nothing to record */
}

// Every reporter call a test double records, so an assertion sees exactly what
// a run said rather than only what it produced.
function recordingReporter(warnings: string[]): Reporter {
	return {
		phase: (_label, body) => Promise.resolve(body({ fact: noop, warn: noop })),
		progress: (_label, _options, body) =>
			Promise.resolve(body({ advance: noop, fact: noop, warn: noop })),
		steps: (_label, body) =>
			Promise.resolve(
				body({
					message: noop,
					group: () => ({ message: noop, success: noop, error: noop }),
					warn: noop
				})
			),
		result: noop,
		data: noop,
		warn(label) {
			warnings.push(label);
		},
		info: noop,
		success: noop,
		step: noop,
		error: noop
	};
}

describe('buildCohortAction', () => {
	let directory: string;
	let environment: Environment;

	beforeEach(async () => {
		directory = await mkdtemp(path.join(tmpdir(), 'cupboard-build-cohort-'));
		environment = { RUNNER_TEMP: directory, GITHUB_OUTPUT: '' };
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it('drives the partition from a single plan-cohort invocation and writes structural outputs', async () => {
		const runCupboardMock = vi.fn<typeof runCupboard>(cupboardStub());
		const runNixBuild = vi.fn(() =>
			Promise.resolve([libraryBuiltPath, floatingBuiltPath])
		);

		await buildCohortAction(baseOptions(), environment, {
			runCupboard: runCupboardMock,
			runNixBuild
		});

		expect(runCupboardMock).toHaveBeenCalledTimes(1);

		const call = runCupboardMock.mock.calls[0];

		if (call === undefined) {
			throw new Error('runCupboard was not called');
		}

		const [binaryPath, arguments_, passedEnvironment] = call;
		const targetsFileIndex = arguments_.indexOf('--targets-file');
		const targetsFile = arguments_[targetsFileIndex + 1] ?? '';
		const targetsFileContents = await readFile(targetsFile, 'utf8');

		expect({
			binaryPath,
			passedEnvironment,
			argumentsWithoutFilePaths: arguments_.filter(
				(value) => !value.startsWith(directory)
			),
			targetsFile: parseJson(targetsFileContents)
		}).toStrictEqual({
			binaryPath: '/opt/cupboard/cupboard',
			passedEnvironment: environment,
			argumentsWithoutFilePaths: [
				'--no-colour',
				'plan',
				'cohort',
				canonicalHref(new URL('https://cache.example.test/t/acme')),
				'--targets-file',
				'--plan-file',
				'--github-oidc'
			],
			targetsFile: {
				targets: [
					{
						attr: '.#packages.x86_64-linux.app',
						installable: appQueryInstallable,
						expectedPath: appPath,
						root: 'github:owner/repo/main/app'
					},
					{
						attr: '.#packages.x86_64-linux.lib',
						installable: libraryQueryInstallable,
						root: 'github:owner/repo/main/lib'
					}
				]
			}
		});

		expect(runNixBuild).toHaveBeenCalledExactlyOnceWith(
			[libraryQueryInstallable, '.#packages.x86_64-linux.floating^out'],
			'',
			'',
			outLinkDirectory(directory)
		);

		const inputs = resolveBuildCohortInputs(baseOptions(), environment);
		const targetPathsRaw = await readFile(inputs.targetPathsFile, 'utf8');
		const intermediatePathsRaw = await readFile(
			inputs.intermediatePathsFile,
			'utf8'
		);
		const referencePathsRaw = await readFile(inputs.referencePathsFile, 'utf8');
		const leftUpstreamRaw = await readFile(inputs.leftUpstreamFile, 'utf8');
		const countsRaw = await readFile(inputs.countsFile, 'utf8');

		expect({
			targetPaths: targetPathsRaw.trim(),
			intermediatePaths: intermediatePathsRaw,
			referencePaths: referencePathsRaw.trim(),
			leftUpstream: parseJson(leftUpstreamRaw),
			counts: parseJson(countsRaw)
		}).toStrictEqual({
			targetPaths: [appPath, floatingBuiltPath, libraryBuiltPath]
				.toSorted((left, right) => left.localeCompare(right))
				.join('\n'),
			intermediatePaths: '',
			referencePaths: referencePath,
			leftUpstream: { leftUpstream: [leftUpstreamPath] },
			counts: {
				partition: {
					counts: { willBuild: 1, willSubstitute: 0, unknown: 0 },
					downloadSize: 100,
					narSize: 200,
					unknownCount: 0,
					ceiling: { value: 5, source: 'configured' }
				},
				capacity: measuredCapacity
			}
		});
	});

	it.each([
		{
			name: "no store keeps the plan and the build in this runner's store",
			store: undefined,
			planStoreArguments: [],
			buildStore: '',
			capacity: measuredCapacity
		},
		{
			name: 'a remote store reaches the plan and the build',
			store: 'ssh-ng://build@example.test',
			planStoreArguments: ['--store', 'ssh-ng://build@example.test'],
			buildStore: 'ssh-ng://build@example.test',
			capacity: { skipped: 'remote-store' }
		}
	])('$name', async ({ store, planStoreArguments, buildStore, capacity }) => {
		const runCupboardMock = vi.fn<typeof runCupboard>(
			cupboardStub({ plan: planCohortSuccess(capacity) })
		);
		const runNixBuild = vi.fn(() =>
			Promise.resolve([libraryBuiltPath, floatingBuiltPath])
		);
		const options: BuildCohortOptions = {
			...baseOptions(),
			...(store !== undefined && { store })
		};

		await buildCohortAction(options, environment, {
			runCupboard: runCupboardMock,
			runNixBuild
		});

		const call = runCupboardMock.mock.calls[0];

		if (call === undefined) {
			throw new Error('runCupboard was not called');
		}

		const [, arguments_] = call;

		expect(
			arguments_.filter((value) => !value.startsWith(directory))
		).toStrictEqual([
			'--no-colour',
			'plan',
			'cohort',
			canonicalHref(new URL('https://cache.example.test/t/acme')),
			'--targets-file',
			'--plan-file',
			'--github-oidc',
			...planStoreArguments
		]);
		expect(runNixBuild).toHaveBeenCalledExactlyOnceWith(
			[libraryQueryInstallable, '.#packages.x86_64-linux.floating^out'],
			'',
			buildStore,
			outLinkDirectory(directory)
		);

		const inputs = resolveBuildCohortInputs(options, environment);

		expect(JSON.parse(await readFile(inputs.countsFile, 'utf8'))).toStrictEqual(
			{
				partition: {
					counts: { willBuild: 1, willSubstitute: 0, unknown: 0 },
					downloadSize: 100,
					narSize: 200,
					unknownCount: 0,
					ceiling: { value: 5, source: 'configured' }
				},
				capacity
			}
		);
	});

	it('skips the plan-cohort invocation when no member evaluated', async () => {
		const unevaluated = cohortJson({
			queryInstallables: [undefined, undefined, undefined],
			expectedPaths: [undefined, undefined, undefined]
		});
		const runCupboardMock = vi.fn<typeof runCupboard>(cupboardStub());
		const runNixBuild = vi.fn(() => Promise.resolve([]));

		await buildCohortAction(
			{ ...baseOptions(), cohortJson: unevaluated },
			environment,
			{ runCupboard: runCupboardMock, runNixBuild }
		);

		expect(runCupboardMock).not.toHaveBeenCalled();
		expect(runNixBuild).toHaveBeenCalledExactlyOnceWith(
			[
				'.#packages.x86_64-linux.app^out',
				'.#packages.x86_64-linux.lib^out',
				'.#packages.x86_64-linux.floating^out'
			],
			'',
			'',
			outLinkDirectory(directory)
		);
	});

	it('propagates a ceiling refusal with the reported numbers', async () => {
		const refusalEvents: readonly ReporterResultEvent[] = [
			{
				kind: 'plan-cohort-refusal',
				data: {
					reason: 'unknown-paths-ceiling',
					unknownCount: 7,
					ceiling: { value: 5, source: 'configured' },
					downloadSize: 111,
					narSize: 222
				}
			}
		];
		const runCupboardMock = vi.fn<typeof runCupboard>(() =>
			Promise.reject(
				new CupboardReportedError(75, refusalEvents, undefined, true)
			)
		);
		const runNixBuild = vi.fn(() => Promise.resolve([]));

		let error: unknown;

		try {
			await buildCohortAction(baseOptions(), environment, {
				runCupboard: runCupboardMock,
				runNixBuild
			});
		} catch (error_: unknown) {
			error = error_;
		}

		expect(error).toBeInstanceOf(CohortPlanRefusedError);

		if (!(error instanceof CohortPlanRefusedError)) {
			return;
		}

		expect({
			exitCode: error.exitCode,
			message: error.message
		}).toStrictEqual({
			exitCode: 75,
			message:
				'7 path(s) have unknown availability, over the configured ceiling ' +
				'of 5 (111 download byte(s), 222 NAR byte(s))'
		});
		expect(runNixBuild).not.toHaveBeenCalled();
	});

	it('propagates a store-capacity refusal with the measured numbers', async () => {
		const refusalEvents: readonly ReporterResultEvent[] = [
			{
				kind: 'plan-cohort-refusal',
				data: {
					reason: 'store-capacity',
					measured: { downloadSize: 5, narSize: 1000, unknownCount: 0 },
					available: 100,
					headroom: 20,
					detected: {
						cohortSplitPossible: false,
						remoteStoreConfigured: false,
						componentPublicationApplicable: false
					}
				}
			}
		];
		const runCupboardMock = vi.fn<typeof runCupboard>(() =>
			Promise.reject(
				new CupboardReportedError(69, refusalEvents, undefined, true)
			)
		);
		const runNixBuild = vi.fn(() => Promise.resolve([]));

		let error: unknown;

		try {
			await buildCohortAction(baseOptions(), environment, {
				runCupboard: runCupboardMock,
				runNixBuild
			});
		} catch (error_: unknown) {
			error = error_;
		}

		expect(error).toBeInstanceOf(CohortPlanRefusedError);

		if (!(error instanceof CohortPlanRefusedError)) {
			return;
		}

		expect({
			exitCode: error.exitCode,
			message: error.message
		}).toStrictEqual({
			exitCode: 69,
			message:
				'measured 1000 substitutable NAR byte(s) against 100 available ' +
				'byte(s) with a 20 byte headroom'
		});
	});

	it('wraps a plan-cohort failure with no refusal event as a command error', async () => {
		const runCupboardMock = vi.fn<typeof runCupboard>(() =>
			Promise.reject(new CupboardReportedError(1, [], undefined, true))
		);
		const runNixBuild = vi.fn(() => Promise.resolve([]));

		await expect(
			buildCohortAction(baseOptions(), environment, {
				runCupboard: runCupboardMock,
				runNixBuild
			})
		).rejects.toBeInstanceOf(CohortPlanCommandError);
	});

	it('fails when cupboard records no plan-cohort result on success', async () => {
		const runCupboardMock = vi.fn<typeof runCupboard>(() =>
			Promise.resolve([])
		);
		const runNixBuild = vi.fn(() => Promise.resolve([]));

		await expect(
			buildCohortAction(baseOptions(), environment, {
				runCupboard: runCupboardMock,
				runNixBuild
			})
		).rejects.toBeInstanceOf(CohortPlanResultMissingError);
	});

	it('refuses a plan build set entry that is not a Nix derived path', async () => {
		const runCupboardMock = vi.fn<typeof runCupboard>(
			cupboardStub({
				plan: planCohortSuccess(measuredCapacity, ['.#packages.bad'])
			})
		);

		await expect(
			buildCohortAction(baseOptions(), environment, {
				runCupboard: runCupboardMock,
				runNixBuild: vi.fn(() => Promise.resolve([]))
			})
		).rejects.toBeInstanceOf(CohortPlanResultInvalidError);
	});
});

// The cohort every re-probe test drives: both queryable members carry an
// expected output, so the confirmation has something to ask about.
function predictableCohort(): string {
	return cohortJson({ expectedPaths: [appPath, libraryBuiltPath, undefined] });
}

function withdrawal(outcome: string): Record<string, unknown> {
	return {
		installable: libraryQueryInstallable,
		storePath: libraryBuiltPath,
		outcome
	};
}

describe('buildCohortAction availability confirmation', () => {
	let directory: string;
	let environment: Environment;

	beforeEach(async () => {
		directory = await mkdtemp(path.join(tmpdir(), 'cupboard-build-cohort-'));
		environment = { RUNNER_TEMP: directory, GITHUB_OUTPUT: '' };
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	interface ConfirmedRun {
		readonly targetsFile: unknown;
		readonly built: readonly (readonly unknown[])[];
		readonly targetPaths: readonly string[];
		readonly referencePaths: readonly string[];
		readonly leftUpstream: unknown;
		readonly counts: unknown;
		readonly warnings: readonly string[];
	}

	async function runConfirmedCohort(
		reprobe: readonly ReporterResultEvent[] | Error
	): Promise<ConfirmedRun> {
		const warnings: string[] = [];
		const runCupboardMock = vi.fn<typeof runCupboard>(
			(binaryPath, arguments_) =>
				reprobe instanceof Error && arguments_[2] === 'reprobe'
					? Promise.reject(reprobe)
					: cupboardStub({
							...(!(reprobe instanceof Error) && { reprobe })
						})(binaryPath, arguments_, environment)
		);
		// Nix prints an out-path for each installable it was actually given, so a
		// withdrawn target contributes nothing to the built set.
		const builtPathOf = new Map([
			[libraryQueryInstallable, libraryBuiltPath],
			['.#packages.x86_64-linux.floating^out', floatingBuiltPath]
		]);
		const runNixBuild = vi.fn((installables: readonly string[]) =>
			Promise.resolve(
				installables.flatMap((installable) => {
					const built = builtPathOf.get(installable);

					return built === undefined ? [] : [built];
				})
			)
		);
		const options: BuildCohortOptions = {
			...baseOptions(),
			cohortJson: predictableCohort()
		};

		await buildCohortAction(options, environment, {
			runCupboard: runCupboardMock,
			runNixBuild,
			reporter: recordingReporter(warnings)
		});

		const inputs = resolveBuildCohortInputs(options, environment);
		const targetsPath = path.join(
			directory,
			`cupboard-plan-reprobe-targets-${inputs.cohort.key}.json`
		);
		let targetsFile: unknown;

		try {
			targetsFile = parseJson(await readFile(targetsPath, 'utf8'));
		} catch {
			targetsFile = undefined;
		}

		const linesIn = async (file: string): Promise<readonly string[]> => {
			const contents = await readFile(file, 'utf8');

			return contents.split('\n').filter((line) => line !== '');
		};

		return {
			targetsFile,
			built: runNixBuild.mock.calls,
			targetPaths: await linesIn(inputs.targetPathsFile),
			referencePaths: await linesIn(inputs.referencePathsFile),
			leftUpstream: parseJson(await readFile(inputs.leftUpstreamFile, 'utf8')),
			counts: parseJson(await readFile(inputs.countsFile, 'utf8')),
			warnings
		};
	}

	it('asks only about the build set members whose output it can name', async () => {
		const run = await runConfirmedCohort(planReprobeSuccess());

		expect(run.targetsFile).toStrictEqual({
			targets: [
				{
					attr: '.#packages.x86_64-linux.lib',
					installable: libraryQueryInstallable,
					expectedPath: libraryBuiltPath,
					root: 'github:owner/repo/main/lib'
				}
			]
		});
	});

	it.each([
		{
			outcome: 'attachOnly',
			targetPaths: [appPath, floatingBuiltPath, libraryBuiltPath],
			referencePaths: [referencePath]
		},
		{
			outcome: 'publishByReference',
			targetPaths: [appPath, floatingBuiltPath],
			referencePaths: [referencePath, libraryBuiltPath]
		}
	])(
		'withdraws a $outcome target from the build set and records it',
		async ({ outcome, targetPaths, referencePaths }) => {
			const run = await runConfirmedCohort(
				planReprobeSuccess([withdrawal(outcome)], [])
			);

			expect({
				built: run.built,
				targetPaths: run.targetPaths.toSorted((left, right) =>
					left.localeCompare(right)
				),
				referencePaths: run.referencePaths,
				leftUpstream: run.leftUpstream,
				withdrawn: run.counts,
				warnings: run.warnings
			}).toStrictEqual({
				built: [
					[
						['.#packages.x86_64-linux.floating^out'],
						'',
						'',
						outLinkDirectory(directory)
					]
				],
				targetPaths: targetPaths.toSorted((left, right) =>
					left.localeCompare(right)
				),
				referencePaths,
				leftUpstream: { leftUpstream: [leftUpstreamPath] },
				withdrawn: {
					partition: {
						counts: { willBuild: 1, willSubstitute: 0, unknown: 0 },
						downloadSize: 100,
						narSize: 200,
						unknownCount: 0,
						ceiling: { value: 5, source: 'configured' }
					},
					capacity: measuredCapacity,
					reprobe: { withdrawn: [withdrawal(outcome)] }
				},
				warnings: []
			});
		}
	);

	it.each([
		{
			name: 'the confirmation command fails',
			reprobe: new CupboardReportedError(1, [], undefined, true)
		},
		{ name: 'the confirmation reports no result', reprobe: [] },
		{
			name: 'the confirmation reports a result it cannot read',
			reprobe: [{ kind: 'plan-reprobe', data: { withdrawn: 'all of them' } }]
		},
		{
			// A cupboard old enough to leave a target upstream from the
			// confirmation names an outcome this action places nowhere, and
			// building the target publishes what a consumer could not fetch.
			name: 'the confirmation withdraws a target to an outcome it cannot place',
			reprobe: planReprobeSuccess([withdrawal('leftUpstream')], [])
		}
	] satisfies readonly {
		readonly name: string;
		readonly reprobe: readonly ReporterResultEvent[] | Error;
	}[])('builds the whole build set when $name', async ({ reprobe }) => {
		const run = await runConfirmedCohort(reprobe);

		expect({
			built: run.built,
			counts: run.counts,
			warnings: run.warnings.length
		}).toStrictEqual({
			built: [
				[
					[libraryQueryInstallable, '.#packages.x86_64-linux.floating^out'],
					'',
					'',
					outLinkDirectory(directory)
				]
			],
			counts: {
				partition: {
					counts: { willBuild: 1, willSubstitute: 0, unknown: 0 },
					downloadSize: 100,
					narSize: 200,
					unknownCount: 0,
					ceiling: { value: 5, source: 'configured' }
				},
				capacity: measuredCapacity
			},
			warnings: 1
		});
	});
});

describe('planReprobeArguments', () => {
	const url = new URL('https://cache.example.test/t/acme');

	it.each([
		{
			name: 'a public cache on this runner asks for nothing more',
			inputs: {
				cache: '',
				reuseView: '',
				readUser: '',
				readPassword: ''
			},
			extra: []
		},
		{
			name: 'a named cache, view and credential all travel',
			inputs: {
				cache: 'builds',
				reuseView: 'pr-view',
				readUser: 'reader',
				readPassword: 'secret'
			},
			extra: [
				'--cache',
				'builds',
				'--reuse-view',
				'pr-view',
				'--read-user',
				'reader',
				'--read-password',
				'secret'
			]
		}
	])('$name', ({ inputs, extra }) => {
		expect(
			planReprobeArguments({ url, ...inputs }, '/tmp/targets.json')
		).toStrictEqual([
			'--no-colour',
			'plan',
			'reprobe',
			canonicalHref(url),
			'--targets-file',
			'/tmp/targets.json',
			...extra
		]);
	});
});

describe('cohortReceiptPushArguments', () => {
	const url = new URL('https://cache.example.test/t/acme');
	const paths = [appPath, libraryBuiltPath];

	it.each([
		{
			name: 'a public default cache asks for nothing more',
			inputs: {
				audience: '',
				cache: '',
				runRoot: '',
				runRootTtl: ''
			},
			alreadyHeld: [],
			held: ['--no-already-held'],
			claimable: [],
			evidence: ['--no-claimable'],
			extra: []
		},
		{
			name: 'a path the store already held is named as claimed by nothing',
			inputs: {
				audience: '',
				cache: '',
				runRoot: '',
				runRootTtl: ''
			},
			alreadyHeld: [libraryBuiltPath],
			held: ['--already-held', libraryBuiltPath],
			claimable: [libraryBuiltPath],
			evidence: ['--claimable', libraryBuiltPath],
			extra: []
		},
		{
			name: 'the audience, cache and run root all travel',
			inputs: {
				audience: 'https://cache.example.test',
				cache: 'builds',
				runRoot: 'github:owner/repo/_cupboard-run/1',
				runRootTtl: '2d'
			},
			extra: [
				'--audience',
				'https://cache.example.test',
				'--cache',
				'builds',
				'--run-root',
				'github:owner/repo/_cupboard-run/1',
				'--run-root-ttl',
				'2d'
			],
			alreadyHeld: [],
			held: ['--no-already-held'],
			claimable: [],
			evidence: ['--no-claimable']
		}
	])('$name', ({ inputs, alreadyHeld, held, claimable, evidence, extra }) => {
		expect(
			cohortReceiptPushArguments(
				{
					url,
					store: 'ssh-ng://build@example.test',
					receiptFile: '/tmp/receipt.json',
					...inputs
				},
				paths,
				alreadyHeld,
				claimable
			)
		).toStrictEqual([
			'--no-colour',
			'push',
			canonicalHref(url),
			...paths,
			'--github-oidc',
			'--no-retain',
			'--store',
			'ssh-ng://build@example.test',
			'--receipt-file',
			'/tmp/receipt.json',
			...held,
			...evidence,
			...extra
		]);
	});
});

describe('withdrawFromPartition', () => {
	const partition = {
		attachOnly: [appPath],
		publishByReference: [referencePath],
		leftUpstream: [leftUpstreamPath],
		alreadyValid: [appPath],
		buildSet: [
			derivedPath(libraryQueryInstallable),
			derivedPath(appQueryInstallable)
		],
		counts: { willBuild: 2, willSubstitute: 0, unknown: 0 },
		downloadSize: 100,
		narSize: 200,
		unknownCount: 0,
		ceiling: { value: 5 as number, source: 'configured' as const }
	};

	it('returns the partition untouched when nothing was withdrawn', () => {
		expect(withdrawFromPartition(partition, [])).toBe(partition);
	});

	it('moves every withdrawn target out of the build set at once', () => {
		expect(
			withdrawFromPartition(partition, [
				{
					installable: libraryQueryInstallable,
					storePath: storePathSchema.parse(libraryBuiltPath),
					outcome: 'attachOnly'
				},
				{
					installable: appQueryInstallable,
					storePath: storePathSchema.parse(floatingBuiltPath),
					outcome: 'publishByReference'
				}
			])
		).toStrictEqual({
			...partition,
			attachOnly: [appPath, libraryBuiltPath],
			publishByReference: [referencePath, floatingBuiltPath],
			buildSet: []
		});
	});
});

describe('rootGroups', () => {
	const members = [
		{
			attr: 'app',
			installable: '.#app^out',
			expectedPath: appPath,
			root: 'github:owner/repo/main/app'
		},
		{
			attr: 'lib',
			installable: '.#lib^out',
			expectedPath: libraryBuiltPath,
			root: 'github:owner/repo/main/lib'
		},
		{
			attr: 'floating',
			installable: '.#floating^out',
			root: 'github:owner/repo/main/app'
		}
	];

	it.each([
		{
			name: 'assigns each expected path to its own root',
			roots: [
				'github:owner/repo/main/app',
				'github:owner/repo/main/lib',
				'github:owner/repo/main/app'
			],
			targetPaths: [appPath, libraryBuiltPath],
			expected: [
				{ root: 'github:owner/repo/main/app', paths: [appPath] },
				{ root: 'github:owner/repo/main/lib', paths: [libraryBuiltPath] }
			]
		},
		{
			name: 'sends a path with no expected match to the first root',
			roots: [
				'github:owner/repo/main/app',
				'github:owner/repo/main/lib',
				'github:owner/repo/main/app'
			],
			targetPaths: [appPath, libraryBuiltPath, floatingBuiltPath],
			expected: [
				{
					root: 'github:owner/repo/main/app',
					paths: [appPath, floatingBuiltPath]
				},
				{ root: 'github:owner/repo/main/lib', paths: [libraryBuiltPath] }
			]
		},
		{
			name: 'drops a root with no paths of its own',
			roots: [
				'github:owner/repo/main/app',
				'github:owner/repo/main/lib',
				'github:owner/repo/main/app'
			],
			targetPaths: [appPath],
			expected: [{ root: 'github:owner/repo/main/app', paths: [appPath] }]
		},
		{
			name: 'yields nothing for an empty cohort',
			roots: [],
			targetPaths: [],
			expected: []
		}
	])('$name', ({ roots, targetPaths, expected }) => {
		expect(rootGroups(members, roots, targetPaths)).toStrictEqual(expected);
	});
});

describe('buildCohortAction publication', () => {
	const cohortKey = 'cohort-x86_64-linux-ubuntu-latest-remote-abc123';
	const url = canonicalHref(new URL('https://cache.example.test/t/acme'));
	let directory: string;
	let environment: Environment;

	beforeEach(async () => {
		directory = await mkdtemp(path.join(tmpdir(), 'cupboard-build-cohort-'));
		environment = {
			RUNNER_TEMP: directory,
			GITHUB_OUTPUT: path.join(directory, 'github-output')
		};
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	interface PublicationRun {
		readonly calls: readonly (readonly string[])[];
		readonly receiptLine: string | undefined;
		readonly cohortsFile: unknown;
		readonly nixBuilds: readonly (readonly unknown[])[];
		readonly resultBuilds: readonly (readonly unknown[])[];
		readonly remoteConnection: {
			readonly lifecycle: readonly string[];
			readonly sequence: readonly string[];
			readonly evaluationCalls: readonly (readonly unknown[])[];
			readonly copyCalls: readonly (readonly unknown[])[];
			readonly didEvaluationReceiveSignal: boolean;
			readonly didCopyReceiveSignal: boolean;
			readonly didBuildReceiveSignal: boolean;
			readonly cupboardCalls: readonly {
				readonly command: string | undefined;
				readonly open: boolean;
			}[];
		};
	}

	async function runPublicationFlow(
		options: BuildCohortOptions,
		builtPaths: readonly string[] = [libraryBuiltPath, floatingBuiltPath],
		results: readonly NixBuildResult[] = [remoteResult('built')]
	): Promise<PublicationRun> {
		const calls: (readonly string[])[] = [];
		const lifecycle: string[] = [];
		const sequence: string[] = [];
		const signal = new AbortController().signal;
		const cupboardCalls: {
			readonly command: string | undefined;
			readonly open: boolean;
		}[] = [];
		let isRemoteConnectionOpen = false;
		const runCupboardMock = vi.fn<typeof runCupboard>(
			(_binaryPath, arguments_) => {
				calls.push(arguments_);
				cupboardCalls.push({
					command: arguments_[1],
					open: isRemoteConnectionOpen
				});

				if (isRemoteConnectionOpen && arguments_[1] === 'push') {
					sequence.push('publish');
				}

				return cupboardStub()(_binaryPath, arguments_, environment);
			}
		);
		const runNixBuild = vi.fn(() => Promise.resolve([...builtPaths]));
		let didEvaluationReceiveSignal = false;
		const runNixDerivationShow = vi.fn(
			(_installables: readonly string[], receivedSignal?: AbortSignal) => {
				didEvaluationReceiveSignal = receivedSignal === signal;
				sequence.push('evaluate');

				return Promise.resolve([
					storePathSchema.parse(
						'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib.drv'
					)
				]);
			}
		);
		let didCopyReceiveSignal = false;
		const runNixCopy = vi.fn(
			(
				_installables: readonly string[],
				_store: string,
				receivedSignal?: AbortSignal
			) => {
				didCopyReceiveSignal = receivedSignal === signal;
				sequence.push('copy');

				return Promise.resolve();
			}
		);
		let didBuildReceiveSignal = false;
		const runNixBuildWithResults = vi.fn(
			async (
				_installables: readonly NixDerivedPathString[],
				_maxJobs: string,
				_store: string,
				publish?: (builds: readonly NixBuildResult[]) => Promise<void>,
				receivedSignal?: AbortSignal
			) => {
				if (publish === undefined) {
					throw new Error('Remote build publication callback is missing');
				}

				didBuildReceiveSignal = receivedSignal === signal;
				isRemoteConnectionOpen = true;
				lifecycle.push('opened');
				sequence.push('session');

				try {
					await publish(results);
				} finally {
					isRemoteConnectionOpen = false;
					lifecycle.push('closed');
					sequence.push('closed');
				}
			}
		);

		await buildCohortAction(options, environment, {
			runCupboard: runCupboardMock,
			runNixBuild,
			runNixBuildWithResults,
			runNixDerivationShow,
			runNixCopy,
			signal
		});

		const outputRaw = await readFile(
			path.join(directory, 'github-output'),
			'utf8'
		);
		const cohortsFilePath = path.join(
			directory,
			`cupboard-build-cohorts-${cohortKey}.json`
		);
		let cohortsFile: unknown;
		try {
			cohortsFile = JSON.parse(await readFile(cohortsFilePath, 'utf8'));
		} catch {
			cohortsFile = undefined;
		}

		return {
			calls,
			receiptLine: outputRaw
				.split('\n')
				.find((line) => line.startsWith('receipt-file=')),
			cohortsFile,
			nixBuilds: runNixBuild.mock.calls,
			resultBuilds: runNixBuildWithResults.mock.calls.map((call) =>
				call.slice(0, 3)
			),
			remoteConnection: {
				lifecycle,
				sequence,
				evaluationCalls: runNixDerivationShow.mock.calls,
				copyCalls: runNixCopy.mock.calls,
				didEvaluationReceiveSignal,
				didCopyReceiveSignal,
				didBuildReceiveSignal,
				cupboardCalls
			}
		};
	}

	// The job removes this directory to release the built closure once nothing
	// further reads those paths, so the action has to name it.
	it('reports the directory holding the out-links that root its targets', async () => {
		const outputFile = path.join(directory, 'github-output');
		const runNixBuild = vi.fn(() => Promise.resolve([libraryBuiltPath]));

		await buildCohortAction(baseOptions(), environment, {
			runCupboard: vi.fn<typeof runCupboard>(cupboardStub()),
			runNixBuild
		});

		const outputs = await readFile(outputFile, 'utf8');

		expect(
			outputs
				.split('\n')
				.filter((line) => line.startsWith('out-link-directory='))
		).toStrictEqual([`out-link-directory=${outLinkDirectory(directory)}`]);
	});

	it('streams the build through build-push, then sets each root with one push per group', async () => {
		const runRoot = 'github:owner/repo/_cupboard-run/1';
		const run = await runPublicationFlow({
			...baseOptions(),
			cohortJson: cohortJson({
				expectedPaths: [appPath, libraryBuiltPath, undefined]
			}),
			push: 'true',
			gcBetweenCohorts: 'true',
			reuseView: 'pr-view',
			cache: 'builds',
			ttl: '7d',
			runRoot,
			runRootTtl: '2d',
			maxJobs: '0'
		});

		const receiptFile = path.join(directory, 'cupboard-cohort-receipt.json');
		const referenceFile = path.join(
			directory,
			'cupboard-cohort-reference-paths.txt'
		);
		const cohortsFile = path.join(
			directory,
			`cupboard-build-cohorts-${cohortKey}.json`
		);
		const [plan, reprobe, ...publication] = run.calls;

		expect({
			planCommand: plan?.slice(1, 3),
			reprobe,
			publication,
			cohortsFile: run.cohortsFile,
			nixBuilds: run.nixBuilds,
			receiptLine: run.receiptLine
		}).toStrictEqual({
			planCommand: ['plan', 'cohort'],
			reprobe: [
				'--no-colour',
				'plan',
				'reprobe',
				url,
				'--targets-file',
				path.join(directory, `cupboard-plan-reprobe-targets-${cohortKey}.json`),
				'--cache',
				'builds',
				'--reuse-view',
				'pr-view'
			],
			publication: [
				[
					'--no-colour',
					'build-push',
					url,
					'--github-oidc',
					'--no-retain',
					'--cohorts-file',
					cohortsFile,
					'--receipt-file',
					receiptFile,
					'--cache',
					'builds',
					'--gc-between-cohorts',
					'--run-root',
					runRoot,
					'--run-root-ttl',
					'2d'
				],
				[
					'--no-colour',
					'push',
					url,
					appPath,
					floatingBuiltPath,
					'--github-oidc',
					'--root',
					'github:owner/repo/main/app',
					'--cache',
					'builds',
					'--ttl',
					'7d',
					'--reference-paths-file',
					referenceFile,
					'--reference-source',
					`${url}/reuse/pr-view`,
					'--run-root',
					runRoot,
					'--run-root-ttl',
					'2d'
				],
				[
					'--no-colour',
					'push',
					url,
					libraryBuiltPath,
					'--github-oidc',
					'--root',
					'github:owner/repo/main/lib',
					'--cache',
					'builds',
					'--ttl',
					'7d',
					'--run-root',
					runRoot,
					'--run-root-ttl',
					'2d'
				]
			],
			cohortsFile: {
				cohorts: [
					{
						installables: [
							libraryQueryInstallable,
							'.#packages.x86_64-linux.floating^out'
						],
						verifyRebuilds: true,
						keepGoing: true,
						maxJobs: 0
					}
				]
			},
			nixBuilds: [
				[
					[libraryQueryInstallable, '.#packages.x86_64-linux.floating^out'],
					'0',
					'',
					outLinkDirectory(directory)
				]
			],
			receiptLine: `receipt-file=${receiptFile}`
		});
	});

	it('refuses remote publication when planning left a target without a derived path', async () => {
		const runCupboardMock = vi.fn<typeof runCupboard>(cupboardStub());

		await expect(
			buildCohortAction(
				{
					...baseOptions(),
					push: 'true',
					store: 'ssh-ng://build@example.test'
				},
				environment,
				{ runCupboard: runCupboardMock }
			)
		).rejects.toMatchObject({
			name: 'InvalidInputError',
			input: 'cohort-json',
			message:
				'Remote publication requires a daemon derived path for every build target; the plan did not resolve .#packages.x86_64-linux.floating. Re-run planning with evaluable locked outputs or publish from the local store.'
		});
		expect(runCupboardMock).not.toHaveBeenCalled();
	});

	it('propagates a cancelled derivation copy before opening the build session', async () => {
		const controller = new AbortController();
		const reason = new Error('cancel remote cohort');
		controller.abort(reason);
		const runNixDerivationShow = vi.fn(() =>
			Promise.resolve([
				storePathSchema.parse(
					'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib.drv'
				)
			])
		);
		const runNixCopy = vi.fn(() => Promise.reject(reason));
		const runNixBuildWithResults = vi.fn(() => Promise.resolve());
		const runCupboardMock = vi.fn<typeof runCupboard>(cupboardStub());

		await expect(
			buildCohortAction(
				{
					...baseOptions(),
					cohortJson: remotelyQueryableCohortJson(),
					push: 'true',
					store: 'ssh-ng://build@example.test'
				},
				environment,
				{
					runCupboard: runCupboardMock,
					runNixDerivationShow,
					runNixCopy,
					runNixBuildWithResults,
					signal: controller.signal
				}
			)
		).rejects.toBe(reason);
		expect({
			evaluationCalls: runNixDerivationShow.mock.calls,
			copyCalls: runNixCopy.mock.calls,
			buildCalls: runNixBuildWithResults.mock.calls
		}).toStrictEqual({
			evaluationCalls: [
				[['.#packages.x86_64-linux.lib^out'], controller.signal]
			],
			copyCalls: [
				[
					['/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib.drv'],
					'ssh-ng://build@example.test',
					controller.signal
				]
			],
			buildCalls: []
		});
	});

	it('refuses evaluation drift before copying or opening a build session', async () => {
		const evaluated = storePathSchema.parse(
			'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-other.drv'
		);
		const runNixDerivationShow = vi.fn(() => Promise.resolve([evaluated]));
		const runNixCopy = vi.fn(() => Promise.resolve());
		const runNixBuildWithResults = vi.fn(() => Promise.resolve());
		const runCupboardMock = vi.fn<typeof runCupboard>(cupboardStub());

		await expect(
			buildCohortAction(
				{
					...baseOptions(),
					cohortJson: remotelyQueryableCohortJson(),
					push: 'true',
					store: 'ssh-ng://build@example.test'
				},
				environment,
				{
					runCupboard: runCupboardMock,
					runNixDerivationShow,
					runNixCopy,
					runNixBuildWithResults
				}
			)
		).rejects.toMatchObject({
			name: 'RemoteCohortEvaluationDriftError',
			missing: ['/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib.drv'],
			evaluated: [evaluated]
		});
		expect({
			evaluationCalls: runNixDerivationShow.mock.calls,
			copyCalls: runNixCopy.mock.calls,
			buildCalls: runNixBuildWithResults.mock.calls
		}).toStrictEqual({
			evaluationCalls: [[['.#packages.x86_64-linux.lib^out'], undefined]],
			copyCalls: [],
			buildCalls: []
		});
	});

	it('fails a remote-store cohort whose result batch contains no outputs', async () => {
		await expect(
			runPublicationFlow(
				{
					...baseOptions(),
					cohortJson: remotelyQueryableCohortJson(),
					push: 'true',
					store: 'ssh-ng://build@example.test'
				},
				[],
				[]
			)
		).rejects.toMatchObject({
			name: 'RemoteCohortBuildFailedError',
			failures: [
				{
					target: derivedPath(libraryQueryInstallable),
					outcome: 'no-result',
					message: 'the daemon returned no result for this target'
				}
			]
		});
	});

	it('closes the remote build connection when root publication fails', async () => {
		const failure = new Error('root publication failed');
		const lifecycle: string[] = [];
		let pushes = 0;
		const runCupboardMock = vi.fn<typeof runCupboard>(
			(binaryPath, arguments_) => {
				if (arguments_[1] === 'push') {
					pushes += 1;

					if (pushes === 2) {
						return Promise.reject(failure);
					}
				}

				return cupboardStub()(binaryPath, arguments_, environment);
			}
		);
		const runNixBuildWithResults = vi.fn(
			async (
				_installables: readonly NixDerivedPathString[],
				_maxJobs: string,
				_store: string,
				publish?: (builds: readonly NixBuildResult[]) => Promise<void>
			) => {
				if (publish === undefined) {
					throw new Error('Remote build publication callback is missing');
				}

				lifecycle.push('opened');

				try {
					await publish([remoteResult('built')]);
				} finally {
					lifecycle.push('closed');
				}
			}
		);

		await expect(
			buildCohortAction(
				{
					...baseOptions(),
					cohortJson: remotelyQueryableCohortJson({
						roots: [
							'github:owner/repo/main',
							'github:owner/repo/main',
							'github:owner/repo/main'
						]
					}),
					push: 'true',
					store: 'ssh-ng://build@example.test'
				},
				environment,
				{
					runCupboard: runCupboardMock,
					runNixDerivationShow: vi.fn(() =>
						Promise.resolve([
							storePathSchema.parse(
								'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib.drv'
							)
						])
					),
					runNixCopy: vi.fn(() => Promise.resolve()),
					runNixBuildWithResults
				}
			)
		).rejects.toBe(failure);
		expect({ lifecycle, pushes }).toStrictEqual({
			lifecycle: ['opened', 'closed'],
			pushes: 2
		});
	});

	it('publishes a single-root cohort with one push, no reference source without a reuse view', async () => {
		const run = await runPublicationFlow({
			...baseOptions(),
			cohortJson: cohortJson({
				roots: [
					'github:owner/repo/main',
					'github:owner/repo/main',
					'github:owner/repo/main'
				]
			}),
			push: 'true'
		});

		expect(run.calls.map((call) => call[1])).toStrictEqual([
			'plan',
			'build-push',
			'push'
		]);
		expect(run.calls[1]).toStrictEqual([
			'--no-colour',
			'build-push',
			url,
			'--github-oidc',
			'--no-retain',
			'--cohorts-file',
			path.join(directory, `cupboard-build-cohorts-${cohortKey}.json`),
			'--receipt-file',
			path.join(directory, 'cupboard-cohort-receipt.json')
		]);
		expect(run.calls[2]).toStrictEqual([
			'--no-colour',
			'push',
			url,
			appPath,
			libraryBuiltPath,
			floatingBuiltPath,
			'--github-oidc',
			'--root',
			'github:owner/repo/main'
		]);
	});

	it('claims only the queryable remote output Nix reports this invocation built', async () => {
		const run = await runPublicationFlow({
			...baseOptions(),
			cohortJson: remotelyQueryableCohortJson({
				roots: [
					'github:owner/repo/main',
					'github:owner/repo/main',
					'github:owner/repo/main'
				]
			}),
			push: 'true',
			maxJobs: '0',
			store: 'ssh-ng://build@example.test'
		});

		const receiptFile = path.join(directory, 'cupboard-cohort-receipt.json');

		expect({
			invocations: run.calls.map((call) => call[1]),
			receiptPush: run.calls[1],
			rootPush: run.calls[2],
			cohortsFile: run.cohortsFile,
			nixBuilds: run.nixBuilds,
			resultBuilds: run.resultBuilds,
			remoteConnection: {
				lifecycle: run.remoteConnection.lifecycle,
				sequence: run.remoteConnection.sequence,
				evaluationCalls: run.remoteConnection.evaluationCalls.map((call) =>
					call.slice(0, 1)
				),
				copyCalls: run.remoteConnection.copyCalls.map((call) =>
					call.slice(0, 2)
				),
				didEvaluationReceiveSignal:
					run.remoteConnection.didEvaluationReceiveSignal,
				didCopyReceiveSignal: run.remoteConnection.didCopyReceiveSignal,
				didBuildReceiveSignal: run.remoteConnection.didBuildReceiveSignal,
				pushesOpen: run.remoteConnection.cupboardCalls
					.filter((call) => call.command === 'push')
					.map((call) => call.open)
			},
			receiptLine: run.receiptLine
		}).toStrictEqual({
			invocations: ['plan', 'push', 'push'],
			receiptPush: [
				'--no-colour',
				'push',
				url,
				libraryBuiltPath,
				'--github-oidc',
				'--no-retain',
				'--store',
				'ssh-ng://build@example.test',
				'--receipt-file',
				receiptFile,
				'--already-held',
				appPath,
				'--claimable',
				libraryBuiltPath
			],
			rootPush: [
				'--no-colour',
				'push',
				url,
				appPath,
				libraryBuiltPath,
				'--github-oidc',
				'--root',
				'github:owner/repo/main',
				'--store',
				'ssh-ng://build@example.test'
			],
			cohortsFile: undefined,
			nixBuilds: [],
			resultBuilds: [
				[[libraryQueryInstallable], '0', 'ssh-ng://build@example.test']
			],
			remoteConnection: {
				lifecycle: ['opened', 'closed'],
				sequence: [
					'evaluate',
					'copy',
					'session',
					'publish',
					'publish',
					'closed'
				],
				evaluationCalls: [[['.#packages.x86_64-linux.lib^out']]],
				copyCalls: [
					[
						['/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib.drv'],
						'ssh-ng://build@example.test'
					]
				],
				didEvaluationReceiveSignal: true,
				didCopyReceiveSignal: true,
				didBuildReceiveSignal: true,
				pushesOpen: [true, true]
			},
			receiptLine: `receipt-file=${receiptFile}`
		});
	});

	it.each(['already-valid', 'substituted'] as const)(
		'publishes a remote %s output without claiming it',
		async (kind) => {
			const run = await runPublicationFlow(
				{
					...baseOptions(),
					cohortJson: remotelyQueryableCohortJson({
						roots: [
							'github:owner/repo/main',
							'github:owner/repo/main',
							'github:owner/repo/main'
						]
					}),
					push: 'true',
					store: 'ssh-ng://build@example.test'
				},
				[libraryBuiltPath, floatingBuiltPath],
				[remoteResult(kind)]
			);

			expect({
				receiptPush: run.calls[1],
				resultBuilds: run.resultBuilds,
				nixBuilds: run.nixBuilds
			}).toStrictEqual({
				receiptPush: [
					'--no-colour',
					'push',
					url,
					libraryBuiltPath,
					'--github-oidc',
					'--no-retain',
					'--store',
					'ssh-ng://build@example.test',
					'--receipt-file',
					path.join(directory, 'cupboard-cohort-receipt.json'),
					'--already-held',
					appPath,
					'--no-claimable'
				],
				resultBuilds: [
					[[libraryQueryInstallable], '', 'ssh-ng://build@example.test']
				],
				nixBuilds: []
			});
		}
	);
});
