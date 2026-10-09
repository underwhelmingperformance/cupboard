import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
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

import {
	defaultSignatureSettings,
	NixStorePathNotFoundError
} from '@cupboard/nix';
import { receiptSubjects as cliReceiptSubjects } from '@cupboard/nix/build-observation';
import { Derivation } from '@cupboard/nix-store/derivation';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import {
	buildEventSchema,
	buildReceiptSchema,
	buildReceiptV3Schema
} from '@cupboard/protocol/build';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BuildObservationIncompleteError } from '../build-paths/observation.ts';
import {
	BuildAttemptsInvalidError,
	BuildInstallableInvalidError,
	BuildObservationMissingError,
	BuildPublicationUrlMissingError,
	BuildRebuildRemoteDispatchError,
	CommandFailedError
} from '../errors.ts';
import {
	reproducedSubjects,
	reproductionReport
} from '../reproduction-report.ts';

import { provenancedSubjects } from './attest.ts';
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
const availabilitySettings = {
	substitution: {
		substitute: true,
		alwaysAllowSubstitutes: false,
		fallback: true,
		substituters: ['https://upstream.example']
	},
	signatures: defaultSignatureSettings
};

function buildStart(derivation: string, machine = '') {
	return JSON.stringify({
		action: 'start',
		type: 105,
		fields: [derivation, machine, 1, 1]
	});
}

describe('CLI verification receipt', () => {
	it('generates a flake reproduction report from a CLI verification receipt', () => {
		const derivation = `${app}.drv`;
		const subjects = cliReceiptSubjects(
			[
				{
					attempt: 2,
					attemptId: 'verification-attempt',
					activities: [{ derivation, machine: '' }],
					verifiedOutputs: [
						{ storePath: app, narHash: 'aa'.repeat(32), derivation }
					]
				}
			],
			[{ ...pathInfo(app, derivation), ultimate: true }],
			new Set([app]),
			'auto'
		);
		const receipt = buildReceiptV3Schema.parse({
			version: 3,
			paths: [app],
			subjects
		});

		expect({
			receipt,
			report: reproductionReport(reproducedSubjects(receipt))
		}).toStrictEqual({
			receipt: {
				version: 3,
				paths: [app],
				subjects: [
					{
						origin: 'built',
						storePath: app,
						narHash: 'aa'.repeat(32),
						derivation,
						attempt: 2,
						attemptId: 'verification-attempt',
						buildStore: 'auto',
						verification: 'local',
						reproduced: true
					}
				]
			},
			report: {
				attributes: [{ attribute: 'REPRODUCIBLE', conditions: { derivation } }]
			}
		});
	});
});

describe('buildActivities', () => {
	it('returns derivations from build-start activities', () => {
		const derivation = `${app}.drv`;
		const log = buildStart(derivation);

		expect(buildActivities(log)).toStrictEqual([{ derivation, machine: '' }]);
	});

	it('preserves remote dispatch when a nested local activity follows it', () => {
		const derivation = `${app}.drv`;
		const log = [
			buildStart(derivation, 'ssh-ng://builder'),
			buildStart(derivation)
		].join('\n');

		expect(buildActivities(log)).toStrictEqual([
			{ derivation, machine: 'ssh-ng://builder' }
		]);
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
	it.each([
		{
			plannedFreshPath: true,
			uncertainInitialPath: false,
			expectedFreshCheck: false
		},
		{
			plannedFreshPath: false,
			uncertainInitialPath: false,
			expectedFreshCheck: true
		},
		{
			plannedFreshPath: true,
			uncertainInitialPath: true,
			expectedFreshCheck: true
		}
	])(
		'checks existing, copied, unplanned and uncertain outputs: $plannedFreshPath $uncertainInitialPath',
		({ plannedFreshPath, uncertainInitialPath, expectedFreshCheck }) => {
			const appDerivation = `${app}.drv`;
			const libraryDerivation = `${library}.drv`;
			const fresh = storePathSchema.parse(
				'/nix/store/4123456789abcdfghijklmnpqrsvwxyz-fresh'
			);
			const freshDerivation = `${fresh}.drv`;

			expect(
				derivationsRequiringVerification(
					[
						{ ...pathInfo(app, appDerivation), ultimate: true },
						pathInfo(library, libraryDerivation),
						{ ...pathInfo(fresh, freshDerivation), ultimate: true }
					],
					new Set([app]),
					new Set([app, library, ...(plannedFreshPath ? [fresh] : [])]),
					new Set(uncertainInitialPath ? [fresh] : [])
				)
			).toStrictEqual([
				appDerivation,
				libraryDerivation,
				...(expectedFreshCheck ? [freshDerivation] : [])
			]);
		}
	);
});

const temporaryDirectories: string[] = [];

beforeEach(() => {
	vi.stubEnv('NIX_CONFIG', `${env.NIX_CONFIG ?? ''}\nbuilders =\n`);
});

afterEach(async () => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
	const directories = [...temporaryDirectories];
	temporaryDirectories.length = 0;
	await Promise.all(
		directories.map((directory) =>
			rm(directory, { recursive: true, force: true })
		)
	);
});

describe('buildAction', () => {
	it.each([
		{ status: 0, allowFailure: 'true' },
		{ status: 0, allowFailure: 'false' },
		{ status: 17, allowFailure: 'true' },
		{ status: 17, allowFailure: 'false' }
	])(
		'refuses hook failure without a receipt: $status $allowFailure',
		async ({ status, allowFailure }) => {
			const directory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-observed-test-')
			);
			temporaryDirectories.push(directory);
			const flush = vi.fn(() => Promise.resolve());
			const close = vi.fn(() => Promise.resolve());
			const runNix = vi.fn((invocation: { arguments: readonly string[] }) =>
				Promise.resolve(
					invocation.arguments.includes('--dry-run')
						? { status: 0, stdout: '[]' }
						: { status, stdout: `${app}\n`, hookDeliveryFailed: true }
				)
			);
			await expect(
				buildAction(
					{ installables: ['.#app'], publish: 'built', allowFailure },
					{ RUNNER_TEMP: directory },
					{
						runNix,
						protection: { directory, protect: () => Promise.resolve() },
						createObservation: () =>
							Promise.resolve({
								environment: {},
								events: [],
								flush,
								close
							})
					}
				)
			).rejects.toStrictEqual(new BuildObservationIncompleteError());
			expect({
				runs: runNix.mock.calls.length,
				flushes: flush.mock.calls,
				closes: close.mock.calls,
				receiptExists: existsSync(
					path.join(directory, 'cupboard-build-receipt.json')
				)
			}).toStrictEqual({
				runs: 2,
				flushes: [[]],
				closes: [[]],
				receiptExists: false
			});
		}
	);

	it('requires the hook helper before starting built publication', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-observed-test-')
		);
		temporaryDirectories.push(directory);
		const runNix = vi.fn();
		await expect(
			buildAction(
				{ installables: ['.#app'], publish: 'built' },
				{ RUNNER_TEMP: directory },
				{ runNix }
			)
		).rejects.toThrow('CUPBOARD_PATH is required');
		expect(runNix.mock.calls).toStrictEqual([]);
	});

	it.each([
		{ selection: 'NIX_REMOTE', warm: false },
		{ selection: 'NIX_REMOTE', warm: true },
		{ selection: 'store setting', warm: false },
		{ selection: 'store setting', warm: true },
		{ selection: 'local', warm: false },
		{ selection: 'local', warm: true }
	])(
		'attributes execution in the selected store: $selection, warm=$warm',
		async ({ selection, warm }) => {
			const directory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-build-test-')
			);
			temporaryDirectories.push(directory);
			const remoteStore = 'ssh-ng://build@example.test?remote-store=/srv/nix';
			const isRemote = selection !== 'local';
			vi.stubEnv('NIX_CONF_DIR', directory);
			vi.stubEnv('NIX_USER_CONF_FILES', path.join(directory, 'absent'));
			vi.stubEnv(
				'NIX_REMOTE',
				selection === 'NIX_REMOTE' ? remoteStore : 'auto'
			);
			vi.stubEnv(
				'NIX_CONFIG',
				`builders =\n${selection === 'store setting' ? `store = ${remoteStore}\n` : ''}`
			);
			const derivation = `${app}.drv`;
			const info = { ...pathInfo(app, derivation), ultimate: true };
			const executions: string[] = [];
			let pathQueries = 0;

			await buildAction(
				{
					installables: ['.#app'],
					attempts: '1',
					build: warm ? 'rebuild' : 'missing'
				},
				{ RUNNER_TEMP: directory },
				{
					nextAttemptId: () => 'selected-store-attempt',
					nix: {
						queryPathInfo: () => {
							pathQueries += 1;
							return !warm && pathQueries === 1
								? Promise.reject(new NixStorePathNotFoundError(app))
								: Promise.resolve(info);
						}
					},
					runNix: async (invocation) => {
						if (invocation.arguments.includes('--dry-run')) {
							return {
								status: 0,
								stdout: JSON.stringify([
									{ drvPath: derivation, outputs: { out: app } }
								])
							};
						}

						const isCheck = invocation.arguments.includes('--rebuild');
						executions.push(isCheck ? 'check' : 'normal');
						const logFile =
							invocation.arguments[
								invocation.arguments.indexOf('json-log-path') + 1
							];
						if (logFile === undefined) {
							throw new Error('missing json-log-path');
						}
						await writeFile(
							logFile,
							!warm || isCheck ? `${buildStart(derivation)}\n` : ''
						);
						return { status: 0, stdout: isCheck ? '' : `${app}\n` };
					}
				}
			);

			const receiptText = await readFile(
				path.join(directory, 'cupboard-build-receipt.json'),
				'utf8'
			);
			const receiptJson: unknown = JSON.parse(receiptText);
			const receipt = buildReceiptV3Schema.parse(receiptJson);
			const builtReceipt: unknown = JSON.parse(
				await readFile(
					path.join(directory, 'cupboard-built-receipt.json'),
					'utf8'
				)
			);
			const identity = {
				storePath: app,
				narHash: 'aa'.repeat(32),
				derivation
			};
			const subject = isRemote
				? { ...identity, origin: 'store-held', buildStore: remoteStore }
				: {
						...identity,
						origin: 'built',
						buildStore: 'auto',
						verification: 'local',
						...(warm && { reproduced: true }),
						attempt: 1,
						attemptId: 'selected-store-attempt'
					};
			expect({
				executions,
				receipt,
				builtReceipt,
				publishPaths: await readFile(
					path.join(directory, 'cupboard-publish-paths.txt'),
					'utf8'
				),
				slsaSubjects: provenancedSubjects(receipt, new Map([[app, info]])).built
			}).toStrictEqual({
				executions: warm ? ['normal', 'check'] : ['normal'],
				receipt: { version: 3, paths: [app], subjects: [subject] },
				builtReceipt: {
					version: 3,
					paths: isRemote ? [] : [app],
					subjects: isRemote ? [] : [subject]
				},
				publishPaths: `${app}\n`,
				slsaSubjects: isRemote
					? []
					: [{ storePath: app, sha256: 'aa'.repeat(32) }]
			});
		}
	);

	it.each([
		{ substituter: 'leave', selected: [] },
		{ substituter: 'copy', selected: [app, library] }
	])(
		'selects output paths for substituter $substituter',
		async ({ substituter, selected }) => {
			const directory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-build-test-')
			);
			temporaryDirectories.push(directory);
			const paths: readonly StorePathString[] = [app, library];

			await buildAction(
				{
					installables: ['.#app'],
					attempts: '1',
					substituter,
					publicationUrl: 'https://cupboard.example/t/acme'
				},
				{
					RUNNER_TEMP: directory,
					GITHUB_OUTPUT: path.join(directory, 'github-output')
				},
				{
					availabilitySettings,
					nix: {
						queryPathInfo: (storePath) =>
							Promise.resolve({
								...pathInfo(
									storePathSchema.parse(storePath),
									`${storePath}.drv`
								),
								ultimate: storePath === library
							})
					},
					availabilityNix: {
						canSubstituteDerivation: () => Promise.resolve(true),
						honoursSubstituterSettings: () =>
							Promise.resolve({ isHonoured: true }),
						resolveSubstitutableClosure: () =>
							Promise.resolve({
								kind: 'served',
								pathCount: 1,
								downloadSize: 1,
								narSize: 1
							})
					},
					runNix: async (invocation) => {
						if (invocation.arguments.includes('--dry-run')) {
							return { status: 0, stdout: '[]' };
						}

						const logFile =
							invocation.arguments[
								invocation.arguments.indexOf('json-log-path') + 1
							];
						if (logFile !== undefined) {
							await writeFile(logFile, '');
						}

						return { status: 0, stdout: `${paths.join('\n')}\n` };
					}
				}
			);

			expect({
				selected: await readFile(
					path.join(directory, 'cupboard-publish-paths.txt'),
					'utf8'
				),
				all: await readFile(
					path.join(directory, 'cupboard-build-paths.txt'),
					'utf8'
				)
			}).toStrictEqual({
				selected: selected.length === 0 ? '' : `${selected.join('\n')}\n`,
				all: `${paths.join('\n')}\n`
			});
		}
	);

	it.each([undefined, 'false'])(
		'keeps large output lists complete with inline-paths %s',
		async (inlinePaths) => {
			const directory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-build-test-')
			);
			temporaryDirectories.push(directory);
			const paths = Array.from({ length: 1000 }, (_, index) =>
				storePathSchema.parse(`${app}-${String(index)}`)
			);
			const output = path.join(directory, 'github-output');
			await buildAction(
				{ installables: ['.#app'], attempts: '1', inlinePaths },
				{ RUNNER_TEMP: directory, GITHUB_OUTPUT: output },
				{
					nix: {
						queryPathInfo: (storePath) =>
							Promise.resolve(
								pathInfo(storePathSchema.parse(storePath), `${app}.drv`)
							)
					},
					runNix: async (invocation) => {
						if (invocation.arguments.includes('--dry-run')) {
							return { status: 0, stdout: '[]' };
						}
						await writeFile(
							invocation.arguments[
								invocation.arguments.indexOf('json-log-path') + 1
							] ?? '',
							''
						);
						return { status: 0, stdout: `${paths.join('\n')}\n` };
					}
				}
			);
			const outputs = await readFile(output, 'utf8');
			const inline = (key: string): string | undefined =>
				new RegExp(String.raw`^${key}<<([^\n]+)\n([\s\S]*?)\n\1$`, 'mu').exec(
					outputs
				)?.[2];
			expect({
				paths: await readFile(
					path.join(directory, 'cupboard-build-paths.txt'),
					'utf8'
				),
				published: await readFile(
					path.join(directory, 'cupboard-publish-paths.txt'),
					'utf8'
				),
				inlinePaths: inline('paths'),
				inlinePublished: inline('publish-paths'),
				counts: outputs.split('\n').filter((line) => /^.+-count=/u.test(line))
			}).toStrictEqual({
				paths: `${paths.join('\n')}\n`,
				published: `${paths.join('\n')}\n`,
				inlinePaths: inlinePaths === 'false' ? undefined : paths.join('\n'),
				inlinePublished: inlinePaths === 'false' ? undefined : paths.join('\n'),
				counts: [
					'intermediate-paths-count=0',
					'paths-count=1000',
					'publish-paths-count=1000',
					'built-paths-count=0'
				]
			});
		}
	);

	it.each([
		{ verdict: 'served', selected: '', queried: [app] },
		{ verdict: 'not-served', selected: `${app}\n`, queried: [app] },
		{ verdict: 'failed-query', selected: `${app}\n`, queried: [app] },
		{ verdict: 'rejected-offer', selected: `${app}\n`, queried: [app] },
		{ verdict: 'substitution-disabled', selected: `${app}\n`, queried: [] },
		{ verdict: 'untrusted-daemon', selected: `${app}\n`, queried: [] },
		{ verdict: 'runner-file', selected: `${app}\n`, queried: [] },
		{ verdict: 'runner-loopback', selected: `${app}\n`, queried: [] }
	] as const)(
		'publishes a warm output under substituter leave when upstream is $verdict',
		async ({ verdict, selected, queried }) => {
			const directory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-build-test-')
			);
			temporaryDirectories.push(directory);
			const availabilityQueries: string[] = [];
			const configuredSubstituter =
				verdict === 'runner-file'
					? 'file:///tmp/runner-cache'
					: verdict === 'runner-loopback'
						? 'http://127.0.0.1:8080'
						: 'https://upstream.example';

			await buildAction(
				{
					installables: ['.#app'],
					attempts: '1',
					substituter: 'leave',
					publicationUrl: 'https://cupboard.example/t/acme'
				},
				{
					RUNNER_TEMP: directory,
					GITHUB_OUTPUT: path.join(directory, 'github-output')
				},
				{
					availabilitySettings: {
						...availabilitySettings,
						substitution: {
							...availabilitySettings.substitution,
							substituters: [configuredSubstituter]
						}
					},
					nix: {
						queryPathInfo: () => Promise.resolve(pathInfo(app, `${app}.drv`))
					},
					availabilityNix: {
						canSubstituteDerivation: () =>
							Promise.resolve(verdict !== 'substitution-disabled'),
						honoursSubstituterSettings: () =>
							Promise.resolve(
								verdict === 'untrusted-daemon'
									? { isHonoured: false, trust: 'not-trusted' }
									: { isHonoured: true }
							),
						resolveSubstitutableClosure: async (storePath, options) => {
							availabilityQueries.push(storePath);
							if (verdict === 'failed-query') {
								throw new Error('substituter unavailable');
							}
							if (verdict === 'rejected-offer') {
								const accepted = await options?.accepts?.({
									source: 'substituter',
									storePath: app,
									references: [],
									narHash: NixSha256Hash.fromDigest(Buffer.alloc(32, 0xaa)),
									narSize: 1,
									signatures: [],
									fromTrustedSubstituter: false,
									downloadSize: 1
								});
								return accepted
									? {
											kind: 'served',
											pathCount: 1,
											downloadSize: 1,
											narSize: 1
										}
									: { kind: 'refused', storePath: app };
							}

							return verdict === 'served'
								? {
										kind: 'served',
										pathCount: 1,
										downloadSize: 1,
										narSize: 1
									}
								: { kind: 'not-served', storePath: app };
						}
					},
					runNix: async ({ arguments: arguments_ }) => {
						if (arguments_.includes('--dry-run')) {
							return { status: 0, stdout: '[]' };
						}

						const logFile = arguments_[arguments_.indexOf('json-log-path') + 1];
						if (logFile === undefined) {
							throw new Error('missing json-log-path');
						}
						await writeFile(logFile, '');
						return { status: 0, stdout: `${app}\n` };
					}
				}
			);

			expect({
				availabilityQueries,
				publishPaths: await readFile(
					path.join(directory, 'cupboard-publish-paths.txt'),
					'utf8'
				)
			}).toStrictEqual({
				availabilityQueries: queried,
				publishPaths: selected
			});
		}
	);

	it('records a substituted output as copied without claiming a local build', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-build-test-')
		);
		temporaryDirectories.push(directory);
		let pathQueries = 0;

		await buildAction(
			{ installables: ['.#app'], attempts: '1' },
			{
				RUNNER_TEMP: directory,
				GITHUB_OUTPUT: path.join(directory, 'github-output')
			},
			{
				nix: {
					queryPathInfo: () => {
						pathQueries += 1;
						return pathQueries === 1
							? Promise.reject(new Error('not present'))
							: Promise.resolve(pathInfo(app, `${app}.drv`));
					}
				},
				runNix: async (invocation) => {
					if (invocation.arguments.includes('--dry-run')) {
						return {
							status: 0,
							stdout: `[ { "outputs": { "out": "${app}" } } ]`
						};
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

		const receiptText = await readFile(
			path.join(directory, 'cupboard-build-receipt.json'),
			'utf8'
		);
		const receiptJson: unknown = JSON.parse(receiptText);
		expect(buildReceiptSchema.parse(receiptJson)).toStrictEqual({
			version: 3,
			paths: [app],
			subjects: [
				{
					origin: 'copied',
					storePath: app,
					narHash: 'aa'.repeat(32),
					derivation: `${app}.drv`,
					signatures: []
				}
			]
		});
	});

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

	it.each([undefined, '', ' '.repeat(3)])(
		'requires the publication destination before planning with leave (%j)',
		async (publicationUrl) => {
			const runNix = vi.fn();
			await expect(
				buildAction(
					{ installables: ['.#app'], substituter: 'leave', publicationUrl },
					{},
					{ runNix }
				)
			).rejects.toThrow(BuildPublicationUrlMissingError);
			expect(runNix.mock.calls).toStrictEqual([]);
		}
	);

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

	it('does not rebuild a derivation from a failed attempt under build missing', async () => {
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
							stdout: `[{"drvPath":"${appDerivation}","outputs":{"out":"${app}","dev":null}}]`
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
				}
			],
			receipt: {
				version: 3,
				paths: [app],
				subjects: [
					{
						origin: 'copied',
						storePath: app,
						narHash: 'aa'.repeat(32),
						derivation: appDerivation,
						signatures: []
					}
				]
			}
		});
	});

	it.each([
		{ machine: '', changedHash: false, changedDeriver: false },
		{ machine: 'ssh-ng://builder', changedHash: false, changedDeriver: false },
		{ machine: '', changedHash: true, changedDeriver: false },
		{ machine: '', changedHash: false, changedDeriver: true }
	])(
		'preserves matching local evidence across retries ($machine, $changedHash, $changedDeriver)',
		async ({ machine, changedHash, changedDeriver }) => {
			const directory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-build-test-')
			);
			temporaryDirectories.push(directory);
			let attempt = 0;
			const derivation = `${app}.drv`;
			const libraryDerivation = `${library}.drv`;
			await buildAction(
				{
					installables: ['.#app', '.#lib'],
					attempts: '2',
					substituter: 'leave',
					publicationUrl: 'https://cupboard.example/t/acme',
					keepGoing: 'true'
				},
				{
					RUNNER_TEMP: directory,
					GITHUB_OUTPUT: path.join(directory, 'github-output')
				},
				{
					nextAttemptId: () => `attempt-${String(attempt + 1)}`,
					sleep: () => Promise.resolve(),
					availabilitySettings,
					availabilityNix: {
						canSubstituteDerivation: () => Promise.resolve(true),
						honoursSubstituterSettings: () =>
							Promise.resolve({ isHonoured: true }),
						resolveSubstitutableClosure: () =>
							Promise.resolve({
								kind: 'served',
								pathCount: 1,
								downloadSize: 1,
								narSize: 1
							})
					},
					nix: {
						queryPathInfo: (storePath) => {
							if (attempt === 0 || (storePath === library && attempt === 1)) {
								return Promise.reject(new NixStorePathNotFoundError(storePath));
							}
							if (storePath === library) {
								return Promise.resolve({
									...pathInfo(library, libraryDerivation),
									ultimate: true
								});
							}

							return Promise.resolve({
								...pathInfo(
									app,
									changedDeriver && attempt === 2
										? `${app}-changed.drv`
										: derivation
								),
								ultimate: true,
								narHash: NixSha256Hash.fromDigest(
									Buffer.alloc(32, changedHash && attempt === 2 ? 0xbb : 0xaa)
								)
							});
						}
					},
					runNix: async (invocation) => {
						if (invocation.arguments.includes('--dry-run')) {
							return {
								status: 0,
								stdout: JSON.stringify([
									{ drvPath: derivation, outputs: { out: app } },
									{ drvPath: libraryDerivation, outputs: { out: library } }
								])
							};
						}
						attempt += 1;
						const logFile =
							invocation.arguments[
								invocation.arguments.indexOf('json-log-path') + 1
							];
						if (logFile === undefined) {
							throw new Error('missing json-log-path');
						}
						await writeFile(
							logFile,
							attempt === 1
								? `${buildStart(derivation, machine)}\n`
								: `${buildStart(libraryDerivation)}\n`
						);
						return {
							status: attempt === 1 ? 1 : 0,
							stdout: attempt === 1 ? '' : `${app}\n${library}\n`
						};
					}
				}
			);
			const receiptText = await readFile(
				path.join(directory, 'cupboard-build-receipt.json'),
				'utf8'
			);
			const receipt = buildReceiptV3Schema.parse(JSON.parse(receiptText));
			const builtReceiptText = await readFile(
				path.join(directory, 'cupboard-built-receipt.json'),
				'utf8'
			);
			const builtReceipt = buildReceiptV3Schema.parse(
				JSON.parse(builtReceiptText)
			);
			const appSubject =
				machine === '' && !changedHash && !changedDeriver
					? {
							origin: 'built',
							storePath: app,
							narHash: 'aa'.repeat(32),
							derivation,
							attempt: 1,
							attemptId: 'attempt-1',
							buildStore: 'auto',
							verification: 'local'
						}
					: {
							origin: 'store-held',
							storePath: app,
							narHash: (changedHash ? 'bb' : 'aa').repeat(32),
							derivation: changedDeriver ? `${app}-changed.drv` : derivation,
							buildStore: 'auto'
						};
			const librarySubject = {
				origin: 'built',
				storePath: library,
				narHash: 'aa'.repeat(32),
				derivation: libraryDerivation,
				attempt: 2,
				attemptId: 'attempt-2',
				buildStore: 'auto',
				verification: 'local'
			};

			expect({
				receipt,
				builtReceipt,
				published: await readFile(
					path.join(directory, 'cupboard-publish-paths.txt'),
					'utf8'
				)
			}).toStrictEqual({
				receipt: {
					version: 3,
					paths: [app, library],
					subjects: [appSubject, librarySubject]
				},
				builtReceipt: {
					version: 3,
					paths:
						machine === '' && !changedHash && !changedDeriver
							? [app, library]
							: [library],
					subjects:
						machine === '' && !changedHash && !changedDeriver
							? [appSubject, librarySubject]
							: [librarySubject]
				},
				published:
					changedHash || changedDeriver
						? `${library}\n`
						: `${app}\n${library}\n`
			});
		}
	);

	it.each([true, false])(
		'uses the dry-run derivation when the recorded deriver is absent (warm: %s)',
		async (warm) => {
			const directory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-build-test-')
			);
			temporaryDirectories.push(directory);
			const derivation = `${app}.drv`;
			let builds = 0;
			await buildAction(
				{ installables: ['.#app'], build: 'rebuild', attempts: '1' },
				{
					RUNNER_TEMP: directory,
					GITHUB_OUTPUT: path.join(directory, 'output')
				},
				{
					nextAttemptId: () => 'missing-deriver',
					nix: {
						queryPathInfo: () =>
							builds === 0 && !warm
								? Promise.reject(new NixStorePathNotFoundError(app))
								: Promise.resolve({ ...pathInfo(app), ultimate: true })
					},
					runNix: async (invocation) => {
						if (invocation.arguments.includes('--dry-run')) {
							return {
								status: 0,
								stdout: JSON.stringify([
									{ drvPath: derivation, outputs: { out: app } }
								])
							};
						}
						builds += 1;
						const log =
							invocation.arguments[
								invocation.arguments.indexOf('json-log-path') + 1
							];
						if (log === undefined) {
							throw new Error('missing log');
						}
						await writeFile(log, `${buildStart(derivation)}\n`);
						return { status: 0, stdout: `${app}\n` };
					}
				}
			);
			const receiptText = await readFile(
				path.join(directory, 'cupboard-built-receipt.json'),
				'utf8'
			);
			const receipt = buildReceiptV3Schema.parse(JSON.parse(receiptText));
			expect({ builds, receipt }).toStrictEqual({
				builds: warm ? 2 : 1,
				receipt: {
					version: 3,
					paths: [app],
					subjects: [
						{
							origin: 'built',
							storePath: app,
							narHash: 'aa'.repeat(32),
							derivation,
							attempt: 1,
							attemptId: 'missing-deriver',
							buildStore: 'auto',
							verification: 'local',
							...(warm && { reproduced: true })
						}
					]
				}
			});
		}
	);

	it.each(['true', 'false'])(
		'fails missing successful-build observation without retrying (allow-failure: %s)',
		async (allowFailure) => {
			vi.useFakeTimers({ toFake: ['Date'] });
			vi.setSystemTime(0);
			const directory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-build-test-')
			);
			temporaryDirectories.push(directory);
			const sleep = vi.fn((delayMs: number) => {
				vi.setSystemTime(Date.now() + delayMs);
				return Promise.resolve();
			});
			const runNix = vi.fn((invocation: { arguments: readonly string[] }) =>
				Promise.resolve({
					status: 0,
					stdout: invocation.arguments.includes('--dry-run')
						? JSON.stringify([{ drvPath: `${app}.drv`, outputs: { out: app } }])
						: `${app}\n`
				})
			);
			await expect(
				buildAction(
					{ installables: ['.#app'], build: 'rebuild', allowFailure },
					{ RUNNER_TEMP: directory },
					{
						sleep,
						runNix,
						nix: {
							queryPathInfo: () => Promise.resolve(pathInfo(app, `${app}.drv`))
						}
					}
				)
			).rejects.toBeInstanceOf(BuildObservationMissingError);
			expect({
				runs: runNix.mock.calls.length,
				sleeps: sleep.mock.calls,
				elapsed: Date.now()
			}).toStrictEqual({ runs: 3, sleeps: [], elapsed: 0 });
		}
	);

	it.each([
		{ legacy: 'true', build: undefined, fails: false },
		{ legacy: 'true', build: 'missing', fails: true }
	])(
		'retains deprecated provenance guarantee ($build)',
		async ({ legacy, build, fails }) => {
			const directory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-build-test-')
			);
			temporaryDirectories.push(directory);
			const runNix = vi.fn(() => Promise.resolve({ status: 1, stdout: '' }));
			const result = buildAction(
				{
					installables: ['.#app'],
					requireProvenance: legacy,
					build,
					attempts: '1'
				},
				{ RUNNER_TEMP: directory },
				{
					runNix,
					buildSettings: {
						systems: ['x86_64-linux'],
						features: [],
						builders: 'ssh://builder'
					}
				}
			);
			await expect(result).rejects.toMatchObject({
				name: fails
					? 'BuildProvenanceConflictError'
					: 'BuildRebuildRemoteDispatchError'
			});
			expect(runNix.mock.calls).toStrictEqual([]);
		}
	);

	it('rejects configured builders before planning a rebuild', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-build-test-')
		);
		temporaryDirectories.push(directory);
		const runNix = vi.fn(() => Promise.resolve({ status: 0, stdout: '' }));
		await expect(
			buildAction(
				{ installables: ['.#app'], build: 'rebuild' },
				{ RUNNER_TEMP: directory },
				{
					buildSettings: {
						systems: ['x86_64-linux'],
						features: [],
						builders: 'ssh-ng://builder x86_64-linux'
					},
					runNix
				}
			)
		).rejects.toStrictEqual(new BuildRebuildRemoteDispatchError());
		expect(runNix.mock.calls).toStrictEqual([]);
	});

	it('rebuilds a substituted output in the selected store', async () => {
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
				build: 'rebuild'
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

						return Promise.resolve({
							...pathInfo(app, appDerivation),
							ultimate: pathQueries > 2
						});
					}
				},
				runNix: async (invocation) => {
					invocations.push(invocation);
					if (invocation.arguments.includes('--dry-run')) {
						return {
							status: 0,
							stdout: `[{"drvPath":"${appDerivation}","outputs":{"out":"${app}","dev":null}}]`
						};
					}
					if (invocation.arguments.includes('--rebuild')) {
						const logFile =
							invocation.arguments[
								invocation.arguments.indexOf('json-log-path') + 1
							];
						if (logFile === undefined) {
							throw new Error('missing json-log-path');
						}
						await writeFile(logFile, `${buildStart(appDerivation)}\n`);
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
						'--option',
						'builders',
						'',
						'--no-link',
						'--option',
						'json-log-path',
						path.join(
							directory,
							'cupboard-nix-current-run-rebuild-1-rebuild.jsonl'
						),
						'--stdin'
					],
					stdin: `${appDerivation}^out\n`
				}
			],
			receipt: {
				version: 3,
				paths: [app],
				subjects: [
					{
						origin: 'built',
						storePath: app,
						narHash: 'aa'.repeat(32),
						derivation: appDerivation,
						attempt: 1,
						attemptId: 'current-run-rebuild',
						buildStore: 'auto',
						verification: 'local',
						reproduced: true
					}
				]
			}
		});
	});

	it('rebuilds an output already in the selected store', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-build-test-')
		);
		temporaryDirectories.push(directory);
		const derivation = `${app}.drv`;
		const invocations: string[][] = [];
		let attempt = 0;

		await buildAction(
			{ installables: ['.#app'], attempts: '1', build: 'rebuild' },
			{
				RUNNER_TEMP: directory,
				GITHUB_OUTPUT: path.join(directory, 'github-output')
			},
			{
				nextAttemptId: () => `attempt-${String(++attempt)}`,
				nix: {
					queryPathInfo: () =>
						Promise.resolve({ ...pathInfo(app, derivation), ultimate: true })
				},
				runNix: async ({ arguments: arguments_ }) => {
					invocations.push([...arguments_]);
					if (arguments_.includes('--dry-run')) {
						return {
							status: 0,
							stdout: `[{"outputs":{"out":"${app}"}}]`
						};
					}

					const logFile = arguments_[arguments_.indexOf('json-log-path') + 1];
					if (logFile === undefined) {
						throw new Error('missing json-log-path');
					}
					await writeFile(logFile, '');
					if (arguments_.includes('--rebuild')) {
						await writeFile(logFile, `${buildStart(derivation)}\n`);
					}
					return {
						status: 0,
						stdout: arguments_.includes('--rebuild') ? '' : `${app}\n`
					};
				}
			}
		);

		const receiptText = await readFile(
			path.join(directory, 'cupboard-build-receipt.json'),
			'utf8'
		);
		const receipt: unknown = JSON.parse(receiptText);
		expect({
			invocations,
			receipt: buildReceiptSchema.parse(receipt),
			publishPaths: await readFile(
				path.join(directory, 'cupboard-publish-paths.txt'),
				'utf8'
			)
		}).toStrictEqual({
			invocations: [
				['build', '--dry-run', '--json', '--no-link', '--stdin'],
				[
					'build',
					'--no-link',
					'--print-out-paths',
					'--option',
					'json-log-path',
					path.join(directory, 'cupboard-nix-attempt-1.jsonl'),
					'--stdin'
				],
				[
					'build',
					'--rebuild',
					'--option',
					'builders',
					'',
					'--no-link',
					'--option',
					'json-log-path',
					path.join(directory, 'cupboard-nix-attempt-2-1-rebuild.jsonl'),
					'--stdin'
				]
			],
			receipt: {
				version: 3,
				paths: [app],
				subjects: [
					{
						origin: 'built',
						storePath: app,
						narHash: 'aa'.repeat(32),
						derivation,
						attempt: 1,
						attemptId: 'attempt-2',
						buildStore: 'auto',
						verification: 'local',
						reproduced: true
					}
				]
			},
			publishPaths: `${app}\n`
		});
	});

	it.each(['realise', 'check'])(
		'rejects delegated %s activity as rebuild evidence',
		async (phase) => {
			const directory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-build-test-')
			);
			temporaryDirectories.push(directory);
			const derivation = `${app}.drv`;
			await expect(
				buildAction(
					{ installables: ['.#app'], attempts: '1', build: 'rebuild' },
					{
						RUNNER_TEMP: directory,
						GITHUB_OUTPUT: path.join(directory, 'github-output')
					},
					{
						nix: {
							queryPathInfo: () => Promise.resolve(pathInfo(app, derivation))
						},
						runNix: async ({ arguments: arguments_ }) => {
							const logFile =
								arguments_[arguments_.indexOf('json-log-path') + 1];
							if (logFile !== undefined && !arguments_.includes('--dry-run')) {
								const matchingPhase = arguments_.includes('--rebuild')
									? 'check'
									: 'realise';
								await writeFile(
									logFile,
									matchingPhase === phase
										? `${buildStart(derivation, 'ssh-ng://builder')}\n`
										: ''
								);
							}
							return {
								status: 0,
								stdout: arguments_.includes('--dry-run')
									? `[{"outputs":{"out":"${app}"}}]`
									: `${app}\n`
							};
						}
					}
				)
			).rejects.toStrictEqual(new BuildRebuildRemoteDispatchError());
			expect(
				existsSync(path.join(directory, 'cupboard-build-receipt.json'))
			).toBe(false);
		}
	);

	it.each([true, false])(
		'observes a fresh store build when the first activity log is present: %s',
		async (hasActivityLog) => {
			const directory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-build-test-')
			);
			temporaryDirectories.push(directory);
			const derivation = `${app}.drv`;
			const invocations: string[] = [];
			let pathQueries = 0;

			await buildAction(
				{ installables: ['.#app'], attempts: '1', build: 'rebuild' },
				{
					RUNNER_TEMP: directory,
					GITHUB_OUTPUT: path.join(directory, 'github-output')
				},
				{
					nextAttemptId: () => 'fresh-local',
					nix: {
						queryPathInfo: () => {
							pathQueries += 1;
							return pathQueries === 1
								? Promise.reject(new NixStorePathNotFoundError(app))
								: Promise.resolve({
										...pathInfo(app, derivation),
										ultimate: true
									});
						}
					},
					runNix: async ({ arguments: arguments_ }) => {
						if (arguments_.includes('--dry-run')) {
							invocations.push('dry-run');
							return { status: 0, stdout: `[{"outputs":{"out":"${app}"}}]` };
						}
						invocations.push(
							arguments_.includes('--rebuild') ? 'rebuild' : 'realise'
						);
						const logFile = arguments_[arguments_.indexOf('json-log-path') + 1];
						if (logFile === undefined) {
							throw new Error('missing json-log-path');
						}
						if (hasActivityLog || arguments_.includes('--rebuild')) {
							await writeFile(logFile, `${buildStart(derivation)}\n`);
						}
						return { status: 0, stdout: `${app}\n` };
					}
				}
			);

			const receiptText = await readFile(
				path.join(directory, 'cupboard-build-receipt.json'),
				'utf8'
			);
			const receipt: unknown = JSON.parse(receiptText);
			expect({
				invocations,
				receipt: buildReceiptSchema.parse(receipt)
			}).toStrictEqual({
				invocations: [
					'dry-run',
					'realise',
					...(hasActivityLog ? [] : ['rebuild'])
				],
				receipt: {
					version: 3,
					paths: [app],
					subjects: [
						{
							origin: 'built',
							storePath: app,
							narHash: 'aa'.repeat(32),
							derivation,
							buildStore: 'auto',
							attempt: 1,
							attemptId: 'fresh-local',
							verification: 'local',
							...(!hasActivityLog && { reproduced: true })
						}
					]
				}
			});
		}
	);

	it('retries a failed rebuild without attributing the failed check', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-build-test-')
		);
		temporaryDirectories.push(directory);
		const derivation = `${app}.drv`;
		const invocations: string[] = [];
		const retryDelays: number[] = [];
		let checkCount = 0;

		await buildAction(
			{ installables: ['.#app'], attempts: '2', build: 'rebuild' },
			{
				RUNNER_TEMP: directory,
				GITHUB_OUTPUT: path.join(directory, 'github-output')
			},
			{
				nextAttemptId: () => 'retry-check',
				sleep: (delayMs) => {
					retryDelays.push(delayMs);
					return Promise.resolve();
				},
				nix: {
					queryPathInfo: () =>
						Promise.resolve({ ...pathInfo(app, derivation), ultimate: true })
				},
				runNix: async ({ arguments: arguments_ }) => {
					if (arguments_.includes('--dry-run')) {
						invocations.push('dry-run');
						return {
							status: 0,
							stdout: `[{"outputs":{"out":"${app}"}}]`
						};
					}
					if (arguments_.includes('--rebuild')) {
						checkCount += 1;
						invocations.push('rebuild');
						const logFile = arguments_[arguments_.indexOf('json-log-path') + 1];
						if (logFile === undefined) {
							throw new Error('missing json-log-path');
						}
						await writeFile(logFile, `${buildStart(derivation)}\n`);
						return {
							status: checkCount === 1 ? 1 : 0,
							stdout: ''
						};
					}
					invocations.push('realise');
					return { status: 0, stdout: `${app}\n` };
				}
			}
		);

		const receiptText = await readFile(
			path.join(directory, 'cupboard-build-receipt.json'),
			'utf8'
		);
		const receipt: unknown = JSON.parse(receiptText);
		expect({
			invocations,
			retryDelays,
			receipt: buildReceiptSchema.parse(receipt)
		}).toStrictEqual({
			invocations: ['dry-run', 'realise', 'rebuild', 'realise', 'rebuild'],
			retryDelays: [15_000],
			receipt: {
				version: 3,
				paths: [app],
				subjects: [
					{
						origin: 'built',
						storePath: app,
						narHash: 'aa'.repeat(32),
						derivation,
						buildStore: 'auto',
						attempt: 2,
						attemptId: 'retry-check',
						verification: 'local',
						reproduced: true
					}
				]
			}
		});
	});

	it('rejects a pre-existing output when the rebuild has no build activity', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-build-test-')
		);
		temporaryDirectories.push(directory);
		const derivation = `${app}.drv`;

		await expect(
			buildAction(
				{ installables: ['.#app'], attempts: '1', build: 'rebuild' },
				{
					RUNNER_TEMP: directory,
					GITHUB_OUTPUT: path.join(directory, 'github-output')
				},
				{
					nix: {
						queryPathInfo: () =>
							Promise.resolve({ ...pathInfo(app, derivation), ultimate: true })
					},
					runNix: ({ arguments: arguments_ }) =>
						Promise.resolve({
							status: 0,
							stdout: arguments_.includes('--dry-run')
								? `[{"drvPath":"${derivation}","outputs":{"out":"${app}"}}]`
								: arguments_.includes('--rebuild')
									? ''
									: `${app}\n`
						})
				}
			)
		).rejects.toMatchObject({
			constructor: BuildObservationMissingError,
			storePaths: [app]
		});
	});

	it('fails when the selected store cannot complete a rebuild', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-build-test-')
		);
		temporaryDirectories.push(directory);
		const derivation = `${app}.drv`;

		await expect(
			buildAction(
				{ installables: ['.#app'], attempts: '1', build: 'rebuild' },
				{
					RUNNER_TEMP: directory,
					GITHUB_OUTPUT: path.join(directory, 'github-output')
				},
				{
					nix: {
						queryPathInfo: () => Promise.resolve(pathInfo(app, derivation))
					},
					runNix: ({ arguments: arguments_ }) =>
						Promise.resolve({
							status: arguments_.includes('--rebuild') ? 7 : 0,
							stdout: arguments_.includes('--dry-run')
								? `[{"outputs":{"out":"${app}"}}]`
								: `${app}\n`
						})
				}
			)
		).rejects.toMatchObject({
			constructor: CommandFailedError,
			command: 'nix build --rebuild',
			status: 7
		});
	});

	it('publishes an output from a configured remote builder without claiming a current-run build', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-build-test-')
		);
		temporaryDirectories.push(directory);
		const derivation = `${app}.drv`;
		const invocations: string[][] = [];
		let pathQueries = 0;

		await buildAction(
			{
				installables: ['.#app'],
				attempts: '1',
				build: 'missing',
				substituter: 'leave',
				publicationUrl: 'https://cupboard.example/t/acme'
			},
			{
				RUNNER_TEMP: directory,
				GITHUB_OUTPUT: path.join(directory, 'github-output')
			},
			{
				nextAttemptId: () => 'remote-build',
				nix: {
					queryPathInfo: () => {
						pathQueries += 1;
						return pathQueries === 1
							? Promise.reject(new Error('not present before build'))
							: Promise.resolve(pathInfo(app, derivation));
					}
				},
				runNix: async ({ arguments: arguments_ }) => {
					invocations.push([...arguments_]);
					if (arguments_.includes('--dry-run')) {
						return { status: 0, stdout: `[{"outputs":{"out":"${app}"}}]` };
					}

					const logFile = arguments_[arguments_.indexOf('json-log-path') + 1];
					if (logFile === undefined) {
						throw new Error('missing json-log-path');
					}
					await writeFile(
						logFile,
						`${buildStart(derivation, 'ssh://builder')}\n`
					);
					return { status: 0, stdout: `${app}\n` };
				}
			}
		);

		const receiptText = await readFile(
			path.join(directory, 'cupboard-build-receipt.json'),
			'utf8'
		);
		const receipt: unknown = JSON.parse(receiptText);
		expect({
			invocations,
			receipt: buildReceiptSchema.parse(receipt),
			publishPaths: await readFile(
				path.join(directory, 'cupboard-publish-paths.txt'),
				'utf8'
			)
		}).toStrictEqual({
			invocations: [
				['build', '--dry-run', '--json', '--no-link', '--stdin'],
				[
					'build',
					'--no-link',
					'--print-out-paths',
					'--option',
					'json-log-path',
					expect.stringMatching(/cupboard-nix-.+\.jsonl/u),
					'--stdin'
				]
			],
			receipt: {
				version: 3,
				paths: [app],
				subjects: [
					{
						origin: 'copied',
						storePath: app,
						narHash: 'aa'.repeat(32),
						derivation,
						signatures: []
					}
				]
			},
			publishPaths: `${app}\n`
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
			[
				{ ...pathInfo(app, appDerivation), ultimate: true },
				{ ...pathInfo(library, libraryDerivation), ultimate: true }
			],
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

	it('does not attribute an output fetched from an already populated remote builder', () => {
		const derivation = `${app}.drv`;
		const subjects = receiptSubjects(
			[
				{
					attempt: 1,
					attemptId: 'one',
					activities: [{ derivation, machine: 'ssh-ng://builder' }]
				}
			],
			[pathInfo(app, derivation)],
			new Set()
		);

		expect(subjects).toStrictEqual([]);
	});

	it('does not attribute a local activity to an output that the store copied', () => {
		const derivation = `${app}.drv`;
		const subjects = receiptSubjects(
			[
				{
					attempt: 1,
					attemptId: 'one',
					activities: [{ derivation, machine: '' }]
				}
			],
			[pathInfo(app, derivation)],
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
			[
				{ ...pathInfo(app, appDerivation), ultimate: true },
				{ ...pathInfo(library, libraryDerivation), ultimate: true }
			],
			new Set([app, library]),
			new Set([app])
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

describe('built publication observation', () => {
	it.each([
		{ recordedDeriver: `${app}.drv`, hasGraph: true },
		{ recordedDeriver: `${library}.drv`, hasGraph: true },
		{ recordedDeriver: `${library}.drv`, hasGraph: false }
	])(
		'records tenant-only dependency metadata using the evaluated graph (recorded deriver: $recordedDeriver, graph: $hasGraph)',
		async ({ recordedDeriver, hasGraph }) => {
			const directory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-tenant-deps-')
			);
			temporaryDirectories.push(directory);
			const queryPathInfo = vi.fn((storePath: string) =>
				storePath === app
					? Promise.resolve(pathInfo(app, recordedDeriver))
					: Promise.reject(new Error('Dependency must not be queried locally'))
			);
			const protectedPaths: string[][] = [];
			await buildAction(
				{
					installables: [hasGraph ? '.#app' : app],
					publish: 'built',
					publicationUrl: 'https://cache.example/t/acme'
				},
				{ RUNNER_TEMP: directory },
				{
					nix: { queryPathInfo },
					graphNix: {
						readDerivation: (path) =>
							Promise.resolve(
								Derivation.parse(
									path === `${app}.drv`
										? `Derive([],[("${library}.drv",["out"])],[],"x86_64-linux","/bin/sh",[],[])`
										: `Derive([("out","${library}","","")],[],[],"x86_64-linux","/bin/sh",[],[])`
								)
							)
					},
					protection: {
						directory,
						protect: (paths) => {
							protectedPaths.push([...paths]);
							return Promise.resolve();
						}
					},
					createObservation: () =>
						Promise.resolve({
							environment: {},
							events: [],
							flush: () => Promise.resolve(),
							close: () => Promise.resolve()
						}),
					runNix: ({ arguments: arguments_ }) =>
						Promise.resolve({
							status: 0,
							stdout: arguments_.includes('--dry-run')
								? JSON.stringify([
										{
											...(hasGraph && { drvPath: `${app}.drv` }),
											outputs: { out: app }
										}
									])
								: `${app}\n`
						}),
					tenantDependencyReferences: (paths) =>
						Promise.resolve(
							paths.map((storePath) => ({
								storePath,
								kind: 'intermediate' as const,
								source: 'https://cache.example/t/acme/reuse/prs',
								narinfo: `StorePath: ${storePath}\nURL: nar/file.nar.zst\nCompression: zstd\nFileHash: sha256:${'0'.repeat(52)}\nFileSize: 1\nNarHash: sha256:${'0'.repeat(52)}\nNarSize: 1\nReferences: \n`
							}))
						)
				}
			);
			const receiptContents = await readFile(
				path.join(directory, 'cupboard-build-receipt.json'),
				'utf8'
			);
			const receipt = buildReceiptV3Schema.parse(JSON.parse(receiptContents));
			expect({
				paths: receipt.paths,
				dependencies: receipt.subjects.filter(
					(subject) => subject.origin === 'republished'
				),
				protectedDependencies: protectedPaths
					.flat()
					.filter((path) => path === library),
				intermediates: await readFile(
					path.join(directory, 'cupboard-intermediate-paths.txt'),
					'utf8'
				)
			}).toStrictEqual({
				paths: hasGraph ? [app, library] : [app],
				dependencies: hasGraph
					? [
							{
								origin: 'republished',
								storePath: library,
								narHash: '0'.repeat(64),
								signatures: [],
								metadataSource: 'https://cache.example/t/acme/reuse/prs'
							}
						]
					: [],
				protectedDependencies: [],
				intermediates: hasGraph ? `${library}\n` : ''
			});
		}
	);

	it.each([false, true])(
		'protects copied requested survivors before retry backoff (pre-existing: %s)',
		async (isPreExisting) => {
			const directory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-copy-root-test-')
			);
			temporaryDirectories.push(directory);
			const environment = { RUNNER_TEMP: directory };
			const protectedPaths = new Set<string>();
			const beforeBuild: string[][] = [];
			const beforeBackoff: string[][] = [];
			let hasAttempted = false;
			await buildAction(
				{
					installables: ['.#app', '.#library'],
					publish: 'built',
					attempts: '2',
					keepGoing: 'true',
					allowFailure: 'true'
				},
				environment,
				{
					protection: {
						directory,
						protect(paths) {
							for (const storePath of paths) {
								protectedPaths.add(storePath);
							}
							return Promise.resolve();
						}
					},
					createObservation: () =>
						Promise.resolve({
							environment,
							events: [],
							flush: () => Promise.resolve(),
							close: () => Promise.resolve()
						}),
					nix: {
						queryPathInfo(storePath) {
							if (storePath === library && (hasAttempted || isPreExisting)) {
								return Promise.resolve(pathInfo(library, `${library}.drv`));
							}
							return Promise.reject(new NixStorePathNotFoundError(storePath));
						}
					},
					runNix: ({ arguments: arguments_ }) => {
						if (arguments_.includes('--dry-run')) {
							return Promise.resolve({
								status: 0,
								stdout: JSON.stringify([
									{ drvPath: `${app}.drv`, outputs: { out: app } },
									{ drvPath: `${library}.drv`, outputs: { out: library } }
								])
							});
						}
						beforeBuild.push([...protectedPaths]);
						hasAttempted = true;
						return Promise.resolve({ status: 1, stdout: '' });
					},
					sleep: () => {
						beforeBackoff.push([...protectedPaths]);
						return Promise.resolve();
					}
				}
			);
			expect({ beforeBuild, beforeBackoff }).toStrictEqual({
				beforeBuild: [isPreExisting ? [library] : [], [library]],
				beforeBackoff: [[library]]
			});
		}
	);

	it('rejects unreadable survivor metadata instead of treating the target as missing', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-survivor-test-')
		);
		temporaryDirectories.push(directory);
		const environment = { RUNNER_TEMP: directory };
		const failure = new Error('The Nix store database could not be read');
		let isInitialQuery = true;
		const close = vi.fn(() => Promise.resolve());
		const result = buildAction(
			{
				installables: ['.#app'],
				publish: 'built',
				attempts: '1',
				allowFailure: 'true'
			},
			environment,
			{
				protection: { directory, protect: () => Promise.resolve() },
				createObservation: () =>
					Promise.resolve({
						environment,
						events: [],
						flush: () => Promise.resolve(),
						close
					}),
				nix: {
					queryPathInfo(storePath) {
						if (isInitialQuery) {
							isInitialQuery = false;
							return Promise.reject(new NixStorePathNotFoundError(storePath));
						}
						return Promise.reject(failure);
					}
				},
				runNix: ({ arguments: arguments_ }) =>
					Promise.resolve(
						arguments_.includes('--dry-run')
							? {
									status: 0,
									stdout: JSON.stringify([
										{ drvPath: `${app}.drv`, outputs: { out: app } }
									])
								}
							: { status: 1, stdout: '' }
					)
			}
		);
		await expect(result).rejects.toBe(failure);
		expect(close.mock.calls).toStrictEqual([[]]);
	});

	it.each([
		{ status: 0, target: true, machine: '' },
		{ status: 0, target: true, machine: 'ssh-ng://builder' },
		{ status: 1, target: false, machine: '' }
	])(
		'publishes completed intermediates with status=$status and machine=$machine',
		async ({ status, target, machine }) => {
			const directory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-observed-test-')
			);
			temporaryDirectories.push(directory);
			const protectedPaths: string[] = [];
			const initialEvents = [
				{
					version: 1 as const,
					invocationId: 'observed-invocation',
					derivation: `${library}.drv`,
					outputPaths: [library]
				}
			];
			const events = initialEvents.map((event) =>
				buildEventSchema.parse(event)
			);
			const output = path.join(directory, 'github-output');
			const environment = { RUNNER_TEMP: directory, GITHUB_OUTPUT: output };
			let isRealised = false;
			const close = vi.fn(() => Promise.resolve());
			await buildAction(
				{
					installables: ['.#app'],
					publish: 'built',
					attempts: '1',
					allowFailure: 'true'
				},
				environment,
				{
					nextAttemptId: () => 'attempt-1',
					protection: {
						directory,
						protect(paths) {
							protectedPaths.push(...paths);
							return Promise.resolve();
						}
					},
					createObservation: () =>
						Promise.resolve({
							environment,
							get events() {
								return isRealised ? events : [];
							},
							flush: () => Promise.resolve(),
							close
						}),
					nix: {
						queryPathInfo(storePath) {
							if (!isRealised || (storePath === app && !target)) {
								return Promise.reject(new NixStorePathNotFoundError(storePath));
							}
							return Promise.resolve({
								...pathInfo(
									storePathSchema.parse(storePath),
									`${storePath}.drv`
								),
								ultimate: true
							});
						}
					},
					runNix: async ({ arguments: arguments_ }) => {
						if (arguments_.includes('--dry-run')) {
							return {
								status: 0,
								stdout: JSON.stringify([
									{ drvPath: `${app}.drv`, outputs: { out: app } }
								])
							};
						}
						isRealised = true;
						const logIndex = arguments_.indexOf('json-log-path');
						await writeFile(
							arguments_[logIndex + 1] ?? '',
							[
								buildStart(`${library}.drv`, machine),
								...(target ? [buildStart(`${app}.drv`)] : [])
							].join('\n')
						);
						return { status, stdout: target ? `${app}\n` : '' };
					}
				}
			);
			const receiptContents = await readFile(
				path.join(directory, 'cupboard-build-receipt.json'),
				'utf8'
			);
			const receiptJson: unknown = JSON.parse(receiptContents);
			const receipt = buildReceiptV3Schema.parse(receiptJson);
			expect(receipt.paths).toStrictEqual([...(target ? [app] : []), library]);
			expect(
				receipt.subjects.map(({ storePath, origin }) => ({ storePath, origin }))
			).toStrictEqual([
				...(target ? [{ storePath: app, origin: 'built' }] : []),
				{ storePath: library, origin: machine === '' ? 'built' : 'store-held' }
			]);
			expect(
				await readFile(
					path.join(directory, 'cupboard-publish-paths.txt'),
					'utf8'
				)
			).toBe(target ? `${app}\n` : '');
			expect(
				await readFile(
					path.join(directory, 'cupboard-intermediate-paths.txt'),
					'utf8'
				)
			).toBe(`${library}\n`);
			expect(close.mock.calls).toStrictEqual([[]]);
		}
	);
});
