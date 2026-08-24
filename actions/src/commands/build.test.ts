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
import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { buildReceiptSchema } from '@cupboard/protocol/build';
import { afterEach, describe, expect, it } from 'vitest';

import {
	BuildAttemptsInvalidError,
	BuildInstallableInvalidError
} from '../errors.ts';

import {
	buildAction,
	buildActivities,
	derivationsRequiringVerification,
	plannedOutputPaths,
	receiptSubjects
} from './build.ts';

const execFileAsync = promisify(execFile);
const app = storePathSchema.parse(
	'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
);
const library = storePathSchema.parse(
	'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib'
);

function buildStart(derivation: string) {
	return JSON.stringify({
		action: 'start',
		type: 105,
		fields: [derivation, '', 1, 1]
	});
}

describe('buildActivities', () => {
	it('returns derivations from build-start activities', () => {
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

describe('derivationsRequiringVerification', () => {
	it('requires local verification for a derivation from an earlier attempt and for a remotely built derivation', () => {
		const appDerivation = `${app}.drv`;
		const libraryDerivation = `${library}.drv`;

		expect(
			derivationsRequiringVerification(
				[
					{
						attempt: 1,
						attemptId: 'one',
						activities: [
							{ derivation: appDerivation, machine: '' },
							{
								derivation: '/nix/store/dependency.drv',
								machine: 'builder'
							}
						]
					},
					{
						attempt: 2,
						attemptId: 'two',
						activities: [{ derivation: libraryDerivation, machine: 'builder' }]
					}
				],
				2,
				[pathInfo(app, appDerivation), pathInfo(library, libraryDerivation)]
			)
		).toStrictEqual([appDerivation, libraryDerivation]);
	});
});

const temporaryDirectories: string[] = [];

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
	it('cancels retry backoff without waiting for its delay', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-build-test-')
		);
		temporaryDirectories.push(directory);
		const controller = new AbortController();
		const reason = new Error('cancel build retries');
		let invocation = 0;

		const action = buildAction(
			{ installables: ['.#app'], attempts: '2' },
			{
				RUNNER_TEMP: directory,
				GITHUB_OUTPUT: path.join(directory, 'github-output')
			},
			{
				signal: controller.signal,
				nix: { queryPathInfo: () => Promise.reject(new Error('not present')) },
				runNix: () => {
					invocation += 1;

					if (invocation === 1) {
						return Promise.resolve({ status: 0, stdout: '[]' });
					}

					controller.abort(reason);

					return Promise.resolve({ status: 1, stdout: '' });
				}
			}
		);

		await expect(action).rejects.toBe(reason);
		expect(invocation).toBe(2);
	});

	it.each(['--refresh', '.#app\t--refresh'])(
		'rejects the unsafe installable %j',
		async (installable) => {
			await expect(
				buildAction({ installables: [installable] }, {})
			).rejects.toBeInstanceOf(BuildInstallableInvalidError);
		}
	);

	it('rejects an attempt count below one', async () => {
		await expect(
			buildAction({ installables: ['.#app'], attempts: '0' }, {})
		).rejects.toBeInstanceOf(BuildAttemptsInvalidError);
	});

	it('makes five build attempts by default', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-build-test-')
		);
		temporaryDirectories.push(directory);
		let buildAttempts = 0;
		const retryDelays: number[] = [];

		await buildAction(
			{ installables: ['.#app'], allowFailure: 'true' },
			{
				RUNNER_TEMP: directory,
				GITHUB_OUTPUT: path.join(directory, 'github-output')
			},
			{
				sleep: (delayMs) => {
					retryDelays.push(delayMs);

					return Promise.resolve();
				},
				nix: { queryPathInfo: () => Promise.reject(new Error('not present')) },
				runNix: (invocation) => {
					if (invocation.arguments.includes('--dry-run')) {
						return Promise.resolve({ status: 0, stdout: '[]' });
					}

					buildAttempts += 1;

					return Promise.resolve({ status: 1, stdout: '' });
				}
			}
		);

		expect({ buildAttempts, retryDelays }).toStrictEqual({
			buildAttempts: 5,
			retryDelays: [15_000, 30_000, 45_000, 60_000]
		});
	});

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
				arguments: ['build', '--dry-run', '--json', '--no-link', '--stdin'],
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

	it('rebuilds a derivation recorded during a failed attempt before attributing the final output', async () => {
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
		let pathQueries = 0;

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
					queryPathInfo: () => {
						pathQueries += 1;
						if (pathQueries === 1) {
							return Promise.reject(new Error('not present'));
						}

						return Promise.resolve(pathInfo(app, appDerivation));
					}
				},
				runNix: async (invocation) => {
					invocations.push(invocation);
					if (invocation.arguments.includes('--dry-run')) {
						return {
							status: 0,
							stdout: `[{"outputs":{"out":"${app}"}}]`
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
						buildAttempt === 1 ? `${buildStart(appDerivation)}\n` : ''
					);

					return {
						status: buildAttempt === 1 ? 1 : 0,
						stdout: `${app}\n`
					};
				}
			}
		);

		const receiptFile = path.join(directory, 'cupboard-build-receipt.json');
		const receiptText = await readFile(receiptFile, 'utf8');
		const receiptJson: unknown = JSON.parse(receiptText);
		const receipt = buildReceiptSchema.parse(receiptJson);
		expect({ invocations, receipt }).toStrictEqual({
			invocations: [
				{
					arguments: ['build', '--dry-run', '--json', '--no-link', '--stdin'],
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
						'--stdin'
					],
					stdin: `${appDerivation}^*\n`
				}
			],
			receipt: {
				version: 2,
				paths: [app],
				subjects: [
					{
						storePath: app,
						narHash: 'aa'.repeat(32),
						derivation: appDerivation,
						attempt: 2,
						attemptId: 'attempt-2'
					}
				]
			}
		});
	});

	it('rebuilds a substituted output before requiring it as a provenance subject', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-build-test-')
		);
		temporaryDirectories.push(directory);
		const appDerivation = `${app}.drv`;
		const invocations: {
			readonly arguments: readonly string[];
			readonly stdin: string;
		}[] = [];
		let pathQueries = 0;

		await buildAction(
			{
				installables: ['.#app'],
				attempts: '1',
				requireProvenance: 'true'
			},
			{
				RUNNER_TEMP: directory,
				GITHUB_OUTPUT: path.join(directory, 'github-output')
			},
			{
				nextAttemptId: () => 'current-run-rebuild',
				nix: {
					queryPathInfo: () => {
						pathQueries += 1;
						if (pathQueries === 1) {
							return Promise.reject(
								new Error('not present before substitution')
							);
						}

						return Promise.resolve(pathInfo(app, appDerivation));
					}
				},
				runNix: async (invocation) => {
					invocations.push(invocation);
					if (invocation.arguments.includes('--dry-run')) {
						return {
							status: 0,
							stdout: `[{"outputs":{"out":"${app}"}}]`
						};
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
					await writeFile(logFile, '');

					return { status: 0, stdout: `${app}\n` };
				}
			}
		);

		const receiptFile = path.join(directory, 'cupboard-build-receipt.json');
		const receiptText = await readFile(receiptFile, 'utf8');
		const receiptJson: unknown = JSON.parse(receiptText);
		const receipt = buildReceiptSchema.parse(receiptJson);

		expect({ invocations, receipt }).toStrictEqual({
			invocations: [
				{
					arguments: ['build', '--dry-run', '--json', '--no-link', '--stdin'],
					stdin: '.#app\n'
				},
				{
					arguments: [
						'build',
						'--no-link',
						'--print-out-paths',
						'--option',
						'json-log-path',
						path.join(directory, 'cupboard-nix-current-run-rebuild.jsonl'),
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
						'--stdin'
					],
					stdin: `${appDerivation}^*\n`
				}
			],
			receipt: {
				version: 2,
				paths: [app],
				subjects: [
					{
						storePath: app,
						narHash: 'aa'.repeat(32),
						derivation: appDerivation,
						attempt: 2,
						attemptId: 'current-run-rebuild'
					}
				]
			}
		});
	});
});

function pathInfo(storePath: StorePathString, deriver?: string) {
	return {
		storePath,
		narHash: NixSha256Hash.fromDigest(Buffer.alloc(32, 0xaa)),
		narSize: 1,
		references: [],
		signatures: [],
		ultimate: false,
		...(deriver !== undefined && { deriver })
	};
}

describe('receiptSubjects', () => {
	it('returns the first build attempt for a final output that was absent before the build', () => {
		const appDerivation = `${app}.drv`;
		const libraryDerivation = `${library}.drv`;
		const subjects = receiptSubjects(
			[
				{
					attempt: 1,
					attemptId: 'one',
					activities: [
						{ derivation: appDerivation, machine: '' },
						{ derivation: libraryDerivation, machine: '' }
					]
				},
				{
					attempt: 2,
					attemptId: 'two',
					activities: [{ derivation: libraryDerivation, machine: '' }]
				}
			],
			[pathInfo(app, appDerivation), pathInfo(library, libraryDerivation)],
			new Set([library])
		);

		expect(subjects).toStrictEqual([
			{
				storePath: app,
				narHash: 'aa'.repeat(32),
				derivation: appDerivation,
				attempt: 1,
				attemptId: 'one'
			}
		]);
	});

	it('does not attribute outputs without a matching derivation', () => {
		const subjects = receiptSubjects(
			[
				{
					attempt: 1,
					attemptId: 'one',
					activities: [{ derivation: `${app}.drv`, machine: '' }]
				}
			],
			[pathInfo(app), pathInfo(library, `${library}.drv`)],
			new Set()
		);

		expect(subjects).toStrictEqual([]);
	});

	it('attributes only pre-existing outputs whose final derivations were rebuilt', () => {
		const appDerivation = `${app}.drv`;
		const libraryDerivation = `${library}.drv`;
		const subjects = receiptSubjects(
			[
				{
					attempt: 2,
					attemptId: 'provenance-rebuild',
					activities: [
						{ derivation: appDerivation, machine: '' },
						{ derivation: libraryDerivation, machine: '' }
					]
				}
			],
			[pathInfo(app, appDerivation), pathInfo(library, libraryDerivation)],
			new Set([app, library]),
			new Set([appDerivation])
		);

		expect(subjects).toStrictEqual([
			{
				storePath: app,
				narHash: 'aa'.repeat(32),
				derivation: appDerivation,
				attempt: 2,
				attemptId: 'provenance-rebuild'
			}
		]);
	});
});

describe('plannedOutputPaths', () => {
	it('returns known output paths and omits unresolved content-addressed outputs', () => {
		expect(
			plannedOutputPaths(
				`[{"outputs":{"out":"${app}","dev":null}},{"outputs":{"out":"${library}"}}]`
			)
		).toStrictEqual([app, library]);
	});
});
