import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	type DaemonCommandRunner,
	Nix,
	type NixBuildResult,
	type NixDaemonClientOptions,
	NixDaemonStoreClient,
	NixDaemonUnavailableError,
	type NixDerivedPathString,
	type NixValidPathInfo
} from '@cupboard/nix';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	storeDirectorySchema,
	storePathBasenameSchema,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { canonicalHref } from '@cupboard/nix-store/url';
import {
	describeUnknownPathsRefusal,
	unknownPathsCeilingRefusalSchema
} from '@cupboard/protocol/plan';
import type { Reporter, ReporterResultEvent } from '@cupboard/reporter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildProgram } from '../../../packages/cli/src/cli.ts';
import { FakeDaemonChild } from '../../../tests/support/fake-daemon-child.ts';
import { FakeDaemonTransport } from '../../../tests/support/fake-daemon-transport.ts';
import {
	type ChildProcessEscalationScheduler,
	terminationGracePeriodMs
} from '../child-process.ts';
import { runCupboard } from '../cupboard-run.ts';
import {
	CohortPlanCommandError,
	CohortPlanRefusedError,
	CohortPlanResultInvalidError,
	CohortPlanResultMissingError,
	CommandOutputTooLargeError,
	CupboardReportedError,
	InvalidInputError,
	MissingInputError,
	type RemoteCohortBuildFailure
} from '../errors.ts';
import type { Environment } from '../inputs.ts';

import {
	buildAndRootNixResults,
	buildCohortAction as productionBuildCohortAction,
	type BuildCohortDependencies,
	type BuildCohortInputs,
	type BuildCohortOptions,
	buildPushCohortsFile,
	canonicalNixDerivedPath,
	type CapturedNixProcess,
	cohortPushArguments,
	cohortReceiptPushArguments,
	materialiseDerivationGraph,
	nixBuildArguments,
	nixCopyArguments,
	nixDerivationShowArguments,
	parseNixDerivationShow,
	planReprobeArguments,
	provenanceRebuildInstallables,
	receiptAlreadyHeldPaths,
	remoteBuildSetOptions,
	type RemoteDerivationPreparation,
	resolveBuildCohortInputs,
	rootGroups,
	runNixBuild,
	runNixCopy,
	runNixDerivationShow,
	runWithLocalDerivationRoots,
	withdrawFromPartition,
	type WithLocalDerivationRoots
} from './build-cohort.ts';

const appPath = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app';
const appQueryInstallable =
	'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app.drv^out';
const libraryQueryInstallable =
	'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib.drv^out';
const floatingQueryInstallable =
	'/nix/store/4123456789abcdfghijklmnpqrsvwxyz-float.drv^out';
const extraQueryInstallable =
	'/nix/store/7123456789abcdfghijklmnpqrsvwxyz-extra.drv^out';
const libraryBuiltPath = '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib';
const floatingBuiltPath = '/nix/store/4123456789abcdfghijklmnpqrsvwxyz-float';
const floatingDevelopmentPath =
	'/nix/store/8123456789abcdfghijklmnpqrsvwxyz-float-dev';
const referencePath = '/nix/store/5123456789abcdfghijklmnpqrsvwxyz-ref';
const leftUpstreamPath = '/nix/store/6123456789abcdfghijklmnpqrsvwxyz-up';

function evaluatedDerivations(
	installables: readonly string[]
): readonly ReturnType<typeof storePathSchema.parse>[] {
	return installables.map((installable) =>
		storePathSchema.parse(
			installable.includes('.app')
				? '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app.drv'
				: installable.includes('.lib') || installable.includes('.multi')
					? '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib.drv'
					: '/nix/store/4123456789abcdfghijklmnpqrsvwxyz-float.drv'
		)
	);
}

const withoutLocalDerivationRoots: WithLocalDerivationRoots = (
	_derivations,
	use
) => use();

function buildCohortAction(
	options: BuildCohortOptions,
	environment: Environment,
	dependencies: BuildCohortDependencies = {}
): Promise<void> {
	return productionBuildCohortAction(options, environment, {
		runNixDerivationShow: (installables) =>
			Promise.resolve(evaluatedDerivations(installables)),
		materialiseDerivationGraph: () => Promise.resolve(),
		withLocalDerivationRoots: withoutLocalDerivationRoots,
		...dependencies
	});
}

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

function remotePathInfo(
	storePath: string,
	references: readonly string[] = []
): NixValidPathInfo {
	return {
		storePath: storePathSchema.parse(storePath),
		narHash: NixSha256Hash.fromDigest(Buffer.alloc(32)),
		narSize: 0,
		references: references.map((reference) => storePathSchema.parse(reference)),
		signatures: [],
		ultimate: true
	};
}

function ownPathClosure(
	storePaths: readonly StorePathString[]
): Promise<readonly NixValidPathInfo[]> {
	return Promise.resolve(
		storePaths.map((storePath) => remotePathInfo(storePath))
	);
}

async function parsePushWithRealCli(
	arguments_: readonly string[]
): Promise<void> {
	const program = buildProgram();

	program.exitOverride();
	program.configureOutput({
		writeErr() {
			return;
		},
		writeOut() {
			return;
		}
	});
	const push = program.commands.find((command) => command.name() === 'push');

	if (push === undefined) {
		throw new Error('Expected the real CLI to register push');
	}

	push.action(() => {
		return;
	});
	await program.parseAsync(['node', 'cupboard', ...arguments_]);
}

function remoteDerivation(drvPath: string): string {
	const outputs: readonly (readonly [string, string])[] = drvPath.includes(
		'-float.drv'
	)
		? [
				['out', floatingBuiltPath],
				['dev', floatingDevelopmentPath]
			]
		: drvPath.includes('-app.drv')
			? [['out', appPath]]
			: [['out', libraryBuiltPath]];

	return `Derive([${outputs.map(([name, output]) => `("${name}","${output}","","")`).join(',')}],[],[],"x86_64-linux","/bin/sh",[],[])`;
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
			store: inputs.store,
			allBestEffort: inputs.allBestEffort
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
			store: '',
			allBestEffort: false
		});
	});

	it('enables the uniform typed build-failure boundary explicitly', () => {
		const inputs = resolveBuildCohortInputs(
			{ ...baseOptions(), bestEffort: 'true' },
			{ RUNNER_TEMP: '/tmp' }
		);

		expect(inputs.allBestEffort).toBe(true);
	});

	it('enables current-invocation provenance rebuilds explicitly', () => {
		const inputs = resolveBuildCohortInputs(
			{ ...baseOptions(), requireProvenance: 'true' },
			{ RUNNER_TEMP: '/tmp' }
		);

		expect(inputs.requireProvenance).toBe(true);
	});

	it('passes the remote store through', () => {
		const inputs = resolveBuildCohortInputs(
			{ ...baseOptions(), store: 'ssh-ng://build@example.test' },
			{ RUNNER_TEMP: '/tmp' }
		);

		expect(inputs.store).toBe('ssh-ng://build@example.test');
	});

	// The composite action always passes the file options, so an unset
	// workflow input arrives as the empty string; both spellings of "not
	// set" must resolve to the RUNNER_TEMP defaults, never to the working
	// directory.
	it.each([
		{ name: 'absent', value: undefined },
		{ name: 'blank', value: '' }
	])(
		'defaults the output files under RUNNER_TEMP for $name inputs',
		({ value }) => {
			const inputs = resolveBuildCohortInputs(
				{
					...baseOptions(),
					receiptFile: value,
					targetPathsFile: value,
					intermediatePathsFile: value,
					referencePathsFile: value,
					leftUpstreamFile: value,
					countsFile: value
				},
				{ RUNNER_TEMP: '/tmp' }
			);

			expect({
				receiptFile: inputs.receiptFile,
				targetPathsFile: inputs.targetPathsFile,
				intermediatePathsFile: inputs.intermediatePathsFile,
				referencePathsFile: inputs.referencePathsFile,
				leftUpstreamFile: inputs.leftUpstreamFile,
				countsFile: inputs.countsFile
			}).toStrictEqual({
				receiptFile: '/tmp/cupboard-cohort-receipt.json',
				targetPathsFile: '/tmp/cupboard-cohort-target-paths.txt',
				intermediatePathsFile: '/tmp/cupboard-cohort-intermediate-paths.txt',
				referencePathsFile: '/tmp/cupboard-cohort-reference-paths.txt',
				leftUpstreamFile: '/tmp/cupboard-cohort-left-upstream.json',
				countsFile: '/tmp/cupboard-cohort-counts.json'
			});
		}
	);

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

describe('buildPushCohortsFile', () => {
	it('separates ordinary builds from provenance rebuilds', () => {
		expect(
			buildPushCohortsFile(
				[libraryQueryInstallable, floatingQueryInstallable],
				'',
				false,
				new Set([floatingQueryInstallable]),
				true
			)
		).toStrictEqual({
			cohorts: [
				{
					installables: [libraryQueryInstallable],
					requireProvenance: true,
					keepGoing: true
				},
				{
					installables: [floatingQueryInstallable],
					rebuild: true,
					requireProvenance: true,
					keepGoing: true
				}
			]
		});
	});

	it('keeps each best-effort target attributable while rebuilding for provenance', () => {
		expect(
			buildPushCohortsFile(
				[libraryQueryInstallable, floatingQueryInstallable],
				'',
				true,
				new Set([floatingQueryInstallable]),
				true
			)
		).toStrictEqual({
			cohorts: [
				{
					installables: [libraryQueryInstallable],
					requireProvenance: true,
					keepGoing: false
				},
				{
					installables: [floatingQueryInstallable],
					rebuild: true,
					requireProvenance: true,
					keepGoing: false
				}
			]
		});
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

class ControlledNixProcess implements CapturedNixProcess {
	private errorListener: ((error: Error) => void) | undefined;

	private closeListener:
		| ((status: number | null, signal: NodeJS.Signals | undefined) => void)
		| undefined;

	private stdoutListener: ((chunk: string) => void) | undefined;

	readonly signals: NodeJS.Signals[] = [];

	onceError(listener: (error: Error) => void): void {
		this.errorListener = listener;
	}

	onceClose(
		listener: (
			status: number | null,
			signal: NodeJS.Signals | undefined
		) => void
	): void {
		this.closeListener = listener;
	}

	onStdout(listener: (chunk: string) => void): void {
		this.stdoutListener = listener;
	}

	kill(signal: NodeJS.Signals): boolean {
		this.signals.push(signal);

		return true;
	}

	emitError(error: Error): void {
		if (this.errorListener === undefined) {
			throw new Error('Expected the Nix command to observe process errors');
		}

		this.errorListener(error);
	}

	emitClose(status: number | null, signal?: NodeJS.Signals): void {
		if (this.closeListener === undefined) {
			throw new Error('Expected the Nix command to observe process closure');
		}

		this.closeListener(status, signal);
	}

	emitStdout(chunk: string): void {
		if (this.stdoutListener === undefined) {
			throw new Error('Expected the Nix command to observe stdout');
		}

		this.stdoutListener(chunk);
	}
}

interface ControlledEscalation {
	readonly delayMs: number;
	readonly run: () => void;
	cancelled: boolean;
}

class ControlledEscalationScheduler implements ChildProcessEscalationScheduler {
	readonly escalations: ControlledEscalation[] = [];

	schedule(run: () => void, delayMs: number): { cancel(): void } {
		const escalation = { delayMs, run, cancelled: false };

		this.escalations.push(escalation);

		return {
			cancel() {
				escalation.cancelled = true;
			}
		};
	}

	runPending(): void {
		for (const escalation of this.escalations) {
			if (!escalation.cancelled) {
				escalation.run();
			}
		}
	}
}

describe('runNixCopy', () => {
	it('waits for process closure before propagating the exact cancellation reason', async () => {
		const process = new ControlledNixProcess();
		const controller = new AbortController();
		const reason = new Error('cancel native copy');
		const settled = vi.fn();
		const start = vi.fn(() => process);
		const copy = runNixCopy(
			[
				storePathSchema.parse(
					'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib.drv'
				)
			],
			'ssh-ng://build@example.test',
			controller.signal,
			{ start }
		);

		void copy.then(settled).catch(settled);
		controller.abort(reason);
		process.emitError(new Error('The operation was aborted'));
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect({
			settled: settled.mock.calls,
			signals: process.signals,
			start: start.mock.calls
		}).toStrictEqual({
			settled: [],
			signals: ['SIGTERM'],
			start: [
				[
					[
						'copy',
						'--to',
						'ssh-ng://build@example.test',
						'--',
						'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib.drv'
					],
					controller.signal
				]
			]
		});

		process.emitClose(0);

		await expect(copy).rejects.toBe(reason);
	});
});

describe('materialiseDerivationGraph', () => {
	it('evaluates the whole graph in the selected store and reads none of the output', async () => {
		const process = new ControlledNixProcess();
		const start = vi.fn(() => process);
		const materialise = materialiseDerivationGraph(
			['.#packages.x86_64-linux.app^out'],
			undefined,
			{ start, evalStore: 'local?root=/work/store' }
		);

		process.emitClose(0);

		await materialise;

		// The launcher is given no stdout listener, so this path cannot
		// buffer the graph, however large the closure grows.
		expect(start.mock.calls).toStrictEqual([
			[
				[
					'derivation',
					'show',
					'--recursive',
					'--eval-store',
					'local?root=/work/store',
					'--no-pretty',
					'--',
					'.#packages.x86_64-linux.app^out'
				],
				undefined
			]
		]);
	});

	it('fails when the evaluation exits non-zero', async () => {
		const process = new ControlledNixProcess();
		const materialise = materialiseDerivationGraph(
			['.#packages.x86_64-linux.app^out'],
			undefined,
			{ start: () => process }
		);

		process.emitClose(1);

		await expect(materialise).rejects.toMatchObject({
			name: 'CommandFailedError',
			command: 'nix derivation show'
		});
	});
});

describe('captured Nix subprocesses', () => {
	it.each([
		{
			command: 'nix derivation show',
			run: (
				_directory: string,
				start: () => CapturedNixProcess,
				scheduler: ChildProcessEscalationScheduler
			) =>
				runNixDerivationShow(['.#package'], undefined, true, {
					start,
					maximumStdoutBytes: 4,
					scheduler
				})
		},
		{
			command: 'nix build',
			run: (
				directory: string,
				start: () => CapturedNixProcess,
				scheduler: ChildProcessEscalationScheduler
			) =>
				runNixBuild(['.#package'], '', '', directory, undefined, {
					start,
					maximumStdoutBytes: 4,
					scheduler
				})
		}
	])(
		'terminates $command when its captured stdout exceeds the byte limit',
		async ({ command, run }) => {
			const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-nix-run-'));

			try {
				const process = new ControlledNixProcess();
				const scheduler = new ControlledEscalationScheduler();
				const started = Promise.withResolvers<undefined>();
				const running = run(
					directory,
					() => {
						started.resolve(undefined);

						return process;
					},
					scheduler
				);
				await started.promise;

				process.emitStdout('{}');
				process.emitStdout('€');
				process.emitStdout('not retained after overflow');
				scheduler.runPending();
				process.emitClose(1, 'SIGKILL');
				let error: unknown;

				try {
					await running;
				} catch (error_) {
					error = error_;
				}

				if (!(error instanceof CommandOutputTooLargeError)) {
					throw error;
				}

				expect({
					error: {
						name: error.name,
						command: error.command,
						maximumBytes: error.maximumBytes,
						observedBytes: error.observedBytes
					},
					signals: process.signals,
					escalations: scheduler.escalations.map(({ delayMs, cancelled }) => ({
						delayMs,
						cancelled
					}))
				}).toStrictEqual({
					error: {
						name: 'CommandOutputTooLargeError',
						command,
						maximumBytes: 4,
						observedBytes: 5
					},
					signals: ['SIGTERM', 'SIGKILL'],
					escalations: [{ delayMs: terminationGracePeriodMs, cancelled: true }]
				});
			} finally {
				await rm(directory, { recursive: true });
			}
		}
	);

	it('reports the signal that terminated derivation evaluation', async () => {
		const process = new ControlledNixProcess();
		const evaluation = runNixDerivationShow(['.#package'], undefined, true, {
			start: () => process
		});

		process.emitClose(1, 'SIGKILL');

		await expect(evaluation).rejects.toMatchObject({
			name: 'CommandFailedError',
			command: 'nix derivation show',
			message: 'nix derivation show terminated by SIGKILL',
			signal: 'SIGKILL',
			status: 1
		});
	});

	it.each([
		{
			command: 'derivation evaluation',
			run: (
				_directory: string,
				signal: AbortSignal,
				start: () => CapturedNixProcess
			) => runNixDerivationShow(['.#package'], signal, true, { start })
		},
		{
			command: 'local build',
			run: (
				directory: string,
				signal: AbortSignal,
				start: () => CapturedNixProcess
			) => runNixBuild(['.#package'], '', '', directory, signal, { start })
		}
	])(
		'waits for $command closure before propagating the exact cancellation reason',
		async ({ run }) => {
			const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-nix-run-'));

			try {
				const process = new ControlledNixProcess();
				const controller = new AbortController();
				const reason = new Error('cancel captured Nix command');
				const settled = vi.fn();
				const started = Promise.withResolvers<undefined>();
				const running = run(directory, controller.signal, () => {
					started.resolve(undefined);

					return process;
				});

				void running.then(settled).catch(settled);
				await started.promise;
				controller.abort(reason);
				process.emitError(new Error('The operation was aborted'));
				await new Promise<void>((resolve) => setImmediate(resolve));

				expect({
					settled: settled.mock.calls,
					signals: process.signals
				}).toStrictEqual({ settled: [], signals: ['SIGTERM'] });

				process.emitClose(0);

				await expect(running).rejects.toBe(reason);
			} finally {
				await rm(directory, { recursive: true });
			}
		}
	);
});

describe('runWithLocalDerivationRoots', () => {
	it('uses the system daemon and holds each derivation for the callback extent', async () => {
		const daemon = new FakeDaemonTransport({}, { expectSetOptions: false });
		const storeDirectory = storeDirectorySchema.parse('/nix/store');
		const nix = Nix.forStore(
			new NixDaemonStoreClient({
				connect: () => Promise.resolve(daemon),
				shouldPreserveDaemonOptions: true,
				storeDirectory
			}),
			{ storeDirectory }
		);
		const controller = new AbortController();
		const opened: NixDaemonClientOptions[] = [];
		const appDerivation = storePathSchema.parse(
			'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app.drv'
		);
		const libraryDerivation = storePathSchema.parse(
			'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib.drv'
		);

		const result = await runWithLocalDerivationRoots(
			[appDerivation, libraryDerivation, appDerivation],
			() => {
				expect({
					temporaryRoots: daemon.temporaryRoots,
					closed: daemon.closed
				}).toStrictEqual({
					temporaryRoots: [appDerivation, libraryDerivation],
					closed: false
				});

				return Promise.resolve('published');
			},
			controller.signal,
			{
				runDaemon: () => {
					throw new Error('the scoped daemon must not start');
				},
				openNix: (options) => {
					opened.push(options);

					return nix;
				}
			}
		);

		expect({ result, opened, closed: daemon.closed }).toStrictEqual({
			result: 'published',
			opened: [{ signal: controller.signal, storeUri: 'daemon' }],
			closed: true
		});
	});

	it('falls back to a scoped local daemon only when the system daemon socket is unavailable', async () => {
		const commands: {
			readonly command: string;
			readonly commandArguments: readonly string[];
		}[] = [];
		const opened: NixDaemonClientOptions[] = [];
		const daemons: FakeDaemonTransport[] = [];
		const children: FakeDaemonChild[] = [];
		const runDaemon: DaemonCommandRunner = (command, commandArguments) => {
			commands.push({ command, commandArguments });
			const daemon = new FakeDaemonTransport({}, { expectSetOptions: false });
			const child = new FakeDaemonChild(daemon);
			daemons.push(daemon);
			children.push(child);

			return child;
		};
		const appDerivation = storePathSchema.parse(
			'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app.drv'
		);
		const libraryDerivation = storePathSchema.parse(
			'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib.drv'
		);

		const result = await runWithLocalDerivationRoots(
			[appDerivation, libraryDerivation, appDerivation],
			() => {
				expect({
					temporaryRoots: daemons[0]?.temporaryRoots,
					childrenKilled: children.map((child) => child.killed)
				}).toStrictEqual({
					temporaryRoots: [appDerivation, libraryDerivation],
					childrenKilled: [0]
				});

				return Promise.resolve('published');
			},
			undefined,
			{
				runDaemon,
				openNix: (options) => {
					opened.push(options);

					if (options.storeUri === 'daemon') {
						throw new NixDaemonUnavailableError(
							'/nix/var/nix/daemon-socket/socket'
						);
					}

					return Nix.openForAvailability(undefined, options);
				}
			}
		);

		expect({
			result,
			opened: opened.map(({ connect, ...options }) => ({
				...options,
				connect: typeof connect
			})),
			commands,
			childrenKilled: children[0]?.killed
		}).toStrictEqual({
			result: 'published',
			opened: [
				{ storeUri: 'daemon', connect: 'undefined' },
				{
					storeUri:
						'ssh-ng://localhost?remote-program=nix%20daemon&remote-store=local',
					connect: 'function'
				}
			],
			commands: [
				{
					command: 'nix',
					commandArguments: ['daemon', '--stdio', '--store', 'local']
				}
			],
			childrenKilled: 1
		});
	});

	it('does not fall back after the system daemon opens but the operation fails', async () => {
		const failure = new Error('system daemon protocol failed');
		const stores: (string | undefined)[] = [];

		await expect(
			runWithLocalDerivationRoots(
				[
					storePathSchema.parse(
						'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app.drv'
					)
				],
				() => Promise.resolve('unused'),
				undefined,
				{
					openNix: (options) => {
						stores.push(options.storeUri);

						return {
							withConnection: <T>() => Promise.reject<T>(failure)
						};
					}
				}
			)
		).rejects.toBe(failure);
		expect(stores).toStrictEqual(['daemon']);
	});

	it('closes the scoped local daemon when the operation is aborted', async () => {
		const daemon = new FakeDaemonTransport({}, { expectSetOptions: false });
		const child = new FakeDaemonChild(daemon);
		const controller = new AbortController();
		const entered = Promise.withResolvers<boolean>();
		const blocked = Promise.withResolvers<never>();
		const reason = new Error('cancel local protection');
		const operation = runWithLocalDerivationRoots(
			[
				storePathSchema.parse(
					'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app.drv'
				)
			],
			async () => {
				entered.resolve(true);
				await blocked.promise;
			},
			controller.signal,
			{
				runDaemon: () => child,
				openNix: (options) => {
					if (options.storeUri === 'daemon') {
						throw new NixDaemonUnavailableError(
							'/nix/var/nix/daemon-socket/socket'
						);
					}

					return Nix.openForAvailability(undefined, options);
				}
			}
		);

		await entered.promise;
		controller.abort(reason);

		await expect(operation).rejects.toBe(reason);
		expect({
			childKilled: child.killed,
			roots: daemon.temporaryRoots
		}).toStrictEqual({
			childKilled: 1,
			roots: ['/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app.drv']
		});
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

	it('evaluates only the requested root when checking one installable', () => {
		expect(
			nixDerivationShowArguments(
				['.#packages.x86_64-linux.lib^out'],
				false,
				'local?root=/tmp/cupboard-eval-store'
			)
		).toStrictEqual([
			'derivation',
			'show',
			'--eval-store',
			'local?root=/tmp/cupboard-eval-store',
			'--no-pretty',
			'--',
			'.#packages.x86_64-linux.lib^out'
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
		{ maxJobs: '', expected: {} },
		{ maxJobs: '0', expected: { maxBuildJobs: 0 } },
		{ maxJobs: '3', expected: { maxBuildJobs: 3 } }
	])('forwards only max-jobs $maxJobs', ({ maxJobs, expected }) => {
		expect(remoteBuildSetOptions(maxJobs)).toStrictEqual(expected);
	});
});

describe('buildAndRootNixResults', () => {
	it('uses daemon check mode only when the selected store already holds every output', async () => {
		const buildCalls: unknown[] = [];

		await buildAndRootNixResults(
			{
				readDerivation: (drvPath) => Promise.resolve(remoteDerivation(drvPath)),
				queryValidPaths: () =>
					Promise.resolve([storePathSchema.parse(libraryBuiltPath)]),
				buildPathsWithResults: (targets, mode) => {
					buildCalls.push({ targets, mode });

					return Promise.resolve([remoteResult('built')]);
				},
				resolveClosure: ownPathClosure,
				addTempRoot: () => Promise.resolve()
			},
			[derivedPath(libraryQueryInstallable)],
			() => Promise.resolve(),
			{
				derivations: [],
				requireProvenance: true,
				copy: () => Promise.resolve()
			}
		);

		expect(buildCalls).toStrictEqual([
			{
				targets: [libraryQueryInstallable],
				mode: 'check'
			}
		]);
	});

	it('uses normal mode when the destination has an output but the selected store is cold', async () => {
		const buildCalls: unknown[] = [];

		await buildAndRootNixResults(
			{
				readDerivation: (drvPath) => Promise.resolve(remoteDerivation(drvPath)),
				queryValidPaths: () => Promise.resolve([]),
				buildPathsWithResults: (targets, mode) => {
					buildCalls.push({ targets, mode });

					return Promise.resolve([remoteResult('built')]);
				},
				resolveClosure: ownPathClosure,
				addTempRoot: () => Promise.resolve()
			},
			[derivedPath(libraryQueryInstallable)],
			() => Promise.resolve(),
			{
				derivations: [],
				requireProvenance: true,
				copy: () => Promise.resolve()
			}
		);

		expect(buildCalls).toStrictEqual([
			{ targets: [libraryQueryInstallable], mode: 'normal' }
		]);
	});

	it('uses normal mode when only some selected outputs are valid', async () => {
		const target = derivedPath(
			'/nix/store/4123456789abcdfghijklmnpqrsvwxyz-float.drv^*'
		);
		const buildCalls: unknown[] = [];
		const result: NixBuildResult = {
			...remoteResult('built', target, floatingBuiltPath),
			target,
			outcome: {
				kind: 'built',
				outputs: {
					out: storePathSchema.parse(floatingBuiltPath),
					dev: storePathSchema.parse(floatingDevelopmentPath)
				}
			}
		};

		await buildAndRootNixResults(
			{
				readDerivation: (drvPath) => Promise.resolve(remoteDerivation(drvPath)),
				queryValidPaths: () =>
					Promise.resolve([storePathSchema.parse(floatingBuiltPath)]),
				buildPathsWithResults: (targets, mode) => {
					buildCalls.push({ targets, mode });

					return Promise.resolve([result]);
				},
				resolveClosure: ownPathClosure,
				addTempRoot: () => Promise.resolve()
			},
			[target],
			() => Promise.resolve(),
			{
				derivations: [],
				requireProvenance: true,
				copy: () => Promise.resolve()
			}
		);

		expect(buildCalls).toStrictEqual([{ targets: [target], mode: 'normal' }]);
	});

	it('switches to check mode when a cold output becomes valid before its build', async () => {
		const buildCalls: unknown[] = [];

		await buildAndRootNixResults(
			{
				readDerivation: (drvPath) => Promise.resolve(remoteDerivation(drvPath)),
				queryValidPaths: () => Promise.resolve([]),
				buildPathsWithResults: (targets, mode) => {
					buildCalls.push({ targets, mode });

					return Promise.resolve([
						remoteResult(mode === 'normal' ? 'already-valid' : 'built')
					]);
				},
				resolveClosure: ownPathClosure,
				addTempRoot: () => Promise.resolve()
			},
			[derivedPath(libraryQueryInstallable)],
			() => Promise.resolve(),
			{
				derivations: [],
				requireProvenance: true,
				copy: () => Promise.resolve()
			}
		);

		expect(buildCalls).toStrictEqual([
			{ targets: [libraryQueryInstallable], mode: 'normal' },
			{ targets: [libraryQueryInstallable], mode: 'check' }
		]);
	});

	it('uses check and normal modes independently in a mixed selected store', async () => {
		const buildCalls: unknown[] = [];
		const rebuilt: string[] = [];

		await buildAndRootNixResults(
			{
				readDerivation: (drvPath) => Promise.resolve(remoteDerivation(drvPath)),
				queryValidPaths: () =>
					Promise.resolve([storePathSchema.parse(libraryBuiltPath)]),
				buildPathsWithResults: ([target], mode) => {
					buildCalls.push({ targets: [target], mode });

					return Promise.resolve(
						target === libraryQueryInstallable
							? [remoteResult('already-valid')]
							: [remoteResult('built', target, floatingBuiltPath)]
					);
				},
				resolveClosure: ownPathClosure,
				addTempRoot: () => Promise.resolve()
			},
			[
				derivedPath(libraryQueryInstallable),
				derivedPath(floatingQueryInstallable)
			],
			(_results, _failures, _paths, provenanceRebuilds) => {
				rebuilt.push(...provenanceRebuilds);

				return Promise.resolve();
			},
			{
				derivations: [],
				requireProvenance: true,
				copy: () => Promise.resolve()
			}
		);

		expect({ buildCalls, rebuilt }).toStrictEqual({
			buildCalls: [
				{ targets: [libraryQueryInstallable], mode: 'check' },
				{ targets: [floatingQueryInstallable], mode: 'normal' }
			],
			rebuilt: [derivedPath(libraryQueryInstallable)]
		});
	});

	it('publishes the realised closure while preserving exact result ownership', async () => {
		const events: string[] = [];
		const infos = new Map([
			[libraryBuiltPath, remotePathInfo(libraryBuiltPath, [referencePath])],
			[referencePath, remotePathInfo(referencePath)]
		]);
		const published: unknown[][] = [];
		const session = {
			readDerivation: (drvPath: string) =>
				Promise.resolve(remoteDerivation(drvPath)),
			buildPathsWithResults: () => Promise.resolve([remoteResult('built')]),
			addTempRoot: (storePath: string) => {
				events.push(`root ${storePath}`);

				return Promise.resolve();
			},
			resolveClosure: (storePaths: readonly string[]) => {
				const closure = storePaths.flatMap((storePath) => {
					const info = infos.get(storePath);

					if (info === undefined) {
						throw new Error(`No remote path info for ${storePath}`);
					}

					return [info, remotePathInfo(referencePath)];
				});

				events.push(...closure.map((info) => `query ${info.storePath}`));

				return Promise.resolve(closure);
			}
		};

		await buildAndRootNixResults(
			session,
			[derivedPath(libraryQueryInstallable)],
			(...arguments_: unknown[]) => {
				published.push(arguments_);

				return Promise.resolve();
			}
		);

		expect({ events, published }).toStrictEqual({
			events: [
				`root ${libraryBuiltPath}`,
				`root ${libraryBuiltPath}`,
				`query ${libraryBuiltPath}`,
				`query ${referencePath}`
			],
			published: [
				[
					[remoteResult('built')],
					[],
					[referencePath, libraryBuiltPath].toSorted((left, right) =>
						left.localeCompare(right)
					),
					new Set()
				]
			]
		});
	});

	it('roots derivations before copying and confirms output roots after building', async () => {
		const libraryDerivation = storePathSchema.parse(
			'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib.drv'
		);
		const events: string[] = [];

		await buildAndRootNixResults(
			{
				readDerivation: (drvPath) => {
					events.push(`read ${drvPath}`);

					return Promise.resolve(remoteDerivation(drvPath));
				},
				buildPathsWithResults: (targets) => {
					events.push(`build ${targets.join(' ')}`);

					return Promise.resolve([remoteResult('built')]);
				},
				resolveClosure: ownPathClosure,
				addTempRoot: (storePath) => {
					events.push(`root ${storePath}`);

					return Promise.resolve();
				}
			},
			[derivedPath(libraryQueryInstallable)],
			() => {
				events.push('publish');

				return Promise.resolve();
			},
			{
				derivations: [libraryDerivation],
				copy: () => {
					events.push('copy');

					return Promise.resolve();
				}
			}
		);

		expect(events).toStrictEqual([
			`root ${libraryDerivation}`,
			'copy',
			`read ${libraryDerivation}`,
			`root ${libraryBuiltPath}`,
			`build ${libraryQueryInstallable}`,
			`root ${libraryBuiltPath}`,
			'publish'
		]);
	});

	it('stops inside the rooted session when copying fails', async () => {
		const libraryDerivation = storePathSchema.parse(
			'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib.drv'
		);
		const reason = new Error('remote copy failed');
		const events: string[] = [];
		const run = buildAndRootNixResults(
			{
				readDerivation: () => {
					events.push('read');

					return Promise.resolve(remoteDerivation(libraryDerivation));
				},
				buildPathsWithResults: () => {
					events.push('build');

					return Promise.resolve([]);
				},
				resolveClosure: ownPathClosure,
				addTempRoot: (storePath) => {
					events.push(`root ${storePath}`);

					return Promise.resolve();
				}
			},
			[derivedPath(libraryQueryInstallable)],
			() => {
				events.push('publish');

				return Promise.resolve();
			},
			{
				derivations: [libraryDerivation],
				copy: () => {
					events.push('copy');

					return Promise.reject(reason);
				}
			}
		);

		await expect(run).rejects.toBe(reason);
		expect(events).toStrictEqual([`root ${libraryDerivation}`, 'copy']);
	});

	it('matches named-output selections independently of selector order', async () => {
		const requested = derivedPath(
			'/nix/store/4123456789abcdfghijklmnpqrsvwxyz-float.drv^out,dev'
		);
		const returned = derivedPath(
			'/nix/store/4123456789abcdfghijklmnpqrsvwxyz-float.drv^dev,out'
		);
		const published: (readonly NixBuildResult[])[] = [];
		const result = {
			...remoteResult('built', returned, floatingBuiltPath),
			target: returned,
			outcome: {
				kind: 'built' as const,
				outputs: {
					out: storePathSchema.parse(floatingBuiltPath),
					dev: storePathSchema.parse(floatingDevelopmentPath)
				}
			}
		};

		await buildAndRootNixResults(
			{
				readDerivation: (drvPath) => Promise.resolve(remoteDerivation(drvPath)),
				buildPathsWithResults: () => Promise.resolve([result]),
				resolveClosure: ownPathClosure,
				addTempRoot: () => Promise.resolve()
			},
			[requested],
			(builds) => {
				published.push(builds);

				return Promise.resolve();
			}
		);

		expect({
			canonical: canonicalNixDerivedPath(requested),
			published
		}).toStrictEqual({
			canonical: returned,
			published: [[result]]
		});
	});

	it.each([
		{
			name: 'output name',
			outputs: { dev: libraryBuiltPath },
			reported: `dev=${libraryBuiltPath}`
		},
		{
			name: 'output path',
			outputs: { out: floatingBuiltPath },
			reported: `out=${floatingBuiltPath}`
		}
	])(
		'rejects a keyed result with the wrong $name',
		async ({ outputs, reported }) => {
			const result: NixBuildResult = {
				...remoteResult('built'),
				outcome: {
					kind: 'built',
					outputs: Object.fromEntries(
						Object.entries(outputs).map(([name, output]) => [
							name,
							storePathSchema.parse(output)
						])
					)
				}
			};
			const published: (readonly NixBuildResult[])[] = [];

			const run = buildAndRootNixResults(
				{
					readDerivation: (drvPath) =>
						Promise.resolve(remoteDerivation(drvPath)),
					buildPathsWithResults: () => Promise.resolve([result]),
					resolveClosure: ownPathClosure,
					addTempRoot: () => Promise.resolve()
				},
				[derivedPath(libraryQueryInstallable)],
				(builds) => {
					published.push(builds);

					return Promise.resolve();
				}
			);

			await expect(run).rejects.toMatchObject({
				name: 'RemoteCohortProtocolError',
				failures: [
					{
						target: derivedPath(libraryQueryInstallable),
						outcome: 'invalid-outputs',
						message: `the daemon reported ${reported}; expected out=${libraryBuiltPath}`
					}
				]
			});
			expect(published).toStrictEqual([[]]);
		}
	);

	it('continues after a failed target and publishes later survivors before reporting it', async () => {
		const events: string[] = [];

		const run = buildAndRootNixResults(
			{
				readDerivation: (drvPath) => Promise.resolve(remoteDerivation(drvPath)),
				buildPathsWithResults: (targets) => {
					events.push(`build ${targets.join(' ')}`);

					const [target] = targets;

					if (target === floatingQueryInstallable) {
						return Promise.resolve([
							remoteFailure(target, 'dependency-failed')
						]);
					}

					return Promise.resolve(
						target === libraryQueryInstallable ? [remoteResult('built')] : []
					);
				},
				resolveClosure: ownPathClosure,
				addTempRoot: (storePath) => {
					events.push(`root ${storePath}`);

					return Promise.resolve();
				}
			},
			[
				derivedPath(floatingQueryInstallable),
				derivedPath(libraryQueryInstallable)
			],
			(builds) => {
				events.push(`publish ${builds.map((build) => build.target).join(' ')}`);

				return Promise.resolve();
			}
		);

		await expect(run).rejects.toMatchObject({
			name: 'RemoteCohortBuildFailedError',
			failures: [
				{
					target: derivedPath(floatingQueryInstallable),
					outcome: 'dependency-failed',
					message: `could not build ${floatingQueryInstallable}`
				}
			]
		});

		expect(events).toStrictEqual([
			`root ${libraryBuiltPath}`,
			`root ${floatingBuiltPath}`,
			`build ${floatingQueryInstallable}`,
			`build ${libraryQueryInstallable}`,
			`root ${libraryBuiltPath}`,
			`publish ${libraryQueryInstallable}`
		]);
	});

	it('excludes duplicate and unexpected keyed results before publication', async () => {
		const results = [
			remoteResult('built'),
			remoteResult('built', floatingQueryInstallable, floatingBuiltPath),
			remoteResult(
				'substituted',
				floatingQueryInstallable,
				floatingDevelopmentPath
			),
			remoteResult('already-valid', appQueryInstallable, appPath)
		];
		const events: string[] = [];
		const run = buildAndRootNixResults(
			{
				readDerivation: (drvPath) => Promise.resolve(remoteDerivation(drvPath)),
				buildPathsWithResults: ([target]) =>
					Promise.resolve(
						target === libraryQueryInstallable
							? [results[0], results[3]].filter(
									(result): result is NixBuildResult => result !== undefined
								)
							: results.slice(1, 3)
					),
				resolveClosure: ownPathClosure,
				addTempRoot: (storePath) => {
					events.push(`root ${storePath}`);

					return Promise.resolve();
				}
			},
			[
				derivedPath(libraryQueryInstallable),
				derivedPath(floatingQueryInstallable)
			],
			(builds) => {
				events.push(`publish ${builds.map((build) => build.target).join(' ')}`);

				return Promise.resolve();
			}
		);

		await expect(run).rejects.toMatchObject({
			name: 'RemoteCohortProtocolError',
			failures: [
				{
					target: derivedPath(appQueryInstallable),
					outcome: 'unexpected-result',
					message: 'the daemon returned a result for an unrequested target'
				},
				{
					target: derivedPath(floatingQueryInstallable),
					outcome: 'duplicate-results',
					message: 'the daemon returned 2 results for this target'
				}
			]
		});
		expect(events).toStrictEqual([
			`root ${libraryBuiltPath}`,
			`root ${floatingBuiltPath}`,
			`root ${libraryBuiltPath}`,
			`publish ${libraryQueryInstallable}`
		]);
	});

	it('refuses an all-failed batch without rooting or publishing', async () => {
		const events: string[] = [];
		const run = buildAndRootNixResults(
			{
				readDerivation: (drvPath) => Promise.resolve(remoteDerivation(drvPath)),
				buildPathsWithResults: ([target]) =>
					Promise.resolve([
						target === floatingQueryInstallable
							? remoteFailure(target, 'dependency-failed')
							: remoteFailure()
					]),
				resolveClosure: ownPathClosure,
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
		expect(events).toStrictEqual([
			`root ${libraryBuiltPath}`,
			`root ${floatingBuiltPath}`,
			'publish'
		]);
	});

	it('refuses a floating output before starting the remote build', async () => {
		const events: string[] = [];
		const run = buildAndRootNixResults(
			{
				readDerivation: () =>
					Promise.resolve(
						'Derive([("out","","sha256","")],[],[],"x86_64-linux","/bin/sh",[],[])'
					),
				addTempRoot: () => {
					events.push('root');

					return Promise.resolve();
				},
				resolveClosure: ownPathClosure,
				buildPathsWithResults: () => {
					events.push('build');

					return Promise.resolve([]);
				}
			},
			[derivedPath(floatingQueryInstallable)],
			() => Promise.resolve()
		);

		await expect(run).rejects.toMatchObject({
			name: 'InvalidInputError',
			input: 'cohort-json'
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
					publishByReference: [],
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

// Returns independently configured results for the plan and re-probe commands.
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
	// Intentionally empty test callback.
}

// Records every warning emitted through the reporter test double.
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

	it.each([
		{ name: 'the local store', store: undefined },
		{
			name: 'a non-publishing remote store',
			store: 'ssh-ng://build@example.test'
		}
	])(
		'materialises planned derivations under temp roots before planning against $name',
		async ({ store }) => {
			const sequence: string[] = [];
			const plan = cupboardStub({
				plan: planCohortSuccess(measuredCapacity, []),
				reprobe: planReprobeSuccess([], [])
			});
			const runCupboardMock = vi.fn<typeof runCupboard>(
				(binaryPath, arguments_, passedEnvironment, dependencies) => {
					sequence.push(`plan ${arguments_[2] ?? ''}`);

					return plan(binaryPath, arguments_, passedEnvironment, dependencies);
				}
			);
			const runNixDerivationShow = vi.fn(
				(
					installables: readonly string[],
					_signal?: AbortSignal,
					isRecursive = true
				) => {
					sequence.push(
						`evaluate ${isRecursive ? 'recursive' : 'root'} ${installables.join(',')}`
					);

					return Promise.resolve(evaluatedDerivations(installables));
				}
			);
			const materialiseGraph = (
				installables: readonly string[]
			): Promise<void> => {
				sequence.push(`materialise ${installables.join(',')}`);

				return Promise.resolve();
			};
			const withLocalDerivationRoots: WithLocalDerivationRoots = async (
				derivations,
				use
			) => {
				sequence.push(`root ${derivations.join(',')}`);

				const result = await use();

				sequence.push('unroot');

				return result;
			};

			await buildCohortAction(
				{
					...baseOptions(),
					cohortJson: cohortJson({
						attrs: ['.#packages.x86_64-linux.app'],
						installables: ['.#packages.x86_64-linux.app^out'],
						queryInstallables: [appQueryInstallable],
						expectedPaths: [appPath],
						roots: ['github:owner/repo/main/app']
					}),
					...(store !== undefined && { store })
				},
				environment,
				{
					runCupboard: runCupboardMock,
					runNixDerivationShow,
					materialiseDerivationGraph: materialiseGraph,
					withLocalDerivationRoots
				}
			);

			// The roots must span planning and the build: a daemon running
			// automatic GC may otherwise collect the materialised derivations
			// before they are used.
			expect(sequence).toStrictEqual([
				'root /nix/store/0123456789abcdfghijklmnpqrsvwxyz-app.drv',
				'materialise .#packages.x86_64-linux.app^out',
				'evaluate root .#packages.x86_64-linux.app^out',
				'plan cohort',
				'unroot'
			]);
		}
	);

	it('drives the partition from a single plan-cohort invocation and writes structural outputs', async () => {
		const runCupboardMock = vi.fn<typeof runCupboard>(cupboardStub());
		const runNixBuild = vi.fn((_installables: readonly string[]) =>
			Promise.resolve({
				paths: [libraryBuiltPath, floatingBuiltPath],
				status: 0
			})
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
			outLinkDirectory(directory),
			undefined
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
			referencePaths: '',
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
			name: 'does',
			requireProvenance: 'true',
			attested: ['--require-attested']
		},
		{
			name: 'does not',
			requireProvenance: 'false',
			attested: []
		}
	])(
		'a run that $name require provenance asks the plan for attested availability',
		async ({ requireProvenance, attested }) => {
			const calls: (readonly string[])[] = [];
			const runCupboardMock = vi.fn<typeof runCupboard>(
				(binaryPath, arguments_, passedEnvironment) => {
					calls.push(arguments_);

					return cupboardStub()(binaryPath, arguments_, passedEnvironment);
				}
			);

			await buildCohortAction(
				{ ...baseOptions(), requireProvenance },
				environment,
				{
					runCupboard: runCupboardMock,
					runNixBuild: vi.fn(() =>
						Promise.resolve({ paths: [libraryBuiltPath], status: 0 })
					)
				}
			);

			expect(
				calls.find((arguments_) => arguments_[1] === 'plan')
			).toStrictEqual([
				'--no-colour',
				'plan',
				'cohort',
				'https://cache.example.test/t/acme',
				'--targets-file',
				path.join(
					directory,
					'cupboard-plan-cohort-targets-cohort-x86_64-linux-ubuntu-latest-remote-abc123.json'
				),
				'--plan-file',
				path.join(
					directory,
					'cupboard-plan-cohort-cohort-x86_64-linux-ubuntu-latest-remote-abc123.json'
				),
				'--github-oidc',
				...attested
			]);
		}
	);

	// The plan moves any served path without an attestation into the build set,
	// so the action builds that set and leaves the attached targets alone.
	it('builds only the plan build set when the run requires provenance', async () => {
		const runNixBuild = vi.fn((installables: readonly string[]) =>
			Promise.resolve({
				paths: installables.includes(libraryQueryInstallable)
					? [libraryBuiltPath]
					: [],
				status: 0
			})
		);

		await buildCohortAction(
			{
				...baseOptions(),
				cohortJson: remotelyQueryableCohortJson(),
				requireProvenance: 'true'
			},
			environment,
			{ runCupboard: vi.fn<typeof runCupboard>(cupboardStub()), runNixBuild }
		);

		const inputs = resolveBuildCohortInputs(baseOptions(), environment);
		const targetPaths = await readFile(inputs.targetPathsFile, 'utf8');

		expect({
			builtInstallables: runNixBuild.mock.calls.map((call) => call[0]),
			targetPaths: targetPaths.trim().split('\n')
		}).toStrictEqual({
			builtInstallables: [[libraryQueryInstallable]],
			targetPaths: [appPath, libraryBuiltPath]
		});
	});

	it.each([
		{ name: 'ordinary publication', requireProvenance: false },
		{ name: 'provenance publication', requireProvenance: true }
	])(
		'resolves a streamed multi-output survivor after a sibling fails during $name',
		async ({ requireProvenance }) => {
			const dependencyPath = storePathSchema.parse(
				'/nix/store/5123456789abcdfghijklmnpqrsvwxyz-dependency'
			);
			const multiOutputInstallable = '.#packages.x86_64-linux.floating^out,dev';
			const multiOutputQueryInstallable =
				'/nix/store/4123456789abcdfghijklmnpqrsvwxyz-float.drv^out,dev';
			const runNixBuild = vi.fn((installables: readonly string[]) => {
				if (installables[0] === multiOutputInstallable) {
					return Promise.resolve({
						paths: [floatingBuiltPath, floatingDevelopmentPath],
						status: 0
					});
				}

				return Promise.reject(
					new Error('the failed target must not be rebuilt')
				);
			});
			const calls: (readonly string[])[] = [];
			const runCupboardMock = vi.fn<typeof runCupboard>(
				async (binaryPath, arguments_, passedEnvironment) => {
					calls.push(arguments_);

					if (arguments_[1] !== 'build-push') {
						return cupboardStub({
							plan: planCohortSuccess(measuredCapacity, [
								libraryQueryInstallable,
								multiOutputQueryInstallable
							]),
							reprobe: planReprobeSuccess(
								[],
								[libraryQueryInstallable, multiOutputQueryInstallable]
							)
						})(binaryPath, arguments_, passedEnvironment);
					}

					const receiptFile =
						arguments_[arguments_.indexOf('--receipt-file') + 1] ?? '';
					const subjects = requireProvenance
						? [floatingBuiltPath, floatingDevelopmentPath].map((storePath) => ({
								storePath,
								narHash: 'aa'.repeat(32),
								derivation:
									'/nix/store/4123456789abcdfghijklmnpqrsvwxyz-float.drv',
								buildStore: 'auto',
								verification: 'local'
							}))
						: [
								{
									storePath: dependencyPath,
									narHash: 'bb'.repeat(32),
									derivation:
										'/nix/store/6123456789abcdfghijklmnpqrsvwxyz-dependency.drv',
									buildStore: 'auto',
									verification: 'local'
								}
							];
					await writeFile(
						receiptFile,
						`${JSON.stringify({
							version: 3,
							paths: [
								floatingBuiltPath,
								floatingDevelopmentPath,
								dependencyPath
							],
							subjects,
							childExitStatus: 1,
							terminalFailure: {
								kind: 'target-build',
								failedTargets: [libraryQueryInstallable]
							}
						})}\n`
					);

					throw new CupboardReportedError(1, [], undefined, true);
				}
			);

			await buildCohortAction(
				{
					...baseOptions(),
					cohortJson: remotelyQueryableCohortJson({
						installables: [
							'.#packages.x86_64-linux.app^out',
							'.#packages.x86_64-linux.lib^out',
							multiOutputInstallable
						],
						queryInstallables: [
							appQueryInstallable,
							libraryQueryInstallable,
							multiOutputQueryInstallable
						]
					}),
					push: 'true',
					bestEffort: 'true',
					...(requireProvenance && { requireProvenance: 'true' })
				},
				environment,
				{ runCupboard: runCupboardMock, runNixBuild }
			);
			const inputs = resolveBuildCohortInputs(baseOptions(), environment);
			const targetPaths = await readFile(inputs.targetPathsFile, 'utf8');

			expect({
				runNixBuildInstallables: runNixBuild.mock.calls.map((call) => call[0]),
				commands: calls.map((arguments_) => arguments_[1]),
				rootRetention: calls
					.filter((arguments_) => arguments_[1] === 'push')
					.map((arguments_) =>
						arguments_.includes('--root') ? 'root' : 'no-retain'
					),
				targetPaths: targetPaths.trim().split('\n')
			}).toStrictEqual({
				runNixBuildInstallables: [[multiOutputInstallable]],
				commands: ['plan', 'build-push', 'push', 'push'],
				rootRetention: ['root', 'root'],
				targetPaths: [appPath, floatingBuiltPath, floatingDevelopmentPath]
			});
		}
	);

	it('keeps a combined streamed build and publication failure fatal', async () => {
		const failure = new CupboardReportedError(1, [], undefined, true);
		const runCupboardMock = vi.fn<typeof runCupboard>(
			async (binaryPath, arguments_, passedEnvironment) => {
				if (arguments_[1] !== 'build-push') {
					return cupboardStub()(binaryPath, arguments_, passedEnvironment);
				}

				const receiptFile =
					arguments_[arguments_.indexOf('--receipt-file') + 1] ?? '';
				await writeFile(
					receiptFile,
					`${JSON.stringify({
						version: 3,
						paths: [],
						subjects: [],
						childExitStatus: 1,
						failed: [libraryBuiltPath]
					})}\n`
				);

				throw failure;
			}
		);

		await expect(
			buildCohortAction(
				{ ...baseOptions(), push: 'true', bestEffort: 'true' },
				environment,
				{ runCupboard: runCupboardMock }
			)
		).rejects.toBe(failure);
		expect(runCupboardMock.mock.calls.map((call) => call[1][1])).toStrictEqual([
			'plan',
			'build-push'
		]);
	});

	it('keeps an explicitly unclassified streamed command failure fatal', async () => {
		const failure = new CupboardReportedError(1, [], undefined, true);
		const runCupboardMock = vi.fn<typeof runCupboard>(
			async (binaryPath, arguments_, passedEnvironment) => {
				if (arguments_[1] !== 'build-push') {
					return cupboardStub()(binaryPath, arguments_, passedEnvironment);
				}

				const receiptFile =
					arguments_[arguments_.indexOf('--receipt-file') + 1] ?? '';
				await writeFile(
					receiptFile,
					`${JSON.stringify({
						version: 3,
						paths: [],
						subjects: [],
						childExitStatus: 1,
						terminalFailure: { kind: 'command' }
					})}\n`
				);

				throw failure;
			}
		);

		await expect(
			buildCohortAction(
				{ ...baseOptions(), push: 'true', bestEffort: 'true' },
				environment,
				{ runCupboard: runCupboardMock }
			)
		).rejects.toBe(failure);
	});

	it('settles successful local outputs before rejecting a mixed non-publishing build', async () => {
		const inputs = resolveBuildCohortInputs(baseOptions(), environment);
		const runCupboardMock = vi.fn<typeof runCupboard>(cupboardStub());
		const runNixBuild = vi.fn(() =>
			Promise.resolve({ paths: [libraryBuiltPath], status: 1 })
		);

		await expect(
			buildCohortAction(baseOptions(), environment, {
				runCupboard: runCupboardMock,
				runNixBuild
			})
		).rejects.toMatchObject({
			name: 'CommandFailedError',
			message: 'nix build failed with status 1'
		});

		const targetPaths = await readFile(inputs.targetPathsFile, 'utf8');

		expect(targetPaths.trim().split('\n')).toStrictEqual([
			appPath,
			libraryBuiltPath
		]);
	});

	it('fails a best-effort build-only cohort closed without structured target evidence', async () => {
		const warnings: string[] = [];
		const runNixBuild = vi.fn((_installables: readonly string[]) =>
			Promise.resolve({ paths: [libraryBuiltPath], status: 75 })
		);
		const runCupboardMock = vi.fn<typeof runCupboard>(cupboardStub());

		await expect(
			buildCohortAction(
				{ ...baseOptions(), bestEffort: 'true', push: 'false' },
				environment,
				{
					runCupboard: runCupboardMock,
					runNixBuild,
					reporter: recordingReporter(warnings)
				}
			)
		).rejects.toMatchObject({
			name: 'CommandFailedError',
			message: 'nix build failed with status 75'
		});

		expect({
			installables: runNixBuild.mock.calls.map((call) => call[0]),
			warnings
		}).toStrictEqual({
			installables: [
				[libraryQueryInstallable, '.#packages.x86_64-linux.floating^out']
			],
			warnings: []
		});
	});

	// Every non-publishing cohort materialises the planned derivations in
	// the runner's local store before planning: first the whole graph, with
	// its output discarded, then each root for the drift check. A remote
	// cohort needs them there too, because `nix build` reads the build
	// set's derivations from the local store and copies them to the remote
	// store itself.
	const prePlanMaterialisations = [
		['.#packages.x86_64-linux.app^out', '.#packages.x86_64-linux.lib^out']
	];
	const prePlanEvaluations = [
		{
			installables: ['.#packages.x86_64-linux.app^out'],
			isRecursive: false
		},
		{
			installables: ['.#packages.x86_64-linux.lib^out'],
			isRecursive: false
		}
	];

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
			Promise.resolve({
				paths: [libraryBuiltPath, floatingBuiltPath],
				status: 0
			})
		);
		const evaluated: {
			installables: readonly string[];
			isRecursive: boolean;
		}[] = [];
		const runNixDerivationShow = (
			installables: readonly string[],
			_signal?: AbortSignal,
			isRecursive = true
		): Promise<readonly StorePathString[]> => {
			evaluated.push({ installables, isRecursive });

			return Promise.resolve(evaluatedDerivations(installables));
		};
		const materialised: (readonly string[])[] = [];
		const materialiseGraph = (
			installables: readonly string[]
		): Promise<void> => {
			materialised.push(installables);

			return Promise.resolve();
		};
		const options: BuildCohortOptions = {
			...baseOptions(),
			...(store !== undefined && { store })
		};

		await buildCohortAction(options, environment, {
			runCupboard: runCupboardMock,
			runNixBuild,
			runNixDerivationShow,
			materialiseDerivationGraph: materialiseGraph,
			runNixCopy: vi.fn(() => Promise.resolve())
		});

		expect({ materialised, evaluated }).toStrictEqual({
			materialised: prePlanMaterialisations,
			evaluated: prePlanEvaluations
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
			outLinkDirectory(directory),
			undefined
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
		const runNixBuild = vi.fn(() => Promise.resolve({ paths: [], status: 0 }));

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
			outLinkDirectory(directory),
			undefined
		);
	});

	it('propagates a ceiling refusal, rendering the detail with the store the plan reported', async () => {
		const unknownPath =
			'/nix/store/5123456789abcdfghijklmnpqrsvwxyz-unknown.drv';
		const refusalData = {
			reason: 'unknown-paths-ceiling',
			unknownCount: 1,
			unknownPaths: [
				{
					path: unknownPath,
					cause: { kind: 'missing-derivation' },
					targets: [
						{
							attr: '.#packages.x86_64-linux.app',
							installable: appQueryInstallable
						}
					]
				}
			],
			store: { kind: 'daemon' },
			unreachableSubstituters: [],
			ceiling: { value: 0, source: 'configured' },
			downloadSize: 111,
			narSize: 222
		};
		const refusalEvents: readonly ReporterResultEvent[] = [
			{ kind: 'plan-cohort-refusal', data: refusalData }
		];
		const runCupboardMock = vi.fn<typeof runCupboard>(() =>
			Promise.reject(
				new CupboardReportedError(75, refusalEvents, undefined, true)
			)
		);
		const buildRuns: (readonly string[])[] = [];
		const runNixBuild = (installables: readonly string[]) => {
			buildRuns.push(installables);

			return Promise.resolve({ paths: [], status: 0 });
		};

		let error: unknown;

		try {
			await buildCohortAction(baseOptions(), environment, {
				runCupboard: runCupboardMock,
				runNixBuild
			});
		} catch (error_: unknown) {
			error = error_;
		}

		if (!(error instanceof CohortPlanRefusedError)) {
			expect.unreachable('the refusal must surface as CohortPlanRefusedError');
		}

		expect({
			exitCode: error.exitCode,
			message: error.message,
			buildRuns
		}).toStrictEqual({
			exitCode: 75,
			message: describeUnknownPathsRefusal(
				unknownPathsCeilingRefusalSchema.parse(refusalData)
			),
			buildRuns: []
		});
	});

	it('recognises a refusal from an older cupboard that reports no per-path detail', async () => {
		const refusalEvents: readonly ReporterResultEvent[] = [
			{
				kind: 'plan-cohort-refusal',
				data: {
					reason: 'unknown-paths-ceiling',
					unknownCount: 2,
					ceiling: { value: 0, source: 'configured' },
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
		const buildRuns: (readonly string[])[] = [];
		const runNixBuild = (installables: readonly string[]) => {
			buildRuns.push(installables);

			return Promise.resolve({ paths: [], status: 0 });
		};

		let error: unknown;

		try {
			await buildCohortAction(baseOptions(), environment, {
				runCupboard: runCupboardMock,
				runNixBuild
			});
		} catch (error_: unknown) {
			error = error_;
		}

		// The refusal classification, and with it the transient exit code,
		// must survive running against a cupboard that predates the per-path
		// detail.
		if (!(error instanceof CohortPlanRefusedError)) {
			expect.unreachable('the refusal must surface as CohortPlanRefusedError');
		}

		expect({
			exitCode: error.exitCode,
			buildRuns
		}).toStrictEqual({ exitCode: 75, buildRuns: [] });
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
		const runNixBuild = vi.fn(() => Promise.resolve({ paths: [], status: 0 }));

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
		const runNixBuild = vi.fn(() => Promise.resolve({ paths: [], status: 0 }));

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
		const runNixBuild = vi.fn(() => Promise.resolve({ paths: [], status: 0 }));

		await expect(
			buildCohortAction(baseOptions(), environment, {
				runCupboard: runCupboardMock,
				runNixBuild
			})
		).rejects.toBeInstanceOf(CohortPlanResultMissingError);
	});

	it('rejects a plan build set entry that is not a Nix derived path', async () => {
		const runCupboardMock = vi.fn<typeof runCupboard>(
			cupboardStub({
				plan: planCohortSuccess(measuredCapacity, ['.#packages.bad'])
			})
		);

		await expect(
			buildCohortAction(baseOptions(), environment, {
				runCupboard: runCupboardMock,
				runNixBuild: vi.fn(() => Promise.resolve({ paths: [], status: 0 }))
			})
		).rejects.toBeInstanceOf(CohortPlanResultInvalidError);
	});
});

// Both queryable members have expected outputs for the re-probe tests.
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
		// Model Nix returning one output path for each remaining installable.
		const builtPathOf = new Map([
			[libraryQueryInstallable, libraryBuiltPath],
			['.#packages.x86_64-linux.floating^out', floatingBuiltPath]
		]);
		const runNixBuild = vi.fn((installables: readonly string[]) =>
			Promise.resolve({
				paths: installables.flatMap((installable) => {
					const built = builtPathOf.get(installable);

					return built === undefined ? [] : [built];
				}),
				status: 0
			})
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

	it('re-probes only the build-set members with a known output path', async () => {
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
			referencePaths: []
		},
		{
			outcome: 'publishByReference',
			targetPaths: [appPath, floatingBuiltPath],
			referencePaths: [libraryBuiltPath]
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
						outLinkDirectory(directory),
						undefined
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
					outLinkDirectory(directory),
					undefined
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

describe('provenanceRebuildInstallables', () => {
	it('rebuilds only targets the selected local build store already held', () => {
		expect(
			provenanceRebuildInstallables(
				{
					attachOnly: [appPath],
					publishByReference: [],
					leftUpstream: [],
					alreadyValid: [appPath, libraryBuiltPath],
					buildSet: [
						derivedPath(appQueryInstallable),
						derivedPath(libraryQueryInstallable)
					],
					counts: { willBuild: 1, willSubstitute: 0, unknown: 0 },
					downloadSize: 0,
					narSize: 0,
					unknownCount: 0,
					ceiling: { value: 0, source: 'configured' }
				},
				[
					{
						attr: 'app',
						installable: '.#app',
						queryInstallable: appQueryInstallable,
						expectedPath: appPath,
						root: 'app'
					},
					{
						attr: 'library',
						installable: '.#library',
						queryInstallable: libraryQueryInstallable,
						expectedPath: libraryBuiltPath,
						root: 'library'
					}
				]
			)
		).toStrictEqual([appQueryInstallable, libraryQueryInstallable]);
	});

	it.each([
		{
			name: 'a selected multi-output derivation',
			queryInstallable:
				'/nix/store/4123456789abcdfghijklmnpqrsvwxyz-float.drv^out,dev'
		},
		{
			name: 'a floating-output derivation',
			queryInstallable: floatingQueryInstallable
		}
	])('rebuilds $name whose output path cannot be predicted', (row) => {
		expect(
			provenanceRebuildInstallables(
				{
					attachOnly: [],
					publishByReference: [],
					leftUpstream: [],
					alreadyValid: [],
					buildSet: [derivedPath(row.queryInstallable)],
					counts: { willBuild: 1, willSubstitute: 0, unknown: 1 },
					downloadSize: 0,
					narSize: 0,
					unknownCount: 1,
					ceiling: { value: 0, source: 'configured' }
				},
				[
					{
						attr: 'target',
						installable: '.#target',
						queryInstallable: row.queryInstallable,
						root: 'target'
					}
				]
			)
		).toStrictEqual([
			canonicalNixDerivedPath(derivedPath(row.queryInstallable))
		]);
	});
});

describe('receiptAlreadyHeldPaths', () => {
	it.each([
		{
			name: 'keeps a path this run does not claim',
			alreadyValid: [appPath, libraryBuiltPath],
			claimable: [],
			expected: [appPath, libraryBuiltPath]
		},
		{
			name: 'drops a rebuilt path this run claims',
			alreadyValid: [appPath, libraryBuiltPath],
			claimable: [libraryBuiltPath],
			expected: [appPath]
		},
		{
			name: 'returns an empty list when the store held nothing before the build',
			alreadyValid: [],
			claimable: [libraryBuiltPath],
			expected: []
		}
	])('$name', ({ alreadyValid, claimable, expected }) => {
		expect(receiptAlreadyHeldPaths(alreadyValid, claimable)).toStrictEqual(
			expected
		);
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
				{
					root: 'github:owner/repo/main/app',
					paths: [appPath],
					referencePaths: [],
					complete: true
				},
				{
					root: 'github:owner/repo/main/lib',
					paths: [libraryBuiltPath],
					referencePaths: [],
					complete: true
				}
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
			expected: [
				{
					root: 'github:owner/repo/main/app',
					paths: [appPath],
					referencePaths: [],
					complete: true
				}
			]
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

	it('keeps a locally resolved floating output with its declared root', () => {
		const ownedMembers = members.map((member) =>
			member.attr === 'floating'
				? { ...member, root: 'github:owner/repo/main/floating' }
				: member
		);

		expect(
			rootGroups(
				ownedMembers,
				[
					'github:owner/repo/main/app',
					'github:owner/repo/main/lib',
					'github:owner/repo/main/floating'
				],
				[appPath, libraryBuiltPath, floatingBuiltPath],
				{
					localBuilds: [
						{
							installable: '.#floating^out',
							outputs: [floatingBuiltPath]
						}
					]
				}
			)
		).toStrictEqual([
			{
				root: 'github:owner/repo/main/app',
				paths: [appPath],
				referencePaths: [],
				complete: true
			},
			{
				root: 'github:owner/repo/main/lib',
				paths: [libraryBuiltPath],
				referencePaths: [],
				complete: true
			},
			{
				root: 'github:owner/repo/main/floating',
				paths: [floatingBuiltPath],
				referencePaths: [],
				complete: true
			}
		]);
	});

	it('keeps all-reference roots and their exact reference paths', () => {
		expect(
			rootGroups(
				members,
				members.map((member) => member.root),
				[appPath, libraryBuiltPath],
				{
					referencePaths: [appPath, libraryBuiltPath]
				}
			)
		).toStrictEqual([
			{
				root: 'github:owner/repo/main/app',
				paths: [appPath],
				referencePaths: [appPath],
				complete: true
			},
			{
				root: 'github:owner/repo/main/lib',
				paths: [libraryBuiltPath],
				referencePaths: [libraryBuiltPath],
				complete: true
			}
		]);
	});

	it('marks a shared root incomplete when one declared member failed', () => {
		const sharedRoot = 'github:owner/repo/main/shared';
		const sharedMembers = members.map((member) => ({
			...member,
			root: sharedRoot
		}));

		expect(
			rootGroups(
				sharedMembers,
				[sharedRoot, sharedRoot, sharedRoot],
				[appPath],
				{
					incompleteRoots: new Set([sharedRoot])
				}
			)
		).toStrictEqual([
			{
				root: sharedRoot,
				paths: [appPath],
				referencePaths: [],
				complete: false
			}
		]);

		const [group] = rootGroups(
			sharedMembers,
			[sharedRoot, sharedRoot, sharedRoot],
			[appPath],
			{ incompleteRoots: new Set([sharedRoot]) }
		);

		if (group === undefined) {
			throw new Error('Expected the surviving shared-root group');
		}
		const inputs = resolveBuildCohortInputs(
			{ ...baseOptions(), push: 'true', ttl: '7d' },
			{ RUNNER_TEMP: '/tmp' }
		);

		expect(
			cohortPushArguments(inputs, group, {
				intermediatePathsFile: '',
				referencePathsFile: '',
				referenceSource: ''
			})
		).toStrictEqual([
			'--no-colour',
			'push',
			'https://cache.example.test/t/acme',
			appPath,
			'--github-oidc',
			'--no-retain'
		]);
	});

	it('keeps a complete all-left-upstream root as an empty replacement', () => {
		const upstreamRoot = 'github:owner/repo/main/upstream';
		const upstreamMembers = [
			{
				attr: 'upstream',
				installable: '.#upstream^out',
				expectedPath: leftUpstreamPath,
				root: upstreamRoot
			}
		];

		expect(
			rootGroups(upstreamMembers, [upstreamRoot], [], {
				leftUpstreamPaths: [leftUpstreamPath]
			})
		).toStrictEqual([
			{
				root: upstreamRoot,
				paths: [],
				referencePaths: [],
				complete: true
			}
		]);
	});

	it('keeps only destination paths in a mixed left-upstream root', () => {
		const sharedRoot = 'github:owner/repo/main/shared';
		const sharedMembers = members.slice(0, 2).map((member) => ({
			...member,
			root: sharedRoot
		}));

		expect(
			rootGroups(sharedMembers, [sharedRoot, sharedRoot], [appPath], {
				leftUpstreamPaths: [libraryBuiltPath]
			})
		).toStrictEqual([
			{
				root: sharedRoot,
				paths: [appPath],
				referencePaths: [],
				complete: true
			}
		]);
	});

	it('drops an incomplete all-left-upstream root to preserve its generation', () => {
		const upstreamRoot = 'github:owner/repo/main/upstream';
		const upstreamMembers = [
			{
				attr: 'upstream',
				installable: '.#upstream^out',
				expectedPath: leftUpstreamPath,
				root: upstreamRoot
			}
		];

		expect(
			rootGroups(upstreamMembers, [upstreamRoot], [], {
				leftUpstreamPaths: [leftUpstreamPath],
				incompleteRoots: new Set([upstreamRoot])
			})
		).toStrictEqual([]);
	});

	it('threads private read credentials into reference-only root publication', () => {
		const inputs = resolveBuildCohortInputs(
			{
				...baseOptions(),
				push: 'true',
				readUser: 'reader',
				readPassword: 'secret'
			},
			{ RUNNER_TEMP: '/tmp' }
		);

		const arguments_ = cohortPushArguments(
			inputs,
			{
				root: 'github:owner/repo/main/app',
				paths: [appPath],
				referencePaths: [appPath],
				complete: true
			},
			{
				intermediatePathsFile: '',
				referencePathsFile: '/tmp/reference-paths',
				referenceSource: 'https://cache.example.test/t/acme/reuse/private'
			}
		);

		expect(arguments_.slice(-4)).toStrictEqual([
			'--read-user',
			'reader',
			'--read-password',
			'secret'
		]);
	});

	it('keeps floating and multi-output remote paths with their keyed target root', () => {
		const ownedMembers = members.map((member) =>
			member.attr === 'floating'
				? {
						...member,
						queryInstallable: floatingQueryInstallable,
						root: 'github:owner/repo/main/floating'
					}
				: member
		);
		const results: readonly NixBuildResult[] = [
			{
				...remoteResult('built', floatingQueryInstallable, floatingBuiltPath),
				outcome: {
					kind: 'built',
					outputs: {
						out: storePathSchema.parse(floatingBuiltPath),
						dev: storePathSchema.parse(floatingDevelopmentPath)
					}
				}
			}
		];

		expect(
			rootGroups(
				ownedMembers,
				[
					'github:owner/repo/main/app',
					'github:owner/repo/main/lib',
					'github:owner/repo/main/floating'
				],
				[appPath, floatingBuiltPath, floatingDevelopmentPath],
				{ resultBuilds: results }
			)
		).toStrictEqual([
			{
				root: 'github:owner/repo/main/app',
				paths: [appPath],
				referencePaths: [],
				complete: true
			},
			{
				root: 'github:owner/repo/main/floating',
				paths: [floatingBuiltPath, floatingDevelopmentPath],
				referencePaths: [],
				complete: true
			}
		]);
	});

	it('assigns one remote result to every alias root that owns its target', () => {
		const aliases = [
			{
				attr: 'stable',
				installable: '.#lib^out',
				queryInstallable: libraryQueryInstallable,
				root: 'github:owner/repo/stable'
			},
			{
				attr: 'latest',
				installable: '.#lib^out',
				queryInstallable: libraryQueryInstallable,
				root: 'github:owner/repo/latest'
			}
		];

		expect(
			rootGroups(
				aliases,
				aliases.map((member) => member.root),
				[libraryBuiltPath],
				{ resultBuilds: [remoteResult('built')] }
			)
		).toStrictEqual([
			{
				root: 'github:owner/repo/stable',
				paths: [libraryBuiltPath],
				referencePaths: [],
				complete: true
			},
			{
				root: 'github:owner/repo/latest',
				paths: [libraryBuiltPath],
				referencePaths: [],
				complete: true
			}
		]);
	});
});

describe('cohort pushes accepted by the real CLI parser', () => {
	it.each([
		{
			name: 'all-attach-only',
			group: {
				root: 'github:owner/repo/main/app',
				paths: [],
				referencePaths: [],
				complete: true
			},
			referenceSource: canonicalHref(
				new URL('https://cache.example.test/t/acme')
			)
		},
		{
			name: 'mixed-reference pre-push',
			group: {
				root: 'github:owner/repo/main/app',
				paths: [],
				referencePaths: [appPath],
				complete: false
			},
			referenceSource: 'https://cache.example.test/t/acme/reuse/pr-view'
		}
	])(
		'accepts the zero-positional $name form',
		async ({ group, referenceSource }) => {
			const inputs = resolveBuildCohortInputs(
				{ ...baseOptions(), push: 'true' },
				{ RUNNER_TEMP: '/tmp' }
			);
			const arguments_ = cohortPushArguments(inputs, group, {
				intermediatePathsFile: '',
				referencePathsFile: '/tmp/reference-paths',
				referenceSource
			});

			await expect(parsePushWithRealCli(arguments_)).resolves.toBeUndefined();
		}
	);
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
		readonly warnings: readonly string[];
		readonly remoteConnection: {
			readonly signal: AbortSignal;
			readonly lifecycle: readonly string[];
			readonly sequence: readonly string[];
			readonly evaluationCalls: readonly (readonly unknown[])[];
			readonly copyCalls: readonly (readonly unknown[])[];
			readonly didEvaluationReceiveSignal: boolean;
			readonly didCopyReceiveSignal: boolean;
			readonly didBuildReceiveSignal: boolean;
			readonly didProtectionReceiveSignal: boolean;
			readonly cupboardCalls: readonly {
				readonly command: string | undefined;
				readonly open: boolean;
			}[];
		};
	}

	async function runPublicationFlow(
		options: BuildCohortOptions,
		builtPaths: readonly string[] = [libraryBuiltPath, floatingBuiltPath],
		results: readonly NixBuildResult[] = [remoteResult('built')],
		plannedBuildSet: readonly string[] = [libraryQueryInstallable],
		publicationPaths?: readonly string[]
	): Promise<PublicationRun> {
		const calls: (readonly string[])[] = [];
		const lifecycle: string[] = [];
		const sequence: string[] = [];
		const warnings: string[] = [];
		const signal = new AbortController().signal;
		const cupboardCalls: {
			readonly command: string | undefined;
			readonly open: boolean;
		}[] = [];
		let isRemoteConnectionOpen = false;
		const runCupboardMock = vi.fn<typeof runCupboard>(
			async (_binaryPath, arguments_) => {
				calls.push(arguments_);
				cupboardCalls.push({
					command: arguments_[1],
					open: isRemoteConnectionOpen
				});

				if (isRemoteConnectionOpen && arguments_[1] === 'push') {
					sequence.push('publish');
				}

				if (arguments_[1] === 'plan') {
					sequence.push('plan');
				}

				const receiptIndex = arguments_.indexOf('--receipt-file');

				if (receiptIndex !== -1 && arguments_[1] === 'push') {
					const firstOption = arguments_.findIndex(
						(argument, index) => index >= 3 && argument.startsWith('--')
					);
					const receiptFile = arguments_[receiptIndex + 1] ?? '';
					const paths = arguments_.slice(
						3,
						firstOption === -1 ? arguments_.length : firstOption
					);
					// cupboard claims exactly the paths the push declared
					// claimable, so this double writes a receipt with a subject
					// for each of them.
					const subjects = arguments_.flatMap((argument, index) =>
						argument === '--claimable'
							? [
									{
										storePath: arguments_[index + 1] ?? '',
										narHash: 'aa'.repeat(32),
										derivation: `${arguments_[index + 1] ?? ''}.drv`,
										buildStore: 'auto',
										verification: 'local'
									}
								]
							: []
					);
					await writeFile(
						receiptFile,
						`${JSON.stringify({ version: 3, paths, subjects })}\n`
					);
				}

				return cupboardStub({
					plan: planCohortSuccess(measuredCapacity, plannedBuildSet),
					reprobe: planReprobeSuccess([], plannedBuildSet)
				})(_binaryPath, arguments_, environment);
			}
		);
		const localOutputs = new Map<string, readonly string[]>([
			['.#packages.x86_64-linux.app^out', [appPath]],
			['.#packages.x86_64-linux.lib^out', [libraryBuiltPath]],
			[
				'.#packages.x86_64-linux.multi^out,dev',
				[libraryBuiltPath, referencePath]
			],
			['.#packages.x86_64-linux.floating^out', [floatingBuiltPath]]
		]);
		const runNixBuild = vi.fn((installables: readonly string[]) =>
			Promise.resolve({
				paths:
					installables.length === 1
						? [...(localOutputs.get(installables[0] ?? '') ?? [])]
						: [...builtPaths],
				status: 0
			})
		);
		let didEvaluationReceiveSignal = false;
		const runNixDerivationShow = vi.fn(
			(installables: readonly string[], receivedSignal?: AbortSignal) => {
				didEvaluationReceiveSignal = receivedSignal === signal;
				sequence.push('evaluate');

				return Promise.resolve(
					installables.map((installable) =>
						storePathSchema.parse(
							installable.includes('.app')
								? '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app.drv'
								: installable.includes('.lib') || installable.includes('.multi')
									? '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib.drv'
									: '/nix/store/4123456789abcdfghijklmnpqrsvwxyz-float.drv'
						)
					)
				);
			}
		);
		const materialiseGraph = (
			_installables: readonly string[]
		): Promise<void> => {
			sequence.push('materialise');

			return Promise.resolve();
		};
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
		let didProtectionReceiveSignal = false;
		const withLocalDerivationRoots: WithLocalDerivationRoots = async (
			derivations,
			use,
			receivedSignal
		) => {
			didProtectionReceiveSignal = receivedSignal === signal;
			sequence.push('local session');

			const uniqueDerivations = new Set(derivations);

			for (const derivation of uniqueDerivations) {
				sequence.push(`local root ${derivation}`);
			}

			try {
				return await use();
			} finally {
				sequence.push('local closed');
			}
		};
		const runNixBuildWithResults = vi.fn(
			async (
				installables: readonly NixDerivedPathString[],
				_maxJobs: string,
				_store: string,
				publish?: (
					builds: readonly NixBuildResult[],
					failures: readonly RemoteCohortBuildFailure[],
					publicationPaths: readonly StorePathString[],
					provenanceRebuilds: ReadonlySet<NixDerivedPathString>
				) => Promise<void>,
				receivedSignal?: AbortSignal,
				preparation?: RemoteDerivationPreparation
			) => {
				if (publish === undefined) {
					throw new Error('Remote build publication callback is missing');
				}

				didBuildReceiveSignal = receivedSignal === signal;
				isRemoteConnectionOpen = true;
				lifecycle.push('opened');
				sequence.push('session');

				try {
					await buildAndRootNixResults(
						{
							readDerivation: (drvPath) =>
								Promise.resolve(remoteDerivation(drvPath)),
							buildPathsWithResults: (targets) => {
								const requested = new Set(
									targets.map((target) => canonicalNixDerivedPath(target))
								);

								return Promise.resolve(
									results.filter((result) =>
										requested.has(canonicalNixDerivedPath(result.target))
									)
								);
							},
							queryValidPaths: () => Promise.resolve([]),
							resolveClosure: (storePaths) =>
								Promise.resolve(
									(publicationPaths ?? storePaths).map((storePath) =>
										remotePathInfo(storePath)
									)
								),
							addTempRoot: () => Promise.resolve()
						},
						installables,
						publish,
						preparation
					);
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
			materialiseDerivationGraph: materialiseGraph,
			runNixCopy,
			withLocalDerivationRoots,
			reporter: recordingReporter(warnings),
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
			warnings,
			remoteConnection: {
				signal,
				lifecycle,
				sequence,
				evaluationCalls: runNixDerivationShow.mock.calls,
				copyCalls: runNixCopy.mock.calls,
				didEvaluationReceiveSignal,
				didCopyReceiveSignal,
				didBuildReceiveSignal,
				didProtectionReceiveSignal,
				cupboardCalls
			}
		};
	}

	// The caller removes this directory after publication to release the GC
	// roots, so the action must return its path.
	it('reports the directory holding the out-links that root its targets', async () => {
		const outputFile = path.join(directory, 'github-output');
		const runNixBuild = vi.fn(() =>
			Promise.resolve({ paths: [libraryBuiltPath], status: 0 })
		);

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

	it('rebuilds queryable targets whose output paths cannot be predicted under supervision', async () => {
		const multiOutputQueryInstallable =
			'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib.drv^dev,out';
		const options: BuildCohortOptions = {
			...baseOptions(),
			cohortJson: cohortJson({
				attrs: [
					'.#packages.x86_64-linux.app',
					'.#packages.x86_64-linux.multi',
					'.#packages.x86_64-linux.floating'
				],
				installables: [
					'.#packages.x86_64-linux.app^out',
					'.#packages.x86_64-linux.multi^out,dev',
					'.#packages.x86_64-linux.floating^out'
				],
				queryInstallables: [
					appQueryInstallable,
					multiOutputQueryInstallable,
					floatingQueryInstallable
				],
				expectedPaths: [appPath, undefined, undefined],
				roots: [
					'github:owner/repo/main/app',
					'github:owner/repo/main/multi',
					'github:owner/repo/main/floating'
				]
			}),
			push: 'true',
			requireProvenance: 'true'
		};
		const unpredictableInstallables = [
			multiOutputQueryInstallable,
			floatingQueryInstallable
		];
		const installables = [appQueryInstallable, ...unpredictableInstallables];
		const run = await runPublicationFlow(
			options,
			[appPath, libraryBuiltPath, referencePath, floatingBuiltPath],
			[],
			installables
		);

		expect({
			cohortsFile: run.cohortsFile,
			nixBuilds: run.nixBuilds.map((call) => call.slice(0, 4))
		}).toStrictEqual({
			cohortsFile: {
				cohorts: [
					{
						installables,
						rebuild: true,
						requireProvenance: true,
						keepGoing: true
					}
				]
			},
			nixBuilds: [
				[installables, '', '', outLinkDirectory(directory)],
				[
					['.#packages.x86_64-linux.multi^out,dev'],
					'',
					'',
					path.join(outLinkDirectory(directory), 'owners', '0')
				],
				[
					['.#packages.x86_64-linux.floating^out'],
					'',
					'',
					path.join(outLinkDirectory(directory), 'owners', '1')
				]
			]
		});
	});

	it("publishes an all-reference cohort under each path's exact root", async () => {
		const allReferences = [appPath, libraryBuiltPath, floatingBuiltPath];
		const plan: readonly ReporterResultEvent[] = [
			{
				kind: 'plan-cohort',
				data: {
					partition: {
						attachOnly: [],
						publishByReference: allReferences,
						leftUpstream: [leftUpstreamPath],
						alreadyValid: allReferences,
						buildSet: [],
						counts: { willBuild: 0, willSubstitute: 0, unknown: 0 },
						downloadSize: 0,
						narSize: 0,
						unknownCount: 0,
						ceiling: { value: 5, source: 'configured' }
					},
					capacity: measuredCapacity
				}
			}
		];
		const runCupboardMock = vi.fn<typeof runCupboard>(
			cupboardStub({
				plan,
				reprobe: planReprobeSuccess([], [])
			})
		);
		const options: BuildCohortOptions = {
			...baseOptions(),
			cohortJson: remotelyQueryableCohortJson({
				expectedPaths: allReferences
			}),
			push: 'true',
			reuseView: 'pr-view'
		};

		await buildCohortAction(options, environment, {
			runCupboard: runCupboardMock,
			runNixBuild: vi.fn(() => Promise.resolve({ paths: [], status: 0 }))
		});

		const inputs = resolveBuildCohortInputs(options, environment);
		const pushCalls = runCupboardMock.mock.calls
			.map((call) => call[1])
			.filter((arguments_) => arguments_[1] === 'push');
		const referenceFiles = await Promise.all(
			allReferences.map((_reference, index) =>
				readFile(`${inputs.referencePathsFile}.${String(index)}`, 'utf8')
			)
		);

		expect({ pushCalls, referenceFiles }).toStrictEqual({
			pushCalls: allReferences.map((reference, index) => [
				'--no-colour',
				'push',
				url,
				reference,
				'--github-oidc',
				'--root',
				[
					'github:owner/repo/main/app',
					'github:owner/repo/main/lib',
					'github:owner/repo/main/floating'
				][index],
				'--reference-paths-file',
				`${inputs.referencePathsFile}.${String(index)}`,
				'--reference-source',
				`${url}/reuse/pr-view`
			]),
			referenceFiles: allReferences.map((reference) => `${reference}\n`)
		});
	});

	it('replaces every complete all-left-upstream root with an empty target list', async () => {
		const upstreamPaths = [appPath, libraryBuiltPath, floatingBuiltPath];
		const plan: readonly ReporterResultEvent[] = [
			{
				kind: 'plan-cohort',
				data: {
					partition: {
						attachOnly: [],
						publishByReference: [],
						leftUpstream: upstreamPaths,
						alreadyValid: upstreamPaths,
						buildSet: [],
						counts: { willBuild: 0, willSubstitute: 0, unknown: 0 },
						downloadSize: 0,
						narSize: 0,
						unknownCount: 0,
						ceiling: { value: 5, source: 'configured' }
					},
					capacity: measuredCapacity
				}
			}
		];
		const runCupboardMock = vi.fn<typeof runCupboard>(
			cupboardStub({
				plan,
				reprobe: planReprobeSuccess([], [])
			})
		);
		const options: BuildCohortOptions = {
			...baseOptions(),
			cohortJson: remotelyQueryableCohortJson({
				expectedPaths: upstreamPaths
			}),
			push: 'true'
		};

		await buildCohortAction(options, environment, {
			runCupboard: runCupboardMock,
			runNixBuild: vi.fn(() => Promise.resolve({ paths: [], status: 0 }))
		});

		const pushCalls = runCupboardMock.mock.calls
			.map((call) => call[1])
			.filter((arguments_) => arguments_[1] === 'push');

		expect(pushCalls).toStrictEqual(
			[
				'github:owner/repo/main/app',
				'github:owner/repo/main/lib',
				'github:owner/repo/main/floating'
			].map((root) => [
				'--no-colour',
				'push',
				url,
				'--github-oidc',
				'--root',
				root
			])
		);
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
					'--aggregate-receipt-v3',
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
					'--github-oidc',
					'--root',
					'github:owner/repo/main/app',
					'--cache',
					'builds',
					'--ttl',
					'7d',
					'--reference-paths-file',
					`${path.join(directory, 'cupboard-cohort-reference-paths.txt')}.destination.0`,
					'--reference-source',
					`${url}/cache/builds`,
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
				],
				[
					'--no-colour',
					'push',
					url,
					floatingBuiltPath,
					'--github-oidc',
					'--root',
					'github:owner/repo/main/floating',
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
					outLinkDirectory(directory),
					run.remoteConnection.signal
				],
				[
					['.#packages.x86_64-linux.floating^out'],
					'0',
					'',
					path.join(outLinkDirectory(directory), 'owners', '0'),
					run.remoteConnection.signal
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

	it('does not evaluate, copy, or open a remote store for an all-no-build partition', async () => {
		const runNixDerivationShow = vi.fn(() => Promise.resolve([]));
		const materialiseGraphMock = vi.fn(() => Promise.resolve());
		const runNixCopy = vi.fn(() => Promise.resolve());
		const runNixBuildWithResults = vi.fn(() => Promise.resolve());
		const runCupboardMock = vi.fn<typeof runCupboard>(
			cupboardStub({
				plan: planCohortSuccess(measuredCapacity, []),
				reprobe: planReprobeSuccess([], [])
			})
		);

		await buildCohortAction(
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
				materialiseDerivationGraph: materialiseGraphMock,
				runNixCopy,
				runNixBuildWithResults,
				withLocalDerivationRoots: withoutLocalDerivationRoots
			}
		);

		expect({
			materialiseCalls: materialiseGraphMock.mock.calls,
			evaluationCalls: runNixDerivationShow.mock.calls,
			copyCalls: runNixCopy.mock.calls,
			buildCalls: runNixBuildWithResults.mock.calls
		}).toStrictEqual({
			materialiseCalls: [],
			evaluationCalls: [],
			copyCalls: [],
			buildCalls: []
		});
	});

	// The promise holds without publication too: the action materialises
	// the planned derivations in the runner's store before planning, and
	// `nix build --store` copies them to the remote store when it realises
	// the build set.
	it.each([{ push: 'true' }, { push: 'false' }])(
		'promises a remote plan its planned local derivations when push is $push',
		async ({ push }) => {
			let targetsFileContents: unknown;
			const stub = cupboardStub({
				plan: planCohortSuccess(measuredCapacity, []),
				reprobe: planReprobeSuccess([], [])
			});
			const runCupboardMock = vi.fn<typeof runCupboard>(
				async (binaryPath, arguments_, passedEnvironment, dependencies) => {
					if (arguments_[1] === 'plan' && arguments_[2] === 'cohort') {
						const targetsFile =
							arguments_[arguments_.indexOf('--targets-file') + 1];

						if (targetsFile === undefined) {
							throw new Error('plan cohort targets file is missing');
						}

						targetsFileContents = JSON.parse(
							await readFile(targetsFile, 'utf8')
						);
					}

					return stub(binaryPath, arguments_, passedEnvironment, dependencies);
				}
			);

			await buildCohortAction(
				{
					...baseOptions(),
					cohortJson: remotelyQueryableCohortJson(),
					push,
					store: 'ssh-ng://build@example.test'
				},
				environment,
				{
					runCupboard: runCupboardMock,
					runNixBuild: vi.fn(() => Promise.resolve({ paths: [], status: 0 }))
				}
			);

			expect(targetsFileContents).toStrictEqual({
				targets: [
					{
						attr: '.#packages.x86_64-linux.app',
						installable: appQueryInstallable,
						plannedLocalDerivation:
							'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app.drv',
						expectedPath: appPath,
						root: 'github:owner/repo/main/app'
					},
					{
						attr: '.#packages.x86_64-linux.lib',
						installable: libraryQueryInstallable,
						plannedLocalDerivation:
							'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib.drv',
						root: 'github:owner/repo/main/lib'
					},
					{
						attr: '.#packages.x86_64-linux.floating',
						installable: floatingQueryInstallable,
						plannedLocalDerivation:
							'/nix/store/4123456789abcdfghijklmnpqrsvwxyz-float.drv',
						root: 'github:owner/repo/main/floating'
					}
				]
			});
		}
	);

	it('propagates cancellation before evaluating or opening the build session', async () => {
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
		const materialiseGraphMock = vi.fn(() => Promise.resolve());
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
					materialiseDerivationGraph: materialiseGraphMock,
					runNixCopy,
					runNixBuildWithResults,
					withLocalDerivationRoots: withoutLocalDerivationRoots,
					signal: controller.signal
				}
			)
		).rejects.toBe(reason);
		expect({
			materialiseCalls: materialiseGraphMock.mock.calls,
			evaluationCalls: runNixDerivationShow.mock.calls,
			copyCalls: runNixCopy.mock.calls,
			buildCalls: runNixBuildWithResults.mock.calls
		}).toStrictEqual({
			materialiseCalls: [],
			evaluationCalls: [],
			copyCalls: [],
			buildCalls: []
		});
	});

	it('refuses evaluation drift before copying or opening a build session', async () => {
		const evaluated = storePathSchema.parse(
			'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-other.drv'
		);
		const runNixDerivationShow = vi.fn(() => Promise.resolve([evaluated]));
		const materialiseGraphMock = vi.fn(() => Promise.resolve());
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
					materialiseDerivationGraph: materialiseGraphMock,
					runNixCopy,
					runNixBuildWithResults,
					withLocalDerivationRoots: withoutLocalDerivationRoots
				}
			)
		).rejects.toMatchObject({
			name: 'CohortEvaluationDriftError',
			missing: ['/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib.drv'],
			evaluated: [evaluated]
		});
		expect({
			materialiseCalls: materialiseGraphMock.mock.calls,
			evaluationCalls: runNixDerivationShow.mock.calls,
			copyCalls: runNixCopy.mock.calls,
			buildCalls: runNixBuildWithResults.mock.calls
		}).toStrictEqual({
			materialiseCalls: [[['.#packages.x86_64-linux.lib^out'], undefined]],
			evaluationCalls: [
				[['.#packages.x86_64-linux.lib^out'], undefined, false]
			],
			copyCalls: [],
			buildCalls: []
		});
	});

	it('refuses drift from every installable alias of one remote target', async () => {
		const stableInstallable = '.#packages.x86_64-linux.stable^out';
		const latestInstallable = '.#packages.x86_64-linux.latest^out';
		const planned = storePathSchema.parse(
			'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib.drv'
		);
		const drifted = storePathSchema.parse(
			'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-other.drv'
		);
		const runCupboardMock = vi.fn<typeof runCupboard>(
			cupboardStub({
				plan: planCohortSuccess(measuredCapacity, [libraryQueryInstallable]),
				reprobe: planReprobeSuccess([], [libraryQueryInstallable])
			})
		);
		const runNixDerivationShow = vi.fn((installables: readonly string[]) =>
			Promise.resolve(
				installables.map((installable) =>
					installable === latestInstallable ? drifted : planned
				)
			)
		);
		const materialiseGraphMock = vi.fn(() => Promise.resolve());
		const runNixCopy = vi.fn(() => Promise.resolve());
		const runNixBuildWithResults = vi.fn(() => Promise.resolve());

		await expect(
			buildCohortAction(
				{
					...baseOptions(),
					cohortJson: remotelyQueryableCohortJson({
						attrs: ['stable', 'latest'],
						installables: [stableInstallable, latestInstallable],
						queryInstallables: [
							libraryQueryInstallable,
							libraryQueryInstallable
						],
						expectedPaths: [undefined, undefined],
						roots: ['github:owner/repo/stable', 'github:owner/repo/latest']
					}),
					push: 'true',
					store: 'ssh-ng://build@example.test'
				},
				environment,
				{
					runCupboard: runCupboardMock,
					runNixDerivationShow,
					materialiseDerivationGraph: materialiseGraphMock,
					runNixCopy,
					runNixBuildWithResults,
					withLocalDerivationRoots: withoutLocalDerivationRoots
				}
			)
		).rejects.toMatchObject({
			name: 'CohortEvaluationDriftError',
			mismatches: [
				{
					installable: latestInstallable,
					planned,
					evaluated: [drifted]
				}
			]
		});
		expect({
			materialiseCalls: materialiseGraphMock.mock.calls,
			evaluationCalls: runNixDerivationShow.mock.calls,
			copyCalls: runNixCopy.mock.calls,
			buildCalls: runNixBuildWithResults.mock.calls
		}).toStrictEqual({
			materialiseCalls: [[[stableInstallable, latestInstallable], undefined]],
			evaluationCalls: [
				[[stableInstallable], undefined, false],
				[[latestInstallable], undefined, false]
			],
			copyCalls: [],
			buildCalls: []
		});
	});

	it.each([
		{
			name: 'swapped installable roots',
			rootFor: (installable: string) =>
				storePathSchema.parse(
					installable.includes('.floating')
						? '/nix/store/4123456789abcdfghijklmnpqrsvwxyz-float.drv'
						: installable.includes('.app')
							? '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib.drv'
							: '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app.drv'
				),
			expected: [
				{
					installable: '.#packages.x86_64-linux.app^out',
					planned: '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app.drv',
					evaluated: ['/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib.drv']
				},
				{
					installable: '.#packages.x86_64-linux.lib^out',
					planned: '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib.drv',
					evaluated: ['/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app.drv']
				}
			]
		},
		{
			name: 'a planned derivation present only in the recursive dependency graph',
			rootFor: (installable: string) =>
				storePathSchema.parse(
					installable.includes('.floating')
						? '/nix/store/4123456789abcdfghijklmnpqrsvwxyz-float.drv'
						: installable.includes('.app')
							? extraQueryInstallable.slice(
									0,
									extraQueryInstallable.indexOf('^')
								)
							: '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib.drv'
				),
			expected: [
				{
					installable: '.#packages.x86_64-linux.app^out',
					planned: '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app.drv',
					evaluated: ['/nix/store/7123456789abcdfghijklmnpqrsvwxyz-extra.drv']
				}
			]
		}
	])('refuses $name one-to-one', async ({ rootFor, expected }) => {
		const targets = [appQueryInstallable, libraryQueryInstallable];
		const runCupboardMock = vi.fn<typeof runCupboard>(
			cupboardStub({
				plan: planCohortSuccess(measuredCapacity, targets),
				reprobe: planReprobeSuccess([], targets)
			})
		);
		const runNixDerivationShow = vi.fn((installables: readonly string[]) =>
			Promise.resolve(installables.map((installable) => rootFor(installable)))
		);
		const materialiseGraphMock = vi.fn(() => Promise.resolve());
		const runNixCopy = vi.fn(() => Promise.resolve());
		const runNixBuildWithResults = vi.fn(() => Promise.resolve());

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
					materialiseDerivationGraph: materialiseGraphMock,
					runNixCopy,
					runNixBuildWithResults,
					withLocalDerivationRoots: withoutLocalDerivationRoots
				}
			)
		).rejects.toMatchObject({
			name: 'CohortEvaluationDriftError',
			mismatches: expected
		});
		expect({
			materialiseCalls: materialiseGraphMock.mock.calls,
			evaluationCalls: runNixDerivationShow.mock.calls,
			copyCalls: runNixCopy.mock.calls,
			buildCalls: runNixBuildWithResults.mock.calls
		}).toStrictEqual({
			materialiseCalls: [
				[
					[
						'.#packages.x86_64-linux.app^out',
						'.#packages.x86_64-linux.lib^out'
					],
					undefined
				]
			],
			evaluationCalls: [
				[['.#packages.x86_64-linux.app^out'], undefined, false],
				[['.#packages.x86_64-linux.lib^out'], undefined, false]
			],
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
			name: 'RemoteCohortProtocolError',
			failures: [
				{
					target: derivedPath(libraryQueryInstallable),
					outcome: 'no-result',
					message: 'the daemon returned no result for this target'
				}
			]
		});
	});

	it('records a strict remote target failure alongside surviving outputs', async () => {
		const receiptFile = path.join(directory, 'cupboard-cohort-receipt.json');

		await expect(
			runPublicationFlow(
				{
					...baseOptions(),
					cohortJson: remotelyQueryableCohortJson(),
					push: 'true',
					store: 'ssh-ng://build@example.test'
				},
				[],
				[remoteResult('substituted'), remoteFailure(floatingQueryInstallable)],
				[libraryQueryInstallable, floatingQueryInstallable]
			)
		).rejects.toMatchObject({ name: 'RemoteCohortBuildFailedError' });

		expect(JSON.parse(await readFile(receiptFile, 'utf8'))).toStrictEqual({
			version: 3,
			paths: [libraryBuiltPath],
			subjects: [],
			terminalFailure: {
				kind: 'target-build',
				failedTargets: [floatingQueryInstallable]
			}
		});
	});

	it('keeps remote protocol corruption fatal for a best-effort cohort', async () => {
		const receiptFile = path.join(directory, 'cupboard-cohort-receipt.json');

		await expect(
			runPublicationFlow(
				{
					...baseOptions(),
					cohortJson: remotelyQueryableCohortJson(),
					push: 'true',
					bestEffort: 'true',
					store: 'ssh-ng://build@example.test'
				},
				[],
				[]
			)
		).rejects.toMatchObject({ name: 'RemoteCohortProtocolError' });

		expect(JSON.parse(await readFile(receiptFile, 'utf8'))).toStrictEqual({
			version: 3,
			paths: [],
			subjects: [],
			terminalFailure: { kind: 'command' }
		});
	});

	it('settles an all-failed remote cohort before tolerating target failures', async () => {
		const run = await runPublicationFlow(
			{
				...baseOptions(),
				cohortJson: remotelyQueryableCohortJson(),
				push: 'true',
				bestEffort: 'true',
				store: 'ssh-ng://build@example.test'
			},
			[],
			[remoteFailure()]
		);
		const receiptFile = path.join(directory, 'cupboard-cohort-receipt.json');
		const receipt: unknown = JSON.parse(await readFile(receiptFile, 'utf8'));

		expect({
			invocations: run.calls.map((call) => call[1]),
			lifecycle: run.remoteConnection.lifecycle,
			receiptLine: run.receiptLine,
			receipt,
			warnings: run.warnings
		}).toStrictEqual({
			invocations: ['plan', 'push'],
			lifecycle: ['opened', 'closed'],
			receiptLine: `receipt-file=${receiptFile}`,
			receipt: {
				version: 3,
				paths: [],
				subjects: [],
				terminalFailure: {
					kind: 'target-build',
					failedTargets: [libraryQueryInstallable]
				}
			},
			warnings: ['remote target build failed']
		});
	});

	it('records exact failed targets alongside surviving remote outputs', async () => {
		const run = await runPublicationFlow(
			{
				...baseOptions(),
				cohortJson: remotelyQueryableCohortJson(),
				push: 'true',
				bestEffort: 'true',
				store: 'ssh-ng://build@example.test'
			},
			[],
			[remoteFailure(floatingQueryInstallable), remoteResult('substituted')],
			[libraryQueryInstallable, floatingQueryInstallable]
		);
		const receiptFile = path.join(directory, 'cupboard-cohort-receipt.json');
		const receipt: unknown = JSON.parse(await readFile(receiptFile, 'utf8'));

		expect({
			invocations: run.calls.map((call) => call[1]),
			receipt,
			warnings: run.warnings
		}).toStrictEqual({
			invocations: ['plan', 'push', 'push', 'push'],
			receipt: {
				version: 3,
				paths: [libraryBuiltPath],
				subjects: [],
				terminalFailure: {
					kind: 'target-build',
					failedTargets: [floatingQueryInstallable]
				}
			},
			warnings: ['remote target build failed']
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
				publish?: (
					builds: readonly NixBuildResult[],
					failures: readonly RemoteCohortBuildFailure[],
					publicationPaths: readonly StorePathString[],
					provenanceRebuilds: ReadonlySet<NixDerivedPathString>
				) => Promise<void>
			) => {
				if (publish === undefined) {
					throw new Error('Remote build publication callback is missing');
				}

				lifecycle.push('opened');

				try {
					await publish(
						[remoteResult('built')],
						[],
						[storePathSchema.parse(libraryBuiltPath)],
						new Set()
					);
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
					bestEffort: 'true',
					store: 'ssh-ng://build@example.test'
				},
				environment,
				{
					runCupboard: runCupboardMock,
					runNixDerivationShow: vi.fn((installables: readonly string[]) =>
						Promise.resolve(evaluatedDerivations(installables))
					),
					runNixCopy: vi.fn(() => Promise.resolve()),
					runNixBuildWithResults,
					withLocalDerivationRoots: withoutLocalDerivationRoots
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
			path.join(directory, 'cupboard-cohort-receipt.json'),
			'--aggregate-receipt-v3'
		]);
		expect(run.calls[2]).toStrictEqual([
			'--no-colour',
			'push',
			url,
			libraryBuiltPath,
			floatingBuiltPath,
			'--github-oidc',
			'--root',
			'github:owner/repo/main',
			'--reference-paths-file',
			`${path.join(directory, 'cupboard-cohort-reference-paths.txt')}.destination.0`,
			'--reference-source',
			url
		]);
	});

	it('publishes a remote output closure without assigning references to its root', async () => {
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
			[libraryBuiltPath],
			[remoteResult('built')],
			[libraryQueryInstallable],
			[libraryBuiltPath, referencePath]
		);
		const receiptFile = path.join(directory, 'cupboard-cohort-receipt.json');
		const receipt: unknown = JSON.parse(await readFile(receiptFile, 'utf8'));

		expect({
			receiptPush: run.calls[1],
			rootPush: run.calls[2],
			receipt
		}).toStrictEqual({
			receiptPush: [
				'--no-colour',
				'push',
				url,
				libraryBuiltPath,
				referencePath,
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
				libraryBuiltPath,
				'--github-oidc',
				'--root',
				'github:owner/repo/main',
				'--store',
				'ssh-ng://build@example.test',
				'--reference-paths-file',
				`${path.join(directory, 'cupboard-cohort-reference-paths.txt')}.destination.0`,
				'--reference-source',
				url
			],
			receipt: {
				version: 3,
				paths: [libraryBuiltPath, referencePath],
				subjects: [
					{
						storePath: libraryBuiltPath,
						narHash: 'aa'.repeat(32),
						derivation: `${libraryBuiltPath}.drv`,
						buildStore: 'auto',
						verification: 'local'
					}
				]
			}
		});
	});

	// The destination already holds an attestation for an attached target, so a
	// provenance run publishes it with no receipt subject.
	it('publishes an attached target alongside the remote build this run claims', async () => {
		const run = await runPublicationFlow(
			{
				...baseOptions(),
				cohortJson: remotelyQueryableCohortJson(),
				push: 'true',
				requireProvenance: 'true',
				store: 'ssh-ng://build@example.test'
			},
			[libraryBuiltPath],
			[remoteResult('built')],
			[libraryQueryInstallable]
		);
		const receiptFile = path.join(directory, 'cupboard-cohort-receipt.json');
		const receipt: unknown = JSON.parse(await readFile(receiptFile, 'utf8'));
		const inputs = resolveBuildCohortInputs(baseOptions(), environment);
		const targetPaths = await readFile(inputs.targetPathsFile, 'utf8');

		expect({
			invocations: run.calls.map((call) => call[1]),
			receipt,
			targetPaths: targetPaths.trim().split('\n')
		}).toStrictEqual({
			invocations: ['plan', 'push', 'push', 'push'],
			receipt: {
				version: 3,
				paths: [libraryBuiltPath],
				subjects: [
					{
						storePath: libraryBuiltPath,
						narHash: 'aa'.repeat(32),
						derivation: `${libraryBuiltPath}.drv`,
						buildStore: 'auto',
						verification: 'local'
					}
				]
			},
			targetPaths: [appPath, libraryBuiltPath]
		});
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
				didProtectionReceiveSignal:
					run.remoteConnection.didProtectionReceiveSignal,
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
				libraryBuiltPath,
				'--github-oidc',
				'--root',
				'github:owner/repo/main',
				'--store',
				'ssh-ng://build@example.test',
				'--reference-paths-file',
				`${path.join(directory, 'cupboard-cohort-reference-paths.txt')}.destination.0`,
				'--reference-source',
				url
			],
			cohortsFile: undefined,
			nixBuilds: [],
			resultBuilds: [
				[[libraryQueryInstallable], '0', 'ssh-ng://build@example.test']
			],
			remoteConnection: {
				lifecycle: ['opened', 'closed'],
				sequence: [
					'plan',
					'local session',
					'local root /nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib.drv',
					'materialise',
					'evaluate',
					'session',
					'copy',
					'publish',
					'publish',
					'closed',
					'local closed'
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
				didProtectionReceiveSignal: true,
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
