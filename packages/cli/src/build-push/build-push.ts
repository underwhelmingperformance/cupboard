import { readdir, readlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Nix } from '@cupboard/nix';
import { derivationPathOf } from '@cupboard/nix-store/derivation';
import {
	type RootName,
	type StoreDirectory,
	storePathSchema,
	type StorePathString,
	type TtlSeconds
} from '@cupboard/nix-store/scalars';
import {
	autoBuildStore,
	buildReceiptV3Schema,
	type BuildSubjectV3,
	type InvocationId,
	type ParsedBuildReceiptV3,
	type TerminalBuildFailure
} from '@cupboard/protocol/build';
import {
	type BuildSummary,
	buildSummaryResultKind,
	buildSummarySchema
} from '@cupboard/protocol/reports';
import type { UploadAttachRoot } from '@cupboard/protocol/upload';
import {
	buildPushPhases,
	formatCount,
	type Reporter,
	type ResultRow
} from '@cupboard/reporter';
import { genericExitCode } from '@cupboard/shared/errors';

import { isAbortError } from '../abort.ts';
import type { WaitTimeoutSeconds } from '../duration.ts';
import {
	BuildCommandFailedError,
	BuildProvenanceIncompleteError,
	BuildPublicationFailedError,
	CliAbortError,
	type DaemonRequiredError,
	publicationFailureExitCode,
	PushIncompleteError,
	type UntrustedDaemonError
} from '../errors.ts';
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
	createRuntimeDirectory,
	type InvocationRuntimeOptions,
	planInvocationDirectory,
	removeInvocationRuntimeDirectory
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

/** Maximum attempts a constructed build invocation runs. */
export const defaultBuildAttempts = 3;

/**
 * A nix invocation the run constructs itself: `nix build` over the given
 * installables, wrapped in the bounded attempt loop with per-attempt activity
 * logs, so a transient build failure retries and the receipt attributes each
 * built path to the attempt that produced it.
 */
export interface ConstructedBuild {
	readonly installables: readonly string[];
	/** Maximum build attempts; defaults to {@link defaultBuildAttempts}. */
	readonly attempts?: number;
	/** Execute every selected derivation even when its outputs are already valid. */
	readonly rebuild?: boolean;
	/** Fail unless the receipt claims every selected final output. */
	readonly requireProvenance?: boolean;
	readonly keepGoing?: boolean;
	readonly maxJobs?: number;
}

/**
 * What the run builds: a user-supplied command supervised unchanged, with its
 * own semantics and no attempts added, or a constructed nix invocation run
 * under the attempt loop.
 */
export type BuildInvocation =
	| { readonly kind: 'command'; readonly command: ChildCommand }
	| { readonly kind: 'constructed'; readonly build: ConstructedBuild };

export interface BuildPushRunOptions {
	readonly invocation: BuildInvocation;
	/** The target root reconciliation replaces once every target confirms. */
	readonly root?: RootName;
	readonly ttlSeconds?: TtlSeconds;
	/** The run root every streamed and re-driven commit binds at negotiate. */
	readonly runRoot?: UploadAttachRoot;
	/** Publish the complete realised closure of the built targets. */
	readonly closure?: boolean;
	/** Paths published alongside the targets without being retained as targets. */
	readonly intermediatePaths?: readonly StorePathString[];
	/** Where the build receipt is written, as JSON. */
	readonly receiptFile?: string;
	readonly wait?: boolean;
	readonly waitTimeoutSeconds?: WaitTimeoutSeconds;
	readonly uploadConcurrency?: number;
}

/**
 * The store a run reads through: what reconciliation queries, what the
 * publication reads, and which of a cohort's declared outputs the store
 * already holds.
 */
export type BuildPushStore = ReconcileOptions['store'] &
	PushStore &
	Pick<Nix, 'queryValidPaths' | 'readDerivation'>;

export interface BuildPushDependencies {
	readonly client: PushClient;
	readonly store: BuildPushStore;
	/** The connection-scoped store the streaming batcher pins batches on. */
	readonly batchStore: BatchStore;
	readonly storeDirectory: StoreDirectory;
	readonly invocationId: InvocationId;
	/** Proves the run can work and returns the endpoints it builds on. */
	readonly preflight: () => Promise<BuildPushPreflight>;
	/** Where a run that hosts no hook endpoint keeps its own directory. */
	readonly runtime?: Omit<InvocationRuntimeOptions, 'invocationId'>;
	readonly environment?: ChildEnvironment;
	readonly signalSource?: SignalSource;
	readonly createNarArchive?: (storePath: string) => PushNarArchive;
	readonly compressNar?: CompressNar;
	/** Generates identifiers for a constructed invocation's attempts. */
	readonly nextAttemptId?: () => string;
	/** Starts the cancellable wait between attempts; injectable for tests. */
	readonly startDelay?: StartDelay;
	/** Receives the successfully published targets before this run returns. */
	readonly settledTargets?: (
		targets: readonly StorePathString[]
	) => Promise<void> | void;
}

/**
 * The process exit code a child's ending maps to: its own status, or 128 plus
 * the number of the signal that killed it, which is the shell convention that
 * retry systems branch on.
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
 * Runs one cohort in the mode supported by its machine. A daemon that accepts
 * this client's post-build hook uses streaming publication. Other local stores
 * use a reconciled build followed by one push. The reporter records the mode
 * before the build starts.
 */
export async function runBuildPush(
	options: BuildPushRunOptions,
	reporter: Reporter,
	dependencies: BuildPushDependencies
): Promise<ParsedBuildReceiptV3> {
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

/**
 * Runs a build with streaming publication. The run creates the hook endpoint,
 * supervises the child, consumes hook events, drains uploads, reconciles the
 * results and writes a receipt. Build failures preserve the child's status.
 * Publication and retention failures after a successful build use a classified
 * sysexits code, so callers can distinguish them from build failures.
 */
async function runStreamedBuildPush(
	options: BuildPushRunOptions,
	reporter: Reporter,
	dependencies: BuildPushDependencies,
	preflight: BuildPushPreflight
): Promise<ParsedBuildReceiptV3> {
	const plan = preflight.runtimePlan;
	const targetLinkDirectory = `${plan.directory}-targets`;

	await createRuntimeDirectory(plan.directory);

	if (options.invocation.kind === 'constructed') {
		await createRuntimeDirectory(targetLinkDirectory);
	}

	const hookScriptPath = path.join(plan.directory, hookScriptFileName);

	await writeFile(
		hookScriptPath,
		renderHookScript({
			invocationId: dependencies.invocationId,
			helperPath: preflight.helperPath,
			socketPath: plan.socketPath
		}),
		{ mode: 0o700 }
	);

	let maxQueueDepth = 0;
	const batcher = new BuildOutputBatcher({
		store: dependencies.batchStore,
		client: dependencies.client,
		...(options.runRoot !== undefined && { runRoot: options.runRoot }),
		...(options.waitTimeoutSeconds !== undefined && {
			commitOptions: { timeoutSeconds: options.waitTimeoutSeconds }
		}),
		...(dependencies.createNarArchive !== undefined && {
			createNarArchive: dependencies.createNarArchive
		}),
		...(dependencies.compressNar !== undefined && {
			compressNar: dependencies.compressNar
		})
	});
	const listener = await BuildEventListener.listen({
		socketPath: plan.socketPath,
		storeDirectory: dependencies.storeDirectory,
		onEvent: (event) => {
			for (const outputPath of event.outputPaths) {
				batcher.enqueue(outputPath);
			}

			maxQueueDepth = Math.max(maxQueueDepth, batcher.candidates.length);
		},
		onRejected: (error) => {
			reporter.warn('rejected event', error.name);
		}
	});

	try {
		const environment = environmentWithPostBuildHook(
			dependencies.environment ?? process.env,
			hookScriptPath
		);
		const { exit, attempts } = await reporter.phase(buildPushPhases.build, () =>
			runInvocation(
				options.invocation,
				environment,
				plan,
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

		return await settleRun(options, reporter, dependencies, {
			mode: 'streamed',
			exit,
			batcher,
			maxQueueDepth,
			eventPaths,
			subjects,
			...(selectedTargetPaths !== undefined && { selectedTargetPaths }),
			...(terminalFailure !== undefined && { terminalFailure })
		});
	} finally {
		await listener.close();
		await removeInvocationRuntimeDirectory(targetLinkDirectory);
	}
}

// A user-supplied command runs exactly once, its semantics untouched; a
// constructed invocation runs under the bounded attempt loop with a
// per-attempt activity log.
async function runInvocation(
	invocation: BuildInvocation,
	environment: ChildEnvironment,
	plan: { readonly directory: string },
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
			runtimeDirectory: plan.directory,
			...(dependencies.signalSource !== undefined && {
				signalSource: dependencies.signalSource
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
		runtimeDirectory: plan.directory,
		...(dependencies.signalSource !== undefined && {
			signalSource: dependencies.signalSource
		}),
		...(dependencies.nextAttemptId !== undefined && {
			nextAttemptId: dependencies.nextAttemptId
		}),
		...(dependencies.startDelay !== undefined && {
			startDelay: dependencies.startDelay
		})
	});
}

// One constructed attempt's argv: a plain `nix build` over the installables,
// with the attempt's activity log requested so attribution can read which
// derivation ran where. An out-link is the run's own record of what the build
// realised, and holds those paths while they are published; a run whose hook
// events name the outputs asks for no links at all.
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
		...build.installables
	];
}

// The receipt subjects a constructed build attributes: the built paths
// joined with the attempts' activity logs. A hook event only fires for an
// executed build, so a path that was valid before the run never appears
// here.
async function attributeSubjects(
	invocation: BuildInvocation,
	dependencies: BuildPushDependencies,
	attempts: readonly SupervisedAttempt[],
	eventPaths: readonly StorePathString[]
): Promise<readonly BuildSubjectV3[]> {
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

// A child failure is attributed to a requested target only when the invocation
// was constructed, requested a single installable, exited with a status, and
// recorded at least one build activity. A command, a signal, a grouped
// request, or a failure before any build activity remains a command failure
// for callers to treat as fatal.
function terminalFailureFor(
	invocation: BuildInvocation,
	attempts: readonly SupervisedAttempt[],
	exit: ChildExit
): TerminalBuildFailure | undefined {
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

/**
 * Runs a reconciled local build without a post-build hook, then publishes the
 * realised outputs in one push. The run reads the output metadata from the
 * store and excludes paths that were already valid before the build from its
 * provenance claims. A user-supplied command does not declare outputs that can
 * be reconciled, so this mode rejects it with the original daemon error.
 */
async function runReconciledLocalBuildPush(
	options: BuildPushRunOptions,
	reporter: Reporter,
	dependencies: BuildPushDependencies,
	reason: DaemonRequiredError | UntrustedDaemonError
): Promise<ParsedBuildReceiptV3> {
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

	try {
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
				})
			})
		);
		const realised = await realisedOutputs(
			outLinkDirectory,
			declared,
			dependencies.store
		);

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
	} finally {
		await removeInvocationRuntimeDirectory(directory);
	}
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

// Evidence collected by a reconciled local build and used to construct its
// receipt.
interface RealisedBuild {
	readonly realised: readonly string[];
	readonly declared: readonly string[];
	readonly alreadyHeld: readonly string[];
	/** The builder for each delegated derivation, taken from the activity logs. */
	readonly delegated: ReadonlyMap<string, string>;
	readonly exit: ChildExit;
	readonly terminalFailure?: TerminalBuildFailure;
}

// Publish all reconciled outputs in one push. A publication failure after a
// successful build uses a classified sysexits code; a failed build preserves
// the child's status. An empty result skips the push and leaves the root intact.
async function publishRealised(
	built: RealisedBuild,
	options: BuildPushRunOptions,
	reporter: Reporter,
	dependencies: BuildPushDependencies
): Promise<ParsedBuildReceiptV3> {
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

	let published: ParsedBuildReceiptV3 | undefined;

	try {
		const shouldRetainTargets = exit.status === 0 && options.root !== undefined;

		published = await runPush(publication, reporter, {
			client: dependencies.client,
			nix: dependencies.store,
			buildStore: autoBuildStore,
			alreadyHeld: built.alreadyHeld,
			claimable: built.declared,
			delegated: built.delegated,
			retain: shouldRetainTargets,
			...(shouldRetainTargets && { root: options.root }),
			...(shouldRetainTargets &&
				options.ttlSeconds !== undefined && {
					ttlSeconds: options.ttlSeconds
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

// Creates the publication failure that the run's exit contract requires: the
// sysexits category the cause maps to, and the paths the push reported as
// unfinished.
function publicationFailure(cause: unknown): BuildPublicationFailedError {
	const failedPaths =
		cause instanceof PushIncompleteError ? cause.failedPaths : [];

	return new BuildPublicationFailedError(
		failedPaths,
		publicationFailureExitCode([cause]),
		{ cause }
	);
}

interface RunFacts {
	readonly mode: BuildSummary['mode'];
	readonly exit: ChildExit;
	readonly batcher: BuildOutputBatcher;
	readonly maxQueueDepth: number;
	readonly eventPaths: readonly StorePathString[];
	readonly subjects: readonly BuildSubjectV3[];
	readonly selectedTargetPaths?: readonly StorePathString[];
	readonly terminalFailure?: TerminalBuildFailure;
}

function requireCompleteProvenance(
	invocation: BuildInvocation,
	targetPaths: readonly string[],
	subjects: readonly BuildSubjectV3[]
): void {
	if (
		invocation.kind !== 'constructed' ||
		invocation.build.requireProvenance !== true
	) {
		return;
	}

	const claimed = new Set(subjects.map((subject) => subject.storePath));
	const missing = targetPaths.filter((storePath) => !claimed.has(storePath));

	if (missing.length > 0) {
		throw new BuildProvenanceIncompleteError(missing);
	}
}

// After the child exits, drain uploads, reconcile paths and write the receipt.
// Preserve a failed build's status; classify any later failure as a publication
// failure.
async function settleRun(
	options: BuildPushRunOptions,
	reporter: Reporter,
	dependencies: BuildPushDependencies,
	facts: RunFacts
): Promise<ParsedBuildReceiptV3> {
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
					...(options.ttlSeconds !== undefined && {
						ttlSeconds: options.ttlSeconds
					}),
					...(options.wait !== undefined && { wait: options.wait }),
					...(options.waitTimeoutSeconds !== undefined && {
						commitOptions: { timeoutSeconds: options.waitTimeoutSeconds }
					}),
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

		throw new BuildPublicationFailedError(
			[],
			publicationFailureExitCode([error]),
			{ cause: error }
		);
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

// Writes the run's receipt where the run was asked to leave one.
async function writeReceiptFile(
	receiptFile: string | undefined,
	receipt: ParsedBuildReceiptV3
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

// The run's final summary result, in both modes: the machine payload as the
// schema validates it, and the rows a reader sees.
function reportBuildSummary(reporter: Reporter, summary: BuildSummary): void {
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

	throw new BuildPublicationFailedError(
		result.failures.map((failure) => failure.storePath),
		publicationFailureExitCode(causes)
	);
}

function orderedUnique(
	paths: readonly StorePathString[]
): readonly StorePathString[] {
	return new Set(paths).values().toArray();
}
