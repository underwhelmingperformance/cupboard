import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	NixStorePathNotFoundError,
	type NixValidPathInfo
} from '@cupboard/nix';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	rootNameSchema,
	storeDirectorySchema,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { invocationIdSchema } from '@cupboard/protocol/build';
import {
	type UploadDecision,
	uploadDecisionSchema
} from '@cupboard/protocol/upload';
import type { Reporter, ResultPayload } from '@cupboard/reporter';
import { afterEach, describe, expect, it } from 'vitest';

import {
	BuildCommandFailedError,
	BuildPublicationFailedError,
	CliAbortError,
	CupboardHttpError,
	DaemonRequiredError,
	publicationFailureExitCode
} from '../errors.ts';
import type { PushClient } from '../push/push.ts';

import {
	type BuildInvocation,
	type BuildPushDependencies,
	type BuildPushRunOptions,
	childExitCode,
	runBuildPush
} from './build-push.ts';
import type { ChildCommand } from './supervisor.ts';

const storeDirectory = storeDirectorySchema.parse('/nix/store');
const pathA = storePathSchema.parse(
	'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
);
const drvA = '/nix/store/8123456789abcdfghijklmnpqrsvwxyz-app.drv';
const invocationId = invocationIdSchema.parse('invocation-under-test');
const narHash = NixSha256Hash.fromDigest(Buffer.alloc(32, 0xaa));

function pathInfo(storePath: StorePathString): NixValidPathInfo {
	return {
		storePath,
		narHash,
		narSize: 4,
		references: [],
		deriver: drvA,
		signatures: [],
		ultimate: false
	};
}

function decisionFor(
	storePath: StorePathString,
	action: UploadDecision['action']
) {
	const base = {
		storePathHash: StorePath.hash(storePath),
		narHash: narHash.toString()
	};

	if (action === 'skip') {
		return uploadDecisionSchema.parse({ action, ...base });
	}

	if (action === 'commit') {
		return uploadDecisionSchema.parse({
			action,
			...base,
			uploadId: `upload-${StorePath.basename(storePath)}`
		});
	}

	return uploadDecisionSchema.parse({
		action,
		...base,
		uploadId: `upload-${StorePath.basename(storePath)}`,
		r2Key: `staging/${StorePath.basename(storePath)}`,
		expiresAt: '2026-07-31T00:00:00.000Z'
	});
}

function emptyStream(): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.close();
		}
	});
}

// A child that delivers one build event to the invocation's hook endpoint the
// way the hook helper does: one newline-terminated line per connection. It
// exits once the listener has closed the connection, or, when detached, as
// soon as its bytes have reached the socket, the way a helper does whose
// message the endpoint has yet to read.
const emitEventScript = [
	"const net = require('net');",
	'const [socketPath, line, exitStatus, mode] = process.argv.slice(1);',
	'const socket = net.connect(socketPath, () => {',
	"\tsocket.write(line + '\\n', () => {",
	"\t\tif (mode === 'detached') process.exit(Number(exitStatus));",
	'\t});',
	'});',
	"socket.on('close', () => process.exit(Number(exitStatus)));",
	"socket.on('error', () => process.exit(1));"
].join('\n');

function emitEventCommand(
	socketPath: string,
	outputPath: StorePathString,
	exitStatus: number,
	mode: 'awaited' | 'detached'
): ChildCommand {
	const line = JSON.stringify({
		version: 1,
		invocationId,
		derivation: drvA,
		outputPaths: [outputPath]
	});

	return [
		process.execPath,
		'-e',
		emitEventScript,
		socketPath,
		line,
		String(exitStatus),
		mode
	];
}

interface RecordedRun {
	readonly phases: string[];
	readonly results: ResultPayload[];
	readonly warnings: { label: string; value?: string }[];
}

function recordingReporter(record: RecordedRun): Reporter {
	const recordWarn = (label: string, value?: string): void => {
		record.warnings.push({ label, value });
	};

	return {
		phase: (label, body) => {
			record.phases.push(label);

			return Promise.resolve(
				body({
					fact() {
						return;
					},
					warn: recordWarn
				})
			);
		},
		progress: (_label, _options, body) =>
			Promise.resolve(
				body({
					advance() {
						return;
					},
					fact() {
						return;
					},
					warn: recordWarn
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
		result(payload) {
			record.results.push(payload);
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

interface ConstructedFlowConfig {
	/** The stub nix succeeds once it has run this many times. */
	readonly succeedOn: number;
	readonly attempts?: number;
	readonly verifyRebuilds?: boolean;
	/** The machine the stub's activity log attributes; empty is local. */
	readonly machine?: string;
}

interface FlowConfig {
	readonly command?: ChildCommand;
	readonly constructed?: ConstructedFlowConfig;
	readonly emitEvent?: boolean;
	readonly emitExitStatus?: number;
	/** The emitting child exits without waiting for its message to be read. */
	readonly emitDetached?: boolean;
	readonly valid?: readonly StorePathString[];
	readonly action?: UploadDecision['action'];
	readonly uploadFailure?: Error;
	/** Requests the receipt in a directory the run never creates. */
	readonly unwritableReceipt?: boolean;
	readonly options?: Partial<BuildPushRunOptions>;
}

interface FlowRun extends RecordedRun {
	readonly error: unknown;
	readonly receiptFile: string;
	readonly sleeps: readonly number[];
	readonly attemptIdsIssued: number;
	readonly verifications: readonly ChildCommand[];
}

function activityLine(machine: string): string {
	return JSON.stringify({
		action: 'start',
		id: 1,
		level: 3,
		parent: 0,
		text: `building '${drvA}'`,
		type: 105,
		fields: [drvA, machine]
	});
}

// A stand-in `nix` on the child's PATH: it writes the activity log the real
// one would, counts its runs so an early attempt can fail, and on success
// delivers the build event to the invocation's hook endpoint the way the hook
// helper does.
const stubNixScript = [
	`#!${process.execPath}`,
	"const fs = require('node:fs');",
	"const net = require('node:net');",
	'const args = process.argv.slice(2);',
	"const logFile = args[args.indexOf('json-log-path') + 1];",
	String.raw`fs.writeFileSync(logFile, process.env.STUB_LOG_LINE + '\n');`,
	'let runs = 0;',
	'try {',
	"\truns = Number(fs.readFileSync(process.env.STUB_COUNT_FILE, 'utf8'));",
	'} catch {}',
	'runs += 1;',
	'fs.writeFileSync(process.env.STUB_COUNT_FILE, String(runs));',
	'if (runs < Number(process.env.STUB_SUCCEED_ON)) process.exit(1);',
	'const socket = net.connect(process.env.STUB_SOCKET, () => {',
	"\tsocket.write(process.env.STUB_EVENT + '\\n');",
	'});',
	"socket.on('close', () => process.exit(0));",
	"socket.on('error', () => process.exit(1));"
].join('\n');

async function stubNixEnvironment(
	workspace: string,
	socketPath: string,
	constructed: ConstructedFlowConfig
): Promise<Record<string, string | undefined>> {
	const stubDirectory = path.join(workspace, 'bin');

	await mkdir(stubDirectory, { recursive: true });
	await writeFile(path.join(stubDirectory, 'nix'), stubNixScript, {
		mode: 0o755
	});

	return {
		...process.env,
		PATH: `${stubDirectory}:${process.env.PATH ?? ''}`,
		STUB_LOG_LINE: activityLine(constructed.machine ?? ''),
		STUB_COUNT_FILE: path.join(workspace, 'stub-count'),
		STUB_SUCCEED_ON: String(constructed.succeedOn),
		STUB_SOCKET: socketPath,
		STUB_EVENT: JSON.stringify({
			version: 1,
			invocationId,
			derivation: drvA,
			outputPaths: [pathA]
		})
	};
}

const workspaces: string[] = [];

afterEach(async () => {
	const removals = workspaces.map((workspace) =>
		rm(workspace, { recursive: true, force: true })
	);
	workspaces.length = 0;

	await Promise.all(removals);
});

async function runFlow(config: FlowConfig): Promise<FlowRun> {
	const workspace = await mkdtemp(path.join(tmpdir(), 'cupboard-bp-'));
	workspaces.push(workspace);

	const runtimeDirectory = path.join(workspace, 'run');
	const socketPath = path.join(runtimeDirectory, 'hook.sock');
	const receiptFile =
		config.unwritableReceipt === true
			? path.join(workspace, 'absent', 'receipt.json')
			: path.join(workspace, 'receipt.json');
	const valid = new Set(config.valid);
	const record: RecordedRun = { phases: [], results: [], warnings: [] };
	const sleeps: number[] = [];
	const verifications: ChildCommand[] = [];
	let attemptIdsIssued = 0;
	const environment =
		config.constructed === undefined
			? undefined
			: await stubNixEnvironment(workspace, socketPath, config.constructed);

	const client: PushClient = {
		negotiate: (body) =>
			Promise.resolve({
				uploads: body.paths.map((negotiated) =>
					decisionFor(
						storePathSchema.parse(negotiated.storePath),
						config.action ?? 'skip'
					)
				)
			}),
		preview: () => Promise.resolve({ uploads: [] }),
		uploadNar: () =>
			config.uploadFailure === undefined
				? Promise.resolve()
				: Promise.reject(config.uploadFailure),
		commit: (target) =>
			Promise.resolve({
				storePathHash: target.storePathHash,
				narHash: target.narHash,
				status: 'committed' as const,
				settled: Promise.resolve()
			}),
		setRoot: (name, _body) =>
			Promise.resolve({
				name: rootNameSchema.parse(name),
				expired: false,
				createdAt: '2026-07-31T00:00:00.000Z',
				updatedAt: '2026-07-31T00:00:00.000Z',
				targets: []
			})
	};

	const dependencies: BuildPushDependencies = {
		client,
		store: {
			queryValidPathsInfo: (paths) =>
				Promise.resolve(
					paths
						.map((candidate) => storePathSchema.parse(candidate))
						.filter((candidate) => valid.has(candidate))
						.map((candidate) => pathInfo(candidate))
				),
			queryDerivationOutputPaths: () => Promise.resolve([])
		},
		batchStore: {
			withConnection: (use) =>
				use({
					addTempRoot: () => Promise.resolve(),
					queryPathInfo: (storePath) =>
						valid.has(storePath)
							? Promise.resolve(pathInfo(storePath))
							: Promise.reject(new NixStorePathNotFoundError(storePath))
				})
		},
		storeDirectory,
		invocationId,
		preflight: () =>
			Promise.resolve({
				daemonSocketPath: path.join(workspace, 'daemon.sock'),
				helperPath: '/bin/cat',
				runtimePlan: { directory: runtimeDirectory, socketPath }
			}),
		createNarArchive: () => emptyStream(),
		compressNar: () => ({
			body: emptyStream(),
			digest: () => ({ narHash, narSize: 4 })
		}),
		...(environment !== undefined && { environment }),
		nextAttemptId: () => {
			attemptIdsIssued += 1;

			return `attempt-${String(attemptIdsIssued)}`;
		},
		sleep: (delayMs) => {
			sleeps.push(delayMs);

			return Promise.resolve();
		},
		runChild: (options) => {
			verifications.push(options.command);

			return Promise.resolve({ status: 0, signal: undefined });
		}
	};

	const command: ChildCommand =
		config.command ??
		(config.emitEvent === true
			? emitEventCommand(
					socketPath,
					pathA,
					config.emitExitStatus ?? 0,
					config.emitDetached === true ? 'detached' : 'awaited'
				)
			: ['sh', '-c', 'exit 0']);
	const invocation: BuildInvocation =
		config.constructed === undefined
			? { kind: 'command', command }
			: {
					kind: 'constructed',
					build: {
						installables: ['.#app'],
						...(config.constructed.attempts !== undefined && {
							attempts: config.constructed.attempts
						}),
						...(config.constructed.verifyRebuilds === true && {
							verifyRebuilds: true
						})
					}
				};
	let thrown: unknown;

	try {
		await runBuildPush(
			{ invocation, receiptFile, ...config.options },
			recordingReporter(record),
			dependencies
		);
	} catch (error) {
		thrown = error;
	}

	return {
		...record,
		error: thrown,
		receiptFile,
		sleeps,
		attemptIdsIssued,
		verifications
	};
}

describe('childExitCode', () => {
	it.each([
		{
			name: 'a plain status',
			exit: { status: 3, signal: undefined },
			expected: 3
		},
		{
			name: 'a success status',
			exit: { status: 0, signal: undefined },
			expected: 0
		},
		{
			name: 'a terminating signal',
			exit: { status: undefined, signal: 'SIGTERM' as const },
			expected: 143
		},
		{
			name: 'an interrupt signal',
			exit: { status: undefined, signal: 'SIGINT' as const },
			expected: 130
		},
		{
			name: 'no status at all',
			exit: { status: undefined, signal: undefined },
			expected: 1
		}
	])('maps $name', ({ exit, expected }) => {
		expect(childExitCode(exit)).toBe(expected);
	});
});

describe('publicationFailureExitCode', () => {
	it.each([
		{
			name: 'an authentication failure',
			causes: [new CupboardHttpError('PUT', '/nar', 401, '')],
			expected: 77
		},
		{
			name: 'a transient failure',
			causes: [new CupboardHttpError('PUT', '/nar', 503, '')],
			expected: 75
		},
		{
			name: 'an unavailable dependency',
			causes: [new DaemonRequiredError('/run/daemon.sock')],
			expected: 69
		},
		{
			name: 'authentication outranking transient',
			causes: [
				new CupboardHttpError('PUT', '/nar', 503, ''),
				new CupboardHttpError('PUT', '/nar', 401, '')
			],
			expected: 77
		},
		{
			name: 'an unclassified failure',
			causes: [new Error('lost')],
			expected: 74
		},
		{ name: 'no recorded cause', causes: [undefined], expected: 74 }
	])('classifies $name', ({ causes, expected }) => {
		expect(publicationFailureExitCode(causes)).toBe(expected);
	});
});

describe('runBuildPush', () => {
	it('reports the build-push phases in run order and a summary result', async () => {
		const run = await runFlow({});

		expect({
			error: run.error,
			phases: run.phases,
			resultKinds: run.results.map((result) => result.kind)
		}).toStrictEqual({
			error: undefined,
			phases: [
				'Building',
				'Queueing completed paths',
				'Uploading missing NARs',
				'Reconciling build results',
				'Recording retention'
			],
			resultKinds: ['build-summary']
		});
	});

	it('streams an accepted build event and writes the receipt file', async () => {
		const run = await runFlow({ emitEvent: true, valid: [pathA] });
		const receipt: unknown = JSON.parse(
			await readFile(run.receiptFile, 'utf8')
		);

		expect({ error: run.error, receipt }).toStrictEqual({
			error: undefined,
			receipt: {
				version: 3,
				paths: [pathA],
				subjects: [],
				outcomes: [{ outcome: 'destination-served', storePath: pathA }],
				childExitStatus: 0,
				uploaded: [],
				failed: [],
				collected: []
			}
		});
	});

	it('accepts an event whose child exited before the endpoint read it', async () => {
		const run = await runFlow({
			emitEvent: true,
			emitDetached: true,
			valid: [pathA]
		});
		const receipt: unknown = JSON.parse(
			await readFile(run.receiptFile, 'utf8')
		);

		expect({ error: run.error, receipt }).toStrictEqual({
			error: undefined,
			receipt: {
				version: 3,
				paths: [pathA],
				subjects: [],
				outcomes: [{ outcome: 'destination-served', storePath: pathA }],
				childExitStatus: 0,
				uploaded: [],
				failed: [],
				collected: []
			}
		});
	});

	it('reports the run summary over the reconciled receipt', async () => {
		const run = await runFlow({ emitEvent: true, valid: [pathA] });
		const [summary] = run.results;

		expect(summary?.data).toStrictEqual({
			store: storeDirectory,
			targetPaths: 1,
			intermediatePaths: 0,
			queueDepth: 1,
			uploadedPaths: 0,
			skipped: 1,
			childExitStatus: 0,
			unconfirmedPaths: []
		});
	});

	it('adds no attempts around a user-supplied command', async () => {
		const run = await runFlow({ emitEvent: true, valid: [pathA] });

		expect({
			error: run.error,
			sleeps: run.sleeps,
			attemptIdsIssued: run.attemptIdsIssued,
			verifications: run.verifications
		}).toStrictEqual({
			error: undefined,
			sleeps: [],
			attemptIdsIssued: 0,
			verifications: []
		});
	});

	it('runs a constructed invocation under the attempt loop and attributes its subjects', async () => {
		const run = await runFlow({
			constructed: { succeedOn: 2 },
			valid: [pathA]
		});
		const receipt: unknown = JSON.parse(
			await readFile(run.receiptFile, 'utf8')
		);

		expect({
			error: run.error,
			sleeps: run.sleeps,
			verifications: run.verifications,
			receipt
		}).toStrictEqual({
			error: undefined,
			sleeps: [15_000],
			verifications: [],
			receipt: {
				version: 3,
				paths: [pathA],
				subjects: [
					{
						storePath: pathA,
						narHash: narHash.digestHex(),
						derivation: drvA,
						attempt: 1,
						attemptId: 'attempt-1',
						buildStore: 'auto',
						verification: 'local'
					}
				],
				outcomes: [{ outcome: 'destination-served', storePath: pathA }],
				childExitStatus: 0,
				uploaded: [],
				failed: [],
				collected: []
			}
		});
	});

	it('verifies remotely built derivations locally before attributing them', async () => {
		const run = await runFlow({
			constructed: {
				succeedOn: 1,
				verifyRebuilds: true,
				machine: 'ssh://builder-1'
			},
			valid: [pathA]
		});
		const receipt: unknown = JSON.parse(
			await readFile(run.receiptFile, 'utf8')
		);

		expect({
			error: run.error,
			verifications: run.verifications,
			receipt
		}).toStrictEqual({
			error: undefined,
			verifications: [
				[
					'nix',
					'build',
					'--rebuild',
					'--no-link',
					'--builders',
					'',
					'--max-jobs',
					'1',
					`${drvA}^*`
				]
			],
			receipt: {
				version: 3,
				paths: [pathA],
				subjects: [
					{
						storePath: pathA,
						narHash: narHash.digestHex(),
						derivation: drvA,
						attempt: 1,
						attemptId: 'attempt-1',
						buildStore: 'auto',
						machine: 'ssh://builder-1',
						verification: 'verified-rebuild'
					}
				],
				outcomes: [{ outcome: 'destination-served', storePath: pathA }],
				childExitStatus: 0,
				uploaded: [],
				failed: [],
				collected: []
			}
		});
	});

	interface ContractRow {
		readonly name: string;
		readonly config: FlowConfig;
		readonly expected: {
			readonly type: new (...arguments_: never[]) => Error;
			readonly exitCode: number;
		};
	}

	const contract: readonly ContractRow[] = [
		{
			name: 'a failed build exits with the child status',
			config: { command: ['sh', '-c', 'exit 3'] },
			expected: { type: BuildCommandFailedError, exitCode: 3 }
		},
		{
			name: 'a killed build exits with 128 plus the signal number',
			config: { command: ['sh', '-c', 'kill -TERM $$'] },
			expected: { type: BuildCommandFailedError, exitCode: 143 }
		},
		{
			name: 'an unclassified publication failure exits 74',
			config: {
				emitEvent: true,
				valid: [pathA],
				action: 'upload',
				uploadFailure: new Error('connection lost')
			},
			expected: { type: BuildPublicationFailedError, exitCode: 74 }
		},
		{
			name: 'an authentication failure exits 77',
			config: {
				emitEvent: true,
				valid: [pathA],
				action: 'upload',
				uploadFailure: new CupboardHttpError('PUT', '/nar', 401, '')
			},
			expected: { type: BuildPublicationFailedError, exitCode: 77 }
		},
		{
			name: 'a transient failure exits 75',
			config: {
				emitEvent: true,
				valid: [pathA],
				action: 'upload',
				uploadFailure: new CupboardHttpError('PUT', '/nar', 503, '')
			},
			expected: { type: BuildPublicationFailedError, exitCode: 75 }
		},
		{
			name: 'an unavailable dependency exits 69',
			config: {
				emitEvent: true,
				valid: [pathA],
				action: 'upload',
				uploadFailure: new DaemonRequiredError('/run/daemon.sock')
			},
			expected: { type: BuildPublicationFailedError, exitCode: 69 }
		},
		{
			name: 'an unwritable receipt after a successful build exits 74',
			config: { emitEvent: true, valid: [pathA], unwritableReceipt: true },
			expected: { type: BuildPublicationFailedError, exitCode: 74 }
		},
		{
			name: 'a failed build keeps its status when settlement fails too',
			config: {
				emitEvent: true,
				emitExitStatus: 3,
				valid: [pathA],
				unwritableReceipt: true
			},
			expected: { type: BuildCommandFailedError, exitCode: 3 }
		},
		{
			name: 'an abort surfaces as the abort, reserving 130',
			config: {
				emitEvent: true,
				valid: [pathA],
				action: 'upload',
				uploadFailure: new CliAbortError()
			},
			expected: { type: CliAbortError, exitCode: 1 }
		}
	];

	it.each(contract)('$name', async ({ config, expected }) => {
		const run = await runFlow(config);
		const error = run.error;
		const exitCode =
			error instanceof BuildCommandFailedError ||
			error instanceof BuildPublicationFailedError ||
			error instanceof CliAbortError
				? error.exitCode
				: undefined;

		expect({
			isExpectedType: error instanceof expected.type,
			exitCode
		}).toStrictEqual({ isExpectedType: true, exitCode: expected.exitCode });
	});

	it('exits with the child status when build and publication both failed, the receipt carrying both', async () => {
		const run = await runFlow({ emitEvent: true, emitExitStatus: 7 });
		const error = run.error;
		const receipt: unknown = JSON.parse(
			await readFile(run.receiptFile, 'utf8')
		);

		expect({
			isBuildFailure: error instanceof BuildCommandFailedError,
			exitCode:
				error instanceof BuildCommandFailedError ? error.exitCode : undefined,
			receipt
		}).toStrictEqual({
			isBuildFailure: true,
			exitCode: 7,
			receipt: {
				version: 3,
				paths: [],
				subjects: [],
				outcomes: [
					{ outcome: 'failed', storePath: pathA, reason: 'collected' }
				],
				childExitStatus: 7,
				uploaded: [],
				failed: [pathA],
				collected: []
			}
		});
	});
});
