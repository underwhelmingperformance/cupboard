import { readFile, writeFile } from 'node:fs/promises';

import {
	isSameCacheScope,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import {
	type BuildReceiptV3,
	buildReceiptV3Schema,
	type BuildReceiptV4,
	buildReceiptV4Schema
} from '@cupboard/protocol/build';
import {
	type CompactPublicationSet,
	publicationSourceSelectorSchema,
	type RecordedPublication,
	recordedPublicationSchema
} from '@cupboard/protocol/publication-manifests';
import {
	publicationWorkflowCaptureInputSchema,
	publicationWorkflowRequestSchema
} from '@cupboard/protocol/publication-workflow';
import {
	buildSummaryResultKind,
	buildSummarySchema,
	buildSummaryV4ResultKind,
	buildSummaryV4Schema
} from '@cupboard/protocol/reports';
import type { Reporter, ResultPayload } from '@cupboard/reporter';
import { z } from 'zod';

import { isAbortError } from '../abort.ts';
import {
	BuildCommandFailedError,
	BuildPublicationFailedError
} from '../errors.ts';
import { classifyPublicationFailures } from '../exit-code.ts';

import type {
	BuildPushDependencies,
	BuildPushRunOptions
} from './build-push.ts';
import { publicationRequests } from './publication-requests.ts';
import {
	ensureSelectedPublication,
	exactSelectedOutputs,
	lookupSelectedPublications,
	publicationMemberFor,
	type PublicationOwnership,
	remainingInvocation,
	selectedPublicationFootprints
} from './publication-sets.ts';
import { publicGitHubRecoveryIdentity } from './recovery-identity.ts';

const selectedOutputSchema = z.strictObject({
	storePath: storePathSchema,
	derivation: storePathSchema.optional(),
	name: z.string().optional()
});
const selectedEntrySchema = z.tuple([z.string(), selectedOutputSchema.array()]);
const recordedSelectionSchema = z.strictObject({
	publication: recordedPublicationSchema,
	sourceSelector: publicationSourceSelectorSchema.optional()
});
const recordedEntrySchema = z.tuple([storePathSchema, recordedSelectionSchema]);
const selectionSnapshotSchema = z.strictObject({
	selected: selectedEntrySchema.array(),
	recorded: recordedEntrySchema.array(),
	supported: z.boolean()
});
const buildSnapshotSchema = z.strictObject({
	receipt: buildReceiptV3Schema,
	targets: storePathSchema.array(),
	captures: publicationWorkflowCaptureInputSchema.array(),
	recorded: recordedEntrySchema.array(),
	supported: z.boolean(),
	summary: buildSummarySchema.optional()
});

/**
Reuses recorded selections and invokes the legacy builder for unresolved
outputs, forced rebuilds and explicit intermediates.
*/
export async function runRecordedBuildPush(
	options: BuildPushRunOptions,
	reporter: Reporter,
	dependencies: BuildPushDependencies,
	build: (
		options: BuildPushRunOptions,
		reporter: Reporter,
		dependencies: BuildPushDependencies
	) => Promise<BuildReceiptV3>
): Promise<BuildReceiptV3 | BuildReceiptV4> {
	const workflow = dependencies.publicationWorkflow;
	if (workflow === undefined) {
		return build(options, reporter, dependencies);
	}
	const {
		receiptFile: _receiptFile,
		publicationRequestsFile: _requestsFile,
		publicationRequestsCompletionFile: _completionFile,
		commandInvocationFingerprint,
		...invocationOptions
	} = options;
	const requestId = await publicationRequests(
		options.receiptFile,
		options.publicationRequestsFile,
		options.publicationRequestsCompletionFile,
		JSON.stringify({
			commandInvocationFingerprint,
			github: publicGitHubRecoveryIdentity(
				dependencies.environment ?? process.env
			),
			options: invocationOptions,
			sources: dependencies.publicationSources ?? [],
			destination: workflow.destination,
			storeDirectory: dependencies.storeDirectory
		}),
		commandInvocationFingerprint
	);
	// Pin the entire destination-first decision before the first materialisation.
	// Recovery must not reselect the destination after a successful promotion.
	const snapshot = await requestId.snapshot(
		'selection',
		selectionSnapshotSchema,
		async () => {
			const selected =
				options.invocation.kind === 'constructed' &&
				(options.invocation.build.rebuild === true ||
					options.invocation.build.requireProvenance === true)
					? new Map()
					: await exactSelectedOutputs(options.invocation, dependencies);
			const recorded = await lookupSelectedPublications(
				selected,
				dependencies.publicationSources ?? [],
				workflow
			);
			return {
				selected: [...selected],
				recorded: recorded === undefined ? [] : [...recorded],
				supported: recorded !== undefined
			};
		}
	);
	const selected = new Map<
		string,
		readonly z.output<typeof selectedOutputSchema>[]
	>(snapshot.selected);
	const recorded = new Map(snapshot.recorded);
	if (!snapshot.supported) {
		return build(options, reporter, dependencies);
	}
	const requestedTargets = new Set<StorePathString>(
		selected
			.values()
			.flatMap((outputs) => outputs.map((output) => output.storePath))
	);
	const remaining =
		options.invocation.kind === 'constructed'
			? remainingInvocation(options.invocation, selected, recorded)
			: options.invocation;
	const settlementInvocation =
		remaining ??
		((options.intermediatePaths?.length ?? 0) > 0
			? options.invocation
			: undefined);
	const publicationSets: CompactPublicationSet[] = [];
	let isRunRootBound = false;
	const bindRunRoot = async () => {
		if (isRunRootBound || options.runRoot === undefined) {
			return;
		}
		// Preparation binds/extends retention without replacing accumulated targets.
		// Negotiated PushClient.negotiate only plans and cannot bind a run root.
		const prepared = await workflow.execute(
			publicationWorkflowRequestSchema.parse({
				operation: 'prepare-run-root',
				input: options.runRoot
			})
		);
		if (prepared.operation !== 'prepare-run-root') {
			throw new Error('Expected a run root preparation response');
		}
		if (!prepared.supported) {
			throw new Error(
				'Recorded publication support changed during run root preparation'
			);
		}
		if (prepared.output.name !== options.runRoot.name) {
			throw new Error('Run root preparation returned a different root name');
		}
		isRunRootBound = true;
	};
	let summary: ResultPayload | undefined;
	let targets: readonly StorePathString[] = [];
	let ownership: PublicationOwnership | undefined;
	const publicationReporter: Reporter = {
		...reporter,
		result(payload) {
			if (payload.kind === buildSummaryResultKind) {
				summary = payload;
				return;
			}
			reporter.result(payload);
		}
	};
	let receipt: BuildReceiptV3 = {
		version: 3,
		paths: [],
		subjects: [],
		childExitStatus: 0
	};
	let isSupported =
		selected.size > 0 && (dependencies.publicationSources?.length ?? 0) > 0;
	const buildState = {
		complete: settlementInvocation === undefined,
		started: false
	};
	const knownRequestedTargets = () => [
		...new Set([...requestedTargets, ...targets])
	];
	// Unknown/floating outputs have no pre-build inventory; retain their legacy
	// count while accounting for every known requested result exactly once.
	const requestedTargetCount = (coldTargetCount: number) =>
		Math.max(
			knownRequestedTargets().length,
			coldTargetCount +
				recorded
					.keys()
					.filter(
						(target) => remaining !== undefined && !targets.includes(target)
					)
					.toArray().length
		);
	const unconfirmedTargets = () =>
		knownRequestedTargets().filter(
			(target) =>
				!receipt.leftUpstream?.includes(target) &&
				publicationSets.every((set) => set.result.storePath !== target)
		);
	try {
		for (const selection of recorded.values()) {
			await bindRunRoot();
			publicationSets.push(
				await ensureSelectedPublication(selection, workflow, options, requestId)
			);
		}
		if (settlementInvocation !== undefined) {
			const cold = await requestId.snapshot(
				'build',
				buildSnapshotSchema,
				async () => {
					// Replace the target root only after the cold snapshot is durable and
					// every first-winner materialisation has completed.
					const { root: _root, ...withoutRoot } = options;
					buildState.started = true;
					receipt = await build(
						{
							...withoutRoot,
							invocation: settlementInvocation
						},
						publicationReporter,
						{
							...dependencies,
							settledTargets: (paths) => {
								targets = paths;
							},
							publicationDependencies: (outputs) => {
								ownership = outputs;
							}
						}
					);
					buildState.complete = true;
					let current = new Map<
						StorePathString,
						z.output<typeof recordedSelectionSchema>
					>();
					if (!isSupported && targets.length > 0) {
						const destination = dependencies.publicationSources?.[0];
						if (destination === undefined) {
							throw new Error(
								'Publication sources must start with the destination'
							);
						}
						const selection = await lookupSelectedPublications(
							new Map(targets.map((storePath) => [storePath, [{ storePath }]])),
							[destination],
							workflow
						);
						isSupported = selection !== undefined;
						current = new Map(selection);
					}
					const captureTargets = targets.filter((target) => {
						if (current.has(target)) {
							return false;
						}
						// A cold alias may accept a result already materialised by the
						// warm ensure. Reuse that set and its immutable source intent,
						// without changing the cold receipt or first-winner membership.
						const result = publicationMemberFor(receipt, target);
						return !(
							receipt.paths.includes(target) &&
							publicationSets.some(
								(set) =>
									set.result.storePath === result.storePath &&
									set.result.narHash === result.narHash
							)
						);
					});
					const footprints =
						!isSupported || captureTargets.length === 0
							? new Map<StorePathString, readonly StorePathString[]>()
							: await selectedPublicationFootprints(
									captureTargets,
									receipt,
									{ ...options, invocation: settlementInvocation },
									dependencies,
									ownership
								);
					const captures: z.output<
						typeof publicationWorkflowCaptureInputSchema
					>[] = [...footprints].map(([target, members]) => {
						const member = publicationMemberFor(receipt, target);
						const warm = publicationSets.find(
							(set) => set.result.storePath === target
						);
						return {
							// A conceded path has no execution subject. Fence its destination
							// lookup to the warm certificate, not the divergent local bytes.
							result:
								warm !== undefined && member.narHash === undefined
									? {
											storePath: target,
											narHash: warm.result.narHash,
											generation: warm.result.generation
										}
									: member,
							members: members.map((member) =>
								publicationMemberFor(receipt, member)
							),
							origin: receipt.subjects.some(
								(subject) =>
									subject.storePath === target && subject.origin === 'built'
							)
								? ('build-selection' as const)
								: ('legacy-selection' as const)
						};
					});
					return {
						receipt,
						targets: [...targets],
						captures,
						recorded: [...current],
						supported: isSupported,
						...(summary !== undefined && {
							summary: buildSummarySchema.parse(summary.data)
						})
					};
				}
			);
			receipt = cold.receipt;
			targets = cold.targets;
			buildState.complete = true;
			isSupported = cold.supported;
			if (summary === undefined && cold.summary !== undefined) {
				summary = {
					kind: buildSummaryResultKind,
					title: 'Build and publication result',
					rows: [],
					data: cold.summary
				};
			}
			for (const [, selection] of cold.recorded) {
				await bindRunRoot();
				publicationSets.push(
					await ensureSelectedPublication(
						selection,
						workflow,
						options,
						requestId
					)
				);
			}
			for (const input of cold.captures) {
				const intent = await requestId.intent(
					{ operation: 'capture', input },
					workflow.destination
				);
				const context = await requestId.captureContext(intent);
				const captured =
					context === undefined
						? await workflow.execute(intent)
						: await workflow.execute(intent, context);
				if (captured.operation !== 'capture') {
					throw new Error('Expected a publication capture response');
				}
				if (!captured.supported) {
					if (isSupported) {
						throw new Error(
							'Recorded publication support changed during capture'
						);
					}
					break;
				}
				isSupported = true;
				const warm = publicationSets.find(
					(set) => set.result.storePath === input.result.storePath
				);
				const selection = recorded.get(input.result.storePath);
				if (
					warm !== undefined &&
					selection !== undefined &&
					receipt.subjects.every(
						(subject) => subject.storePath !== input.result.storePath
					)
				) {
					if (
						input.result.narHash !== warm.result.narHash ||
						input.result.generation !== warm.result.generation ||
						!isSamePublication(captured.output, warm)
					) {
						throw new Error(
							'Accepted publication changed after warm materialisation'
						);
					}
					// Capture proves the current accepted identity, not materialisation.
					// Revalidate with the original source, selector and request ID only.
					const complete = await ensureSelectedPublication(
						selection,
						workflow,
						options,
						requestId
					);
					if (!isSamePublication(complete, warm)) {
						throw new Error(
							'Accepted publication changed after warm materialisation'
						);
					}
					continue;
				}
				await bindRunRoot();
				publicationSets.push(
					await ensureSelectedPublication(
						{ publication: captured.output },
						workflow,
						options,
						requestId
					)
				);
			}
		}
		const allTargets = [...new Set([...recorded.keys(), ...targets])];
		// A successful no-wait build can still have unverified targets.
		const acceptedTargets = new Set(
			isSupported
				? publicationSets.map((set) => set.result.storePath)
				: receipt.paths
		);
		const areAllTargetsAccepted = allTargets.every((target) =>
			acceptedTargets.has(target)
		);
		if (areAllTargetsAccepted) {
			if (options.root !== undefined) {
				await dependencies.client.setRoot(options.root, {
					targets: allTargets,
					retention: options.retention ?? { kind: 'inherit' }
				});
			}
			await dependencies.settledTargets?.(allTargets);
		}
		if (!isSupported) {
			if (summary !== undefined) {
				reporter.result(summary);
			}
			return receipt;
		}
		const result = buildReceiptV4Schema.parse({
			...receipt,
			version: 4,
			publicationSets
		});
		if (options.receiptFile !== undefined) {
			await writeFile(
				options.receiptFile,
				`${JSON.stringify(result, undefined, '\t')}\n`
			);
		}
		const legacySummary =
			summary === undefined
				? {
						mode: 'streamed' as const,
						store: dependencies.storeDirectory,
						targetPaths: targets.length,
						intermediatePaths: 0,
						queueDepth: 0,
						uploadedPaths: 0,
						skipped: 0,
						childExitStatus: 0,
						unconfirmedPaths: []
					}
				: buildSummarySchema.parse(summary.data);
		reporter.result({
			kind: buildSummaryV4ResultKind,
			title: 'Build and publication result',
			data: buildSummaryV4Schema.parse({
				...legacySummary,
				targetPaths: requestedTargetCount(legacySummary.targetPaths),
				version: 4,
				publicationSets
			}),
			rows: summary?.rows ?? []
		});
		return result;
	} catch (error) {
		// A legacy build writes its partial receipt before throwing. Do not replace
		// that evidence or turn a child failure into a publication failure.
		if (summary !== undefined && !buildState.complete) {
			const coldSummary = buildSummarySchema.parse(summary.data);
			const wholeSummary = {
				...coldSummary,
				targetPaths: requestedTargetCount(coldSummary.targetPaths),
				unconfirmedPaths: [
					...new Set([...coldSummary.unconfirmedPaths, ...unconfirmedTargets()])
				]
			};
			if (publicationSets.length === 0) {
				reporter.result({ ...summary, data: wholeSummary });
			} else {
				if (options.receiptFile !== undefined) {
					try {
						const partial = buildReceiptV3Schema.parse(
							JSON.parse(await readFile(options.receiptFile, 'utf8'))
						);
						await writeFile(
							options.receiptFile,
							`${JSON.stringify(buildReceiptV4Schema.parse({ ...partial, version: 4, publicationSets }), undefined, '\t')}\n`
						);
					} catch (recoveryError) {
						reporter.warn(
							'Could not preserve compact publication sets in the partial receipt',
							recoveryError instanceof Error
								? recoveryError.message
								: String(recoveryError)
						);
					}
				}
				reporter.result({
					...summary,
					kind: buildSummaryV4ResultKind,
					data: buildSummaryV4Schema.parse({
						...wholeSummary,
						version: 4,
						publicationSets
					})
				});
			}
		}
		if (isSupported && (buildState.complete || !buildState.started)) {
			const unconfirmed = unconfirmedTargets();
			const coldSummary =
				summary === undefined
					? undefined
					: buildSummarySchema.parse(summary.data);
			const wholeUnconfirmed = [
				...new Set([...(coldSummary?.unconfirmedPaths ?? []), ...unconfirmed])
			];
			const partial = buildReceiptV4Schema.parse({
				...receipt,
				version: 4,
				publicationSets,
				terminalFailure: receipt.terminalFailure ?? { kind: 'command' },
				failed: [...new Set([...(receipt.failed ?? []), ...unconfirmed])]
			});
			if (options.receiptFile !== undefined) {
				await writeFile(
					options.receiptFile,
					`${JSON.stringify(partial, undefined, '\t')}\n`
				);
			}
			reporter.result({
				kind: buildSummaryV4ResultKind,
				title: 'Publication incomplete',
				data: buildSummaryV4Schema.parse({
					...(coldSummary ?? {
						mode: 'streamed',
						store: dependencies.storeDirectory,
						intermediatePaths: 0,
						queueDepth: 0,
						uploadedPaths: 0,
						skipped: 0,
						childExitStatus: 0
					}),
					targetPaths: requestedTargetCount(
						coldSummary?.targetPaths ?? targets.length
					),
					version: 4,
					publicationSets,
					unconfirmedPaths: wholeUnconfirmed
				}),
				rows: []
			});
		}
		if (
			isAbortError(error) ||
			error instanceof BuildPublicationFailedError ||
			error instanceof BuildCommandFailedError
		) {
			throw error;
		}
		const classification = classifyPublicationFailures([error]);
		throw new BuildPublicationFailedError([], classification.exitCode, {
			cause: classification.cause
		});
	}
}

function isSamePublication(
	left: RecordedPublication,
	right: RecordedPublication
): boolean {
	return (
		left.result.storePath === right.result.storePath &&
		left.result.narHash === right.result.narHash &&
		left.result.generation === right.result.generation &&
		isSameCacheScope(left.result.cache, right.result.cache) &&
		left.result.cacheGeneration === right.result.cacheGeneration &&
		left.digest === right.digest &&
		left.memberCount === right.memberCount &&
		left.origin === right.origin
	);
}
