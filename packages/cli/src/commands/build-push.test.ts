import {
	defaultFileTransferSettings,
	defaultSignatureSettings,
	type NixStoreConfig
} from '@cupboard/nix';
import {
	rootNameSchema,
	storeDirectorySchema,
	storePathSchema,
	ttlSecondsSchema
} from '@cupboard/nix-store/scalars';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { runCohortSequence } from '../build-push/cohorts.ts';
import {
	BuildCommandFailedError,
	CacheTargetConflictError,
	CliAbortError,
	CohortInputError,
	CohortsFileInvalidError,
	InvalidUploadConcurrencyError,
	NoRetainConflictError,
	OidcRetentionChoiceRequiredError,
	RunRootTtlWithoutRunRootError
} from '../errors.ts';

import {
	aggregateBuildReceipts,
	aggregateCohortTargets,
	betweenCohortCollector,
	createBuildPushDaemon,
	createNarArchiveForStore,
	multiCohortReceiptDocument,
	parseCohortsFile,
	registerBuildPushCommand,
	updateAggregateCohortRoot
} from './build-push.ts';

const tenantUrl = 'https://cupboard.example.workers.dev/t/acme';
const pathA = storePathSchema.parse(
	'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
);
const pathB = storePathSchema.parse(
	'/nix/store/1123456789abcdfghijklmnpqrsvwxyz-lib'
);
const pathC = storePathSchema.parse(
	'/nix/store/2123456789abcdfghijklmnpqrsvwxyz-docs'
);
const root = rootNameSchema.parse('main');
const ttl = ttlSecondsSchema.parse(60);
const nixConfig: NixStoreConfig = {
	storeUri: 'ssh-ng://builder@example.test',
	storeDirectory: storeDirectorySchema.parse('/nix/store'),
	stateDirectory: '/nix/var/nix',
	daemonSocketPath: '/nix/var/nix/daemon-socket/socket',
	daemonSetOptions: {},
	daemonOverrides: {},
	substitution: {
		substitute: true,
		alwaysAllowSubstitutes: false,
		fallback: false,
		substituters: []
	},
	building: { systems: ['x86_64-linux'], features: [] },
	fileTransfer: defaultFileTransferSettings,
	signatures: defaultSignatureSettings,
	unknownSettings: []
};

describe('createNarArchiveForStore', () => {
	it('reads a logical store path from its physical location', () => {
		const physicalPath =
			'/private/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app';
		const storePathOnDisk = vi.fn(() => physicalPath);
		const archive = createNarArchiveForStore({ storePathOnDisk })(pathA);

		expect({
			archivePath: archive.path,
			mappedPaths: storePathOnDisk.mock.calls
		}).toStrictEqual({
			archivePath: physicalPath,
			mappedPaths: [[pathA]]
		});
	});
});

describe('createBuildPushDaemon', () => {
	it('cancels and closes a pending store operation with the command signal', async () => {
		const controller = new AbortController();
		const reason = new Error('stop build-push');
		let closes = 0;
		const daemon = createBuildPushDaemon(nixConfig, {
			signal: controller.signal,
			connect: () =>
				Promise.resolve({
					write: () => Promise.resolve(),
					read: () =>
						new Promise<Uint8Array>((resolve) => {
							void resolve;
						}),
					close: () => {
						closes += 1;

						return Promise.resolve();
					}
				})
		});

		const query = daemon.queryValidPaths([pathA]);
		await Promise.resolve();
		controller.abort(reason);

		await expect(query).rejects.toBe(reason);
		expect(closes).toBe(1);
	});
});

describe('aggregateCohortTargets', () => {
	it('unions successful cohort targets in stable order', () => {
		expect(
			aggregateCohortTargets([
				[pathB, pathA],
				[pathC, pathA]
			])
		).toStrictEqual([pathA, pathB, pathC]);
	});

	it('replaces the root once with the union after every cohort succeeds', async () => {
		const setRoot = vi.fn(() => Promise.resolve());

		await updateAggregateCohortRoot(
			{
				cohortCount: 2,
				failed: false,
				root,
				settledTargets: new Map([
					[1, [pathA]],
					[2, [pathB]]
				]),
				ttlSeconds: ttl
			},
			setRoot
		);

		expect(setRoot.mock.calls).toStrictEqual([
			[root, { targets: [pathA, pathB], ttlSeconds: ttl }]
		]);
	});

	it('replaces the root with no targets when every cohort settles empty', async () => {
		const setRoot = vi.fn(() => Promise.resolve());

		await updateAggregateCohortRoot(
			{
				cohortCount: 2,
				failed: false,
				root,
				settledTargets: new Map()
			},
			setRoot
		);

		expect(setRoot.mock.calls).toStrictEqual([[root, { targets: [] }]]);
	});

	it('does not replace the root when any cohort failed', async () => {
		const setRoot = vi.fn(() => Promise.resolve());

		await updateAggregateCohortRoot(
			{
				cohortCount: 2,
				failed: true,
				root,
				settledTargets: new Map([
					[1, [pathA]],
					[2, [pathB]]
				])
			},
			setRoot
		);

		expect(setRoot.mock.calls).toStrictEqual([]);
	});
});

describe('aggregateBuildReceipts', () => {
	it('preserves successful paths and exact failed targets across a sequence', () => {
		expect(
			aggregateBuildReceipts([
				{
					version: 3,
					paths: [pathA],
					subjects: [],
					childExitStatus: 0
				},
				{
					version: 3,
					paths: [pathB],
					subjects: [],
					childExitStatus: 1,
					terminalFailure: {
						kind: 'target-build',
						failedTargets: ['.#optional']
					}
				}
			])
		).toStrictEqual({
			version: 3,
			paths: [pathA, pathB],
			subjects: [],
			childExitStatus: 1,
			terminalFailure: {
				kind: 'target-build',
				failedTargets: ['.#optional']
			},
			uploaded: [],
			failed: [],
			collected: []
		});
	});

	it('keeps the public envelope unless the V3 aggregate is explicit', () => {
		const receipts = [
			{
				version: 3 as const,
				paths: [pathA],
				subjects: [],
				childExitStatus: 0
			},
			{
				version: 3 as const,
				paths: [pathB],
				subjects: [],
				childExitStatus: 0
			}
		];

		expect({
			publicDocument: multiCohortReceiptDocument(receipts, false),
			aggregateDocument: multiCohortReceiptDocument(receipts, true)
		}).toStrictEqual({
			publicDocument: { receipts },
			aggregateDocument: {
				version: 3,
				paths: [pathA, pathB],
				subjects: [],
				uploaded: [],
				failed: [],
				collected: []
			}
		});
	});
});

function silentProgram(): Command {
	const program = new Command();

	program.exitOverride();
	program.configureOutput({
		writeErr() {
			return;
		},
		writeOut() {
			return;
		}
	});
	registerBuildPushCommand(program);

	return program;
}

async function parseBuildPush(arguments_: readonly string[]): Promise<unknown> {
	try {
		await silentProgram().parseAsync(['build-push', ...arguments_], {
			from: 'user'
		});

		return { kind: 'parsed' as const };
	} catch (error: unknown) {
		return error;
	}
}

describe('registerBuildPushCommand', () => {
	it('recognises a cache name only before the command boundary', async () => {
		const result = await parseBuildPush([
			`${tenantUrl}/cache/release`,
			'builds',
			'--',
			'nix',
			'build'
		]);

		expect(result).toBeInstanceOf(CacheTargetConflictError);
	});

	it('treats the sole positional as a cache in cohorts-file mode', async () => {
		const result = await parseBuildPush([
			`${tenantUrl}/cache/release`,
			'builds',
			'--cohorts-file',
			'plan.json'
		]);

		expect(result).toBeInstanceOf(CacheTargetConflictError);
	});

	it.each([
		{
			name: '--no-retain combined with --root',
			arguments_: [
				tenantUrl,
				'--no-retain',
				'--root',
				'main',
				'--',
				'nix',
				'build'
			],
			error: NoRetainConflictError
		},
		{
			name: '--no-retain combined with --ttl',
			arguments_: [
				tenantUrl,
				'--no-retain',
				'--ttl',
				'7d',
				'--',
				'nix',
				'build'
			],
			error: NoRetainConflictError
		},
		{
			name: '--run-root-ttl without --run-root',
			arguments_: [
				tenantUrl,
				'--root',
				'main',
				'--run-root-ttl',
				'1h',
				'--',
				'nix',
				'build'
			],
			error: RunRootTtlWithoutRunRootError
		},
		{
			name: 'a GitHub OIDC run naming neither --root nor --no-retain',
			arguments_: [tenantUrl, '--github-oidc', '--', 'nix', 'build'],
			error: OidcRetentionChoiceRequiredError
		},
		{
			name: 'a non-numeric --upload-concurrency',
			arguments_: [
				tenantUrl,
				'--upload-concurrency',
				'zero',
				'--',
				'nix',
				'build'
			],
			error: InvalidUploadConcurrencyError
		},
		{
			name: 'a missing build command',
			arguments_: [tenantUrl],
			error: CohortInputError
		},
		{
			name: 'a build command combined with a cohorts file',
			arguments_: [
				tenantUrl,
				'--cohorts-file',
				'cohorts.json',
				'--',
				'nix',
				'build'
			],
			error: CohortInputError
		}
	])('rejects $name', async ({ arguments_, error }) => {
		const result = await parseBuildPush(arguments_);

		expect(result).toBeInstanceOf(error);
	});
});

describe('parseCohortsFile', () => {
	it('parses command and constructed cohorts in order', () => {
		const contents = JSON.stringify({
			cohorts: [
				{ command: ['nix', 'build', '--no-link', '.#app'] },
				{
					installables: ['.#lib'],
					attempts: 2,
					rebuild: true,
					requireProvenance: true,
					keepGoing: true,
					maxJobs: 4
				},
				{ installables: ['.#docs'] }
			]
		});

		expect(parseCohortsFile(contents)).toStrictEqual([
			{ kind: 'command', command: ['nix', 'build', '--no-link', '.#app'] },
			{
				kind: 'constructed',
				build: {
					installables: ['.#lib'],
					attempts: 2,
					rebuild: true,
					requireProvenance: true,
					keepGoing: true,
					maxJobs: 4
				}
			},
			{ kind: 'constructed', build: { installables: ['.#docs'] } }
		]);
	});

	it('accepts a remote-builders-only cohort with zero local build jobs', () => {
		const contents = JSON.stringify({
			cohorts: [{ installables: ['.#app'], maxJobs: 0 }]
		});

		expect(parseCohortsFile(contents)).toStrictEqual([
			{ kind: 'constructed', build: { installables: ['.#app'], maxJobs: 0 } }
		]);
	});

	it.each([
		{ name: 'a body that is not JSON', contents: 'not json' },
		{ name: 'a body with no cohorts', contents: '{"cohorts": []}' },
		{
			name: 'a cohort with an empty command',
			contents: '{"cohorts": [{"command": []}]}'
		},
		{
			name: 'a cohort naming both forms',
			contents: '{"cohorts": [{"command": ["nix"], "installables": [".#app"]}]}'
		},
		{
			name: 'a cohort with an unknown key',
			contents: '{"cohorts": [{"installables": [".#app"], "surprise": 1}]}'
		}
	])('refuses $name', ({ contents }) => {
		let error: unknown;
		try {
			parseCohortsFile(contents);
		} catch (error_: unknown) {
			error = error_;
		}

		expect(error).toBeInstanceOf(CohortsFileInvalidError);
	});
});

describe('betweenCohortCollector', () => {
	interface CollectorRun {
		readonly commands: readonly (readonly string[])[];
		readonly warnings: readonly { label: string; value?: string }[];
	}

	async function runCollector(exitStatus: number): Promise<CollectorRun> {
		const commands: (readonly string[])[] = [];
		const warnings: { label: string; value?: string }[] = [];
		const collect = betweenCohortCollector(
			{
				warn(label, value) {
					warnings.push({ label, value });
				}
			},
			{
				runCollector: (options) => {
					commands.push(options.command);

					return Promise.resolve({ status: exitStatus, signal: undefined });
				}
			}
		);

		await collect();

		return { commands, warnings };
	}

	it('collects with nix store gc, silently on success', async () => {
		expect(await runCollector(0)).toStrictEqual({
			commands: [['nix', 'store', 'gc']],
			warnings: []
		});
	});

	it('surfaces a failed collection as a warning and carries on', async () => {
		expect(await runCollector(5)).toStrictEqual({
			commands: [['nix', 'store', 'gc']],
			warnings: [
				{
					label: 'collection failed',
					value:
						'nix store gc exited 5; the next cohort builds with the store as it stands'
				}
			]
		});
	});

	it('continues the sequence after an ordinary failed collection', async () => {
		const events: string[] = [];
		const warnings: string[] = [];
		const collect = betweenCohortCollector(
			{
				warn(label) {
					warnings.push(label);
				}
			},
			{
				runCollector: () => {
					events.push('collect');

					return Promise.resolve({ status: 5, signal: undefined });
				}
			}
		);
		const receipt = aggregateBuildReceipts([]);

		await runCohortSequence(
			{
				cohorts: [
					{ kind: 'command', command: ['true'] },
					{ kind: 'command', command: ['true'] }
				],
				collectBetweenCohorts: true
			},
			{
				runCohort: (_invocation, cohort) => {
					events.push(`cohort:${String(cohort)}`);

					return Promise.resolve(receipt);
				},
				collect
			}
		);

		expect({ events, warnings }).toStrictEqual({
			events: ['cohort:1', 'collect', 'cohort:2'],
			warnings: ['collection failed']
		});
	});

	it.each([
		{ signal: 'SIGINT' as const, exitCode: 130 },
		{ signal: 'SIGTERM' as const, exitCode: 143 }
	])(
		'surfaces a collection killed by $signal as typed cancellation',
		async ({ signal, exitCode }) => {
			const collect = betweenCohortCollector(
				{ warn: vi.fn() },
				{
					runCollector: () => Promise.resolve({ status: undefined, signal })
				}
			);
			let error: unknown;

			try {
				await collect();
			} catch (error_: unknown) {
				error = error_;
			}

			expect({
				isTyped: error instanceof BuildCommandFailedError,
				status:
					error instanceof BuildCommandFailedError ? error.status : undefined,
				signal:
					error instanceof BuildCommandFailedError ? error.signal : undefined,
				exitCode:
					error instanceof BuildCommandFailedError ? error.exitCode : undefined
			}).toStrictEqual({
				isTyped: true,
				status: undefined,
				signal,
				exitCode
			});
		}
	);

	it.each([
		{ signal: 'SIGINT' as const, exitCode: 130 },
		{ signal: 'SIGTERM' as const, exitCode: 143 }
	])(
		'surfaces a collection that translates $signal to status $exitCode as typed cancellation',
		async ({ signal, exitCode }) => {
			const warnings: string[] = [];
			const collect = betweenCohortCollector(
				{
					warn: (label) => {
						warnings.push(label);
					}
				},
				{
					runCollector: () =>
						Promise.resolve({ status: exitCode, signal: undefined })
				}
			);
			let error: unknown;

			try {
				await collect();
			} catch (error_: unknown) {
				error = error_;
			}

			expect({ error, warnings }).toStrictEqual({
				error: new BuildCommandFailedError(exitCode, signal, exitCode),
				warnings: []
			});
		}
	);

	it.each(['before', 'after'] as const)(
		'stops on an abort $phase the collector without warning or further work',
		async (phase) => {
			const controller = new AbortController();
			const reason = new CliAbortError();
			const events: string[] = [];
			const warnings: string[] = [];

			if (phase === 'before') {
				controller.abort(reason);
			}

			const collect = betweenCohortCollector(
				{
					warn: (label) => {
						warnings.push(label);
					}
				},
				{
					signal: controller.signal,
					runCollector: () => {
						events.push('collect');

						if (phase === 'after') {
							controller.abort(reason);
						}

						return Promise.resolve({ status: 0, signal: undefined });
					}
				}
			);

			await expect(collect()).rejects.toBe(reason);
			expect({ events, warnings }).toStrictEqual({
				events: phase === 'before' ? [] : ['collect'],
				warnings: []
			});
		}
	);

	it('forwards an in-flight abort to the collector child', async () => {
		const controller = new AbortController();
		const reason = new CliAbortError();
		const started = Promise.withResolvers<undefined>();
		let receivedSignal: AbortSignal | undefined;
		const collect = betweenCohortCollector(
			{ warn: vi.fn() },
			{
				signal: controller.signal,
				runCollector: (options) => {
					const signal = options.signal;

					receivedSignal = signal;
					started.resolve(undefined);

					if (signal === undefined) {
						return Promise.resolve({ status: 0, signal: undefined });
					}

					return new Promise((resolve) => {
						signal.addEventListener(
							'abort',
							() => {
								resolve({ status: undefined, signal: 'SIGTERM' });
							},
							{ once: true }
						);
					});
				}
			}
		);
		const collecting = collect();

		await started.promise;
		expect(receivedSignal).toBe(controller.signal);
		controller.abort(reason);

		await expect(collecting).rejects.toBe(reason);
	});
});
