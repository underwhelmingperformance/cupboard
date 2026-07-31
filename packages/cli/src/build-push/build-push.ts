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
import type { InvocationId } from '@cupboard/protocol/build';
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
	type SignalSource,
	superviseBuild
} from './supervisor.ts';

export const hookScriptFileName = 'post-build-hook.sh';

export interface BuildPushRunOptions {
	readonly command: ChildCommand;
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

/**
 * Runs the supplied build command under streaming publication and settles the
 * run: preflight, the invocation runtime endpoint and hook script, the child
 * with its composed environment, the batcher consuming hook events while the
 * build runs, then drain, reconciliation, the receipt, and the numeric exit
 * contract. A failed build exits with the child's own status; a successful
 * build with failed publication or retention exits with a classified sysexits
 * code, never a bare 1, so a cache failure can never present as a build
 * failure or vice versa.
 */
export async function runBuildPush(
	options: BuildPushRunOptions,
	reporter: Reporter,
	dependencies: BuildPushDependencies
): Promise<void> {
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
		const exit = await reporter.phase(buildPushPhases.build, () =>
			superviseBuild({
				command: options.command,
				environment,
				runtimeDirectory: plan.directory,
				...(dependencies.signalSource !== undefined && {
					signalSource: dependencies.signalSource
				})
			})
		);
		const accepted = listener.accepted;

		await settleRun(options, reporter, dependencies, {
			exit,
			batcher,
			maxQueueDepth,
			eventPaths: orderedUnique(accepted.flatMap((event) => event.outputPaths))
		});
	} finally {
		await listener.close();
	}
}

interface RunFacts {
	readonly exit: ChildExit;
	readonly batcher: BuildOutputBatcher;
	readonly maxQueueDepth: number;
	readonly eventPaths: readonly StorePathString[];
}

// The phases after the child exits: drain, reconcile, receipt, exit contract.
// Once the build has ended, any loss here is a publication loss, so an escape
// that carries no classified code is re-raised under the publication contract
// and never as a bare 1.
async function settleRun(
	options: BuildPushRunOptions,
	reporter: Reporter,
	dependencies: BuildPushDependencies,
	facts: RunFacts
): Promise<void> {
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
	} catch (error) {
		if (
			isAbortError(error) ||
			error instanceof BuildCommandFailedError ||
			error instanceof BuildPublicationFailedError
		) {
			throw error;
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
		throw new BuildCommandFailedError(
			exit.status,
			exit.signal,
			childExitCode(exit)
		);
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
