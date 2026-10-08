import { readdir, readlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
	copySources,
	defaultNixConfigEnvironment,
	discoverNixStoreConfig,
	type Nix,
	type PublicationSelection,
	selectPublicationPaths
} from '@cupboard/nix';
import {
	abortReason,
	type BuildAttempt,
	BuildEventListener,
	type ChildEnvironment,
	createRootLinkDirectory,
	createRuntimeDirectory,
	environmentWithPostBuildHook,
	type InvocationRuntimeOptions,
	parseBuildActivities,
	planInvocationDirectory,
	receiptSubjects,
	removeInvocationRuntimeDirectory,
	renderHookScript,
	type RootLinkDirectory,
	type VerifiedBuildOutput,
	waitForProtection
} from '@cupboard/nix/build-observation';
import { derivationPathOf } from '@cupboard/nix-store/derivation';
import {
	type RootName,
	type StoreDirectory,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import {
	autoBuildStore,
	type BuildReceiptV3,
	buildReceiptV3Schema,
	type BuildSubjectV3Input,
	type InvocationId,
	type NixStoreUri,
	nixStoreUriSchema,
	type TargetFailureReason,
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
	type ResultRow,
	shouldShowDetails
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
	BuildObservationMissingError,
	BuildProvenanceIncompleteError,
	BuildPublicationFailedError,
	BuildRebuildRemoteDispatchError,
	CliAbortError,
	CliUsageError,
	type PushCredential,
	PushIncompleteError,
	type UntrustedDaemonError
} from '../errors.ts';
import { classifyPublicationFailures } from '../exit-code.ts';
import { formatHumanError } from '../human-errors.ts';
import type { NarCompressionFacts } from '../nix/blob.ts';
import { capacityWaitReporter } from '../push/capacity-wait.ts';
import {
	compressionRows,
	CompressionTotals,
	type PeakRssSampler,
	processPeakRss,
	reportNarCompression
} from '../push/compression-report.ts';
import { PublicationCollection } from '../push/publication.ts';
import {
	type CompressNar,
	type PushClient,
	type PushNarArchive,
	type PushStore,
	runPush
} from '../push/push.ts';
import { reportUploadDuration } from '../push/upload-transfer.ts';

import { type BatchStore, BuildOutputBatcher } from './batching.ts';
import { buildPushModeDescription, selectBuildPushMode } from './mode.ts';
import type { BuildPushPreflight } from './preflight.ts';
import {
	reconcileBuild,
	type ReconcileFailure,
	type ReconcileOptions,
	type ReconcileResult,
	type ReconcileTarget
} from './reconcile.ts';
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
	/**
	Realise each required path from its candidate producers before targets.
	*/
	readonly dependencyBuilds?: readonly {
		readonly path: StorePathString;
		readonly installables: readonly string[];
	}[];
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
	readonly publicationScope?: 'outputs' | 'built' | 'closure';
	readonly substituter?: 'leave' | 'copy';
	readonly tenantUrl?: URL;
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
	readonly selectPublicationPaths?: typeof selectPublicationPaths;
	readonly signal?: AbortSignal;
	readonly client: PushClient;
	readonly credential: PushCredential;
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
	/**
	 * Reads the process's peak RSS for the summary. Defaults to
	 * `processPeakRss`.
	 */
	readonly peakRss?: PeakRssSampler;
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

class BuiltPublicationObservationUnsupportedError extends CliUsageError {
	constructor() {
		super(
			'Publication scope built cannot observe all build intermediates without a supported post-build hook. Use a trusted local daemon or select outputs or closure.'
		);
		this.name = 'BuiltPublicationObservationUnsupportedError';
	}
}

class PublicationScopeInvalidError extends CliUsageError {
	constructor() {
		super(
			'An explicit publication scope requires installable cohorts and cannot be combined with --closure or --intermediate-paths-file'
		);
		this.name = 'PublicationScopeInvalidError';
	}
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
	if (
		options.publicationScope !== undefined &&
		(options.invocation.kind !== 'constructed' ||
			options.closure === true ||
			(options.intermediatePaths?.length ?? 0) > 0)
	) {
		throw new PublicationScopeInvalidError();
	}
	const mode = await selectBuildPushMode(dependencies.preflight);

	if (mode.kind === 'reconciled-local') {
		if (options.publicationScope === 'built') {
			throw new BuiltPublicationObservationUnsupportedError();
		}

		return runReconciledLocalBuildPush(
			options,
			reporter,
			dependencies,
			mode.reason
		);
	}

	reporter.info(buildPushModeDescription(mode), {
		humanMessage: shouldShowDetails(reporter)
			? buildPushModeDescription(mode)
			: 'Publishing outputs as the build finishes.'
	});

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
	const compression = new CompressionTotals();
	const reportUpload = uploadReporter(reporter, compression);
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
			}),
			...(options.uploadConcurrency !== undefined && {
				uploadConcurrency: options.uploadConcurrency
			}),
			onUploaded: reportUpload
		});
		listener = await BuildEventListener.listen({
			socketPath: plan.socketPath,
			storeDirectory: dependencies.storeDirectory,
			onEvent: async (event, signal) => {
				if (event.outputProtection === 'failed') {
					return;
				}

				await protectEventPaths(event.outputPaths, signal);

				if (options.publicationScope === undefined) {
					for (const outputPath of event.outputPaths) {
						batcher.enqueue(outputPath);
					}
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

				reporter.warn(label, reason, {
					humanMessage:
						error instanceof BuildEventHandlingError
							? `Completed outputs could not be kept in the local store: ${formatHumanError(error.cause, { debug: reporter.presentation === 'debug' })}`
							: `Could not identify completed outputs for publication: ${formatHumanError(error, { debug: reporter.presentation === 'debug' })}`
				});
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
		const {
			exit,
			attempts,
			preExisting = [],
			terminalFailure: dependencyFailure
		} = await reporter.phase(buildPushPhases.build, () =>
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
			options.invocation.kind === 'constructed' &&
				options.invocation.build.rebuild === true &&
				exit.status === 0
				? orderedUnique([...eventPaths, ...(selectedTargetPaths ?? [])])
				: eventPaths,
			preExisting,
			true
		);
		const terminalFailure =
			dependencyFailure ??
			terminalFailureFor(options.invocation, attempts, exit);

		return settleRun(options, reporter, dependencies, {
			observedDerivations: new Set(
				attempts.flatMap((attempt) =>
					parseBuildActivities(attempt.log).map(
						(activity) => activity.derivation
					)
				)
			),
			mode: 'streamed',
			exit,
			batcher,
			compression,
			reportUpload,
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
): Promise<BuildExecution> {
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

	if (
		invocation.build.rebuild === true &&
		discoverNixStoreConfig({ ...defaultNixConfigEnvironment, env: environment })
			.building.builders !== undefined
	) {
		throw new BuildRebuildRemoteDispatchError();
	}

	const dependencyAttempts: BuildExecutionAttempt[] = [];
	const requiredDependencies = invocation.build.dependencyBuilds ?? [];
	for (const [dependencyIndex, dependency] of requiredDependencies.entries()) {
		const candidate = await runDependencyBuild(
			dependency,
			invocation.build,
			environment,
			runtimeDirectory,
			dependencies,
			path.join(
				path.dirname(runtimeDirectory),
				'dependency-out-links',
				String(dependencyIndex)
			)
		);
		appendBuildAttempts(dependencyAttempts, candidate.attempts);
		if (!candidate.isRealised) {
			return {
				exit: candidate.exit,
				attempts: dependencyAttempts,
				terminalFailure: { kind: 'command' }
			};
		}
	}
	const target =
		invocation.build.rebuild === true
			? await runRebuild(
					invocation.build,
					environment,
					runtimeDirectory,
					dependencies,
					targetLinkDirectory
				)
			: await runConstructedBuild(
					invocation.build,
					environment,
					runtimeDirectory,
					dependencies,
					path.join(targetLinkDirectory, outLinkName)
				);
	const terminalFailure =
		target.terminalFailure ??
		terminalFailureFor(invocation, target.attempts, target.exit);
	appendBuildAttempts(dependencyAttempts, target.attempts);
	return {
		...target,
		attempts: dependencyAttempts,
		...(terminalFailure !== undefined && { terminalFailure })
	};
}

interface BuildExecutionAttempt extends SupervisedAttempt {
	readonly verifiedOutputs?: readonly VerifiedBuildOutput[];
}

interface BuildExecution {
	readonly terminalFailure?: TerminalBuildFailureInput;
	readonly preExisting?: readonly string[];
	readonly exit: ChildExit;
	readonly attempts: readonly BuildExecutionAttempt[];
}

interface DependencyBuildExecution extends BuildExecution {
	readonly isRealised: boolean;
}

async function runDependencyBuild(
	dependency: NonNullable<ConstructedBuild['dependencyBuilds']>[number],
	build: ConstructedBuild,
	environment: ChildEnvironment,
	runtimeDirectory: string,
	dependencies: BuildPushDependencies,
	linkDirectory: string
): Promise<DependencyBuildExecution> {
	const attempts: BuildExecutionAttempt[] = [];
	let lastExit: ChildExit = { status: 1, signal: undefined };
	for (const [
		candidateIndex,
		installable
	] of dependency.installables.entries()) {
		const candidateLinks = path.join(linkDirectory, String(candidateIndex));
		await createRuntimeDirectory(candidateLinks);
		const candidate = await runConstructedBuild(
			{
				installables: [installable],
				...(build.attempts !== undefined && { attempts: build.attempts }),
				...(build.maxJobs !== undefined && { maxJobs: build.maxJobs })
			},
			environment,
			runtimeDirectory,
			dependencies,
			path.join(candidateLinks, outLinkName)
		);
		appendBuildAttempts(attempts, candidate.attempts);
		lastExit = candidate.exit;
		if (
			candidate.exit.signal !== undefined ||
			candidate.exit.status === 127 ||
			candidate.exit.status === undefined
		) {
			return { exit: candidate.exit, attempts, isRealised: false };
		}
		const valid = await dependencies.store.queryValidPaths([dependency.path]);
		if (valid.includes(dependency.path)) {
			return { exit: candidate.exit, attempts, isRealised: true };
		}
	}
	return {
		exit: { ...lastExit, status: lastExit.status === 0 ? 1 : lastExit.status },
		attempts,
		isRealised: false
	};
}

async function runConstructedBuild(
	build: ConstructedBuild,
	environment: ChildEnvironment,
	runtimeDirectory: string,
	dependencies: BuildPushDependencies,
	outLink?: string
): Promise<BuildExecution> {
	await createRuntimeDirectory(runtimeDirectory);
	return superviseAttemptedBuild({
		command: (logFile) => constructedNixCommand(build, logFile, outLink),
		attempts: build.attempts ?? defaultBuildAttempts,
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

async function runRebuild(
	build: ConstructedBuild,
	environment: ChildEnvironment,
	runtimeDirectory: string,
	dependencies: BuildPushDependencies,
	targetLinkDirectory: string
): Promise<BuildExecution> {
	const declaredByTarget = new Map<string, readonly string[]>();
	for (const installable of build.installables) {
		declaredByTarget.set(
			installable,
			await declaredOutputs(
				{ ...build, installables: [installable] },
				dependencies.store
			)
		);
	}
	const initiallyValid = new Set(
		await dependencies.store.queryValidPaths(
			declaredByTarget.values().toArray().flat()
		)
	);
	const normal = await runConstructedBuild(
		{ ...build, rebuild: false },
		environment,
		runtimeDirectory,
		dependencies,
		path.join(targetLinkDirectory, outLinkName)
	);
	if (normal.exit.status !== 0) {
		return { ...normal, preExisting: [...initiallyValid] };
	}

	const attempts = [...normal.attempts];
	const completed = new Set(
		normal.attempts
			.filter((attempt) => attempt.exit.status === 0)
			.flatMap((attempt) =>
				parseBuildActivities(attempt.log)
					.filter((activity) => activity.machine === '')
					.map((activity) => activity.derivation)
			)
	);
	const linked = await outLinkTargets(targetLinkDirectory);
	const finalInfos = await dependencies.store.queryValidPathsInfo(linked);
	let failure: ChildExit | undefined;

	for (const [index, installable] of build.installables.entries()) {
		let selected = declaredByTarget.get(installable) ?? [];
		if (selected.length === 0) {
			const derivation = derivationPathOf(installable);
			selected =
				build.installables.length === 1
					? linked
					: finalInfos
							.filter(
								(info) =>
									derivation !== undefined && info.deriver === derivation
							)
							.map((info) => info.storePath);
		}
		if (selected.length === 0) {
			const links = path.join(targetLinkDirectory, String(index));
			await createRuntimeDirectory(links);
			const resolved = await runConstructedBuild(
				{ ...build, installables: [installable], rebuild: false },
				environment,
				runtimeDirectory,
				dependencies,
				path.join(links, outLinkName)
			);
			appendBuildAttempts(attempts, resolved.attempts);
			if (resolved.exit.status !== 0) {
				return {
					exit: resolved.exit,
					attempts,
					preExisting: [...initiallyValid]
				};
			}
			for (const attempt of resolved.attempts) {
				if (attempt.exit.status === 0) {
					for (const activity of parseBuildActivities(attempt.log)) {
						if (activity.machine === '') {
							completed.add(activity.derivation);
						}
					}
				}
			}
			selected = await outLinkTargets(links);
		}

		const infos = await dependencies.store.queryValidPathsInfo(selected);
		const requestedDerivation = derivationPathOf(installable);
		const targetDerivations = new Set([
			...(requestedDerivation === undefined ? [] : [requestedDerivation]),
			...infos.flatMap((info) =>
				info.deriver === undefined ? [] : [info.deriver]
			)
		]);
		if (
			attempts.some(
				(attempt) =>
					attempt.exit.status === 0 &&
					parseBuildActivities(attempt.log).some(
						(activity) =>
							activity.machine !== '' &&
							targetDerivations.has(activity.derivation)
					)
			)
		) {
			throw new BuildRebuildRemoteDispatchError();
		}
		const requiresCheck =
			selected.length === 0 ||
			infos.length !== selected.length ||
			infos.some(
				(info) =>
					initiallyValid.has(info.storePath) ||
					info.deriver === undefined ||
					!completed.has(info.deriver)
			);
		if (!requiresCheck) {
			continue;
		}
		const checked = await runConstructedBuild(
			{ ...build, installables: [installable], rebuild: true },
			environment,
			runtimeDirectory,
			dependencies
		);
		if (checked.exit.status === 0) {
			if (
				checked.attempts.some(
					(attempt) =>
						attempt.exit.status === 0 &&
						parseBuildActivities(attempt.log).some(
							(activity) =>
								activity.machine !== '' &&
								targetDerivations.has(activity.derivation)
						)
				)
			) {
				throw new BuildRebuildRemoteDispatchError();
			}
			const checkedDerivations = new Set(
				checked.attempts
					.filter((attempt) => attempt.exit.status === 0)
					.flatMap((attempt) =>
						parseBuildActivities(attempt.log)
							.filter((activity) => activity.machine === '')
							.map((activity) => activity.derivation)
					)
			);
			if (
				selected.length === 0 ||
				infos.length !== selected.length ||
				infos.some(
					(info) =>
						!checkedDerivations.has(
							derivationPathOf(installable) ?? info.deriver ?? ''
						)
				)
			) {
				throw new BuildObservationMissingError([installable]);
			}
			const checkedInfos =
				await dependencies.store.queryValidPathsInfo(selected);
			if (
				infos.some((info) =>
					checkedInfos.every(
						(checkedInfo) =>
							checkedInfo.storePath !== info.storePath ||
							checkedInfo.deriver !== info.deriver ||
							checkedInfo.narHash.digestHex() !== info.narHash.digestHex()
					)
				)
			) {
				throw new BuildObservationMissingError([installable]);
			}
			const verifiedAttempts = checked.attempts.map((attempt) => {
				if (attempt.exit.status !== 0) {
					return { ...attempt, verifiedOutputs: [] };
				}

				const activities = parseBuildActivities(attempt.log);
				const verifiedOutputs = checkedInfos.flatMap((info) =>
					info.deriver !== undefined &&
					activities.some(
						(activity) =>
							activity.derivation === info.deriver && activity.machine === ''
					)
						? [
								{
									storePath: info.storePath,
									narHash: info.narHash.digestHex(),
									derivation: info.deriver
								}
							]
						: []
				);

				return { ...attempt, verifiedOutputs };
			});
			appendBuildAttempts(attempts, verifiedAttempts);
			continue;
		}
		appendBuildAttempts(attempts, checked.attempts);
		failure ??= checked.exit;
		if (build.keepGoing !== true || checked.exit.signal !== undefined) {
			break;
		}
	}
	return {
		exit: failure ?? normal.exit,
		attempts,
		preExisting: failure === undefined ? [] : [...initiallyValid]
	};
}

function appendBuildAttempts(
	attempts: BuildExecutionAttempt[],
	additional: readonly BuildExecutionAttempt[]
): void {
	const offset = attempts.length;
	attempts.push(
		...additional.map((attempt) => ({
			...attempt,
			attempt: offset + attempt.attempt
		}))
	);
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
		...(build.rebuild === true ? ['--option', 'builders', ''] : []),
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

async function attributeSubjects(
	invocation: BuildInvocation,
	dependencies: BuildPushDependencies,
	attempts: readonly BuildExecutionAttempt[],
	eventPaths: readonly StorePathString[],
	preExisting: readonly string[],
	canAttributeMultipleOutputs: boolean
): Promise<readonly BuildSubjectV3Input[]> {
	if (invocation.kind !== 'constructed' || eventPaths.length === 0) {
		return [];
	}

	const observed: readonly BuildAttempt[] = attempts
		.filter((attempt) => attempt.exit.status === 0)
		.toReversed()
		.map((attempt) => ({
			attempt: attempt.attempt,
			attemptId: attempt.attemptId,
			activities: parseBuildActivities(attempt.log),
			...(attempt.verifiedOutputs !== undefined && {
				verifiedOutputs: attempt.verifiedOutputs
			})
		}));

	if (observed.length === 0) {
		return [];
	}

	const infos = await dependencies.store.queryValidPathsInfo(eventPaths);

	const attributable = canAttributeMultipleOutputs
		? infos
		: Map.groupBy(infos, (info) => info.deriver)
				.values()
				.filter((outputs) => outputs.length === 1)
				.toArray()
				.flat();

	return receiptSubjects(
		observed,
		attributable,
		new Set(preExisting),
		autoBuildStore
	);
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

	reporter.info(
		buildPushModeDescription({ kind: 'reconciled-local', reason }),
		{
			humanMessage: shouldShowDetails(reporter)
				? buildPushModeDescription({ kind: 'reconciled-local', reason })
				: 'Outputs will be published after the build finishes.'
		}
	);

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
		const {
			exit,
			attempts,
			terminalFailure: dependencyFailure
		} = await reporter.phase(buildPushPhases.build, () =>
			runInvocation(
				invocation,
				dependencies.environment ?? process.env,
				buildDirectory,
				dependencies,
				outLinkDirectory
			)
		);
		const realised = await realisedOutputs(
			outLinkDirectory,
			declared,
			dependencies.store
		);

		const attemptLogs = attempts.map((attempt) => attempt.log);
		const subjects = await attributeSubjects(
			invocation,
			dependencies,
			attempts,
			realised
				.filter((storePath) => declared.includes(storePath))
				.map((storePath) => storePathSchema.parse(storePath)),
			build.rebuild === true && exit.status === 0 ? [] : initiallyValid,
			build.rebuild === true && exit.status === 0
		);
		const terminalFailure =
			dependencyFailure ?? terminalFailureFor(invocation, attempts, exit);
		if (exit.status === 0) {
			requireCompleteProvenance(invocation, realised, subjects);
		}
		const receipt = await publishRealised(
			{
				observedDerivations: new Set(
					attempts.flatMap((attempt) =>
						parseBuildActivities(attempt.log).map(
							(activity) => activity.derivation
						)
					)
				),
				realised,
				subjects,
				copiedFrom: watchedCopySources(attemptLogs),
				exit,
				...(terminalFailure !== undefined && { terminalFailure })
			},
			options,
			reporter,
			dependencies
		);
		try {
			await writeReceiptFile(options.receiptFile, receipt);
		} catch (error) {
			if (exit.status !== 0) {
				throw childFailure(exit);
			}

			throw publicationFailure(error);
		}

		const uploaded = receipt.uploaded?.length ?? 0;
		reportBuildSummary(
			reporter,
			{
				mode: 'reconciled-local',
				store: dependencies.storeDirectory,
				targetPaths: realised.length,
				intermediatePaths: options.intermediatePaths?.length ?? 0,
				queueDepth: 0,
				uploadedPaths: uploaded,
				skipped: Math.max(receipt.paths.length - uploaded, 0),
				childExitStatus: childExitCode(exit),
				unconfirmedPaths: []
			},
			[]
		);

		if (exit.status !== 0) {
			throw childFailure(exit);
		}

		await dependencies.settledTargets?.(
			realised
				.filter(
					(storePath) =>
						!receipt.leftUpstream?.includes(storePathSchema.parse(storePath))
				)
				.map((storePath) => storePathSchema.parse(storePath))
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
		entries.map(async (entry) => {
			const file = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				return outLinkTargets(file);
			}
			return entry.isSymbolicLink() ? [await readlink(file)] : [];
		})
	);

	return orderedUnique(
		targets.flat().flatMap((target) => {
			const parsed = storePathSchema.safeParse(target);

			return parsed.success ? [parsed.data] : [];
		})
	);
}

interface RealisedBuild {
	readonly observedDerivations: ReadonlySet<string>;
	readonly realised: readonly string[];
	readonly subjects: readonly BuildSubjectV3Input[];
	readonly copiedFrom: ReadonlyMap<StorePathString, readonly NixStoreUri[]>;
	readonly exit: ChildExit;
	readonly terminalFailure?: TerminalBuildFailureInput;
}

async function selectRealisedTargets(
	paths: readonly string[],
	subjects: readonly BuildSubjectV3Input[],
	options: BuildPushRunOptions,
	dependencies: BuildPushDependencies,
	observedDerivations: ReadonlySet<string> = new Set()
): ReturnType<typeof selectPublicationPaths> {
	if (
		options.substituter !== 'leave' ||
		(options.invocation.kind === 'constructed' &&
			options.invocation.build.rebuild === true)
	) {
		return {
			published: paths.map((storePath) => storePathSchema.parse(storePath)),
			leftUpstream: []
		};
	}
	const pathInfos = await dependencies.store.queryValidPathsInfo(paths);
	const infos = new Map(pathInfos.map((info) => [info.storePath, info]));
	const byPath = new Map(
		subjects.map((subject) => [subject.storePath, subject])
	);
	return (dependencies.selectPublicationPaths ?? selectPublicationPaths)(
		paths.map((storePath) => {
			const subject = byPath.get(storePathSchema.parse(storePath));
			return {
				storePath,
				origin:
					subject?.origin === 'built' ||
					observedDerivations.has(
						infos.get(storePathSchema.parse(storePath))?.deriver ?? ''
					)
						? 'built'
						: 'store-held',
				...((subject?.derivation ??
					infos.get(storePathSchema.parse(storePath))?.deriver) !==
					undefined && {
					derivation:
						subject?.derivation ??
						infos.get(storePathSchema.parse(storePath))?.deriver
				})
			};
		}),
		{
			substituter:
				options.invocation.kind === 'constructed' &&
				options.invocation.build.rebuild === true
					? 'copy'
					: (options.substituter ?? 'copy'),
			...(options.tenantUrl !== undefined && { tenantUrl: options.tenantUrl }),
			...(dependencies.signal !== undefined && { signal: dependencies.signal })
		}
	);
}

async function clearExcludedRoot(
	selection: PublicationSelection,
	exit: ChildExit,
	options: BuildPushRunOptions,
	dependencies: BuildPushDependencies
) {
	if (
		exit.status !== 0 ||
		options.root === undefined ||
		selection.published.length > 0 ||
		selection.leftUpstream.length === 0
	) {
		return;
	}
	await dependencies.client.setRoot(options.root, {
		targets: [],
		retention: options.retention ?? { kind: 'inherit' }
	});
	return { root: options.root, applied: true, targets: [] };
}

// Publish the reconciled outputs together. A publication failure after a
// successful build uses a classified sysexits code; a failed build preserves
// the child's status.
async function publishRealised(
	built: RealisedBuild,
	options: BuildPushRunOptions,
	reporter: Reporter,
	dependencies: BuildPushDependencies
): Promise<BuildReceiptV3> {
	const { exit } = built;
	const selection = await selectRealisedTargets(
		built.realised,
		built.subjects,
		options,
		dependencies,
		built.observedDerivations
	);
	const publication = PublicationCollection.of({
		targets: [...selection.published],
		...(options.intermediatePaths !== undefined && {
			intermediatePaths: [...options.intermediatePaths]
		})
	});
	const childExitStatus = childExitCode(exit);

	if (publication.entries.length === 0) {
		try {
			await clearExcludedRoot(selection, exit, options, dependencies);
		} catch (error) {
			if (isAbortError(error)) {
				throw error;
			}
			throw publicationFailure(error);
		}
		return buildReceiptV3Schema.parse({
			version: 3,
			paths: [],
			subjects: [],
			...(selection.leftUpstream.length > 0 && {
				leftUpstream: [...selection.leftUpstream]
			}),
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
			command: 'cupboard build-push',
			credential: dependencies.credential,
			client: dependencies.client,
			nix: dependencies.store,
			buildStore: autoBuildStore,
			copiedFrom: built.copiedFrom,
			retain: shouldRetainTargets,
			...(shouldRetainTargets && { root: options.root }),
			...(shouldRetainTargets && {
				retention: options.retention ?? { kind: 'inherit' }
			}),
			...(options.runRoot !== undefined && { runRoot: options.runRoot }),
			...((options.closure !== undefined ||
				options.publicationScope !== undefined) && {
				closure:
					options.publicationScope === 'closure' || options.closure === true
			}),
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

	const builtByPath = new Map(
		built.subjects.map((subject) => [subject.storePath, subject])
	);

	return buildReceiptV3Schema.parse({
		...published,
		...(selection.leftUpstream.length > 0 && {
			leftUpstream: [...selection.leftUpstream]
		}),
		subjects: published.subjects.map((subject) => {
			const evidence = builtByPath.get(subject.storePath);

			return evidence?.narHash === subject.narHash &&
				evidence.derivation === subject.derivation
				? evidence
				: subject;
		}),
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
	readonly observedDerivations: ReadonlySet<string>;
	readonly mode: BuildSummaryInput['mode'];
	readonly exit: ChildExit;
	readonly batcher: BuildOutputBatcher;
	readonly compression: CompressionTotals;
	readonly reportUpload: UploadReporter;
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
		await reporter.phase(
			buildPushPhases.queue,
			(ctx) => {
				ctx.fact('accepted', formatCount(facts.eventPaths.length), {
					humanLabel: 'completed paths observed'
				});
				ctx.fact('queue depth', formatCount(facts.maxQueueDepth), {
					level: 'debug'
				});
			},
			{ humanLabel: 'Publishing completed outputs' }
		);

		await reporter.phase(
			buildPushPhases.upload,
			async (ctx) => {
				await batcher.drain();
				ctx.fact('outcomes', formatCount(batcher.outcomes.size), {
					level: 'debug'
				});
				ctx.fact('remaining', formatCount(batcher.candidates.length), {
					humanLabel: 'paths still waiting'
				});
			},
			{ humanLabel: 'Uploading missing paths' }
		);

		const declaredIntermediates = new Set(options.intermediatePaths);
		const targetPaths =
			facts.selectedTargetPaths ??
			facts.eventPaths.filter(
				(eventPath) => !declaredIntermediates.has(eventPath)
			);
		const selection = await selectRealisedTargets(
			targetPaths,
			facts.subjects,
			options,
			dependencies,
			facts.observedDerivations
		);
		const publishedTargets = selection.published;
		const targetSet = new Set(targetPaths);
		const intermediates = new Set([
			...declaredIntermediates,
			...(options.publicationScope === undefined ||
			options.publicationScope === 'built'
				? facts.eventPaths.filter((eventPath) => !targetSet.has(eventPath))
				: [])
		]);
		const targets: readonly ReconcileTarget[] = publishedTargets.map(
			(targetPath) => ({
				installable: targetPath,
				expectedPath: targetPath,
				...(options.root !== undefined && { root: options.root })
			})
		);
		if (exit.status === 0) {
			requireCompleteProvenance(
				options.invocation,
				targetPaths,
				facts.subjects
			);
		}

		const result = await reporter.phase(
			buildPushPhases.reconcile,
			async (ctx) => {
				const closureIntermediates = await closureExpansion(
					options,
					dependencies,
					publishedTargets
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
					onUploaded: facts.reportUpload,
					copiedFrom: facts.copiedFrom,
					childExitStatus: childExitCode(exit),
					...(facts.terminalFailure !== undefined && {
						terminalFailure: facts.terminalFailure
					})
				});

				ctx.fact('servable', formatCount(reconciled.receipt.paths.length), {
					humanLabel: 'available paths'
				});
				ctx.fact('failed', formatCount(reconciled.receipt.failed?.length ?? 0));

				return reconciled;
			},
			{ humanLabel: 'Checking published outputs' }
		);

		const clearedRoot =
			result.failures.length === 0
				? await clearExcludedRoot(selection, exit, options, dependencies)
				: undefined;
		const settledResult =
			clearedRoot === undefined
				? result
				: { ...result, roots: [...result.roots, clearedRoot] };
		await reporter.phase(
			buildPushPhases.retention,
			(ctx) => {
				const applied = settledResult.roots.filter(
					(root) => root.applied
				).length;

				ctx.fact(
					'roots',
					`${formatCount(applied)}/${formatCount(settledResult.roots.length)} replaced`
				);
			},
			{ humanLabel: 'Updating retention roots' }
		);

		await writeReceiptFile(options.receiptFile, {
			...result.receipt,
			...(selection.leftUpstream.length > 0 && {
				leftUpstream: [...selection.leftUpstream]
			})
		});
		reportSummary(
			reporter,
			dependencies,
			facts,
			targetPaths.length,
			settledResult
		);
		raiseExitContract(exit, result);
		await dependencies.settledTargets?.(publishedTargets);

		return {
			...result.receipt,
			...(selection.leftUpstream.length > 0 && {
				leftUpstream: [...selection.leftUpstream]
			})
		};
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
	if (
		(options.closure !== true && options.publicationScope !== 'closure') ||
		targetPaths.length === 0
	) {
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
	const compressionSummary = facts.compression.summary(
		(dependencies.peakRss ?? processPeakRss)()
	);

	reportBuildSummary(
		reporter,
		{
			mode: facts.mode,
			store: dependencies.storeDirectory,
			targetPaths: targetCount,
			intermediatePaths: facts.eventPaths.length - targetCount,
			queueDepth: facts.maxQueueDepth,
			uploadedPaths: uploaded,
			skipped: Math.max(receipt.paths.length - uploaded, 0),
			childExitStatus: childExitCode(facts.exit),
			unconfirmedPaths: [...(receipt.failed ?? [])],
			...(compressionSummary !== undefined && {
				compression: compressionSummary
			})
		},
		result.failures
	);
}

type UploadReporter = (
	storePath: StorePathString,
	durationMs: number,
	compression: NarCompressionFacts | undefined
) => void;

// Reports one upload at debug level and adds its compression to the run's
// totals.
function uploadReporter(
	reporter: Reporter,
	totals: CompressionTotals
): UploadReporter {
	return (storePath, durationMs, compression) => {
		const name = StorePath.basename(storePath);

		if (compression !== undefined) {
			totals.add(compression);
			reportNarCompression(reporter, name, compression);
		}

		reportUploadDuration(reporter, name, durationMs);
	};
}

const failureRowLabels: Readonly<
	Record<
		TargetFailureReason,
		{ readonly paths: string; readonly cause: string }
	>
> = {
	build: { paths: 'Build failed', cause: 'First build failure' },
	upload: { paths: 'Upload failed', cause: 'First upload failure' },
	verification: {
		paths: 'Verification failed',
		cause: 'First verification failure'
	},
	collected: {
		paths: 'Removed from the local store',
		cause: 'First removal error'
	},
	retention: {
		paths: 'Retention not recorded',
		cause: 'First retention failure'
	}
};

const maxFailedPathsPerReason = 10;

// Lists the failed paths for each reason, in a fixed order, with the cause of
// the first failure. The rows appear without `--debug`, so a failed run shows
// what failed and why.
function failureRows(
	reporter: Reporter,
	failures: readonly ReconcileFailure[]
): readonly ResultRow[] {
	const reasons: readonly TargetFailureReason[] = [
		'build',
		'upload',
		'verification',
		'collected',
		'retention'
	];

	return reasons.flatMap((reason) => {
		const group = failures.filter((failure) => failure.reason === reason);
		const [first] = group;

		if (first === undefined) {
			return [];
		}

		const labels = failureRowLabels[reason];
		const names = group
			.slice(0, maxFailedPathsPerReason)
			.map((failure) => StorePath.basename(failure.storePath));
		const hidden = group.length - names.length;

		return [
			{
				label: labels.paths,
				value:
					hidden > 0
						? `${names.join(', ')} and ${formatCount(hidden)} more`
						: names.join(', ')
			},
			...(first.cause === undefined
				? []
				: [
						{
							label: labels.cause,
							value: formatHumanError(first.cause, {
								debug: reporter.presentation === 'debug'
							})
						}
					])
		];
	});
}

function reportBuildSummary(
	reporter: Reporter,
	summary: BuildSummaryInput,
	failures: readonly ReconcileFailure[]
): void {
	const { compression } = summary;
	const rows: ResultRow[] = [
		{ label: 'Store', value: summary.store },
		{ label: 'Targets', value: formatCount(summary.targetPaths) },
		{ label: 'Uploaded paths', value: formatCount(summary.uploadedPaths) },
		{ label: 'Paths without upload', value: formatCount(summary.skipped) },
		{
			label: 'Build exit status',
			value: formatCount(summary.childExitStatus)
		},
		...(compression === undefined ? [] : compressionRows(compression)),
		...(summary.unconfirmedPaths.length > 0
			? [
					{
						label: 'Availability not confirmed',
						value: formatCount(summary.unconfirmedPaths.length)
					}
				]
			: []),
		...failureRows(reporter, failures)
	];
	const validated = buildSummarySchema.safeParse(summary);

	reporter.result({
		kind: buildSummaryResultKind,
		title: 'Build and publication result',
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
