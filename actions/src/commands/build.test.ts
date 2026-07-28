import { execFile } from 'node:child_process';
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { env, execPath } from 'node:process';
import { promisify } from 'node:util';

import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { afterEach, describe, expect, it } from 'vitest';

import { buildReceiptSchema } from '../build-receipt.ts';

import {
	buildAction,
	buildActivities,
	type NixInvocation,
	plannedOutputPaths,
	publicationPaths,
	receiptSubjects,
	retentionRootPaths
} from './build.ts';

const app = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app';
const library = '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib';
const execFileAsync = promisify(execFile);

function buildStart(derivation: string, machine = '') {
	return JSON.stringify({
		action: 'start',
		type: 105,
		fields: [derivation, machine, 1, 1]
	});
}

function derivationGraph(
	outputs: Readonly<Record<string, Readonly<Record<string, string | null>>>>
) {
	return JSON.stringify(
		Object.fromEntries(
			Object.entries(outputs).map(([derivation, derivationOutputs]) => [
				derivation,
				{
					env: {},
					inputs: { drvs: {} },
					outputs: Object.fromEntries(
						Object.entries(derivationOutputs).map(([name, outputPath]) => [
							name,
							outputPath === null ? {} : { path: outputPath }
						])
					)
				}
			])
		)
	);
}

describe('buildActivities', () => {
	it('collects derivations whose build activity started', () => {
		const derivation = `${app}.drv`;
		const log = buildStart(derivation);

		expect(buildActivities(log)).toStrictEqual([{ derivation, machine: '' }]);
	});

	it('ignores unrelated internal JSON records', () => {
		const log = JSON.stringify({ action: 'stop', id: 1 });
		const paths = buildActivities(log);

		expect(paths).toStrictEqual([]);
	});

	it('fails closed when the log is truncated', () => {
		expect(() => buildActivities('{"action":"start"')).toThrow(SyntaxError);
	});

	it('rejects a malformed build activity', () => {
		const log = JSON.stringify({ action: 'start', type: 105, fields: [] });

		expect(() => buildActivities(log)).toThrow();
	});
});

const temporaryDirectories: string[] = [];

async function readBuildReceipt(directory: string) {
	const text = await readFile(
		path.join(directory, 'cupboard-build-receipt.json'),
		'utf8'
	);
	const value: unknown = JSON.parse(text);

	return buildReceiptSchema.parse(value);
}

afterEach(async () => {
	const directories = [...temporaryDirectories];
	temporaryDirectories.length = 0;
	await Promise.all(
		directories.map((directory) =>
			rm(directory, { recursive: true, force: true })
		)
	);
});

describe('buildAction', () => {
	it.each(['--refresh', '.#app\t--refresh'])(
		'rejects the unsafe installable %j',
		async (installable) => {
			await expect(
				buildAction({ installables: [installable] }, {})
			).rejects.toThrow('installables must not start with a hyphen');
		}
	);

	it('starts Nix with a publication-sized installables file', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-build-test-')
		);
		temporaryDirectories.push(directory);
		const binDirectory = path.join(directory, 'bin');
		const nixLog = path.join(directory, 'nix.jsonl');
		const installablesFile = path.join(directory, 'installables.txt');
		const githubOutput = path.join(directory, 'github-output');
		const installables = Array.from(
			{ length: 18_662 },
			(_, index) =>
				`/nix/store/${String(index).padStart(32, '0')}-seed-${String(index)}.drv^out`
		);

		await writeFile(installablesFile, `${installables.join('\n')}\n`);
		await mkdir(binDirectory, { recursive: true });
		const nixExecutable = path.join(binDirectory, 'nix');
		await writeFile(
			nixExecutable,
			String.raw`#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
	appendFileSync(
		process.env.FAKE_NIX_LOG,
		JSON.stringify({
			arguments: process.argv.slice(2),
			installables: input.split(/\r?\n/u).filter(Boolean)
		}) + '\n'
	);
	if (process.argv.includes('--dry-run')) {
		process.stdout.write('[]');
	}
	if (process.argv.includes('derivation')) {
		process.stdout.write('{}');
	}
});
`
		);
		await chmod(nixExecutable, 0o755);

		const action = new URL('../main.ts', import.meta.url);
		await execFileAsync(
			execPath,
			[
				'--experimental-transform-types',
				'--disable-warning=ExperimentalWarning',
				action.pathname,
				'build',
				'--installables-file',
				installablesFile,
				'--attempts',
				'1'
			],
			{
				env: {
					...env,
					FAKE_NIX_LOG: nixLog,
					GITHUB_OUTPUT: githubOutput,
					PATH: `${binDirectory}:${env.PATH ?? ''}`,
					RUNNER_TEMP: directory
				}
			}
		);

		const nixLogContents = await readFile(nixLog, 'utf8');
		const invocations = nixLogContents
			.trim()
			.split('\n')
			.map((line): unknown => JSON.parse(line));
		expect(invocations).toStrictEqual([
			{
				arguments: ['derivation', 'show', '-r', '--stdin'],
				installables
			},
			{
				arguments: [
					'build',
					'--no-link',
					'--print-out-paths',
					'--option',
					'json-log-path',
					expect.stringMatching(/cupboard-nix-.+\.jsonl/u),
					'--stdin'
				],
				installables
			}
		]);
	});

	it('reuses a supplied derivation graph without evaluating it again', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-build-test-')
		);
		temporaryDirectories.push(directory);
		const appDerivation = `${app}.drv`;
		const graphFile = path.join(directory, 'derivations.json');
		const invocations: NixInvocation[] = [];
		let hasBuilt = false;

		await writeFile(
			graphFile,
			derivationGraph({ [appDerivation]: { out: app } })
		);
		await buildAction(
			{
				installables: ['.#app'],
				attempts: '1',
				derivationGraphFile: graphFile
			},
			{
				RUNNER_TEMP: directory,
				GITHUB_OUTPUT: path.join(directory, 'github-output')
			},
			{
				nextAttemptId: () => 'one',
				nix: {
					queryDerivationOutputPaths: () => Promise.resolve([app]),
					queryPathsInfo: (storePaths) =>
						Promise.resolve(
							storePaths.map((storePath) => pathInfo(storePath, appDerivation))
						),
					queryValidPaths: (storePaths) =>
						Promise.resolve(hasBuilt ? storePaths : []),
					queryValidPathsInfo: (storePaths) =>
						Promise.resolve(
							hasBuilt
								? storePaths.map((storePath) =>
										pathInfo(storePath, appDerivation)
									)
								: []
						)
				},
				runNix: async (invocation) => {
					invocations.push(invocation);
					const logFile =
						invocation.arguments[
							invocation.arguments.indexOf('json-log-path') + 1
						];
					if (logFile === undefined) {
						throw new Error('missing json-log-path');
					}

					await writeFile(logFile, `${buildStart(appDerivation)}\n`);
					hasBuilt = true;

					return { status: 0, stdout: `${app}\n` };
				}
			}
		);

		expect(invocations).toStrictEqual([
			{
				arguments: [
					'build',
					'--no-link',
					'--print-out-paths',
					'--option',
					'json-log-path',
					path.join(directory, 'cupboard-nix-one.jsonl'),
					'--stdin'
				],
				stdin: '.#app\n'
			}
		]);
	});

	it('keeps a best-effort build useful when its graph cannot be evaluated', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-build-test-')
		);
		temporaryDirectories.push(directory);
		const appDerivation = `${app}.drv`;
		const invocations: NixInvocation[] = [];

		await buildAction(
			{
				installables: ['.#app', '.#broken'],
				attempts: '1',
				allowFailure: 'true'
			},
			{
				RUNNER_TEMP: directory,
				GITHUB_OUTPUT: path.join(directory, 'github-output')
			},
			{
				nextAttemptId: () => 'only',
				nix: {
					queryDerivationOutputPaths: () => Promise.resolve([]),
					queryPathsInfo: (storePaths) =>
						Promise.resolve(
							storePaths.map((storePath) => pathInfo(storePath, appDerivation))
						),
					queryValidPaths: () => Promise.resolve([]),
					queryValidPathsInfo: () => Promise.resolve([])
				},
				runNix: async (invocation) => {
					invocations.push(invocation);

					if (invocation.arguments.includes('derivation')) {
						return { status: 1, stdout: '' };
					}

					if (invocation.arguments.includes('--rebuild')) {
						return { status: 0, stdout: '' };
					}

					const logFile =
						invocation.arguments[
							invocation.arguments.indexOf('json-log-path') + 1
						];
					if (logFile === undefined) {
						throw new Error('missing json-log-path');
					}

					await writeFile(logFile, `${buildStart(appDerivation, 'builder')}\n`);

					return { status: 0, stdout: `${app}\n` };
				}
			}
		);

		const receipt = await readBuildReceipt(directory);

		expect({ invocations, receipt }).toStrictEqual({
			invocations: [
				{
					arguments: ['derivation', 'show', '-r', '--stdin'],
					stdin: '.#app\n.#broken\n'
				},
				{
					arguments: ['derivation', 'show', '-r', '--stdin'],
					stdin: '.#app\n'
				},
				{
					arguments: ['derivation', 'show', '-r', '--stdin'],
					stdin: '.#broken\n'
				},
				{
					arguments: [
						'build',
						'--no-link',
						'--print-out-paths',
						'--option',
						'json-log-path',
						path.join(directory, 'cupboard-nix-only.jsonl'),
						'--stdin'
					],
					stdin: '.#app\n.#broken\n'
				},
				{
					arguments: [
						'build',
						'--rebuild',
						'--no-link',
						'--builders',
						'',
						'--max-jobs',
						'1',
						'--keep-going',
						'--stdin'
					],
					stdin: `${appDerivation}^*\n`
				}
			],
			receipt: { version: 1, paths: [app], subjects: [] }
		});
	});

	it('verifies a partial failed attempt before attributing it after retry', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-build-test-')
		);
		temporaryDirectories.push(directory);
		const appDerivation = `${app}.drv`;
		const invocations: {
			readonly arguments: readonly string[];
			readonly stdin: string;
		}[] = [];
		let buildAttempt = 0;

		await buildAction(
			{ installables: ['.#app'], attempts: '2', keepGoing: 'true' },
			{
				RUNNER_TEMP: directory,
				GITHUB_OUTPUT: path.join(directory, 'github-output')
			},
			{
				nextAttemptId: () => `attempt-${String(buildAttempt + 1)}`,
				sleep: () => Promise.resolve(),
				nix: {
					queryDerivationOutputPaths: () => Promise.resolve([app]),
					queryPathsInfo: (storePaths) =>
						Promise.resolve(
							storePaths.map((storePath) =>
								pathInfo(storePath, appDerivation, [library])
							)
						),
					queryValidPaths: (storePaths) =>
						Promise.resolve(buildAttempt === 0 ? [] : storePaths),
					queryValidPathsInfo: (storePaths) =>
						Promise.resolve(
							buildAttempt === 0
								? []
								: storePaths.map((storePath) =>
										pathInfo(storePath, appDerivation, [library])
									)
						)
				},
				runNix: async (invocation) => {
					invocations.push(invocation);
					if (invocation.arguments.includes('derivation')) {
						return {
							status: 0,
							stdout: derivationGraph({
								[appDerivation]: { out: app }
							})
						};
					}
					if (invocation.arguments.includes('--rebuild')) {
						return { status: 0, stdout: '' };
					}

					buildAttempt += 1;
					const logFile =
						invocation.arguments[
							invocation.arguments.indexOf('json-log-path') + 1
						];
					if (logFile === undefined) {
						throw new Error('missing json-log-path');
					}
					await writeFile(
						logFile,
						buildAttempt === 1
							? `${buildStart(appDerivation, 'builder')}\n`
							: ''
					);

					return {
						status: buildAttempt === 1 ? 1 : 0,
						stdout: `${app}\n`
					};
				}
			}
		);

		const receiptFile = path.join(directory, 'cupboard-build-receipt.json');
		const publicationPathsFile = path.join(
			directory,
			'cupboard-publication-paths.txt'
		);
		const receiptText = await readFile(receiptFile, 'utf8');
		const publicationPathsText = await readFile(publicationPathsFile, 'utf8');
		const receiptJson: unknown = JSON.parse(receiptText);
		const receipt = buildReceiptSchema.parse(receiptJson);
		expect({ invocations, publicationPathsText, receipt }).toStrictEqual({
			invocations: [
				{
					arguments: ['derivation', 'show', '-r', '--stdin'],
					stdin: '.#app\n'
				},
				{
					arguments: [
						'build',
						'--no-link',
						'--print-out-paths',
						'--option',
						'json-log-path',
						path.join(directory, 'cupboard-nix-attempt-1.jsonl'),
						'--keep-going',
						'--stdin'
					],
					stdin: '.#app\n'
				},
				{
					arguments: [
						'build',
						'--no-link',
						'--print-out-paths',
						'--option',
						'json-log-path',
						path.join(directory, 'cupboard-nix-attempt-2.jsonl'),
						'--keep-going',
						'--stdin'
					],
					stdin: '.#app\n'
				},
				{
					arguments: [
						'build',
						'--rebuild',
						'--no-link',
						'--builders',
						'',
						'--max-jobs',
						'1',
						'--keep-going',
						'--stdin'
					],
					stdin: `${appDerivation}^*\n`
				}
			],
			publicationPathsText: `${app}\n`,
			receipt: {
				version: 1,
				paths: [app],
				subjects: [
					{
						storePath: app,
						narHash: 'aa'.repeat(32),
						derivation: appDerivation,
						attempt: 1,
						attemptId: 'attempt-1'
					}
				]
			}
		});
	});

	it('reports outputs built by an exhausted best-effort build as publishable', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-build-test-')
		);
		temporaryDirectories.push(directory);
		const dependency = `/nix/store/${'4'.repeat(32)}-dependency`;
		const dependencyDerivation = `${dependency}.drv`;
		const githubOutput = path.join(directory, 'github-output');
		const invocations: NixInvocation[] = [];
		let hasBuilt = false;

		await buildAction(
			{
				installables: ['.#app', '.#broken'],
				attempts: '1',
				allowFailure: 'true'
			},
			{ RUNNER_TEMP: directory, GITHUB_OUTPUT: githubOutput },
			{
				nextAttemptId: () => 'failed',
				nix: {
					queryDerivationOutputPaths: () => Promise.resolve([dependency]),
					queryPathsInfo: (storePaths) =>
						Promise.resolve(
							storePaths.map((storePath) =>
								pathInfo(storePath, dependencyDerivation)
							)
						),
					queryValidPaths: (storePaths) =>
						Promise.resolve(hasBuilt ? storePaths : []),
					queryValidPathsInfo: (storePaths) =>
						Promise.resolve(
							hasBuilt
								? storePaths.map((storePath) =>
										pathInfo(storePath, dependencyDerivation)
									)
								: []
						)
				},
				runNix: async (invocation) => {
					invocations.push(invocation);
					if (invocation.arguments.includes('derivation')) {
						if (invocation.stdin !== '.#app\n') {
							return { status: 1, stdout: '' };
						}

						return {
							status: 0,
							stdout: derivationGraph({
								[dependencyDerivation]: { out: dependency }
							})
						};
					}
					if (invocation.arguments.includes('--dry-run')) {
						return { status: 0, stdout: '[]' };
					}
					if (invocation.arguments.includes('--rebuild')) {
						return { status: 0, stdout: '' };
					}

					const logFile =
						invocation.arguments[
							invocation.arguments.indexOf('json-log-path') + 1
						];
					if (logFile === undefined) {
						throw new Error('missing json-log-path');
					}
					await writeFile(
						logFile,
						`${buildStart(dependencyDerivation, 'builder')}\n`
					);
					hasBuilt = true;

					return { status: 1, stdout: '' };
				}
			}
		);

		const publicationPathsText = await readFile(
			path.join(directory, 'cupboard-publication-paths.txt'),
			'utf8'
		);
		const retainedPathsText = await readFile(
			path.join(directory, 'cupboard-build-paths.txt'),
			'utf8'
		);
		const receipt = await readBuildReceipt(directory);
		const outputs = await readFile(githubOutput, 'utf8');

		expect({
			verification: invocations.find((invocation) =>
				invocation.arguments.includes('--rebuild')
			),
			publicationPathsText,
			retainedPathsText,
			receipt,
			hasPublicationPathCount: outputs.includes('publication-path-count=1\n')
		}).toStrictEqual({
			verification: {
				arguments: [
					'build',
					'--rebuild',
					'--no-link',
					'--builders',
					'',
					'--max-jobs',
					'1',
					'--keep-going',
					'--stdin'
				],
				stdin: `${dependencyDerivation}^*\n`
			},
			publicationPathsText: `${dependency}\n`,
			retainedPathsText: `${dependency}\n`,
			receipt: {
				version: 1,
				paths: [dependency],
				subjects: [
					{
						storePath: dependency,
						narHash: 'aa'.repeat(32),
						derivation: dependencyDerivation,
						attempt: 1,
						attemptId: 'failed'
					}
				]
			},
			hasPublicationPathCount: true
		});
	});

	it('fails before publishing when best-effort remote verification fails', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-build-test-')
		);
		temporaryDirectories.push(directory);
		const dependency = `/nix/store/${'4'.repeat(32)}-dependency`;
		const dependencyDerivation = `${dependency}.drv`;
		let hasBuilt = false;

		await expect(
			buildAction(
				{
					installables: ['.#app'],
					attempts: '1',
					allowFailure: 'true'
				},
				{
					RUNNER_TEMP: directory,
					GITHUB_OUTPUT: path.join(directory, 'github-output')
				},
				{
					nextAttemptId: () => 'failed',
					nix: {
						queryDerivationOutputPaths: () => Promise.resolve([dependency]),
						queryPathsInfo: () => Promise.resolve([]),
						queryValidPaths: (storePaths) =>
							Promise.resolve(hasBuilt ? storePaths : []),
						queryValidPathsInfo: (storePaths) =>
							Promise.resolve(
								hasBuilt
									? storePaths.map((storePath) =>
											pathInfo(storePath, dependencyDerivation)
										)
									: []
							)
					},
					runNix: async (invocation) => {
						if (invocation.arguments.includes('derivation')) {
							return {
								status: 0,
								stdout: derivationGraph({
									[dependencyDerivation]: { out: dependency }
								})
							};
						}
						if (invocation.arguments.includes('--rebuild')) {
							return { status: 1, stdout: '' };
						}

						const logFile =
							invocation.arguments[
								invocation.arguments.indexOf('json-log-path') + 1
							];
						if (logFile === undefined) {
							throw new Error('missing json-log-path');
						}
						await writeFile(
							logFile,
							`${buildStart(dependencyDerivation, 'builder')}\n`
						);
						hasBuilt = true;

						return { status: 1, stdout: '' };
					}
				}
			)
		).rejects.toThrow('nix build --rebuild failed with status 1');

		await expect(
			readFile(path.join(directory, 'cupboard-publication-paths.txt'), 'utf8')
		).rejects.toThrow();
	});

	it('publishes only outputs made valid by this invocation', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-build-test-')
		);
		temporaryDirectories.push(directory);
		const target = `/nix/store/${'5'.repeat(32)}-target`;
		const targetDerivation = `${target}.drv`;
		const dependency = `/nix/store/${'6'.repeat(32)}-dependency`;
		const development = `/nix/store/${'7'.repeat(32)}-dependency-dev`;
		const dependencyDerivation = `${dependency}.drv`;
		let validityQuery = 0;

		await buildAction(
			{ installables: ['.#target'], attempts: '1' },
			{
				RUNNER_TEMP: directory,
				GITHUB_OUTPUT: path.join(directory, 'github-output')
			},
			{
				nextAttemptId: () => 'only',
				nix: {
					queryDerivationOutputPaths: () =>
						Promise.resolve([dependency, development]),
					queryPathsInfo: (storePaths) =>
						Promise.resolve(
							storePaths.map((storePath) =>
								pathInfo(
									storePath,
									storePath === target ? targetDerivation : dependencyDerivation
								)
							)
						),
					queryValidPaths: (storePaths) => {
						validityQuery += 1;

						if (validityQuery === 1) {
							return Promise.resolve([dependency]);
						}

						return Promise.resolve(storePaths);
					},
					queryValidPathsInfo: (storePaths) =>
						Promise.resolve(
							storePaths.map((storePath) =>
								pathInfo(storePath, dependencyDerivation)
							)
						)
				},
				runNix: async (invocation) => {
					if (invocation.arguments.includes('derivation')) {
						return {
							status: 0,
							stdout: derivationGraph({
								[targetDerivation]: { out: target },
								[dependencyDerivation]: {
									out: dependency,
									dev: development
								}
							})
						};
					}
					if (invocation.arguments.includes('--dry-run')) {
						return {
							status: 0,
							stdout: `[{"outputs":{"out":"${target}"}}]`
						};
					}

					const logFile =
						invocation.arguments[
							invocation.arguments.indexOf('json-log-path') + 1
						];
					if (logFile === undefined) {
						throw new Error('missing json-log-path');
					}
					await writeFile(logFile, `${buildStart(dependencyDerivation)}\n`);

					return { status: 0, stdout: `${target}\n` };
				}
			}
		);

		await expect(
			readFile(path.join(directory, 'cupboard-publication-paths.txt'), 'utf8')
		).resolves.toBe(`${target}\n${development}\n`);
	});

	it('uses realised outputs attributed by a daemonless local store', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-build-test-')
		);
		temporaryDirectories.push(directory);
		const appDerivation = `${app}.drv`;
		let hasBuilt = false;

		await buildAction(
			{ installables: ['.#app'], attempts: '1' },
			{
				RUNNER_TEMP: directory,
				GITHUB_OUTPUT: path.join(directory, 'github-output')
			},
			{
				nextAttemptId: () => 'local',
				nix: {
					queryDerivationOutputPaths: () => Promise.resolve([app]),
					queryPathsInfo: (storePaths) =>
						Promise.resolve(
							storePaths.map((storePath) =>
								pathInfo(storePath, appDerivation, [library])
							)
						),
					queryValidPaths: (storePaths) =>
						Promise.resolve(hasBuilt ? storePaths : []),
					queryValidPathsInfo: (storePaths) =>
						Promise.resolve(
							hasBuilt
								? storePaths.map((storePath) =>
										pathInfo(storePath, appDerivation, [library])
									)
								: []
						)
				},
				runNix: async (invocation) => {
					if (invocation.arguments.includes('derivation')) {
						return {
							status: 0,
							stdout: derivationGraph({
								[appDerivation]: { out: app }
							})
						};
					}

					const logFile =
						invocation.arguments[
							invocation.arguments.indexOf('json-log-path') + 1
						];
					if (logFile === undefined) {
						throw new Error('missing json-log-path');
					}
					await writeFile(logFile, `${buildStart(appDerivation)}\n`);
					hasBuilt = true;

					return { status: 0, stdout: `${app}\n` };
				}
			}
		);

		await expect(
			readFile(path.join(directory, 'cupboard-publication-paths.txt'), 'utf8')
		).resolves.toBe(`${app}\n`);
	});
});

function pathInfo(
	storePath: string,
	deriver?: string,
	references: readonly string[] = []
) {
	return {
		storePath,
		narHash: NixSha256Hash.fromDigest(Buffer.alloc(32, 0xaa)),
		narSize: 1,
		references,
		signatures: [],
		ultimate: false,
		...(deriver !== undefined && { deriver })
	};
}

describe('receiptSubjects', () => {
	it('preserves the producing attempt for each derivation output', () => {
		const derivation = `${app}.drv`;
		const subjects = receiptSubjects(
			[
				{
					storePath: app,
					derivation,
					attempt: 1,
					attemptId: 'one',
					machine: ''
				},
				{
					storePath: library,
					derivation,
					attempt: 2,
					attemptId: 'two',
					machine: 'builder'
				}
			],
			[pathInfo(app, derivation), pathInfo(library, derivation)],
			new Set()
		);

		expect(subjects).toStrictEqual([
			{
				storePath: app,
				narHash: 'aa'.repeat(32),
				derivation,
				attempt: 1,
				attemptId: 'one'
			},
			{
				storePath: library,
				narHash: 'aa'.repeat(32),
				derivation,
				attempt: 2,
				attemptId: 'two'
			}
		]);
	});

	it('does not attribute outputs without a matching derivation', () => {
		const subjects = receiptSubjects(
			[
				{
					storePath: app,
					derivation: `${app}.drv`,
					attempt: 1,
					attemptId: 'one',
					machine: ''
				}
			],
			[pathInfo(app), pathInfo(library, `${library}.drv`)],
			new Set()
		);

		expect(subjects).toStrictEqual([]);
	});
});

describe('plannedOutputPaths', () => {
	it('collects known outputs and leaves unknown content-addressed outputs out', () => {
		expect(
			plannedOutputPaths(
				`[{"outputs":{"out":"${app}","dev":null}},{"outputs":{"out":"${library}"}}]`
			)
		).toStrictEqual([app, library]);
	});
});

describe('publicationPaths', () => {
	it('includes targets and outputs built during the run', () => {
		const built = `/nix/store/${'4'.repeat(32)}-built`;

		expect(
			publicationPaths({
				targetPaths: [app],
				builtOutputPaths: [built, app]
			})
		).toStrictEqual([app, built]);
	});
});

describe('retentionRootPaths', () => {
	it('keeps only the roots of the selected realised graph', () => {
		const tool = `/nix/store/${'4'.repeat(32)}-tool`;

		expect(
			retentionRootPaths([
				pathInfo(app, `${app}.drv`, [library, app]),
				pathInfo(library, `${library}.drv`, [tool]),
				pathInfo(tool, `${tool}.drv`)
			])
		).toStrictEqual([app]);
	});

	it('keeps unrelated realised outputs as separate roots', () => {
		expect(
			retentionRootPaths([
				pathInfo(app, `${app}.drv`),
				pathInfo(library, `${library}.drv`)
			])
		).toStrictEqual([app, library]);
	});

	it('collapses a large realised dependency chain to one root', () => {
		const storePaths = Array.from(
			{ length: 1001 },
			(_, index) => `/nix/store/path-${String(index)}`
		);
		const infos = storePaths.map((storePath, index) => {
			const reference = storePaths[index + 1];

			return pathInfo(
				storePath,
				`${storePath}.drv`,
				reference === undefined ? [] : [reference]
			);
		});

		expect(retentionRootPaths(infos)).toStrictEqual(['/nix/store/path-0']);
	});
});
