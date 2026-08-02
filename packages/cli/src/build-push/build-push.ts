import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { NixValidPathInfo } from '@cupboard/nix';
import type {
	RootName,
	StoreDirectory,
	StorePathString,
	TtlSeconds
} from '@cupboard/nix-store/scalars';
import type {
	BuildSubject,
	InvocationId,
	ParsedBuildReceipt
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
	BuildPublicationFailedError,
	CliAbortError,
	publicationFailureExitCode
} from '../errors.ts';
import type { CompressNar, PushClient, PushNarArchive } from '../push/push.ts';

import {
	type BuildAttempt,
	derivationsRequiringVerification,
	parseBuildActivities,
	receiptSubjects,
	verifiedAttribution
} from './attribution.ts';
import { type BatchStore, BuildOutputBatcher } from './batching.ts';
import { renderHookScript } from './hook-script.ts';
import { BuildEventListener } from './listener.ts';
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
import { createPlannedRuntimeDirectory } from './runtime-directory.ts';
import {
	type ChildCommand,
	type ChildExit,
	runChild,
	type RunChildOptions,
	type SignalSource,
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
	/**
	 * Locally rebuild remotely built or early-attempt-built derivations once
	 * the build succeeds, refusing the run when a rebuild diverges.
	 */
	readonly verifyRebuilds?: boolean;
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

export interface BuildPushDependencies {
	readonly client: PushClient;
	/** The selected store's queries reconciliation reads. */
	readonly store: ReconcileOptions['store'];
	/** The connection-scoped store the streaming batcher pins batches on. */
	readonly batchStore: BatchStore;
	readonly storeDirectory: StoreDirectory;
	readonly invocationId: InvocationId;
	/** Proves the run can work and returns the endpoints it builds on. */
	readonly preflight: () => Promise<BuildPushPreflight>;
	/** The realised closure of the given paths, for `--closure` expansion. */
	readonly resolveClosure?: (
		paths: readonly StorePathString[]
	) => Promise<readonly NixValidPathInfo[]>;
	readonly environment?: ChildEnvironment;
	readonly signalSource?: SignalSource;
	readonly createNarArchive?: (storePath: string) => PushNarArchive;
	readonly compressNar?: CompressNar;
	/** Names a constructed invocation's attempts; injectable for tests. */
	readonly nextAttemptId?: () => string;
	/** Waits between a constructed invocation's attempts; injectable for tests. */
	readonly sleep?: (delayMs: number) => Promise<void>;
	/** Runs the verification rebuild child; injectable for tests. */
	readonly runChild?: (options: RunChildOptions) => Promise<ChildExit>;
}

/**
 * The process exit code a child's ending maps to: its own status, or 128 plus
 * the number of the signal that killed it, the shell convention retry systems
 * branch on.
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

// The failure a child that did not succeed ends the run with, carrying its own
// status or the signal that killed it. Every site that ends a run on a child
// raises this one, so the numeric contract has a single statement.
function childFailure(exit: ChildExit): BuildCommandFailedError {
	return new BuildCommandFailedError(
		exit.status,
		exit.signal,
		childExitCode(exit)
	);
}

/**
 * Runs the supplied build command under streaming publication and settles the
 * run: preflight, the invocation runtime endpoint and hook script, the child
 * with its composed environment, the batcher consuming hook events while the
 * build runs, then the quiesced hook endpoint, the drained uploads,
 * reconciliation, the receipt, and the numeric exit contract. A failed build
 * exits with the child's own status; a successful build with failed
 * publication or retention exits with a classified sysexits
 * code, never a bare 1, so a cache failure can never present as a build
 * failure or vice versa. A settled run resolves to its reconciled receipt, so
 * a cohort sequence can aggregate the receipts it ran.
 */
export async function runBuildPush(
	options: BuildPushRunOptions,
	reporter: Reporter,
	dependencies: BuildPushDependencies
): Promise<ParsedBuildReceipt> {
	const preflight = await dependencies.preflight();
	const plan = preflight.runtimePlan;

	await createPlannedRuntimeDirectory(plan);

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
			runInvocation(options.invocation, environment, plan, dependencies)
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
		const subjects = await attributeSubjects(
			options.invocation,
			dependencies,
			attempts,
			eventPaths,
			exit
		);

		return await settleRun(options, reporter, dependencies, {
			exit,
			batcher,
			maxQueueDepth,
			eventPaths,
			subjects
		});
	} finally {
		await listener.close();
	}
}

// A user-supplied command runs exactly once, its semantics untouched; a
// constructed invocation runs under the bounded attempt loop with a
// per-attempt activity log.
async function runInvocation(
	invocation: BuildInvocation,
	environment: ChildEnvironment,
	plan: { readonly directory: string },
	dependencies: BuildPushDependencies
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
		command: (logFile) => constructedNixCommand(invocation.build, logFile),
		attempts: invocation.build.attempts ?? defaultBuildAttempts,
		environment,
		runtimeDirectory: plan.directory,
		...(dependencies.signalSource !== undefined && {
			signalSource: dependencies.signalSource
		}),
		...(dependencies.nextAttemptId !== undefined && {
			nextAttemptId: dependencies.nextAttemptId
		}),
		...(dependencies.sleep !== undefined && { sleep: dependencies.sleep })
	});
}

// One constructed attempt's argv: a plain `nix build` over the installables,
// with the attempt's activity log requested so attribution can read which
// derivation ran where.
function constructedNixCommand(
	build: ConstructedBuild,
	logFile: string
): ChildCommand {
	return [
		'nix',
		'build',
		'--no-link',
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

// The local re-verification of derivations the successful attempt did not
// itself build locally: a rebuild with remote builders off, refusing the run
// when the rebuild diverges.
function rebuildVerificationCommand(
	derivations: readonly string[]
): ChildCommand {
	return [
		'nix',
		'build',
		'--rebuild',
		'--no-link',
		'--builders',
		'',
		'--max-jobs',
		'1',
		...derivations.map((derivation) => `${derivation}^*`)
	];
}

// The receipt subjects a successful constructed build attributes: the built
// paths joined with the attempts' activity logs. The verification pass, when
// requested, locally rebuilds what the successful attempt did not build
// locally and attributes the verified derivations to that attempt; without
// it, each path keeps the earliest attempt that built it. A hook event only
// fires for an executed build, so a path that was valid before the run never
// appears here.
async function attributeSubjects(
	invocation: BuildInvocation,
	dependencies: BuildPushDependencies,
	attempts: readonly SupervisedAttempt[],
	eventPaths: readonly StorePathString[],
	exit: ChildExit
): Promise<readonly BuildSubject[]> {
	if (
		invocation.kind !== 'constructed' ||
		exit.status !== 0 ||
		eventPaths.length === 0
	) {
		return [];
	}

	const observed: readonly BuildAttempt[] = attempts.map((attempt) => ({
		attempt: attempt.attempt,
		attemptId: attempt.attemptId,
		activities: parseBuildActivities(attempt.log)
	}));
	const successful = observed.at(-1);

	if (successful === undefined) {
		return [];
	}

	const infos = await dependencies.store.queryValidPathsInfo(eventPaths);

	if (invocation.build.verifyRebuilds !== true) {
		return receiptSubjects(observed, infos, new Set());
	}

	const derivations = derivationsRequiringVerification(
		observed,
		successful.attempt,
		infos
	);

	if (derivations.length > 0) {
		const runVerification = dependencies.runChild ?? runChild;
		const verification = await runVerification({
			command: rebuildVerificationCommand(derivations),
			environment: dependencies.environment ?? process.env,
			...(dependencies.signalSource !== undefined && {
				signalSource: dependencies.signalSource
			})
		});

		if (verification.status !== 0) {
			throw childFailure(verification);
		}
	}

	return receiptSubjects(
		[verifiedAttribution(successful, derivations)],
		infos,
		new Set()
	);
}

interface RunFacts {
	readonly exit: ChildExit;
	readonly batcher: BuildOutputBatcher;
	readonly maxQueueDepth: number;
	readonly eventPaths: readonly StorePathString[];
	readonly subjects: readonly BuildSubject[];
}

// The phases after the child exits: drain, reconcile, receipt, exit contract.
// A failed build ends under its own status; behind a build that succeeded, an
// escape carrying no classified code is a publication loss, re-raised under
// the publication contract and never as a bare 1.
async function settleRun(
	options: BuildPushRunOptions,
	reporter: Reporter,
	dependencies: BuildPushDependencies,
	facts: RunFacts
): Promise<ParsedBuildReceipt> {
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

		const intermediates = new Set(options.intermediatePaths);
		const targetPaths = facts.eventPaths.filter(
			(eventPath) => !intermediates.has(eventPath)
		);
		const targets: readonly ReconcileTarget[] = targetPaths.map(
			(targetPath) => ({
				installable: targetPath,
				expectedPath: targetPath,
				...(options.root !== undefined && { root: options.root })
			})
		);

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
					childExitStatus: childExitCode(exit)
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

		if (options.receiptFile !== undefined) {
			await writeFile(
				options.receiptFile,
				`${JSON.stringify(result.receipt, undefined, '\t')}\n`
			);
		}

		reportSummary(reporter, dependencies, facts, targets.length, result);
		raiseExitContract(exit, result);

		return result.receipt;
	} catch (error) {
		if (
			isAbortError(error) ||
			error instanceof BuildCommandFailedError ||
			error instanceof BuildPublicationFailedError
		) {
			throw error;
		}

		// The sysexits codes classify a publication failure behind a build that
		// succeeded, so a failed build carries its own status out of a failed
		// settlement.
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
	if (
		options.closure !== true ||
		dependencies.resolveClosure === undefined ||
		targetPaths.length === 0
	) {
		return [];
	}

	const targets = new Set(targetPaths);
	const closure = await dependencies.resolveClosure(targetPaths);

	return closure
		.map((info) => info.storePath)
		.filter((storePath) => !targets.has(storePath));
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
	const summary: BuildSummary = {
		store: dependencies.storeDirectory,
		targetPaths: targetCount,
		intermediatePaths: facts.eventPaths.length - targetCount,
		queueDepth: facts.maxQueueDepth,
		uploadedPaths: uploaded,
		skipped: Math.max(receipt.paths.length - uploaded, 0),
		childExitStatus: childExitCode(facts.exit),
		unconfirmedPaths: [...(receipt.failed ?? [])]
	};
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
