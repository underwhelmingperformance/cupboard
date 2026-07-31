import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from 'node:process';

import { rootNameSchema, storePathSchema } from '@cupboard/nix-store/scalars';
import { canonicalHref } from '@cupboard/nix-store/url';
import type { ReporterResultEvent } from '@cupboard/reporter';
import type { Command } from 'commander';
import { z } from 'zod';

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
	MissingInputError
} from '../errors.ts';
import { type Environment, requireEnvironment, setOutput } from '../inputs.ts';
import { provided, providedReadUser, providedUrl } from '../options.ts';

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
		queryInstallables: z.array(z.string().min(1).nullable()),
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

interface CohortMember {
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
	buildSet: z.array(z.string()),
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
	readonly targetPathsFile: string;
	readonly intermediatePathsFile: string;
	readonly referencePathsFile: string;
	readonly leftUpstreamFile: string;
	readonly countsFile: string;
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
		maxJobs: provided(options.maxJobs) ?? '',
		store: provided(options.store) ?? '',
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
		countsFile: outputPath('counts.json', options.countsFile)
	};
}

export function registerBuildCohortCommand(
	program: Command,
	environment: Environment = env
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
			buildCohortAction(options, environment)
		);
}

export interface BuildCohortDependencies {
	readonly runCupboard?: typeof defaultRunCupboard;
	readonly runNixBuild?: typeof runNixBuild;
	readonly cupboardRunDependencies?: CupboardRunDependencies;
}

export async function buildCohortAction(
	options: BuildCohortOptions,
	environment: Environment = env,
	dependencies: BuildCohortDependencies = {}
): Promise<void> {
	const inputs = resolveBuildCohortInputs(options, environment);
	const members = membersOf(inputs.cohort);
	const queryable = members.filter(
		(member) => member.queryInstallable !== undefined
	);
	const unqueryable = members.filter(
		(member) => member.queryInstallable === undefined
	);

	const runCupboard = dependencies.runCupboard ?? defaultRunCupboard;
	const runNix = dependencies.runNixBuild ?? runNixBuild;

	const result =
		queryable.length === 0
			? undefined
			: await planCohort(
					inputs,
					queryable,
					environment,
					runCupboard,
					dependencies.cupboardRunDependencies
				);

	const buildInstallables = [
		...(result?.partition.buildSet ?? []),
		...unqueryable.map((member) => member.installable)
	];

	const built =
		buildInstallables.length === 0
			? []
			: await runNix(buildInstallables, inputs.maxJobs, inputs.store);

	// Every path a plain, single-invocation `nix build` prints belongs to one
	// of this cohort's own requested installables: there is nothing else it
	// could have realised. The intermediate-paths file exists so a future
	// increment that derives genuine shared-dependency intermediates from the
	// build log has somewhere to report them without changing this
	// interface; for now it is always empty.
	const targetPaths = [
		...(result?.partition.attachOnly ?? []),
		...built
	].toSorted((left, right) => left.localeCompare(right));
	const intermediatePaths: readonly string[] = [];
	const referencePaths = result?.partition.publishByReference ?? [];
	const leftUpstream = result?.partition.leftUpstream ?? [];

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
				partition: result === undefined ? undefined : partitionCounts(result),
				capacity: result?.capacity
			},
			undefined,
			2
		)}\n`
	);

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
}

function partitionCounts(result: PlanCohortResultData): {
	readonly counts: PlanCohortResultData['partition']['counts'];
	readonly downloadSize: number;
	readonly narSize: number;
	readonly unknownCount: number;
	readonly ceiling: PlanCohortResultData['partition']['ceiling'];
} {
	return {
		counts: result.partition.counts,
		downloadSize: result.partition.downloadSize,
		narSize: result.partition.narSize,
		unknownCount: result.partition.unknownCount,
		ceiling: result.partition.ceiling
	};
}

function linesOf(paths: readonly string[]): string {
	return paths.length === 0 ? '' : `${paths.join('\n')}\n`;
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
 * Runs `nix build --keep-going` over the given installables, out-links kept
 * in the job workspace (no `--no-link`): the out-link protects the built
 * closure until the subsequent push reads it, per the interim workflow's
 * collection-window design. A cohort with one failing derivation still
 * reports whatever `--print-out-paths` prints for the survivors; only a
 * catastrophic failure that printed nothing at all is treated as this
 * command's own failure. A configured remote store owns the build:
 * `--store` sends the results there while `--eval-store auto` keeps
 * evaluation on the runner, so the built closure never enters the runner's
 * local store.
 */
export function nixBuildArguments(
	installables: readonly string[],
	maxJobs: string,
	store: string
): readonly string[] {
	const arguments_ = ['build', '--keep-going', '--print-out-paths'];

	if (maxJobs !== '') {
		arguments_.push('--max-jobs', maxJobs);
	}

	if (store !== '') {
		arguments_.push('--store', store, '--eval-store', 'auto');
	}

	arguments_.push('--', ...installables);

	return arguments_;
}

export async function runNixBuild(
	installables: readonly string[],
	maxJobs: string,
	store: string
): Promise<readonly string[]> {
	const arguments_ = nixBuildArguments(installables, maxJobs, store);

	const { status, stdout } = await new Promise<{
		readonly status: number | null;
		readonly stdout: string;
	}>((resolve, reject) => {
		const child = spawn('nix', arguments_, {
			stdio: ['ignore', 'pipe', 'inherit']
		});
		let out = '';

		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			out += chunk;
		});
		child.once('error', reject);
		child.once('close', (code) => {
			resolve({ status: code, stdout: out });
		});
	});

	const paths = stdout.split(/\r?\n/u).filter((line) => line !== '');

	if (status !== 0 && paths.length === 0) {
		throw new CommandFailedError('nix build', status);
	}

	return paths;
}
