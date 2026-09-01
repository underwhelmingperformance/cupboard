import { readdir, readlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { copySources, type Nix } from '@cupboard/nix';
import { derivationPathOf } from '@cupboard/nix-store/derivation';
import {
	type RootName,
	type StoreDirectory,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import {
	autoBuildStore,
	type BuildReceiptV3,
	buildReceiptV3Schema,
	type BuildSubjectV3Input,
	type InvocationId,
	type NixStoreUri,
	nixStoreUriSchema,
	type TerminalBuildFailureInput
} from '@cupboard/protocol/build';
import {
	type BuildSummaryInput,
	buildSummaryResultKind,
	buildSummarySchema
} from '@cupboard/protocol/reports';
import type { RootRetentionRequest } from '@cupboard/protocol/retention';
import type { UploadAttachRootInput } from '@cupboard/protocol/upload';
import {
	buildPushPhases,
	formatCount,
	type Reporter,
	type ResultRow
} from '@cupboard/reporter';
import { withCleanups } from '@cupboard/shared/cleanup';
import { genericExitCode } from '@cupboard/shared/errors';

import { isAbortError } from '../abort.ts';
import type { CommitOptions } from '../client/client.ts';
import type { CommitSession } from '../client/commit-socket.ts';
import type { WaitTimeoutSeconds } from '../duration.ts';
import {
	BuildCommandFailedError,
	BuildEventHandlingError,
	BuildProvenanceIncompleteError,
	BuildPublicationFailedError,
	classifyPublicationFailures,
	CliAbortError,
	PushIncompleteError,
	type UntrustedDaemonError
} from '../errors.ts';
import { capacityWaitReporter } from '../push/capacity-wait.ts';
import { PublicationCollection } from '../push/publication.ts';
import {
	type CompressNar,
	type PushClient,
	type PushNarArchive,
	type PushStore,
	runPush
} from '../push/push.ts';

import {
	type BuildAttempt,
	delegatedMachines,
	parseBuildActivities,
	receiptSubjects
} from './attribution.ts';
import { type BatchStore, BuildOutputBatcher } from './batching.ts';
import { renderHookScript } from './hook-script.ts';
import { BuildEventListener } from './listener.ts';
import { buildPushModeDescription, selectBuildPushMode } from './mode.ts';
import {
	type ChildEnvironment,
	environmentWithPostBuildHook
} from './nix-config.ts';
import type { BuildPushPreflight } from './preflight.ts';
import {
	reconcileBuild,
	type ReconcileOptions,
	type ReconcileResult,
	type ReconcileTarget
} from './reconcile.ts';
import {
	createRootLinkDirectory,
	createRuntimeDirectory,
	type InvocationRuntimeOptions,
	planInvocationDirectory,
	removeInvocationRuntimeDirectory,
	type RootLinkDirectory
} from './runtime-directory.ts';
import {
	type ChildCommand,
	type ChildExit,
	type SignalSource,
	type StartDelay,
	superviseAttemptedBuild,
	superviseBuild,
	type SupervisedAttempt
} from './supervisor.ts';

export const hookScriptFileName = 'post-build-hook.sh';

export const defaultBuildAttempts = 5;

/**
 * A bounded attempt loop retries transient build failures. Per-attempt activity
 * logs associate each built path with the attempt that produced it.
 */
export interface ConstructedBuild {
	readonly installables: readonly string[];
	/**
	Maximum build attempts; defaults to {@link defaultBuildAttempts}.
	*/
	readonly attempts?: number;
	/**
	Execute selected derivations even when their outputs are already valid.
	*/
	readonly rebuild?: boolean;
	/**
	Fail unless the receipt claims every selected final output.
	*/
	readonly requireProvenance?: boolean;
	readonly keepGoing?: boolean;
	readonly maxJobs?: number;
}

/**
 * A user command must inherit the configured Nix store. Cupboard cannot protect
 * or publish outputs from a store selected inside the command.
 */
export type BuildInvocation =
	| { readonly kind: 'command'; readonly command: ChildCommand }
	| { readonly kind: 'constructed'; readonly build: ConstructedBuild };

export interface BuildPushRunOptions {
	readonly invocation: BuildInvocation;
	readonly root?: RootName;
	readonly retention?: RootRetentionRequest;
	readonly runRoot?: UploadAttachRootInput;
	readonly closure?: boolean;
	readonly intermediatePaths?: readonly StorePathString[];
	readonly receiptFile?: string;
	readonly wait?: boolean;
	readonly waitTimeoutSeconds?: WaitTimeoutSeconds;
	readonly uploadConcurrency?: number;
}

export type BuildPushStore = ReconcileOptions['store'] &
	PushStore &
	Pick<Nix, 'queryPathInfo' | 'queryValidPaths' | 'readDerivation'>;

export interface BuildPushDependencies {
	readonly client: PushClient;
	readonly store: BuildPushStore;
	readonly batchStore: BatchStore;
	readonly storeDirectory: StoreDirectory;
	readonly invocationId: InvocationId;
	readonly preflight: () => Promise<BuildPushPreflight>;
	readonly runtime?: Omit<InvocationRuntimeOptions, 'invocationId'>;
	readonly environment?: ChildEnvironment;
	readonly signalSource?: SignalSource;
	readonly createNarArchive?: (storePath: string) => PushNarArchive;
	readonly compressNar?: CompressNar;
	readonly nextAttemptId?: () => string;
	readonly startDelay?: StartDelay;
	readonly removeRuntimeDirectory?: (directory: string) => Promise<void>;
	readonly settledTargets?: (
		targets: readonly StorePathString[]
	) => Promise<void> | void;
}

/**
 * Converts a child exit to the shell status used by retry systems: the child's
 * status, or 128 plus its terminating signal number.
 */
export function childExitCode(exit: ChildExit): number {
	if (exit.status !== undefined) {
		return exit.status;
	}

	if (exit.signal !== undefined) {
		return 128 + os.constants.signals[exit.signal];
	}

	return genericExitCode;
}

// Preserve the child's status or terminating signal in every build failure.
function childFailure(exit: ChildExit): BuildCommandFailedError {
	return new BuildCommandFailedError(
		exit.status,
		exit.signal,
		childExitCode(exit)
	);
}

/**
 * Runs one cohort using the publication mode supported by the selected Nix
 * store. A daemonless store streams after the hook registers GC roots. A trusted
 * daemon streams by using temporary roots on one connection. An untrusted daemon
 * publishes from the store after the build. The reporter records the mode
 * before the build starts.
 */
export async function runBuildPush(
	options: BuildPushRunOptions,
	reporter: Reporter,
	dependencies: BuildPushDependencies
): Promise<BuildReceiptV3> {
	const mode = await selectBuildPushMode(dependencies.preflight);

	reporter.info(buildPushModeDescription(mode));

	if (mode.kind === 'reconciled-local') {
		return runReconciledLocalBuildPush(
			options,
			reporter,
			dependencies,
			mode.reason
		);
	}

	return runStreamedBuildPush(options, reporter, dependencies, mode.preflight);
}

function alreadyProtectedBatchStore(
	store: Pick<Nix, 'queryPathInfo'>
): BatchStore {
	return {
		withProtectedPaths: (use) =>
			use({
				// The hook creates the GC root before sending the event.
				protectPath: () => Promise.resolve(),
				queryPathInfo: (storePath) => store.queryPathInfo(storePath)
			})
	};
}

function waitForProtection(
	operation: Promise<void>,
	signal: AbortSignal
): Promise<void> {
	if (signal.aborted) {
		return Promise.reject(abortReason(signal));
	}

	return new Promise((resolve, reject) => {
		const abort = (): void => {
			reject(abortReason(signal));
		};

		signal.addEventListener('abort', abort, { once: true });
		void operation
			.then(resolve)
			.catch(reject)
			.finally(() => {
				signal.removeEventListener('abort', abort);
			});
	});
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new Error('Output protection was cancelled.');
}

async function runStreamedBuildPush(
	options: BuildPushRunOptions,
	reporter: Reporter,
	dependencies: BuildPushDependencies,
	preflight: BuildPushPreflight
): Promise<BuildReceiptV3> {
	if (preflight.outputProtection.kind === 'daemon-temporary-roots') {
		return dependencies.batchStore.withProtectedPaths((session) =>
			runProtectedStreamedBuildPush(
				options,
				reporter,
				dependencies,
				preflight,
				alreadyProtectedBatchStore(dependencies.store),
				async (storePaths, signal) => {
					for (const storePath of storePaths) {
						if (signal.aborted) {
							throw abortReason(signal);
						}

						await waitForProtection(session.protectPath(storePath), signal);
					}
				}
			)
		);
	}

	return runProtectedStreamedBuildPush(
		options,
		reporter,
		dependencies,
		preflight,
		alreadyProtectedBatchStore(dependencies.store),
		() => Promise.resolve()
	);
}

async function runProtectedStreamedBuildPush(
	options: BuildPushRunOptions,
	reporter: Reporter,
	dependencies: BuildPushDependencies,
	preflight: BuildPushPreflight,
	batchStore: BatchStore,
	protectEventPaths: (
		storePaths: readonly StorePathString[],
		signal: AbortSignal
	) => Promise<void>
): Promise<BuildReceiptV3> {
	const plan = preflight.runtimePlan;
	const targetLinkDirectory = `${plan.directory}-targets`;
	const childRuntimeDirectory = path.join(plan.directory, 'child');
	const rootLinkDirectory =
		preflight.outputProtection.kind === 'daemonless-gc-roots'
			? preflight.outputProtection.rootLinkDirectory
			: undefined;
	let roots: RootLinkDirectory | undefined;
	let batcher: BuildOutputBatcher;
	let listener: BuildEventListener;

	let maxQueueDepth = 0;
	const hookScriptPath = path.join(plan.directory, hookScriptFileName);
	// Share one commit session between streaming and reconciliation so the server
	// applies one credit budget across the whole run.
	const commitOptions: CommitOptions = {
		...(options.waitTimeoutSeconds !== undefined && {
			timeoutSeconds: options.waitTimeoutSeconds
		}),
		onWaiting: capacityWaitReporter(reporter)
	};
	const removeRuntimeDirectory =
		dependencies.removeRuntimeDirectory ?? removeInvocationRuntimeDirectory;
	let session: CommitSession | undefined;

	try {
		await createRuntimeDirectory(plan.directory);
		session = await dependencies.client.openCommitSession?.(commitOptions);

		if (rootLinkDirectory !== undefined) {
			roots = await createRootLinkDirectory(
				rootLinkDirectory,
				path.join(plan.directory, 'root.sock')
			);
		}

		if (options.invocation.kind === 'constructed') {
			await createRuntimeDirectory(targetLinkDirectory);
		}
		await createRuntimeDirectory(childRuntimeDirectory);

		await writeFile(
			hookScriptPath,
			renderHookScript({
				invocationId: dependencies.invocationId,
				helperPath: preflight.helperPath,
				socketPath: plan.socketPath,
				...(rootLinkDirectory !== undefined && { rootLinkDirectory })
			}),
			{ mode: 0o700 }
		);

		batcher = new BuildOutputBatcher({
			store: batchStore,
			client: dependencies.client,
			...(options.runRoot !== undefined && { runRoot: options.runRoot }),
			commitOptions,
			...(session !== undefined && { session }),
			...(dependencies.createNarArchive !== undefined && {
				createNarArchive: dependencies.createNarArchive
			}),
			...(dependencies.compressNar !== undefined && {
				compressNar: dependencies.compressNar
			})
		});
		listener = await BuildEventListener.listen({
			socketPath: plan.socketPath,
			storeDirectory: dependencies.storeDirectory,
			onEvent: async (event, signal) => {
				if (event.outputProtection === 'failed') {
					return;
				}

				await protectEventPaths(event.outputPaths, signal);

				for (const outputPath of event.outputPaths) {
					batcher.enqueue(outputPath);
				}

				maxQueueDepth = Math.max(maxQueueDepth, batcher.candidates.length);
			},
			onRejected: (error) => {
				const label =
					error instanceof BuildEventHandlingError
						? 'Could not protect completed outputs'
						: 'Could not read completed outputs from the build hook';
				const reason =
					error instanceof BuildEventHandlingError &&
					error.cause instanceof Error
						? error.cause.message
						: error.message;

				reporter.warn(label, reason);
			}
		});
	} catch (error) {
		return withCleanups(() => {
			throw error;
		}, [
			() => roots?.close() ?? Promise.resolve(),
			() => {
				session?.close();

				return Promise.resolve();
			},
			() => removeRuntimeDirectory(plan.directory),
			() => removeRuntimeDirectory(targetLinkDirectory)
		]);
	}

	return withCleanups(async () => {
		const environment = environmentWithPostBuildHook(
			dependencies.environment ?? process.env,
			hookScriptPath
		);
		const { exit, attempts } = await reporter.phase(buildPushPhases.build, () =>
			runInvocation(
				options.invocation,
				environment,
				childRuntimeDirectory,
				dependencies,
				targetLinkDirectory
			)
		);

		// Every helper has connected by the time the child exits, though its
		// message may still be undelivered. Quiescing the endpoint first makes
		// the accepted set complete, so every event the batcher uploads is
		// also reconciled, retained and receipted.
		await listener.drain();

		const accepted = listener.accepted;
		const eventPaths = orderedUnique(
			accepted.flatMap((event) => event.outputPaths)
		);
		const selectedTargetPaths =
			options.invocation.kind === 'constructed'
				? await outLinkTargets(targetLinkDirectory)
				: undefined;
		const subjects = await attributeSubjects(
			options.invocation,
			dependencies,
			attempts,
			eventPaths
		);
		const terminalFailure = terminalFailureFor(
			options.invocation,
			attempts,
			exit
		);

		return settleRun(options, reporter, dependencies, {
			mode: 'streamed',
			exit,
			batcher,
			commitOptions,
			...(session !== undefined && { session }),
			maxQueueDepth,
			eventPaths,
			subjects,
			copiedFrom: watchedCopySources(attempts.map((attempt) => attempt.log)),
			...(selectedTargetPaths !== undefined && { selectedTargetPaths }),
			...(terminalFailure !== undefined && { terminalFailure })
		});
	}, [
		() => listener.drain(),
		() => batcher.stop(),
		() => {
			session?.close();

			return Promise.resolve();
		},
		() => roots?.close() ?? Promise.resolve(),
		() => listener.close(),
		() => removeRuntimeDirectory(plan.directory),
		() => removeRuntimeDirectory(targetLinkDirectory)
	]);
}

// A user-supplied command runs exactly once, its semantics untouched; a
// constructed invocation runs under the bounded attempt loop with a
// per-attempt activity log.
async function runInvocation(
	invocation: BuildInvocation,
	environment: ChildEnvironment,
	runtimeDirectory: string,
	dependencies: BuildPushDependencies,
	targetLinkDirectory: string
): Promise<{
	readonly exit: ChildExit;
	readonly attempts: readonly SupervisedAttempt[];
}> {
	if (invocation.kind === 'command') {
		const exit = await superviseBuild({
			command: invocation.command,
			environment,
			runtimeDirectory,
			...(dependencies.signalSource !== undefined && {
				signalSource: dependencies.signalSource
			}),
			...(dependencies.removeRuntimeDirectory !== undefined && {
				removeRuntimeDirectory: dependencies.removeRuntimeDirectory
			})
		});

		return { exit, attempts: [] };
	}

	return superviseAttemptedBuild({
		command: (logFile) =>
			constructedNixCommand(
				invocation.build,
				logFile,
				path.join(targetLinkDirectory, outLinkName)
			),
		attempts: invocation.build.attempts ?? defaultBuildAttempts,
		environment,
		runtimeDirectory,
		...(dependencies.signalSource !== undefined && {
			signalSource: dependencies.signalSource
		}),
		...(dependencies.nextAttemptId !== undefined && {
			nextAttemptId: dependencies.nextAttemptId
		}),
		...(dependencies.startDelay !== undefined && {
			startDelay: dependencies.startDelay
		}),
		...(dependencies.removeRuntimeDirectory !== undefined && {
			removeRuntimeDirectory: dependencies.removeRuntimeDirectory
		})
	});
}

// Construct a `nix build` invocation and request an activity log for derivation
// and builder attribution. When provided, the out-link records realised outputs
// and keeps them alive during publication. Streaming hook events identify their
// own outputs and therefore require no out-link.
function constructedNixCommand(
	build: ConstructedBuild,
	logFile: string,
	outLink?: string
): ChildCommand {
	return [
		'nix',
		'build',
		...(build.rebuild === true ? ['--rebuild'] : []),
		...(outLink === undefined ? ['--no-link'] : ['--out-link', outLink]),
		'--option',
		'json-log-path',
		logFile,
		...(build.keepGoing === true ? ['--keep-going'] : []),
		...(build.maxJobs === undefined
			? []
			: ['--max-jobs', String(build.maxJobs)]),
		'--',
		...build.installables
	];
}

// `copySources` returns each store as a plain string, because `@cupboard/nix`
// does not depend on the receipt schemas. Brand the strings here, where they
// become receipt values.
function watchedCopySources(
	logs: readonly string[]
): ReadonlyMap<StorePathString, readonly NixStoreUri[]> {
	return new Map(
		copySources(logs)
			.entries()
			.map(([storePath, sources]) => [
				storePath,
				sources.map((source) => nixStoreUriSchema.parse(source))
			])
	);
}

// Join completed hook paths to build-start activity by deriver. The hook emits
// events only for builds executed in this run, so these paths do not need a
// pre-run validity exclusion.
async function attributeSubjects(
	invocation: BuildInvocation,
	dependencies: BuildPushDependencies,
	attempts: readonly SupervisedAttempt[],
	eventPaths: readonly StorePathString[]
): Promise<readonly BuildSubjectV3Input[]> {
	if (invocation.kind !== 'constructed' || eventPaths.length === 0) {
		return [];
	}

	const observed: readonly BuildAttempt[] = attempts.map((attempt) => ({
		attempt: attempt.attempt,
		attemptId: attempt.attemptId,
		activities: parseBuildActivities(attempt.log)
	}));

	if (observed.length === 0) {
		return [];
	}

	const infos = await dependencies.store.queryValidPathsInfo(eventPaths);

	return receiptSubjects(observed, infos, new Set(), autoBuildStore);
}

// Classify a non-zero exit as a target build failure only when a constructed
// invocation requested one installable and emitted build activity. Commands,
// signals, grouped requests, and failures before activity remain command
// failures.
function terminalFailureFor(
	invocation: BuildInvocation,
	attempts: readonly SupervisedAttempt[],
	exit: ChildExit
): TerminalBuildFailureInput | undefined {
	if (exit.status === 0) {
		return undefined;
	}

	if (
		invocation.kind === 'constructed' &&
		invocation.build.installables.length === 1 &&
		exit.status !== undefined &&
		attempts.some((attempt) => parseBuildActivities(attempt.log).length > 0)
	) {
		return {
			kind: 'target-build',
			failedTargets: [...invocation.build.installables]
		};
	}

	return { kind: 'command' };
}

// Keep the activity logs and out-links in separate run directories. The
// out-links keep realised paths alive while the push reads them, replacing the
// temporary roots that a daemon-backed run would use.
const buildDirectoryName = 'build';
const outLinkDirectoryName = 'out-links';
const outLinkName = 'result';

// Exclude paths that were valid before the build from current-run provenance.
// A user command declares no outputs that can be reconciled, so this mode
// returns the preflight error for one.
async function runReconciledLocalBuildPush(
	options: BuildPushRunOptions,
	reporter: Reporter,
	dependencies: BuildPushDependencies,
	reason: UntrustedDaemonError
): Promise<BuildReceiptV3> {
	const { invocation } = options;

	if (invocation.kind !== 'constructed') {
		throw reason;
	}

	const { build } = invocation;
	const directory = planInvocationDirectory({
		...dependencies.runtime,
		invocationId: dependencies.invocationId
	});
	const buildDirectory = path.join(directory, buildDirectoryName);
	const outLinkDirectory = path.join(directory, outLinkDirectoryName);
	const removeRuntimeDirectory =
		dependencies.removeRuntimeDirectory ?? removeInvocationRuntimeDirectory;

	return withCleanups(async () => {
		await createRuntimeDirectory(buildDirectory);
		await createRuntimeDirectory(outLinkDirectory);

		const declared = await declaredOutputs(build, dependencies.store);
		const initiallyValid = await dependencies.store.queryValidPaths(declared);
		const { exit, attempts } = await reporter.phase(buildPushPhases.build, () =>
			superviseAttemptedBuild({
				command: (logFile) =>
					constructedNixCommand(
						build,
						logFile,
						path.join(outLinkDirectory, outLinkName)
					),
				attempts: build.attempts ?? defaultBuildAttempts,
				environment: dependencies.environment ?? process.env,
				runtimeDirectory: buildDirectory,
				...(dependencies.signalSource !== undefined && {
					signalSource: dependencies.signalSource
				}),
				...(dependencies.nextAttemptId !== undefined && {
					nextAttemptId: dependencies.nextAttemptId
				}),
				...(dependencies.startDelay !== undefined && {
					startDelay: dependencies.startDelay
				}),
				removeRuntimeDirectory
			})
		);
		const realised = await realisedOutputs(
			outLinkDirectory,
			declared,
			dependencies.store
		);

		const attemptLogs = attempts.map((attempt) => attempt.log);
		const delegated = delegatedMachines(
			attempts.map((attempt) => ({
				attempt: attempt.attempt,
				attemptId: attempt.attemptId,
				activities: parseBuildActivities(attempt.log)
			}))
		);
		const terminalFailure = terminalFailureFor(invocation, attempts, exit);
		const receipt = await publishRealised(
			{
				realised,
				declared,
				// `--rebuild` executes every selected final derivation even when
				// its output was valid beforehand. Those paths are therefore
				// current-run provenance candidates rather than exclusions.
				alreadyHeld: build.rebuild === true ? [] : initiallyValid,
				delegated,
				copiedFrom: watchedCopySources(attemptLogs),
				exit,
				...(terminalFailure !== undefined && { terminalFailure })
			},
			options,
			reporter,
			dependencies
		);
		requireCompleteProvenance(invocation, realised, receipt.subjects);

		try {
			await writeReceiptFile(options.receiptFile, receipt);
		} catch (error) {
			if (exit.status !== 0) {
				throw childFailure(exit);
			}

			throw publicationFailure(error);
		}

		const uploaded = receipt.uploaded?.length ?? 0;
		reportBuildSummary(reporter, {
			mode: 'reconciled-local',
			store: dependencies.storeDirectory,
			targetPaths: realised.length,
			intermediatePaths: options.intermediatePaths?.length ?? 0,
			queueDepth: 0,
			uploadedPaths: uploaded,
			skipped: Math.max(receipt.paths.length - uploaded, 0),
			childExitStatus: childExitCode(exit),
			unconfirmedPaths: []
		});

		if (exit.status !== 0) {
			throw childFailure(exit);
		}

		await dependencies.settledTargets?.(
			realised.map((storePath) => storePathSchema.parse(storePath))
		);

		return receipt;
	}, [() => removeRuntimeDirectory(directory)]);
}

// Resolve predictable output paths from derivation installables before the
// build. Outputs from other installable forms are discovered through out-links.
async function declaredOutputs(
	build: ConstructedBuild,
	store: BuildPushStore
): Promise<readonly string[]> {
	const outputs = new Set<string>();

	for (const installable of build.installables) {
		const drvPath = derivationPathOf(installable);

		if (drvPath === undefined) {
			continue;
		}

		const derivation = await store.readDerivation(drvPath);
		const selection = installable.split('^', 2)[1];
		const selectedNames =
			selection === undefined || selection === '*'
				? derivation.outputs.keys()
				: selection.split(',').values();

		for (const name of selectedNames) {
			const output = derivation.outputs.get(name);

			if (output !== undefined) {
				outputs.add(output);
			}
		}
	}

	return outputs.values().toArray();
}

// Combine the out-link targets with declared outputs that are now valid. The
// declared outputs preserve successful results from a partial `--keep-going`
// build even when Nix did not create out-links for them.
async function realisedOutputs(
	outLinkDirectory: string,
	declared: readonly string[],
	store: BuildPushStore
): Promise<readonly string[]> {
	const linked = await outLinkTargets(outLinkDirectory);

	return store.queryValidPaths([...new Set([...linked, ...declared])]);
}

// Read each out-link target instead of parsing Nix's `result`, `result-<n>` and
// `result-<output>` link names.
async function outLinkTargets(
	directory: string
): Promise<readonly StorePathString[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const targets = await Promise.all(
		entries
			.filter((entry) => entry.isSymbolicLink())
			.map((entry) => readlink(path.join(directory, entry.name)))
	);

	return targets.flatMap((target) => {
		const parsed = storePathSchema.safeParse(target);

		return parsed.success ? [parsed.data] : [];
	});
}

interface RealisedBuild {
	readonly realised: readonly string[];
	readonly declared: readonly string[];
	readonly alreadyHeld: readonly string[];
	readonly delegated: ReadonlyMap<string, string>;
	readonly copiedFrom: ReadonlyMap<StorePathString, readonly NixStoreUri[]>;
	readonly exit: ChildExit;
	readonly terminalFailure?: TerminalBuildFailureInput;
}

// Publish the reconciled outputs together. A publication failure after a
// successful build uses a classified sysexits code; a failed build preserves
// the child's status. An empty result skips the push and leaves the root intact.
async function publishRealised(
	built: RealisedBuild,
	options: BuildPushRunOptions,
	reporter: Reporter,
	dependencies: BuildPushDependencies
): Promise<BuildReceiptV3> {
	const { exit } = built;
	const publication = PublicationCollection.of({
		targets: [...built.realised],
		...(options.intermediatePaths !== undefined && {
			intermediatePaths: [...options.intermediatePaths]
		})
	});
	const childExitStatus = childExitCode(exit);

	if (publication.entries.length === 0) {
		return buildReceiptV3Schema.parse({
			version: 3,
			paths: [],
			subjects: [],
			childExitStatus,
			...(built.terminalFailure !== undefined && {
				terminalFailure: built.terminalFailure
			})
		});
	}

	let published: BuildReceiptV3 | undefined;

	try {
		const shouldRetainTargets = exit.status === 0 && options.root !== undefined;

		published = await runPush(publication, reporter, {
			client: dependencies.client,
			nix: dependencies.store,
			buildStore: autoBuildStore,
			alreadyHeld: built.alreadyHeld,
			claimable: built.declared,
			delegated: built.delegated,
			copiedFrom: built.copiedFrom,
			retain: shouldRetainTargets,
			...(shouldRetainTargets && { root: options.root }),
			...(shouldRetainTargets && {
				retention: options.retention ?? { kind: 'inherit' }
			}),
			...(options.runRoot !== undefined && { runRoot: options.runRoot }),
			...(options.closure !== undefined && { closure: options.closure }),
			...(options.wait !== undefined && { wait: options.wait }),
			...(options.waitTimeoutSeconds !== undefined && {
				waitTimeoutSeconds: options.waitTimeoutSeconds
			}),
			...(options.uploadConcurrency !== undefined && {
				uploadConcurrency: options.uploadConcurrency
			}),
			...(dependencies.createNarArchive !== undefined && {
				createNarArchive: dependencies.createNarArchive
			}),
			...(dependencies.compressNar !== undefined && {
				compressNar: dependencies.compressNar
			})
		});
	} catch (error) {
		if (isAbortError(error) || error instanceof BuildPublicationFailedError) {
			throw error;
		}

		if (exit.status !== 0) {
			throw childFailure(exit);
		}

		throw publicationFailure(error);
	}

	if (published === undefined) {
		throw publicationFailure(undefined);
	}

	return buildReceiptV3Schema.parse({
		...published,
		childExitStatus,
		...(built.terminalFailure !== undefined && {
			terminalFailure: built.terminalFailure
		})
	});
}

// Preserve both parts of the publication exit contract: the sysexits category
// derived from the cause and any unfinished paths reported by the push.
function publicationFailure(cause: unknown): BuildPublicationFailedError {
	const failedPaths =
		cause instanceof PushIncompleteError ? cause.failedPaths : [];
	const classification = classifyPublicationFailures([cause]);

	return new BuildPublicationFailedError(failedPaths, classification.exitCode, {
		cause: classification.cause
	});
}

interface RunFacts {
	readonly mode: BuildSummaryInput['mode'];
	readonly exit: ChildExit;
	readonly batcher: BuildOutputBatcher;
	readonly commitOptions: CommitOptions;
	readonly session?: CommitSession;
	readonly maxQueueDepth: number;
	readonly eventPaths: readonly StorePathString[];
	readonly subjects: readonly BuildSubjectV3Input[];
	readonly copiedFrom: ReadonlyMap<StorePathString, readonly NixStoreUri[]>;
	readonly selectedTargetPaths?: readonly StorePathString[];
	readonly terminalFailure?: TerminalBuildFailureInput;
}

function requireCompleteProvenance(
	invocation: BuildInvocation,
	targetPaths: readonly string[],
	subjects: readonly BuildSubjectV3Input[]
): void {
	if (
		invocation.kind !== 'constructed' ||
		invocation.build.requireProvenance !== true
	) {
		return;
	}

	// Receipts also contain store-held subjects. Require a `built` subject for
	// every target so a path merely found in the store cannot satisfy provenance.
	const claimed = new Set(
		subjects
			.filter((subject) => subject.origin === 'built')
			.map((subject) => subject.storePath)
	);
	const missing = targetPaths.filter((storePath) => !claimed.has(storePath));

	if (missing.length > 0) {
		throw new BuildProvenanceIncompleteError(missing);
	}
}

async function settleRun(
	options: BuildPushRunOptions,
	reporter: Reporter,
	dependencies: BuildPushDependencies,
	facts: RunFacts
): Promise<BuildReceiptV3> {
	const { exit, batcher } = facts;

	try {
		await reporter.phase(buildPushPhases.queue, (ctx) => {
			ctx.fact('accepted', formatCount(facts.eventPaths.length));
			ctx.fact('queue depth', formatCount(facts.maxQueueDepth));
		});

		await reporter.phase(buildPushPhases.upload, async (ctx) => {
			await batcher.drain();
			ctx.fact('outcomes', formatCount(batcher.outcomes.size));
			ctx.fact('remaining', formatCount(batcher.candidates.length));
		});

		const declaredIntermediates = new Set(options.intermediatePaths);
		const targetPaths =
			facts.selectedTargetPaths ??
			facts.eventPaths.filter(
				(eventPath) => !declaredIntermediates.has(eventPath)
			);
		const targetSet = new Set(targetPaths);
		const intermediates = new Set([
			...declaredIntermediates,
			...facts.eventPaths.filter((eventPath) => !targetSet.has(eventPath))
		]);
		const targets: readonly ReconcileTarget[] = targetPaths.map(
			(targetPath) => ({
				installable: targetPath,
				expectedPath: targetPath,
				...(options.root !== undefined && { root: options.root })
			})
		);
		requireCompleteProvenance(options.invocation, targetPaths, facts.subjects);

		const result = await reporter.phase(
			buildPushPhases.reconcile,
			async (ctx) => {
				const closureIntermediates = await closureExpansion(
					options,
					dependencies,
					targetPaths
				);
				const reconciled = await reconcileBuild({
					targets,
					outcomes: batcher.outcomes,
					candidates: batcher.candidates,
					snapshot: { derivations: new Map() },
					intermediatePaths: [...intermediates, ...closureIntermediates],
					store: dependencies.store,
					client: dependencies.client,
					...(options.runRoot !== undefined && {
						runRoot: options.runRoot
					}),
					retention: options.retention ?? { kind: 'inherit' },
					...(options.wait !== undefined && { wait: options.wait }),
					commitOptions: facts.commitOptions,
					...(facts.session !== undefined && { session: facts.session }),
					...(options.uploadConcurrency !== undefined && {
						uploadConcurrency: options.uploadConcurrency
					}),
					...(dependencies.createNarArchive !== undefined && {
						createNarArchive: dependencies.createNarArchive
					}),
					...(dependencies.compressNar !== undefined && {
						compressNar: dependencies.compressNar
					}),
					...(facts.subjects.length > 0 && { subjects: facts.subjects }),
					copiedFrom: facts.copiedFrom,
					childExitStatus: childExitCode(exit),
					...(facts.terminalFailure !== undefined && {
						terminalFailure: facts.terminalFailure
					})
				});

				ctx.fact('servable', formatCount(reconciled.receipt.paths.length));
				ctx.fact('failed', formatCount(reconciled.receipt.failed?.length ?? 0));

				return reconciled;
			}
		);

		await reporter.phase(buildPushPhases.retention, (ctx) => {
			const applied = result.roots.filter((root) => root.applied).length;

			ctx.fact(
				'roots',
				`${formatCount(applied)}/${formatCount(result.roots.length)} replaced`
			);
		});

		await writeReceiptFile(options.receiptFile, result.receipt);
		reportSummary(reporter, dependencies, facts, targets.length, result);
		raiseExitContract(exit, result);
		await dependencies.settledTargets?.(targetPaths);

		return result.receipt;
	} catch (error) {
		if (
			isAbortError(error) ||
			error instanceof BuildCommandFailedError ||
			error instanceof BuildPublicationFailedError
		) {
			throw error;
		}

		// A build failure takes precedence over a later publication error because
		// callers use the child's status to decide whether to retry the build.
		if (exit.status !== 0) {
			throw childFailure(exit);
		}

		const classification = classifyPublicationFailures([error]);

		throw new BuildPublicationFailedError([], classification.exitCode, {
			cause: classification.cause
		});
	}
}

async function closureExpansion(
	options: BuildPushRunOptions,
	dependencies: BuildPushDependencies,
	targetPaths: readonly StorePathString[]
): Promise<readonly StorePathString[]> {
	if (options.closure !== true || targetPaths.length === 0) {
		return [];
	}

	const targets = new Set(targetPaths);
	const closure = await dependencies.store.resolveClosure(targetPaths);

	return closure
		.map((info) => info.storePath)
		.filter((storePath) => !targets.has(storePath));
}

async function writeReceiptFile(
	receiptFile: string | undefined,
	receipt: BuildReceiptV3
): Promise<void> {
	if (receiptFile === undefined) {
		return;
	}

	await writeFile(receiptFile, `${JSON.stringify(receipt, undefined, '\t')}\n`);
}

function reportSummary(
	reporter: Reporter,
	dependencies: BuildPushDependencies,
	facts: RunFacts,
	targetCount: number,
	result: ReconcileResult
): void {
	const { receipt } = result;
	const uploaded = receipt.uploaded?.length ?? 0;

	reportBuildSummary(reporter, {
		mode: facts.mode,
		store: dependencies.storeDirectory,
		targetPaths: targetCount,
		intermediatePaths: facts.eventPaths.length - targetCount,
		queueDepth: facts.maxQueueDepth,
		uploadedPaths: uploaded,
		skipped: Math.max(receipt.paths.length - uploaded, 0),
		childExitStatus: childExitCode(facts.exit),
		unconfirmedPaths: [...(receipt.failed ?? [])]
	});
}

function reportBuildSummary(
	reporter: Reporter,
	summary: BuildSummaryInput
): void {
	const rows: ResultRow[] = [
		{ label: 'Store', value: summary.store },
		{ label: 'Targets', value: formatCount(summary.targetPaths) },
		{ label: 'Uploaded paths', value: formatCount(summary.uploadedPaths) },
		{ label: 'Skipped', value: formatCount(summary.skipped) },
		{
			label: 'Child exit status',
			value: formatCount(summary.childExitStatus)
		},
		...(summary.unconfirmedPaths.length > 0
			? [
					{
						label: 'Unconfirmed',
						value: formatCount(summary.unconfirmedPaths.length)
					}
				]
			: [])
	];
	const validated = buildSummarySchema.safeParse(summary);

	reporter.result({
		kind: buildSummaryResultKind,
		data: validated.success ? validated.data : summary,
		rows
	});
}

// The numeric exit contract: a failed build exits with the child's own
// status, or 128 plus its signal number; a successful build with failed
// publication exits with the classified sysexits code. An abort among the
// failure causes is re-raised as the abort so the run exits 130.
function raiseExitContract(exit: ChildExit, result: ReconcileResult): void {
	if (exit.status !== 0) {
		throw childFailure(exit);
	}

	if (result.failures.length === 0) {
		return;
	}

	const causes = result.failures.map((failure) => failure.cause);
	const abort = causes.find((cause) => isAbortError(cause));

	if (abort !== undefined) {
		if (abort instanceof Error) {
			throw abort;
		}

		throw new CliAbortError();
	}

	const classification = classifyPublicationFailures(causes);

	throw new BuildPublicationFailedError(
		result.failures.map((failure) => failure.storePath),
		classification.exitCode,
		{ cause: classification.cause }
	);
}

function orderedUnique(
	paths: readonly StorePathString[]
): readonly StorePathString[] {
	return new Set(paths).values().toArray();
}
