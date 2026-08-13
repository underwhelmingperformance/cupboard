import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from 'node:process';

import {
	createProcessNixDaemonConnector,
	type DaemonCommandRunner,
	Nix,
	type NixBuildResult,
	type NixDaemonClientOptions,
	type NixDaemonSession,
	type NixDaemonSetOptions,
	NixDaemonUnavailableError,
	type NixDerivedPathString,
	parseSshNgStoreUri
} from '@cupboard/nix';
import { Derivation } from '@cupboard/nix-store/derivation';
import {
	rootNameSchema,
	type StorePathBasename,
	storePathBasenameSchema,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { byCodeUnit, storePathBasename } from '@cupboard/nix-store/store-path';
import { canonicalHref } from '@cupboard/nix-store/url';
import {
	type BuildReceiptV3,
	buildReceiptV3Schema,
	type ParsedBuildReceiptV3,
	type ParsedTerminalBuildFailure
} from '@cupboard/protocol/build';
import {
	createGithubReporter,
	type Reporter,
	type ReporterResultEvent
} from '@cupboard/reporter';
import type { Command } from 'commander';
import { z } from 'zod';

import {
	type ChildProcessLifecycle,
	observeChildProcess,
	waitForChildProcess
} from '../child-process.ts';
import {
	type CupboardRunDependencies,
	runCupboard as defaultRunCupboard
} from '../cupboard-run.ts';
import {
	CohortPlanCommandError,
	CohortPlanRefusedError,
	CohortPlanResultInvalidError,
	CohortPlanResultMissingError,
	CommandFailedError,
	CupboardReportedError,
	InvalidInputError,
	MissingInputError,
	RemoteCohortBuildFailedError,
	type RemoteCohortBuildFailure,
	RemoteCohortEvaluationDriftError,
	RemoteCohortProtocolError
} from '../errors.ts';
import { type Environment, requireEnvironment, setOutput } from '../inputs.ts';
import {
	isEnabled,
	provided,
	providedCache,
	providedReadUser,
	providedUrl
} from '../options.ts';
import { cacheUrlFor } from '../substituters.ts';

function isNixDerivedPathString(value: unknown): value is NixDerivedPathString {
	if (typeof value !== 'string') {
		return false;
	}

	const selection = value.indexOf('^');
	const storePath = selection === -1 ? value : value.slice(0, selection);

	return storePathSchema.safeParse(storePath).success;
}

/** The canonical spelling of a derived path's unordered named-output set. */
export function canonicalNixDerivedPath(
	value: NixDerivedPathString
): NixDerivedPathString {
	const selection = value.indexOf('^');

	if (selection === -1) {
		return value;
	}

	const outputs = value.slice(selection + 1);

	if (outputs === '*') {
		return value;
	}

	const canonical = [...new Set(outputs.split(','))]
		.toSorted(byCodeUnit)
		.join(',');
	const storePath = storePathSchema.parse(value.slice(0, selection));

	return `${storePath}^${canonical}`;
}

const nixDerivedPathSchema = z
	.custom<NixDerivedPathString>(
		isNixDerivedPathString,
		'Derived path must name a Nix store path, optionally followed by an output selection'
	)
	.transform(canonicalNixDerivedPath);

const maxNixBuildJobs = 4_294_967_295n;

// The shape `cohortMatrix` (in plan.ts) emits for one surviving cohort: every
// array is parallel, indexed the same as `attrs`. `queryInstallables` and
// `expectedPaths` carry `null` for a member whose evaluation is unknown or
// ambiguous, the way a value absent from a JS array survives a JSON round
// trip.
const cohortMatrixEntrySchema = z
	.object({
		key: z.string().min(1),
		attrs: z.array(z.string().min(1)),
		installables: z.array(z.string().min(1)),
		queryInstallables: z.array(nixDerivedPathSchema.nullable()),
		expectedPaths: z.array(storePathSchema.nullable()),
		roots: z.array(rootNameSchema),
		system: z.string().min(1),
		os: z.string().min(1),
		remote: z.boolean(),
		runsOn: z.string().min(1)
	})
	.superRefine((entry, ctx) => {
		const memberFields = [
			'installables',
			'queryInstallables',
			'expectedPaths',
			'roots'
		] as const;

		for (const field of memberFields) {
			if (entry[field].length !== entry.attrs.length) {
				ctx.addIssue({
					code: 'custom',
					path: [field],
					message: `${field} must carry one entry per attr (${String(entry.attrs.length)})`
				});
			}
		}
	});

type CohortMatrixEntry = z.output<typeof cohortMatrixEntrySchema>;

export interface CohortMember {
	readonly attr: string;
	/** The flake-reference form `nix build` resolves directly. */
	readonly installable: string;
	/**
	 * The derivation-store-path form the daemon's availability queries
	 * understand, absent when the member's evaluation is unknown.
	 */
	readonly queryInstallable?: string;
	readonly expectedPath?: string;
	readonly root: string;
}

function membersOf(entry: CohortMatrixEntry): readonly CohortMember[] {
	return entry.attrs.map((attribute, index) => ({
		attr: attribute,
		installable: entry.installables[index] ?? attribute,
		...((entry.queryInstallables[index] ?? undefined) !== undefined && {
			queryInstallable: entry.queryInstallables[index] ?? undefined
		}),
		...((entry.expectedPaths[index] ?? undefined) !== undefined && {
			expectedPath: entry.expectedPaths[index] ?? undefined
		}),
		root: entry.roots[index] ?? ''
	}));
}

const availabilityCeilingSchema = z.object({
	value: z.number(),
	source: z.enum(['configured', 'untrusted-fallback']),
	fallbackReason: z.string().optional()
});

const partitionSchema = z.object({
	attachOnly: z.array(z.string()),
	publishByReference: z.array(z.string()),
	leftUpstream: z.array(z.string()),
	alreadyValid: z.array(z.string()),
	buildSet: z.array(nixDerivedPathSchema),
	counts: z.object({
		willBuild: z.number(),
		willSubstitute: z.number(),
		unknown: z.number()
	}),
	downloadSize: z.number(),
	narSize: z.number(),
	unknownCount: z.number(),
	ceiling: availabilityCeilingSchema
});

type PartitionData = z.output<typeof partitionSchema>;

// One target `cupboard plan reprobe` took out of the build set, in the
// partition's own vocabulary for where it belongs instead. The confirmation
// answers for the destination and the reuse view alone, so those are the two
// buckets a withdrawal can name.
const withdrawnTargetSchema = z.object({
	installable: z.string().min(1),
	storePath: storePathSchema,
	outcome: z.enum(['attachOnly', 'publishByReference'])
});

const planReprobeResultDataSchema = z.object({
	buildSet: z.array(nixDerivedPathSchema),
	withdrawn: z.array(withdrawnTargetSchema)
});

type PlanReprobeResultData = z.output<typeof planReprobeResultDataSchema>;
export type WithdrawnTargetData = z.output<typeof withdrawnTargetSchema>;

const capacityResultSchema = z.object({
	available: z.number(),
	capacity: z.number(),
	headroom: z.number()
});

// A plan against a remote store records this in place of a measured capacity
// result: ssh cannot statfs the remote filesystem.
const capacitySkipSchema = z.object({
	skipped: z.literal('remote-store')
});

const planCohortResultDataSchema = z.object({
	partition: partitionSchema,
	capacity: z.union([capacityResultSchema, capacitySkipSchema])
});

type PlanCohortResultData = z.output<typeof planCohortResultDataSchema>;

const capacityMeasurementSchema = z.object({
	downloadSize: z.number(),
	narSize: z.number(),
	unknownCount: z.number()
});

const detectedCapacityOptionsSchema = z.object({
	cohortSplitPossible: z.boolean(),
	remoteStoreConfigured: z.boolean(),
	componentPublicationApplicable: z.boolean()
});

const unknownPathsCeilingRefusalSchema = z.object({
	reason: z.literal('unknown-paths-ceiling'),
	unknownCount: z.number(),
	ceiling: availabilityCeilingSchema,
	downloadSize: z.number(),
	narSize: z.number()
});

const storeCapacityRefusalSchema = z.object({
	reason: z.literal('store-capacity'),
	measured: capacityMeasurementSchema,
	available: z.number(),
	headroom: z.number(),
	detected: detectedCapacityOptionsSchema
});

const planCohortRefusalDataSchema = z.union([
	unknownPathsCeilingRefusalSchema,
	storeCapacityRefusalSchema
]);

type PlanCohortRefusalData = z.output<typeof planCohortRefusalDataSchema>;

function describeRefusal(refusal: PlanCohortRefusalData): string {
	if (refusal.reason === 'unknown-paths-ceiling') {
		return (
			`${String(refusal.unknownCount)} path(s) have unknown availability, over the ` +
			`${refusal.ceiling.source} ceiling of ${String(refusal.ceiling.value)} ` +
			`(${String(refusal.downloadSize)} download byte(s), ${String(refusal.narSize)} NAR byte(s))`
		);
	}

	return (
		`measured ${String(refusal.measured.narSize)} substitutable NAR byte(s) against ` +
		`${String(refusal.available)} available byte(s) with a ${String(refusal.headroom)} byte headroom`
	);
}

export interface BuildCohortOptions {
	readonly cohortJson?: string;
	readonly url?: string;
	readonly cupboardPath?: string;
	readonly cache?: string;
	readonly reuseView?: string;
	readonly ttl?: string;
	readonly audience?: string;
	readonly readUser?: string;
	readonly readPassword?: string;
	readonly maxJobs?: string;
	readonly store?: string;
	readonly push?: string;
	readonly bestEffort?: string;
	readonly gcBetweenCohorts?: string;
	readonly runRoot?: string;
	readonly runRootTtl?: string;
	readonly receiptFile?: string;
	readonly targetPathsFile?: string;
	readonly intermediatePathsFile?: string;
	readonly referencePathsFile?: string;
	readonly leftUpstreamFile?: string;
	readonly countsFile?: string;
}

export interface BuildCohortInputs {
	readonly cohort: CohortMatrixEntry;
	readonly url: URL;
	readonly cupboardPath: string;
	readonly cache: string;
	readonly reuseView: string;
	readonly ttl: string;
	readonly audience: string;
	readonly readUser: string;
	readonly readPassword: string;
	readonly maxJobs: string;
	readonly store: string;
	readonly push: boolean;
	readonly allBestEffort: boolean;
	readonly gcBetweenCohorts: boolean;
	readonly runRoot: string;
	readonly runRootTtl: string;
	readonly receiptFile: string;
	readonly targetPathsFile: string;
	readonly intermediatePathsFile: string;
	readonly referencePathsFile: string;
	readonly leftUpstreamFile: string;
	readonly countsFile: string;
	// Where a local build's out-links live. They root the targets' reference
	// closures for as long as the directory stands; a remote publication uses
	// daemon temporary roots instead and reports no out-link directory.
	readonly outLinkDirectory: string;
}

export function resolveBuildCohortInputs(
	options: BuildCohortOptions,
	environment: Environment
): BuildCohortInputs {
	const cohortJson = provided(options.cohortJson);

	if (cohortJson === undefined) {
		throw new MissingInputError('cohort-json');
	}

	let parsedJson: unknown;

	try {
		parsedJson = JSON.parse(cohortJson);
	} catch (error) {
		throw new InvalidInputError(
			'cohort-json',
			`cohort-json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
		);
	}

	const cohort = cohortMatrixEntrySchema.safeParse(parsedJson);

	if (!cohort.success) {
		throw new InvalidInputError(
			'cohort-json',
			`cohort-json does not match a cohort-matrix entry:\n${z.prettifyError(cohort.error)}`
		);
	}

	const url = providedUrl('url', options.url);

	if (url === undefined) {
		throw new MissingInputError('url');
	}

	const cupboardPath = provided(options.cupboardPath);

	if (cupboardPath === undefined) {
		throw new MissingInputError('cupboard-path');
	}

	const readUser = providedReadUser(options.readUser);
	const readPassword = options.readPassword ?? '';

	if (readUser !== '' && readPassword === '') {
		throw new InvalidInputError(
			'read-password',
			'read-password is required when read-user is supplied'
		);
	}

	if (readPassword !== '' && readUser === '') {
		throw new InvalidInputError(
			'read-user',
			'read-user is required when read-password is supplied'
		);
	}

	const maxJobs = provided(options.maxJobs) ?? '';

	if (
		maxJobs !== '' &&
		(!/^\d+$/u.test(maxJobs) || BigInt(maxJobs) > maxNixBuildJobs)
	) {
		throw new InvalidInputError(
			'max-jobs',
			'max-jobs must be a non-negative 32-bit integer'
		);
	}

	const runRoot = provided(options.runRoot) ?? '';
	const runRootTtl = provided(options.runRootTtl) ?? '';

	if (runRootTtl !== '' && runRoot === '') {
		throw new InvalidInputError(
			'run-root-ttl',
			'run-root-ttl requires run-root'
		);
	}

	const runnerTemporary = requireEnvironment(environment, 'RUNNER_TEMP');
	const outputPath = (name: string, provided_: string | undefined): string =>
		path.resolve(
			provided_ ?? path.join(runnerTemporary, `cupboard-cohort-${name}`)
		);

	return {
		cohort: cohort.data,
		url,
		cupboardPath,
		cache: provided(options.cache) ?? '',
		reuseView: provided(options.reuseView) ?? '',
		ttl: provided(options.ttl) ?? '',
		audience: provided(options.audience) ?? '',
		readUser,
		readPassword,
		maxJobs,
		store: provided(options.store) ?? '',
		push: isEnabled('push', options.push, false),
		allBestEffort: isEnabled('best-effort', options.bestEffort, false),
		gcBetweenCohorts: isEnabled(
			'gc-between-cohorts',
			options.gcBetweenCohorts,
			false
		),
		runRoot,
		runRootTtl,
		receiptFile: outputPath('receipt.json', options.receiptFile),
		targetPathsFile: outputPath('target-paths.txt', options.targetPathsFile),
		intermediatePathsFile: outputPath(
			'intermediate-paths.txt',
			options.intermediatePathsFile
		),
		referencePathsFile: outputPath(
			'reference-paths.txt',
			options.referencePathsFile
		),
		leftUpstreamFile: outputPath(
			'left-upstream.json',
			options.leftUpstreamFile
		),
		countsFile: outputPath('counts.json', options.countsFile),
		outLinkDirectory: path.join(
			runnerTemporary,
			`cupboard-out-links-${cohort.data.key}`
		)
	};
}

export function registerBuildCohortCommand(
	program: Command,
	environment: Environment = env,
	signal?: AbortSignal
): void {
	program
		.command('build-cohort')
		.description(
			"Build one publish cohort's missing targets and report its partition."
		)
		.requiredOption(
			'--cohort-json <json>',
			"this job's entry from the plan cohort-matrix"
		)
		.requiredOption('--url <url>', 'cupboard Worker URL')
		.requiredOption(
			'--cupboard-path <path>',
			'path to the cupboard binary installed by actions/setup'
		)
		.option('--cache <name>', 'named cache to inspect and publish to')
		.option(
			'--reuse-view <name>',
			'named reuse view to probe for substitutable paths'
		)
		.option(
			'--ttl <ttl>',
			'TTL applied when retaining an already cached target'
		)
		.option('--audience <audience>', 'GitHub OIDC audience (defaults to url)')
		.option('--read-user <user>', 'username for private cache reads')
		.option('--read-password <password>', 'password for private cache reads')
		.option('--max-jobs <count>', 'maximum local build jobs')
		.option(
			'--store <uri>',
			'remote ssh-ng store the plan and the build run against'
		)
		.option(
			'--push <boolean>',
			'publish the cohort: stream the build through cupboard build-push and set the target roots (true or false)',
			'false'
		)
		.option(
			'--gc-between-cohorts <boolean>',
			'collect the local Nix store between build-push cohorts (true or false)',
			'false'
		)
		.option(
			'--best-effort <boolean>',
			'tolerate only settled target build failures (true or false)',
			'false'
		)
		.option(
			'--run-root <name>',
			'run root every published path joins as it commits'
		)
		.option('--run-root-ttl <ttl>', 'expire the run root after this duration')
		.option(
			'--receipt-file <path>',
			'where to write the cupboard build-push receipt'
		)
		.option(
			'--target-paths-file <path>',
			"where to write the cohort's target output paths"
		)
		.option(
			'--intermediate-paths-file <path>',
			"where to write built outputs that are not any target's own output"
		)
		.option(
			'--reference-paths-file <path>',
			'where to write paths the tenant already holds, publishable by reference'
		)
		.option(
			'--left-upstream-file <path>',
			'where to record targets deliberately left upstream'
		)
		.option(
			'--counts-file <path>',
			'where to write the partition counts and capacity result for the receipt'
		)
		.action((options: BuildCohortOptions) =>
			buildCohortAction(options, environment, {
				...(signal !== undefined && { signal })
			})
		);
}

export interface BuildCohortDependencies {
	readonly runCupboard?: typeof defaultRunCupboard;
	readonly runNixBuild?: typeof runNixBuild;
	readonly runNixBuildWithResults?: typeof runNixBuildWithResults;
	readonly runNixCopy?: typeof runNixCopy;
	readonly runNixDerivationShow?: typeof runNixDerivationShow;
	readonly withLocalDerivationRoots?: WithLocalDerivationRoots;
	readonly cupboardRunDependencies?: CupboardRunDependencies;
	readonly reporter?: Reporter;
	readonly signal?: AbortSignal;
}

export async function buildCohortAction(
	options: BuildCohortOptions,
	environment: Environment = env,
	dependencies: BuildCohortDependencies = {}
): Promise<void> {
	dependencies.signal?.throwIfAborted();

	const inputs = resolveBuildCohortInputs(options, environment);
	const members = membersOf(inputs.cohort);
	const queryable = members.filter(
		(member) => member.queryInstallable !== undefined
	);
	const unqueryable = members.filter(
		(member) => member.queryInstallable === undefined
	);

	if (inputs.push && inputs.store !== '' && unqueryable.length > 0) {
		throw new InvalidInputError(
			'cohort-json',
			`Remote publication requires a daemon derived path for every build target; the plan did not resolve ${unqueryable.map((member) => member.attr).join(', ')}. Re-run planning with evaluable locked outputs or publish from the local store.`
		);
	}

	const runCupboard = dependencies.runCupboard ?? defaultRunCupboard;
	const runNix = dependencies.runNixBuild ?? runNixBuild;
	const runNixWithResults =
		dependencies.runNixBuildWithResults ?? runNixBuildWithResults;
	const runCopy = dependencies.runNixCopy ?? runNixCopy;
	const runDerivationShow =
		dependencies.runNixDerivationShow ?? runNixDerivationShow;
	const withLocalDerivationRoots =
		dependencies.withLocalDerivationRoots ?? runWithLocalDerivationRoots;
	const reporter = dependencies.reporter ?? createGithubReporter();
	const cupboardRunDependencies =
		dependencies.signal === undefined
			? dependencies.cupboardRunDependencies
			: {
					...dependencies.cupboardRunDependencies,
					signal: dependencies.signal
				};
	const result =
		queryable.length === 0
			? undefined
			: await planCohort(
					inputs,
					queryable,
					environment,
					runCupboard,
					cupboardRunDependencies
				);

	// The partition settled when the cohort started; the destination and the
	// reuse view are asked once more about the exact outputs still on the build
	// set, so a target something has published in the meantime is withdrawn
	// before Nix is asked to realise it.
	const reprobe =
		result === undefined
			? undefined
			: await reprobeCohort(
					inputs,
					result.partition,
					queryable,
					environment,
					reporter,
					runCupboard,
					cupboardRunDependencies
				);
	const partition =
		result === undefined
			? undefined
			: withdrawFromPartition(result.partition, reprobe?.withdrawn ?? []);

	const buildInstallables = [
		...new Set([
			...(partition?.buildSet ?? []),
			...unqueryable.map((member) => member.installable)
		])
	];
	const remoteTargets = [
		...new Set(
			(partition?.buildSet ?? []).map((target) =>
				canonicalNixDerivedPath(nixDerivedPathSchema.parse(target))
			)
		)
	];
	// Streaming supervision runs through the local daemon's post-build hook.
	// A remote-store cohort instead keeps one daemon connection open from its
	// keyed build results through receipt and root publication.
	const isStreamed =
		inputs.push && inputs.store === '' && buildInstallables.length > 0;

	let streamedFailure:
		| {
				readonly error: CupboardReportedError;
				readonly receipt: ParsedBuildReceiptV3;
		  }
		| undefined;

	if (isStreamed) {
		try {
			await runBuildPushCohort(
				inputs,
				buildInstallables,
				environment,
				runCupboard,
				cupboardRunDependencies
			);
		} catch (error) {
			if (!inputs.allBestEffort) {
				throw error;
			}

			streamedFailure = await settledTargetBuildFailure(
				error,
				inputs.receiptFile
			);

			const terminalFailure = streamedFailure.receipt.terminalFailure;

			if (terminalFailure?.kind === 'target-build') {
				for (const target of terminalFailure.failedTargets) {
					reporter.warn('target build failed', target);
				}
			}
		}
	}

	const context: SettleCohortBuildContext = {
		inputs,
		members,
		partition,
		result,
		reprobe,
		isStreamed,
		environment,
		runCupboard,
		cupboardRunDependencies
	};

	if (inputs.push && inputs.store !== '') {
		if (remoteTargets.length === 0) {
			await settleCohortBuild(context, { built: [] });
			return;
		}

		if (inputs.maxJobs !== '') {
			reporter.warn(
				'remote max-jobs ignored',
				'max-jobs controls local nix build processes only; configure the selected remote store daemon to limit its own build parallelism'
			);
		}

		try {
			const selectedTargets = remoteTargets.map((target) =>
				nixDerivedPathSchema.parse(target)
			);
			const plannedDerivations = selectedTargets.map((target) =>
				derivationPathOf(target)
			);

			await withLocalDerivationRoots(
				plannedDerivations,
				async () => {
					const remoteBindings = await resolveRemoteDerivations(
						members,
						selectedTargets,
						runDerivationShow,
						dependencies.signal
					);

					await runNixWithResults(
						remoteBindings.map((binding) => binding.target),
						inputs.maxJobs,
						inputs.store,
						async (results, failures) => {
							const targetFailures = failures.filter(
								(failure) => failure.kind === 'target'
							);
							const terminalFailure =
								failures.length === 0
									? undefined
									: targetFailures.length === failures.length
										? ({
												kind: 'target-build',
												failedTargets: targetFailures.map(
													(failure) => failure.target
												)
											} as const)
										: ({ kind: 'command' } as const);

							if (inputs.allBestEffort) {
								for (const failure of targetFailures) {
									reporter.warn(
										'remote target build failed',
										`${failure.target}: ${failure.message}`
									);
								}
							}

							await settleCohortBuild(context, {
								built: buildResultOutputPaths(results),
								resultBuilds: results,
								incompleteRoots: incompleteRootsFor(members, failures),
								...(terminalFailure !== undefined && {
									terminalFailure
								})
							});
						},
						dependencies.signal,
						{
							derivations: remoteBindings.map((binding) => binding.derivation),
							copy: () =>
								runCopy(
									remoteBindings.map((binding) => binding.derivation),
									inputs.store,
									dependencies.signal
								)
						}
					);
				},
				dependencies.signal
			);
		} catch (error) {
			if (
				!inputs.allBestEffort ||
				!(error instanceof RemoteCohortBuildFailedError)
			) {
				throw error;
			}
		}
		return;
	}

	// For a streamed cohort the build is already realised, so this invocation
	// resolves the targets' own output paths and pins them with local out-links
	// until the roots are set; for an unstreamed cohort it is the build itself.
	let build: NixBuildCommandResult;

	if (streamedFailure === undefined) {
		build =
			buildInstallables.length === 0
				? { paths: [], status: 0 }
				: await runNix(
						buildInstallables,
						inputs.maxJobs,
						inputs.store,
						inputs.outLinkDirectory,
						dependencies.signal
					);
	} else {
		build = {
			paths: streamedFailure.receipt.paths,
			status: streamedFailure.error.status
		};
	}

	let localOwnership: {
		readonly builds: readonly CohortOwnedBuild[];
		readonly incompleteRoots: ReadonlySet<string>;
	} = { builds: [], incompleteRoots: new Set<string>() };

	if (streamedFailure !== undefined && inputs.push) {
		localOwnership = await resolveStreamedBuildOwners({
			members,
			buildInstallables,
			receipt: streamedFailure.receipt,
			inputs,
			runNix,
			...(dependencies.signal !== undefined && {
				signal: dependencies.signal
			})
		});
		build = {
			...build,
			paths: [
				...new Set(localOwnership.builds.flatMap((owned) => owned.outputs))
			].toSorted((left, right) => left.localeCompare(right))
		};
	} else if (inputs.push) {
		localOwnership = await resolveLocalBuildOwners({
			members,
			buildInstallables,
			builtPaths: build.paths,
			inputs,
			runNix,
			allowIncomplete: inputs.allBestEffort && build.status !== 0,
			...(dependencies.signal !== undefined && {
				signal: dependencies.signal
			})
		});
	}

	await settleCohortBuild(context, {
		built: build.paths,
		localBuilds: localOwnership.builds,
		incompleteRoots: localOwnership.incompleteRoots
	});

	if (build.status !== 0) {
		if (streamedFailure !== undefined) {
			return;
		}

		throw new CommandFailedError('nix build', build.status);
	}
}

async function settledTargetBuildFailure(
	error: unknown,
	receiptFile: string
): Promise<{
	readonly error: CupboardReportedError;
	readonly receipt: ParsedBuildReceiptV3;
}> {
	if (!(error instanceof CupboardReportedError)) {
		throw error;
	}

	let receipt: ParsedBuildReceiptV3;

	try {
		receipt = buildReceiptV3Schema.parse(
			JSON.parse(await readFile(receiptFile, 'utf8'))
		);
	} catch {
		throw error;
	}

	if (
		error.status === null ||
		error.status === 0 ||
		receipt.childExitStatus !== error.status ||
		(receipt.failed?.length ?? 0) > 0 ||
		receipt.terminalFailure?.kind !== 'target-build'
	) {
		throw error;
	}

	return { error, receipt };
}

async function resolveStreamedBuildOwners(options: {
	readonly members: readonly CohortMember[];
	readonly buildInstallables: readonly string[];
	readonly receipt: ParsedBuildReceiptV3;
	readonly inputs: BuildCohortInputs;
	readonly runNix: typeof runNixBuild;
	readonly signal?: AbortSignal;
}): Promise<{
	readonly builds: readonly CohortOwnedBuild[];
	readonly incompleteRoots: ReadonlySet<string>;
}> {
	const failedTargets = new Set(
		options.receipt.terminalFailure?.kind === 'target-build'
			? options.receipt.terminalFailure.failedTargets
			: []
	);
	const survivingInstallables = options.buildInstallables.filter(
		(installable) => !failedTargets.has(installable)
	);
	const ownership = await resolveLocalBuildOwners({
		members: options.members,
		buildInstallables: survivingInstallables,
		builtPaths: options.receipt.paths,
		inputs: options.inputs,
		runNix: options.runNix,
		allowIncomplete: true,
		...(options.signal !== undefined && { signal: options.signal })
	});
	const incompleteRoots = new Set(ownership.incompleteRoots);

	for (const member of options.members) {
		if (
			failedTargets.has(member.installable) ||
			(member.queryInstallable !== undefined &&
				failedTargets.has(member.queryInstallable))
		) {
			incompleteRoots.add(member.root);
		}
	}

	return { builds: ownership.builds, incompleteRoots };
}

async function writeRemoteFailureReceipt(
	receiptFile: string,
	built: readonly string[],
	terminalFailure: ParsedTerminalBuildFailure
): Promise<void> {
	let receipt: BuildReceiptV3;

	if (built.length === 0) {
		receipt = { version: 3, paths: [], subjects: [], terminalFailure };
	} else {
		const settled = buildReceiptV3Schema.parse(
			JSON.parse(await readFile(receiptFile, 'utf8'))
		);
		receipt = { ...settled, terminalFailure };
	}

	await writeFile(receiptFile, `${JSON.stringify(receipt, undefined, 2)}\n`);
}

interface SettleCohortBuildContext {
	readonly inputs: BuildCohortInputs;
	readonly members: readonly CohortMember[];
	readonly partition: PartitionData | undefined;
	readonly result: PlanCohortResultData | undefined;
	readonly reprobe: PlanReprobeResultData | undefined;
	readonly isStreamed: boolean;
	readonly environment: Environment;
	readonly runCupboard: typeof defaultRunCupboard;
	readonly cupboardRunDependencies: CupboardRunDependencies | undefined;
}

// Settles every artifact and publication that reads realised paths. A remote
// caller runs this whole function inside the daemon session holding those
// paths' temporary roots, so both the receipt push and every target-root push
// finish before closing the connection releases them.
async function settleCohortBuild(
	context: SettleCohortBuildContext,
	build: {
		readonly built: readonly string[];
		readonly resultBuilds?: readonly NixBuildResult[];
		readonly localBuilds?: readonly CohortOwnedBuild[];
		readonly incompleteRoots?: ReadonlySet<string>;
		readonly terminalFailure?: ParsedTerminalBuildFailure;
	}
): Promise<void> {
	const {
		inputs,
		members,
		partition,
		result,
		reprobe,
		isStreamed,
		environment,
		runCupboard,
		cupboardRunDependencies
	} = context;
	const {
		built,
		resultBuilds = [],
		localBuilds = [],
		incompleteRoots = new Set<string>(),
		terminalFailure
	} = build;
	const claimable = claimableOutputPaths(resultBuilds);

	// Every path a plain, single-invocation `nix build` prints belongs to one
	// of this cohort's own requested installables: there is nothing else it
	// could have realised. The intermediate-paths file exists so a future
	// increment that derives genuine shared-dependency intermediates from the
	// build log has somewhere to report them without changing this
	// interface; for now it is always empty.
	const targetPaths = [...(partition?.attachOnly ?? []), ...built].toSorted(
		(left, right) => left.localeCompare(right)
	);
	const intermediatePaths: readonly string[] = [];
	const referencePaths = partition?.publishByReference ?? [];
	const leftUpstream = partition?.leftUpstream ?? [];

	await mkdir(path.dirname(inputs.targetPathsFile), { recursive: true });
	await writeFile(inputs.targetPathsFile, linesOf(targetPaths));
	await writeFile(inputs.intermediatePathsFile, linesOf(intermediatePaths));
	await writeFile(inputs.referencePathsFile, linesOf(referencePaths));
	await writeFile(
		inputs.leftUpstreamFile,
		`${JSON.stringify({ leftUpstream }, undefined, 2)}\n`
	);
	await writeFile(
		inputs.countsFile,
		`${JSON.stringify(
			{
				partition:
					partition === undefined ? undefined : partitionCounts(partition),
				capacity: result?.capacity,
				...(reprobe !== undefined && {
					reprobe: { withdrawn: reprobe.withdrawn }
				})
			},
			undefined,
			2
		)}\n`
	);

	// A remote-store cohort has no post-build hook to stream, so its receipt is
	// reconciled from the store the build ran in: one push over exactly the
	// paths the keyed daemon results report publishes them and reads back each
	// one's NAR hash and deriver. Those results also prove which outputs this
	// invocation built; substituted and already-valid results, including a path
	// that appeared after planning, remain unclaimed. The per-root pushes that
	// follow negotiate these paths as already-present skips, exactly as they do
	// behind a streamed build.
	const isReconciled = inputs.push && inputs.store !== '' && built.length > 0;

	if (isReconciled) {
		await runCupboard(
			inputs.cupboardPath,
			cohortReceiptPushArguments(
				inputs,
				built,
				partition?.alreadyValid ?? [],
				claimable
			),
			environment,
			cupboardRunDependencies
		);
	}

	if (terminalFailure !== undefined) {
		await writeRemoteFailureReceipt(inputs.receiptFile, built, terminalFailure);
	}

	if (inputs.push) {
		await publishCohort({
			inputs,
			members,
			paths: { targetPaths, intermediatePaths, referencePaths },
			attachOnlyPaths: partition?.attachOnly ?? [],
			leftUpstreamPaths: leftUpstream,
			environment,
			runCupboard,
			cupboardRunDependencies,
			resultBuilds,
			localBuilds,
			incompleteRoots
		});
	}

	const receiptFile =
		isStreamed || isReconciled || terminalFailure !== undefined
			? inputs.receiptFile
			: '';

	await setOutput(environment, 'target-paths-file', inputs.targetPathsFile);
	await setOutput(
		environment,
		'intermediate-paths-file',
		inputs.intermediatePathsFile
	);
	await setOutput(
		environment,
		'reference-paths-file',
		inputs.referencePathsFile
	);
	await setOutput(environment, 'left-upstream-file', inputs.leftUpstreamFile);
	await setOutput(environment, 'counts-file', inputs.countsFile);
	await setOutput(environment, 'receipt-file', receiptFile);
	await setOutput(
		environment,
		'out-link-directory',
		inputs.store === '' ? inputs.outLinkDirectory : ''
	);
}

/**
 * The cohorts file one supervised `cupboard build-push` run consumes: the
 * whole build set as one constructed nix invocation, so the build keeps
 * cross-target work sharing, with the attempt loop, local re-verification of
 * remotely built derivations, and `--keep-going` the way the fan-out's build
 * supervision ran.
 */
export function buildPushCohortsFile(
	installables: readonly string[],
	maxJobs: string,
	shouldSeparateTargets = false
): { readonly cohorts: readonly Record<string, unknown>[] } {
	const groups = shouldSeparateTargets
		? [...new Set(installables)].map((installable) => [installable])
		: [[...new Set(installables)]];

	return {
		cohorts: groups.map((group) => ({
			installables: group,
			verifyRebuilds: true,
			keepGoing: !shouldSeparateTargets,
			...(maxJobs !== '' && { maxJobs: Number(maxJobs) })
		}))
	};
}

/**
 * The `cupboard build-push` argv for one streamed cohort build. The run
 * publishes without a target root: a root's declared list must also name its
 * attach-only and reference targets, so the roots are set by the per-group
 * pushes once every target path is known.
 */
export function cohortBuildPushArguments(
	inputs: Pick<
		BuildCohortInputs,
		| 'url'
		| 'audience'
		| 'cache'
		| 'gcBetweenCohorts'
		| 'runRoot'
		| 'runRootTtl'
		| 'receiptFile'
		| 'allBestEffort'
	>,
	cohortsFile: string
): readonly string[] {
	const arguments_ = [
		'--no-colour',
		'build-push',
		canonicalHref(inputs.url),
		'--github-oidc',
		'--no-retain',
		'--cohorts-file',
		cohortsFile,
		'--receipt-file',
		inputs.receiptFile,
		'--aggregate-receipt-v3'
	];

	if (inputs.audience !== '') {
		arguments_.push('--audience', inputs.audience);
	}

	if (inputs.cache !== '') {
		arguments_.push('--cache', inputs.cache);
	}

	if (inputs.gcBetweenCohorts) {
		arguments_.push('--gc-between-cohorts');
	}

	if (inputs.allBestEffort) {
		arguments_.push('--keep-going-cohorts');
	}

	if (inputs.runRoot !== '') {
		arguments_.push('--run-root', inputs.runRoot);
	}

	if (inputs.runRootTtl !== '') {
		arguments_.push('--run-root-ttl', inputs.runRootTtl);
	}

	return arguments_;
}

async function runBuildPushCohort(
	inputs: BuildCohortInputs,
	buildInstallables: readonly string[],
	environment: Environment,
	runCupboard: typeof defaultRunCupboard,
	cupboardRunDependencies: CupboardRunDependencies | undefined
): Promise<void> {
	const runnerTemporary = requireEnvironment(environment, 'RUNNER_TEMP');
	const cohortsFile = path.join(
		runnerTemporary,
		`cupboard-build-cohorts-${inputs.cohort.key}.json`
	);

	await writeFile(
		cohortsFile,
		`${JSON.stringify(buildPushCohortsFile(buildInstallables, inputs.maxJobs, inputs.allBestEffort), undefined, 2)}\n`
	);
	await rm(inputs.receiptFile, { force: true });

	await runCupboard(
		inputs.cupboardPath,
		cohortBuildPushArguments(inputs, cohortsFile),
		environment,
		cupboardRunDependencies
	);
}

/**
 * The `cupboard push` argv that publishes a remote-store cohort's result paths
 * and writes its receipt. The paths are published unretained: the per-root
 * pushes that follow declare each root over its full target list, so this one
 * exists to publish what Nix returned and record what the selected store
 * now holds. The keyed daemon results name which resolved outputs this
 * invocation built; substituted and already-valid outputs remain publishable
 * but unclaimed.
 */
export function cohortReceiptPushArguments(
	inputs: Pick<
		BuildCohortInputs,
		| 'url'
		| 'audience'
		| 'cache'
		| 'store'
		| 'runRoot'
		| 'runRootTtl'
		| 'receiptFile'
	>,
	paths: readonly string[],
	alreadyHeld: readonly string[],
	claimable: readonly string[]
): readonly string[] {
	const arguments_ = [
		'--no-colour',
		'push',
		canonicalHref(inputs.url),
		...paths,
		'--github-oidc',
		'--no-retain',
		'--store',
		inputs.store,
		'--receipt-file',
		inputs.receiptFile,
		...(alreadyHeld.length === 0
			? ['--no-already-held']
			: alreadyHeld.flatMap((storePath) => ['--already-held', storePath])),
		...(claimable.length === 0
			? ['--no-claimable']
			: claimable.flatMap((storePath) => ['--claimable', storePath]))
	];

	if (inputs.audience !== '') {
		arguments_.push('--audience', inputs.audience);
	}

	if (inputs.cache !== '') {
		arguments_.push('--cache', inputs.cache);
	}

	if (inputs.runRoot !== '') {
		arguments_.push('--run-root', inputs.runRoot);
	}

	if (inputs.runRootTtl !== '') {
		arguments_.push('--run-root-ttl', inputs.runRootTtl);
	}

	return arguments_;
}

/** One root group's own target paths, from a cohort declaring several roots. */
export interface CohortRootGroup {
	readonly root: string;
	readonly paths: readonly string[];
	readonly referencePaths: readonly string[];
	readonly complete: boolean;
}

interface CohortOwnedBuild {
	readonly installable: string;
	readonly outputs: readonly string[];
}

interface CohortRootGrouping {
	readonly resultBuilds?: readonly NixBuildResult[];
	readonly localBuilds?: readonly CohortOwnedBuild[];
	readonly referencePaths?: readonly string[];
	readonly leftUpstreamPaths?: readonly string[];
	readonly incompleteRoots?: ReadonlySet<string>;
}

/**
 * Groups a cohort's target paths by root. Remote keyed results retain the
 * owning derived path for floating and multi-output targets. Otherwise, an
 * evaluated expected path names its root; only a flat local build path with no
 * known owner joins the first root.
 */
export function rootGroups(
	members: readonly CohortMember[],
	roots: readonly string[],
	targetPaths: readonly string[],
	grouping: CohortRootGrouping = {}
): readonly CohortRootGroup[] {
	const uniqueRoots = [...new Set(roots)];

	if (uniqueRoots.length === 0) {
		return [];
	}

	const rootsByPath = new Map<string, Set<string>>();
	const addOwner = (targetPath: string, root: string): void => {
		const owners = rootsByPath.get(targetPath) ?? new Set<string>();

		owners.add(root);
		rootsByPath.set(targetPath, owners);
	};

	for (const member of members) {
		if (member.expectedPath !== undefined) {
			addOwner(member.expectedPath, member.root);
		}
	}

	const resultBuilds = grouping.resultBuilds ?? [];

	for (const result of resultBuilds) {
		const owners = members.filter(
			(member) =>
				member.queryInstallable !== undefined &&
				nixDerivedPathSchema.parse(member.queryInstallable) ===
					canonicalNixDerivedPath(result.target)
		);

		if (owners.length === 0) {
			throw new InvalidInputError(
				'cohort-json',
				`Remote build result ${result.target} has no cohort owner.`
			);
		}

		if ('outputs' in result.outcome) {
			for (const output of Object.values(result.outcome.outputs)) {
				for (const owner of owners) {
					addOwner(output, owner.root);
				}
			}
		}
	}

	const localBuilds = grouping.localBuilds ?? [];

	for (const build of localBuilds) {
		const owners = members.filter(
			(member) =>
				member.installable === build.installable ||
				(member.queryInstallable !== undefined &&
					nixDerivedPathSchema.parse(member.queryInstallable) ===
						build.installable)
		);

		if (owners.length === 0) {
			throw new InvalidInputError(
				'cohort-json',
				`Local build result ${build.installable} has no cohort owner.`
			);
		}

		for (const output of build.outputs) {
			for (const owner of owners) {
				addOwner(output, owner.root);
			}
		}
	}

	for (const targetPath of targetPaths) {
		if (!rootsByPath.has(targetPath)) {
			throw new InvalidInputError(
				'cohort-json',
				`Cohort target path ${targetPath} has no declared root owner.`
			);
		}
	}

	const referencePaths = new Set(grouping.referencePaths);
	const leftUpstreamRoots = new Set(
		(grouping.leftUpstreamPaths ?? []).flatMap((storePath) => [
			...(rootsByPath.get(storePath) ?? [])
		])
	);

	return uniqueRoots
		.map((root) => ({
			root,
			paths: targetPaths.filter((targetPath) =>
				rootsByPath.get(targetPath)?.has(root)
			),
			referencePaths: targetPaths.filter(
				(targetPath) =>
					referencePaths.has(targetPath) &&
					rootsByPath.get(targetPath)?.has(root) === true
			),
			complete: grouping.incompleteRoots?.has(root) !== true
		}))
		.filter(
			(group) =>
				group.paths.length > 0 ||
				(group.complete && leftUpstreamRoots.has(group.root))
		);
}

interface CohortPushExtras {
	readonly intermediatePathsFile: string;
	readonly referencePathsFile: string;
	readonly referenceSource: string;
}

/**
 * The `cupboard push` argv for one root group: the group's every target path,
 * built and attach-only alike, so the root's all-or-nothing replacement names
 * the full declared list. A streamed cohort's built paths negotiate as
 * already-present skips, so this invocation is the root setting, not a second
 * upload.
 */
export function cohortPushArguments(
	inputs: Pick<
		BuildCohortInputs,
		| 'url'
		| 'audience'
		| 'cache'
		| 'store'
		| 'ttl'
		| 'runRoot'
		| 'runRootTtl'
		| 'readUser'
		| 'readPassword'
	>,
	group: CohortRootGroup,
	extras: CohortPushExtras
): readonly string[] {
	const arguments_ = [
		'--no-colour',
		'push',
		canonicalHref(inputs.url),
		...group.paths,
		'--github-oidc',
		...(group.complete ? ['--root', group.root] : ['--no-retain'])
	];

	if (inputs.audience !== '') {
		arguments_.push('--audience', inputs.audience);
	}

	if (inputs.cache !== '') {
		arguments_.push('--cache', inputs.cache);
	}

	if (inputs.store !== '') {
		arguments_.push('--store', inputs.store);
	}

	if (inputs.ttl !== '' && group.complete) {
		arguments_.push('--ttl', inputs.ttl);
	}

	if (extras.intermediatePathsFile !== '') {
		arguments_.push('--intermediate-paths-file', extras.intermediatePathsFile);
	}

	if (extras.referencePathsFile !== '') {
		arguments_.push(
			'--reference-paths-file',
			extras.referencePathsFile,
			'--reference-source',
			extras.referenceSource
		);

		if (inputs.readUser !== '') {
			arguments_.push(
				'--read-user',
				inputs.readUser,
				'--read-password',
				inputs.readPassword
			);
		}
	}

	if (inputs.runRoot !== '') {
		arguments_.push('--run-root', inputs.runRoot);
	}

	if (inputs.runRootTtl !== '') {
		arguments_.push('--run-root-ttl', inputs.runRootTtl);
	}

	return arguments_;
}

interface PublishCohortOptions {
	readonly inputs: BuildCohortInputs;
	readonly members: readonly CohortMember[];
	readonly paths: {
		readonly targetPaths: readonly string[];
		readonly intermediatePaths: readonly string[];
		readonly referencePaths: readonly string[];
	};
	readonly attachOnlyPaths: readonly string[];
	readonly leftUpstreamPaths: readonly string[];
	readonly environment: Environment;
	readonly runCupboard: typeof defaultRunCupboard;
	readonly cupboardRunDependencies: CupboardRunDependencies | undefined;
	readonly resultBuilds: readonly NixBuildResult[];
	readonly localBuilds: readonly CohortOwnedBuild[];
	readonly incompleteRoots: ReadonlySet<string>;
}

// One push per exact root group. Reference paths travel only with their owning
// root, so an all-reference group remains publishable without broadening any
// other root's retained set.
async function publishCohort(options: PublishCohortOptions): Promise<void> {
	const {
		inputs,
		members,
		paths,
		environment,
		runCupboard,
		cupboardRunDependencies,
		resultBuilds,
		localBuilds,
		leftUpstreamPaths,
		incompleteRoots
	} = options;
	const allTargetPaths = [...paths.targetPaths, ...paths.referencePaths];
	const groups = rootGroups(members, inputs.cohort.roots, allTargetPaths, {
		resultBuilds,
		localBuilds,
		referencePaths: paths.referencePaths,
		leftUpstreamPaths,
		incompleteRoots
	});
	const referenceSource =
		inputs.reuseView === ''
			? ''
			: `${canonicalHref(inputs.url)}/reuse/${inputs.reuseView}`;
	const destinationSource = canonicalHref(
		cacheUrlFor(inputs.url, providedCache(inputs.cache))
	);
	const attachOnly = new Set(options.attachOnlyPaths);
	const hasIntermediates = paths.intermediatePaths.length > 0;

	for (const [index, group] of groups.entries()) {
		const attachOnlyPaths = group.paths.filter((targetPath) =>
			attachOnly.has(targetPath)
		);

		if (attachOnlyPaths.length === 0) {
			const referencePathsFile =
				group.referencePaths.length === 0
					? ''
					: `${inputs.referencePathsFile}.${String(index)}`;

			if (referencePathsFile !== '') {
				if (referenceSource === '') {
					throw new InvalidInputError(
						'reuse-view',
						'publish-by-reference paths require a reuse view'
					);
				}

				await writeFile(referencePathsFile, linesOf(group.referencePaths));
			}

			await runCupboard(
				inputs.cupboardPath,
				cohortPushArguments(inputs, group, {
					intermediatePathsFile:
						index === 0 && hasIntermediates ? inputs.intermediatePathsFile : '',
					referencePathsFile,
					referenceSource: referencePathsFile === '' ? '' : referenceSource
				}),
				environment,
				cupboardRunDependencies
			);
			continue;
		}

		if (group.referencePaths.length > 0) {
			if (referenceSource === '') {
				throw new InvalidInputError(
					'reuse-view',
					'publish-by-reference paths require a reuse view'
				);
			}

			const reusePathsFile = `${inputs.referencePathsFile}.reuse.${String(index)}`;
			await writeFile(reusePathsFile, linesOf(group.referencePaths));
			await runCupboard(
				inputs.cupboardPath,
				cohortPushArguments(
					inputs,
					{ ...group, paths: [], complete: false },
					{
						intermediatePathsFile: '',
						referencePathsFile: reusePathsFile,
						referenceSource
					}
				),
				environment,
				cupboardRunDependencies
			);
		}

		const destinationPaths = group.paths.filter(
			(targetPath) =>
				attachOnly.has(targetPath) || group.referencePaths.includes(targetPath)
		);
		const destinationPathsFile =
			destinationPaths.length === 0
				? ''
				: `${inputs.referencePathsFile}.destination.${String(index)}`;

		if (destinationPathsFile !== '') {
			await writeFile(destinationPathsFile, linesOf(destinationPaths));
		}

		await runCupboard(
			inputs.cupboardPath,
			cohortPushArguments(
				inputs,
				{
					...group,
					paths: group.paths.filter(
						(targetPath) => !destinationPaths.includes(targetPath)
					)
				},
				{
					intermediatePathsFile:
						index === 0 && hasIntermediates ? inputs.intermediatePathsFile : '',
					referencePathsFile: destinationPathsFile,
					referenceSource: destinationPathsFile === '' ? '' : destinationSource
				}
			),
			environment,
			cupboardRunDependencies
		);
	}
}

function partitionCounts(partition: PartitionData): {
	readonly counts: PartitionData['counts'];
	readonly downloadSize: number;
	readonly narSize: number;
	readonly unknownCount: number;
	readonly ceiling: PartitionData['ceiling'];
} {
	return {
		counts: partition.counts,
		downloadSize: partition.downloadSize,
		narSize: partition.narSize,
		unknownCount: partition.unknownCount,
		ceiling: partition.ceiling
	};
}

function linesOf(paths: readonly string[]): string {
	return paths.length === 0 ? '' : `${paths.join('\n')}\n`;
}

/**
 * The partition as the re-probe leaves it: every withdrawn target moves out of
 * the build set and into the bucket the re-probe classified it under, so the
 * target paths, the reference paths and the pushes that set the target roots
 * all read one partition rather than two. The left-upstream list stays the
 * plan's own, since the confirmation behind it runs when the partition settles.
 */
export function withdrawFromPartition(
	partition: PartitionData,
	withdrawn: readonly WithdrawnTargetData[]
): PartitionData {
	if (withdrawn.length === 0) {
		return partition;
	}

	const withdrawnInstallables = new Set(
		withdrawn.map((target) => target.installable)
	);
	const pathsOf = (
		outcome: WithdrawnTargetData['outcome']
	): readonly string[] =>
		withdrawn
			.filter((target) => target.outcome === outcome)
			.map((target) => target.storePath);

	return {
		...partition,
		attachOnly: [...partition.attachOnly, ...pathsOf('attachOnly')],
		publishByReference: [
			...partition.publishByReference,
			...pathsOf('publishByReference')
		],
		buildSet: partition.buildSet.filter(
			(installable) => !withdrawnInstallables.has(installable)
		)
	};
}

// The confirmation `cupboard plan reprobe` answers, asked of the destination
// this cohort publishes to and of the reuse view it may substitute from.
// Best-effort by design: a failed confirmation leaves the partition exactly as
// the plan settled it and names the cause, so the cohort builds its whole
// build set rather than failing on a question it only asked to save work.
async function reprobeCohort(
	inputs: BuildCohortInputs,
	partition: PartitionData,
	queryable: readonly CohortMember[],
	environment: Environment,
	reporter: Reporter,
	runCupboard: typeof defaultRunCupboard,
	cupboardRunDependencies: CupboardRunDependencies | undefined
): Promise<PlanReprobeResultData | undefined> {
	const targets = reprobeTargets(partition, queryable);

	if (targets.length === 0) {
		return undefined;
	}

	const runnerTemporary = requireEnvironment(environment, 'RUNNER_TEMP');
	const targetsFile = path.join(
		runnerTemporary,
		`cupboard-plan-reprobe-targets-${inputs.cohort.key}.json`
	);

	await writeFile(
		targetsFile,
		`${JSON.stringify({ targets }, undefined, 2)}\n`
	);

	let results: readonly ReporterResultEvent[];

	try {
		results = await runCupboard(
			inputs.cupboardPath,
			planReprobeArguments(inputs, targetsFile),
			environment,
			cupboardRunDependencies
		);
	} catch (error) {
		cupboardRunDependencies?.signal?.throwIfAborted();

		reporter.warn(
			"Building the cohort's whole build set: the availability confirmation failed",
			error instanceof Error ? error.message : String(error)
		);

		return undefined;
	}

	return planReprobeResult(results, reporter);
}

/** One build-set member as the confirmation's targets file names it. */
interface ReprobeTargetEntry {
	readonly attr: string;
	readonly installable: string;
	readonly expectedPath: string;
	readonly root: string;
}

// The build-set members the confirmation can answer for: a member with no
// predictable output has nothing to ask about, so it stays on the build set
// without a question.
function reprobeTargets(
	partition: PartitionData,
	queryable: readonly CohortMember[]
): readonly ReprobeTargetEntry[] {
	const entryByInstallable = new Map(
		queryable.flatMap((member): (readonly [string, ReprobeTargetEntry])[] =>
			member.queryInstallable === undefined || member.expectedPath === undefined
				? []
				: [
						[
							member.queryInstallable,
							{
								attr: member.attr,
								installable: member.queryInstallable,
								expectedPath: member.expectedPath,
								root: member.root
							}
						]
					]
		)
	);

	return partition.buildSet.flatMap((installable) => {
		const entry = entryByInstallable.get(installable);

		return entry === undefined ? [] : [entry];
	});
}

/**
 * The `cupboard plan reprobe` argv for one cohort. No token is exchanged and no
 * store is named: the confirmation reconciles no retention root and asks
 * nothing of a store, so it puts its questions to the cache's own read
 * endpoints with this run's read credentials, or with none at all for a public
 * cache.
 */
export function planReprobeArguments(
	inputs: Pick<
		BuildCohortInputs,
		'url' | 'cache' | 'reuseView' | 'readUser' | 'readPassword'
	>,
	targetsFile: string
): readonly string[] {
	const arguments_ = [
		'--no-colour',
		'plan',
		'reprobe',
		canonicalHref(inputs.url),
		'--targets-file',
		targetsFile
	];

	if (inputs.cache !== '') {
		arguments_.push('--cache', inputs.cache);
	}

	if (inputs.reuseView !== '') {
		arguments_.push('--reuse-view', inputs.reuseView);
	}

	if (inputs.readUser !== '') {
		arguments_.push(
			'--read-user',
			inputs.readUser,
			'--read-password',
			inputs.readPassword
		);
	}

	return arguments_;
}

function planReprobeResult(
	results: readonly ReporterResultEvent[],
	reporter: Reporter
): PlanReprobeResultData | undefined {
	for (const event of results) {
		if (event.kind !== 'plan-reprobe') {
			continue;
		}

		const parsed = planReprobeResultDataSchema.safeParse(event.data);

		if (parsed.success) {
			return parsed.data;
		}

		reporter.warn(
			"Building the cohort's whole build set: the availability confirmation reported an unreadable result",
			z.prettifyError(parsed.error)
		);

		return undefined;
	}

	reporter.warn(
		"Building the cohort's whole build set: the availability confirmation reported no result"
	);

	return undefined;
}

async function planCohort(
	inputs: BuildCohortInputs,
	queryable: readonly CohortMember[],
	environment: Environment,
	runCupboard: typeof defaultRunCupboard,
	cupboardRunDependencies: CupboardRunDependencies | undefined
): Promise<PlanCohortResultData> {
	const runnerTemporary = requireEnvironment(environment, 'RUNNER_TEMP');
	const targetsFile = path.join(
		runnerTemporary,
		`cupboard-plan-cohort-targets-${inputs.cohort.key}.json`
	);
	const planFile = path.join(
		runnerTemporary,
		`cupboard-plan-cohort-${inputs.cohort.key}.json`
	);

	await writeFile(
		targetsFile,
		`${JSON.stringify(
			{
				targets: queryable.map((member) => ({
					attr: member.attr,
					installable: member.queryInstallable,
					...(member.expectedPath !== undefined && {
						expectedPath: member.expectedPath
					}),
					root: member.root
				}))
			},
			undefined,
			2
		)}\n`
	);

	const arguments_ = [
		'--no-colour',
		'plan',
		'cohort',
		canonicalHref(inputs.url),
		'--targets-file',
		targetsFile,
		'--plan-file',
		planFile,
		'--github-oidc'
	];

	if (inputs.audience !== '') {
		arguments_.push('--audience', inputs.audience);
	}

	if (inputs.cache !== '') {
		arguments_.push('--cache', inputs.cache);
	}

	if (inputs.reuseView !== '') {
		arguments_.push('--reuse-view', inputs.reuseView);
	}

	if (inputs.ttl !== '') {
		arguments_.push('--ttl', inputs.ttl);
	}

	if (inputs.readUser !== '') {
		arguments_.push(
			'--read-user',
			inputs.readUser,
			'--read-password',
			inputs.readPassword
		);
	}

	if (inputs.store !== '') {
		arguments_.push('--store', inputs.store);
	}

	let results: readonly ReporterResultEvent[];

	try {
		results = await runCupboard(
			inputs.cupboardPath,
			arguments_,
			environment,
			cupboardRunDependencies
		);
	} catch (error) {
		cupboardRunDependencies?.signal?.throwIfAborted();

		if (error instanceof CupboardReportedError) {
			const refusal = refusalFrom(error.results);

			if (refusal !== undefined) {
				throw new CohortPlanRefusedError(
					inputs.cohort.key,
					error.status,
					describeRefusal(refusal)
				);
			}
		}

		throw new CohortPlanCommandError(inputs.cohort.key, {
			cause: error,
			wasReported:
				error instanceof CupboardReportedError ? error.wasReported : false
		});
	}

	return planCohortResult(inputs.cohort.key, results);
}

function refusalFrom(
	results: readonly ReporterResultEvent[]
): PlanCohortRefusalData | undefined {
	for (const event of results) {
		if (event.kind !== 'plan-cohort-refusal') {
			continue;
		}

		const parsed = planCohortRefusalDataSchema.safeParse(event.data);

		if (parsed.success) {
			return parsed.data;
		}
	}

	return undefined;
}

function planCohortResult(
	cohortKey: string,
	results: readonly ReporterResultEvent[]
): PlanCohortResultData {
	for (const event of results) {
		if (event.kind !== 'plan-cohort') {
			continue;
		}

		const parsed = planCohortResultDataSchema.safeParse(event.data);

		if (!parsed.success) {
			throw new CohortPlanResultInvalidError(cohortKey, {
				cause: parsed.error
			});
		}

		return parsed.data;
	}

	throw new CohortPlanResultMissingError(cohortKey);
}

/**
 * Runs `nix build --keep-going` over the given installables. A local build's
 * out-links are kept under a directory this invocation owns, protecting its
 * closure until publication finishes. A remote non-publishing build also
 * receives the argument, but its out-link exists only in the local filesystem
 * and is not treated as a remote GC root. A cohort with one failing
 * derivation still reports whatever `--print-out-paths` prints for the
 * survivors; only a catastrophic failure that printed nothing at all is
 * treated as this command's own failure. A configured remote store owns the
 * build: `--store` sends the results there while `--eval-store auto` keeps
 * evaluation on the runner, so the built closure never enters the runner's
 * local store.
 */
export function nixBuildArguments(
	installables: readonly string[],
	maxJobs: string,
	store: string,
	outLinkDirectory: string
): readonly string[] {
	const arguments_ = [
		'build',
		'--keep-going',
		'--print-out-paths',
		'--out-link',
		path.join(outLinkDirectory, 'result')
	];

	if (maxJobs !== '') {
		arguments_.push('--max-jobs', maxJobs);
	}

	if (store !== '') {
		arguments_.push('--store', store, '--eval-store', 'auto');
	}

	arguments_.push('--', ...installables);

	return arguments_;
}

interface RemoteTargetBinding {
	readonly target: NixDerivedPathString;
	readonly derivation: StorePathString;
	readonly installables: readonly string[];
}

function remoteTargetBindings(
	members: readonly CohortMember[],
	targets: readonly NixDerivedPathString[]
): readonly RemoteTargetBinding[] {
	const uniqueTargets = [
		...new Set(targets.map((target) => canonicalNixDerivedPath(target)))
	];

	return uniqueTargets.map((target) => {
		const matches = members.filter((member) => {
			if (member.queryInstallable === undefined) {
				return false;
			}

			return nixDerivedPathSchema.parse(member.queryInstallable) === target;
		});

		if (matches.length === 0) {
			throw new InvalidInputError(
				'cohort-json',
				`Remote build target ${target} has no matching local installable. Re-run planning so the cohort's evaluated targets remain aligned.`
			);
		}

		return {
			target,
			derivation: derivationPathOf(target),
			installables: [...new Set(matches.map((member) => member.installable))]
		};
	});
}

async function resolveRemoteDerivations(
	members: readonly CohortMember[],
	targets: readonly NixDerivedPathString[],
	runDerivationShow: typeof runNixDerivationShow,
	signal?: AbortSignal
): Promise<readonly RemoteTargetBinding[]> {
	const bindings = remoteTargetBindings(members, targets);

	if (bindings.length === 0) {
		return [];
	}

	const installables = [
		...new Set(bindings.flatMap((binding) => binding.installables))
	];

	// The recursive graph materialises every derivation needed by `nix copy`,
	// while the individual evaluations preserve the one-to-one drift check.
	await runDerivationShow(installables, signal, true);
	const evaluations = [];

	for (const binding of bindings) {
		for (const installable of binding.installables) {
			const evaluated = await runDerivationShow([installable], signal, false);

			evaluations.push({ binding, installable, evaluated });
		}
	}

	const mismatches = evaluations.flatMap(
		({ binding, installable, evaluated }) => {
			const [actual] = evaluated;

			if (
				actual !== undefined &&
				evaluated.length === 1 &&
				isMatchingDerivation(binding.derivation, actual)
			) {
				return [];
			}

			return [
				{
					installable,
					planned: binding.derivation,
					evaluated
				}
			];
		}
	);

	if (mismatches.length > 0) {
		throw new RemoteCohortEvaluationDriftError(mismatches);
	}

	return bindings;
}

function derivationPathOf(target: NixDerivedPathString): StorePathString {
	const selection = target.indexOf('^');
	const storePath = selection === -1 ? target : target.slice(0, selection);

	if (!storePath.endsWith('.drv')) {
		throw new InvalidInputError(
			'cohort-json',
			`Remote build target ${target} does not name a derivation. Re-run planning so every remote target has a daemon derived path.`
		);
	}

	return storePathSchema.parse(storePath);
}

function isMatchingDerivation(
	planned: StorePathString,
	evaluated: StorePathBasename | StorePathString
): boolean {
	if (evaluated === planned) {
		return true;
	}

	return evaluated === storePathBasename(planned);
}

/** Local derivation-graph evaluation argv for the cohort's flake installables. */
export function nixDerivationShowArguments(
	installables: readonly string[],
	isRecursive = true,
	evalStore = 'auto'
): readonly string[] {
	return [
		'derivation',
		'show',
		...(isRecursive ? ['--recursive'] : []),
		'--eval-store',
		evalStore,
		'--no-pretty',
		'--',
		...installables
	];
}

const nixDerivationShowEnvelopeSchema = z.looseObject({
	version: z.literal(4),
	derivations: z.record(z.string(), z.unknown())
});

/** A Nix child whose stdout is captured until the complete process closes. */
export interface CapturedNixProcess extends ChildProcessLifecycle {
	onStdout(listener: (chunk: string) => void): void;
}

/** Process launcher seam shared by captured-output Nix commands. */
export interface CapturedNixProcessDependencies {
	readonly start: (
		arguments_: readonly string[],
		signal: AbortSignal | undefined
	) => CapturedNixProcess;
}

export interface NixDerivationShowDependencies {
	readonly evalStore?: string;
	readonly start?: CapturedNixProcessDependencies['start'];
}

function startCapturedNixProcess(
	arguments_: readonly string[],
	signal: AbortSignal | undefined
): CapturedNixProcess {
	const child = spawn('nix', arguments_, {
		stdio: ['ignore', 'pipe', 'inherit'],
		...(signal !== undefined && { signal })
	});
	const lifecycle = observeChildProcess(child);

	child.stdout.setEncoding('utf8');

	return {
		...lifecycle,
		onStdout(listener) {
			child.stdout.on('data', listener);
		}
	};
}

const defaultCapturedNixProcessDependencies: CapturedNixProcessDependencies = {
	start: startCapturedNixProcess
};

async function runCapturedNixProcess(
	arguments_: readonly string[],
	signal: AbortSignal | undefined,
	dependencies: CapturedNixProcessDependencies
): Promise<{
	readonly signal: NodeJS.Signals | undefined;
	readonly status: number | null;
	readonly stdout: string;
}> {
	const child = dependencies.start(arguments_, signal);
	let stdout = '';

	child.onStdout((chunk) => {
		stdout += chunk;
	});

	const result = await waitForChildProcess(child);

	if (signal?.aborted) {
		throw signal.reason;
	}

	if (result.error !== undefined) {
		throw result.error;
	}

	return { signal: result.signal, status: result.status, stdout };
}

/** Parse derivation paths from the pinned Nix v4 or legacy flat JSON shape. */
export function parseNixDerivationShow(
	stdout: string
): readonly (StorePathBasename | StorePathString)[] {
	let graph: unknown;

	try {
		graph = JSON.parse(stdout);
	} catch (error) {
		throw new CommandFailedError(
			'nix derivation show',
			0,
			'the command returned invalid JSON',
			{ cause: error }
		);
	}

	if (typeof graph !== 'object' || graph === null || Array.isArray(graph)) {
		throw new CommandFailedError(
			'nix derivation show',
			0,
			'the command returned a non-object derivation graph'
		);
	}

	const envelope = nixDerivationShowEnvelopeSchema.safeParse(graph);
	const derivations = envelope.success ? envelope.data.derivations : graph;

	return Object.keys(derivations).map((reported) => {
		const derivation = envelope.success
			? storePathBasenameSchema.safeParse(reported)
			: storePathSchema.safeParse(reported);

		if (!derivation.success || !derivation.data.endsWith('.drv')) {
			throw new CommandFailedError(
				'nix derivation show',
				0,
				`the command reported a non-derivation path: ${reported}`
			);
		}

		return derivation.data;
	});
}

/** Evaluate and materialise a cohort's complete derivation graph locally. */
export async function runNixDerivationShow(
	installables: readonly string[],
	signal?: AbortSignal,
	isRecursive = true,
	dependencies: NixDerivationShowDependencies = {}
): Promise<readonly (StorePathBasename | StorePathString)[]> {
	signal?.throwIfAborted();
	const processDependencies: CapturedNixProcessDependencies = {
		start: dependencies.start ?? defaultCapturedNixProcessDependencies.start
	};

	const {
		signal: terminationSignal,
		status,
		stdout
	} = await runCapturedNixProcess(
		nixDerivationShowArguments(
			installables,
			isRecursive,
			dependencies.evalStore ?? 'auto'
		),
		signal,
		processDependencies
	);

	if (status !== 0) {
		throw new CommandFailedError('nix derivation show', status, undefined, {
			signal: terminationSignal
		});
	}

	return parseNixDerivationShow(stdout);
}

export type WithLocalDerivationRoots = <T>(
	derivations: readonly StorePathString[],
	use: () => Promise<T>,
	signal?: AbortSignal
) => Promise<T>;

type OpenNixForAvailability = (
	options: NixDaemonClientOptions
) => Pick<Nix, 'withConnection'>;

export interface LocalDerivationRootDependencies {
	readonly runDaemon?: DaemonCommandRunner;
	readonly openNix?: OpenNixForAvailability;
}

const localDerivationRootStoreUri =
	'ssh-ng://localhost?remote-program=nix%20daemon&remote-store=local';

const defaultOpenNixForAvailability: OpenNixForAvailability = (options) =>
	Nix.openForAvailability(undefined, options);

function systemDaemonRootStoreOptions(
	signal: AbortSignal | undefined
): NixDaemonClientOptions {
	return {
		storeUri: 'daemon',
		...(signal !== undefined && { signal })
	};
}

function localDerivationRootStoreOptions(
	signal: AbortSignal | undefined,
	dependencies: LocalDerivationRootDependencies
): NixDaemonClientOptions {
	const store = parseSshNgStoreUri(localDerivationRootStoreUri);
	const remoteProgram = store?.remoteProgram;
	const command = remoteProgram?.[0];
	const remoteStore = store?.remoteStore;

	if (
		remoteProgram === undefined ||
		command === undefined ||
		remoteStore === undefined
	) {
		throw new Error('The local derivation-root store is not executable');
	}

	return {
		storeUri: localDerivationRootStoreUri,
		connect: createProcessNixDaemonConnector(
			command,
			[...remoteProgram.slice(1), '--stdio', '--store', remoteStore],
			dependencies.runDaemon
		),
		...(signal !== undefined && { signal })
	};
}

function openLocalDerivationRootStore(
	signal: AbortSignal | undefined,
	dependencies: LocalDerivationRootDependencies
): Pick<Nix, 'withConnection'> {
	const openNix = dependencies.openNix ?? defaultOpenNixForAvailability;

	try {
		return openNix(systemDaemonRootStoreOptions(signal));
	} catch (error) {
		if (!(error instanceof NixDaemonUnavailableError)) {
			throw error;
		}

		return openNix(localDerivationRootStoreOptions(signal, dependencies));
	}
}

/**
 * Keep planned derivations and their materialised closure live during use.
 * A multi-user installation holds them through its system daemon. A
 * single-user installation has no daemon socket, so it falls back to a scoped
 * stdio daemon serving the explicit local store where evaluation materialised
 * them.
 */
export async function runWithLocalDerivationRoots<T>(
	derivations: readonly StorePathString[],
	use: () => Promise<T>,
	signal?: AbortSignal,
	dependencies: LocalDerivationRootDependencies = {}
): Promise<T> {
	signal?.throwIfAborted();
	const nix = openLocalDerivationRootStore(signal, dependencies);

	return nix.withConnection(async (session) => {
		const uniqueDerivations = new Set(derivations);

		for (const derivation of uniqueDerivations) {
			await session.addTempRoot(derivation);
		}

		return use();
	});
}

/**
 * Native Nix copy argv for the complete closure of each locally materialised
 * planned derivation, preserving the selected remote store verbatim.
 */
export function nixCopyArguments(
	derivations: readonly StorePathString[],
	store: string
): readonly string[] {
	return ['copy', '--to', store, '--', ...derivations];
}

/** Process launcher seam for deterministic native-copy lifecycle tests. */
export interface RunNixCopyDependencies {
	readonly start: (
		arguments_: readonly string[],
		signal: AbortSignal | undefined
	) => ChildProcessLifecycle;
}

function startNixCopy(
	arguments_: readonly string[],
	signal: AbortSignal | undefined
): ChildProcessLifecycle {
	const child = spawn('nix', arguments_, {
		stdio: 'inherit',
		...(signal !== undefined && { signal })
	});

	return observeChildProcess(child);
}

const defaultRunNixCopyDependencies: RunNixCopyDependencies = {
	start: startNixCopy
};

/** Copy the locally evaluated derivation closures to the remote build store. */
export async function runNixCopy(
	derivations: readonly StorePathString[],
	store: string,
	signal?: AbortSignal,
	dependencies: RunNixCopyDependencies = defaultRunNixCopyDependencies
): Promise<void> {
	signal?.throwIfAborted();

	const result = await waitForChildProcess(
		dependencies.start(nixCopyArguments(derivations, store), signal)
	);

	if (signal?.aborted) {
		throw signal.reason;
	}

	if (result.error !== undefined) {
		throw result.error;
	}

	if (result.status !== 0) {
		throw new CommandFailedError('nix copy', result.status);
	}
}

/** Daemon settings shared by every queryable target in a remote cohort. */
export function remoteBuildSetOptions(maxJobs: string): NixDaemonSetOptions {
	return maxJobs === '' ? {} : { maxBuildJobs: Number(maxJobs) };
}

/**
 * Builds the queryable targets through one selected remote-store connection,
 * roots every settled output on that connection, and runs publication before
 * closing it. The keyed result is the current invocation's evidence: unlike
 * `--print-out-paths`, it distinguishes a build from substitution and a path
 * that became valid before Nix asked for it.
 */
export async function runNixBuildWithResults(
	installables: readonly NixDerivedPathString[],
	maxJobs: string,
	store: string,
	publish: (
		results: readonly NixBuildResult[],
		failures: readonly RemoteCohortBuildFailure[]
	) => Promise<void>,
	signal?: AbortSignal,
	preparation?: RemoteDerivationPreparation
): Promise<void> {
	const discovered = Nix.openForAvailability(undefined, {
		storeUri: store,
		...(signal !== undefined && { signal })
	});
	const nix =
		maxJobs === '' || discovered.preservesDaemonOptions
			? discovered
			: Nix.openForAvailability(undefined, {
					storeUri: store,
					setOptions: remoteBuildSetOptions(maxJobs),
					...(signal !== undefined && { signal })
				});

	await nix.withConnection((session) =>
		buildAndRootNixResults(session, installables, publish, preparation)
	);
}

/**
 * Work that must share one remote daemon session so copied derivations and
 * realised outputs remain protected until publication has settled.
 */
export interface RemoteDerivationPreparation {
	/** Top-level derivations whose copied closures the session must protect. */
	readonly derivations: readonly StorePathString[];
	/** Copies those derivation closures after their temporary roots exist. */
	copy(): Promise<void>;
}

/** Root every predictable output, then build and publish on the same session. */
export async function buildAndRootNixResults(
	session: Pick<
		NixDaemonSession,
		'addTempRoot' | 'buildPathsWithResults' | 'readDerivation'
	>,
	installables: readonly NixDerivedPathString[],
	publish: (
		results: readonly NixBuildResult[],
		failures: readonly RemoteCohortBuildFailure[]
	) => Promise<void>,
	preparation?: RemoteDerivationPreparation
): Promise<void> {
	if (preparation !== undefined) {
		const derivations = new Set(preparation.derivations);

		for (const derivation of derivations) {
			await session.addTempRoot(derivation);
		}

		await preparation.copy();
	}

	const expectedBuilds = await predictableRemoteBuilds(session, installables);
	const predictableOutputs = new Set(
		expectedBuilds.flatMap((build) => build.outputs.values().toArray())
	);

	for (const output of predictableOutputs
		.values()
		.toArray()
		.toSorted(byCodeUnit)) {
		await session.addTempRoot(output);
	}

	const results: NixBuildResult[] = [];
	const failures: RemoteCohortBuildFailure[] = [];

	for (const build of expectedBuilds) {
		const returned = await session.buildPathsWithResults([build.installable]);
		const reconciliation = reconcileBuildResults([build], returned);

		for (const output of reconciliation.outputs) {
			await session.addTempRoot(output);
		}

		results.push(...reconciliation.results);
		failures.push(...reconciliation.failures);
	}

	await publish(results, failures);

	if (failures.length > 0) {
		const protocolFailures = failures.filter(
			(failure) => failure.kind === 'protocol'
		);

		if (protocolFailures.length > 0) {
			throw new RemoteCohortProtocolError(protocolFailures);
		}

		throw new RemoteCohortBuildFailedError(failures);
	}
}

interface ExpectedRemoteBuild {
	readonly installable: NixDerivedPathString;
	readonly target: NixDerivedPathString;
	readonly outputs: ReadonlyMap<string, StorePathString>;
}

async function predictableRemoteBuilds(
	session: Pick<NixDaemonSession, 'readDerivation'>,
	installables: readonly NixDerivedPathString[]
): Promise<readonly ExpectedRemoteBuild[]> {
	const builds: ExpectedRemoteBuild[] = [];

	for (const installable of installables) {
		const derivationPath = derivationPathOf(installable);
		const derivation = Derivation.parse(
			await session.readDerivation(derivationPath)
		);
		const selection = installable.split('^', 2)[1];
		const selected =
			selection === undefined || selection === '*'
				? new Set(derivation.outputs.keys())
				: new Set(selection.split(','));
		const outputs = new Map<string, StorePathString>();

		for (const outputName of selected) {
			if (!derivation.outputs.has(outputName)) {
				throw new InvalidInputError(
					'cohort-json',
					`Remote build target ${installable} selects output '${outputName}', which its derivation does not declare.`
				);
			}

			const output = derivation.outputs.get(outputName);

			if (output === undefined) {
				throw new InvalidInputError(
					'cohort-json',
					`Remote build target ${installable} selects output '${outputName}', whose content-addressed path is not known before the build. Publish it from a local store until remote builds can root floating outputs atomically.`
				);
			}

			outputs.set(outputName, output);
		}

		builds.push({
			installable,
			target: canonicalNixDerivedPath(installable),
			outputs
		});
	}

	return builds;
}

interface ReconciledBuildResults {
	readonly results: readonly NixBuildResult[];
	readonly outputs: readonly StorePathString[];
	readonly failures: readonly RemoteCohortBuildFailure[];
}

function incompleteRootsFor(
	members: readonly CohortMember[],
	failures: readonly RemoteCohortBuildFailure[]
): ReadonlySet<string> {
	const failedTargets = new Set(
		failures.map((failure) =>
			canonicalNixDerivedPath(nixDerivedPathSchema.parse(failure.target))
		)
	);

	return new Set(
		members.flatMap((member) => {
			if (member.queryInstallable === undefined) {
				return [];
			}

			return failedTargets.has(
				nixDerivedPathSchema.parse(member.queryInstallable)
			)
				? [member.root]
				: [];
		})
	);
}

function reconcileBuildResults(
	expectedBuilds: readonly ExpectedRemoteBuild[],
	results: readonly NixBuildResult[]
): ReconciledBuildResults {
	const canonicalInstallables = expectedBuilds.map((build) => build.target);
	const expectedOutputsByTarget = new Map(
		expectedBuilds.map((build) => [build.target, build.outputs])
	);
	const requested = new Set(canonicalInstallables);
	const resultsByTarget = new Map<NixDerivedPathString, NixBuildResult[]>();

	for (const result of results) {
		const target = canonicalNixDerivedPath(result.target);
		const targetResults = resultsByTarget.get(target) ?? [];

		targetResults.push(result);
		resultsByTarget.set(target, targetResults);
	}

	const survivors: NixBuildResult[] = [];
	const failures: RemoteCohortBuildFailure[] = [];

	for (const target of canonicalInstallables) {
		const targetResults = resultsByTarget.get(target) ?? [];

		if (targetResults.length === 0) {
			failures.push({
				target,
				kind: 'protocol',
				outcome: 'no-result',
				message: 'the daemon returned no result for this target'
			});
			continue;
		}

		resultsByTarget.delete(target);

		if (targetResults.length > 1) {
			failures.push({
				target,
				kind: 'protocol',
				outcome: 'duplicate-results',
				message: `the daemon returned ${String(targetResults.length)} results for this target`
			});
			continue;
		}

		const [result] = targetResults;

		if (result === undefined) {
			continue;
		}

		if (
			'outputs' in result.outcome &&
			Object.values(result.outcome.outputs).length > 0
		) {
			const expectedOutputs = expectedOutputsByTarget.get(target);

			if (
				expectedOutputs === undefined ||
				!hasMatchingRemoteOutputs(result.outcome.outputs, expectedOutputs)
			) {
				failures.push({
					target,
					kind: 'protocol',
					outcome: 'invalid-outputs',
					message: `the daemon reported ${formatRemoteOutputEntries(Object.entries(result.outcome.outputs))}; expected ${formatRemoteOutputEntries(expectedOutputs?.entries().toArray() ?? [])}`
				});
				continue;
			}

			survivors.push(result);
			continue;
		}

		failures.push({
			target,
			kind: 'target',
			outcome: result.outcome.kind,
			message:
				'message' in result.outcome
					? result.outcome.message
					: 'the daemon reported no outputs for this settled target'
		});
	}

	for (const [target, unexpected] of resultsByTarget) {
		if (requested.has(target)) {
			continue;
		}

		failures.push({
			target,
			kind: 'protocol',
			outcome: 'unexpected-result',
			message: 'the daemon returned a result for an unrequested target'
		});

		if (unexpected.length > 1) {
			failures.push({
				target,
				kind: 'protocol',
				outcome: 'duplicate-results',
				message: `the daemon returned ${String(unexpected.length)} results for this target`
			});
		}
	}

	return {
		results: survivors,
		outputs: buildResultOutputPaths(survivors),
		failures
	};
}

function hasMatchingRemoteOutputs(
	actual: Readonly<Record<string, StorePathString>>,
	expected: ReadonlyMap<string, StorePathString>
): boolean {
	const entries = Object.entries(actual);

	return (
		entries.length === expected.size &&
		entries.every(([name, output]) => expected.get(name) === output)
	);
}

function formatRemoteOutputEntries(
	entries: readonly (readonly [string, StorePathString])[]
): string {
	return entries
		.toSorted(([left], [right]) => byCodeUnit(left, right))
		.map(([name, output]) => `${name}=${output}`)
		.join(', ');
}

/** Every settled output path the keyed results report, once and sorted. */
export function buildResultOutputPaths(
	results: readonly NixBuildResult[]
): readonly StorePathString[] {
	return [
		...new Set(
			results.flatMap((result) =>
				'outputs' in result.outcome ? Object.values(result.outcome.outputs) : []
			)
		)
	].toSorted((left, right) => left.localeCompare(right));
}

export interface NixBuildCommandResult {
	readonly paths: readonly string[];
	readonly status: number | null;
}

async function resolveLocalBuildOwners(options: {
	readonly members: readonly CohortMember[];
	readonly buildInstallables: readonly string[];
	readonly builtPaths: readonly string[];
	readonly inputs: BuildCohortInputs;
	readonly runNix: typeof runNixBuild;
	readonly signal?: AbortSignal;
	readonly allowIncomplete: boolean;
}): Promise<{
	readonly builds: readonly CohortOwnedBuild[];
	readonly incompleteRoots: ReadonlySet<string>;
}> {
	const requested = new Set(options.buildInstallables);
	const built = new Set(options.builtPaths);
	const owners: CohortOwnedBuild[] = [];
	const incompleteRoots = new Set<string>();
	let unknownIndex = 0;

	for (const member of options.members) {
		const queryInstallable =
			member.queryInstallable === undefined
				? undefined
				: nixDerivedPathSchema.parse(member.queryInstallable);
		const wasRequested =
			requested.has(member.installable) ||
			(queryInstallable !== undefined && requested.has(queryInstallable));

		if (!wasRequested) {
			continue;
		}

		const selection = queryInstallable?.split('^', 2)[1];

		if (
			selection !== '*' &&
			selection?.includes(',') !== true &&
			member.expectedPath !== undefined
		) {
			if (!built.has(member.expectedPath)) {
				if (options.allowIncomplete) {
					incompleteRoots.add(member.root);
					continue;
				}

				throw new InvalidInputError(
					'cohort-json',
					`Local build result for ${member.installable} omitted its expected path ${member.expectedPath}.`
				);
			}

			owners.push({
				installable: member.installable,
				outputs: [member.expectedPath]
			});
			continue;
		}

		const result = await options.runNix(
			[member.installable],
			options.inputs.maxJobs,
			options.inputs.store,
			path.join(
				options.inputs.outLinkDirectory,
				'owners',
				String(unknownIndex)
			),
			options.signal
		);
		unknownIndex += 1;

		if (result.status !== 0) {
			if (options.allowIncomplete) {
				incompleteRoots.add(member.root);
				continue;
			}

			throw new CommandFailedError('nix build', result.status);
		}

		const outputs = result.paths.filter((output) => built.has(output));

		if (outputs.length !== result.paths.length || outputs.length === 0) {
			if (options.allowIncomplete) {
				incompleteRoots.add(member.root);
				continue;
			}

			throw new InvalidInputError(
				'cohort-json',
				`Local build result for ${member.installable} did not resolve to this cohort's built paths.`
			);
		}

		owners.push({ installable: member.installable, outputs });
	}

	return { builds: owners, incompleteRoots };
}

/** Outputs this invocation's keyed daemon results say it actually built. */
export function claimableOutputPaths(
	results: readonly NixBuildResult[]
): readonly string[] {
	return [
		...new Set(
			results.flatMap((result) =>
				result.outcome.kind === 'built'
					? Object.values(result.outcome.outputs)
					: []
			)
		)
	].toSorted((left, right) => left.localeCompare(right));
}

export async function runNixBuild(
	installables: readonly string[],
	maxJobs: string,
	store: string,
	outLinkDirectory: string,
	signal?: AbortSignal,
	dependencies: CapturedNixProcessDependencies = defaultCapturedNixProcessDependencies
): Promise<NixBuildCommandResult> {
	signal?.throwIfAborted();

	await mkdir(outLinkDirectory, { recursive: true });

	const arguments_ = nixBuildArguments(
		installables,
		maxJobs,
		store,
		outLinkDirectory
	);

	const { status, stdout } = await runCapturedNixProcess(
		arguments_,
		signal,
		dependencies
	);

	const paths = stdout.split(/\r?\n/u).filter((line) => line !== '');

	return { paths, status };
}
