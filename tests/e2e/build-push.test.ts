import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import {
	selectorForCache,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { invocationIdSchema } from '@cupboard/protocol/build';
import type { Reporter } from '@cupboard/reporter';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	type BuildPushRunOptions,
	hookScriptFileName,
	runBuildPush
} from '../../packages/cli/src/build-push/build-push.ts';
import { renderHookScript } from '../../packages/cli/src/build-push/hook-script.ts';
import { preflightBuildPush } from '../../packages/cli/src/build-push/preflight.ts';
import type { ChildCommand } from '../../packages/cli/src/build-push/supervisor.ts';
import { storedCacheFor } from '../../packages/cli/src/client/client.ts';
import {
	BuildCommandFailedError,
	BuildPublicationFailedError
} from '../../packages/cli/src/errors.ts';
import type { PushClient } from '../../packages/cli/src/push/push.ts';
import {
	createNixDaemonStoreClient,
	discoverNixStoreConfig,
	Nix
} from '../../packages/nix/src/index.ts';
import { CupboardTestServer } from '../support/cupboard-server.ts';
import { NixStore } from '../support/nix.ts';

const run = promisify(execFile);
const isDaemonSocketPresent = existsSync('/nix/var/nix/daemon-socket/socket');
const isCompilerPresent = spawnSync('cc', ['--version']).status === 0;
const helperSource = path.resolve(
	import.meta.dirname,
	'../../packages/cli/hook-helper/cupboard-hook-relay.c'
);
const fakeDrvPath = '/nix/store/8123456789abcdfghijklmnpqrsvwxyz-e2e.drv';

// A child that records the runtime directory and socket modes while the run
// is live, the only moment they exist.
const recordModesScript = [
	"const fs = require('fs');",
	'const [directory, socket, outFile] = process.argv.slice(1);',
	'const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);',
	'fs.writeFileSync(',
	'\toutFile,',
	'\tJSON.stringify({ directory: mode(directory), socket: mode(socket) })',
	');'
].join('\n');

interface RecordedRun {
	readonly warnings: { label: string; value?: string }[];
}

function recordingReporter(record: RecordedRun): Reporter {
	const recordWarn = (label: string, value?: string): void => {
		record.warnings.push({ label, ...(value !== undefined && { value }) });
	};
	const facts = {
		fact() {
			return;
		},
		warn: recordWarn
	};

	return {
		phase: (_label, body) => Promise.resolve(body(facts)),
		progress: (_label, _options, body) =>
			Promise.resolve(
				body({
					advance() {
						return;
					},
					...facts
				})
			),
		steps: (_label, body) =>
			Promise.resolve(
				body({
					message() {
						return;
					},
					group: () => ({
						message() {
							return;
						},
						success() {
							return;
						},
						error() {
							return;
						}
					}),
					warn: recordWarn
				})
			),
		result() {
			return;
		},
		data() {
			return;
		},
		error() {
			return;
		},
		warn: recordWarn,
		info() {
			return;
		},
		success() {
			return;
		},
		step() {
			return;
		}
	};
}

interface RunConfig {
	readonly command: (scriptPath: string) => ChildCommand;
	readonly options?: Partial<BuildPushRunOptions>;
	readonly uploadFailure?: Error;
	readonly environment?: NodeJS.ProcessEnv;
}

interface RunOutcome {
	readonly error: unknown;
	readonly warnings: RecordedRun['warnings'];
	readonly receiptPaths: readonly string[];
	readonly runtimeDirectory: string;
	readonly socketPath: string;
}

function clientWithFailingUpload(
	base: PushClient,
	failure: Error | undefined
): PushClient {
	if (failure === undefined) {
		return base;
	}

	return { ...base, uploadNar: () => Promise.reject(failure) };
}

function fireHook(scriptPath: string, outPaths: readonly string[]): string {
	return `DRV_PATH='${fakeDrvPath}' OUT_PATHS='${outPaths.join(' ')}' '${scriptPath}'`;
}

// The receipt's paths list: plain store-path strings, sorted here so the
// assertions are order-independent. A run that never reached the receipt
// reads as an empty list.
async function readReceiptPaths(
	receiptFile: string
): Promise<readonly string[]> {
	try {
		const receipt: unknown = JSON.parse(await readFile(receiptFile, 'utf8'));
		const parsed =
			receipt !== null &&
			typeof receipt === 'object' &&
			'paths' in receipt &&
			Array.isArray(receipt.paths)
				? receipt.paths
				: [];

		return parsed
			.filter((entry: unknown): entry is string => typeof entry === 'string')
			.toSorted((left, right) => left.localeCompare(right));
	} catch {
		return [];
	}
}

async function servedStatuses(
	server: CupboardTestServer,
	paths: readonly StorePathString[]
): Promise<Readonly<Record<string, number>>> {
	const statuses = await Promise.all(
		paths.map(async (storePath) => {
			const response = await fetch(
				server.tenantPath(`/${StorePath.hash(storePath)}.narinfo`)
			);

			return [storePath, response.status] as const;
		})
	);

	return Object.fromEntries(statuses);
}

describe.skipIf(!isDaemonSocketPresent || !isCompilerPresent)(
	'build-push end to end',
	() => {
		let workspace: string;
		let helperPath: string;
		let server: CupboardTestServer;
		let client: PushClient;
		let store: NixStore;
		let daemon: ReturnType<typeof createNixDaemonStoreClient>;
		let nix: Nix;
		let nixConfig: ReturnType<typeof discoverNixStoreConfig>;
		let isDaemonTrusted = false;
		let outA: StorePathString;
		let outB: StorePathString;
		let runCounter = 0;

		beforeAll(async () => {
			workspace = await mkdtemp(path.join(tmpdir(), 'cupboard-bp-e2e-'));
			helperPath = path.join(workspace, 'cupboard-hook-relay');
			await run('cc', ['-O2', '-o', helperPath, helperSource]);

			server = await CupboardTestServer.start(path.join(workspace, 'server'));
			client = server.pushClient(await server.ownerAdminToken());

			store = await NixStore.host(path.join(workspace, 'nix-home'));
			const sources = path.join(workspace, 'sources');
			await mkdir(sources, { recursive: true });
			const seed = randomUUID();
			await writeFile(path.join(sources, 'a.txt'), `cupboard e2e a ${seed}\n`);
			await writeFile(path.join(sources, 'b.txt'), `cupboard e2e b ${seed}\n`);
			outA = storePathSchema.parse(
				await store.add(path.join(sources, 'a.txt'))
			);
			outB = storePathSchema.parse(
				await store.add(path.join(sources, 'b.txt'))
			);

			nixConfig = discoverNixStoreConfig();
			daemon = createNixDaemonStoreClient(undefined, nixConfig);
			nix = Nix.forStore(daemon, { storeDirectory: nixConfig.storeDirectory });
			isDaemonTrusted = (await daemon.daemonTrust()) === 'trusted';
		}, 120_000);

		afterAll(async () => {
			await server.stop();
			await rm(workspace, { recursive: true, force: true });
		});

		async function runReal(config: RunConfig): Promise<RunOutcome> {
			runCounter += 1;
			const invocationId = invocationIdSchema.parse(
				`bp-${String(process.pid)}-${String(runCounter)}`
			);
			const runtimeDirectory = path.join(tmpdir(), 'cupboard', invocationId);
			const socketPath = path.join(runtimeDirectory, 'hook.sock');
			const scriptPath = path.join(runtimeDirectory, hookScriptFileName);
			const receiptFile = path.join(workspace, `receipt-${invocationId}.json`);
			const record: RecordedRun = { warnings: [] };
			const runClient = clientWithFailingUpload(client, config.uploadFailure);
			let thrown: unknown;

			try {
				await runBuildPush(
					{
						command: config.command(scriptPath),
						receiptFile,
						...config.options
					},
					recordingReporter(record),
					{
						client: runClient,
						store: nix,
						batchStore: { withConnection: (use) => daemon.withConnection(use) },
						storeDirectory: nixConfig.storeDirectory,
						invocationId,
						environment: config.environment ?? { PATH: process.env.PATH },
						preflight: () =>
							preflightBuildPush({
								config: nixConfig,
								socketExists: (candidate) => existsSync(candidate),
								// The suite's runs never hand the hook to the daemon
								// itself except in the real-build case, which is gated
								// on the probed trust separately.
								daemonTrust: () => Promise.resolve('trusted'),
								invocationId,
								grants: [],
								cache: selectorForCache(storedCacheFor(undefined)),
								helper: {
									environment: { CUPBOARD_HOOK_HELPER: helperPath }
								},
								runtime: { environment: {}, temporaryDirectory: tmpdir() }
							}),
						resolveClosure: (paths) => nix.resolveClosure(paths)
					}
				);
			} catch (error) {
				thrown = error;
			}

			return {
				error: thrown,
				warnings: record.warnings,
				receiptPaths: await readReceiptPaths(receiptFile),
				runtimeDirectory,
				socketPath
			};
		}

		it('publishes every output of one multi-output hook event', async () => {
			const outcome = await runReal({
				command: (scriptPath) => [
					'/bin/sh',
					'-c',
					fireHook(scriptPath, [outA, outB])
				]
			});

			expect({
				error: outcome.error,
				receiptPaths: outcome.receiptPaths,
				served: await servedStatuses(server, [outA, outB]),
				runtimeDirectoryRemoved: !existsSync(outcome.runtimeDirectory)
			}).toStrictEqual({
				error: undefined,
				receiptPaths: [outA, outB].toSorted((left, right) =>
					left.localeCompare(right)
				),
				served: { [outA]: 200, [outB]: 200 },
				runtimeDirectoryRemoved: true
			});
		});

		it('accepts concurrent hook firings each as a whole message', async () => {
			const outcome = await runReal({
				command: (scriptPath) => [
					'/bin/sh',
					'-c',
					`${fireHook(scriptPath, [outA])} & ${fireHook(scriptPath, [outB])} & wait`
				]
			});

			expect({
				error: outcome.error,
				receiptPaths: outcome.receiptPaths,
				served: await servedStatuses(server, [outA, outB])
			}).toStrictEqual({
				error: undefined,
				receiptPaths: [outA, outB].toSorted((left, right) =>
					left.localeCompare(right)
				),
				served: { [outA]: 200, [outB]: 200 }
			});
		});

		it('records an owner-only runtime directory and socket during the run', async () => {
			const modesFile = path.join(workspace, 'modes.json');
			const outcome = await runReal({
				command: (scriptPath) => [
					process.execPath,
					'-e',
					recordModesScript,
					path.dirname(scriptPath),
					path.join(path.dirname(scriptPath), 'hook.sock'),
					modesFile
				]
			});

			expect({
				error: outcome.error,
				modes: JSON.parse(await readFile(modesFile, 'utf8')) as unknown,
				removed: !existsSync(outcome.runtimeDirectory)
			}).toStrictEqual({
				error: undefined,
				modes: { directory: '700', socket: '600' },
				removed: true
			});
		});

		it('exits promptly and zero when no listener is present', async () => {
			const started = performance.now();
			const helper = spawn(helperPath, [path.join(workspace, 'absent.sock')]);
			helper.stdin.end('{"version":1}\n');
			const status = await new Promise<number | null>((resolve) => {
				helper.once('exit', (code) => {
					resolve(code);
				});
			});
			const elapsedMs = performance.now() - started;

			expect({ status, prompt: elapsedMs < 2000 }).toStrictEqual({
				status: 0,
				prompt: true
			});
		});

		it('releases a stalled delivery at the inactivity timeout', async () => {
			const socketPath = path.join(workspace, 'stall.sock');
			const listener: Server = createServer(() => {
				// Accept and stay silent: the helper's standard input never
				// closes either, so only its inactivity timeout can end the run.
			});
			await new Promise<void>((resolve) => {
				listener.listen(socketPath, resolve);
			});

			try {
				const started = performance.now();
				const helper = spawn(helperPath, [socketPath]);
				// Standard input stays open and quiet.
				const status = await new Promise<number | null>((resolve) => {
					helper.once('exit', (code) => {
						resolve(code);
					});
				});
				const elapsedMs = performance.now() - started;

				expect({
					status,
					releasedAfterTimeout: elapsedMs >= 2500,
					releasedPromptly: elapsedMs < 15_000
				}).toStrictEqual({
					status: 0,
					releasedAfterTimeout: true,
					releasedPromptly: true
				});
			} finally {
				await new Promise<void>((resolve) => {
					listener.close(() => {
						resolve();
					});
				});
			}
		});

		it('completes the hook within its budget through the rendered script', async () => {
			const socketPath = path.join(workspace, 'budget.sock');
			const lines: string[] = [];
			const listener: Server = createServer((connection) => {
				connection.on('data', (chunk: Buffer) => {
					lines.push(chunk.toString('utf8'));
				});
			});
			await new Promise<void>((resolve) => {
				listener.listen(socketPath, resolve);
			});
			const scriptPath = path.join(workspace, 'budget-hook.sh');
			await writeFile(
				scriptPath,
				renderHookScript({
					invocationId: invocationIdSchema.parse('budget'),
					helperPath,
					socketPath
				}),
				{ mode: 0o700 }
			);

			try {
				const started = performance.now();
				const { stdout } = await run('/bin/sh', [
					'-c',
					fireHook(scriptPath, [outA])
				]);
				const elapsedMs = performance.now() - started;

				expect({
					stdout,
					withinBudget: elapsedMs < 2000,
					event: JSON.parse(lines.join('')) as unknown
				}).toStrictEqual({
					stdout: '',
					withinBudget: true,
					event: {
						version: 1,
						invocationId: 'budget',
						derivation: fakeDrvPath,
						outputPaths: [outA]
					}
				});
			} finally {
				await new Promise<void>((resolve) => {
					listener.close(() => {
						resolve();
					});
				});
			}
		});

		it('publishes a path whose hook delivery was lost', async () => {
			// A mis-pointed script stands in for a delivery the event stream
			// lost: the helper warns and exits zero, so the child still
			// succeeds, and reconciliation publishes the named path.
			const lostScript = path.join(workspace, 'lost-hook.sh');
			await writeFile(
				lostScript,
				renderHookScript({
					invocationId: invocationIdSchema.parse('lost'),
					helperPath,
					socketPath: path.join(workspace, 'nobody-listens.sock')
				}),
				{ mode: 0o700 }
			);
			const outcome = await runReal({
				command: () => ['/bin/sh', '-c', fireHook(lostScript, [outA])],
				options: { intermediatePaths: [outA] }
			});

			expect({
				error: outcome.error,
				receiptPaths: outcome.receiptPaths,
				served: await servedStatuses(server, [outA])
			}).toStrictEqual({
				error: undefined,
				receiptPaths: [outA],
				served: { [outA]: 200 }
			});
		});

		it('passes a failed build through as the child exit status', async () => {
			const outcome = await runReal({
				command: () => ['/bin/sh', '-c', 'exit 7']
			});

			expect(outcome.error).toBeInstanceOf(BuildCommandFailedError);

			if (!(outcome.error instanceof BuildCommandFailedError)) {
				throw outcome.error;
			}

			expect({
				name: outcome.error.name,
				status: outcome.error.status,
				exitCode: outcome.error.exitCode,
				runtimeDirectoryRemoved: !existsSync(outcome.runtimeDirectory)
			}).toStrictEqual({
				name: 'BuildCommandFailedError',
				status: 7,
				exitCode: 7,
				runtimeDirectoryRemoved: true
			});
		});

		it('maps a signalled child to 128 plus the signal number', async () => {
			const outcome = await runReal({
				command: () => ['/bin/sh', '-c', 'kill -TERM $$']
			});

			expect(outcome.error).toBeInstanceOf(BuildCommandFailedError);

			if (!(outcome.error instanceof BuildCommandFailedError)) {
				throw outcome.error;
			}

			expect({
				signal: outcome.error.signal,
				exitCode: outcome.error.exitCode,
				runtimeDirectoryRemoved: !existsSync(outcome.runtimeDirectory)
			}).toStrictEqual({
				signal: 'SIGTERM',
				exitCode: 143,
				runtimeDirectoryRemoved: true
			});
		});

		it('classifies a publication failure after a successful build', async () => {
			// A path the server has never seen, so its upload must run and fail.
			const sources = path.join(workspace, 'fresh');
			await mkdir(sources, { recursive: true });
			await writeFile(
				path.join(sources, 'fresh.txt'),
				`cupboard e2e fresh ${randomUUID()}\n`
			);
			const freshPath = storePathSchema.parse(
				await store.add(path.join(sources, 'fresh.txt'))
			);
			const outcome = await runReal({
				command: (scriptPath) => [
					'/bin/sh',
					'-c',
					fireHook(scriptPath, [freshPath])
				],
				uploadFailure: new Error('upload endpoint unreachable')
			});

			expect(outcome.error).toBeInstanceOf(BuildPublicationFailedError);

			if (!(outcome.error instanceof BuildPublicationFailedError)) {
				throw outcome.error;
			}

			expect({
				name: outcome.error.name,
				exitCode: outcome.error.exitCode,
				failedPaths: outcome.error.failedPaths,
				runtimeDirectoryRemoved: !existsSync(outcome.runtimeDirectory)
			}).toStrictEqual({
				name: 'BuildPublicationFailedError',
				exitCode: 74,
				failedPaths: [freshPath],
				runtimeDirectoryRemoved: true
			});
		});

		it('publishes the outputs of a real multi-output nix build', async (context) => {
			if (!isDaemonTrusted) {
				context.skip();
			}

			const seed = randomUUID().replaceAll('-', '');
			const expression =
				`builtins.derivation { name = "cupboard-e2e-${seed}"; ` +
				'system = builtins.currentSystem; builder = "/bin/sh"; ' +
				`args = [ "-c" "echo one-${seed} > $out; echo two-${seed} > $dev" ]; ` +
				'outputs = [ "out" "dev" ]; }';
			const outcome = await runReal({
				command: () => [
					'nix-build',
					'--expr',
					expression,
					'--no-out-link',
					'--option',
					'sandbox',
					'false',
					'--option',
					'substituters',
					''
				],
				environment: process.env
			});

			// A child failure here is the platform refusing to build the
			// trivial derivation at all (macOS sandbox and store policies
			// vary); the exit contract itself is covered above.
			if (outcome.error instanceof BuildCommandFailedError) {
				context.skip();
			}

			const receiptPaths = outcome.receiptPaths.map((storePath) =>
				storePathSchema.parse(storePath)
			);

			expect({
				error: outcome.error,
				publishedOutputs: receiptPaths.length,
				served: Object.values(await servedStatuses(server, receiptPaths)).every(
					(status) => status === 200
				)
			}).toStrictEqual({
				error: undefined,
				publishedOutputs: 2,
				served: true
			});
		});
	}
);
