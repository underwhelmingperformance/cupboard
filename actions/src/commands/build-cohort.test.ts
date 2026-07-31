import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { canonicalHref } from '@cupboard/nix-store/url';
import type { ReporterResultEvent } from '@cupboard/reporter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runCupboard } from '../cupboard-run.ts';
import {
	CohortPlanCommandError,
	CohortPlanRefusedError,
	CohortPlanResultMissingError,
	CupboardReportedError,
	InvalidInputError,
	MissingInputError
} from '../errors.ts';
import type { Environment } from '../inputs.ts';

import {
	buildCohortAction,
	type BuildCohortOptions,
	nixBuildArguments,
	resolveBuildCohortInputs
} from './build-cohort.ts';

const appPath = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app';
const appQueryInstallable =
	'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app.drv^out';
const libraryQueryInstallable =
	'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib.drv^out';
const libraryBuiltPath = '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib';
const floatingBuiltPath = '/nix/store/4123456789abcdfghijklmnpqrsvwxyz-float';
const referencePath = '/nix/store/5123456789abcdfghijklmnpqrsvwxyz-ref';
const leftUpstreamPath = '/nix/store/6123456789abcdfghijklmnpqrsvwxyz-up';

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
			readPassword: inputs.readPassword
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
			readPassword: ''
		});
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
});

describe('nixBuildArguments', () => {
	it('runs keep-going with print-out-paths and no --no-link', () => {
		expect(nixBuildArguments(['.#a^out', '.#b^out'], '')).toStrictEqual([
			'build',
			'--keep-going',
			'--print-out-paths',
			'--',
			'.#a^out',
			'.#b^out'
		]);
	});

	it('carries an explicit max-jobs through', () => {
		expect(nixBuildArguments(['.#a^out'], '4')).toStrictEqual([
			'build',
			'--keep-going',
			'--print-out-paths',
			'--max-jobs',
			'4',
			'--',
			'.#a^out'
		]);
	});
});

function parseJson(text: string): unknown {
	return JSON.parse(text);
}

function planCohortSuccess(): readonly ReporterResultEvent[] {
	return [
		{
			kind: 'plan-cohort',
			data: {
				partition: {
					attachOnly: [appPath],
					publishByReference: [referencePath],
					leftUpstream: [leftUpstreamPath],
					buildSet: [libraryQueryInstallable],
					counts: { willBuild: 1, willSubstitute: 0, unknown: 0 },
					downloadSize: 100,
					narSize: 200,
					unknownCount: 0,
					ceiling: { value: 5, source: 'configured' }
				},
				capacity: { available: 1000, capacity: 2000, headroom: 100 }
			}
		}
	];
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
		const runCupboardMock = vi.fn<typeof runCupboard>(() =>
			Promise.resolve(planCohortSuccess())
		);
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
			''
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
				capacity: { available: 1000, capacity: 2000, headroom: 100 }
			}
		});
	});

	it('skips the plan-cohort invocation when no member evaluated', async () => {
		const unevaluated = cohortJson({
			queryInstallables: [undefined, undefined, undefined],
			expectedPaths: [undefined, undefined, undefined]
		});
		const runCupboardMock = vi.fn<typeof runCupboard>(() =>
			Promise.resolve(planCohortSuccess())
		);
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
			''
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
});
