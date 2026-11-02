import {
	type ChildProcess,
	execFile,
	spawn,
	spawnSync
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import {
	BuildEventListener,
	renderHookScript
} from '@cupboard/nix/build-observation';
import {
	cacheNameSchema,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import {
	buildReceiptV3Schema,
	buildReceiptV4Schema,
	invocationIdSchema
} from '@cupboard/protocol/build';
import {
	compactPublicationSetSchema,
	publicationManifestIdentity,
	type PublicationResultIdentity,
	publicationResultIdentitySchema
} from '@cupboard/protocol/publication-manifests';
import {
	publicationCaptureEnvelopeSchema,
	type PublicationWorkflowRequest,
	publicationWorkflowRequestSchema
} from '@cupboard/protocol/publication-workflow';
import {
	parseReporterResults,
	type Reporter,
	type ReporterResultEvent
} from '@cupboard/reporter';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import * as cohortAction from '../../actions/src/commands/build-cohort.ts';
import { commandOptionsFromHelp } from '../../actions/src/cupboard-run.ts';
import { writeCachedSession } from '../../packages/cli/src/auth/token-store.ts';
import {
	type BuildPushRunOptions,
	hookScriptFileName,
	runBuildPush
} from '../../packages/cli/src/build-push/build-push.ts';
import { preflightBuildPush } from '../../packages/cli/src/build-push/preflight.ts';
import type { ChildCommand } from '../../packages/cli/src/build-push/supervisor.ts';
import { buildProgram } from '../../packages/cli/src/cli.ts';
import { tenantRpc } from '../../packages/cli/src/client/orpc.ts';
import {
	BuildCommandFailedError,
	BuildEventHandlingError,
	BuildPublicationFailedError
} from '../../packages/cli/src/errors.ts';
import { publicationWorkflowFor } from '../../packages/cli/src/publication/publication-client.ts';
import type { PushClient } from '../../packages/cli/src/push/push.ts';
import * as pushClientFactory from '../../packages/cli/src/push/push-client.ts';
import * as helperLocator from '../../packages/nix/src/build-observation/helper-resolution.ts';
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
const clockHelperSource = path.resolve(
	import.meta.dirname,
	'../fixtures/hook-relay-clock.c'
);
const fakeDrvPath = '/nix/store/8123456789abcdfghijklmnpqrsvwxyz-e2e.drv';

async function readCoordinatorJson(file: string): Promise<unknown> {
	return JSON.parse(await readFile(file, 'utf8')) as unknown;
}

function waitForChildClose(child: ChildProcess): Promise<number | null> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error): void => {
			child.removeListener('close', onClose);
			reject(error);
		};
		const onClose = (status: number | null): void => {
			child.removeListener('error', onError);
			resolve(status);
		};

		child.once('error', onError);
		child.once('close', onClose);
	});
}

function listenOnSocket(server: Server, socketPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error): void => {
			reject(error);
		};

		server.once('error', onError);
		server.listen(socketPath, () => {
			server.removeListener('error', onError);
			resolve();
		});
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error !== undefined) {
				reject(error);
				return;
			}

			resolve();
		});
	});
}

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
		phase: (_label, body) =>
			Promise.resolve(
				body({
					...facts,
					result() {
						return;
					}
				})
			),
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

	return {
		...base,
		uploadNar: () => Promise.reject(failure),
		uploadCompressedNar: () => Promise.reject(failure)
	};
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

// Temporary-root protection across a concurrent collection has no case here:
// temporary roots exist only behind a daemon, macOS cannot build into a
// diverted (`local?root=`) store, and collecting the host store discards real
// data, so exercising `nix-store --gc` against a store this suite owns needs a
// dedicated `nix-daemon --store` fixture for a diverted store on Linux.
describe.skipIf(!isDaemonSocketPresent || !isCompilerPresent)(
	'build-push end to end',
	() => {
		let workspace: string;
		let helperPath: string;
		let clockHelperPath: string;
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
			clockHelperPath = path.join(workspace, 'cupboard-hook-relay-clock');
			await run('cc', ['-O2', '-o', clockHelperPath, clockHelperSource]);

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
			nix = Nix.forStore(daemon, {
				storeDirectory: nixConfig.storeDirectory,
				storeKind: 'daemon'
			});
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
						invocation: {
							kind: 'command',
							command: config.command(scriptPath)
						},
						receiptFile,
						...config.options
					},
					recordingReporter(record),
					{
						client: runClient,
						credential: 'cupboard-login',
						store: nix,
						batchStore: {
							withProtectedPaths: (use) =>
								daemon.withConnection((session) =>
									use({
										protectPath: (storePath) => session.addTempRoot(storePath),
										queryPathInfo: (storePath) =>
											session.queryPathInfo(storePath)
									})
								)
						},
						storeDirectory: nixConfig.storeDirectory,
						invocationId,
						environment: config.environment ?? { PATH: process.env.PATH },
						preflight: () =>
							preflightBuildPush({
								config: nixConfig,
								storeKind: nix.storeKind,
								stateDirectory: nix.stateDirectory ?? nixConfig.stateDirectory,
								// The suite's runs never hand the hook to the daemon
								// itself except in the real-build case, which is gated
								// on the probed trust separately.
								daemonTrust: () => Promise.resolve('trusted'),
								invocationId,
								grants: [],
								cache: { kind: 'default' },
								helper: {
									executablePath: path.join(workspace, 'cupboard')
								},
								runtime: { environment: {}, temporaryDirectory: tmpdir() }
							})
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

		it('exits zero when no listener is present', async () => {
			const helper = spawn(helperPath, [path.join(workspace, 'absent.sock')], {
				stdio: 'ignore'
			});
			const status = await waitForChildClose(helper);

			expect(status).toBe(0);
		});

		it('stops waiting when the listener does not confirm an event', async () => {
			const socketPath = path.join(workspace, 'stall.sock');
			let accepted: Socket | undefined;
			const delivered = Promise.withResolvers<string>();
			const listener: Server = createServer(
				{ allowHalfOpen: true },
				(connection) => {
					accepted = connection;
					const event: string[] = [];
					connection.setEncoding('utf8');
					connection.on('data', (chunk: string) => {
						event.push(chunk);
					});
					connection.once('end', () => {
						delivered.resolve(event.join(''));
					});
				}
			);
			await listenOnSocket(listener, socketPath);

			try {
				const helper = spawn(clockHelperPath, [socketPath]);
				let stderr = '';
				let stdout = '';
				helper.stdout.setEncoding('utf8');
				helper.stdout.on('data', (chunk: string) => {
					stdout += chunk;
				});
				helper.stderr.setEncoding('utf8');
				helper.stderr.on('data', (chunk: string) => {
					stderr += chunk;
				});
				helper.stdin.end('event\n');
				const status = await waitForChildClose(helper);
				const timeout: unknown = JSON.parse(stdout);

				expect({
					status,
					stderr,
					timeout,
					delivered: await delivered.promise
				}).toStrictEqual({
					status: 0,
					stderr:
						'cupboard-hook-relay: delivery failed: the listener did not confirm the event\n',
					timeout: { timeoutMs: 3000 },
					delivered: 'event\n'
				});
			} finally {
				accepted?.destroy();
				await closeServer(listener);
			}
		});

		it('warns when the listener cannot handle an event', async () => {
			const socketPath = path.join(workspace, 'rejected.sock');
			const failure = new Error('protection failed');
			const rejections: unknown[] = [];
			const listener = await BuildEventListener.listen({
				socketPath,
				storeDirectory: nixConfig.storeDirectory,
				onEvent: () => Promise.reject(failure),
				onRejected: (error) => {
					rejections.push(error);
				}
			});

			try {
				const helper = spawn(helperPath, [socketPath], {
					stdio: ['pipe', 'ignore', 'pipe']
				});
				let stderr = '';
				helper.stderr.setEncoding('utf8');
				helper.stderr.on('data', (chunk: string) => {
					stderr += chunk;
				});
				helper.stdin.end(
					`${JSON.stringify({
						version: 1,
						invocationId: 'rejected-event',
						derivation: fakeDrvPath,
						outputPaths: [outA]
					})}\n`
				);
				const status = await waitForChildClose(helper);
				await listener.drain();
				const [rejection] = rejections;

				expect({
					status,
					warned: stderr !== '',
					isHandlingError: rejection instanceof BuildEventHandlingError,
					cause:
						rejection instanceof BuildEventHandlingError
							? rejection.cause
							: undefined
				}).toStrictEqual({
					status: 0,
					warned: true,
					isHandlingError: true,
					cause: failure
				});
			} finally {
				await listener.close();
			}
		});

		it('delivers through the rendered script without an inactivity timeout', async () => {
			const socketPath = path.join(workspace, 'budget.sock');
			const event = Promise.withResolvers<string>();
			const listener: Server = createServer((connection) => {
				const chunks: Buffer[] = [];

				connection.on('data', (chunk: Buffer) => {
					chunks.push(chunk);

					if (chunk.includes(0x0a)) {
						connection.end(Buffer.from([1]));
					}
				});
				connection.once('error', event.reject);
				connection.once('close', () => {
					event.resolve(Buffer.concat(chunks).toString('utf8'));
				});
			});
			await listenOnSocket(listener, socketPath);
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
				const [{ stderr, stdout }, eventLine] = await Promise.all([
					run('/bin/sh', ['-c', fireHook(scriptPath, [outA])]),
					event.promise
				]);
				expect({
					stderr,
					stdout,
					event: JSON.parse(eventLine) as unknown
				}).toStrictEqual({
					stderr: '',
					stdout: '',
					event: {
						version: 1,
						invocationId: 'budget',
						derivation: fakeDrvPath,
						outputPaths: [outA]
					}
				});
			} finally {
				await closeServer(listener);
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

		it.each(['fresh', 'existing'] as const)(
			'prepares a %s native warm run root through the production publication adapter',
			async (kind) => {
				const directory = await mkdtemp(path.join(workspace, 'native-root-'));
				const token = await server.ownerAdminToken();
				const cache = {
					kind: 'named' as const,
					name: cacheNameSchema.parse(`native-${kind}`)
				};
				const loopbackClient = server.pushClient(token, { cache });
				const factory = vi
					.spyOn(pushClientFactory, 'pushClientFor')
					.mockReturnValue(loopbackClient);
				vi.stubEnv('XDG_CONFIG_HOME', path.join(directory, 'config'));
				vi.stubEnv(
					'NIX_CONFIG',
					'experimental-features = nix-command flakes\nsubstituters ='
				);
				try {
					await writeCachedSession({ accessToken: token }, server.tenantUrl);
					const rpc = tenantRpc(server.tenantUrl, { credential: token });
					await rpc.caches.put.inNamedCache({
						cacheName: cache.name,
						access: 'public',
						priority: 40
					});
					await buildProgram().parseAsync(
						[
							'--output-mode',
							'json',
							'push',
							server.tenantUrl.href,
							cache.name,
							outA,
							outB,
							'--no-retain'
						],
						{ from: 'user' }
					);
					const workflow = publicationWorkflowFor(server.tenantUrl, token, {
						cache
					});
					const captured = await workflow.execute({
						operation: 'capture',
						input: {
							result: { storePath: outA },
							members: [{ storePath: outA }],
							origin: 'legacy-selection'
						}
					});
					if (captured.operation !== 'capture' || !captured.supported) {
						throw new Error('Fixture must capture an accepted warm result');
					}
					const root = `run/native-${kind}`;
					const targetRoot = `main/native-${kind}`;
					const sentinel = {
						storePathHash: StorePath.hash(outB),
						storePath: outB,
						present: true
					};
					const timestamp: unknown = expect.any(String);
					if (kind === 'existing') {
						const previous = await rpc.roots.set.inNamedCache({
							cacheName: cache.name,
							name: root,
							targets: [outB],
							retention: { kind: 'duration', seconds: 60 }
						});
						expect(previous).toStrictEqual({
							name: root,
							expiresAt: timestamp,
							expired: false,
							createdAt: timestamp,
							updatedAt: timestamp,
							targets: [sentinel]
						});
						expect(Date.parse(previous.expiresAt ?? '')).toBeGreaterThan(
							Date.now()
						);
					}
					await rpc.roots.set.inNamedCache({
						cacheName: cache.name,
						name: targetRoot,
						targets: [outB],
						retention: { kind: 'permanent' }
					});
					const cohortsFile = path.join(directory, 'cohorts.json');
					const receiptFile = path.join(directory, 'receipt.json');
					const resultFile = path.join(directory, 'results.jsonl');
					await writeFile(
						cohortsFile,
						JSON.stringify({ cohorts: [{ installables: [outA] }] })
					);
					const requestsBefore = server.requests.length;
					const entriesBefore = server.publicationEntriesSent;
					const sessionsBefore = server.commitSessions;
					await buildProgram().parseAsync(
						[
							'--output-mode',
							'json',
							'--result-file',
							resultFile,
							'build-push',
							server.tenantUrl.href,
							cache.name,
							'--cohorts-file',
							cohortsFile,
							'--receipt-file',
							receiptFile,
							'--aggregate-receipt',
							'3,4',
							'--root',
							targetRoot,
							'--permanent',
							'--run-root',
							root,
							'--run-root-permanent'
						],
						{ from: 'user' }
					);
					const requests = server.requests.slice(requestsBefore);
					const publicationSet = {
						...captured.output,
						materialisation: 'complete'
					};
					expect(
						buildReceiptV4Schema.parse(await readCoordinatorJson(receiptFile))
					).toEqual({
						version: 4,
						paths: [],
						subjects: [],
						childExitStatus: 0,
						publicationSets: [publicationSet]
					});
					expect(
						parseReporterResults(await readFile(resultFile, 'utf8'))
					).toEqual([
						{
							kind: 'build-summary-v4',
							data: {
								mode: 'streamed',
								store: nixConfig.storeDirectory,
								targetPaths: 1,
								intermediatePaths: 0,
								queueDepth: 0,
								uploadedPaths: 0,
								skipped: 0,
								childExitStatus: 0,
								unconfirmedPaths: [],
								version: 4,
								publicationSets: [publicationSet]
							}
						}
					]);
					const targets = [
						{
							storePathHash: StorePath.hash(outA),
							storePath: outA,
							present: true
						},
						...(kind === 'existing' ? [sentinel] : [])
					].toSorted((left, right) =>
						left.storePath.localeCompare(right.storePath)
					);
					expect(
						await rpc.roots.targets.inNamedCache({
							cacheName: cache.name,
							name: root
						})
					).toEqual({ targets });
					expect(
						await rpc.roots.targets.inNamedCache({
							cacheName: cache.name,
							name: targetRoot
						})
					).toEqual({
						targets: targets.filter((target) => target.storePath === outA)
					});
					const roots = await rpc.roots.list.inNamedCache({
						cacheName: cache.name
					});
					expect(roots).toEqual({
						roots: [targetRoot, root].map((name) => ({
							name,
							expired: false,
							targetCount: name === root ? targets.length : 1,
							createdAt: timestamp,
							updatedAt: timestamp
						}))
					});
					expect({
						entries: server.publicationEntriesSent,
						sessions: server.commitSessions
					}).toEqual({ entries: entriesBefore, sessions: sessionsBefore });
					expect(requests).toEqual([
						{
							method: 'POST',
							path: `${server.tenantUrl.pathname}/cache/${cache.name}/uploads/credential`,
							status: 200
						},
						{
							method: 'POST',
							path: `${server.tenantUrl.pathname}/cache/${cache.name}/publication-results/lookup`,
							status: 200
						},
						{
							method: 'POST',
							path: `${server.tenantUrl.pathname}/cache/${cache.name}/uploads/credential`,
							status: 200
						},
						{
							method: 'POST',
							path: `${server.tenantUrl.pathname}/cache/${cache.name}/uploads`,
							status: 200
						},
						{
							method: 'POST',
							path: `${server.tenantUrl.pathname}/cache/${cache.name}/uploads/plan`,
							status: 200
						},
						{
							method: 'POST',
							path: `${server.tenantUrl.pathname}/cache/${cache.name}/publication-results/ensure`,
							status: 200
						},
						{
							method: 'PUT',
							path: `${server.tenantUrl.pathname}/cache/${cache.name}/roots/${encodeURIComponent(targetRoot)}`,
							status: 200
						}
					]);
				} finally {
					factory.mockRestore();
					vi.unstubAllEnvs();
				}
			}
		);

		it('records the action-settled build-only tool after a strict V3 subordinate CLI build and reuses the exact app set', async (context) => {
			if (!isDaemonTrusted) {
				if (process.env.CI === undefined) {
					context.skip();
				}

				throw new Error('The end-to-end Nix daemon must trust its test client');
			}
			const directory = await mkdtemp(path.join(workspace, 'coordinator-'));
			const runtimeBase = await mkdtemp('/tmp/cbc-');
			const token = await server.ownerAdminToken();
			// Construct before spying: this factory itself calls pushClientFor.
			const loopbackClient = server.pushClient(token);
			const resolveHelper = helperLocator.resolveHookHelper;
			const factory = vi
				.spyOn(pushClientFactory, 'pushClientFor')
				.mockReturnValue(loopbackClient);
			const locator = vi
				.spyOn(helperLocator, 'resolveHookHelper')
				.mockImplementation(() =>
					resolveHelper({ executablePath: path.join(workspace, 'cupboard') })
				);
			vi.stubEnv('XDG_CONFIG_HOME', path.join(directory, 'config'));
			vi.stubEnv('XDG_RUNTIME_DIR', runtimeBase);
			vi.stubEnv(
				'NIX_CONFIG',
				[
					'experimental-features = nix-command flakes',
					'substituters =',
					'builders =',
					'sandbox = false'
				].join('\n')
			);
			try {
				await writeCachedSession({ accessToken: token }, server.tenantUrl);
				const seed = randomUUID().replaceAll('-', '');
				const expressionFile = path.join(directory, 'coordinator.nix');
				await writeFile(
					expressionFile,
					`let
					make = name: extra: builtins.derivation ({
						name = "cupboard-coordinator-${seed}-" + name;
						system = builtins.currentSystem;
						builder = "/bin/sh";
						args = [ "-c" "echo ${seed} > $out" ];
					} // extra);
					tool = make "tool" {};
				in { inherit tool; sibling = make "sibling" {}; app = make "app" { buildTool = tool; }; }
				`
				);
				const derivation = async (attribute: string) => {
					const result = await run('nix-instantiate', [
						expressionFile,
						'-A',
						attribute
					]);
					return storePathSchema.parse(result.stdout.trim());
				};
				const appDrv = await derivation('app');
				const toolDrv = await derivation('tool');
				const siblingDrv = await derivation('sibling');
				const output = async (drv: StorePathString) => {
					const result = await run('nix-store', ['--query', '--outputs', drv]);
					return storePathSchema.parse(result.stdout.trim());
				};
				const app = await output(appDrv);
				const tool = await output(toolDrv);
				const sibling = await output(siblingDrv);
				await run('nix-build', [
					expressionFile,
					'-A',
					'tool',
					'-A',
					'sibling',
					'--no-out-link'
				]);
				const commands: (readonly string[])[] = [];
				const requests: PublicationWorkflowRequest[] = [];
				let commandCounter = 0;
				let expectedAppResult: PublicationResultIdentity | undefined;
				let subordinate:
					ReturnType<typeof buildReceiptV3Schema.parse> | undefined;
				const option = (argv: readonly string[], name: string): string => {
					const index = argv.indexOf(name);
					const value = argv[index + 1];
					if (index === -1 || value === undefined) {
						throw new Error(`Missing ${name}`);
					}
					return value;
				};
				const cli = async (
					_binary: string,
					argv: readonly string[]
				): Promise<readonly ReporterResultEvent[]> => {
					commands.push(argv);
					commandCounter += 1;
					if (argv[1] === 'publication-result') {
						const requestFile = option(argv, '--request-file');
						const input = publicationWorkflowRequestSchema
							.or(publicationCaptureEnvelopeSchema)
							.parse(await readCoordinatorJson(requestFile));
						requests.push('version' in input ? input.request : input);
					}
					const resultFile = path.join(
						directory,
						`results-${String(commandCounter)}.jsonl`
					);
					await buildProgram().parseAsync(
						[
							'--output-mode',
							'json',
							'--result-file',
							resultFile,
							...argv.filter((argument) => argument !== '--github-oidc'),
							// Disk-sized reserves can exceed free space on large hosts.
							...(argv[1] === 'plan' && argv[2] === 'cohort'
								? [
										'--headroom-fraction',
										'0',
										'--headroom-absolute-minimum',
										'1048576'
									]
								: [])
						],
						{ from: 'user' }
					);
					if (argv[1] === 'build-push') {
						expect(argv).toContain('--aggregate-receipt-v3');
						expect(argv).toContain('--no-reference-dependencies');
						const receipt = await readCoordinatorJson(
							option(argv, '--receipt-file')
						);
						subordinate = buildReceiptV3Schema.parse(receipt);
						expect(subordinate.paths).toEqual([app]);
						const rpc = tenantRpc(server.tenantUrl, { credential: token });
						const accepted = await rpc.publication.lookup.inDefaultCache({
							source: { cache: { kind: 'default' } },
							results: [{ storePath: app }]
						});
						const entry = accepted.entries[0];
						if (entry?.kind !== 'missing') {
							throw new Error(
								'Subordinate preempted the action publication capture'
							);
						}
						const allocated = publicationResultIdentitySchema.parse(
							entry.result
						);
						const source = await nix.queryPathInfo(app);
						expectedAppResult = publicationResultIdentitySchema.parse({
							storePath: app,
							narHash: source.narHash.toString(),
							generation: allocated.generation,
							cache: { kind: 'default' },
							cacheGeneration: allocated.cacheGeneration
						});
						const lookup = await rpc.publication.lookup.inDefaultCache({
							source: { cache: { kind: 'default' } },
							results: [{ storePath: app }]
						});
						expect(lookup).toEqual({
							entries: [{ kind: 'missing', result: expectedAppResult }]
						});
					}
					return parseReporterResults(await readFile(resultFile, 'utf8'));
				};
				await cli('in-process-cupboard', [
					'--no-colour',
					'push',
					server.tenantUrl.href,
					tool,
					sibling,
					'--no-retain'
				]);
				const graph = vi.fn(cohortAction.resolveLocalDerivationGraph);
				const materialise = vi.fn(cohortAction.materialiseDerivationGraph);
				const build = vi.fn(cohortAction.runNixBuild);
				const show = vi.fn(cohortAction.runNixDerivationShow);
				let isWarmRepeat = false;
				const receiptFile = path.join(directory, 'receipt.json');
				const options = {
					url: server.tenantUrl.href,
					cupboardPath: 'in-process-cupboard',
					publish: 'built',
					substituter: 'copy',
					receiptFile
				};
				const { stdout: system } = await run('nix', [
					'eval',
					'--raw',
					'--impure',
					'--expr',
					'builtins.currentSystem'
				]);
				const matrix = (shouldIncludeSibling: boolean) =>
					JSON.stringify({
						key: 'coordinator',
						attrs: shouldIncludeSibling ? ['app', 'sibling'] : ['app'],
						installables: shouldIncludeSibling
							? [appDrv + '^out', siblingDrv + '^out']
							: [appDrv + '^out'],
						queryInstallables: shouldIncludeSibling
							? [appDrv + '^out', siblingDrv + '^out']
							: [appDrv + '^out'],
						expectedPaths: shouldIncludeSibling ? [app, sibling] : [app],
						roots: shouldIncludeSibling
							? ['github:acme/app/main', 'github:acme/sibling/main']
							: ['github:acme/app/main'],
						system: system.trim(),
						os: process.platform,
						remote: false,
						runsOn: 'local'
					});
				const dependencies: cohortAction.BuildCohortDependencies = {
					runCupboard: cli,
					reporter: recordingReporter({ warnings: [] }),
					hasPublicationSupport: () => {
						const command = buildProgram().commands.find(
							(entry) => entry.name() === 'publication-result'
						);
						return Promise.resolve(
							command !== undefined &&
								commandOptionsFromHelp(command.helpInformation()).has(
									'--request-file'
								)
						);
					},
					inspectCommandOptions: (_binary, names) => {
						let command = buildProgram();
						for (const name of names) {
							const child = command.commands.find(
								(entry) => entry.name() === name
							);
							if (child === undefined) {
								throw new Error(`Unsupported command ${name}`);
							}
							command = child;
						}
						return Promise.resolve(
							commandOptionsFromHelp(command.helpInformation())
						);
					},
					resolveLocalDerivationGraph: graph,
					materialiseDerivationGraph: materialise,
					runNixBuild: build,
					runNixDerivationShow: show,
					withLocalDerivationRoots: (derivations, use, signal) => {
						if (isWarmRepeat) {
							throw new Error('Warm repeat rooted derivations');
						}
						return cohortAction.runWithLocalDerivationRoots(
							derivations,
							use,
							signal
						);
					}
				};
				const environment = {
					RUNNER_TEMP: directory,
					GITHUB_OUTPUT: path.join(directory, 'github-output')
				};
				await cohortAction.buildCohortAction(
					{ ...options, cohortJson: matrix(true) },
					environment,
					dependencies
				);
				expect(subordinate?.version).toBe(3);
				expect(locator).toHaveBeenCalledTimes(1);
				const appInfo = await nix.queryPathInfo(app);
				const toolInfo = await nix.queryPathInfo(tool);
				expect(appInfo.references).toEqual([]);
				const graphRun = graph.mock.results[0];
				if (graphRun?.type !== 'return') {
					throw new Error(
						'Cold action did not resolve the real derivation graph'
					);
				}
				const selectionGraph = await graphRun.value;
				expect(selectionGraph.dependencyOutputs).toContainEqual({
					storePath: tool,
					requiredBy: [appDrv]
				});
				if (expectedAppResult === undefined) {
					throw new Error(
						'Subordinate did not record the allocated app identity'
					);
				}
				const generatedId: unknown = expect.stringMatching(
					/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/
				);
				expect(subordinate?.subjects).toEqual([
					{
						origin: 'built',
						storePath: app,
						narHash: appInfo.narHash.digestHex(),
						derivation: appDrv,
						buildStore: 'auto',
						verification: 'local',
						attempt: 1,
						attemptId: generatedId
					}
				]);
				const identity = await publicationManifestIdentity([
					{ storePath: app, narHash: appInfo.narHash.toString() },
					{ storePath: tool, narHash: toolInfo.narHash.toString() }
				]);
				const capture = requests.find(
					(request) =>
						request.operation === 'capture' &&
						request.input.result.storePath === app
				);
				expect(capture).toEqual({
					operation: 'capture',
					input: {
						result: { storePath: app, narHash: appInfo.narHash.toString() },
						members: identity.members,
						origin: 'build-selection',
						requestId: generatedId
					}
				});
				const cold = buildReceiptV4Schema.parse(
					JSON.parse(await readFile(receiptFile, 'utf8'))
				);
				const appSet = cold.publicationSets?.find(
					(set) => set.result.storePath === app
				);
				const expectedAppSet = compactPublicationSetSchema.parse({
					result: expectedAppResult,
					digest: identity.digest,
					memberCount: 2,
					origin: 'build-selection',
					materialisation: 'complete'
				});
				expect(appSet).toEqual(expectedAppSet);
				const lookup = await tenantRpc(server.tenantUrl, {
					credential: token
				}).publication.lookup.inDefaultCache({
					source: { cache: { kind: 'default' } },
					results: [{ storePath: app }]
				});
				expect(lookup).toEqual({
					entries: [
						{
							kind: 'recorded',
							complete: true,
							publication: {
								result: expectedAppResult,
								digest: identity.digest,
								memberCount: 2,
								origin: 'build-selection'
							}
						}
					]
				});
				const forbidden = () => {
					throw new Error('Warm repeat performed graph/build/member work');
				};
				graph.mockImplementation(forbidden);
				materialise.mockImplementation(forbidden);
				build.mockImplementation(forbidden);
				show.mockImplementation(forbidden);
				isWarmRepeat = true;
				commands.length = 0;
				requests.length = 0;
				const entriesBefore = server.publicationEntriesSent;
				await cohortAction.buildCohortAction(
					{ ...options, cohortJson: matrix(false) },
					environment,
					dependencies
				);
				const warm = buildReceiptV4Schema.parse(
					JSON.parse(await readFile(receiptFile, 'utf8'))
				);
				expect(warm).toEqual({
					version: 4,
					paths: [app],
					subjects: [],
					publicationSets: [expectedAppSet]
				});
				expect(commands.map((argv) => argv[1])).toEqual([
					'publication-result',
					'publication-result',
					'root'
				]);
				expect(requests.map((request) => request.operation)).toEqual([
					'lookup',
					'ensure'
				]);
				expect(server.publicationEntriesSent).toBe(entriesBefore);
			} finally {
				factory.mockRestore();
				locator.mockRestore();
				vi.unstubAllEnvs();
				await rm(runtimeBase, { recursive: true, force: true });
			}
		});

		it('publishes the outputs of a real multi-output nix build', async (context) => {
			if (!isDaemonTrusted) {
				if (process.env.CI === undefined) {
					context.skip();
				}

				throw new Error('The end-to-end Nix daemon must trust its test client');
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

			// Some macOS sandbox and store policies cannot build this fixture.
			// The preceding test covers the child-process exit contract.
			if (
				process.platform === 'darwin' &&
				process.env.CI === undefined &&
				outcome.error instanceof BuildCommandFailedError
			) {
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
