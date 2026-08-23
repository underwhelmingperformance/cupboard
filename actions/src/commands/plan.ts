import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from 'node:process';

import { discoverNixStoreConfig } from '@cupboard/nix';
import {
	rootNameMaxLength,
	rootNameSchema,
	type StoredCache,
	type StoreDirectory,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { canonicalHref } from '@cupboard/nix-store/url';
import {
	type ParsedRootEnsureResponse,
	type ParsedRootTarget,
	rootEnsureResponseSchema,
	rootSetMaxTargets,
	rootTargetSchema
} from '@cupboard/protocol/retention';
import {
	createGithubReporter,
	parseReporterResults,
	type Reporter,
	type ReporterResultEvent
} from '@cupboard/reporter';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { type ReadUser } from '@cupboard/shared/http';
import type { Command } from 'commander';
import { z } from 'zod';

import {
	type ClosedChildProcess,
	observeChildProcess,
	waitForAbortableChildProcess
} from '../child-process.ts';
import {
	CommandFailedError,
	ComponentRootTargetLimitError,
	MatrixJobLimitError,
	MeasureResultInvalidError,
	MeasureResultMissingError,
	MissingInputError,
	PackCapacityInvalidError,
	PublishRootTargetLimitError,
	PublishTargetsJsonError,
	PublishTargetsSchemaError,
	ReadPasswordRequiredError,
	ReadUserRequiredError,
	RemoteOutputPathUnknownDuringPlanningError,
	RootEnsureCommandError,
	RootEnsureResultInvalidError,
	RootEnsureResultMissingError,
	RootNameInvalidError,
	RootTargetsCommandError,
	RootTargetsResultInvalidError,
	RootTargetsResultMissingError
} from '../errors.ts';
import { type Environment, requireEnvironment, setOutput } from '../inputs.ts';
import {
	isEnabled,
	provided,
	providedCache,
	providedReadUser,
	providedUrl
} from '../options.ts';
import { packCohorts } from '../packing.ts';
import {
	availableCachePaths,
	cacheProbePaths,
	type Cohort,
	type CohortPreFilterDecision,
	cohortPreFilterDecision,
	cohortsFor,
	evaluateTargetCoverage,
	evaluateTargets,
	expandComponents,
	isBestEffortCohort,
	joinRoot,
	type NixEvaluator,
	planPublish,
	type PublishPlan,
	type PublishTarget,
	publishTargetsSchema,
	type TargetCoverage,
	type TargetEvaluation
} from '../publish-plan.ts';

export type EnsureRunner = (
	command: string,
	arguments_: readonly string[],
	signal?: AbortSignal
) => Promise<{ stdout: string; stderr: string }>;

const maximumCapturedOutputBytes = 16 * 1024 * 1024;

class CapturedCommandError extends CommandFailedError {
	constructor(
		command: string,
		result: ClosedChildProcess,
		public readonly stdout: string,
		public readonly stderr: string
	) {
		super(command, result.status, result.error?.message, {
			...(result.error !== undefined && { cause: result.error }),
			...(result.signal !== undefined && { signal: result.signal })
		});
		this.name = 'CapturedCommandError';
	}
}

const defaultEnsureRunner: EnsureRunner = async (
	command,
	arguments_,
	signal
) => {
	signal?.throwIfAborted();

	const child = spawn(command, [...arguments_], {
		stdio: ['ignore', 'pipe', 'pipe']
	});
	const outputLimit = new AbortController();
	const lifecycleSignal =
		signal === undefined
			? outputLimit.signal
			: AbortSignal.any([signal, outputLimit.signal]);
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	let stdoutBytes = 0;
	let stderrBytes = 0;
	const capture = (
		chunks: Buffer[],
		chunk: Buffer,
		capturedBytes: number,
		stream: 'stdout' | 'stderr'
	): number => {
		const nextBytes = capturedBytes + chunk.byteLength;

		if (nextBytes > maximumCapturedOutputBytes) {
			outputLimit.abort(
				new Error(
					`${command} ${stream} exceeded ${String(maximumCapturedOutputBytes)} bytes`
				)
			);

			return nextBytes;
		}

		chunks.push(chunk);

		return nextBytes;
	};

	child.stdout.on('data', (chunk: Buffer) => {
		stdoutBytes = capture(stdout, chunk, stdoutBytes, 'stdout');
	});
	child.stderr.on('data', (chunk: Buffer) => {
		stderrBytes = capture(stderr, chunk, stderrBytes, 'stderr');
	});

	const result = await waitForAbortableChildProcess(
		observeChildProcess(child),
		lifecycleSignal
	);
	const capturedStdout = Buffer.concat(stdout).toString('utf8');
	const capturedStderr = Buffer.concat(stderr).toString('utf8');

	if (result.error !== undefined || result.status !== 0) {
		throw new CapturedCommandError(
			command,
			result,
			capturedStdout,
			capturedStderr
		);
	}

	return { stdout: capturedStdout, stderr: capturedStderr };
};
const maximumConcurrentRootEnsures = 8;

const capturedCommandOutputSchema = z.looseObject({
	stdout: z.string().optional(),
	stderr: z.string().optional()
});

interface ReplayedCommandOutput {
	readonly wasReported: boolean;
}

function hasErrorWorkflowCommand(output: string): boolean {
	return /(?:^|\r?\n)::error(?: [^\r\n]*)?::/u.test(output);
}

export function replayCapturedCommandOutput(
	error: unknown
): ReplayedCommandOutput {
	const captured = capturedCommandOutputSchema.safeParse(error);
	const stdout = captured.success ? (captured.data.stdout ?? '') : '';
	const stderr = captured.success ? (captured.data.stderr ?? '') : '';

	if (stdout !== '') {
		process.stdout.write(stdout);
	}

	if (stderr !== '') {
		process.stderr.write(stderr);
	}

	return {
		wasReported:
			hasErrorWorkflowCommand(stdout) || hasErrorWorkflowCommand(stderr)
	};
}

export interface PlanOptions {
	readonly targets?: string;
	readonly url?: string;
	readonly cache?: string;
	readonly rootPrefix?: string;
	readonly ttl?: string;
	readonly readUser?: string;
	readonly readPassword?: string;
	readonly audience?: string;
	readonly cupboardPath?: string;
	readonly planFile?: string;
	readonly optimise?: string;
	readonly enablePacking?: string;
	readonly packCapacity?: string;
	readonly store?: string;
	readonly requireProvenance?: string;
}

export interface PlanInputs {
	readonly targets: readonly PublishTarget[];
	readonly url: URL;
	readonly cache: StoredCache;
	readonly rootPrefix: string;
	readonly ttl: string;
	readonly readUser: ReadUser | '';
	readonly readPassword: string;
	readonly audience: string;
	readonly cupboardPath: string;
	readonly planFile: string;
	readonly optimise: boolean;
	readonly temporaryDirectory: string;
	readonly enablePacking: boolean;
	readonly packCapacity: number;
	readonly store: string;
	readonly requireProvenance: boolean;
}

/**
 * Dependencies that callers can replace to run planning without spawning Nix
 * or Cupboard processes or making network requests.
 */
export interface PlanDependencies {
	readonly evaluator?: NixEvaluator;
	/**
	 * When omitted, planning reads the store directory from the runner's Nix
	 * configuration. Nix evaluation reports output paths relative to this
	 * directory.
	 */
	readonly storeDirectory?: StoreDirectory;
	readonly fetcher?: typeof fetch;
	readonly runner?: EnsureRunner;
	readonly signal?: AbortSignal;
	readonly createArtifactName?: () => string;
	/**
	 * When packing is enabled, returns each surviving target's substitutable NAR
	 * size by attribute. The default runs `cupboard plan measure` against the
	 * selected build store.
	 */
	readonly measurer?: (
		cohorts: readonly Cohort[],
		evaluations: readonly TargetEvaluation[]
	) => Promise<ReadonlyMap<string, number>>;
}

export function registerPlanCommand(
	program: Command,
	environment: Environment = env,
	signal?: AbortSignal
): void {
	program
		.command('plan')
		.description(
			'Plan a flake publication by checking which targets the cache already serves.'
		)
		.requiredOption('--targets <json>', 'JSON target manifest to evaluate')
		.requiredOption('--url <url>', 'cupboard Worker URL')
		.requiredOption(
			'--cupboard-path <path>',
			'path to the cupboard binary installed by the setup action'
		)
		.requiredOption(
			'--root-prefix <prefix>',
			"prefix used to form each target's retention root"
		)
		.option('--cache <name>', 'named cache to inspect and publish to')
		.option('--ttl <ttl>', 'TTL applied when retaining a cached target')
		.option('--read-user <user>', 'username for private cache reads')
		.option('--read-password <password>', 'password for private cache reads')
		.option('--audience <audience>', 'GitHub OIDC audience (defaults to url)')
		.option('--plan-file <path>', 'destination for the detailed JSON plan')
		.option(
			'--optimise <value>',
			'inspect the cache and derivation graph: true or false'
		)
		.option(
			'--enable-packing <value>',
			'combine measured cohorts within a disk budget: true or false'
		)
		.option(
			'--pack-capacity <bytes>',
			'available disk capacity, in bytes, for measured cohort packing'
		)
		.option(
			'--store <uri>',
			'remote ssh-ng store for cohort builds; remote planning requires predictable output paths'
		)
		.option(
			'--require-provenance <value>',
			'build cached targets again to produce provenance for this run: true or false'
		)
		.action((options: PlanOptions) =>
			planAction(options, environment, undefined, {
				...(signal !== undefined && { signal })
			})
		);
}

export function resolvePlanInputs(
	options: PlanOptions,
	environment: Environment
): PlanInputs {
	const declaredTargets = parseTargets(options.targets);

	validateComponentLimits(declaredTargets);

	const targets = expandComponents(declaredTargets);

	const url = providedUrl('url', options.url);

	if (url === undefined) {
		throw new MissingInputError('url');
	}

	const rootPrefix = provided(options.rootPrefix);

	if (rootPrefix === undefined) {
		throw new MissingInputError('root-prefix');
	}

	validateTargetRoots(rootPrefix, targets);
	validateTargetOutputLimits(targets);
	validateCohorts(targets);

	const cupboardPath = provided(options.cupboardPath);

	if (cupboardPath === undefined) {
		throw new MissingInputError('cupboard-path');
	}

	// Both credential halves are taken verbatim: surrounding whitespace is
	// part of a credential, so only its complete absence means "not set".
	const readUser = providedReadUser(options.readUser);
	const readPassword = options.readPassword ?? '';

	if (readUser !== '' && readPassword === '') {
		throw new ReadPasswordRequiredError();
	}

	if (readPassword !== '' && readUser === '') {
		throw new ReadUserRequiredError();
	}

	const temporaryDirectory = requireEnvironment(environment, 'RUNNER_TEMP');
	const isPackingEnabled = isEnabled(
		'enable-packing',
		options.enablePacking,
		false
	);

	return {
		targets,
		url,
		cache: providedCache(options.cache),
		rootPrefix,
		ttl: provided(options.ttl) ?? '',
		readUser,
		readPassword,
		audience: provided(options.audience) ?? '',
		cupboardPath,
		optimise: isEnabled('optimise', options.optimise, true),
		temporaryDirectory,
		planFile:
			provided(options.planFile) ??
			path.join(temporaryDirectory, 'cupboard-publish-plan.json'),
		enablePacking: isPackingEnabled,
		packCapacity: resolvePackCapacity(isPackingEnabled, options.packCapacity),
		store: provided(options.store) ?? '',
		requireProvenance: isEnabled(
			'require-provenance',
			options.requireProvenance,
			false
		)
	};
}

function resolvePackCapacity(
	isPackingEnabled: boolean,
	value: string | undefined
): number {
	if (!isPackingEnabled) {
		return 0;
	}

	const trimmed = provided(value);

	if (trimmed === undefined) {
		throw new MissingInputError('pack-capacity');
	}

	const parsed = Number(trimmed);

	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new PackCapacityInvalidError(trimmed);
	}

	return parsed;
}

function validateTargetRoots(
	rootPrefix: string,
	targets: readonly PublishTarget[]
): void {
	for (const target of targets) {
		const root = joinRoot(rootPrefix, target.rootSuffix);

		if (rootNameSchema.safeParse(root).success) {
			continue;
		}

		throw new RootNameInvalidError(target.attr, rootNameMaxLength);
	}
}

function validateTargetOutputLimits(targets: readonly PublishTarget[]): void {
	for (const target of targets) {
		if (target.outputs.length <= rootSetMaxTargets) {
			continue;
		}

		throw new PublishRootTargetLimitError(
			target.attr,
			target.outputs.length,
			rootSetMaxTargets
		);
	}
}

// Validate the aggregate before `expandComponents` replaces it. All components
// share one retention root, so the server must accept the complete component
// list in one update.
function validateComponentLimits(targets: readonly PublishTarget[]): void {
	for (const target of targets) {
		if (
			target.components === undefined ||
			target.components.length <= rootSetMaxTargets
		) {
			continue;
		}

		throw new ComponentRootTargetLimitError(
			target.attr,
			target.components.length,
			rootSetMaxTargets
		);
	}
}

// `cohortsFor` rejects members that use different execution contexts. Run it
// before evaluation so an invalid manifest fails before build work starts.
function validateCohorts(targets: readonly PublishTarget[]): void {
	cohortsFor(targets);
}

function parseTargets(source: string | undefined): readonly PublishTarget[] {
	const raw = provided(source);

	if (raw === undefined) {
		throw new MissingInputError('targets');
	}

	let value: unknown;

	try {
		value = JSON.parse(raw);
	} catch (error) {
		throw new PublishTargetsJsonError(
			error instanceof SyntaxError ? error : new SyntaxError(String(error))
		);
	}

	const targets = publishTargetsSchema.safeParse(value);

	if (!targets.success) {
		throw new PublishTargetsSchemaError(targets.error);
	}

	return targets.data;
}

export async function planAction(
	options: PlanOptions,
	environment: Environment = env,
	reporter: Reporter = createGithubReporter(),
	dependencies: PlanDependencies = {}
): Promise<void> {
	dependencies.signal?.throwIfAborted();

	const inputs = resolvePlanInputs(options, environment);
	const { plan, evaluations } = inputs.optimise
		? await optimisedPlan(inputs, reporter, dependencies)
		: { plan: unoptimisedPlan(inputs.targets), evaluations: [] };
	// Only an optimised plan has the evaluated graph that the pre-filter needs.
	// An unoptimised plan must keep every cohort in the matrix.
	const cohortDecisions =
		inputs.optimise && !inputs.requireProvenance
			? await cohortPreFilter(
					inputs,
					plan,
					evaluations,
					dependencies.runner,
					dependencies.signal
				)
			: plan.cohorts.map((cohort) => ({ key: cohort.key, pruned: false }));

	await writePlan(
		environment,
		inputs,
		plan,
		cohortDecisions,
		evaluations,
		dependencies.createArtifactName?.() ??
			`cupboard-publish-plan-${randomUUID()}`,
		dependencies.measurer ??
			packingMeasurer(
				inputs,
				reporter,
				dependencies.runner,
				dependencies.signal
			)
	);
}

async function optimisedPlan(
	inputs: PlanInputs,
	reporter: Reporter,
	dependencies: PlanDependencies
): Promise<{
	readonly plan: PublishPlan;
	readonly evaluations: readonly TargetEvaluation[];
}> {
	const { evaluations, unevaluated } = await evaluateTargets(
		inputs.targets,
		dependencies.storeDirectory ?? discoverNixStoreConfig().storeDirectory,
		dependencies.evaluator
	);
	validateRemoteOutputPredictability(
		inputs.store,
		evaluations,
		unevaluated.map((failure) => failure.target.attr)
	);

	for (const failure of unevaluated) {
		reporter.warn(
			`Planning ${failure.target.attr} as a direct build because it did not evaluate: ${failure.reason}`
		);
	}

	const retainedRoots = await retainedRootsFor(
		inputs,
		evaluations,
		dependencies
	);
	const plan = planPublish({
		evaluations,
		retainedRoots,
		unevaluated: unevaluated.map((failure) => failure.target)
	});

	return { plan, evaluations };
}

// Keep the provenance return before the cache probe. Provenance requires every
// target to be rebuilt, so a probe cannot change the result and must not fail
// this plan.
async function retainedRootsFor(
	inputs: PlanInputs,
	evaluations: readonly TargetEvaluation[],
	dependencies: PlanDependencies
): Promise<Set<string>> {
	if (inputs.requireProvenance) {
		return new Set<string>();
	}

	const credentials =
		inputs.readUser === ''
			? {}
			: {
					credentials: { user: inputs.readUser, password: inputs.readPassword }
				};
	const fetcher =
		dependencies.fetcher === undefined ? {} : { fetcher: dependencies.fetcher };
	const availablePaths = await availableCachePaths({
		baseUrl: inputs.url,
		cache: inputs.cache,
		paths: cacheProbePaths(evaluations),
		...credentials,
		...fetcher
	});

	return ensureAvailableTargets(
		inputs,
		evaluations,
		availablePaths,
		dependencies.runner,
		dependencies.signal
	);
}

export function validateRemoteOutputPredictability(
	store: string,
	evaluations: readonly TargetEvaluation[],
	unevaluatedTargets: readonly string[] = []
): void {
	if (store === '') {
		return;
	}

	const unsupportedTargets = [
		...evaluations
			.filter(
				(evaluation) =>
					evaluation.targetPaths.length !== evaluation.target.outputs.length
			)
			.map((evaluation) => evaluation.target.attr),
		...unevaluatedTargets
	];

	if (unsupportedTargets.length === 0) {
		return;
	}

	throw new RemoteOutputPathUnknownDuringPlanningError(unsupportedTargets);
}

function unoptimisedPlan(targets: readonly PublishTarget[]): PublishPlan {
	return {
		retained: [],
		targets,
		cohorts: cohortsFor(targets),
		derivationToTargets: []
	};
}

async function writePlan(
	environment: Environment,
	inputs: PlanInputs,
	plan: PublishPlan,
	cohortDecisions: readonly CohortPreFilterDecision[],
	evaluations: readonly TargetEvaluation[],
	artifactName: string,
	measurer: NonNullable<PlanDependencies['measurer']>
): Promise<void> {
	const document = { ...plan, cohortPreFilter: cohortDecisions };

	await mkdir(path.dirname(inputs.planFile), { recursive: true });
	await writeFile(
		inputs.planFile,
		`${JSON.stringify(document, undefined, 2)}\n`
	);
	await setOutput(environment, 'plan-file', inputs.planFile);
	await setOutput(environment, 'plan-artifact-name', artifactName);
	await setOutput(
		environment,
		'target-matrix',
		matrix('target', targetMatrix(inputs, plan))
	);
	const prunedKeys = new Set(
		cohortDecisions
			.filter((decision) => decision.pruned)
			.map((decision) => decision.key)
	);
	const survivingCohorts = plan.cohorts.filter(
		(cohort) => !prunedKeys.has(cohort.key)
	);
	const packedCohorts = await packedCohortsFor(
		inputs,
		survivingCohorts,
		evaluations,
		measurer
	);
	const cohortEntries = cohortMatrix(inputs, packedCohorts, evaluations);
	await setOutput(
		environment,
		'cohort-matrix',
		matrix('cohort', cohortEntries)
	);
	await setOutput(environment, 'cohort-count', String(cohortEntries.length));
	await setOutput(environment, 'retained-count', String(plan.retained.length));
	await setOutput(environment, 'target-count', String(plan.targets.length));
}

export async function ensureAvailableTargets(
	inputs: PlanInputs,
	evaluations: readonly TargetEvaluation[],
	availablePaths: ReadonlySet<StorePathString>,
	runner: EnsureRunner = defaultEnsureRunner,
	signal?: AbortSignal
): Promise<Set<string>> {
	const cached = evaluations.filter(
		(evaluation) =>
			evaluation.targetPaths.length === evaluation.target.outputs.length &&
			evaluation.targetPaths.every((storePath) => availablePaths.has(storePath))
	);
	const results = await mapWithConcurrency(
		cached,
		maximumConcurrentRootEnsures,
		async (evaluation) => {
			const root = joinRoot(inputs.rootPrefix, evaluation.target.rootSuffix);
			const response = await ensureRoot(
				inputs,
				root,
				evaluation.targetPaths,
				runner,
				signal
			);

			return { rootSuffix: evaluation.target.rootSuffix, response };
		}
	);

	const retained = new Set<string>();

	for (const result of results) {
		if (result.response.status === 'retained') {
			retained.add(result.rootSuffix);
		}
	}

	return retained;
}

async function ensureRoot(
	inputs: PlanInputs,
	root: string,
	storePaths: readonly StorePathString[],
	runner: EnsureRunner,
	signal?: AbortSignal
): Promise<ParsedRootEnsureResponse> {
	const resultFile = path.join(
		inputs.temporaryDirectory,
		`cupboard-root-ensure-${randomUUID()}.jsonl`
	);
	const arguments_ = [
		'--output-mode',
		'github',
		'--no-colour',
		'--result-file',
		resultFile,
		'root',
		'ensure',
		canonicalHref(inputs.url),
		root,
		...storePaths,
		'--github-oidc'
	];

	if (inputs.audience !== '') {
		arguments_.push('--audience', inputs.audience);
	}

	if (inputs.cache !== '') {
		arguments_.push('--cache', inputs.cache);
	}

	if (inputs.ttl !== '') {
		arguments_.push('--ttl', inputs.ttl);
	}

	try {
		await runner(inputs.cupboardPath, arguments_, signal);
	} catch (error) {
		signal?.throwIfAborted();

		const replayed = replayCapturedCommandOutput(error);

		throw new RootEnsureCommandError(root, {
			cause: error,
			wasReported: replayed.wasReported
		});
	}

	return ensureResponse(root, await readEnsureResults(root, resultFile));
}

// A run that never opened its result file recorded no result. Any other read
// failure comes from the environment, so it propagates unchanged.
async function readEnsureResults(
	root: string,
	resultFile: string
): Promise<string> {
	try {
		return await readFile(resultFile, 'utf8');
	} catch (error) {
		if (isFileNotFound(error)) {
			throw new RootEnsureResultMissingError(root);
		}

		throw error;
	}
}

function isFileNotFound(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function ensureResponse(
	root: string,
	recorded: string
): ParsedRootEnsureResponse {
	let events: readonly ReporterResultEvent[];

	try {
		events = parseReporterResults(recorded);
	} catch (error) {
		throw new RootEnsureResultInvalidError(root, { cause: error });
	}

	for (const event of events) {
		if (event.kind !== 'root-ensure') {
			continue;
		}

		const response = rootEnsureResponseSchema.safeParse(event.data);

		if (!response.success) {
			throw new RootEnsureResultInvalidError(root, { cause: response.error });
		}

		return response.data;
	}

	throw new RootEnsureResultMissingError(root);
}

// Refresh the complete reconciled root, including content-addressed and
// upstream outputs that are absent from the current manifest. Refreshing only
// manifest targets could reconcile those retained outputs away.
async function readRootTargets(
	inputs: PlanInputs,
	root: string,
	runner: EnsureRunner,
	signal?: AbortSignal
): Promise<ReadonlySet<StorePathString>> {
	const resultFile = path.join(
		inputs.temporaryDirectory,
		`cupboard-root-targets-${randomUUID()}.jsonl`
	);
	const arguments_ = [
		'--output-mode',
		'github',
		'--no-colour',
		'--result-file',
		resultFile,
		'root',
		'targets',
		canonicalHref(inputs.url),
		root,
		'--github-oidc'
	];

	if (inputs.audience !== '') {
		arguments_.push('--audience', inputs.audience);
	}

	if (inputs.cache !== '') {
		arguments_.push('--cache', inputs.cache);
	}

	try {
		await runner(inputs.cupboardPath, arguments_, signal);
	} catch (error) {
		signal?.throwIfAborted();

		const replayed = replayCapturedCommandOutput(error);

		throw new RootTargetsCommandError(root, {
			cause: error,
			wasReported: replayed.wasReported
		});
	}

	const targets = rootTargetsResponse(
		root,
		await readRootTargetsResults(root, resultFile)
	);

	return new Set(targets.map((target) => target.storePath));
}

// A run that never opened its result file recorded no result. Any other read
// failure comes from the environment, so it propagates unchanged.
async function readRootTargetsResults(
	root: string,
	resultFile: string
): Promise<string> {
	try {
		return await readFile(resultFile, 'utf8');
	} catch (error) {
		if (isFileNotFound(error)) {
			throw new RootTargetsResultMissingError(root);
		}

		throw error;
	}
}

function rootTargetsResponse(
	root: string,
	recorded: string
): readonly ParsedRootTarget[] {
	let events: readonly ReporterResultEvent[];

	try {
		events = parseReporterResults(recorded);
	} catch (error) {
		throw new RootTargetsResultInvalidError(root, { cause: error });
	}

	for (const event of events) {
		if (event.kind !== 'root-targets') {
			continue;
		}

		const response = z.array(rootTargetSchema).safeParse(event.data);

		if (!response.success) {
			throw new RootTargetsResultInvalidError(root, { cause: response.error });
		}

		return response.data;
	}

	throw new RootTargetsResultMissingError(root);
}

async function targetCoverageOutcome(
	target: PublishTarget,
	evaluationByAttribute: ReadonlyMap<string, TargetEvaluation>,
	inputs: PlanInputs,
	runner: EnsureRunner,
	signal?: AbortSignal
): Promise<TargetCoverage> {
	const evaluation = evaluationByAttribute.get(target.attr);

	if (evaluation?.targetPaths.length !== target.outputs.length) {
		return { attr: target.attr, status: 'unknown-output' };
	}

	const root = joinRoot(inputs.rootPrefix, target.rootSuffix);
	let reconciledPaths: ReadonlySet<StorePathString>;

	try {
		reconciledPaths = await readRootTargets(inputs, root, runner, signal);
	} catch (error) {
		signal?.throwIfAborted();

		return {
			attr: target.attr,
			status: 'failed',
			reason: error instanceof Error ? error.message : String(error)
		};
	}

	if (reconciledPaths.size === 0) {
		return { attr: target.attr, status: 'not-covered' };
	}

	try {
		const response = await ensureRoot(
			inputs,
			root,
			[...reconciledPaths],
			runner,
			signal
		);

		return evaluateTargetCoverage(target, evaluation.targetPaths, {
			retained: response.status === 'retained',
			reconciledPaths
		});
	} catch (error) {
		signal?.throwIfAborted();

		return {
			attr: target.attr,
			status: 'failed',
			reason: error instanceof Error ? error.message : String(error)
		};
	}
}

/**
 * Returns an advisory prune decision for every cohort. The filter reads only
 * retention roots, so each remaining job still calculates its partition
 * against the selected store. A failed check keeps the cohort in the matrix
 * and records the reason without failing the plan.
 */
export async function cohortPreFilter(
	inputs: PlanInputs,
	plan: Pick<PublishPlan, 'cohorts'>,
	evaluations: readonly TargetEvaluation[],
	runner: EnsureRunner = defaultEnsureRunner,
	signal?: AbortSignal
): Promise<readonly CohortPreFilterDecision[]> {
	const evaluationByAttribute = new Map(
		evaluations.map((evaluation) => [evaluation.target.attr, evaluation])
	);
	const targets = plan.cohorts.flatMap((cohort) => cohort.targets);
	const coverageEntries = await mapWithConcurrency(
		targets,
		maximumConcurrentRootEnsures,
		(target) =>
			targetCoverageOutcome(
				target,
				evaluationByAttribute,
				inputs,
				runner,
				signal
			)
	);
	const coverageByAttribute = new Map(
		coverageEntries.map((entry) => [entry.attr, entry])
	);

	return plan.cohorts.map((cohort) =>
		cohortPreFilterDecision(cohort, coverageByAttribute)
	);
}

function targetMatrix(
	inputs: PlanInputs,
	plan: PublishPlan
): readonly object[] {
	return plan.targets.map((target) => ({
		attr: target.attr,
		system: target.system,
		os: target.os,
		remote: target.remote,
		bestEffort: target.bestEffort,
		rootSuffix: target.rootSuffix,
		outputs: target.outputs,
		root: joinRoot(inputs.rootPrefix, target.rootSuffix),
		runsOn: target.os
	}));
}

// `queryInstallables` uses derived paths from evaluation. `expectedPaths` has a
// value only for a target with one predictable output. A missing value in
// either list tells the build job to keep the target in its build set.
function cohortMatrix(
	inputs: PlanInputs,
	cohorts: readonly Cohort[],
	evaluations: readonly TargetEvaluation[]
): readonly object[] {
	const evaluationByAttribute = new Map(
		evaluations.map((evaluation) => [evaluation.target.attr, evaluation])
	);

	return cohorts.map((cohort) => ({
		key: cohort.key,
		attrs: cohort.targets.map((target) => target.attr),
		installables: cohort.installables,
		queryInstallables: cohort.targets.map((target) =>
			queryInstallableFor(target, evaluationByAttribute.get(target.attr))
		),
		expectedPaths: cohort.targets.map((target) =>
			expectedPathFor(target, evaluationByAttribute.get(target.attr))
		),
		system: cohort.system,
		os: cohort.os,
		remote: cohort.remote,
		bestEffort: isBestEffortCohort(cohort.targets),
		runsOn: cohort.os,
		roots: cohort.targets.map((target) =>
			joinRoot(inputs.rootPrefix, target.rootSuffix)
		)
	}));
}

async function packedCohortsFor(
	inputs: PlanInputs,
	cohorts: readonly Cohort[],
	evaluations: readonly TargetEvaluation[],
	measurer: NonNullable<PlanDependencies['measurer']>
): Promise<readonly Cohort[]> {
	if (!inputs.enablePacking) {
		return cohorts;
	}

	const measurements = await measurer(cohorts, evaluations);
	const packed = packCohorts({
		enabled: true,
		cohorts,
		measurements,
		capacity: inputs.packCapacity
	});

	return packed?.cohorts ?? cohorts;
}

const measurementSchema = z.object({
	downloadSize: z.number(),
	narSize: z.number()
});
const planMeasureResultSchema = z.object({
	measurements: z.record(z.string(), measurementSchema)
});

interface MeasurableTarget {
	readonly attr: string;
	readonly installable: string;
}

/**
 * Measures each surviving target's substitutable NAR size by invoking
 * `cupboard plan measure` once per target against the selected build store. If
 * any measurement fails, returns an empty map; the planner retains the cohorts
 * from the manifest and succeeds.
 */
export function packingMeasurer(
	inputs: PlanInputs,
	reporter: Reporter,
	runner: EnsureRunner = defaultEnsureRunner,
	signal?: AbortSignal
): NonNullable<PlanDependencies['measurer']> {
	return async (cohorts, evaluations) => {
		const evaluationByAttribute = new Map(
			evaluations.map((evaluation) => [evaluation.target.attr, evaluation])
		);
		const targets = cohorts.flatMap((cohort) =>
			cohort.targets.flatMap((target): MeasurableTarget[] => {
				const installable = queryInstallableFor(
					target,
					evaluationByAttribute.get(target.attr)
				);

				return installable === undefined
					? []
					: [{ attr: target.attr, installable }];
			})
		);

		if (targets.length === 0) {
			return new Map();
		}

		try {
			return await measureTargetSizes(inputs, targets, runner, signal);
		} catch (error) {
			signal?.throwIfAborted();

			reporter.warn(
				'Packing measurement failed; using the cohorts from the manifest',
				error instanceof Error ? error.message : String(error)
			);

			return new Map();
		}
	};
}

async function measureTargetSizes(
	inputs: PlanInputs,
	targets: readonly MeasurableTarget[],
	runner: EnsureRunner,
	signal?: AbortSignal
): Promise<ReadonlyMap<string, number>> {
	const identifier = randomUUID();
	const targetsFile = path.join(
		inputs.temporaryDirectory,
		`cupboard-plan-measure-targets-${identifier}.json`
	);
	const resultFile = path.join(
		inputs.temporaryDirectory,
		`cupboard-plan-measure-${identifier}.jsonl`
	);
	const measureFile = path.join(
		inputs.temporaryDirectory,
		`cupboard-plan-measure-${identifier}.json`
	);

	await writeFile(targetsFile, `${JSON.stringify({ targets })}\n`);
	await runner(
		inputs.cupboardPath,
		[
			'--output-mode',
			'github',
			'--no-colour',
			'--result-file',
			resultFile,
			'plan',
			'measure',
			'--targets-file',
			targetsFile,
			'--measure-file',
			measureFile,
			...(inputs.store === '' ? [] : ['--store', inputs.store])
		],
		signal
	);

	return measureResponse(await readMeasureResults(resultFile));
}

// A run that never opened its result file recorded no result. Any other read
// failure comes from the environment, so it propagates unchanged.
async function readMeasureResults(resultFile: string): Promise<string> {
	try {
		return await readFile(resultFile, 'utf8');
	} catch (error) {
		if (isFileNotFound(error)) {
			throw new MeasureResultMissingError();
		}

		throw error;
	}
}

function measureResponse(recorded: string): ReadonlyMap<string, number> {
	let events: readonly ReporterResultEvent[];

	try {
		events = parseReporterResults(recorded);
	} catch (error) {
		throw new MeasureResultInvalidError({ cause: error });
	}

	for (const event of events) {
		if (event.kind !== 'plan-measure') {
			continue;
		}

		const response = planMeasureResultSchema.safeParse(event.data);

		if (!response.success) {
			throw new MeasureResultInvalidError({ cause: response.error });
		}

		return new Map(
			Object.entries(response.data.measurements).map(([attribute, sizes]) => [
				attribute,
				sizes.narSize
			])
		);
	}

	throw new MeasureResultMissingError();
}

function queryInstallableFor(
	target: PublishTarget,
	evaluation: TargetEvaluation | undefined
): string | undefined {
	if (evaluation === undefined) {
		return undefined;
	}

	return `${evaluation.rootDrvPath}^${target.outputs.join(',')}`;
}

// Return no expected path unless exactly one selected output was resolved. The
// build job treats a missing expected path as requiring a build; choosing one
// output from a multi-output target could incorrectly prune it.
function expectedPathFor(
	target: PublishTarget,
	evaluation: TargetEvaluation | undefined
): string | undefined {
	if (
		target.outputs.length !== 1 ||
		evaluation?.targetPaths.length !== target.outputs.length
	) {
		return undefined;
	}

	return evaluation.targetPaths[0];
}

// GitHub runs at most this many jobs for a single matrix; an oversized plan
// is refused at plan time with the matrix and the counts named.
export const maximumMatrixJobs = 256;

export function matrix(name: string, entries: readonly object[]): string {
	if (entries.length > maximumMatrixJobs) {
		throw new MatrixJobLimitError(name, entries.length, maximumMatrixJobs);
	}

	return JSON.stringify({ include: entries });
}
