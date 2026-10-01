import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	NixStorePathNotFoundError,
	type NixValidPathInfo
} from '@cupboard/nix';
import { Derivation } from '@cupboard/nix-store/derivation';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	nixSha256HashSchema,
	rootNameSchema,
	storeDirectorySchema,
	storePathHashSchema,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { byCodeUnit, StorePath } from '@cupboard/nix-store/store-path';
import {
	buildReceiptV3Schema,
	invocationIdSchema
} from '@cupboard/protocol/build';
import {
	type UploadDecisionInput,
	uploadDecisionSchema,
	uploadIdSchema
} from '@cupboard/protocol/upload';
import type { Reporter, ResultPayload } from '@cupboard/reporter';
import { genericExitCode } from '@cupboard/shared/errors';
import { ORPCError } from '@orpc/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { FakeCommitSocket } from '../client/commit-socket.test-support.ts';
import {
	type CommitSession,
	type CommitSocket,
	runCommitSession
} from '../client/commit-socket.ts';
import {
	AdminApiTransientError,
	BuildCommandFailedError,
	BuildObservationMissingError,
	BuildProvenanceIncompleteError,
	BuildPublicationFailedError,
	BuildRebuildRemoteDispatchError,
	CliAbortError,
	CliError,
	CommitCapacityQueuedError,
	CommitCapacityTimeoutError,
	CupboardHttpError,
	PostBuildHookConflictError,
	PushIncompleteError,
	QuotaExceededError,
	SessionRejectedError,
	transientExitCode,
	unavailableExitCode,
	UntrustedDaemonError
} from '../errors.ts';
import { classifyPublicationFailures } from '../exit-code.ts';
import { capacityWaitReporter } from '../push/capacity-wait.ts';
import type { PushClient } from '../push/push.ts';

import {
	type BuildInvocation,
	type BuildPushDependencies,
	type BuildPushRunOptions,
	type BuildPushStore,
	childExitCode,
	runBuildPush
} from './build-push.ts';
import { buildPushModeDescription } from './mode.ts';
import type { BuildPushPreflight } from './preflight.ts';
import type { ChildCommand } from './supervisor.ts';

const storeDirectory = storeDirectorySchema.parse('/nix/store');
const pathA = storePathSchema.parse(
	'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
);
const pathB = storePathSchema.parse(
	'/nix/store/1123456789abcdfghijklmnpqrsvwxyz-app-dev'
);
const pathC = storePathSchema.parse(
	'/nix/store/2123456789abcdfghijklmnpqrsvwxyz-runtime'
);
const drvB = '/nix/store/9123456789abcdfghijklmnpqrsvwxyz-dependency.drv';
const drvA = '/nix/store/8123456789abcdfghijklmnpqrsvwxyz-app.drv';
const invocationId = invocationIdSchema.parse('invocation-under-test');
const narHash = NixSha256Hash.fromDigest(Buffer.alloc(32, 0xaa));

class UnavailableTestError extends CliError {
	constructor() {
		super('A required service is unavailable');
		this.name = 'UnavailableTestError';
	}

	override get exitCode(): number {
		return unavailableExitCode;
	}
}

function pathInfo(
	storePath: StorePathString,
	isUltimate = false
): NixValidPathInfo {
	return {
		storePath,
		narHash,
		narSize: 4,
		references: [],
		deriver: drvA,
		signatures: [],
		ultimate: isUltimate
	};
}

// For a path that the run did not build, the receipt records whether the store
// reports it as an ultimate path or as a copy.
function heldSubject(storePath: StorePathString): unknown {
	return {
		origin: 'store-held',
		storePath,
		narHash: narHash.digestHex(),
		derivation: drvA,
		buildStore: 'auto'
	};
}

function copiedSubject(storePath: StorePathString): unknown {
	return {
		origin: 'copied',
		storePath,
		narHash: narHash.digestHex(),
		derivation: drvA,
		signatures: []
	};
}

function decisionFor(
	storePath: StorePathString,
	action: UploadDecisionInput['action']
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

const emptyNar: AsyncIterable<Uint8Array> = {
	[Symbol.asyncIterator]: () => ({
		next: () => Promise.resolve({ done: true, value: undefined })
	})
};

// A child that delivers one build event to the invocation's hook endpoint the
// way the hook helper does: one newline-terminated line per connection. It
// exits once the listener has closed the connection, or, when detached, as
// soon as its bytes have reached the socket, the way a helper does whose
// message the endpoint has yet to read.
const emitEventScript = [
	"const net = require('net');",
	'const [socketPath, line, exitStatus, mode] = process.argv.slice(1);',
	'const socket = net.connect(socketPath, () => {',
	'\tsocket.resume();',
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
	mode: 'awaited' | 'detached',
	outputProtection?: 'failed'
): ChildCommand {
	const line = JSON.stringify({
		version: 1,
		invocationId,
		derivation: drvA,
		outputPaths: [outputPath],
		...(outputProtection !== undefined && { outputProtection })
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

const emitTwoEventsScript = [
	"const net = require('net');",
	'const [socketPath, first, second] = process.argv.slice(1);',
	'const sendAndWait = (line) => new Promise((resolve, reject) => {',
	'\tconst socket = net.connect(socketPath, () => socket.end(line + "\\n"));',
	'\tsocket.resume();',
	'\tsocket.on("close", resolve);',
	'\tsocket.on("error", reject);',
	'});',
	'void sendAndWait(first).then(() => {',
	'\tconst socket = net.connect(socketPath, () => {',
	'\t\tsocket.write(second + "\\n", () => process.exit(0));',
	'\t});',
	'\tsocket.on("error", () => process.exit(1));',
	'}).catch(() => process.exit(1));'
].join('\n');

function eventLine(outputPath: StorePathString): string {
	return JSON.stringify({
		version: 1,
		invocationId,
		derivation: drvA,
		outputPaths: [outputPath]
	});
}

function emitTwoEventsCommand(socketPath: string): ChildCommand {
	return [
		process.execPath,
		'-e',
		emitTwoEventsScript,
		socketPath,
		eventLine(pathA),
		eventLine(pathB)
	];
}

interface RecordedRun {
	readonly phases: string[];
	readonly results: ResultPayload[];
	readonly warnings: { label: string; value?: string }[];
	readonly info: string[];
	readonly storeCalls: string[];
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
		info(message) {
			record.info.push(message);
		},
		success() {
			return;
		},
		step() {
			return;
		}
	};
}

interface RebuildTargetFixture {
	readonly installable: string;
	readonly derivation: string;
	readonly paths: readonly StorePathString[];
	readonly origin: 'built' | 'substituted' | 'existing';
	readonly machine?: string;
}

interface ConstructedFlowConfig {
	readonly dependencyBuilds?: readonly {
		readonly path: StorePathString;
		readonly installables: readonly string[];
	}[];
	readonly targets?: readonly RebuildTargetFixture[];
	readonly succeedOn: number;
	readonly isValidOnSuccess?: boolean;
	readonly dependencyPaths?: readonly StorePathString[];
	readonly installables?: readonly string[];
	readonly attempts?: number;
	readonly rebuild?: boolean;
	readonly failCheck?: boolean;
	readonly checkDerivations?: readonly string[];
	readonly builders?: string;
	readonly requireProvenance?: boolean;
	readonly omitActivity?: boolean;
	readonly suppressEvent?: boolean;
	readonly outputProtection?: 'failed';
	readonly machine?: string;
}

interface FlowConfig {
	readonly daemonless?: boolean;
	readonly command?: ChildCommand;
	readonly constructed?: ConstructedFlowConfig;
	readonly emitEvent?: boolean;
	readonly emitTwoEvents?: boolean;
	readonly emitExitStatus?: number;
	readonly emitDetached?: boolean;
	readonly eventOutputProtection?: 'failed';
	readonly stalledProtectionCall?: number;
	readonly valid?: readonly StorePathString[];
	readonly closurePaths?: readonly StorePathString[];
	readonly closurePathsByTarget?: ReadonlyMap<
		string,
		readonly StorePathString[]
	>;
	readonly alreadyValid?: readonly StorePathString[];
	readonly declaredOutputs?: readonly StorePathString[];
	readonly outPaths?: readonly StorePathString[];
	readonly ultimatePaths?: readonly StorePathString[];
	readonly action?: UploadDecisionInput['action'];
	readonly uploadFailure?: Error;
	readonly unwritableReceipt?: boolean;
	readonly preflightFailure?: Error;
	readonly sessionOpenFailure?: Error;
	readonly runtimeRemovalFailure?: Error;
	readonly options?: Partial<BuildPushRunOptions>;
	readonly externallyServed?: readonly StorePathString[];
}

interface FlowRun extends RecordedRun {
	readonly commands: readonly {
		readonly rebuild: boolean;
		readonly installables: readonly string[];
	}[];
	readonly error: unknown;
	readonly preflight: BuildPushPreflight;
	readonly receiptFile: string;
	readonly sleeps: readonly number[];
	readonly attemptIdsIssued: number;
	readonly negotiatedPaths: readonly (readonly StorePathString[])[];
	readonly rootSets: readonly string[];
	readonly rootRequests: readonly {
		readonly name: string;
		readonly body: Parameters<PushClient['setRoot']>[1];
	}[];
	readonly settledTargets: readonly StorePathString[];
	readonly batchSessions: number;
	readonly protectionCalls: number;
	readonly rootLinkDirectory: string;
}

function activityLine(machine: string, derivation = drvA): string {
	return JSON.stringify({
		action: 'start',
		id: 1,
		level: 3,
		parent: 0,
		text: `building '${derivation}'`,
		type: 105,
		fields: [derivation, machine]
	});
}

// A stand-in `nix` on the child's PATH: it writes the activity log the real
// one would, counts its runs so an early attempt can fail, leaves an out-link
// per realised path where one was asked for, and, where the invocation hosts a
// hook endpoint, delivers the build event the way the hook helper does.
const stubNixScript = [
	`#!${process.execPath}`,
	"const fs = require('node:fs');",
	"const net = require('node:net');",
	'const args = process.argv.slice(2);',
	"const targets = JSON.parse(process.env.STUB_TARGETS || '[]').filter((target) => args.slice(args.indexOf('--') + 1).includes(target.installable));",
	"const rebuild = args.includes('--rebuild');",
	String.raw`fs.appendFileSync(process.env.STUB_COMMANDS_FILE, JSON.stringify({ rebuild, installables: args.slice(args.indexOf('--') + 1) }) + '\n');`,
	"if (rebuild && !fs.existsSync(process.env.STUB_COUNT_FILE) && targets.some((target) => target.origin === 'built')) process.exit(2);",
	"if (args.includes('--store') && !(args.indexOf('--') < args.indexOf('--store'))) process.exit(2);",
	"const logFile = args[args.indexOf('json-log-path') + 1];",
	"const builtTargets = targets.filter((target) => rebuild || target.origin === 'built');",
	String.raw`const activity = rebuild && process.env.STUB_CHECK_DERIVATIONS ? JSON.parse(process.env.STUB_CHECK_DERIVATIONS).map((derivation) => JSON.stringify({ action: 'start', type: 105, fields: [derivation, ''] })).join('\n') : targets.length === 0 ? process.env.STUB_LOG_LINE : builtTargets.map((target) => JSON.stringify({ action: 'start', type: 105, fields: [target.derivation, target.machine || ''] })).join('\n');`,
	String.raw`fs.writeFileSync(logFile, activity + '\n');`,
	'let runs = 0;',
	'try {',
	"\truns = Number(fs.readFileSync(process.env.STUB_COUNT_FILE, 'utf8'));",
	'} catch {}',
	'runs += 1;',
	'fs.writeFileSync(process.env.STUB_COUNT_FILE, String(runs));',
	'if (runs < Number(process.env.STUB_SUCCEED_ON)) process.exit(1);',
	"if (rebuild && process.env.STUB_FAIL_CHECK === '1') process.exit(1);",
	"const outLinkIndex = args.indexOf('--out-link');",
	'if (outLinkIndex !== -1) {',
	'\tconst outLink = args[outLinkIndex + 1];',
	"\tconst outPaths = targets.length > 0 ? targets.flatMap((target) => target.paths) : process.env.STUB_OUT_PATHS.split(' ').filter(Boolean);",
	'\toutPaths.forEach((outPath, index) => {',
	"\t\tconst link = index === 0 ? outLink : outLink + '-' + String(index);",
	'\t\tfs.rmSync(link, { force: true });',
	'\t\tfs.symlinkSync(outPath, link);',
	'\t});',
	'}',
	'if (!process.env.STUB_SOCKET) process.exit(0);',
	'const send = (event) => new Promise((resolve, reject) => {',
	'\tconst socket = net.connect(process.env.STUB_SOCKET, () => {',
	'\t\tsocket.resume();',
	"\t\tsocket.write(event + '\\n');",
	'\t});',
	"\tsocket.on('close', resolve);",
	"\tsocket.on('error', reject);",
	'});',
	'void (async () => {',
	'\tif (process.env.STUB_DEPENDENCY_EVENT && (targets.length === 0 || targets.some((target) => target.derivation === process.env.STUB_DEPENDENCY_DERIVATION))) await send(process.env.STUB_DEPENDENCY_EVENT);',
	'\tconst event = JSON.parse(process.env.STUB_EVENT);',
	'\tif (targets.length > 0) event.outputPaths = targets.flatMap((target) => target.paths);',
	'\tawait send(JSON.stringify(event));',
	'})().then(() => process.exit(0), () => process.exit(1));'
].join('\n');

async function stubNixEnvironment(
	workspace: string,
	socketPath: string,
	constructed: ConstructedFlowConfig,
	outPaths: readonly StorePathString[]
): Promise<Record<string, string | undefined>> {
	const stubDirectory = path.join(workspace, 'bin');

	await mkdir(stubDirectory, { recursive: true });
	await writeFile(path.join(stubDirectory, 'nix'), stubNixScript, {
		mode: 0o755
	});

	return {
		...process.env,
		PATH: `${stubDirectory}:${process.env.PATH ?? ''}`,
		NIX_CONFIG: `${process.env.NIX_CONFIG ?? ''}\nbuilders = ${constructed.builders ?? ''}\n`,
		STUB_LOG_LINE:
			constructed.omitActivity === true
				? ''
				: [
						activityLine(constructed.machine ?? ''),
						...(constructed.dependencyPaths === undefined
							? []
							: [activityLine('', drvB)])
					].join('\n'),
		STUB_COUNT_FILE: stubCountFile(workspace),
		STUB_SUCCEED_ON: String(constructed.succeedOn),
		STUB_TARGETS: JSON.stringify(constructed.targets ?? []),
		STUB_FAIL_CHECK: constructed.failCheck === true ? '1' : '0',
		STUB_CHECK_DERIVATIONS:
			constructed.checkDerivations === undefined
				? ''
				: JSON.stringify(constructed.checkDerivations),
		STUB_COMMANDS_FILE: path.join(workspace, 'commands.jsonl'),
		STUB_SOCKET: constructed.suppressEvent === true ? '' : socketPath,
		STUB_OUT_PATHS: outPaths.join(' '),
		STUB_DEPENDENCY_DERIVATION: drvB,
		STUB_DEPENDENCY_EVENT:
			constructed.dependencyPaths === undefined
				? ''
				: JSON.stringify({
						version: 1,
						invocationId,
						derivation: drvB,
						outputPaths: constructed.dependencyPaths
					}),
		STUB_EVENT: JSON.stringify({
			version: 1,
			invocationId,
			derivation: drvA,
			outputPaths: outPaths,
			...(constructed.outputProtection !== undefined && {
				outputProtection: constructed.outputProtection
			})
		})
	};
}

function stubCountFile(workspace: string): string {
	return path.join(workspace, 'stub-count');
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
	const rootLinkDirectory = path.join(
		workspace,
		'nix-state',
		'gcroots',
		'cupboard',
		invocationId
	);
	const receiptFile =
		config.unwritableReceipt === true
			? path.join(workspace, 'absent', 'receipt.json')
			: path.join(workspace, 'receipt.json');
	const valid = new Set(config.valid);
	const alreadyValid = new Set(config.alreadyValid);
	const ultimatePaths = new Set(config.ultimatePaths);
	const record: RecordedRun = {
		phases: [],
		results: [],
		warnings: [],
		info: [],
		storeCalls: []
	};
	const sleeps: number[] = [];
	const negotiatedPaths: StorePathString[][] = [];
	const rootSets: string[] = [];
	const rootRequests: {
		name: string;
		body: Parameters<PushClient['setRoot']>[1];
	}[] = [];
	let settledTargets: readonly StorePathString[] = [];
	let attemptIdsIssued = 0;
	let batchSessions = 0;
	let protectionCalls = 0;
	const sessionOpenFailure = config.sessionOpenFailure;
	const runtimeRemovalFailure = config.runtimeRemovalFailure;
	const isStreamed = config.preflightFailure === undefined;
	const environment =
		config.constructed === undefined
			? undefined
			: await stubNixEnvironment(
					workspace,
					isStreamed ? socketPath : '',
					config.constructed,
					config.outPaths ?? config.valid ?? []
				);
	const preflight: BuildPushPreflight = {
		outputProtection:
			config.daemonless === true
				? { kind: 'daemonless-gc-roots', rootLinkDirectory }
				: { kind: 'daemon-temporary-roots' },
		helperPath: '/bin/cat',
		runtimePlan: { directory: runtimeDirectory, socketPath }
	};

	const client: PushClient = {
		...(sessionOpenFailure !== undefined && {
			openCommitSession: () => Promise.reject(sessionOpenFailure)
		}),
		negotiate: (body) => {
			negotiatedPaths.push(
				body.paths.map((candidate) =>
					storePathSchema.parse(candidate.storePath)
				)
			);

			return Promise.resolve({
				uploads: body.paths.map((negotiated) =>
					decisionFor(
						storePathSchema.parse(negotiated.storePath),
						config.action ?? 'skip'
					)
				)
			});
		},
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
		setRoot: (name, _body) => {
			rootSets.push(name);
			rootRequests.push({ name, body: _body });

			return Promise.resolve({
				name: rootNameSchema.parse(name),
				expired: false,
				createdAt: '2026-07-31T00:00:00.000Z',
				updatedAt: '2026-07-31T00:00:00.000Z',
				targets: []
			});
		}
	};

	// The count file separates paths that existed before the stub build from
	// paths that became valid during it. Flows without the stub use one stable
	// set of valid paths throughout.
	const hasBuilt = (): boolean => {
		if (config.constructed === undefined) {
			return true;
		}
		if (!existsSync(stubCountFile(workspace))) {
			return false;
		}
		return (
			config.constructed.isValidOnSuccess !== true ||
			Number(readFileSync(stubCountFile(workspace), 'utf8')) >=
				config.constructed.succeedOn
		);
	};
	const recordCall = (name: string): void => {
		record.storeCalls.push(
			`${name} ${hasBuilt() ? 'after' : 'before'} the build`
		);
	};
	const held = (): ReadonlySet<StorePathString> =>
		hasBuilt() ? valid : alreadyValid;
	const infoFor = (storePath: StorePathString): NixValidPathInfo => ({
		...pathInfo(storePath, ultimatePaths.has(storePath)),
		deriver:
			config.constructed?.targets?.find((target) =>
				target.paths.includes(storePath)
			)?.derivation ??
			(config.constructed?.dependencyPaths?.includes(storePath) === true
				? drvB
				: drvA)
	});
	const store: BuildPushStore = {
		storeKind: 'local-filesystem',
		queryPathInfo: (candidate) => {
			const storePath = storePathSchema.parse(candidate);

			return valid.has(storePath)
				? Promise.resolve(infoFor(storePath))
				: Promise.reject(new NixStorePathNotFoundError(storePath));
		},
		queryValidPathsInfo: (paths) => {
			recordCall('queryValidPathsInfo');
			const holds = held();

			return Promise.resolve(
				paths
					.map((candidate) => storePathSchema.parse(candidate))
					.filter((candidate) => holds.has(candidate))
					.map((candidate) => infoFor(candidate))
			);
		},
		queryValidPaths: (paths) => {
			recordCall('queryValidPaths');
			const holds = held();

			return Promise.resolve(
				paths.filter((candidate) => holds.has(storePathSchema.parse(candidate)))
			);
		},
		queryDerivationOutputPaths: () => {
			recordCall('queryDerivationOutputPaths');

			return Promise.resolve([...(config.declaredOutputs ?? [])]);
		},
		readDerivation: (derivation) => {
			recordCall('readDerivation');
			const outputs = (
				config.constructed?.targets?.find(
					(target) => target.derivation === derivation
				)?.paths ??
				config.declaredOutputs ??
				[]
			)
				.map(
					(output, index) =>
						`("${index === 0 ? 'out' : 'dev'}","${output}","","")`
				)
				.join(',');

			return Promise.resolve(
				Derivation.parse(
					`Derive([${outputs}],[],[],"aarch64-darwin","/bin/sh",[],[])`
				)
			);
		},
		resolveClosure: (targets) =>
			Promise.resolve(
				(config.closurePathsByTarget === undefined
					? (config.closurePaths ?? [])
					: [
							...new Set(
								targets.flatMap(
									(target) => config.closurePathsByTarget?.get(target) ?? []
								)
							)
						]
				).map((storePath) => infoFor(storePath))
			),
		narFromPath: () => emptyNar
	};

	const dependencies: BuildPushDependencies = {
		selectPublicationPaths: (candidates, options) => {
			const leftUpstream = (config.externallyServed ?? []).filter(
				(storePath) =>
					options.substituter === 'leave' &&
					candidates.some(
						(candidate) =>
							candidate.storePath === storePath && candidate.origin !== 'built'
					)
			);
			return Promise.resolve({
				published: candidates
					.filter(
						(candidate) =>
							!leftUpstream.includes(storePathSchema.parse(candidate.storePath))
					)
					.map((candidate) => storePathSchema.parse(candidate.storePath)),
				leftUpstream
			});
		},
		client,
		credential: 'cupboard-login',
		store,
		batchStore: {
			withProtectedPaths: (use) => {
				batchSessions += 1;

				return use({
					protectPath: () => {
						protectionCalls += 1;

						if (protectionCalls === config.stalledProtectionCall) {
							return Promise.withResolvers<undefined>().promise;
						}

						return Promise.resolve();
					},
					queryPathInfo: (storePath) =>
						valid.has(storePath)
							? Promise.resolve(pathInfo(storePath))
							: Promise.reject(new NixStorePathNotFoundError(storePath))
				});
			}
		},
		storeDirectory,
		invocationId,
		runtime: { environment: {}, temporaryDirectory: workspace },
		preflight: () =>
			config.preflightFailure === undefined
				? Promise.resolve(preflight)
				: Promise.reject(config.preflightFailure),
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
		startDelay: (delayMs) => {
			sleeps.push(delayMs);

			return {
				completed: Promise.resolve(),
				cancel() {
					return;
				}
			};
		},
		...(runtimeRemovalFailure !== undefined && {
			removeRuntimeDirectory: (directory: string) =>
				path.basename(directory) === 'build'
					? rm(directory, { recursive: true, force: true })
					: Promise.reject(runtimeRemovalFailure)
		}),
		settledTargets: (targets) => {
			settledTargets = targets;
		}
	};

	const command: ChildCommand =
		config.command ??
		(config.emitTwoEvents === true
			? emitTwoEventsCommand(socketPath)
			: config.emitEvent === true
				? emitEventCommand(
						socketPath,
						pathA,
						config.emitExitStatus ?? 0,
						config.emitDetached === true ? 'detached' : 'awaited',
						config.eventOutputProtection
					)
				: ['sh', '-c', 'exit 0']);
	const invocation: BuildInvocation =
		config.constructed === undefined
			? { kind: 'command', command }
			: {
					kind: 'constructed',
					build: {
						installables: config.constructed.installables ?? ['.#app'],
						...(config.constructed.dependencyBuilds !== undefined && {
							dependencyBuilds: config.constructed.dependencyBuilds
						}),
						...(config.constructed.attempts !== undefined && {
							attempts: config.constructed.attempts
						}),
						...(config.constructed.rebuild === true && { rebuild: true }),
						...(config.constructed.requireProvenance === true && {
							requireProvenance: true
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

	const commandsFile = path.join(workspace, 'commands.jsonl');
	const commands = existsSync(commandsFile)
		? await readFile(commandsFile, 'utf8')
		: '';
	return {
		...record,
		commands: commands
			.split('\n')
			.filter(Boolean)
			.map((line) =>
				z
					.object({ rebuild: z.boolean(), installables: z.array(z.string()) })
					.parse(JSON.parse(line))
			),
		error: thrown,
		preflight,
		receiptFile,
		sleeps,
		attemptIdsIssued,
		negotiatedPaths,
		rootSets,
		rootRequests,
		settledTargets,
		batchSessions,
		protectionCalls,
		rootLinkDirectory
	};
}

function ignore(): void {
	return;
}

function infoReporter(info: { lines: number }): Reporter {
	return {
		phase: (_label, body) =>
			Promise.resolve(body({ fact: ignore, warn: ignore })),
		progress: (_label, _options, body) =>
			Promise.resolve(body({ advance: ignore, fact: ignore, warn: ignore })),
		steps: (_label, body) =>
			Promise.resolve(
				body({
					message: ignore,
					group: () => ({
						message: ignore,
						success: ignore,
						error: ignore
					}),
					warn: ignore
				})
			),
		result: ignore,
		data: ignore,
		warn: ignore,
		info: () => {
			info.lines += 1;
		},
		success: ignore,
		step: ignore,
		error: ignore
	};
}

const commitPath = '/commit';
const commitTarget = {
	uploadId: uploadIdSchema.parse('upload-app'),
	storePathHash: storePathHashSchema.parse('0123456789abcdfghijklmnpqrsvwxyz'),
	narHash: nixSha256HashSchema.parse(`sha256:${'1'.repeat(52)}`)
};

function pacedSession(
	sockets: readonly FakeCommitSocket[],
	onWaiting: (isWaitingForCapacity: boolean) => void
): CommitSession {
	let attempt = 0;
	const connect = (): CommitSocket => {
		const socket = sockets[attempt];
		attempt += 1;

		if (socket === undefined) {
			throw new Error(
				`no socket scripted for connection attempt ${String(attempt)}`
			);
		}

		return socket;
	};

	return runCommitSession(
		connect,
		new URL(`wss://cupboard.test${commitPath}`),
		{
			initial: {
				headers: {},
				refreshAfterAuthenticationFailure: () => Promise.resolve(undefined)
			},
			authorise: () =>
				Promise.resolve({
					headers: {},
					refreshAfterAuthenticationFailure: () => Promise.resolve(undefined)
				})
		},
		{
			path: commitPath,
			timeoutSeconds: 100,
			keepaliveMs: 600_000,
			onWaiting
		}
	);
}

function grantNothing(socket: FakeCommitSocket): void {
	socket.emit('upgrade', {
		headers: {
			'x-cupboard-commit-capabilities':
				'commit-batch;max=1,commit-credit;grant=0'
		}
	});
}

describe('capacityWaitReporter', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// Short waits are normal credit pacing. If capacity arrives before the
	// announcement delay, cancel the pending message instead of printing one for
	// every path.
	it('prints nothing for a wait that ends promptly', () => {
		const info = { lines: 0 };
		const report = capacityWaitReporter(infoReporter(info));

		for (const _path of ['a', 'b', 'c']) {
			report(true);
			vi.advanceTimersByTime(100);
			report(false);
		}

		vi.advanceTimersByTime(60_000);

		expect(info).toStrictEqual({ lines: 0 });
	});

	// Announce each wait that outlasts the delay. Do not print a second message
	// when capacity arrives because continued progress already shows that the wait
	// ended, while a failed run reports its reason separately.
	it('reports each wait that lasts, and nothing when one ends', () => {
		const info = { lines: 0 };
		const report = capacityWaitReporter(infoReporter(info));

		report(true);
		vi.advanceTimersByTime(5000);
		const whileWaiting = info.lines;

		report(false);
		const afterEnding = info.lines;

		report(true);
		vi.advanceTimersByTime(5000);
		const whileWaitingAgain = info.lines;

		report(false);
		vi.advanceTimersByTime(60_000);

		expect({
			whileWaiting,
			afterEnding,
			whileWaitingAgain,
			atRunEnd: info.lines
		}).toStrictEqual({
			whileWaiting: 1,
			afterEnding: 1,
			whileWaitingAgain: 2,
			atRunEnd: 2
		});
	});

	// The capacity wait continues across reconnects. Each connection below lasts
	// less than the announcement delay, so restarting the delay on every drop
	// would leave the user waiting in silence for the entire capacity budget.
	it('announces a capacity wait that continues across reconnects', async () => {
		const info = { lines: 0 };
		const dropped = [new FakeCommitSocket(), new FakeCommitSocket()];
		const last = new FakeCommitSocket();
		const session = pacedSession(
			[...dropped, last],
			capacityWaitReporter(infoReporter(info))
		);
		const commit = session.commit(commitTarget);
		let isRejected = false;
		void commit.catch(() => {
			isRejected = true;
		});

		for (const socket of dropped) {
			grantNothing(socket);
			socket.emit('open');
			await vi.advanceTimersByTimeAsync(2000);
			socket.emit('close', 1006, '');
			await vi.advanceTimersByTimeAsync(2000);
		}

		const afterDrops = info.lines;

		grantNothing(last);
		last.emit('open');
		await vi.advanceTimersByTimeAsync(100_000);

		expect({
			afterDrops,
			atExpiry: info.lines,
			rejected: isRejected
		}).toStrictEqual({
			afterDrops: 1,
			atExpiry: 1,
			rejected: true
		});
	});
});

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

describe('classifyPublicationFailures', () => {
	it.each([
		{
			name: 'an authentication failure',
			causes: [new CupboardHttpError('PUT', '/nar', 401, '')],
			expectedExitCode: 77,
			expectedCauseIndex: 0
		},
		{
			name: 'a transient failure',
			causes: [new CupboardHttpError('PUT', '/nar', 503, '')],
			expectedExitCode: 75,
			expectedCauseIndex: 0
		},
		{
			name: 'an incomplete push with a transient failure',
			causes: [
				new PushIncompleteError({
					failures: [{ path: 'a-app', stage: 'upload' }],
					exitStatus: transientExitCode,
					command: 'cupboard build-push',
					credential: 'cupboard-login',
					recordsRetention: false
				})
			],
			expectedExitCode: 75,
			expectedCauseIndex: 0
		},
		{
			name: 'an incomplete push with an unclassified failure',
			causes: [
				new PushIncompleteError({
					failures: [{ path: 'a-app', stage: 'upload' }],
					exitStatus: genericExitCode,
					command: 'cupboard build-push',
					credential: 'cupboard-login',
					recordsRetention: false
				})
			],
			expectedExitCode: 74,
			expectedCauseIndex: 0
		},
		{
			name: 'a quota refusal',
			causes: [new QuotaExceededError('over quota')],
			expectedExitCode: 74,
			expectedCauseIndex: 0
		},
		{
			name: 'an unavailable dependency',
			causes: [new UnavailableTestError()],
			expectedExitCode: 69,
			expectedCauseIndex: 0
		},
		{
			name: 'authentication outranking transient',
			causes: [
				new CupboardHttpError('PUT', '/nar', 503, ''),
				new CupboardHttpError('PUT', '/nar', 401, '')
			],
			expectedExitCode: 77,
			expectedCauseIndex: 1
		},
		{
			name: 'authentication outranking an earlier unclassified failure',
			causes: [
				new Error('lost'),
				new CupboardHttpError('PUT', '/nar', 401, '')
			],
			expectedExitCode: 77,
			expectedCauseIndex: 1
		},
		{
			name: 'a capacity timeout',
			causes: [
				new CommitCapacityTimeoutError(
					600,
					600,
					new CommitCapacityQueuedError(2)
				)
			],
			expectedExitCode: 75,
			expectedCauseIndex: 0
		},
		{
			name: 'an unclassified failure',
			causes: [new Error('lost')],
			expectedExitCode: 74,
			expectedCauseIndex: 0
		},
		{
			name: 'no recorded cause',
			causes: [undefined],
			expectedExitCode: 74,
			expectedCauseIndex: 0
		}
	])('classifies $name', ({ causes, expectedExitCode, expectedCauseIndex }) => {
		expect(classifyPublicationFailures(causes)).toStrictEqual({
			exitCode: expectedExitCode,
			cause: causes[expectedCauseIndex]
		});
	});

	const rateLimited = new ORPCError('TOO_MANY_REQUESTS', { status: 429 });
	const rejectedSession = new ORPCError('UNAUTHORIZED', { status: 401 });

	it.each([
		{
			name: 'a rate-limited admin response',
			causes: [rateLimited],
			expected: {
				exitCode: 75,
				cause: new AdminApiTransientError(429, 'TOO_MANY_REQUESTS', {
					cause: rateLimited
				})
			}
		},
		{
			name: 'a rejected admin session',
			causes: [rejectedSession],
			expected: {
				exitCode: 77,
				cause: new SessionRejectedError({ cause: rejectedSession })
			}
		}
	])('classifies $name as the converted CLI error', ({ causes, expected }) => {
		expect(classifyPublicationFailures(causes)).toStrictEqual(expected);
	});
});

describe('runBuildPush', () => {
	it('reports the streamed mode, the phases in run order and a summary result', async () => {
		const run = await runFlow({});

		expect({
			error: run.error,
			info: run.info,
			phases: run.phases,
			resultKinds: run.results.map((result) => result.kind)
		}).toStrictEqual({
			error: undefined,
			info: [
				buildPushModeDescription({
					kind: 'streamed',
					preflight: run.preflight
				})
			],
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

	it.each([
		{
			name: 'a daemon that does not trust the client',
			failure: new UntrustedDaemonError('not-trusted')
		}
	])('publishes after the build for $name', async ({ failure }) => {
		const run = await runFlow({
			preflightFailure: failure,
			constructed: { succeedOn: 1 },
			valid: [pathA]
		});
		const receipt: unknown = JSON.parse(
			await readFile(run.receiptFile, 'utf8')
		);

		expect({ error: run.error, info: run.info, receipt }).toStrictEqual({
			error: undefined,
			info: [
				buildPushModeDescription({
					kind: 'reconciled-local',
					reason: failure
				})
			],
			receipt: {
				version: 3,
				paths: [pathA],
				subjects: [copiedSubject(pathA)],
				childExitStatus: 0,
				uploaded: []
			}
		});
	});

	it('asks which declared outputs the store holds before it builds', async () => {
		const run = await runFlow({
			preflightFailure: new UntrustedDaemonError('not-trusted'),
			constructed: { succeedOn: 1, installables: [`${drvA}^*`] },
			declaredOutputs: [pathA],
			valid: [pathA]
		});

		expect({ error: run.error, storeCalls: run.storeCalls }).toStrictEqual({
			error: undefined,
			storeCalls: [
				'readDerivation before the build',
				'queryValidPaths before the build',
				'queryValidPaths after the build',
				'queryValidPathsInfo after the build',
				'queryValidPathsInfo after the build'
			]
		});
	});

	it('passes constructed installables after the Nix option terminator', async () => {
		const run = await runFlow({
			constructed: {
				succeedOn: 1,
				installables: ['--store', 'ssh-ng://builder.example']
			}
		});

		expect(run.error).toBeUndefined();
	});

	it.each([
		{
			selection: 'out',
			outPaths: [pathA],
			expected: [pathA]
		},
		{
			selection: '*',
			outPaths: [pathA, pathB],
			expected: [pathA, pathB]
		}
	])(
		'publishes only the explicitly selected ^$selection outputs in reconciled mode',
		async ({ selection, outPaths, expected }) => {
			const run = await runFlow({
				preflightFailure: new UntrustedDaemonError('not-trusted'),
				constructed: {
					succeedOn: 1,
					installables: [`${drvA}^${selection}`]
				},
				declaredOutputs: [pathA, pathB],
				valid: [pathA, pathB],
				outPaths
			});
			const receipt = buildReceiptV3Schema.parse(
				JSON.parse(await readFile(run.receiptFile, 'utf8'))
			);

			expect({ error: run.error, paths: receipt.paths }).toStrictEqual({
				error: undefined,
				paths: expected
			});
		}
	);

	async function reconciledReceipt(config: FlowConfig): Promise<unknown> {
		const run = await runFlow({
			preflightFailure: new UntrustedDaemonError('not-trusted'),
			valid: [pathA],
			...config
		});

		expect(run.error).toBeUndefined();

		return JSON.parse(await readFile(run.receiptFile, 'utf8'));
	}

	function receiptOver(subjects: readonly unknown[]): unknown {
		return {
			version: 3,
			paths: [pathA],
			subjects,
			childExitStatus: 0,
			uploaded: []
		};
	}

	function subjectClaimed(): unknown {
		return {
			origin: 'built',
			storePath: pathA,
			narHash: narHash.digestHex(),
			derivation: drvA,
			buildStore: 'auto',
			attempt: 1,
			attemptId: 'attempt-1',
			verification: 'local'
		};
	}

	it.each([
		{
			name: 'a path this run resolved and the store then held as its own',
			config: {
				constructed: { succeedOn: 1, installables: [`${drvA}^*`] },
				declaredOutputs: [pathA],
				ultimatePaths: [pathA]
			},
			subject: subjectClaimed()
		},
		{
			name: 'an output that a remote builder produced for this run',
			config: {
				constructed: {
					succeedOn: 1,
					installables: [`${drvA}^*`],
					machine: 'ssh://builder-1'
				},
				declaredOutputs: [pathA]
			},
			subject: copiedSubject(pathA)
		}
	])('classifies $name from execution evidence', async (row) => {
		await expect(reconciledReceipt(row.config)).resolves.toStrictEqual(
			receiptOver([row.subject])
		);
	});

	it.each([
		{
			name: 'a path the store already held before the build',
			config: {
				constructed: { succeedOn: 1, installables: [`${drvA}^*`] },
				declaredOutputs: [pathA],
				alreadyValid: [pathA],
				ultimatePaths: [pathA]
			},
			subject: heldSubject(pathA)
		},
		{
			name: 'a path the build store fetched from a substituter',
			config: {
				constructed: { succeedOn: 1, installables: [`${drvA}^*`] },
				declaredOutputs: [pathA]
			},
			subject: copiedSubject(pathA)
		},
		{
			name: 'a path no question before the build covered',
			config: { constructed: { succeedOn: 1 }, ultimatePaths: [pathA] },
			subject: heldSubject(pathA)
		}
	])('describes $name without claiming that this run built it', async (row) => {
		await expect(reconciledReceipt(row.config)).resolves.toStrictEqual(
			receiptOver([row.subject])
		);
	});

	it('reports the reconciled local run in its summary', async () => {
		const run = await runFlow({
			preflightFailure: new UntrustedDaemonError('not-trusted'),
			constructed: { succeedOn: 1 },
			declaredOutputs: [pathA],
			valid: [pathA]
		});
		const summary = run.results.find(
			(result) => result.kind === 'build-summary'
		);

		expect(summary?.data).toStrictEqual({
			mode: 'reconciled-local',
			store: storeDirectory,
			targetPaths: 1,
			intermediatePaths: 0,
			queueDepth: 0,
			uploadedPaths: 0,
			skipped: 1,
			childExitStatus: 0,
			unconfirmedPaths: []
		});
	});

	it('preserves a reconciled publication failure when directory removal fails', async () => {
		const run = await runFlow({
			constructed: { succeedOn: 1 },
			declaredOutputs: [pathA],
			valid: [pathA],
			preflightFailure: new UntrustedDaemonError('not-trusted'),
			runtimeRemovalFailure: new Error('runtime removal failed'),
			unwritableReceipt: true
		});

		expect(run.error).toBeInstanceOf(BuildPublicationFailedError);
	});
	it('publishes nothing and exits with its own status when the build fails', async () => {
		const run = await runFlow({
			preflightFailure: new UntrustedDaemonError('not-trusted'),
			constructed: {
				succeedOn: 4,
				attempts: 1,
				installables: [`${drvA}^*`]
			},
			declaredOutputs: [pathA]
		});
		const { error } = run;
		const receipt: unknown = JSON.parse(
			await readFile(run.receiptFile, 'utf8')
		);

		expect({
			error:
				error instanceof BuildCommandFailedError
					? { name: error.name, exitCode: error.exitCode }
					: error,
			receipt
		}).toStrictEqual({
			error: { name: 'BuildCommandFailedError', exitCode: 1 },
			receipt: {
				version: 3,
				paths: [],
				subjects: [],
				childExitStatus: 1,
				terminalFailure: {
					kind: 'target-build',
					failedTargets: [`${drvA}^*`]
				}
			}
		});
	});

	it('publishes failed-build survivors without replacing their target root', async () => {
		const run = await runFlow({
			preflightFailure: new UntrustedDaemonError('not-trusted'),
			constructed: {
				succeedOn: 4,
				attempts: 1,
				installables: [`${drvA}^*`]
			},
			declaredOutputs: [pathA, pathB],
			valid: [pathA],
			options: { root: rootNameSchema.parse('github:owner/repo/main/app') }
		});

		expect({
			error:
				run.error instanceof BuildCommandFailedError
					? { name: run.error.name, exitCode: run.error.exitCode }
					: run.error,
			rootSets: run.rootSets
		}).toStrictEqual({
			error: { name: 'BuildCommandFailedError', exitCode: 1 },
			rootSets: []
		});
	});

	it('publishes failed-build survivors without claiming remote execution', async () => {
		const run = await runFlow({
			preflightFailure: new UntrustedDaemonError('not-trusted'),
			constructed: {
				succeedOn: 4,
				attempts: 1,
				installables: [`${drvA}^*`],
				machine: 'ssh://builder-1'
			},
			declaredOutputs: [pathA, pathB],
			valid: [pathA]
		});
		const receipt: unknown = JSON.parse(
			await readFile(run.receiptFile, 'utf8')
		);

		expect({
			error:
				run.error instanceof BuildCommandFailedError
					? { name: run.error.name, exitCode: run.error.exitCode }
					: run.error,
			negotiatedPaths: run.negotiatedPaths,
			receipt
		}).toStrictEqual({
			error: { name: 'BuildCommandFailedError', exitCode: 1 },
			negotiatedPaths: [[pathA]],
			receipt: {
				version: 3,
				paths: [pathA],
				subjects: [copiedSubject(pathA)],
				childExitStatus: 1,
				terminalFailure: {
					kind: 'target-build',
					failedTargets: [`${drvA}^*`]
				},
				uploaded: []
			}
		});
	});

	it.each([
		{
			name: 'successful build',
			succeedOn: 1,
			error: { name: 'BuildPublicationFailedError', exitCode: 74 }
		},
		{
			name: 'failed build',
			succeedOn: 4,
			error: { name: 'BuildCommandFailedError', exitCode: 1 }
		}
	])(
		'classifies an unwritable reconciled receipt after a $name',
		async ({ succeedOn, error: expectedError }) => {
			const run = await runFlow({
				preflightFailure: new UntrustedDaemonError('not-trusted'),
				constructed: {
					succeedOn,
					attempts: 1,
					installables: [`${drvA}^*`]
				},
				declaredOutputs: [pathA],
				valid: [pathA],
				unwritableReceipt: true
			});
			const error = run.error;

			expect({
				error:
					error instanceof BuildCommandFailedError ||
					error instanceof BuildPublicationFailedError
						? { name: error.name, exitCode: error.exitCode }
						: error,
				negotiatedPaths: run.negotiatedPaths
			}).toStrictEqual({
				error: expectedError,
				negotiatedPaths: [[pathA]]
			});
		}
	);

	it('refuses a user-supplied command with the condition that ruled streaming out', async () => {
		const failure = new UntrustedDaemonError('not-trusted');
		const run = await runFlow({ preflightFailure: failure });

		expect({ error: run.error, phases: run.phases }).toStrictEqual({
			error: failure,
			phases: []
		});
	});

	it('fails the run on a refusal no mode works around', async () => {
		const failure = new PostBuildHookConflictError('/etc/nix/hook.sh');
		const run = await runFlow({ preflightFailure: failure });

		expect({
			error: run.error,
			info: run.info,
			phases: run.phases
		}).toStrictEqual({ error: failure, info: [], phases: [] });
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
				subjects: [copiedSubject(pathA)],
				outcomes: [{ outcome: 'destination-served', storePath: pathA }],
				childExitStatus: 0,
				uploaded: [],
				failed: [],
				collected: []
			}
		});
	});

	it('removes the runtime directory when opening the commit session fails', async () => {
		const failure = new Error('commit session failed');
		const run = await runFlow({ sessionOpenFailure: failure });

		expect({
			error: run.error,
			runtimeDirectoryExists: existsSync(run.preflight.runtimePlan.directory)
		}).toStrictEqual({
			error: failure,
			runtimeDirectoryExists: false
		});
	});

	it('publishes an unprotected command output after the build', async () => {
		const run = await runFlow({
			daemonless: true,
			emitEvent: true,
			eventOutputProtection: 'failed',
			valid: [pathA]
		});
		const receipt = buildReceiptV3Schema.parse(
			JSON.parse(await readFile(run.receiptFile, 'utf8'))
		);

		expect({
			error: run.error,
			paths: receipt.paths,
			outcomes: receipt.outcomes,
			batchSessions: run.batchSessions,
			rootDirectoryExists: existsSync(run.rootLinkDirectory)
		}).toStrictEqual({
			error: undefined,
			paths: [pathA],
			outcomes: [{ outcome: 'destination-served', storePath: pathA }],
			batchSessions: 0,
			rootDirectoryExists: false
		});
	});

	it('removes daemonless roots when settlement fails', async () => {
		const run = await runFlow({
			daemonless: true,
			emitEvent: true,
			valid: [pathA],
			unwritableReceipt: true
		});

		expect(run.error).toBeInstanceOf(BuildPublicationFailedError);
		expect(
			run.error instanceof BuildPublicationFailedError
				? {
						exitCode: run.error.exitCode,
						failedPaths: run.error.failedPaths,
						rootDirectoryExists: existsSync(run.rootLinkDirectory)
					}
				: undefined
		).toStrictEqual({
			exitCode: 74,
			failedPaths: [],
			rootDirectoryExists: false
		});
	});

	it('settles exactly the selected top-level output when a dependency built and the target was already valid', async () => {
		const run = await runFlow({
			constructed: { succeedOn: 1 },
			valid: [pathA, pathB],
			outPaths: [pathB]
		});
		const receipt = buildReceiptV3Schema.parse(
			JSON.parse(await readFile(run.receiptFile, 'utf8'))
		);

		expect({
			error: run.error,
			settledTargets: run.settledTargets,
			outcomes: receipt.outcomes
		}).toStrictEqual({
			error: undefined,
			settledTargets: [pathB],
			outcomes: [{ outcome: 'destination-served', storePath: pathB }]
		});
	});

	it('accepts an event whose child exited before the endpoint read it', async () => {
		const run = await runFlow({
			emitEvent: true,
			emitDetached: true,
			valid: [pathA]
		});

		expect(run.error).toBeUndefined();
		const receipt: unknown = JSON.parse(
			await readFile(run.receiptFile, 'utf8')
		);

		expect({ error: run.error, receipt }).toStrictEqual({
			error: undefined,
			receipt: {
				version: 3,
				paths: [pathA],
				subjects: [copiedSubject(pathA)],
				outcomes: [{ outcome: 'destination-served', storePath: pathA }],
				childExitStatus: 0,
				uploaded: [],
				failed: [],
				collected: []
			}
		});
	});

	it('publishes earlier events when a later protection call does not finish', async () => {
		const run = await runFlow({
			emitTwoEvents: true,
			stalledProtectionCall: 2,
			valid: [pathA, pathB]
		});
		const receipt = buildReceiptV3Schema.parse(
			JSON.parse(await readFile(run.receiptFile, 'utf8'))
		);

		expect({
			error: run.error,
			batchSessions: run.batchSessions,
			protectionCalls: run.protectionCalls,
			outcomes: receipt.outcomes
		}).toStrictEqual({
			error: undefined,
			batchSessions: 1,
			protectionCalls: 2,
			outcomes: [
				{ outcome: 'destination-served', storePath: pathA },
				{ outcome: 'destination-served', storePath: pathB }
			]
		});
	});

	it('reports the run summary over the reconciled receipt', async () => {
		const run = await runFlow({ emitEvent: true, valid: [pathA] });
		const [summary] = run.results;

		expect(summary?.data).toStrictEqual({
			mode: 'streamed',
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
			attemptIdsIssued: run.attemptIdsIssued
		}).toStrictEqual({
			error: undefined,
			sleeps: [],
			attemptIdsIssued: 0
		});
	});

	it('runs a constructed invocation under the attempt loop and attributes its subjects', async () => {
		const run = await runFlow({
			constructed: { succeedOn: 2, installables: [`${drvA}^out`] },
			declaredOutputs: [pathA],
			ultimatePaths: [pathA],
			valid: [pathA]
		});

		expect(run.error).toBeUndefined();
		const receipt: unknown = JSON.parse(
			await readFile(run.receiptFile, 'utf8')
		);

		expect({
			error: run.error,
			sleeps: run.sleeps,
			receipt
		}).toStrictEqual({
			error: undefined,
			sleeps: [15_000],
			receipt: {
				version: 3,
				paths: [pathA],
				subjects: [
					{
						origin: 'built',
						storePath: pathA,
						narHash: narHash.digestHex(),
						derivation: drvA,
						attempt: 2,
						attemptId: 'attempt-2',
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

	it.each([
		{ succeedOn: 1, producers: [`${drvB}^out`] },
		{ succeedOn: 2, producers: ['.#broken', `${drvB}^out`] }
	])(
		'observes producer builds and transitive intermediates before targets ($succeedOn)',
		async ({ succeedOn, producers }) => {
			const run = await runFlow({
				constructed: {
					succeedOn,
					isValidOnSuccess: true,
					targets: [
						{
							installable: `${drvB}^out`,
							derivation: drvB,
							paths: [pathB],
							origin: 'built'
						},
						{
							installable: `${drvA}^out`,
							derivation: drvA,
							paths: [pathA],
							origin: 'built'
						}
					],
					attempts: 1,
					dependencyBuilds: [{ path: pathB, installables: producers }],
					dependencyPaths: [pathB, pathC],
					installables: [`${drvA}^out`]
				},
				declaredOutputs: [pathA],
				ultimatePaths: [pathA, pathB, pathC],
				valid: [pathA, pathB, pathC],
				outPaths: [pathA],
				options: { publicationScope: 'built' },
				action: 'upload'
			});
			const receipt = buildReceiptV3Schema.parse(
				JSON.parse(await readFile(run.receiptFile, 'utf8'))
			);
			expect({
				error: run.error,
				commands: run.commands,
				negotiated: [...new Set(run.negotiatedPaths.flat())].toSorted(
					byCodeUnit
				),
				published: receipt.paths,
				settledTargets: run.settledTargets,
				built: receipt.subjects
					.filter((subject) => subject.origin === 'built')
					.map((subject) => subject.storePath)
			}).toStrictEqual({
				error: undefined,
				commands: [...producers, `${drvA}^out`].map((installable) => ({
					rebuild: false,
					installables: [installable]
				})),
				negotiated: [pathA, pathB, pathC],
				published: [pathA, pathB, pathC],
				settledTargets: [pathA],
				built: [pathA, pathB, pathC]
			});
		}
	);

	it('keeps an unavailable producer fatal and does not start its target', async () => {
		const run = await runFlow({
			constructed: {
				succeedOn: 1,
				attempts: 1,
				suppressEvent: true,
				installables: [`${drvA}^out`],
				dependencyBuilds: [{ path: pathB, installables: [`${drvB}^out`] }]
			},
			valid: [pathA],
			declaredOutputs: [pathA],
			outPaths: [pathA],
			options: { publicationScope: 'built' }
		});
		const receipt = buildReceiptV3Schema.parse(
			JSON.parse(await readFile(run.receiptFile, 'utf8'))
		);
		expect({
			error:
				run.error instanceof BuildCommandFailedError
					? {
							status: run.error.status,
							signal: run.error.signal,
							exitCode: run.error.exitCode
						}
					: run.error,
			commands: run.commands,
			receipt
		}).toStrictEqual({
			error: { status: 1, signal: undefined, exitCode: 1 },
			commands: [{ rebuild: false, installables: [`${drvB}^out`] }],
			receipt: {
				version: 3,
				paths: [],
				subjects: [],
				outcomes: [],
				childExitStatus: 1,
				uploaded: [],
				failed: [],
				collected: [],
				terminalFailure: { kind: 'command' }
			}
		});
	});

	it('rejects built publication before an untrusted-daemon build starts', async () => {
		const run = await runFlow({
			constructed: {
				succeedOn: 1,
				installables: [`${drvA}^out`],
				dependencyBuilds: [{ path: pathB, installables: [`${drvB}^out`] }]
			},
			preflightFailure: new UntrustedDaemonError('not-trusted'),
			options: { publicationScope: 'built' }
		});

		expect(run.error).toBeInstanceOf(Error);
		expect(
			run.error instanceof Error ? run.error.message : undefined
		).toContain('cannot observe all build intermediates');
		expect(run.attemptIdsIssued).toBe(0);
	});

	it.each([
		{
			scope: 'built' as const,
			published: [pathA, pathB],
			closure: [pathA, pathC],
			built: [pathA, pathB]
		},
		{
			scope: 'outputs' as const,
			published: [pathA],
			closure: [pathA, pathC],
			built: [pathA]
		},
		{
			scope: 'closure' as const,
			published: [pathA, pathC],
			closure: [pathA, pathC],
			built: [pathA]
		},
		{
			scope: 'closure' as const,
			published: [pathA, pathB],
			closure: [pathA, pathB],
			built: [pathA, pathB]
		}
	])(
		'limits $scope publication when the hook observes a build dependency',
		async ({ scope, published, closure, built }) => {
			const run = await runFlow({
				constructed: {
					succeedOn: 1,
					dependencyPaths: [pathB],
					installables: [`${drvA}^out`]
				},
				declaredOutputs: [pathA],
				ultimatePaths: [pathA, pathB],
				valid: [pathA, pathB, pathC],
				outPaths: [pathA],
				closurePaths: closure,
				options: { publicationScope: scope },
				action: 'upload'
			});
			const receipt = buildReceiptV3Schema.parse(
				JSON.parse(await readFile(run.receiptFile, 'utf8'))
			);
			expect({
				error: run.error,
				negotiated: [...new Set(run.negotiatedPaths.flat())].toSorted(
					byCodeUnit
				),
				published: receipt.paths,
				built: receipt.subjects
					.filter((subject) => subject.origin === 'built')
					.map((subject) => subject.storePath)
			}).toStrictEqual({
				error: undefined,
				negotiated: published,
				published,
				built
			});
		}
	);

	it.each(['outputs', 'closure'] as const)(
		'leaves a cold substituted target upstream before %s publication',
		async (scope) => {
			const run = await runFlow({
				constructed: {
					succeedOn: 1,
					targets: [
						{
							installable: `${drvA}^out`,
							derivation: drvA,
							paths: [pathA],
							origin: 'substituted'
						}
					],
					installables: [`${drvA}^out`]
				},
				declaredOutputs: [pathA],
				valid: [pathA, pathC],
				outPaths: [pathA],
				closurePaths: [pathA, pathC],
				externallyServed: [pathA],
				options: { publicationScope: scope, substituter: 'leave' },
				action: 'upload'
			});
			const receipt = buildReceiptV3Schema.parse(
				JSON.parse(await readFile(run.receiptFile, 'utf8'))
			);
			expect({
				error: run.error,
				negotiated: run.negotiatedPaths,
				paths: receipt.paths,
				subjects: receipt.subjects,
				leftUpstream: receipt.leftUpstream
			}).toStrictEqual({
				error: undefined,
				negotiated: [],
				paths: [],
				subjects: [],
				leftUpstream: [pathA]
			});
		}
	);

	it.each([
		{
			name: 'fallback build',
			origin: 'built' as const,
			machine: '',
			preflightFailure: undefined,
			alreadyValid: [],
			substituter: 'leave' as const,
			rebuild: false,
			expected: [pathA],
			left: []
		},
		{
			name: 'remote observed build',
			origin: 'built' as const,
			machine: 'ssh://builder',
			preflightFailure: undefined,
			alreadyValid: [],
			substituter: 'leave' as const,
			rebuild: false,
			expected: [pathA],
			left: []
		},
		{
			name: 'untrusted observed build',
			origin: 'built' as const,
			machine: '',
			preflightFailure: new UntrustedDaemonError('not-trusted'),
			alreadyValid: [],
			substituter: 'leave' as const,
			rebuild: false,
			expected: [pathA],
			left: []
		},
		{
			name: 'copy policy',
			origin: 'substituted' as const,
			machine: '',
			preflightFailure: undefined,
			alreadyValid: [],
			substituter: 'copy' as const,
			rebuild: false,
			expected: [pathA],
			left: []
		},
		{
			name: 'selected rebuild',
			origin: 'existing' as const,
			machine: '',
			preflightFailure: undefined,
			alreadyValid: [pathA],
			substituter: 'leave' as const,
			rebuild: true,
			expected: [pathA],
			left: []
		}
	])(
		'keeps $name selected independently of attestation eligibility',
		async ({
			origin,
			machine,
			preflightFailure,
			alreadyValid,
			substituter,
			rebuild,
			expected,
			left
		}) => {
			const run = await runFlow({
				constructed: {
					succeedOn: 1,
					rebuild,
					targets: [
						{
							installable: `${drvA}^out`,
							derivation: drvA,
							paths: [pathA],
							origin,
							machine
						}
					],
					installables: [`${drvA}^out`]
				},
				declaredOutputs: [pathA],
				valid: [pathA],
				ultimatePaths: origin === 'built' || rebuild ? [pathA] : [],
				alreadyValid,
				outPaths: [pathA],
				externallyServed: [pathA],
				preflightFailure,
				options: { publicationScope: 'outputs', substituter },
				action: 'upload'
			});
			const receipt = buildReceiptV3Schema.parse(
				JSON.parse(await readFile(run.receiptFile, 'utf8'))
			);
			expect({
				error: run.error,
				paths: receipt.paths,
				left: receipt.leftUpstream ?? []
			}).toStrictEqual({ error: undefined, paths: expected, left });
		}
	);

	it('publishes only the retained multi-output target and its runtime closure', async () => {
		const run = await runFlow({
			constructed: {
				succeedOn: 1,
				targets: [
					{
						installable: `${drvA}^out,dev`,
						derivation: drvA,
						paths: [pathA, pathB],
						origin: 'substituted'
					}
				],
				installables: [`${drvA}^out,dev`]
			},
			declaredOutputs: [pathA, pathB],
			valid: [pathA, pathB, pathC],
			outPaths: [pathA, pathB],
			externallyServed: [pathA],
			closurePathsByTarget: new Map([
				[pathA, [pathA]],
				[pathB, [pathB, pathC]]
			]),
			options: { publicationScope: 'closure', substituter: 'leave' },
			action: 'upload'
		});
		const receipt = buildReceiptV3Schema.parse(
			JSON.parse(await readFile(run.receiptFile, 'utf8'))
		);
		expect({
			error: run.error,
			paths: receipt.paths,
			leftUpstream: receipt.leftUpstream,
			negotiated: [...new Set(run.negotiatedPaths.flat())].toSorted(byCodeUnit)
		}).toStrictEqual({
			error: undefined,
			paths: [pathB, pathC],
			leftUpstream: [pathA],
			negotiated: [pathB, pathC]
		});
	});

	it.each([undefined, new UntrustedDaemonError('not-trusted')])(
		'clears the requested root after all targets are left upstream (%s)',
		async (preflightFailure) => {
			const root = rootNameSchema.parse('github:owner/repo/main');
			const run = await runFlow({
				constructed: {
					succeedOn: 1,
					targets: [
						{
							installable: `${drvA}^out`,
							derivation: drvA,
							paths: [pathA],
							origin: 'substituted'
						}
					],
					installables: [`${drvA}^out`]
				},
				declaredOutputs: [pathA],
				valid: [pathA],
				outPaths: [pathA],
				externallyServed: [pathA],
				preflightFailure,
				options: {
					publicationScope: 'outputs',
					substituter: 'leave',
					root,
					retention: { kind: 'permanent' }
				}
			});
			expect({ error: run.error, roots: run.rootRequests }).toStrictEqual({
				error: undefined,
				roots: [
					{
						name: root,
						body: { targets: [], retention: { kind: 'permanent' } }
					}
				]
			});
		}
	);

	it.each([undefined, new UntrustedDaemonError('not-trusted')])(
		'preserves the root when required build evidence is missing before leaving a target upstream (%s)',
		async (preflightFailure) => {
			const root = rootNameSchema.parse('github:owner/repo/main');
			const run = await runFlow({
				constructed: {
					succeedOn: 1,
					rebuild: false,
					requireProvenance: true,
					targets: [
						{
							installable: `${drvA}^out`,
							derivation: drvA,
							paths: [pathA],
							origin: 'substituted'
						}
					],
					installables: [`${drvA}^out`]
				},
				declaredOutputs: [pathA],
				valid: [pathA],
				outPaths: [pathA],
				externallyServed: [pathA],
				preflightFailure,
				options: {
					publicationScope: 'outputs',
					substituter: 'leave',
					root,
					retention: { kind: 'permanent' }
				}
			});
			expect({
				error: run.error,
				roots: run.rootRequests,
				negotiated: run.negotiatedPaths
			}).toStrictEqual({
				error:
					preflightFailure === undefined
						? new BuildPublicationFailedError([], 74, {
								cause: new BuildProvenanceIncompleteError([pathA])
							})
						: new BuildProvenanceIncompleteError([pathA]),
				roots: [],
				negotiated: []
			});
		}
	);

	it('publishes a left-upstream target when another selected target requires it at runtime', async () => {
		const run = await runFlow({
			constructed: {
				succeedOn: 1,
				targets: [
					{
						installable: `${drvA}^out`,
						derivation: drvA,
						paths: [pathA],
						origin: 'built'
					},
					{
						installable: `${drvB}^out`,
						derivation: drvB,
						paths: [pathB],
						origin: 'substituted'
					}
				],
				installables: [`${drvA}^out`, `${drvB}^out`]
			},
			declaredOutputs: [pathA, pathB],
			valid: [pathA, pathB],
			ultimatePaths: [pathA],
			outPaths: [pathA, pathB],
			externallyServed: [pathB],
			closurePathsByTarget: new Map([
				[pathA, [pathA, pathB]],
				[pathB, [pathB]]
			]),
			options: { publicationScope: 'closure', substituter: 'leave' },
			action: 'upload'
		});
		const receipt = buildReceiptV3Schema.parse(
			JSON.parse(await readFile(run.receiptFile, 'utf8'))
		);
		expect({
			error: run.error,
			paths: receipt.paths,
			leftUpstream: receipt.leftUpstream
		}).toStrictEqual({
			error: undefined,
			paths: [pathA, pathB],
			leftUpstream: [pathB]
		});
	});

	it('makes five build attempts by default', async () => {
		const run = await runFlow({
			constructed: { succeedOn: 5 },
			valid: [pathA]
		});

		expect({
			error: run.error,
			attemptIdsIssued: run.attemptIdsIssued,
			sleeps: run.sleeps
		}).toStrictEqual({
			error: undefined,
			attemptIdsIssued: 5,
			sleeps: [15_000, 30_000, 45_000, 60_000]
		});
	});

	it.each([
		{
			name: 'streamed',
			preflightFailure: undefined,
			receipt: {
				version: 3,
				paths: [pathA, pathB],
				subjects: [pathA, pathB].map((storePath) => ({
					origin: 'built',
					storePath,
					narHash: narHash.digestHex(),
					derivation: drvA,
					attempt: 2,
					attemptId: 'attempt-2',
					buildStore: 'auto',
					verification: 'local',
					reproduced: true
				})),
				outcomes: [pathA, pathB].map((storePath) => ({
					outcome: 'destination-served',
					storePath
				})),
				childExitStatus: 0,
				uploaded: [],
				failed: [],
				collected: []
			}
		},
		{
			name: 'reconciled local',
			preflightFailure: new UntrustedDaemonError('not-trusted'),
			receipt: {
				version: 3,
				paths: [pathA, pathB],
				subjects: [pathA, pathB].map((storePath) => ({
					origin: 'built',
					storePath,
					narHash: narHash.digestHex(),
					derivation: drvA,
					buildStore: 'auto',
					attempt: 2,
					attemptId: 'attempt-2',
					verification: 'local',
					reproduced: true
				})),
				childExitStatus: 0,
				uploaded: []
			}
		}
	])(
		'rebuilds and claims every output of an already-valid multi-output derivation in $name mode',
		{ timeout: 30_000 },
		async ({ preflightFailure, receipt: expectedReceipt }) => {
			const run = await runFlow({
				...(preflightFailure !== undefined && { preflightFailure }),
				constructed: {
					succeedOn: 1,
					rebuild: true,
					requireProvenance: true,
					installables: [`${drvA}^*`]
				},
				valid: [pathA, pathB],
				alreadyValid: [pathA, pathB],
				declaredOutputs: [pathA, pathB],
				outPaths: [pathA, pathB],
				ultimatePaths: [pathA, pathB]
			});
			const receipt: unknown = JSON.parse(
				await readFile(run.receiptFile, 'utf8')
			);

			expect({
				error: run.error,
				attemptIdsIssued: run.attemptIdsIssued,
				receipt
			}).toStrictEqual({
				error: undefined,
				attemptIdsIssued: 2,
				receipt: expectedReceipt
			});
		}
	);

	it.each(
		[
			{ name: 'streamed', preflightFailure: undefined },
			{
				name: 'reconciled',
				preflightFailure: new UntrustedDaemonError('not-trusted')
			}
		].flatMap((mode) =>
			(['built', 'substituted', 'existing', 'mixed'] as const).map(
				(scenario) => ({ ...mode, scenario })
			)
		)
	)(
		'realises $scenario outputs before checking reused targets in $name mode',
		async ({ preflightFailure, scenario }) => {
			const first: RebuildTargetFixture = {
				installable: `${drvA}^out`,
				derivation: drvA,
				paths: [pathA],
				origin:
					scenario === 'substituted' || scenario === 'existing'
						? scenario
						: 'built'
			};
			const targets: readonly RebuildTargetFixture[] =
				scenario === 'mixed'
					? [
							first,
							{
								installable: `${drvB}^out`,
								derivation: drvB,
								paths: [pathB],
								origin: 'substituted'
							}
						]
					: [first];
			const paths = targets.flatMap((target) => target.paths);
			const run = await runFlow({
				...(preflightFailure && { preflightFailure }),
				constructed: {
					succeedOn: 1,
					rebuild: true,
					installables: targets.map((target) => target.installable),
					targets
				},
				valid: paths,
				alreadyValid: scenario.endsWith('existing') ? paths : [],
				declaredOutputs: paths,
				outPaths: paths,
				ultimatePaths: paths
			});
			expect({ error: run.error, commands: run.commands }).toStrictEqual({
				error: undefined,
				commands: [
					{
						rebuild: false,
						installables: targets.map((target) => target.installable)
					},
					...targets
						.filter((target) => target.origin !== 'built')
						.map((target) => ({
							rebuild: true,
							installables: [target.installable]
						}))
				]
			});
			const receipt = buildReceiptV3Schema.parse(
				JSON.parse(await readFile(run.receiptFile, 'utf8'))
			);
			expect(
				receipt.subjects.map((subject) => ({
					path: subject.storePath,
					origin: subject.origin
				}))
			).toStrictEqual(
				paths.map((storePath) => ({
					path: storePath,
					origin: 'built'
				}))
			);
		}
	);

	it.each([
		{ name: 'streamed', preflightFailure: undefined },
		{
			name: 'reconciled',
			preflightFailure: new UntrustedDaemonError('not-trusted')
		}
	])(
		'does not claim reused outputs after a failed check in $name mode',
		async ({ preflightFailure }) => {
			const run = await runFlow({
				...(preflightFailure !== undefined && { preflightFailure }),
				constructed: {
					succeedOn: 1,
					attempts: 1,
					rebuild: true,
					failCheck: true,
					installables: [`${drvA}^*`]
				},
				valid: [pathA, pathB],
				alreadyValid: [pathA, pathB],
				declaredOutputs: [pathA, pathB],
				outPaths: [pathA, pathB],
				ultimatePaths: [pathA, pathB]
			});
			const receipt = buildReceiptV3Schema.parse(
				JSON.parse(await readFile(run.receiptFile, 'utf8'))
			);
			expect({
				failed: run.error instanceof BuildCommandFailedError,
				exit: receipt.childExitStatus,
				built: receipt.subjects.filter((subject) => subject.origin === 'built')
			}).toStrictEqual({ failed: true, exit: 1, built: [] });
		}
	);

	it.each(
		[
			{ name: 'streamed', preflightFailure: undefined },
			{
				name: 'reconciled',
				preflightFailure: new UntrustedDaemonError('not-trusted')
			}
		].flatMap((mode) =>
			[
				{ activity: 'no derivations', checkDerivations: [] },
				{ activity: 'another derivation', checkDerivations: [drvB] }
			].map((activity) => ({ ...mode, ...activity }))
		)
	)(
		'rejects a successful rebuild with $activity in $name mode',
		async ({ preflightFailure, checkDerivations }) => {
			const installable = `${drvA}^out`;
			const run = await runFlow({
				...(preflightFailure !== undefined && { preflightFailure }),
				constructed: {
					succeedOn: 1,
					rebuild: true,
					omitActivity: true,
					checkDerivations,
					installables: [installable]
				},
				valid: [pathA],
				alreadyValid: [pathA],
				declaredOutputs: [pathA],
				outPaths: [pathA],
				ultimatePaths: [pathA],
				options: { root: rootNameSchema.parse('release') }
			});

			expect({
				error: run.error,
				receiptExists: existsSync(run.receiptFile),
				rootSets: run.rootSets
			}).toStrictEqual({
				error: new BuildObservationMissingError([installable]),
				receiptExists: false,
				rootSets: []
			});
		}
	);

	it.each([undefined, new UntrustedDaemonError('not-trusted')])(
		'rejects configured builders before rebuilding (preflight: %s)',
		async (preflightFailure) => {
			const run = await runFlow({
				...(preflightFailure !== undefined && { preflightFailure }),
				constructed: {
					succeedOn: 1,
					rebuild: true,
					builders: 'ssh-ng://builder x86_64-linux',
					installables: [`${drvA}^out`]
				},
				valid: [pathA],
				declaredOutputs: [pathA],
				outPaths: [pathA]
			});
			expect({
				error: run.error,
				commands: run.commands,
				rootSets: run.rootSets
			}).toStrictEqual({
				error: new BuildRebuildRemoteDispatchError(),
				commands: [],
				rootSets: []
			});
		}
	);

	it.each(
		[
			{ name: 'streamed', preflightFailure: undefined },
			{
				name: 'reconciled',
				preflightFailure: new UntrustedDaemonError('not-trusted')
			}
		].flatMap((mode) =>
			['built', 'existing'].map((origin) => ({ ...mode, origin }))
		)
	)(
		'rejects a delegated $origin output as rebuild evidence in $name mode',
		async ({ preflightFailure, origin }) => {
			const installable = `${drvA}^out`;
			const run = await runFlow({
				...(preflightFailure !== undefined && { preflightFailure }),
				constructed: {
					succeedOn: 1,
					rebuild: true,
					installables: [installable],
					targets: [
						{
							installable,
							derivation: drvA,
							paths: [pathA],
							origin: origin === 'built' ? 'built' : 'existing',
							machine: 'ssh://builder'
						}
					]
				},
				valid: [pathA],
				alreadyValid: origin === 'existing' ? [pathA] : [],
				declaredOutputs: [pathA],
				outPaths: [pathA]
			});
			expect({
				error: run.error,
				receiptExists: existsSync(run.receiptFile),
				rootSets: run.rootSets
			}).toStrictEqual({
				error: new BuildRebuildRemoteDispatchError(),
				receiptExists: false,
				rootSets: []
			});
		}
	);

	it('does not infer individual outputs from a successful reconciled multi-output build', async () => {
		const run = await runFlow({
			preflightFailure: new UntrustedDaemonError('not-trusted'),
			constructed: { succeedOn: 1, installables: [`${drvA}^*`] },
			valid: [pathA, pathB],
			alreadyValid: [pathA],
			declaredOutputs: [pathA, pathB],
			ultimatePaths: [pathA, pathB]
		});
		const receipt = buildReceiptV3Schema.parse(
			JSON.parse(await readFile(run.receiptFile, 'utf8'))
		);

		expect(receipt.subjects).toStrictEqual([
			heldSubject(pathA),
			heldSubject(pathB)
		]);
	});

	it.each([true, false])(
		'does not claim an existing output after a failed reconciled-local rebuild (missing activity: %s)',
		async (omitActivity) => {
			const run = await runFlow({
				preflightFailure: new UntrustedDaemonError('not-trusted'),
				constructed: {
					succeedOn: 2,
					attempts: 1,
					rebuild: true,
					requireProvenance: true,
					omitActivity,
					installables: [`${drvA}^out`]
				},
				valid: [pathA],
				alreadyValid: [pathA],
				declaredOutputs: [pathA],
				ultimatePaths: [pathA]
			});
			const receipt = buildReceiptV3Schema.parse(
				JSON.parse(await readFile(run.receiptFile, 'utf8'))
			);

			expect(receipt).toStrictEqual({
				version: 3,
				paths: [pathA],
				subjects: [
					{
						origin: 'store-held',
						storePath: pathA,
						narHash: narHash.digestHex(),
						derivation: drvA,
						buildStore: 'auto'
					}
				],
				childExitStatus: 1,
				terminalFailure: omitActivity
					? { kind: 'command' }
					: { kind: 'target-build', failedTargets: [`${drvA}^out`] },
				uploaded: []
			});
		}
	);

	it.each([
		{ name: 'streamed', preflightFailure: undefined },
		{
			name: 'reconciled local',
			preflightFailure: new UntrustedDaemonError('not-trusted')
		}
	])(
		'does not claim a remote builder output in $name mode without producer evidence',
		async ({ preflightFailure }) => {
			const run = await runFlow({
				...(preflightFailure !== undefined && { preflightFailure }),
				constructed: {
					succeedOn: 1,
					machine: 'ssh://builder',
					installables: [`${drvA}^out`]
				},
				valid: [pathA],
				declaredOutputs: [pathA]
			});
			const receipt = buildReceiptV3Schema.parse(
				JSON.parse(await readFile(run.receiptFile, 'utf8'))
			);

			expect(receipt.subjects).toStrictEqual([
				{
					origin: 'copied',
					storePath: pathA,
					narHash: narHash.digestHex(),
					derivation: drvA,
					signatures: []
				}
			]);
		}
	);

	it('fails closed when a provenance-required final build event is lost', async () => {
		const run = await runFlow({
			constructed: {
				succeedOn: 1,
				requireProvenance: true,
				suppressEvent: true
			},
			valid: [pathA]
		});

		expect({
			error:
				run.error instanceof BuildPublicationFailedError
					? {
							name: run.error.name,
							exitCode: run.error.exitCode,
							cause: run.error.cause
						}
					: run.error,
			receiptExists: existsSync(run.receiptFile),
			rootSets: run.rootSets
		}).toStrictEqual({
			error: {
				name: 'BuildPublicationFailedError',
				exitCode: 74,
				cause: new BuildProvenanceIncompleteError([pathA])
			},
			receiptExists: false,
			rootSets: []
		});
	});

	it('publishes a hook output without claiming a build when activity is missing', async () => {
		const run = await runFlow({
			constructed: {
				succeedOn: 1,
				omitActivity: true
			},
			valid: [pathA],
			ultimatePaths: [pathA]
		});
		const receipt: unknown = existsSync(run.receiptFile)
			? JSON.parse(await readFile(run.receiptFile, 'utf8'))
			: undefined;

		expect({ error: run.error, receipt }).toStrictEqual({
			error: undefined,
			receipt: {
				version: 3,
				paths: [pathA],
				subjects: [heldSubject(pathA)],
				outcomes: [{ outcome: 'destination-served', storePath: pathA }],
				childExitStatus: 0,
				uploaded: [],
				failed: [],
				collected: []
			}
		});
	});

	it.each([
		{
			name: 'the store did not build the output locally',
			succeedOn: 1,
			ultimatePaths: []
		},
		{
			name: 'multiple attempts leave the producing attempt uncertain',
			succeedOn: 2,
			ultimatePaths: [pathA]
		}
	])(
		'rejects hook-only provenance when $name',
		async ({ succeedOn, ultimatePaths }) => {
			const run = await runFlow({
				constructed: {
					succeedOn,
					requireProvenance: true,
					omitActivity: true
				},
				valid: [pathA],
				ultimatePaths
			});

			expect({
				error:
					run.error instanceof BuildPublicationFailedError
						? {
								name: run.error.name,
								exitCode: run.error.exitCode,
								cause: run.error.cause
							}
						: run.error,
				receiptExists: existsSync(run.receiptFile)
			}).toStrictEqual({
				error: {
					name: 'BuildPublicationFailedError',
					exitCode: 74,
					cause: new BuildProvenanceIncompleteError([pathA])
				},
				receiptExists: false
			});
		}
	);

	it('does not infer remote execution after a retry', async () => {
		const run = await runFlow({
			constructed: {
				succeedOn: 2,
				machine: 'ssh://builder-1'
			},
			valid: [pathA]
		});
		const receipt: unknown = JSON.parse(
			await readFile(run.receiptFile, 'utf8')
		);

		expect({
			error: run.error,
			sleeps: run.sleeps,
			receipt
		}).toStrictEqual({
			error: undefined,
			sleeps: [15_000],
			receipt: {
				version: 3,
				paths: [pathA],
				subjects: [copiedSubject(pathA)],
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
				uploadFailure: new UnavailableTestError()
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

	it('preserves the cause of a publication failure', async () => {
		const cause = new UnavailableTestError();
		const run = await runFlow({
			emitEvent: true,
			valid: [pathA],
			action: 'upload',
			uploadFailure: cause
		});
		const error = run.error;

		expect(
			error instanceof BuildPublicationFailedError
				? { type: error.constructor, cause: error.cause }
				: { type: error instanceof Error ? error.constructor : undefined }
		).toStrictEqual({
			type: BuildPublicationFailedError,
			cause
		});
	});

	it('passes cupboard build-push as the command to run again when publication after the build cannot publish a path', async () => {
		const run = await runFlow({
			preflightFailure: new UntrustedDaemonError('not-trusted'),
			constructed: { succeedOn: 1 },
			valid: [pathA],
			action: 'upload',
			uploadFailure: new CupboardHttpError('PUT', '/nar', 503, '')
		});
		const path = StorePath.basename(pathA);

		expect(run.error).toStrictEqual(
			new BuildPublicationFailedError([path], transientExitCode, {
				cause: new PushIncompleteError({
					failures: [{ path, stage: 'upload' }],
					exitStatus: transientExitCode,
					command: 'cupboard build-push',
					credential: 'cupboard-login',
					recordsRetention: false
				})
			})
		);
	});

	it('returns the child status when build and publication both fail and records both failures in the receipt', async () => {
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
				terminalFailure: { kind: 'command' },
				uploaded: [],
				failed: [pathA],
				collected: []
			}
		});
	});
});
