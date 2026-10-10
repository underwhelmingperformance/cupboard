import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from 'node:process';

import {
	copySources,
	createProcessNixDaemonConnector,
	type DaemonCommandRunner,
	type DependencyOutput,
	dependencyOutputs,
	discoverNixStoreConfig,
	Nix,
	type NixBuildMode,
	type NixBuildResult,
	type NixBuildSettings,
	type NixDaemonClientOptions,
	type NixDaemonSession,
	type NixDaemonSetOptions,
	NixDaemonUnavailableError,
	type NixDerivedPathString,
	type NixValidPathInfo,
	parseSshNgStoreUri,
	selectPublicationPaths,
	tenantDependencyReferences,
	tenantReferenceSources
} from '@cupboard/nix';
import { parseTenantCacheUrl } from '@cupboard/nix-store/cache-url';
import { Derivation } from '@cupboard/nix-store/derivation';
import {
	type CacheScope,
	hasControlCharacter,
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
	type TerminalBuildFailure
} from '@cupboard/protocol/build';
import {
	availabilityCeilingSchema,
	describeUnknownPathsRefusal,
	unknownPathsCeilingRefusalSchema
} from '@cupboard/protocol/plan';
import {
	pushSummaryResultKind,
	pushSummarySchema
} from '@cupboard/protocol/reports';
import type { RootSummary } from '@cupboard/protocol/retention';
import {
	type ReferencePublicationManifestInput,
	referencePublicationManifestSchema
} from '@cupboard/protocol/upload';
import {
	createGithubReporter,
	type Reporter,
	type ReporterResultEvent
} from '@cupboard/reporter';
import {
	type AbortableChildProcessLifecycle,
	type ChildProcessEscalationScheduler,
	observeChildProcess,
	waitForAbortableChildProcess
} from '@cupboard/shared/child-process';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { readUserInputSchema } from '@cupboard/shared/http';
import type { Command } from 'commander';
import { z } from 'zod';

import {
	addUploads,
	attributedUploads,
	cohortFailureResult,
	type CohortRootSummary,
	cohortSummaryResult,
	outcomeOrder,
	recordedRoots,
	type TargetOutcome,
	type UploadTally,
	uploadTally
} from '../cohort-summary.ts';
import {
	type CupboardRunDependencies,
	runCupboard as defaultRunCupboard
} from '../cupboard-run.ts';
import {
	BuildObservationMissingError,
	BuildRebuildRemoteDispatchError,
	BuiltPublicationObservationUnsupportedError,
	CohortEvaluationDriftError,
	CohortJsonInvalidError,
	CohortJsonSchemaError,
	CohortPlanCommandError,
	CohortPlanRefusedError,
	CohortPlanResultInvalidError,
	CohortPlanResultMissingError,
	CohortTargetOwnerMissingError,
	CommandFailedError,
	CommandOutputTooLargeError,
	CupboardReportedError,
	FallbackReadPasswordRequiredError,
	FallbackReadUserRequiredError,
	InvalidMaxJobsError,
	LocalBuildExpectedPathMissingError,
	LocalBuildOutputsMissingError,
	LocalBuildOutputsOutsideCohortError,
	LocalBuildOwnerMissingError,
	LocalDependencyBuildFailedError,
	MissingInputError,
	PlannedTargetNotDerivationError,
	PlannedTargetSourceMissingError,
	ReadPasswordRequiredError,
	ReadUserRequiredError,
	RemoteBuildOutputPathUnknownError,
	RemoteBuildOutputUndeclaredError,
	RemoteBuildOwnerMissingError,
	RemoteCohortBuildFailedError,
	type RemoteCohortBuildFailure,
	RemoteCohortProtocolError,
	RemotePublicationTargetUnresolvedError,
	RetentionChoiceConflictError,
	ReuseViewRequiredError,
	RunRootPermanentRequiredError,
	RunRootRequiredError
} from '../errors.ts';
import { type Environment, requireEnvironment, setOutput } from '../inputs.ts';
import { copyNixPaths, type NixCopyDependencies } from '../nix-copy.ts';
import {
	isEnabled,
	provided,
	providedCacheSelection,
	providedChoice,
	providedReadUser,
	providedUrl
} from '../options.ts';
import { rootRetention } from '../root-retention.ts';
import { cacheUrlFor } from '../substituters.ts';

import { buildActivities } from './build.ts';
import {
	type CachedClosureReference,
	type CachedClosureSource,
	type LocalStoreUri,
	materialiseCachedClosure
} from './materialise-cached-closure.ts';

function isNixDerivedPathString(value: unknown): value is NixDerivedPathString {
	if (typeof value !== 'string') {
		return false;
	}

	const selection = value.indexOf('^');
	const storePath = selection === -1 ? value : value.slice(0, selection);
	const outputs = selection === -1 ? undefined : value.slice(selection + 1);

	// The output selection is rendered into operator diagnostics, so a control
	// character in it could forge log lines or runner workflow commands.
	return (
		storePathSchema.safeParse(storePath).success &&
		(outputs === undefined ||
			(outputs.length > 0 && !hasControlCharacter(outputs)))
	);
}

/**
The canonical spelling of a derived path's unordered named-output set.
*/
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

// The `cohortMatrix` output for one surviving cohort. All arrays use the same
// indices as `attrs`. `queryInstallables` and `expectedPaths` use `null` when
// evaluation did not produce one unambiguous value.
// An attr identifies its target in operator diagnostics, so a control
// character in it could forge log lines or runner workflow commands.
const cohortAttributeSchema = z
	.string()
	.min(1)
	.refine((value) => !hasControlCharacter(value));

const cohortMatrixEntrySchema = z
	.object({
		key: z.string().min(1),
		attrs: z.array(cohortAttributeSchema),
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
					message: `${field} must contain one entry per attr (${String(entry.attrs.length)})`
				});
			}
		}
	});

type CohortMatrixEntry = z.output<typeof cohortMatrixEntrySchema>;

export interface CohortMember {
	readonly attr: string;
	/**
	The flake-reference form `nix build` resolves directly.
	*/
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

const dependencyBuildSchema = z.object({
	path: storePathSchema,
	installables: z.tuple([nixDerivedPathSchema], nixDerivedPathSchema),
	requiredBy: z.tuple([nixDerivedPathSchema], nixDerivedPathSchema)
});

const dependencyCopySchema = z.object({
	path: storePathSchema,
	requiredBy: z.tuple([nixDerivedPathSchema], nixDerivedPathSchema)
});

const partitionSchema = z.object({
	attachOnly: z.array(z.string()),
	publishByReference: z.array(z.string()),
	leftUpstream: z.array(z.string()),
	alreadyValid: z.array(z.string()),
	buildSet: z.array(nixDerivedPathSchema),
	rebuildSet: z.array(nixDerivedPathSchema).default([]),
	closureTargets: z.array(storePathSchema).default([]),
	dependencyBuilds: z.array(dependencyBuildSchema).default([]),
	dependencyCopies: z.array(dependencyCopySchema).default([]),
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

// A target removed from the build set by `cupboard plan reprobe`, classified by
// whether the destination or reuse view now serves it.
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
		if (refusal.unknownPaths.length > 0) {
			return describeUnknownPathsRefusal(refusal);
		}

		// An older cupboard reports no per-path detail, so its refusal keeps
		// a count-and-limit sentence.
		const pathUnit = refusal.unknownCount === 1 ? 'path' : 'paths';
		const availabilityVerb = refusal.unknownCount === 1 ? 'is' : 'are';
		const downloadUnit = refusal.downloadSize === 1 ? 'byte' : 'bytes';
		const narUnit = refusal.narSize === 1 ? 'byte' : 'bytes';

		return (
			`Cupboard could not determine whether ${String(refusal.unknownCount)} required store ${pathUnit} ${availabilityVerb} available. ` +
			`The limit is ${String(refusal.ceiling.value)}. Nix reported ` +
			`${String(refusal.downloadSize)} download ${downloadUnit} and ` +
			`${String(refusal.narSize)} NAR ${narUnit}.`
		);
	}

	const narUnit = refusal.measured.narSize === 1 ? 'byte' : 'bytes';
	const availableUnit = refusal.available === 1 ? 'byte' : 'bytes';
	const headroomUnit = refusal.headroom === 1 ? 'byte' : 'bytes';

	return (
		`The cohort needs ${String(refusal.measured.narSize)} substitutable NAR ${narUnit}, ` +
		`but the store has ${String(refusal.available)} ${availableUnit} available and must ` +
		`retain ${String(refusal.headroom)} ${headroomUnit} of headroom.`
	);
}

export interface BuildCohortOptions {
	readonly cohortJson?: string;
	readonly url?: string;
	readonly cupboardPath?: string;
	readonly cache?: string;
	readonly reuseView?: string;
	readonly ttl?: string;
	readonly permanent?: string;
	readonly audience?: string;
	readonly readUser?: string;
	readonly fallbackReadUser?: string;
	readonly fallbackReadPassword?: string;
	readonly readPassword?: string;
	readonly maxJobs?: string;
	readonly store?: string;
	readonly publish?: string;
	readonly build?: string;
	readonly substituter?: string;
	readonly bestEffort?: string;
	readonly gcBetweenCohorts?: string;
	readonly runRoot?: string;
	readonly runRootTtl?: string;
	readonly runRootPermanent?: string;
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
	readonly cache: CacheScope;
	readonly reuseView: string;
	readonly ttl: string;
	readonly permanent: boolean;
	readonly audience: string;
	readonly readUser: string;
	readonly fallbackReadUser: string;
	readonly fallbackReadPassword: string;
	readonly readPassword: string;
	readonly maxJobs: string;
	readonly store: string;
	readonly publish: 'none' | 'outputs' | 'built' | 'closure';
	readonly push: boolean;
	readonly build: 'missing' | 'rebuild';
	readonly substituter: 'leave' | 'copy';
	readonly allBestEffort: boolean;
	readonly gcBetweenCohorts: boolean;
	readonly runRoot: string;
	readonly runRootTtl: string;
	readonly runRootPermanent: boolean;
	readonly receiptFile: string;
	readonly targetPathsFile: string;
	readonly intermediatePathsFile: string;
	readonly referencePathsFile: string;
	readonly leftUpstreamFile: string;
	readonly countsFile: string;
	// Local-build out-links keep target closures alive while this directory
	// exists. Remote publication uses daemon temporary roots instead.
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
		throw new CohortJsonInvalidError(error);
	}

	const cohort = cohortMatrixEntrySchema.safeParse(parsedJson);

	if (!cohort.success) {
		throw new CohortJsonSchemaError(cohort.error);
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
		throw new ReadPasswordRequiredError();
	}

	if (readPassword !== '' && readUser === '') {
		throw new ReadUserRequiredError();
	}

	const fallbackReadUser = providedReadUser(options.fallbackReadUser);
	const fallbackReadPassword = options.fallbackReadPassword ?? '';

	if (fallbackReadUser !== '' && fallbackReadPassword === '') {
		throw new FallbackReadPasswordRequiredError();
	}

	if (fallbackReadPassword !== '' && fallbackReadUser === '') {
		throw new FallbackReadUserRequiredError();
	}

	const maxJobs = provided(options.maxJobs) ?? '';

	if (
		maxJobs !== '' &&
		(!/^\d+$/u.test(maxJobs) || BigInt(maxJobs) > maxNixBuildJobs)
	) {
		throw new InvalidMaxJobsError(maxJobs);
	}

	const runRoot = provided(options.runRoot) ?? '';
	const runRootTtl = provided(options.runRootTtl) ?? '';

	if (runRootTtl !== '' && runRoot === '') {
		throw new RunRootRequiredError(runRootTtl);
	}

	const isRunRootPermanent = isEnabled(
		'run-root-permanent',
		options.runRootPermanent,
		false
	);

	if (isRunRootPermanent && runRoot === '') {
		throw new RunRootPermanentRequiredError();
	}

	if (runRootTtl !== '' && isRunRootPermanent) {
		throw new RetentionChoiceConflictError(
			'run-root-ttl',
			'run-root-permanent'
		);
	}

	const ttl = provided(options.ttl) ?? '';
	const isPermanent = isEnabled('permanent', options.permanent, false);

	if (ttl !== '' && isPermanent) {
		throw new RetentionChoiceConflictError('ttl', 'permanent');
	}

	const runnerTemporary = requireEnvironment(environment, 'RUNNER_TEMP');
	// The composite action passes every file option, so an unset workflow
	// input arrives as the empty string, and `path.resolve('')` is the
	// working directory. Treat blank as absent or the default file becomes
	// the repository checkout.
	const outputPath = (name: string, provided_: string | undefined): string =>
		path.resolve(
			provided(provided_) ??
				path.join(runnerTemporary, `cupboard-cohort-${name}`)
		);

	const publish = providedChoice(
		'publish',
		options.publish,
		['none', 'outputs', 'built', 'closure'],
		'none'
	);
	const isPushEnabled = publish !== 'none';
	const build = providedChoice(
		'build',
		options.build,
		['missing', 'rebuild'],
		'missing'
	);
	const substituter = providedChoice(
		'substituter',
		options.substituter,
		['leave', 'copy'],
		'leave'
	);

	return {
		cohort: cohort.data,
		url,
		cupboardPath,
		cache: providedCacheSelection(options.cache),
		reuseView: provided(options.reuseView) ?? '',
		ttl,
		permanent: isPermanent,
		audience: provided(options.audience) ?? '',
		readUser,
		fallbackReadUser,
		fallbackReadPassword,
		readPassword,
		maxJobs,
		store: provided(options.store) ?? '',
		publish,
		push: isPushEnabled,
		build,
		substituter,
		allBestEffort: isEnabled('best-effort', options.bestEffort, false),
		gcBetweenCohorts: isEnabled(
			'gc-between-cohorts',
			options.gcBetweenCohorts,
			false
		),
		runRoot,
		runRootTtl,
		runRootPermanent: isRunRootPermanent,
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
		.option('--cache <name>', 'Inspect and publish to a named cache.')
		.option(
			'--reuse-view <name>',
			'named reuse view to probe for substitutable paths'
		)
		.option(
			'--ttl <ttl>',
			'TTL applied when retaining an already cached target'
		)
		.option(
			'--permanent <value>',
			'retain an already cached target permanently: true or false',
			'false'
		)
		.option('--audience <audience>', 'GitHub OIDC audience (defaults to url)')
		.option('--read-user <user>', 'username for cache reads')
		.option('--read-password <password>', 'password for cache reads')
		.option(
			'--fallback-read-user <user>',
			'tenant-fallback username for private reuse-view reads'
		)
		.option(
			'--fallback-read-password <password>',
			'tenant-fallback password for private reuse-view reads'
		)
		.option('--max-jobs <count>', 'maximum local build jobs')
		.option(
			'--store <uri>',
			'remote ssh-ng store the plan and the build run against'
		)
		.option(
			'--publish <scope>',
			'control published paths: none, outputs, built, or closure'
		)
		.option(
			'--build <mode>',
			'control target builds: missing reuses available outputs; rebuild builds them again'
		)
		.option(
			'--substituter <mode>',
			'control publication of externally substituted targets: leave or copy'
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
			'--run-root-permanent <value>',
			'retain the run root permanently: true or false',
			'false'
		)
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
			'where to write paths the tenant already serves, publishable by reference'
		)
		.option(
			'--left-upstream-file <path>',
			'where to record targets excluded from publication because an upstream substituter serves them'
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
	readonly tenantDependencyReferences?: typeof tenantDependencyReferences;
	readonly selectPublicationPaths?: typeof selectPublicationPaths;
	readonly buildSettings?: NixBuildSettings;
	readonly fetcher?: typeof fetch;
	readonly runCupboard?: typeof defaultRunCupboard;
	readonly runNixBuild?: typeof runNixBuild;
	readonly runNixBuildWithResults?: typeof runNixBuildWithResults;
	readonly runNixCopy?: typeof runNixCopy;
	readonly runNixDerivationShow?: typeof runNixDerivationShow;
	readonly materialiseDerivationGraph?: typeof materialiseDerivationGraph;
	readonly resolveLocalDerivationGraph?: typeof resolveLocalDerivationGraph;
	readonly withLocalDerivationRoots?: WithLocalDerivationRoots;
	readonly withLocalStoreSession?: <T>(
		use: (
			session: Pick<
				NixDaemonSession,
				'addTempRoot' | 'buildPathsWithResults' | 'resolveClosure'
			>,
			localStore: LocalStoreUri
		) => Promise<T>
	) => Promise<T>;
	readonly materialiseCachedClosure?: typeof materialiseCachedClosure;
	readonly cupboardRunDependencies?: CupboardRunDependencies;
	readonly reporter?: Reporter;
	readonly signal?: AbortSignal;
	/**
	Returns the current time in milliseconds, for the job's duration.
	*/
	readonly now?: () => number;
}

function cachedClosureSources(
	inputs: BuildCohortInputs,
	partition: PartitionData | undefined
): readonly CachedClosureSource[] {
	const targets = new Set<string>(partition?.closureTargets);
	if (targets.size === 0) {
		return [];
	}
	const destination = (partition?.attachOnly ?? [])
		.filter((storePath) => targets.has(storePath))
		.map((storePath) => storePathSchema.parse(storePath));
	const view = (partition?.publishByReference ?? [])
		.filter((storePath) => targets.has(storePath))
		.map((storePath) => storePathSchema.parse(storePath));
	const sources: CachedClosureSource[] = [];

	if (targets.size > 0) {
		sources.push({
			url: cacheUrlFor(inputs.url, inputs.cache),
			paths: destination,
			...(inputs.readUser !== '' && {
				credential: {
					user: readUserInputSchema.parse(inputs.readUser),
					password: inputs.readPassword
				}
			})
		});
	}

	if (inputs.reuseView !== '') {
		sources.push({
			url: new URL(
				`reuse/${inputs.reuseView}`,
				`${canonicalHref(inputs.url)}/`
			),
			paths: view,
			...(inputs.fallbackReadUser !== '' && {
				credential: {
					user: readUserInputSchema.parse(inputs.fallbackReadUser),
					password: inputs.fallbackReadPassword
				}
			})
		});
	}

	return sources;
}

export async function buildCohortAction(
	options: BuildCohortOptions,
	environment: Environment = env,
	dependencies: BuildCohortDependencies = {}
): Promise<void> {
	dependencies.signal?.throwIfAborted();

	const now = dependencies.now ?? (() => Date.now());
	const startedAt = now();
	const inputs = resolveBuildCohortInputs(options, environment);
	if (inputs.publish === 'built' && inputs.store !== '') {
		throw new BuiltPublicationObservationUnsupportedError();
	}

	if (
		inputs.build === 'rebuild' &&
		inputs.store === '' &&
		(inputs.cohort.remote ||
			(dependencies.buildSettings ?? discoverNixStoreConfig().building)
				.builders !== undefined)
	) {
		throw new BuildRebuildRemoteDispatchError();
	}
	const members = membersOf(inputs.cohort);
	const queryable = members.filter(
		(member) => member.queryInstallable !== undefined
	);
	const unqueryable = members.filter(
		(member) => member.queryInstallable === undefined
	);
	// A remote publication copies selected local closure paths, then realises
	// dependencies and targets over one rooted connection. Every other cohort
	// realises its build set from the runner's local store.
	const isRemotePublication = inputs.push && inputs.store !== '';

	if (isRemotePublication && unqueryable.length > 0) {
		throw new RemotePublicationTargetUnresolvedError(
			unqueryable.map((member) => member.attr)
		);
	}

	const runCupboard = dependencies.runCupboard ?? defaultRunCupboard;
	const runNix = dependencies.runNixBuild ?? runNixBuild;
	const runNixWithResults =
		dependencies.runNixBuildWithResults ?? runNixBuildWithResults;
	const runCopy = dependencies.runNixCopy ?? runNixCopy;
	const runDerivationShow =
		dependencies.runNixDerivationShow ?? runNixDerivationShow;
	const materialiseGraph =
		dependencies.materialiseDerivationGraph ?? materialiseDerivationGraph;
	const resolveLocalGraph =
		dependencies.resolveLocalDerivationGraph ?? resolveLocalDerivationGraph;
	const withLocalDerivationRoots =
		dependencies.withLocalDerivationRoots ?? runWithLocalDerivationRoots;
	const withLocalStoreSession =
		dependencies.withLocalStoreSession ??
		(<T>(
			use: (
				session: Pick<
					NixDaemonSession,
					'addTempRoot' | 'buildPathsWithResults' | 'resolveClosure'
				>,
				localStore: LocalStoreUri
			) => Promise<T>
		) => {
			const opened = openLocalDerivationRootStore(dependencies.signal, {});

			return opened.nix.withConnection((session) =>
				use(session, opened.copyStoreUri)
			);
		});
	const materialiseClosure =
		dependencies.materialiseCachedClosure ?? materialiseCachedClosure;
	const reporter =
		dependencies.reporter ?? createGithubReporter({ environment });
	const cupboardRunDependencies =
		dependencies.signal === undefined
			? dependencies.cupboardRunDependencies
			: {
					...dependencies.cupboardRunDependencies,
					signal: dependencies.signal
				};

	const planAndBuild = async (execution: CohortExecution): Promise<void> => {
		const plannedGraph =
			execution.kind === 'remote'
				? execution.preparation.graph
				: execution.graph;
		const result =
			queryable.length === 0
				? undefined
				: await planCohort(
						inputs,
						queryable,
						environment,
						runCupboard,
						cupboardRunDependencies,
						plannedGraph
					);

		// Recheck build-set outputs immediately before realisation. Remove any target
		// that has become available in the destination or reuse view since planning.
		const reprobe =
			result === undefined ||
			inputs.build === 'rebuild' ||
			inputs.substituter !== 'leave'
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
				: withdrawFromPartition(
						result.partition,
						reprobe?.withdrawn ?? [],
						inputs.publish === 'closure'
					);
		const closureSources = cachedClosureSources(inputs, partition);
		const closureReferences = new Map<
			string,
			readonly CachedClosureReference[]
		>();
		const recordClosureReferences = (
			source: URL,
			paths: readonly CachedClosureReference[]
		): void => {
			closureReferences.set(canonicalHref(source), paths);
		};
		const provenanceRebuilds = new Set<string>(partition?.rebuildSet);
		if (inputs.build === 'rebuild') {
			for (const member of unqueryable) {
				provenanceRebuilds.add(member.installable);
			}
		}

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
		const localDependencyBuilds =
			execution.kind === 'local'
				? retainedDependencyBuilds(partition, buildInstallables)
				: [];

		if (localDependencyBuilds.length > 0 && inputs.publish !== 'built') {
			await realiseLocalDependencies(
				localDependencyBuilds,
				inputs,
				runNix,
				dependencies.signal
			);
		}

		let streamedFailure:
			| {
					readonly error: CupboardReportedError;
					readonly receipt: BuildReceiptV3;
			  }
			| undefined;
		let buildUploads: UploadTally | undefined;

		if (isStreamed) {
			try {
				buildUploads = await runBuildPushCohort(
					inputs,
					buildInstallables,
					provenanceRebuilds,
					environment,
					runCupboard,
					cupboardRunDependencies,
					inputs.publish === 'built' ? localDependencyBuilds : []
				);
			} catch (error) {
				if (!inputs.allBestEffort) {
					const uploads =
						error instanceof CupboardReportedError
							? uploadTally(error.results)
							: undefined;
					reporter.result(
						cohortFailureResult({
							durationMs: now() - startedAt,
							cause: error instanceof Error ? error.message : String(error),
							targets: members.map(({ attr, root }) => ({ attr, root })),
							...(uploads !== undefined && { uploads })
						})
					);
					throw error;
				}

				streamedFailure = await settledTargetBuildFailure(
					error,
					inputs.receiptFile
				);
				buildUploads = uploadTally(streamedFailure.error.results);

				const terminalFailure = streamedFailure.receipt.terminalFailure;

				if (terminalFailure?.kind === 'target-build') {
					for (const target of terminalFailure.failedTargets) {
						reportTargetBuildFailure(
							reporter,
							members,
							target,
							terminalFailure.failedDerivations?.find(
								(failure) => failure.target === target
							)?.derivation
						);
					}
				}
			}
		}

		const context: SettleCohortBuildContext = {
			dependencyOutputs: plannedGraph?.dependencyOutputs ?? [],
			tenantDependencyReferences:
				dependencies.tenantDependencyReferences ?? tenantDependencyReferences,
			fetcher: dependencies.fetcher,
			selectPublicationPaths:
				dependencies.selectPublicationPaths ?? selectPublicationPaths,
			inputs,
			members,
			partition,
			result,
			reprobe,
			provenanceRebuilds,
			closureReferences,
			isStreamed,
			environment,
			runCupboard,
			cupboardRunDependencies,
			reporter,
			duration: () => now() - startedAt,
			buildUploads
		};

		if (execution.kind === 'remote') {
			if (remoteTargets.length === 0 && closureSources.length === 0) {
				await settleCohortBuild(context, { built: [] });
				return;
			}

			if (inputs.maxJobs !== '') {
				reporter.warn(
					'remote max-jobs ignored',
					'max-jobs controls local nix build processes only; configure the selected remote store daemon to limit its own build parallelism'
				);
			}

			const bindingByTarget = new Map(
				execution.preparation.bindings.map((binding) => [
					binding.target,
					binding
				])
			);
			const remoteBindings = remoteTargets.map((target) => {
				const binding = bindingByTarget.get(target);

				if (binding === undefined) {
					throw new PlannedTargetSourceMissingError(target);
				}

				return binding;
			});
			const remoteTargetSet = new Set(remoteTargets);
			const dependencyBuilds = (partition?.dependencyBuilds ?? []).flatMap(
				({ path, installables, requiredBy }) => {
					const retainedOwners = requiredBy.filter((target) =>
						remoteTargetSet.has(canonicalNixDerivedPath(target))
					);

					return retainedOwners.length === 0
						? []
						: [{ path, installables, requiredBy: retainedOwners }];
				}
			);
			const dependencyCopies = (partition?.dependencyCopies ?? [])
				.filter(({ requiredBy }) =>
					requiredBy.some((target) =>
						remoteTargetSet.has(canonicalNixDerivedPath(target))
					)
				)
				.map(({ path }) => path);
			const copiedPaths = [
				...new Set([
					...remoteBindings.map((binding) => binding.derivation),
					...dependencyBuilds.flatMap(({ installables }) =>
						installables.map((installable) => derivationPathOf(installable))
					),
					...dependencyCopies
				])
			];
			let settledTerminalFailure: TerminalBuildFailure | undefined;
			const publishRemoteResults: RemoteBuildPublisher = async (
				results,
				failures,
				publicationPaths,
				currentProvenanceRebuilds,
				copiedFrom,
				resolveClosure
			) => {
				const targetResults = results.filter((result) =>
					remoteTargetSet.has(canonicalNixDerivedPath(result.target))
				);
				const targetFailures = failures.filter(
					(failure) => failure.kind === 'target'
				);
				const failedTargets = new Set(
					targetFailures.map((failure) =>
						canonicalNixDerivedPath(nixDerivedPathSchema.parse(failure.target))
					)
				);
				const dependencyOwnersByProducer = new Map(
					dependencyBuilds.flatMap(({ installables, requiredBy }) =>
						installables.map((installable) => [
							canonicalNixDerivedPath(installable),
							requiredBy
						])
					)
				);
				const unscopedFailures = failures.filter((failure) => {
					if (failure.kind === 'target') {
						return false;
					}

					if (failure.kind !== 'dependency') {
						return true;
					}

					const requiredBy = dependencyOwnersByProducer.get(
						canonicalNixDerivedPath(nixDerivedPathSchema.parse(failure.target))
					);

					return (
						requiredBy === undefined ||
						requiredBy.some(
							(target) => !failedTargets.has(canonicalNixDerivedPath(target))
						)
					);
				});
				const terminalFailure =
					failures.length === 0
						? undefined
						: unscopedFailures.length === 0
							? ({
									kind: 'target-build',
									failedTargets: targetFailures.map((failure) => failure.target)
								} as const)
							: ({ kind: 'command' } as const);

				if (inputs.allBestEffort) {
					for (const failure of targetFailures) {
						reportTargetBuildFailure(
							reporter,
							members,
							failure.target,
							undefined,
							failure.message
						);
					}
				}

				await settleCohortBuild(
					{
						...context,
						provenanceRebuilds: currentProvenanceRebuilds
					},
					{
						built: buildResultOutputPaths(targetResults),
						publicationPaths,
						resultBuilds: targetResults,
						publicationBuilds: results,
						copiedFrom,
						resolveClosure,
						incompleteRoots: incompleteRootsFor(members, failures),
						...(terminalFailure !== undefined && { terminalFailure })
					}
				);
				settledTerminalFailure = terminalFailure;
			};
			const installablesByTarget = new Map(
				remoteBindings.map((binding) => [
					binding.target,
					binding.installables.join(', ')
				])
			);

			try {
				await reporter.progress(
					'Building remote targets',
					{ total: remoteBindings.length },
					(bar) =>
						runNixWithResults(
							remoteBindings.map((binding) => binding.target),
							inputs.maxJobs,
							inputs.store,
							publishRemoteResults,
							dependencies.signal,
							{
								copyPaths: copiedPaths,
								...(dependencyBuilds.length > 0 && { dependencyBuilds }),
								...(inputs.build === 'rebuild' && {
									rebuild: true
								}),
								...(closureSources.length > 0 && {
									materialiseClosure: (
										session: Pick<
											NixDaemonSession,
											'addTempRoot' | 'buildPathsWithResults' | 'resolveClosure'
										>
									) =>
										withLocalStoreSession(async (localNix, localStore) => {
											await mkdir(path.dirname(inputs.receiptFile), {
												recursive: true
											});

											return materialiseClosure({
												sources: closureSources,
												store: inputs.store,
												localStore,
												nix: session,
												localNix,
												onReferenced: recordClosureReferences,
												...(dependencies.fetcher !== undefined && {
													fetch: dependencies.fetcher
												}),
												...(dependencies.signal && {
													signal: dependencies.signal
												})
											});
										})
								}),
								publishClosure: inputs.publish === 'closure',
								onTargetStarted: (target) => {
									reporter.info(
										`Building remote target ${installablesByTarget.get(target) ?? target}`
									);
								},
								onDependencyStarted: (dependency) => {
									reporter.info(`Building remote dependency ${dependency}`);
								},
								onTargetCompleted: () => {
									bar.advance();
								},
								copy: () =>
									copiedPaths.length === 0
										? Promise.resolve()
										: runCopy(copiedPaths, inputs.store, dependencies.signal)
							}
						)
				);
			} catch (error) {
				if (!(
					inputs.allBestEffort &&
					error instanceof RemoteCohortBuildFailedError &&
					settledTerminalFailure?.kind === 'target-build'
				)) {
					throw error;
				}
			}
			return;
		}

		// For a streamed cohort the build is already realised, so this invocation
		// resolves the targets' own output paths and pins them with local out-links
		// until the roots are set; for an unstreamed cohort it is the build itself.
		let build: NixBuildCommandResult;
		const buildPolicy: [] | [RunNixBuildOptions] =
			inputs.build === 'rebuild' && !inputs.push ? [{ rebuild: true }] : [];

		if (streamedFailure === undefined) {
			build =
				buildInstallables.length === 0
					? { paths: [], status: 0, copiedFrom: new Map() }
					: await runNix(
							buildInstallables,
							inputs.maxJobs,
							inputs.store,
							inputs.outLinkDirectory,
							dependencies.signal,
							...buildPolicy
						);
		} else {
			build = {
				paths: [
					...streamedFailure.receipt.paths,
					...(streamedFailure.receipt.leftUpstream ?? [])
				],
				status: streamedFailure.error.status,
				// The streamed run published through `cupboard build-push`, which
				// records the copies it watched in the receipt it writes. This
				// branch only reads the paths back out of that receipt, so there
				// is no copy for this process to record.
				copiedFrom: new Map()
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
				reporter,
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

		const settle = (publicationPaths: readonly string[]) =>
			settleCohortBuild(context, {
				built: build.paths,
				publicationPaths,
				localBuilds: localOwnership.builds,
				copiedFrom: build.copiedFrom,
				incompleteRoots: localOwnership.incompleteRoots
			});

		if (closureSources.length === 0) {
			await settle(build.paths);
		} else {
			await withLocalStoreSession(async (session, localStore) => {
				await mkdir(path.dirname(inputs.receiptFile), { recursive: true });
				const cachedPaths = await materialiseClosure({
					sources: closureSources,
					store: '',
					localStore,
					nix: session,
					onReferenced: recordClosureReferences,
					...(dependencies.fetcher !== undefined && {
						fetch: dependencies.fetcher
					}),
					...(dependencies.signal && { signal: dependencies.signal })
				});

				await settle([...new Set([...build.paths, ...cachedPaths])]);
			});
		}

		if (streamedFailure !== undefined || build.status === 0) {
			return;
		}

		throw new CommandFailedError('nix build', build.status);
	};

	if (isRemotePublication && queryable.length > 0) {
		const targets = queryable.map((member) =>
			nixDerivedPathSchema.parse(member.queryInstallable)
		);
		const plannedDerivations = [
			...new Set(targets.map((target) => derivationPathOf(target)))
		];

		await withLocalDerivationRoots(
			plannedDerivations,
			async () => {
				const bindings = await materialisePlannedDerivations(
					queryable,
					targets,
					runDerivationShow,
					materialiseGraph,
					dependencies.signal
				);
				const graph = await resolveLocalGraph(
					plannedDerivations,
					dependencies.signal
				);

				await planAndBuild({
					kind: 'remote',
					preparation: { bindings, graph }
				});
			},
			dependencies.signal
		);

		return;
	}

	if (!isRemotePublication && queryable.length > 0) {
		const targets = queryable.map((member) =>
			nixDerivedPathSchema.parse(member.queryInstallable)
		);

		// The build set's entries are derivation paths, and `nix build` reads those
		// derivations from the runner's local store whether it builds there or
		// copies them to a non-publishing remote store. A temporary root lasts only
		// while its daemon connection stays open, and a daemon running automatic GC
		// can collect an unrooted derivation between materialisation and the build.
		// Plan and build inside the rooted connection so the materialised closure
		// survives until the build registers roots of its own.
		await withLocalDerivationRoots(
			targets.map((target) => derivationPathOf(target)),
			async () => {
				await materialisePlannedDerivations(
					queryable,
					targets,
					runDerivationShow,
					materialiseGraph,
					dependencies.signal
				);
				const graph = inputs.push
					? await resolveLocalGraph(
							targets.map((target) => derivationPathOf(target)),
							dependencies.signal
						)
					: undefined;

				await planAndBuild({ kind: 'local', graph });
			},
			dependencies.signal
		);

		return;
	}

	await planAndBuild({ kind: 'local' });
}

function reportTargetBuildFailure(
	reporter: Reporter,
	members: readonly CohortMember[],
	target: string,
	firstFailingDerivation?: string,
	message?: string
): void {
	const failed = members.filter(
		(member) =>
			member.queryInstallable === target || member.installable === target
	);
	const derivation =
		firstFailingDerivation ?? target.split('^', 1)[0] ?? target;
	const description =
		failed.length === 0
			? target
			: failed.map(({ attr, root }) => `${attr} (root ${root})`).join(', ');
	reporter.warn(
		'Target build failed',
		`${description}; ${firstFailingDerivation === undefined ? 'build derivation' : 'first failing derivation'}: ${derivation}; nix log ${derivation}${message === undefined ? '' : `; ${message}`}`
	);
}

async function settledTargetBuildFailure(
	error: unknown,
	receiptFile: string
): Promise<{
	readonly error: CupboardReportedError;
	readonly receipt: BuildReceiptV3;
}> {
	if (!(error instanceof CupboardReportedError)) {
		throw error;
	}

	let receipt: BuildReceiptV3;

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
	readonly receipt: BuildReceiptV3;
	readonly inputs: BuildCohortInputs;
	readonly runNix: typeof runNixBuild;
	readonly reporter: Reporter;
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
	const ownerCount = requestedCohortMemberCount(
		options.members,
		survivingInstallables
	);
	const resolveOwners = (onResolved?: () => void) =>
		resolveLocalBuildOwners({
			members: options.members,
			buildInstallables: survivingInstallables,
			builtPaths: [
				...options.receipt.paths,
				...(options.receipt.leftUpstream ?? [])
			],
			inputs: options.inputs,
			runNix: options.runNix,
			allowIncomplete: false,
			...(onResolved !== undefined && { onResolved }),
			...(options.signal !== undefined && { signal: options.signal })
		});
	const ownership =
		ownerCount === 0
			? await resolveOwners()
			: await options.reporter.progress(
					'Identifying outputs after the build',
					{ total: ownerCount },
					(bar) =>
						resolveOwners(() => {
							bar.advance();
						})
				);
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
	shouldPreservePublishedReceipt: boolean,
	terminalFailure: TerminalBuildFailure
): Promise<void> {
	let receipt: BuildReceiptV3;

	if (shouldPreservePublishedReceipt) {
		const settled = buildReceiptV3Schema.parse(
			JSON.parse(await readFile(receiptFile, 'utf8'))
		);
		receipt = { ...settled, terminalFailure };
	} else {
		receipt = { version: 3, paths: [], subjects: [], terminalFailure };
	}

	await writeFile(receiptFile, `${JSON.stringify(receipt, undefined, 2)}\n`);
}

export async function mergeCohortReceipts(
	receiptFile: string,
	shouldIncludeExisting: boolean,
	additionalFiles: readonly string[]
): Promise<void> {
	if (additionalFiles.length === 0) {
		return;
	}

	const receipts = await Promise.all(
		[...(shouldIncludeExisting ? [receiptFile] : []), ...additionalFiles].map(
			async (file) =>
				buildReceiptV3Schema.parse(JSON.parse(await readFile(file, 'utf8')))
		)
	);
	const subjects = new Map<string, BuildReceiptV3['subjects'][number]>();
	const originPriority = {
		'store-held': 0,
		copied: 1,
		republished: 2,
		built: 3
	} as const;

	for (const receipt of receipts) {
		for (const subject of receipt.subjects) {
			const previous = subjects.get(subject.storePath);

			if (
				previous === undefined ||
				originPriority[subject.origin] > originPriority[previous.origin]
			) {
				subjects.set(subject.storePath, subject);
			}
		}
	}

	const receipt = buildReceiptV3Schema.parse({
		...(shouldIncludeExisting && receipts[0]),
		version: 3,
		paths: [...new Set(receipts.flatMap((item) => item.paths))].toSorted(
			byCodeUnit
		),
		subjects: subjects
			.values()
			.toArray()
			.toSorted((left, right) => byCodeUnit(left.storePath, right.storePath)),
		uploaded: [
			...new Set(receipts.flatMap((item) => item.uploaded ?? []))
		].toSorted(byCodeUnit)
	});

	await writeFile(receiptFile, `${JSON.stringify(receipt, undefined, 2)}\n`);
}

function remotePublicationDerivation(
	storePath: string,
	results: readonly NixBuildResult[]
): { readonly derivation?: string } {
	const result = results.find(
		(result) =>
			'outputs' in result.outcome &&
			Object.values(result.outcome.outputs).includes(
				storePathSchema.parse(storePath)
			)
	);
	const derivation =
		result === undefined ? undefined : derivationPathOf(result.target);
	return derivation === undefined ? {} : { derivation };
}

interface SettleCohortBuildContext {
	readonly dependencyOutputs: readonly DependencyOutput[];
	readonly tenantDependencyReferences: typeof tenantDependencyReferences;
	readonly fetcher: typeof fetch | undefined;
	readonly selectPublicationPaths: typeof selectPublicationPaths;
	readonly inputs: BuildCohortInputs;
	readonly members: readonly CohortMember[];
	readonly partition: PartitionData | undefined;
	readonly result: PlanCohortResultData | undefined;
	readonly reprobe: PlanReprobeResultData | undefined;
	readonly provenanceRebuilds: ReadonlySet<string>;
	readonly closureReferences: Map<string, readonly CachedClosureReference[]>;
	readonly isStreamed: boolean;
	readonly environment: Environment;
	readonly runCupboard: typeof defaultRunCupboard;
	readonly cupboardRunDependencies: CupboardRunDependencies | undefined;
	readonly reporter: Reporter;
	readonly duration: () => number;
	readonly buildUploads: UploadTally | undefined;
}

// Complete every operation that reads realised paths before returning. Remote
// callers keep the daemon session open throughout, so temporary roots remain
// active until the receipt and target-root pushes finish.
async function settleCohortBuild(
	context: SettleCohortBuildContext,
	build: {
		readonly resolveClosure?: (
			paths: readonly StorePathString[]
		) => ReturnType<Nix['resolveClosure']>;
		readonly built: readonly string[];
		readonly publicationPaths?: readonly string[];
		readonly resultBuilds?: readonly NixBuildResult[];
		readonly publicationBuilds?: readonly NixBuildResult[];
		readonly localBuilds?: readonly CohortOwnedBuild[];
		readonly incompleteRoots?: ReadonlySet<string>;
		readonly terminalFailure?: TerminalBuildFailure;
		/**
		The stores each path was copied from, keyed by store path.
		*/
		readonly copiedFrom?: ReadonlyMap<string, readonly string[]>;
	}
): Promise<void> {
	const {
		inputs,
		members,
		partition,
		result,
		reprobe,
		provenanceRebuilds,
		closureReferences,
		isStreamed,
		environment,
		runCupboard,
		cupboardRunDependencies,
		reporter
	} = context;
	const {
		built,
		publicationPaths = built,
		resultBuilds = [],
		publicationBuilds = resultBuilds,
		localBuilds = [],
		incompleteRoots = new Set<string>(),
		terminalFailure,
		copiedFrom = new Map<string, readonly string[]>()
	} = build;
	// The build and the push run as separate processes, so the copies the build
	// watched reach the push through a file beside the receipt.
	const copiedFromFile = path.join(
		path.dirname(inputs.receiptFile),
		'observed-copies.json'
	);
	const claimable = claimableOutputPaths(publicationBuilds, provenanceRebuilds);

	if (inputs.build === 'rebuild' && inputs.store !== '' && inputs.push) {
		const reportedBuilt = new Set(claimable);
		const missing = built.filter((storePath) => !reportedBuilt.has(storePath));
		if (missing.length > 0) {
			throw new BuildObservationMissingError(missing);
		}
	}

	const streamedReceipt = isStreamed
		? buildReceiptV3Schema.parse(
				JSON.parse(await readFile(inputs.receiptFile, 'utf8'))
			)
		: undefined;
	const realised = new Set(built);
	const leftFromReceipt = streamedReceipt?.leftUpstream ?? [];
	if (
		leftFromReceipt.some(
			(storePath) =>
				!realised.has(storePath) ||
				(streamedReceipt?.failed?.includes(storePath) ?? false) ||
				streamedReceipt?.subjects.some(
					(subject) =>
						subject.storePath === storePath && subject.origin === 'built'
				)
		)
	) {
		throw new Error(
			'The build receipt excludes a path that is not a successfully realised selected output'
		);
	}
	const remoteCandidates = built.map((storePath) => ({
		storePath,
		origin: claimable.includes(storePath)
			? ('built' as const)
			: ('store-held' as const),
		...remotePublicationDerivation(storePath, resultBuilds)
	}));
	const selection =
		isStreamed || !inputs.push
			? {
					published: built.filter(
						(storePath) =>
							!leftFromReceipt.includes(storePathSchema.parse(storePath))
					),
					leftUpstream: leftFromReceipt
				}
			: await context.selectPublicationPaths(remoteCandidates, {
					substituter: inputs.build === 'rebuild' ? 'copy' : inputs.substituter,
					tenantUrl: parseTenantCacheUrl(inputs.url).tenantUrl,
					...(inputs.store !== '' && { storeUri: inputs.store }),
					...(cupboardRunDependencies?.signal !== undefined && {
						signal: cupboardRunDependencies.signal
					})
				});

	if (
		inputs.push &&
		inputs.publish === 'built' &&
		context.dependencyOutputs.length > 0
	) {
		const published = new Set([
			...(streamedReceipt?.paths ?? []),
			...publicationPaths
		]);
		const cached = new Set([
			...(partition?.attachOnly ?? []),
			...(partition?.publishByReference ?? [])
		]);
		const requiredRoots = new Set(
			members.flatMap((member) => {
				if (member.queryInstallable === undefined) {
					return [];
				}
				const isRetained =
					member.expectedPath !== undefined && cached.has(member.expectedPath);
				const isCompleted = localBuilds.some(
					(owned) =>
						owned.installable === member.installable &&
						owned.outputs.some((output) =>
							selection.published.includes(storePathSchema.parse(output))
						)
				);
				return isRetained || isCompleted
					? [
							derivationPathOf(
								nixDerivedPathSchema.parse(member.queryInstallable)
							)
						]
					: [];
			})
		);
		const paths = context.dependencyOutputs
			.filter(
				(dependency) =>
					dependency.requiredBy.some((root) => requiredRoots.has(root)) &&
					!published.has(dependency.storePath)
			)
			.map((dependency) => dependency.storePath);
		if (paths.length > 0) {
			const sources = tenantReferenceSources(
				parseTenantCacheUrl(inputs.url).tenantUrl,
				[
					{
						url: cacheUrlFor(inputs.url, inputs.cache),
						paths: [],
						...(inputs.readUser !== '' && {
							credential: {
								user: readUserInputSchema.parse(inputs.readUser),
								password: inputs.readPassword
							}
						})
					},
					...(inputs.reuseView === ''
						? []
						: [
								{
									url: new URL(
										`reuse/${inputs.reuseView}`,
										`${canonicalHref(inputs.url)}/`
									),
									paths: [],
									...(inputs.fallbackReadUser !== '' && {
										credential: {
											user: readUserInputSchema.parse(inputs.fallbackReadUser),
											password: inputs.fallbackReadPassword
										}
									})
								}
							])
				]
			);
			const references = await context.tenantDependencyReferences(paths, {
				sources,
				...(context.fetcher !== undefined && { fetch: context.fetcher }),
				...(cupboardRunDependencies?.signal !== undefined && {
					signal: cupboardRunDependencies.signal
				})
			});
			const grouped = Map.groupBy(references, (reference) => reference.source);
			for (const [source, entries] of grouped) {
				closureReferences.set(source, [
					...(closureReferences.get(source) ?? []),
					...entries
				]);
			}
		}
	}
	const selectedTargets = selection.published;
	const excludedTargets = new Set(selection.leftUpstream);
	if (
		!isStreamed &&
		inputs.publish === 'closure' &&
		selection.leftUpstream.length > 0 &&
		selectedTargets.length > 0 &&
		build.resolveClosure === undefined
	) {
		throw new Error(
			'The selected store cannot resolve the retained publication closure'
		);
	}
	const selectedPublicationPaths =
		isStreamed && (inputs.publish === 'closure' || inputs.publish === 'built')
			? [
					...new Set([
						...(streamedReceipt?.paths ?? []),
						...publicationPaths.filter(
							(storePath) =>
								!excludedTargets.has(storePathSchema.parse(storePath))
						)
					])
				]
			: !isStreamed &&
				  inputs.publish === 'closure' &&
				  selection.leftUpstream.length > 0
				? selectedTargets.length === 0
					? []
					: [
							...new Set([
								...selectedTargets,
								...(
									(await build.resolveClosure?.(
										selectedTargets.map((storePath) =>
											storePathSchema.parse(storePath)
										)
									)) ?? []
								).map((info) => info.storePath),
								...closureReferences
									.values()
									.flatMap((entries) => entries.map((entry) => entry.storePath))
							])
						]
				: publicationPaths.filter(
						(storePath) =>
							!excludedTargets.has(storePathSchema.parse(storePath))
					);
	const targetPaths = [
		...new Set([...(partition?.attachOnly ?? []), ...selectedTargets])
	].toSorted(byCodeUnit);
	const targetPathSet = new Set(targetPaths);
	const intermediatePaths = [
		...new Set([
			...selectedPublicationPaths,
			...closureReferences
				.values()
				.flatMap((entries) => entries.map((entry) => entry.storePath))
		])
	]
		.filter((storePath) => !targetPathSet.has(storePath))
		.toSorted(byCodeUnit);
	const referencePaths = partition?.publishByReference ?? [];
	const leftUpstream = [
		...new Set([...(partition?.leftUpstream ?? []), ...selection.leftUpstream])
	];

	await mkdir(path.dirname(inputs.targetPathsFile), { recursive: true });
	await mkdir(path.dirname(copiedFromFile), { recursive: true });
	await writeFile(
		copiedFromFile,
		`${JSON.stringify(Object.fromEntries(copiedFrom), undefined, 2)}\n`
	);
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

	// Remote-store builds cannot use the local post-build hook. Publish their
	// keyed daemon results once to read back NAR hashes and derivers for the
	// receipt. The receipt records these paths as held in the selected store;
	// the runner cannot attest to a build that the remote store performed.
	// Per-root pushes then reuse these paths.
	const isReconciled =
		inputs.push && inputs.store !== '' && selectedPublicationPaths.length > 0;

	let buildUploads = context.buildUploads;

	if (isReconciled) {
		const publicationPathsFile = `${inputs.targetPathsFile}.publication`;
		await writeFile(publicationPathsFile, linesOf(selectedPublicationPaths));
		const results = await runCupboard(
			inputs.cupboardPath,
			cohortReceiptPushArguments(inputs, publicationPathsFile, copiedFromFile),
			environment,
			cupboardRunDependencies
		);
		buildUploads = addUploads(buildUploads, uploadTally(results));
	}

	if (terminalFailure !== undefined) {
		await writeRemoteFailureReceipt(
			inputs.receiptFile,
			isReconciled,
			terminalFailure
		);
	}

	let publication: CohortPublication = {
		receiptFiles: [],
		rootUploads: new Map(),
		updatedRoots: new Set(),
		rootRetention: new Map()
	};
	if (inputs.push) {
		publication = await publishCohort({
			inputs,
			collectReceipts:
				(partition?.closureTargets.length ?? 0) > 0 ||
				referencePaths.length > 0,
			members,
			paths: { targetPaths, intermediatePaths, referencePaths },
			attachOnlyPaths: partition?.attachOnly ?? [],
			closureReferences,
			copiedFromFile,
			leftUpstreamPaths: leftUpstream,
			environment,
			runCupboard,
			cupboardRunDependencies,
			reporter,
			resultBuilds,
			localBuilds,
			incompleteRoots
		});
	}
	await mergeCohortReceipts(
		inputs.receiptFile,
		isStreamed || isReconciled || terminalFailure !== undefined,
		publication.receiptFiles
	);

	const receiptFile =
		isStreamed ||
		isReconciled ||
		terminalFailure !== undefined ||
		publication.receiptFiles.length > 0
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

	const uploadsBeforeRoots = addUploads(buildUploads, publication.otherUploads);
	const owners = targetPathOwners(members, { resultBuilds, localBuilds });
	const assignedUploads = attributedUploads(buildUploads, owners);
	const rootUploads = new Map(publication.rootUploads);
	for (const [root, uploads] of assignedUploads) {
		const total = addUploads(rootUploads.get(root), uploads);
		if (total !== undefined) {
			rootUploads.set(root, total);
		}
	}
	const roots = cohortRootSummaries({
		inputs,
		members,
		owners,
		paths: {
			attachOnly: new Set(partition?.attachOnly),
			reference: new Set(referencePaths),
			leftUpstream: new Set(leftUpstream),
			known: [...targetPaths, ...referencePaths, ...leftUpstream]
		},
		incompleteRoots,
		publication: { ...publication, rootUploads },
		origins: new Map(
			streamedReceipt?.subjects.map((subject) => [
				subject.storePath,
				subject.origin
			])
		)
	});

	context.reporter.result(
		cohortSummaryResult({
			durationMs: context.duration(),
			...(uploadsBeforeRoots !== undefined && {
				buildUploads: uploadsBeforeRoots
			}),
			roots
		})
	);
}

interface CohortRootSummaryInputs {
	readonly inputs: BuildCohortInputs;
	readonly members: readonly CohortMember[];
	readonly owners: ReadonlyMap<string, ReadonlySet<string>>;
	readonly paths: {
		readonly attachOnly: ReadonlySet<string>;
		readonly reference: ReadonlySet<string>;
		readonly leftUpstream: ReadonlySet<string>;
		readonly known: readonly string[];
	};
	readonly incompleteRoots: ReadonlySet<string>;
	readonly publication: CohortPublication;
	readonly origins?: ReadonlyMap<string, string>;
}

function cohortRootSummaries(
	options: CohortRootSummaryInputs
): readonly CohortRootSummary[] {
	const { inputs, paths, publication } = options;
	const retention = rootRetention(inputs.ttl, inputs.permanent);
	const outcomeOf = (storePath: string): TargetOutcome => {
		if (paths.leftUpstream.has(storePath)) {
			return 'left-upstream';
		}

		if (paths.reference.has(storePath)) {
			return 'reused';
		}

		if (paths.attachOnly.has(storePath)) {
			return 'already-served';
		}
		const origin = options.origins?.get(storePath);
		return origin === undefined || origin === 'built' ? 'built' : 'reused';
	};
	const roots = [...new Set(options.members.map((member) => member.root))];

	return roots.map((root) => {
		const ownedOutcomes = new Set(
			paths.known
				.filter((storePath) => options.owners.get(storePath)?.has(root))
				.map((storePath) => outcomeOf(storePath))
		);
		const outcomes: readonly TargetOutcome[] = options.incompleteRoots.has(root)
			? ['failed']
			: ownedOutcomes.size === 0
				? ['not-built']
				: outcomeOrder.filter((outcome) => ownedOutcomes.has(outcome));
		const uploads = publication.rootUploads.get(root);

		return {
			attrs: options.members
				.filter((member) => member.root === root)
				.map((member) => member.attr),
			root,
			outcomes,
			...(uploads !== undefined && { uploads }),
			...(publication.rootRetention.has(root) && {
				recordedRetention: publication.rootRetention.get(root)
			}),
			...(publication.updatedRoots.has(root) && { retention })
		};
	});
}

/**
 * The cohorts file one supervised `cupboard build-push` run consumes. A strict
 * build keeps every target in one cohort so they share work; a best-effort
 * build puts one target in each cohort so every failure can be attributed to
 * its target.
 */
export function buildPushCohortsFile(
	installables: readonly string[],
	maxJobs: string,
	shouldSeparateTargets = false,
	rebuildInstallables: ReadonlySet<string> = new Set()
): { readonly cohorts: readonly Record<string, unknown>[] } {
	const unique = [...new Set(installables)];
	const groups = shouldSeparateTargets
		? unique.map((installable) => [installable])
		: [
				unique.filter((installable) => !rebuildInstallables.has(installable)),
				unique.filter((installable) => rebuildInstallables.has(installable))
			].filter((group) => group.length > 0);

	return {
		cohorts: groups.map((group) => ({
			installables: group,
			...(group.every((installable) =>
				rebuildInstallables.has(installable)
			) && {
				rebuild: true
			}),
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
		| 'runRootPermanent'
		| 'receiptFile'
		| 'allBestEffort'
		| 'publish'
		| 'substituter'
	>,
	cohortsFile: string
): readonly string[] {
	return [
		'--no-colour',
		'build-push',
		canonicalHref(cacheUrlFor(inputs.url, inputs.cache)),
		'--github-oidc',
		'--no-retain',
		'--cohorts-file',
		cohortsFile,
		'--receipt-file',
		inputs.receiptFile,
		'--aggregate-receipt-v3',
		'--substituter',
		inputs.substituter,
		...(inputs.publish === 'none'
			? []
			: ['--publication-scope', inputs.publish]),
		...(inputs.audience === '' ? [] : ['--audience', inputs.audience]),
		...(inputs.gcBetweenCohorts ? ['--gc-between-cohorts'] : []),
		...(inputs.allBestEffort ? ['--keep-going-cohorts'] : []),
		...(inputs.runRoot === '' ? [] : ['--run-root', inputs.runRoot]),
		...(inputs.runRootTtl === '' ? [] : ['--run-root-ttl', inputs.runRootTtl]),
		...(inputs.runRootPermanent ? ['--run-root-permanent'] : [])
	];
}

function supervisedCohortsFile(
	dependencyBuilds: readonly RemoteDependencyBuild[],
	buildInstallables: readonly string[],
	maxJobs: string,
	shouldSeparateTargets: boolean,
	provenanceRebuilds: ReadonlySet<string>
): { readonly cohorts: readonly Record<string, unknown>[] } {
	const { cohorts } = buildPushCohortsFile(
		buildInstallables,
		maxJobs,
		shouldSeparateTargets,
		provenanceRebuilds
	);
	return {
		cohorts: cohorts.map((cohort, index) => ({
			...cohort,
			...(index === 0 &&
				dependencyBuilds.length > 0 && {
					dependencyBuilds: dependencyBuilds.map(({ path, installables }) => ({
						path,
						installables
					}))
				})
		}))
	};
}

async function runBuildPushCohort(
	inputs: BuildCohortInputs,
	buildInstallables: readonly string[],
	provenanceRebuilds: ReadonlySet<string>,
	environment: Environment,
	runCupboard: typeof defaultRunCupboard,
	cupboardRunDependencies: CupboardRunDependencies | undefined,
	dependencyBuilds: readonly RemoteDependencyBuild[] = []
): Promise<UploadTally | undefined> {
	const runnerTemporary = requireEnvironment(environment, 'RUNNER_TEMP');
	const cohortsFile = path.join(
		runnerTemporary,
		`cupboard-build-cohorts-${inputs.cohort.key}.json`
	);

	await writeFile(
		cohortsFile,
		`${JSON.stringify(
			supervisedCohortsFile(
				dependencyBuilds,
				buildInstallables,
				inputs.maxJobs,
				inputs.allBestEffort,
				provenanceRebuilds
			),
			undefined,
			2
		)}\n`
	);
	await rm(inputs.receiptFile, { force: true });

	const buildContexts = membersOf(inputs.cohort).map((member) => ({
		installables: [
			member.installable,
			...(member.queryInstallable === undefined
				? []
				: [member.queryInstallable])
		],
		attr: member.attr,
		root: member.root
	}));
	const results = await runCupboard(
		inputs.cupboardPath,
		cohortBuildPushArguments(inputs, cohortsFile),
		{
			...environment,
			CUPBOARD_BUILD_CONTEXTS: JSON.stringify(buildContexts)
		},
		{
			...cupboardRunDependencies,
			deferErrorAnnotations: inputs.allBestEffort
		}
	);
	return uploadTally(results);
}

/**
 * Arguments for the unretained push that publishes remote-store results and
 * writes their receipt. Later pushes apply each root to its complete target
 * list. Keyed daemon results identify which outputs were built by this run;
 * substituted and already-valid outputs are published without provenance
 * claims.
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
		| 'runRootPermanent'
		| 'receiptFile'
	>,
	pathsFile: string,
	copiedFromFile: string
): readonly string[] {
	return [
		'--no-colour',
		'push',
		canonicalHref(cacheUrlFor(inputs.url, inputs.cache)),
		'--paths-file',
		pathsFile,
		'--github-oidc',
		'--no-retain',
		'--store',
		inputs.store,
		'--receipt-file',
		inputs.receiptFile,
		'--copied-from-file',
		copiedFromFile,
		...(inputs.audience === '' ? [] : ['--audience', inputs.audience]),
		...(inputs.runRoot === '' ? [] : ['--run-root', inputs.runRoot]),
		...(inputs.runRootTtl === '' ? [] : ['--run-root-ttl', inputs.runRootTtl]),
		...(inputs.runRootPermanent ? ['--run-root-permanent'] : [])
	];
}

/**
One root group's own target paths, from a cohort declaring several roots.
*/
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
 * Groups target paths by retention root. For a floating or multi-output target,
 * the remote keyed results say which member produced each output, so they decide
 * the root; otherwise the predictable output paths decide it. A local path with
 * no known owner uses the first root.
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

	const rootsByPath = targetPathOwners(members, grouping);

	for (const targetPath of targetPaths) {
		if (!rootsByPath.has(targetPath)) {
			throw new CohortTargetOwnerMissingError(targetPath);
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

function targetPathOwners(
	members: readonly CohortMember[],
	grouping: Pick<CohortRootGrouping, 'resultBuilds' | 'localBuilds'>
): ReadonlyMap<string, ReadonlySet<string>> {
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
			throw new RemoteBuildOwnerMissingError(result.target);
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
			throw new LocalBuildOwnerMissingError(build.installable);
		}

		for (const output of build.outputs) {
			for (const owner of owners) {
				addOwner(output, owner.root);
			}
		}
	}

	return rootsByPath;
}

interface CohortPushExtras {
	readonly pathsFile?: string;
	readonly intermediatePathsFile: string;
	readonly referencePathsFile: string;
	readonly referenceSource: string;
	readonly referenceManifestFile?: string;
	readonly receiptFile?: string;
	readonly referenceReceiptFile?: string;
	readonly copiedFromFile?: string;
}

/**
 * The `cupboard push` arguments for one root group, including built and
 * attach-only targets so the atomic root replacement contains the complete
 * declared list. A streamed cohort's built paths negotiate as
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
		| 'permanent'
		| 'runRoot'
		| 'runRootTtl'
		| 'runRootPermanent'
		| 'readUser'
		| 'readPassword'
		| 'fallbackReadUser'
		| 'fallbackReadPassword'
		| 'reuseView'
		| 'publish'
	>,
	group: CohortRootGroup,
	extras: CohortPushExtras
): readonly string[] {
	const hasReferences = extras.referencePathsFile !== '';
	const viewSource =
		hasReferences && inputs.reuseView !== ''
			? `${canonicalHref(inputs.url)}/reuse/${inputs.reuseView}`
			: '';
	const isViewReference =
		viewSource !== '' && extras.referenceSource === viewSource;
	const readUser = isViewReference ? inputs.fallbackReadUser : inputs.readUser;
	const readPassword = isViewReference
		? inputs.fallbackReadPassword
		: inputs.readPassword;

	return [
		'--no-colour',
		'push',
		canonicalHref(cacheUrlFor(inputs.url, inputs.cache)),
		...(extras.pathsFile === undefined
			? group.paths
			: ['--paths-file', extras.pathsFile]),
		'--github-oidc',
		...(group.complete ? ['--root', group.root] : ['--no-retain']),
		...(inputs.audience === '' ? [] : ['--audience', inputs.audience]),
		...(inputs.store === '' &&
		(extras.receiptFile === undefined || extras.receiptFile === '')
			? []
			: ['--store', inputs.store || 'auto']),
		...(inputs.publish === 'closure' ? ['--closure'] : []),
		...(inputs.ttl !== '' && group.complete ? ['--ttl', inputs.ttl] : []),
		...(inputs.permanent && group.complete ? ['--permanent'] : []),
		...(extras.intermediatePathsFile === ''
			? []
			: ['--intermediate-paths-file', extras.intermediatePathsFile]),
		...(extras.referencePathsFile === ''
			? []
			: [
					'--reference-paths-file',
					extras.referencePathsFile,
					'--reference-source',
					extras.referenceSource
				]),
		...(extras.referenceManifestFile === undefined
			? []
			: ['--reference-manifest', extras.referenceManifestFile]),
		...(readUser !== '' && hasReferences
			? ['--read-user', readUser, '--read-password', readPassword]
			: []),
		...(extras.receiptFile === undefined || extras.receiptFile === ''
			? []
			: [
					'--receipt-file',
					extras.receiptFile,
					...(extras.copiedFromFile === undefined
						? []
						: ['--copied-from-file', extras.copiedFromFile])
				]),
		...(extras.referenceReceiptFile === undefined ||
		extras.referenceReceiptFile === ''
			? []
			: ['--reference-receipt-file', extras.referenceReceiptFile]),
		...(inputs.runRoot === '' ? [] : ['--run-root', inputs.runRoot]),
		...(inputs.runRootTtl === '' ? [] : ['--run-root-ttl', inputs.runRootTtl]),
		...(inputs.runRootPermanent ? ['--run-root-permanent'] : [])
	];
}

interface PublishCohortOptions {
	readonly inputs: BuildCohortInputs;
	readonly collectReceipts: boolean;
	readonly copiedFromFile: string;
	readonly members: readonly CohortMember[];
	readonly paths: {
		readonly targetPaths: readonly string[];
		readonly intermediatePaths: readonly string[];
		readonly referencePaths: readonly string[];
	};
	readonly attachOnlyPaths: readonly string[];
	readonly closureReferences: ReadonlyMap<
		string,
		readonly CachedClosureReference[]
	>;
	readonly leftUpstreamPaths: readonly string[];
	readonly environment: Environment;
	readonly runCupboard: typeof defaultRunCupboard;
	readonly cupboardRunDependencies: CupboardRunDependencies | undefined;
	readonly reporter: Reporter;
	readonly resultBuilds: readonly NixBuildResult[];
	readonly localBuilds: readonly CohortOwnedBuild[];
	readonly incompleteRoots: ReadonlySet<string>;
}

async function writeReferenceManifest(
	file: string,
	paths: ReferencePublicationManifestInput['paths']
): Promise<void> {
	const manifest = referencePublicationManifestSchema.parse({
		version: 1,
		paths
	});
	await writeFile(file, `${JSON.stringify(manifest)}\n`);
}

/**
 * A reference path has no local bytes, so an upload-stage failure means that
 * the destination requested them.
 */
function reportReferenceUploads(
	reporter: Reporter,
	error: unknown,
	members: readonly CohortMember[],
	sources: ReadonlyMap<string, string>
): void {
	if (!(error instanceof CupboardReportedError)) {
		return;
	}

	const summary = error.results
		.filter((event) => event.kind === pushSummaryResultKind)
		.map((event) => pushSummarySchema.safeParse(event.data))
		.find((parsed) => parsed.success)?.data;

	const uploads = (summary?.failures ?? []).flatMap((failure) => {
		const source = sources.get(failure.storePath);

		return source !== undefined && failure.stage === 'upload'
			? [{ storePath: failure.storePath, source }]
			: [];
	});

	for (const failure of uploads) {
		const attributes = members
			.filter((member) => member.expectedPath === failure.storePath)
			.map((member) => member.attr);
		const target =
			attributes.length === 0
				? failure.storePath
				: `${attributes.join(', ')} (${failure.storePath})`;

		reporter.warn(
			'cannot publish by reference',
			`${target} from ${failure.source}: the destination requested an upload, but this run has no bytes for the path. Check the push token's read access to the source and whether the tenant still stores the NAR.`
		);
	}
}

function sourcesOf(
	referencePaths: readonly string[],
	source: string
): ReadonlyMap<string, string> {
	return new Map(referencePaths.map((storePath) => [storePath, source]));
}

function manifestSources(
	entries: readonly { readonly storePath: string; readonly source: string }[]
): ReadonlyMap<string, string> {
	return new Map(entries.map((entry) => [entry.storePath, entry.source]));
}

interface CohortPublication {
	readonly receiptFiles: readonly string[];
	readonly rootUploads: ReadonlyMap<string, UploadTally>;
	readonly rootRetention: ReadonlyMap<string, RootSummary>;
	readonly updatedRoots: ReadonlySet<string>;
	readonly otherUploads?: UploadTally;
}

async function publishCohort(
	options: PublishCohortOptions
): Promise<CohortPublication> {
	const {
		inputs,
		members,
		paths,
		environment,
		runCupboard,
		cupboardRunDependencies,
		reporter,
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
		cacheUrlFor(inputs.url, inputs.cache)
	);
	const attachOnly = new Set(options.attachOnlyPaths);
	const targetPathsFile = async (
		index: number,
		localPaths: readonly string[]
	): Promise<Pick<CohortPushExtras, 'pathsFile'>> => {
		if (localPaths.length === 0) {
			return {};
		}

		const pathsFile = `${inputs.targetPathsFile}.${String(index)}`;
		await writeFile(pathsFile, linesOf(localPaths));
		return { pathsFile };
	};
	const hasIntermediates = paths.intermediatePaths.length > 0;
	const receiptFiles: string[] = [];
	const rootUploads = new Map<string, UploadTally>();
	const updatedRoots = new Set<string>();
	const rootRetention = new Map<string, RootSummary>();
	let otherUploads: UploadTally | undefined;
	const push = async (
		group: CohortRootGroup | undefined,
		arguments_: readonly string[],
		sources: ReadonlyMap<string, string>
	): Promise<void> => {
		let results: readonly ReporterResultEvent[];

		try {
			results = await runCupboard(
				inputs.cupboardPath,
				arguments_,
				environment,
				cupboardRunDependencies
			);
		} catch (error) {
			reportReferenceUploads(reporter, error, members, sources);
			throw error;
		}

		const uploads = uploadTally(results);
		for (const root of recordedRoots(results)) {
			rootRetention.set(root.name, root);
		}

		if (group === undefined) {
			otherUploads = addUploads(otherUploads, uploads);
			return;
		}

		const recorded = addUploads(rootUploads.get(group.root), uploads);

		if (recorded !== undefined) {
			rootUploads.set(group.root, recorded);
		}

		if (group.complete) {
			updatedRoots.add(group.root);
		}
	};
	const receiptForPush = (
		index: number,
		kind: string,
		localPaths: readonly string[],
		referencePathsFile: string,
		intermediatePathsFile: string
	): Pick<
		CohortPushExtras,
		'receiptFile' | 'referenceReceiptFile' | 'copiedFromFile'
	> => {
		if (!options.collectReceipts) {
			return {};
		}

		const hasFullReceipt =
			(inputs.store === '' && inputs.publish === 'closure') ||
			(referencePathsFile !== '' &&
				(localPaths.length > 0 || intermediatePathsFile !== ''));
		const hasReferenceReceipt = referencePathsFile !== '' && !hasFullReceipt;

		if (!hasFullReceipt && !hasReferenceReceipt) {
			return {};
		}

		const receiptFile = `${inputs.receiptFile}.${String(index)}.${kind}`;
		receiptFiles.push(receiptFile);

		return hasFullReceipt
			? { receiptFile, copiedFromFile: options.copiedFromFile }
			: { referenceReceiptFile: receiptFile };
	};
	const selected = new Set(allTargetPaths);
	const prepared = new Map<string, { source: string; narinfo: string }>();
	const referenceIntermediates: ReferencePublicationManifestInput['paths'] = [];
	for (const [source, references] of options.closureReferences) {
		for (const reference of references) {
			prepared.set(reference.storePath, { source, narinfo: reference.narinfo });
			if (!selected.has(reference.storePath)) {
				referenceIntermediates.push({
					...reference,
					source,
					kind: 'intermediate'
				});
			}
		}
	}
	if (referenceIntermediates.length > 0) {
		const referenceManifestFile = `${inputs.referencePathsFile}.closure.json`;
		await writeReferenceManifest(referenceManifestFile, referenceIntermediates);
		const receiptFile = `${inputs.receiptFile}.closure`;
		receiptFiles.push(receiptFile);
		await push(
			undefined,
			cohortPushArguments(
				inputs,
				{ root: '', paths: [], referencePaths: [], complete: false },
				{
					intermediatePathsFile: '',
					referencePathsFile: '',
					referenceManifestFile,
					referenceSource: '',
					referenceReceiptFile: receiptFile
				}
			),
			manifestSources(referenceIntermediates)
		);
	}
	for (const [index, group] of groups.entries()) {
		const cachedTargets = group.paths.flatMap((storePath) => {
			const reference = prepared.get(storePath);
			return reference === undefined
				? []
				: [{ storePath, kind: 'target' as const, ...reference }];
		});
		if (cachedTargets.length > 0) {
			const cached = new Set(cachedTargets.map((entry) => entry.storePath));
			const localPaths = group.paths.filter(
				(storePath) => !cached.has(storePath)
			);
			const targetExtras = await targetPathsFile(index, localPaths);
			const referenceManifestFile = `${inputs.referencePathsFile}.${String(index)}.json`;
			await writeReferenceManifest(referenceManifestFile, cachedTargets);
			const receiptFile = `${inputs.receiptFile}.${String(index)}.manifest`;
			receiptFiles.push(receiptFile);
			await push(
				group,
				cohortPushArguments(
					inputs,
					{
						...group,
						paths: localPaths
					},
					{
						...targetExtras,
						intermediatePathsFile:
							index === 0 && hasIntermediates
								? inputs.intermediatePathsFile
								: '',
						referencePathsFile: '',
						referenceSource: '',
						referenceManifestFile,
						receiptFile,
						copiedFromFile: options.copiedFromFile
					}
				),
				manifestSources(cachedTargets)
			);
			continue;
		}
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
					throw new ReuseViewRequiredError();
				}

				await writeFile(referencePathsFile, linesOf(group.referencePaths));
			}

			const intermediatePathsFile =
				index === 0 && hasIntermediates ? inputs.intermediatePathsFile : '';
			const localPaths = group.paths.filter(
				(storePath) => !group.referencePaths.includes(storePath)
			);
			const receiptExtras = receiptForPush(
				index,
				'main',
				localPaths,
				referencePathsFile,
				intermediatePathsFile
			);
			const targetExtras = await targetPathsFile(index, localPaths);
			await push(
				group,
				cohortPushArguments(
					inputs,
					{ ...group, paths: localPaths },
					{
						...targetExtras,
						intermediatePathsFile,
						referencePathsFile,
						referenceSource: referencePathsFile === '' ? '' : referenceSource,
						...receiptExtras
					}
				),
				sourcesOf(group.referencePaths, referenceSource)
			);
			continue;
		}

		if (group.referencePaths.length > 0) {
			if (referenceSource === '') {
				throw new ReuseViewRequiredError();
			}

			const reusePathsFile = `${inputs.referencePathsFile}.reuse.${String(index)}`;
			await writeFile(reusePathsFile, linesOf(group.referencePaths));
			await push(
				{ ...group, complete: false },
				cohortPushArguments(
					inputs,
					{ ...group, paths: [], complete: false },
					{
						intermediatePathsFile: '',
						referencePathsFile: reusePathsFile,
						referenceSource,
						...receiptForPush(index, 'reuse', [], reusePathsFile, '')
					}
				),
				sourcesOf(group.referencePaths, referenceSource)
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

		const localPaths = group.paths.filter(
			(targetPath) => !destinationPaths.includes(targetPath)
		);
		const intermediatePathsFile =
			index === 0 && hasIntermediates ? inputs.intermediatePathsFile : '';
		const targetExtras = await targetPathsFile(index, localPaths);
		await push(
			group,
			cohortPushArguments(
				inputs,
				{
					...group,
					paths: localPaths
				},
				{
					...targetExtras,
					intermediatePathsFile,
					referencePathsFile: destinationPathsFile,
					referenceSource: destinationPathsFile === '' ? '' : destinationSource,
					...receiptForPush(
						index,
						'destination',
						localPaths,
						destinationPathsFile,
						intermediatePathsFile
					)
				}
			),
			sourcesOf(destinationPaths, destinationSource)
		);
	}

	return {
		receiptFiles,
		rootUploads,
		rootRetention,
		updatedRoots,
		...(otherUploads !== undefined && { otherUploads })
	};
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
 * the build set and into the list the re-probe classified it under, so the
 * target paths, the reference paths and the pushes that set the target roots
 * all read one partition rather than two. The `leftUpstream` list keeps the
 * plan's own entries, because the re-probe classifies a withdrawn target only
 * as `attachOnly` or `publishByReference`.
 */
export function withdrawFromPartition(
	partition: PartitionData,
	withdrawn: readonly WithdrawnTargetData[],
	shouldPublishClosure = false
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
		closureTargets: shouldPublishClosure
			? [
					...new Set([
						...partition.closureTargets,
						...withdrawn.map((target) => target.storePath)
					])
				]
			: partition.closureTargets,
		buildSet: partition.buildSet.filter(
			(installable) => !withdrawnInstallables.has(installable)
		)
	};
}

// Recheck the destination and reuse view through `cupboard plan reprobe`. This
// optimisation is best-effort: a failed check preserves the original build set
// and reports the reason.
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
			'Availability confirmation failed; building the complete cohort build set',
			error instanceof Error ? error.message : String(error)
		);

		return undefined;
	}

	return planReprobeResult(results, reporter);
}

/**
One build-set member in the confirmation targets file.
*/
interface ReprobeTargetEntry {
	readonly attr: string;
	readonly installable: string;
	readonly expectedPath: string;
	readonly root: string;
}

// Reprobe only members with predictable output paths. Floating outputs remain
// on the build set.
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
 * The `cupboard plan reprobe` arguments for one cohort. The command reads cache
 * endpoints without exchanging a token or opening a Nix store. It uses the
 * run's read credentials for a cache.
 */
export function planReprobeArguments(
	inputs: Pick<
		BuildCohortInputs,
		| 'url'
		| 'cache'
		| 'reuseView'
		| 'readUser'
		| 'readPassword'
		| 'fallbackReadUser'
		| 'fallbackReadPassword'
	>,
	targetsFile: string
): readonly string[] {
	const arguments_ = [
		'--no-colour',
		'plan',
		'reprobe',
		canonicalHref(cacheUrlFor(inputs.url, inputs.cache)),
		'--targets-file',
		targetsFile
	];

	if (inputs.reuseView !== '') {
		arguments_.push('--reuse-view', inputs.reuseView);
		if (inputs.fallbackReadUser !== '') {
			arguments_.push(
				'--view-read-user',
				inputs.fallbackReadUser,
				'--view-read-password',
				inputs.fallbackReadPassword
			);
		}
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
			'Availability confirmation returned an invalid result; building the complete cohort build set',
			z.prettifyError(parsed.error)
		);

		return undefined;
	}

	reporter.warn(
		'Availability confirmation returned no result; building the complete cohort build set'
	);

	return undefined;
}

async function planCohort(
	inputs: BuildCohortInputs,
	queryable: readonly CohortMember[],
	environment: Environment,
	runCupboard: typeof defaultRunCupboard,
	cupboardRunDependencies: CupboardRunDependencies | undefined,
	plannedLocalGraph: LocalDerivationGraph | undefined
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
	const shouldRecordPlannedDerivations =
		inputs.store !== '' || plannedLocalGraph !== undefined;

	await writeFile(
		targetsFile,
		`${JSON.stringify(
			{
				targets: queryable.map((member) => ({
					attr: member.attr,
					installable: member.queryInstallable,
					...(shouldRecordPlannedDerivations && {
						plannedLocalDerivation: derivationPathOf(
							nixDerivedPathSchema.parse(member.queryInstallable)
						)
					}),
					...(member.expectedPath !== undefined && {
						expectedPath: member.expectedPath
					}),
					root: member.root
				})),
				...(plannedLocalGraph !== undefined && {
					plannedLocalClosure: plannedLocalGraph.closure,
					...(plannedLocalGraph.substitutableDerivations.length > 0 && {
						plannedSubstitutableDerivations:
							plannedLocalGraph.substitutableDerivations
					}),
					...(plannedLocalGraph.floatingOutputs.length > 0 && {
						plannedFloatingOutputs: plannedLocalGraph.floatingOutputs
					}),
					...(plannedLocalGraph.outputs.length > 0 && {
						plannedLocalOutputs: plannedLocalGraph.outputs
					})
				})
			},
			undefined,
			2
		)}\n`
	);

	const arguments_ = [
		'--no-colour',
		'plan',
		'cohort',
		canonicalHref(cacheUrlFor(inputs.url, inputs.cache)),
		'--targets-file',
		targetsFile,
		'--plan-file',
		planFile,
		'--github-oidc',
		'--build',
		inputs.build,
		'--substituter',
		inputs.substituter,
		'--publish',
		inputs.publish,
		...(inputs.audience === '' ? [] : ['--audience', inputs.audience]),
		...(inputs.reuseView === '' ? [] : ['--reuse-view', inputs.reuseView]),
		...(inputs.reuseView !== '' && inputs.fallbackReadUser !== ''
			? [
					'--view-read-user',
					inputs.fallbackReadUser,
					'--view-read-password',
					inputs.fallbackReadPassword
				]
			: []),
		...(inputs.ttl === '' ? [] : ['--ttl', inputs.ttl]),
		...(inputs.permanent ? ['--permanent'] : []),
		...(inputs.readUser === ''
			? []
			: [
					'--read-user',
					inputs.readUser,
					'--read-password',
					inputs.readPassword
				]),
		...(inputs.store === '' ? [] : ['--store', inputs.store])
	];

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
			wasReported: error instanceof CupboardReportedError && error.wasReported
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
 * out-links are kept under a directory this invocation owns, which protects its
 * closure until publication finishes. A remote non-publishing build also
 * receives the argument, but its out-link exists only in the local filesystem
 * and is not a GC root on the remote store. Because of `--keep-going`, a cohort
 * with one failing derivation still reports whatever `--print-out-paths` prints
 * for the survivors; a failure that reports no target results at all is treated
 * as a command failure. A configured remote store owns the build: `--store`
 * sends the results there while `--eval-store auto` keeps evaluation on the
 * runner, so the built closure never enters the runner's local store.
 */
export function nixBuildArguments(
	installables: readonly string[],
	maxJobs: string,
	store: string,
	outLinkDirectory: string,
	logFile: string,
	options: {
		readonly rebuild?: boolean;
		readonly outLink?: boolean;
		readonly disableRemoteBuilders?: boolean;
	} = {}
): readonly string[] {
	return [
		'build',
		...(options.rebuild === true ? ['--rebuild'] : []),
		...(options.rebuild === true || options.disableRemoteBuilders === true
			? ['--option', 'builders', '']
			: []),
		'--keep-going',
		'--print-out-paths',
		...(options.outLink === false
			? ['--no-link']
			: ['--out-link', path.join(outLinkDirectory, 'result')]),
		// The log records the store each copied path was read from. For a path
		// the run substituted rather than built, that record is how the receipt
		// can say where the path came from.
		'--option',
		'json-log-path',
		logFile,
		...(maxJobs === '' ? [] : ['--max-jobs', maxJobs]),
		...(store === '' ? [] : ['--store', store, '--eval-store', 'auto']),
		'--',
		...installables
	];
}

interface PlannedTargetBinding {
	readonly target: NixDerivedPathString;
	readonly derivation: StorePathString;
	readonly installables: readonly string[];
}

interface RemoteCohortPreparation {
	readonly bindings: readonly PlannedTargetBinding[];
	readonly graph: LocalDerivationGraph;
}

type CohortExecution =
	| { readonly kind: 'local'; readonly graph?: LocalDerivationGraph }
	| { readonly kind: 'remote'; readonly preparation: RemoteCohortPreparation };

function retainedDependencyBuilds(
	partition: PartitionData | undefined,
	buildInstallables: readonly string[]
): readonly RemoteDependencyBuild[] {
	if (partition === undefined || buildInstallables.length === 0) {
		return [];
	}

	const retainedTargets = new Set(
		buildInstallables.flatMap((target) => {
			const parsed = nixDerivedPathSchema.safeParse(target);

			return parsed.success ? [canonicalNixDerivedPath(parsed.data)] : [];
		})
	);

	return partition.dependencyBuilds.flatMap((dependency) => {
		const requiredBy = dependency.requiredBy.filter((target) =>
			retainedTargets.has(canonicalNixDerivedPath(target))
		);

		return requiredBy.length === 0 ? [] : [{ ...dependency, requiredBy }];
	});
}

async function realiseLocalDependencies(
	dependencies: readonly RemoteDependencyBuild[],
	inputs: Pick<BuildCohortInputs, 'maxJobs' | 'store' | 'outLinkDirectory'>,
	runNix: typeof runNixBuild,
	signal?: AbortSignal
): Promise<void> {
	for (const [dependencyIndex, dependency] of dependencies.entries()) {
		const outcome = await realiseLocalDependency(
			dependency,
			dependencyIndex,
			inputs,
			runNix,
			signal
		);

		if (outcome === 'unavailable') {
			throw new LocalDependencyBuildFailedError(
				dependency.path,
				dependency.installables
			);
		}
	}
}

async function realiseLocalDependency(
	dependency: RemoteDependencyBuild,
	dependencyIndex: number,
	inputs: Pick<BuildCohortInputs, 'maxJobs' | 'store' | 'outLinkDirectory'>,
	runNix: typeof runNixBuild,
	signal?: AbortSignal
): Promise<'realised' | 'unavailable'> {
	for (const [
		candidateIndex,
		installable
	] of dependency.installables.entries()) {
		const result = await runNix(
			[installable],
			inputs.maxJobs,
			inputs.store,
			path.join(
				inputs.outLinkDirectory,
				'dependencies',
				String(dependencyIndex),
				String(candidateIndex)
			),
			signal
		);

		if (result.paths.includes(dependency.path)) {
			return 'realised';
		}
	}

	return 'unavailable';
}

function plannedTargetBindings(
	members: readonly CohortMember[],
	targets: readonly NixDerivedPathString[]
): readonly PlannedTargetBinding[] {
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
			throw new PlannedTargetSourceMissingError(target);
		}

		return {
			target,
			derivation: derivationPathOf(target),
			installables: [...new Set(matches.map((member) => member.installable))]
		};
	});
}

// Each per-installable drift evaluation runs its own `nix` process; a small
// fan-out keeps a large cohort's evaluations from running one at a time.
const maximumConcurrentEvaluations = 4;

async function materialisePlannedDerivations(
	members: readonly CohortMember[],
	targets: readonly NixDerivedPathString[],
	runDerivationShow: typeof runNixDerivationShow,
	materialiseGraph: typeof materialiseDerivationGraph,
	signal?: AbortSignal
): Promise<readonly PlannedTargetBinding[]> {
	const bindings = plannedTargetBindings(members, targets);

	if (bindings.length === 0) {
		return [];
	}

	const installables = [
		...new Set(bindings.flatMap((binding) => binding.installables))
	];

	// Materialising the graph writes every derivation the build and `nix
	// copy` need into the store; the individual evaluations preserve the
	// one-to-one drift check.
	await materialiseGraph(installables, signal);
	const evaluations = await mapWithConcurrency(
		bindings.flatMap((binding) =>
			binding.installables.map((installable) => ({ binding, installable }))
		),
		maximumConcurrentEvaluations,
		async ({ binding, installable }) => ({
			binding,
			installable,
			evaluated: await runDerivationShow([installable], signal, false)
		})
	);

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
		throw new CohortEvaluationDriftError(mismatches);
	}

	return bindings;
}

function derivationPathOf(target: NixDerivedPathString): StorePathString {
	const selection = target.indexOf('^');
	const storePath = selection === -1 ? target : target.slice(0, selection);

	if (!storePath.endsWith('.drv')) {
		throw new PlannedTargetNotDerivationError(target);
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

/**
Local derivation-graph evaluation argv for the cohort's flake installables.
*/
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

/**
A Nix child whose stdout is captured until the complete process closes.
*/
export interface CapturedNixProcess extends AbortableChildProcessLifecycle {
	onStdout(listener: (chunk: string) => void): void;
}

/**
The injectable process launcher shared by captured-output Nix commands.
*/
export interface CapturedNixProcessDependencies {
	readonly start: (
		arguments_: readonly string[],
		signal: AbortSignal | undefined
	) => CapturedNixProcess;
	readonly maximumStdoutBytes?: number;
	readonly scheduler?: ChildProcessEscalationScheduler;
}

export interface RunNixBuildOptions extends Partial<CapturedNixProcessDependencies> {
	readonly rebuild?: boolean;
	readonly buildSettings?: NixBuildSettings;
	readonly nix?: Pick<
		Nix,
		'readDerivation' | 'queryValidPaths' | 'queryPathInfo'
	>;
	readonly evaluationNix?: Pick<Nix, 'readDerivation'>;
}

export interface NixDerivationShowDependencies {
	readonly evalStore?: string;
	readonly start?: CapturedNixProcessDependencies['start'];
	readonly maximumStdoutBytes?: number;
	readonly scheduler?: ChildProcessEscalationScheduler;
}

/**
Maximum stdout retained from a Nix derivation or build subprocess.
*/
const maximumCapturedNixStdoutBytes = 16 * 1024 * 1024;

function startCapturedNixProcess(
	arguments_: readonly string[],
	_signal: AbortSignal | undefined
): CapturedNixProcess {
	const child = spawn('nix', arguments_, {
		stdio: ['ignore', 'pipe', 'inherit']
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
	command: string,
	arguments_: readonly string[],
	signal: AbortSignal | undefined,
	dependencies: CapturedNixProcessDependencies
): Promise<{
	readonly signal: NodeJS.Signals | undefined;
	readonly status: number | null;
	readonly stdout: string;
}> {
	const child = dependencies.start(arguments_, signal);
	const outputLimit = new AbortController();
	const lifecycleSignal =
		signal === undefined
			? outputLimit.signal
			: AbortSignal.any([signal, outputLimit.signal]);
	const maximumStdoutBytes =
		dependencies.maximumStdoutBytes ?? maximumCapturedNixStdoutBytes;
	let stdout = '';
	let capturedBytes = 0;

	child.onStdout((chunk) => {
		if (outputLimit.signal.aborted) {
			return;
		}

		const observedBytes = capturedBytes + Buffer.byteLength(chunk);

		if (observedBytes > maximumStdoutBytes) {
			outputLimit.abort(
				new CommandOutputTooLargeError(
					command,
					maximumStdoutBytes,
					observedBytes
				)
			);
			return;
		}

		capturedBytes = observedBytes;
		stdout += chunk;
	});

	const result = await waitForAbortableChildProcess(
		child,
		lifecycleSignal,
		dependencies.scheduler
	);

	if (result.error !== undefined) {
		throw result.error;
	}

	return { signal: result.signal, status: result.status, stdout };
}

/**
Parse derivation paths from the pinned Nix v4 or legacy flat JSON shape.
*/
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

/**
Evaluate and materialise a cohort's complete derivation graph locally.
*/
export async function runNixDerivationShow(
	installables: readonly string[],
	signal?: AbortSignal,
	isRecursive = true,
	dependencies: NixDerivationShowDependencies = {}
): Promise<readonly (StorePathBasename | StorePathString)[]> {
	signal?.throwIfAborted();
	const processDependencies: CapturedNixProcessDependencies = {
		start: dependencies.start ?? defaultCapturedNixProcessDependencies.start,
		...(dependencies.maximumStdoutBytes !== undefined && {
			maximumStdoutBytes: dependencies.maximumStdoutBytes
		}),
		...(dependencies.scheduler !== undefined && {
			scheduler: dependencies.scheduler
		})
	};

	const {
		signal: terminationSignal,
		status,
		stdout
	} = await runCapturedNixProcess(
		'nix derivation show',
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

/**
 * The evaluation store and process launcher for
 * {@link materialiseDerivationGraph}.
 */
export interface MaterialiseDerivationGraphDependencies {
	readonly evalStore?: string;
	readonly start?: (
		arguments_: readonly string[],
		signal: AbortSignal | undefined
	) => AbortableChildProcessLifecycle;
}

function startDiscardedNixProcess(
	arguments_: readonly string[],
	_signal: AbortSignal | undefined
): AbortableChildProcessLifecycle {
	const child = spawn('nix', arguments_, {
		stdio: ['ignore', 'ignore', 'inherit']
	});

	return observeChildProcess(child);
}

/**
 * Evaluates a cohort's complete derivation graph and materialises every
 * derivation in the evaluation store. The JSON can exceed a pipe's buffer for
 * a large closure, so discard it at the child process rather than capturing it.
 */
export async function materialiseDerivationGraph(
	installables: readonly string[],
	signal?: AbortSignal,
	dependencies: MaterialiseDerivationGraphDependencies = {}
): Promise<void> {
	signal?.throwIfAborted();

	const result = await waitForAbortableChildProcess(
		(dependencies.start ?? startDiscardedNixProcess)(
			nixDerivationShowArguments(
				installables,
				true,
				dependencies.evalStore ?? 'auto'
			),
			signal
		),
		signal
	);

	if (result.error !== undefined) {
		throw result.error;
	}

	if (result.status !== 0) {
		throw new CommandFailedError('nix derivation show', result.status);
	}
}

/**
An output whose path is declared by a derivation in the local graph.
*/
export interface LocalDerivationOutput {
	readonly path: StorePathString;
	readonly installable: NixDerivedPathString;
}

/**
The local derivation graph that the action passes to cohort planning.
*/
export interface LocalDerivationGraph {
	readonly dependencyOutputs?: readonly DependencyOutput[];
	/**
	The closure of the top-level derivations.
	*/
	readonly closure: readonly StorePathString[];
	/**
	Derivations whose own policy permits Nix to substitute their outputs.
	*/
	readonly substitutableDerivations: readonly StorePathString[];
	/**
	Derived-path installables whose output paths the derivation does not declare.
	*/
	readonly floatingOutputs: readonly NixDerivedPathString[];
	/**
	The declared outputs with known paths from the derivations in `closure`.
	*/
	readonly outputs: readonly LocalDerivationOutput[];
}

const maximumConcurrentGraphReads = 4;

/**
The Nix operations used to inspect a materialised local derivation graph.
*/
export type LocalDerivationGraphReader = Pick<
	Nix,
	'readDerivation' | 'resolveClosure'
>;

/**
Dependencies for reading a materialised local derivation graph.
*/
export interface LocalDerivationGraphDependencies {
	readonly openNix?: (signal?: AbortSignal) => LocalDerivationGraphReader;
}

const defaultLocalDerivationGraphReader = (
	signal?: AbortSignal
): LocalDerivationGraphReader =>
	Nix.openForAvailability(undefined, {
		...(signal !== undefined && { signal })
	});

/**
Returns the closure of the top-level derivations, their declared outputs with
known paths, and the derivations whose own policy permits substitution. Each
output entry pairs its store path with the derived-path installable that selects
it.
*/
export async function resolveLocalDerivationGraph(
	derivations: readonly StorePathString[],
	signal?: AbortSignal,
	dependencies: LocalDerivationGraphDependencies = {}
): Promise<LocalDerivationGraph> {
	if (derivations.length === 0) {
		return {
			dependencyOutputs: [],
			closure: [],
			floatingOutputs: [],
			substitutableDerivations: [],
			outputs: []
		};
	}

	const nix = (dependencies.openNix ?? defaultLocalDerivationGraphReader)(
		signal
	);
	const closure = await nix.resolveClosure(derivations);
	const derivationPaths = closure
		.map(({ storePath }) => storePath)
		.filter((storePath) => storePath.endsWith('.drv'));
	const parsedDerivations = await mapWithConcurrency(
		derivationPaths,
		maximumConcurrentGraphReads,
		async (derivation) => ({
			derivation,
			term: await nix.readDerivation(derivation)
		})
	);

	const terms = new Map(
		parsedDerivations.map(({ derivation, term }) => [derivation, term])
	);
	const requiredOutputs = await dependencyOutputs(derivations, {
		readDerivation: (path) => {
			const term = terms.get(path);
			return term === undefined
				? nix.readDerivation(path)
				: Promise.resolve(term);
		},
		...(signal !== undefined && { signal })
	});
	return {
		dependencyOutputs: requiredOutputs,
		closure: closure.map(({ storePath }) => storePath),
		floatingOutputs: parsedDerivations.flatMap(({ derivation, term }) =>
			term.outputs
				.entries()
				.flatMap(([name, output]) =>
					output === undefined
						? [nixDerivedPathSchema.parse(`${derivation}^${name}`)]
						: []
				)
				.toArray()
		),
		substitutableDerivations: parsedDerivations
			.filter(({ term }) => term.allowsSubstitutes)
			.map(({ derivation }) => derivation),
		outputs: parsedDerivations.flatMap(({ derivation, term }) =>
			term.outputs
				.entries()
				.flatMap(([name, output]) =>
					output === undefined
						? []
						: [
								{
									path: output,
									installable: nixDerivedPathSchema.parse(
										`${derivation}^${name}`
									)
								}
							]
				)
				.toArray()
		)
	};
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
): {
	readonly nix: Pick<Nix, 'withConnection'>;
	readonly copyStoreUri: LocalStoreUri;
} {
	const openNix = dependencies.openNix ?? defaultOpenNixForAvailability;

	try {
		return {
			nix: openNix(systemDaemonRootStoreOptions(signal)),
			copyStoreUri: 'daemon'
		};
	} catch (error) {
		if (!(error instanceof NixDaemonUnavailableError)) {
			throw error;
		}

		return {
			nix: openNix(localDerivationRootStoreOptions(signal, dependencies)),
			copyStoreUri: 'local'
		};
	}
}

/**
 * Keeps planned derivations and their materialised closure live during use.
 * A multi-user installation roots them through its system daemon. A
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
	const { nix } = openLocalDerivationRootStore(signal, dependencies);

	return nix.withConnection(async (session) => {
		const uniqueDerivations = new Set(derivations);

		for (const derivation of uniqueDerivations) {
			await session.addTempRoot(derivation);
		}

		return use();
	});
}

/**
 * Copies the required local store paths to the remote build store.
 */
export async function runNixCopy(
	paths: readonly StorePathString[],
	store: string,
	signal?: AbortSignal,
	dependencies: NixCopyDependencies = {}
): Promise<void> {
	await copyNixPaths({ paths, to: store }, signal, dependencies);
}

/**
Daemon settings shared by every queryable target in a remote cohort.
*/
export function remoteBuildSetOptions(maxJobs: string): NixDaemonSetOptions {
	return maxJobs === '' ? {} : { maxBuildJobs: Number(maxJobs) };
}

type RemoteBuildPublisher = (
	results: readonly NixBuildResult[],
	failures: readonly RemoteCohortBuildFailure[],
	publicationPaths: readonly StorePathString[],
	provenanceRebuilds: ReadonlySet<NixDerivedPathString>,
	copiedFrom: ReadonlyMap<StorePathString, readonly string[]>,
	resolveClosure?: (
		paths: readonly StorePathString[]
	) => ReturnType<Nix['resolveClosure']>
) => Promise<void>;

/**
 * Copies selected local paths and realises dependencies and cohort targets
 * through one connection to the remote store. The connection protects the
 * copied paths and every realised output until publication finishes. Keyed
 * results distinguish current builds from substitutions and paths that became
 * valid before Nix started them.
 */
export async function runNixBuildWithResults(
	installables: readonly NixDerivedPathString[],
	maxJobs: string,
	store: string,
	publish: RemoteBuildPublisher,
	signal?: AbortSignal,
	options?: RemoteBuildSessionOptions
): Promise<void> {
	const discovered = Nix.openForAvailability(undefined, {
		storeUri: store,
		...(options?.rebuild === true && { disableRemoteBuilders: true }),
		...(signal !== undefined && { signal })
	});
	const nix =
		maxJobs === '' || discovered.preservesDaemonOptions
			? discovered
			: Nix.openForAvailability(undefined, {
					storeUri: store,
					...(options?.rebuild === true && { disableRemoteBuilders: true }),
					setOptions: remoteBuildSetOptions(maxJobs),
					...(signal !== undefined && { signal })
				});

	// The store reports each copy on the connection that requested the build.
	// Publication runs before that connection closes, so the client has recorded
	// every path the build fetched.
	await nix.withConnection((session) =>
		buildAndRootNixResults(
			session,
			installables,
			(results, failures, publicationPaths, provenanceRebuilds) =>
				publish(
					results,
					failures,
					publicationPaths,
					provenanceRebuilds,
					nix.observedCopies(),
					(paths) => session.resolveClosure(paths)
				),
			options
		)
	);
}

/**
 * Options for work that shares the remote daemon session. The connection
 * protects copied paths and realised outputs until publication finishes.
 */
export interface RemoteBuildSessionOptions {
	/**
	Local store paths whose copied closures the session must protect.
	*/
	readonly copyPaths: readonly StorePathString[];
	/**
	Copies those paths after their temporary roots exist.
	*/
	copy(): Promise<void>;
	/**
	Derived-path installables to realise before the cohort targets. Their
	derivations are included in `copyPaths`.
	*/
	readonly dependencyBuilds?: readonly RemoteDependencyBuild[];
	readonly publishClosure?: boolean;
	readonly materialiseClosure?: (
		session: Pick<
			NixDaemonSession,
			'addTempRoot' | 'buildPathsWithResults' | 'resolveClosure'
		>
	) => Promise<readonly StorePathString[]>;
	/**
	Called immediately before the store realises one dependency.
	*/
	readonly onDependencyStarted?: (dependency: NixDerivedPathString) => void;
	/**
	Build every selected target again in the selected Nix store.
	*/
	readonly rebuild?: boolean;
	/**
	Called before the daemon starts work on one target.
	*/
	readonly onTargetStarted?: (target: NixDerivedPathString) => void;
	/**
	Called after the daemon returns a complete result for one target and the
	session protects that target's outputs from garbage collection.
	*/
	readonly onTargetCompleted?: (target: NixDerivedPathString) => void;
}

/**
One output required by target substitution and the derived paths that can
realise it.
*/
export interface RemoteDependencyBuild {
	readonly path: StorePathString;
	readonly installables: readonly [
		NixDerivedPathString,
		...NixDerivedPathString[]
	];
	readonly requiredBy?: readonly NixDerivedPathString[];
}

/**
Root every predictable output, then build and publish on the same session.
*/
export async function buildAndRootNixResults(
	session: Pick<
		NixDaemonSession,
		| 'addTempRoot'
		| 'buildPathsWithResults'
		| 'readDerivation'
		| 'resolveClosure'
	> &
		Partial<Pick<NixDaemonSession, 'queryValidPaths'>>,
	installables: readonly NixDerivedPathString[],
	publish: (
		results: readonly NixBuildResult[],
		failures: readonly RemoteCohortBuildFailure[],
		publicationPaths: readonly StorePathString[],
		provenanceRebuilds: ReadonlySet<NixDerivedPathString>
	) => Promise<void>,
	options?: RemoteBuildSessionOptions
): Promise<void> {
	const dependencyResults: NixBuildResult[] = [];
	const dependencyFailures: RemoteCohortBuildFailure[] = [];
	const failedDependencyPaths = new Map<string, StorePathString>();

	if (options !== undefined) {
		const copyPaths = new Set(options.copyPaths);

		for (const path of copyPaths) {
			await session.addTempRoot(path);
		}

		await options.copy();
		const dependencies = await realiseRemoteDependencies(
			session,
			options.dependencyBuilds ?? [],
			options.onDependencyStarted
		);

		dependencyResults.push(...dependencies.results);
		dependencyFailures.push(...dependencies.failures);

		for (const [target, path] of dependencies.failedPaths) {
			failedDependencyPaths.set(target, path);
		}
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

	const results: NixBuildResult[] = [...dependencyResults];
	const targetFailures: RemoteCohortBuildFailure[] = [];
	const provenanceRebuilds = new Set<NixDerivedPathString>();
	const queryCurrentValidity = session.queryValidPaths;

	if (queryCurrentValidity === undefined && options?.rebuild === true) {
		throw new Error(
			'Rebuilding remote targets needs selected-store validity queries'
		);
	}

	for (const build of expectedBuilds) {
		const dependencyResult = dependencyResults.find(
			(result) => canonicalNixDerivedPath(result.target) === build.target
		);

		if (
			dependencyResult !== undefined &&
			(options?.rebuild !== true ||
				(dependencyResult.outcome.kind === 'built' &&
					dependencyResult.execution === 'local'))
		) {
			options?.onTargetCompleted?.(build.target);
			continue;
		}

		if (dependencyResult !== undefined) {
			results.splice(results.indexOf(dependencyResult), 1);
		}

		options?.onTargetStarted?.(build.target);

		const selectedOutputs = build.outputs.values().toArray();
		const currentlyValid =
			queryCurrentValidity !== undefined && options?.rebuild === true
				? new Set(await queryCurrentValidity.call(session, selectedOutputs))
				: new Set<StorePathString>();
		let buildMode: NixBuildMode =
			options?.rebuild === true &&
			selectedOutputs.every((output) => currentlyValid.has(output))
				? 'check'
				: 'normal';
		let returned = await session.buildPathsWithResults(
			[build.installable],
			buildMode
		);
		let reconciliation = reconcileBuildResults([build], returned);

		if (
			buildMode === 'normal' &&
			options?.rebuild === true &&
			reconciliation.failures.length === 0 &&
			reconciliation.results.some(
				(result) =>
					result.outcome.kind !== 'built' || result.execution !== 'local'
			)
		) {
			buildMode = 'check';
			returned = await session.buildPathsWithResults(
				[build.installable],
				buildMode
			);
			reconciliation = reconcileBuildResults([build], returned);
		}

		if (options?.rebuild === true && reconciliation.failures.length === 0) {
			const notBuilt = reconciliation.results.filter(
				(result) =>
					result.outcome.kind !== 'built' || result.execution !== 'local'
			);

			if (notBuilt.length > 0) {
				const built = reconciliation.results.filter(
					(result) =>
						result.outcome.kind === 'built' && result.execution === 'local'
				);
				reconciliation = {
					results: built,
					outputs: buildResultOutputPaths(built),
					failures: notBuilt.map((result) => ({
						target: result.target,
						kind: 'verification',
						outcome: 'not-built',
						message: `the rebuild did not prove execution in the selected store (result: ${result.outcome.kind}; execution: ${result.execution ?? 'unobserved'})`
					}))
				};
			} else if (buildMode === 'check') {
				provenanceRebuilds.add(build.target);
			}
		}

		for (const output of reconciliation.outputs) {
			await session.addTempRoot(output);
		}

		results.push(...reconciliation.results);
		targetFailures.push(...reconciliation.failures);

		const hasTargetProtocolFailure = reconciliation.failures.some(
			(failure) =>
				failure.kind === 'protocol' &&
				canonicalNixDerivedPath(nixDerivedPathSchema.parse(failure.target)) ===
					build.target
		);

		if (!hasTargetProtocolFailure) {
			options?.onTargetCompleted?.(build.target);
		}
	}

	const targetSet = new Set(expectedBuilds.map((build) => build.target));
	const outputPaths = buildResultOutputPaths(
		options?.publishClosure === false
			? results.filter((result) =>
					targetSet.has(canonicalNixDerivedPath(result.target))
				)
			: results
	);
	const publicationInfos =
		outputPaths.length === 0 || options?.publishClosure === false
			? []
			: await session.resolveClosure(outputPaths);
	const builtPublicationPaths =
		options?.publishClosure === false
			? outputPaths
			: publicationInfos.map((info) => info.storePath);
	const cachedClosurePaths =
		options?.materialiseClosure === undefined
			? []
			: await options.materialiseClosure(session);
	const publicationPaths = [
		...new Set([...builtPublicationPaths, ...cachedClosurePaths])
	].toSorted(byCodeUnit);
	const publicationPathSet = new Set(publicationPaths);
	const remainingDependencyFailures = dependencyFailures.filter((failure) => {
		if (failure.kind !== 'dependency') {
			return true;
		}

		const failedPath = failedDependencyPaths.get(failure.target);

		return failedPath === undefined || !publicationPathSet.has(failedPath);
	});
	const failures = [...remainingDependencyFailures, ...targetFailures];

	await publish(results, failures, publicationPaths, provenanceRebuilds);

	if (failures.length === 0) {
		return;
	}

	const protocolFailures = failures.filter((failure) =>
		['dependency-protocol', 'protocol'].includes(failure.kind)
	);

	if (protocolFailures.length > 0) {
		throw new RemoteCohortProtocolError(protocolFailures);
	}

	throw new RemoteCohortBuildFailedError(failures);
}

async function realiseRemoteDependencies(
	session: Pick<
		NixDaemonSession,
		'addTempRoot' | 'buildPathsWithResults' | 'readDerivation'
	>,
	dependencies: readonly RemoteDependencyBuild[],
	onStarted: ((dependency: NixDerivedPathString) => void) | undefined
): Promise<{
	readonly results: readonly NixBuildResult[];
	readonly failures: readonly RemoteCohortBuildFailure[];
	readonly failedPaths: ReadonlyMap<string, StorePathString>;
}> {
	if (dependencies.length === 0) {
		return { results: [], failures: [], failedPaths: new Map() };
	}

	const states: RemoteDependencyBuildState[] = [];

	for (const dependency of dependencies) {
		states.push({
			dependency,
			builds: await predictableRemoteBuilds(session, dependency.installables),
			attempted: new Set(),
			isResolved: false,
			isExhausted: false
		});
	}

	const statesByDerivation = Map.groupBy(
		states.flatMap((state) =>
			state.builds.map((build) => ({
				build,
				derivation: build.derivation,
				state
			}))
		),
		({ derivation }) => derivation
	);
	const results: NixBuildResult[] = [];
	const unmatchedProtocolFailures: RemoteCohortBuildFailure[] = [];
	while (states.some((state) => !state.isResolved && !state.isExhausted)) {
		const selection = selectRemoteDependencyBuilds(states, statesByDerivation);

		if (selection.ready.length === 0 && selection.didAdvance) {
			continue;
		}

		const ready =
			selection.ready.length > 0
				? selection.ready
				: forcedRemoteDependencyBuild(states);

		if (ready.length === 0) {
			break;
		}

		for (const { build } of ready) {
			for (const output of build.outputs.values()) {
				await session.addTempRoot(output);
			}

			onStarted?.(build.installable);
		}

		const builds = ready.map(({ build }) => build);
		const returned = await session.buildPathsWithResults(
			builds.map((build) => build.installable),
			'normal'
		);
		const reconciliation = reconcileBuildResults(builds, returned);

		for (const output of reconciliation.outputs) {
			await session.addTempRoot(output);
		}

		results.push(...reconciliation.results);
		recordRemoteDependencyResults(ready, reconciliation);
		const selectedTargets = new Set(ready.map(({ build }) => build.target));
		unmatchedProtocolFailures.push(
			...reconciliation.failures.flatMap((failure) => {
				const target = canonicalNixDerivedPath(
					nixDerivedPathSchema.parse(failure.target)
				);

				return failure.kind === 'protocol' && !selectedTargets.has(target)
					? [{ ...failure, kind: 'dependency-protocol' as const }]
					: [];
			})
		);

		if (
			unmatchedProtocolFailures.length > 0 ||
			ready.some(({ state }) => state.hasProtocolFailure === true)
		) {
			break;
		}
	}

	const failedStates = states.filter(
		(
			state
		): state is RemoteDependencyBuildState & {
			readonly lastFailure: RemoteCohortBuildFailure;
		} => !state.isResolved && state.lastFailure !== undefined
	);

	return {
		results,
		failures: [
			...failedStates.map(({ lastFailure }) => lastFailure),
			...unmatchedProtocolFailures
		],
		failedPaths: new Map(
			failedStates.map(({ dependency, lastFailure }) => [
				lastFailure.target,
				dependency.path
			])
		)
	};
}

interface RemoteDependencyBuildState {
	readonly dependency: RemoteDependencyBuild;
	readonly builds: readonly ExpectedRemoteBuild[];
	readonly attempted: Set<NixDerivedPathString>;
	isResolved: boolean;
	isExhausted: boolean;
	hasProtocolFailure?: boolean;
	lastFailure?: RemoteCohortBuildFailure;
}

interface SelectedRemoteDependencyBuild {
	readonly state: RemoteDependencyBuildState;
	readonly build: ExpectedRemoteBuild;
}

function selectRemoteDependencyBuilds(
	states: readonly RemoteDependencyBuildState[],
	statesByDerivation: ReadonlyMap<
		StorePathString,
		readonly {
			readonly build: ExpectedRemoteBuild;
			readonly state: RemoteDependencyBuildState;
		}[]
	>
): {
	readonly ready: readonly SelectedRemoteDependencyBuild[];
	readonly didAdvance: boolean;
} {
	const ready: SelectedRemoteDependencyBuild[] = [];
	let didAdvance = false;

	for (const state of states) {
		if (state.isResolved || state.isExhausted) {
			continue;
		}

		const selection = selectRemoteDependencyBuild(state, statesByDerivation);
		didAdvance ||= selection.didAdvance;

		if (selection.build !== undefined) {
			ready.push({ state, build: selection.build });
		}
	}

	return { ready, didAdvance };
}

function selectRemoteDependencyBuild(
	state: RemoteDependencyBuildState,
	statesByDerivation: ReadonlyMap<
		StorePathString,
		readonly {
			readonly build: ExpectedRemoteBuild;
			readonly state: RemoteDependencyBuildState;
		}[]
	>
): {
	readonly build?: ExpectedRemoteBuild;
	readonly didAdvance: boolean;
} {
	const attemptedBefore = state.attempted.size;
	let hasWaitingCandidate = false;

	for (const build of state.builds) {
		if (state.attempted.has(build.target)) {
			continue;
		}

		const prerequisites = new Set(
			build.inputDerivations
				.entries()
				.flatMap(([derivation, outputNames]) =>
					(statesByDerivation.get(derivation) ?? []).flatMap(
						({ build: prerequisiteBuild, state: prerequisite }) =>
							outputNames.some((outputName) =>
								prerequisiteBuild.outputs.has(outputName)
							)
								? [prerequisite]
								: []
					)
				)
		);

		if ([...prerequisites].some((prerequisite) => prerequisite.isExhausted)) {
			state.attempted.add(build.target);
			continue;
		}

		if ([...prerequisites].every((prerequisite) => prerequisite.isResolved)) {
			return {
				build,
				didAdvance: state.attempted.size > attemptedBefore
			};
		}

		hasWaitingCandidate = true;
	}

	state.isExhausted = !hasWaitingCandidate;

	return {
		didAdvance: state.attempted.size > attemptedBefore || state.isExhausted
	};
}

function forcedRemoteDependencyBuild(
	states: readonly RemoteDependencyBuildState[]
): readonly SelectedRemoteDependencyBuild[] {
	for (const state of states) {
		if (state.isResolved || state.isExhausted) {
			continue;
		}

		const build = state.builds.find(
			(candidate) => !state.attempted.has(candidate.target)
		);

		if (build !== undefined) {
			return [{ state, build }];
		}
	}

	return [];
}

function recordRemoteDependencyResults(
	selected: readonly SelectedRemoteDependencyBuild[],
	reconciliation: ReconciledBuildResults
): void {
	const results = new Set(
		reconciliation.results.map((result) =>
			canonicalNixDerivedPath(result.target)
		)
	);
	const failures = new Map(
		reconciliation.failures.map((failure) => [
			canonicalNixDerivedPath(nixDerivedPathSchema.parse(failure.target)),
			failure
		])
	);

	for (const { state, build } of selected) {
		state.attempted.add(build.target);

		const failure = failures.get(build.target);

		if (failure === undefined && results.has(build.target)) {
			state.isResolved = true;
			continue;
		}

		if (failure === undefined) {
			continue;
		}

		state.lastFailure = {
			...failure,
			kind:
				failure.kind === 'protocol'
					? 'dependency-protocol'
					: failure.kind === 'verification'
						? 'verification'
						: 'dependency'
		};

		if (failure.kind === 'target') {
			continue;
		}

		state.hasProtocolFailure = failure.kind === 'protocol';
		state.isExhausted = true;
	}
}

interface ExpectedRemoteBuild {
	readonly derivation: StorePathString;
	readonly installable: NixDerivedPathString;
	readonly inputDerivations: ReadonlyMap<StorePathString, readonly string[]>;
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
		const selected = new Set(
			selection === undefined || selection === '*'
				? derivation.outputs.keys()
				: selection.split(',')
		);
		const outputs = new Map<string, StorePathString>();

		for (const outputName of selected) {
			if (!derivation.outputs.has(outputName)) {
				throw new RemoteBuildOutputUndeclaredError(installable, outputName);
			}

			const output = derivation.outputs.get(outputName);

			if (output === undefined) {
				throw new RemoteBuildOutputPathUnknownError(installable, outputName);
			}

			outputs.set(outputName, output);
		}

		builds.push({
			derivation: derivationPath,
			installable,
			inputDerivations: derivation.inputDerivations,
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
		failures
			.filter((failure) =>
				['protocol', 'target', 'verification'].includes(failure.kind)
			)
			.map((failure) =>
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
	const resultsByTarget = Map.groupBy(results, (result) =>
		canonicalNixDerivedPath(result.target)
	);

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

		if ('outputs' in result.outcome) {
			const expectedOutputs = expectedOutputsByTarget.get(target);

			if (
				expectedOutputs === undefined ||
				Object.values(result.outcome.outputs).length === 0 ||
				!hasMatchingRemoteOutputs(result.outcome.outputs, expectedOutputs)
			) {
				failures.push({
					target,
					kind: 'protocol',
					outcome: 'invalid-outputs',
					message: `the daemon reported ${Object.values(result.outcome.outputs).length === 0 ? 'no outputs' : formatRemoteOutputEntries(Object.entries(result.outcome.outputs))}; expected ${formatRemoteOutputEntries(expectedOutputs?.entries().toArray() ?? [])}`
				});
				continue;
			}

			survivors.push(result);
			continue;
		}

		failures.push({
			target,
			kind:
				result.outcome.kind === 'not-deterministic' ? 'verification' : 'target',
			outcome: result.outcome.kind,
			message: result.outcome.message
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

/**
Every final output path in the keyed results, deduplicated and sorted.
*/
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
	/**
	The stores each path was copied from, keyed by store path.
	*/
	readonly copiedFrom: ReadonlyMap<StorePathString, readonly string[]>;
}

function requestedCohortMemberCount(
	members: readonly CohortMember[],
	buildInstallables: readonly string[]
): number {
	const requested = new Set(buildInstallables);

	return members.filter((member) => {
		if (requested.has(member.installable)) {
			return true;
		}

		return (
			member.queryInstallable !== undefined &&
			requested.has(nixDerivedPathSchema.parse(member.queryInstallable))
		);
	}).length;
}

async function resolveLocalBuildOwners(options: {
	readonly members: readonly CohortMember[];
	readonly buildInstallables: readonly string[];
	readonly builtPaths: readonly string[];
	readonly inputs: BuildCohortInputs;
	readonly runNix: typeof runNixBuild;
	readonly signal?: AbortSignal;
	readonly allowIncomplete: boolean;
	readonly onResolved?: () => void;
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
					options.onResolved?.();
					continue;
				}

				throw new LocalBuildExpectedPathMissingError(
					member.installable,
					member.expectedPath
				);
			}

			owners.push({
				installable: member.installable,
				outputs: [member.expectedPath]
			});
			options.onResolved?.();
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
				options.onResolved?.();
				continue;
			}

			throw new CommandFailedError('nix build', result.status);
		}

		const unexpectedPaths = result.paths.filter((output) => !built.has(output));

		if (unexpectedPaths.length > 0) {
			if (options.allowIncomplete) {
				incompleteRoots.add(member.root);
				options.onResolved?.();
				continue;
			}

			throw new LocalBuildOutputsOutsideCohortError(
				member.installable,
				unexpectedPaths
			);
		}

		if (result.paths.length === 0) {
			if (options.allowIncomplete) {
				incompleteRoots.add(member.root);
				options.onResolved?.();
				continue;
			}

			throw new LocalBuildOutputsMissingError(member.installable);
		}

		owners.push({ installable: member.installable, outputs: result.paths });
		options.onResolved?.();
	}

	return { builds: owners, incompleteRoots };
}

/**
Outputs this invocation's keyed daemon results say it actually built.
*/
export function claimableOutputPaths(
	results: readonly NixBuildResult[],
	provenanceRebuilds: ReadonlySet<string> = new Set()
): readonly string[] {
	return [
		...new Set(
			results.flatMap((result) =>
				result.outcome.kind === 'built' ||
				(provenanceRebuilds.has(result.target) && 'outputs' in result.outcome)
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
	options: RunNixBuildOptions = {}
): Promise<NixBuildCommandResult> {
	signal?.throwIfAborted();

	if (
		store === '' &&
		options.rebuild === true &&
		(options.buildSettings ?? discoverNixStoreConfig().building).builders !==
			undefined
	) {
		throw new BuildRebuildRemoteDispatchError();
	}

	await mkdir(outLinkDirectory, { recursive: true });

	const nix =
		options.rebuild === true
			? (options.nix ??
				Nix.openForAvailability(undefined, {
					storeUri: store === '' ? 'auto' : store,
					...(signal !== undefined && { signal })
				}))
			: undefined;
	const evaluationNix =
		nix === undefined
			? undefined
			: (options.evaluationNix ??
				(store === ''
					? nix
					: Nix.openForAvailability(undefined, {
							storeUri: 'auto',
							...(signal !== undefined && { signal })
						})));
	const initiallyValid =
		nix === undefined || evaluationNix === undefined
			? new Set<string>()
			: await initiallyValidBuildOutputs(evaluationNix, nix, installables);
	const logFile = path.join(outLinkDirectory, 'activity.jsonl');
	const checkLogFile = path.join(outLinkDirectory, 'check-activity.jsonl');
	await Promise.all([
		rm(logFile, { force: true }),
		rm(checkLogFile, { force: true })
	]);
	const arguments_ = nixBuildArguments(
		installables,
		maxJobs,
		store,
		outLinkDirectory,
		logFile,
		{ rebuild: false, disableRemoteBuilders: options.rebuild === true }
	);

	const processDependencies: CapturedNixProcessDependencies = {
		start: options.start ?? defaultCapturedNixProcessDependencies.start,
		...(options.maximumStdoutBytes !== undefined && {
			maximumStdoutBytes: options.maximumStdoutBytes
		}),
		...(options.scheduler !== undefined && { scheduler: options.scheduler })
	};
	const { status, stdout } = await runCapturedNixProcess(
		'nix build',
		arguments_,
		signal,
		processDependencies
	);

	const paths = stdout.split(/\r?\n/u).filter((line) => line !== '');
	const copiedFrom = await readCopySources(logFile);

	if (status !== 0 || nix === undefined) {
		return { paths, status, copiedFrom };
	}

	const checkInstallables = await buildOnlyChecks(
		evaluationNix ?? nix,
		nix,
		installables,
		paths,
		initiallyValid,
		logFile
	);

	if (checkInstallables.length > 0) {
		const check = await runCapturedNixProcess(
			'nix build --rebuild',
			nixBuildArguments(
				checkInstallables,
				maxJobs,
				store,
				outLinkDirectory,
				checkLogFile,
				{ rebuild: true, outLink: false }
			),
			signal,
			processDependencies
		);

		if (check.status !== 0) {
			throw new CommandFailedError('nix build --rebuild', check.status);
		}
	}

	const logs = await Promise.all(
		[logFile, checkLogFile].map(async (file) => {
			try {
				return await readFile(file, 'utf8');
			} catch {
				return '';
			}
		})
	);
	const activities = logs.flatMap((log) => buildActivities(log));
	const observed = new Set(
		activities
			.filter((activity) => activity.machine === '')
			.map((activity) => activity.derivation)
	);
	const infos = await Promise.all(
		paths.map((storePath) => nix.queryPathInfo(storePath))
	);
	if (
		activities.some(
			(activity) =>
				activity.machine !== '' &&
				infos.some((info) => info.deriver === activity.derivation)
		)
	) {
		throw new BuildRebuildRemoteDispatchError();
	}
	const unobserved = infos
		.filter((info) => info.deriver === undefined || !observed.has(info.deriver))
		.map((info) => info.storePath);

	if (unobserved.length > 0) {
		throw new BuildObservationMissingError(unobserved);
	}

	return { paths, status, copiedFrom: copySources(logs) };
}

async function initiallyValidBuildOutputs(
	evaluationNix: Pick<Nix, 'readDerivation'>,
	nix: Pick<Nix, 'queryValidPaths'>,
	installables: readonly string[]
): Promise<ReadonlySet<string>> {
	const outputs: StorePathString[] = [];

	for (const installable of installables) {
		const [rawDerivation, selection] = installable.split('^', 2);
		const derivation = storePathSchema.safeParse(rawDerivation);

		if (!derivation.success || !derivation.data.endsWith('.drv')) {
			continue;
		}

		const declared = await evaluationNix.readDerivation(derivation.data);
		const names =
			selection === undefined || selection === '*'
				? declared.outputs.keys()
				: selection.split(',').values();

		for (const name of names) {
			const output = declared.outputs.get(name);

			if (output !== undefined) {
				outputs.push(output);
			}
		}
	}

	return new Set(await nix.queryValidPaths(outputs));
}

async function buildOnlyChecks(
	evaluationNix: Pick<Nix, 'readDerivation'>,
	nix: Pick<Nix, 'queryPathInfo'>,
	installables: readonly string[],
	paths: readonly string[],
	initiallyValid: ReadonlySet<string>,
	logFile: string
): Promise<readonly string[]> {
	let log = '';

	try {
		log = await readFile(logFile, 'utf8');
	} catch {
		// Nix may reuse every output without creating an activity log.
	}

	const executed = new Set(
		buildActivities(log).map((activity) => activity.derivation)
	);
	const infos: readonly NixValidPathInfo[] = await Promise.all(
		paths.map((storePath) => nix.queryPathInfo(storePath))
	);
	const checks = new Set<string>();
	const derivations = new Map<
		string,
		Awaited<ReturnType<Nix['readDerivation']>>
	>();

	for (const info of infos) {
		if (info.deriver === undefined) {
			return installables;
		}

		if (!initiallyValid.has(info.storePath) && executed.has(info.deriver)) {
			continue;
		}

		let derivation = derivations.get(info.deriver);
		if (derivation === undefined) {
			try {
				derivation = await evaluationNix.readDerivation(info.deriver);
			} catch {
				return installables;
			}
			derivations.set(info.deriver, derivation);
		}

		const output = [...derivation.outputs].find(
			([, storePath]) => storePath === info.storePath
		);
		if (output === undefined) {
			return installables;
		}

		checks.add(`${info.deriver}^${output[0]}`);
	}

	return [...checks].toSorted(byCodeUnit);
}

// Nix creates the activity log when the build starts, so an invocation that
// failed before then leaves no file. Treat a log this process cannot read as a
// run that copied nothing.
async function readCopySources(
	logFile: string
): Promise<ReadonlyMap<StorePathString, readonly string[]>> {
	try {
		return copySources([await readFile(logFile, 'utf8')]);
	} catch {
		return new Map();
	}
}
