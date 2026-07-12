import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { afterEach, describe, expect, it } from 'vitest';

import { buildReceiptSchema } from '../build-receipt.ts';

import {
	buildAction,
	buildActivities,
	derivationsRequiringVerification,
	plannedOutputPaths,
	receiptSubjects
} from './build.ts';

const app = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app';
const library = '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib';

function buildStart(derivation: string) {
	return JSON.stringify({
		action: 'start',
		type: 105,
		fields: [derivation, '', 1, 1]
	});
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

describe('derivationsRequiringVerification', () => {
	it('selects remote and earlier-attempt activities for final outputs', () => {
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
	it.each(['--refresh', '.#app\t--refresh'])(
		'rejects the unsafe installable %j',
		async (installable) => {
			await expect(
				buildAction({ installables: [installable] }, {})
			).rejects.toThrow('installables must not start with a hyphen');
		}
	);

	it('verifies a partial failed attempt before attributing it after retry', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-build-test-')
		);
		temporaryDirectories.push(directory);
		const appDerivation = `${app}.drv`;
		const commands: string[][] = [];
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
				runNix: async (arguments_) => {
					commands.push([...arguments_]);
					if (arguments_.includes('--dry-run')) {
						return {
							status: 0,
							stdout: `[{"outputs":{"out":"${app}"}}]`
						};
					}
					if (arguments_.includes('--rebuild')) {
						return { status: 0, stdout: '' };
					}

					buildAttempt += 1;
					const logFile = arguments_[arguments_.indexOf('json-log-path') + 1];
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
		expect({ commands, receipt }).toStrictEqual({
			commands: [
				['build', '--dry-run', '--json', '--no-link', '--', '.#app'],
				[
					'build',
					'--no-link',
					'--print-out-paths',
					'--option',
					'json-log-path',
					path.join(directory, 'cupboard-nix-attempt-1.jsonl'),
					'--keep-going',
					'--',
					'.#app'
				],
				[
					'build',
					'--no-link',
					'--print-out-paths',
					'--option',
					'json-log-path',
					path.join(directory, 'cupboard-nix-attempt-2.jsonl'),
					'--keep-going',
					'--',
					'.#app'
				],
				[
					'build',
					'--rebuild',
					'--no-link',
					'--builders',
					'',
					'--max-jobs',
					'1',
					'--',
					`${appDerivation}^*`
				]
			],
			receipt: {
				version: 1,
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
});

function pathInfo(storePath: string, deriver?: string) {
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
	it('unions retry attempts and intersects them with final outputs', () => {
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
