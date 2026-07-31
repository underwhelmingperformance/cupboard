import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from 'node:process';
import { promisify } from 'node:util';

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
	buildReceiptSchema,
	type ParsedBuildReceipt
} from '@cupboard/protocol/build';
import {
	graceCoverageResponseSchema,
	type ParsedGraceCoverageResponse,
	type ParsedRootEnsureResponse,
	type ParsedRootTarget,
	rootEnsureResponseSchema,
	rootSetMaxTargets,
	rootTargetSchema
} from '@cupboard/protocol/retention';
import {
	type ParsedUploadConfirmResponse,
	uploadConfirmResponseSchema
} from '@cupboard/protocol/upload';
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
	ComponentRootTargetLimitError,
	ConfirmCommandError,
	ConfirmResultInvalidError,
	ConfirmResultMissingError,
	GraceCoverageCommandError,
	GraceCoverageResultInvalidError,
	GraceCoverageResultMissingError,
	GraceDeadlineMissingError,
	GracePolicyMissingError,
	IntermediateRootInvalidError,
	InvalidInputError,
	MatrixJobLimitError,
	MissingInputError,
	PublishRootTargetLimitError,
	PublishTargetsJsonError,
	PublishTargetsSchemaError,
	RootEnsureCommandError,
	RootEnsureResultInvalidError,
	RootEnsureResultMissingError,
	RootTargetsCommandError,
	RootTargetsResultInvalidError,
	RootTargetsResultMissingError,
	ZeroGracePolicyError
} from '../errors.ts';
import { type Environment, requireEnvironment, setOutput } from '../inputs.ts';
import {
	isEnabled,
	provided,
	providedCache,
	providedReadUser,
	providedUrl
} from '../options.ts';
import {
	availableCachePaths,
	availableViewPaths,
	cacheProbePaths,
	type Cohort,
	type CohortPreFilterDecision,
	cohortPreFilterDecision,
	cohortsFor,
	derivationUses,
	evaluateTargetCoverage,
	evaluateTargets,
	expandComponents,
	joinRoot,
	type NixEvaluator,
	planPublish,
	type PublishPlan,
	type PublishTarget,
	publishTargetsSchema,
	type TargetCoverage,
	type TargetEvaluation,
	viewProbePaths
} from '../publish-plan.ts';

export type EnsureRunner = (
	command: string,
	arguments_: readonly string[]
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile);
const defaultEnsureRunner: EnsureRunner = (command, arguments_) =>
	execFileAsync(command, arguments_, {
		encoding: 'utf8',
		maxBuffer: 16 * 1024 * 1024
	});
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
	readonly reuseView?: string;
	readonly audience?: string;
	readonly cupboardPath?: string;
	readonly planFile?: string;
	readonly optimise?: string;
	readonly intermediateRetention?: string;
	readonly previousReceiptFile?: string;
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
	readonly intermediateRetention: 'root' | 'grace';
	readonly reuseView: string;
	readonly runId: string;
	readonly temporaryDirectory: string;
	// Absent when the caller has no receipt to pass, such as a repository's
	// first run: the cohort pre-filter then finds no target left upstream,
	// never a reason to treat every target's absence as unexplained.
	readonly previousReceiptFile?: string;
}

/**
 * The processes the plan reaches out through, injectable so tests can drive
 * the whole plan without a Nix store, a network or a cupboard binary.
 */
export interface PlanDependencies {
	readonly evaluator?: NixEvaluator;
	/**
	 * The store directory the runner's Nix reads, which the derivation paths in
	 * an evaluation are relative to. Discovered from the runner's configuration
	 * when it is not given.
	 */
	readonly storeDirectory?: StoreDirectory;
	readonly fetcher?: typeof fetch;
	readonly runner?: EnsureRunner;
	readonly createArtifactName?: () => string;
}

export function registerPlanCommand(
	program: Command,
	environment: Environment = env
): void {
	program
		.command('plan')
		.description(
			'Plan a flake publication around what the cache already serves.'
		)
		.requiredOption('--targets <json>', 'JSON target manifest to evaluate')
		.requiredOption('--url <url>', 'cupboard Worker URL')
		.requiredOption(
			'--cupboard-path <path>',
			'path to the cupboard binary installed by the setup action'
		)
		.requiredOption(
			'--root-prefix <prefix>',
			'retention-root prefix prepended to every target root suffix'
		)
		.option('--cache <name>', 'named cache to inspect and publish to')
		.option('--ttl <ttl>', 'TTL applied when retaining a cached target')
		.option('--read-user <user>', 'username for private cache reads')
		.option('--read-password <password>', 'password for private cache reads')
		.option(
			'--reuse-view <name>',
			'named tenant reuse view to probe for substitutable intermediates'
		)
		.option('--audience <audience>', 'GitHub OIDC audience (defaults to url)')
		.option('--plan-file <path>', 'destination for the detailed JSON plan')
		.option(
			'--optimise <value>',
			'inspect the cache and derivation graph: true or false'
		)
		.option(
			'--intermediate-retention <value>',
			"how seed and fallback intermediates are retained: 'root' or 'grace'"
		)
		.option(
			'--previous-receipt-file <path>',
			"path to the previous run's build receipt, when the workflow has one, " +
				'so the cohort pre-filter can recognise a target left upstream by an ' +
				'unchanged manifest'
		)
		.action((options: PlanOptions) => planAction(options, environment));
}

export function resolvePlanInputs(
	options: PlanOptions,
	environment: Environment
): PlanInputs {
	const declaredTargets = parseTargets(options.targets);

	validateComponentLimits(declaredTargets);

	const targets = expandComponents(declaredTargets);

	// A malformed URL would otherwise surface much later as a confusing OIDC
	// or fetch failure.
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

	const intermediateRetention =
		provided(options.intermediateRetention) ?? 'root';

	if (intermediateRetention !== 'root' && intermediateRetention !== 'grace') {
		throw new InvalidInputError(
			'intermediate-retention',
			"intermediate-retention must be 'root' or 'grace'"
		);
	}

	const temporaryDirectory = requireEnvironment(environment, 'RUNNER_TEMP');
	const runId = requireEnvironment(environment, 'GITHUB_RUN_ID');

	return {
		targets,
		url,
		cache: providedCache(options.cache),
		rootPrefix,
		ttl: provided(options.ttl) ?? '',
		readUser,
		readPassword,
		reuseView: provided(options.reuseView) ?? '',
		audience: provided(options.audience) ?? '',
		cupboardPath,
		optimise: isEnabled('optimise', options.optimise, true),
		intermediateRetention,
		runId,
		temporaryDirectory,
		planFile:
			provided(options.planFile) ??
			path.join(temporaryDirectory, 'cupboard-publish-plan.json'),
		...(provided(options.previousReceiptFile) !== undefined && {
			previousReceiptFile: provided(options.previousReceiptFile)
		})
	};
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

		throw new InvalidInputError(
			'root-prefix',
			`root-prefix and rootSuffix for ${target.attr} must form a root name of at most ${String(rootNameMaxLength)} characters without control characters`
		);
	}
}

function validateTargetOutputLimits(targets: readonly PublishTarget[]): void {
	for (const target of targets) {
		if (target.outputs.length <= rootSetMaxTargets) {
			continue;
		}

		throw new PublishRootTargetLimitError(
			'target',
			target.attr,
			target.outputs.length,
			rootSetMaxTargets
		);
	}
}

// Checked against the declared manifest, before expandComponents replaces
// each component-publication target with its components: the component
// count is exactly the target list the aggregate's one retention root would
// have to accept in a single write.
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

// Cohort membership is a manifest-wide invariant, like rootSuffix uniqueness,
// so a cohort spanning execution contexts is refused here, before evaluation
// or building starts, rather than only once the plan is written. The result
// is discarded: `optimisedPlan` and `unoptimisedPlan` each derive the plan's
// own cohorts from the same manifest once planning proceeds.
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
	const inputs = resolvePlanInputs(options, environment);
	const { plan, evaluations } = inputs.optimise
		? await optimisedPlan(inputs, reporter, dependencies)
		: { plan: unoptimisedPlan(inputs.targets), evaluations: [] };
	// The pre-filter needs the same evaluated graph the plan itself used, so
	// it only runs when planning did: the unoptimised path never inspects the
	// cache, and spawning every cohort's job unfiltered matches that.
	const cohortDecisions = inputs.optimise
		? await cohortPreFilter(
				inputs,
				plan,
				evaluations,
				await readPreviousReceipt(inputs.previousReceiptFile, reporter),
				dependencies.runner
			)
		: plan.cohorts.map((cohort) => ({ key: cohort.key, pruned: false }));

	await writePlan(
		environment,
		inputs,
		plan,
		cohortDecisions,
		evaluations,
		dependencies.createArtifactName?.() ??
			`cupboard-publish-plan-${randomUUID()}`
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

	for (const failure of unevaluated) {
		reporter.warn(
			`Planning ${failure.target.attr} as a direct build because it did not evaluate: ${failure.reason}`
		);
	}

	const uses = derivationUses(evaluations);
	const probePaths = cacheProbePaths(evaluations, uses);
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
		paths: probePaths,
		...credentials,
		...fetcher
	});
	// The view probe is a second, separate fact: it says where a shared
	// output can be substituted from, never what the destination retains.
	const viewAvailablePaths =
		inputs.reuseView === ''
			? undefined
			: await availableViewPaths({
					baseUrl: inputs.url,
					view: inputs.reuseView,
					paths: viewProbePaths(uses),
					...credentials,
					...fetcher
				});
	// Grace mode fails closed at plan time, in two halves. Coverage first: a
	// destination with no usable grace policy keeps nothing alive, so the run
	// refuses here, before the ensure calls below touch any retention root,
	// whether or not this manifest happens to produce a shared intermediate.
	if (inputs.intermediateRetention === 'grace') {
		await verifyGraceCoverage(inputs, dependencies.runner);
	} else {
		// Removing retained targets can split fallback groups, but cannot enlarge
		// them. Known outputs need a separate pass without fallback exclusions:
		// a split fallback group can expose seed candidates that it hid.
		const maximumFallbackPlan = planPublish({
			evaluations,
			retainedRoots: new Set(),
			availablePaths,
			...(viewAvailablePaths !== undefined && { viewAvailablePaths }),
			uses,
			unevaluated: unevaluated.map((failure) => failure.target)
		});
		const seedEligibleUses = new Map(
			uses.entries().filter(([, use]) => use.path !== undefined)
		);
		const maximumSeedPlan = planPublish({
			evaluations,
			retainedRoots: new Set(),
			availablePaths,
			...(viewAvailablePaths !== undefined && { viewAvailablePaths }),
			uses: seedEligibleUses,
			unevaluated: unevaluated.map((failure) => failure.target)
		});
		validateIntermediateRootTargetLimits(inputs, {
			seedGroups: maximumSeedPlan.seedGroups,
			fallbackGroups: maximumFallbackPlan.fallbackGroups
		});
	}

	const retainedRoots = await ensureAvailableTargets(
		inputs,
		evaluations,
		availablePaths,
		dependencies.runner
	);
	const plan = planPublish({
		evaluations,
		retainedRoots,
		availablePaths,
		...(viewAvailablePaths !== undefined && { viewAvailablePaths }),
		uses,
		unevaluated: unevaluated.map((failure) => failure.target)
	});

	// The second half: the intermediates that already reside at the
	// destination have their deadlines refreshed, and the plan fails unless
	// every deadline comes back positive.
	if (inputs.intermediateRetention === 'grace') {
		await confirmDestinationIntermediates(
			inputs,
			plan.destinationIntermediates,
			dependencies.runner
		);
	}

	return { plan, evaluations };
}

export function validateIntermediateRootTargetLimits(
	inputs: Pick<PlanInputs, 'intermediateRetention'>,
	plan: Pick<PublishPlan, 'seedGroups' | 'fallbackGroups'>
): void {
	if (inputs.intermediateRetention === 'grace') {
		return;
	}

	for (const group of plan.seedGroups) {
		validateIntermediateRootTargetLimit(
			'seed group',
			group.key,
			group.candidates.length
		);
	}

	for (const group of plan.fallbackGroups) {
		const count = group.targets.reduce(
			(total, target) => total + target.outputs.length,
			0
		);
		validateIntermediateRootTargetLimit('fallback group', group.key, count);
	}
}

function validateIntermediateRootTargetLimit(
	kind: 'seed group' | 'fallback group',
	identifier: string,
	count: number
): void {
	if (count <= rootSetMaxTargets) {
		return;
	}

	throw new PublishRootTargetLimitError(
		kind,
		identifier,
		count,
		rootSetMaxTargets
	);
}

function unoptimisedPlan(targets: readonly PublishTarget[]): PublishPlan {
	return {
		retained: [],
		targets,
		seedGroups: [],
		fallbackGroups: [],
		destinationIntermediates: [],
		cohorts: cohortsFor(targets),
		// No graph was evaluated, so there is nothing to invert.
		derivationToTargets: []
	};
}

async function writePlan(
	environment: Environment,
	inputs: PlanInputs,
	plan: PublishPlan,
	cohortDecisions: readonly CohortPreFilterDecision[],
	evaluations: readonly TargetEvaluation[],
	artifactName: string
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
		'seed-matrix',
		matrix('seed', seedMatrix(inputs, plan))
	);
	await setOutput(
		environment,
		'target-matrix',
		matrix('target', targetMatrix(inputs, plan))
	);
	await setOutput(
		environment,
		'fallback-matrix',
		matrix('fallback', fallbackMatrix(inputs, plan))
	);
	const cohortEntries = cohortMatrix(
		inputs,
		plan.cohorts,
		cohortDecisions,
		evaluations
	);
	await setOutput(
		environment,
		'cohort-matrix',
		matrix('cohort', cohortEntries)
	);
	await setOutput(environment, 'cohort-count', String(cohortEntries.length));
	await setOutput(environment, 'retained-count', String(plan.retained.length));
	await setOutput(environment, 'seed-count', String(plan.seedGroups.length));
	await setOutput(environment, 'target-count', String(plan.targets.length));
	await setOutput(
		environment,
		'fallback-count',
		String(plan.fallbackGroups.length)
	);
}

export async function ensureAvailableTargets(
	inputs: PlanInputs,
	evaluations: readonly TargetEvaluation[],
	availablePaths: ReadonlySet<StorePathString>,
	runner: EnsureRunner = defaultEnsureRunner
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
				runner
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
	runner: EnsureRunner
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
		await runner(inputs.cupboardPath, arguments_);
	} catch (error) {
		const replayed = replayCapturedCommandOutput(error);

		throw new RootEnsureCommandError(root, {
			cause: error,
			wasReported: replayed.wasReported
		});
	}

	return ensureResponse(root, await readEnsureResults(root, resultFile));
}

// A run that never opened its result file recorded no result; any other read
// failure is the caller's environment misbehaving and propagates as itself.
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

// A target the previous run recorded as left upstream is still fine to leave
// there: the store path is the same path that would be left upstream again,
// so an unchanged one names an unchanged manifest without comparing the
// manifest itself. A receipt with no outcomes section (a run that only
// built) covers nothing.
function leftUpstreamPathsFrom(
	receipt: ParsedBuildReceipt | undefined
): ReadonlySet<StorePathString> {
	const outcomes = receipt?.outcomes ?? [];

	return new Set(
		outcomes
			.filter((outcome) => outcome.outcome === 'left-upstream')
			.map((outcome) => outcome.storePath)
	);
}

// A missing or unusable receipt is not a plan failure: it simply leaves the
// pre-filter with no left-upstream coverage, exactly as a repository's first
// run has none.
async function readPreviousReceipt(
	filePath: string | undefined,
	reporter: Reporter
): Promise<ParsedBuildReceipt | undefined> {
	if (filePath === undefined) {
		return undefined;
	}

	try {
		const parsed = buildReceiptSchema.safeParse(
			JSON.parse(await readFile(filePath, 'utf8'))
		);

		if (!parsed.success) {
			reporter.warn(
				`Ignoring the previous receipt at ${filePath}: it does not match the build receipt schema`
			);
			return undefined;
		}

		return parsed.data;
	} catch (error) {
		reporter.warn(
			`Ignoring the previous receipt at ${filePath}: ${error instanceof Error ? error.message : String(error)}`
		);
		return undefined;
	}
}

// The store paths a root's last reconciliation wrote, freshly probed: the
// pre-filter's whole reason to exist is that this is not the current
// manifest's target list, so a content-addressed or upstream-left output the
// manifest no longer names still refreshes here rather than churning the
// job that would otherwise reconcile it away.
async function readRootTargets(
	inputs: PlanInputs,
	root: string,
	runner: EnsureRunner
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
		await runner(inputs.cupboardPath, arguments_);
	} catch (error) {
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

// A run that never opened its result file recorded no result; any other read
// failure is the caller's environment misbehaving and propagates as itself.
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

// One target's coverage, gathered by the IO the pure decision in
// evaluateTargetCoverage cannot itself perform. An unevaluated target, or one
// whose outputs are not all known before building, never reaches the read or
// ensure calls at all: the pre-filter reaches only targets whose output
// paths are known before building, per the design.
async function targetCoverageOutcome(
	target: PublishTarget,
	evaluationByAttribute: ReadonlyMap<string, TargetEvaluation>,
	leftUpstreamPaths: ReadonlySet<StorePathString>,
	inputs: PlanInputs,
	runner: EnsureRunner
): Promise<TargetCoverage> {
	const evaluation = evaluationByAttribute.get(target.attr);

	if (evaluation?.targetPaths.length !== target.outputs.length) {
		return { attr: target.attr, status: 'unknown-output' };
	}

	const root = joinRoot(inputs.rootPrefix, target.rootSuffix);
	let reconciledPaths: ReadonlySet<StorePathString>;

	try {
		reconciledPaths = await readRootTargets(inputs, root, runner);
	} catch (error) {
		return {
			attr: target.attr,
			status: 'failed',
			reason: error instanceof Error ? error.message : String(error)
		};
	}

	// An empty reconciled list means the root has nothing to refresh yet
	// (a target left entirely upstream may never have one): there is
	// nothing to ensure, so the check proceeds vacuously retained and the
	// receipt's left-upstream coverage decides the rest.
	if (reconciledPaths.size === 0) {
		return evaluateTargetCoverage(
			target,
			evaluation.targetPaths,
			{ retained: true, reconciledPaths },
			leftUpstreamPaths
		);
	}

	try {
		const response = await ensureRoot(
			inputs,
			root,
			[...reconciledPaths],
			runner
		);

		return evaluateTargetCoverage(
			target,
			evaluation.targetPaths,
			{ retained: response.status === 'retained', reconciledPaths },
			leftUpstreamPaths
		);
	} catch (error) {
		return {
			attr: target.attr,
			status: 'failed',
			reason: error instanceof Error ? error.message : String(error)
		};
	}
}

/**
 * The advisory destination pre-filter: for every cohort in the plan, decides
 * whether its job can be pruned because every member is already covered.
 * Machine-independent by construction, since it only reads and refreshes
 * retention roots; a spawned job's own partition against its own store stays
 * authoritative regardless of what this finds. A failure anywhere in a
 * cohort spawns that cohort's job and carries the reason, never composing a
 * build set and never failing the plan itself.
 */
export async function cohortPreFilter(
	inputs: PlanInputs,
	plan: Pick<PublishPlan, 'cohorts'>,
	evaluations: readonly TargetEvaluation[],
	previousReceipt: ParsedBuildReceipt | undefined,
	runner: EnsureRunner = defaultEnsureRunner
): Promise<readonly CohortPreFilterDecision[]> {
	const evaluationByAttribute = new Map(
		evaluations.map((evaluation) => [evaluation.target.attr, evaluation])
	);
	const leftUpstreamPaths = leftUpstreamPathsFrom(previousReceipt);
	const targets = plan.cohorts.flatMap((cohort) => cohort.targets);
	const coverageEntries = await mapWithConcurrency(
		targets,
		maximumConcurrentRootEnsures,
		(target) =>
			targetCoverageOutcome(
				target,
				evaluationByAttribute,
				leftUpstreamPaths,
				inputs,
				runner
			)
	);
	const coverageByAttribute = new Map(
		coverageEntries.map((entry) => [entry.attr, entry])
	);

	return plan.cohorts.map((cohort) =>
		cohortPreFilterDecision(cohort, coverageByAttribute)
	);
}

// Establishes, before anything is published, that a grace policy covers the
// destination cache, through `cupboard policy grace-coverage` under the same
// OIDC identity the confirm calls use.
export async function verifyGraceCoverage(
	inputs: PlanInputs,
	runner: EnsureRunner = defaultEnsureRunner
): Promise<void> {
	const resultFile = path.join(
		inputs.temporaryDirectory,
		`cupboard-grace-coverage-${randomUUID()}.jsonl`
	);
	const arguments_ = [
		'--output-mode',
		'github',
		'--no-colour',
		'--result-file',
		resultFile,
		'policy',
		'grace-coverage',
		canonicalHref(inputs.url),
		'--github-oidc'
	];

	if (inputs.audience !== '') {
		arguments_.push('--audience', inputs.audience);
	}

	if (inputs.cache !== '') {
		arguments_.push('--cache', inputs.cache);
	}

	try {
		await runner(inputs.cupboardPath, arguments_);
	} catch (error) {
		const replayed = replayCapturedCommandOutput(error);

		throw new GraceCoverageCommandError({
			cause: error,
			wasReported: replayed.wasReported
		});
	}

	const coverage = coverageResponse(await readCoverageResults(resultFile));

	if (!coverage.covered) {
		throw new GracePolicyMissingError(inputs.cache);
	}

	// A zero-grace policy covers the cache without ever materialising a
	// deadline, so every publication would fail later with a per-path
	// diagnosis pointing away from the real problem: the policy itself.
	if (coverage.graceSeconds === 0) {
		throw new ZeroGracePolicyError(inputs.cache);
	}
}

// A run that never opened its result file recorded no result; any other read
// failure is the caller's environment misbehaving and propagates as itself.
async function readCoverageResults(resultFile: string): Promise<string> {
	try {
		return await readFile(resultFile, 'utf8');
	} catch (error) {
		if (isFileNotFound(error)) {
			throw new GraceCoverageResultMissingError();
		}

		throw error;
	}
}

function coverageResponse(recorded: string): ParsedGraceCoverageResponse {
	let events: readonly ReporterResultEvent[];

	try {
		events = parseReporterResults(recorded);
	} catch (error) {
		throw new GraceCoverageResultInvalidError({ cause: error });
	}

	for (const event of events) {
		if (event.kind !== 'grace-coverage') {
			continue;
		}

		const response = graceCoverageResponseSchema.safeParse(event.data);

		if (!response.success) {
			throw new GraceCoverageResultInvalidError({ cause: response.error });
		}

		return response.data;
	}

	throw new GraceCoverageResultMissingError();
}

// Refreshes the retention deadline of every destination-resident intermediate
// through `cupboard confirm`, the publication-free half of grace mode's
// fail-closed rule: an intermediate the plan omits from seeding must carry a
// positive deadline before a later job relies on substituting it.
export async function confirmDestinationIntermediates(
	inputs: PlanInputs,
	storePaths: readonly StorePathString[],
	runner: EnsureRunner = defaultEnsureRunner
): Promise<void> {
	if (storePaths.length === 0) {
		return;
	}

	const resultFile = path.join(
		inputs.temporaryDirectory,
		`cupboard-confirm-${randomUUID()}.jsonl`
	);
	const arguments_ = [
		'--output-mode',
		'github',
		'--no-colour',
		'--result-file',
		resultFile,
		'confirm',
		canonicalHref(inputs.url),
		...storePaths,
		'--github-oidc'
	];

	if (inputs.audience !== '') {
		arguments_.push('--audience', inputs.audience);
	}

	if (inputs.cache !== '') {
		arguments_.push('--cache', inputs.cache);
	}

	try {
		await runner(inputs.cupboardPath, arguments_);
	} catch (error) {
		const replayed = replayCapturedCommandOutput(error);
		// An unconfirmed path makes the CLI exit non-zero after it has already
		// recorded the per-path result, so the failure carries the
		// classification's input; only a run with no recorded result stays a
		// bare command error.
		const recorded = await confirmResponseIfRecorded(resultFile);

		if (recorded === undefined) {
			throw new ConfirmCommandError({
				cause: error,
				wasReported: replayed.wasReported
			});
		}

		classifyMissingGrace(inputs, recorded);

		// The result names nothing missing, so the failure is something else;
		// it stays a command error carrying the CLI's own failure.
		throw new ConfirmCommandError({
			cause: error,
			wasReported: replayed.wasReported
		});
	}

	classifyMissingGrace(
		inputs,
		confirmResponse(await readConfirmResults(resultFile))
	);
}

// A confirmed path with no deadline means the cache itself has no usable
// grace policy: the confirm endpoint answers an empty grace fact exactly when
// no policy matched and names a matched zero-grace policy in `graceSeconds`,
// and resolution is cache-level, so one such path implies every path and the
// cache-level error names the actual remedy. An unconfirmed path is genuinely
// per-path: the confirm no longer found it committed, which points at
// reseeding.
function classifyMissingGrace(
	inputs: PlanInputs,
	response: ParsedUploadConfirmResponse
): void {
	const missing = response.paths.filter(
		(confirmed) => confirmed.grace?.retainUntil === undefined
	);

	if (
		missing.some(
			(confirmed) => confirmed.confirmed && confirmed.grace?.graceSeconds === 0
		)
	) {
		throw new ZeroGracePolicyError(inputs.cache);
	}

	if (missing.some((confirmed) => confirmed.confirmed)) {
		throw new GracePolicyMissingError(inputs.cache);
	}

	const perPath = missing.map((confirmed) => ({
		storePathHash: confirmed.storePathHash,
		reason: 'not-present' as const
	}));

	if (perPath.length > 0) {
		throw new GraceDeadlineMissingError(perPath);
	}
}

// The recorded confirm result of a failing run, when one exists: any absence
// or malformation reads as "nothing recorded", since the run's own failure is
// about to surface either way.
async function confirmResponseIfRecorded(
	resultFile: string
): Promise<ParsedUploadConfirmResponse | undefined> {
	let recorded: string;

	try {
		recorded = await readFile(resultFile, 'utf8');
	} catch {
		return undefined;
	}

	let events: readonly ReporterResultEvent[];

	try {
		events = parseReporterResults(recorded);
	} catch {
		return undefined;
	}

	for (const event of events) {
		if (event.kind !== 'confirm-paths') {
			continue;
		}

		const response = uploadConfirmResponseSchema.safeParse(event.data);

		return response.success ? response.data : undefined;
	}

	return undefined;
}

// A run that never opened its result file recorded no result; any other read
// failure is the caller's environment misbehaving and propagates as itself.
async function readConfirmResults(resultFile: string): Promise<string> {
	try {
		return await readFile(resultFile, 'utf8');
	} catch (error) {
		if (isFileNotFound(error)) {
			throw new ConfirmResultMissingError();
		}

		throw error;
	}
}

function confirmResponse(recorded: string): ParsedUploadConfirmResponse {
	let events: readonly ReporterResultEvent[];

	try {
		events = parseReporterResults(recorded);
	} catch (error) {
		throw new ConfirmResultInvalidError({ cause: error });
	}

	for (const event of events) {
		if (event.kind !== 'confirm-paths') {
			continue;
		}

		const response = uploadConfirmResponseSchema.safeParse(event.data);

		if (!response.success) {
			throw new ConfirmResultInvalidError({ cause: response.error });
		}

		return response.data;
	}

	throw new ConfirmResultMissingError();
}

// Each target job's matrix entry carries the full root its push publishes
// under, computed by the same construction the ensure calls use, so the two
// paths a target can take to retention name one root. The `runs-on` value is
// the manifest's `os` label: the manifest is the operator's flake, so where
// its targets build is operator configuration, exactly like the labels in
// any hand-written workflow.
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

// A pruned cohort needs no job at all, so its entry is dropped rather than
// carried through with a flag a workflow would have to remember to check;
// the surviving entries carry every member's attr, installable and root, so
// a cohort job builds and publishes without asking the plan anything
// further. `installables` names each member the way `nix build` resolves it
// (a flake reference); `queryInstallables` names the same member the way the
// Nix daemon's store protocol does (a derivation store path), which is what
// the cohort job's own availability partition queries against, so both
// travel side by side rather than one being derived from the other at build
// time. Neither is known until the target evaluates, so an unevaluated or
// still-floating member reports `undefined` in both and its build-time
// availability check treats it as always needing to build, per the design.
function cohortMatrix(
	inputs: PlanInputs,
	cohorts: readonly Cohort[],
	decisions: readonly CohortPreFilterDecision[],
	evaluations: readonly TargetEvaluation[]
): readonly object[] {
	const prunedKeys = new Set(
		decisions
			.filter((decision) => decision.pruned)
			.map((decision) => decision.key)
	);
	const evaluationByAttribute = new Map(
		evaluations.map((evaluation) => [evaluation.target.attr, evaluation])
	);

	return cohorts
		.filter((cohort) => !prunedKeys.has(cohort.key))
		.map((cohort) => ({
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
			runsOn: cohort.os,
			roots: cohort.targets.map((target) =>
				joinRoot(inputs.rootPrefix, target.rootSuffix)
			)
		}));
}

// The derived-path form of a target member, the way the Nix daemon's store
// protocol names a realisation target: the evaluated root derivation and the
// outputs the manifest selected, exactly as `Cohort.installables` builds the
// flake-reference form from the same target's attr and outputs. A target
// that did not evaluate has no derivation path to build this from.
function queryInstallableFor(
	target: PublishTarget,
	evaluation: TargetEvaluation | undefined
): string | undefined {
	if (evaluation === undefined) {
		return undefined;
	}

	return `${evaluation.rootDrvPath}^${target.outputs.join(',')}`;
}

// The single output path a build-time availability check can classify a
// target member by. A target with more than one selected output has no one
// path that represents it, and a target whose evaluation left any selected
// output unresolved (a content-addressed or otherwise floating output) has
// none at all; both report `undefined` and the target always joins the
// build set, exactly as a manifest target with no predictable output does
// elsewhere in the plan.
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

// The exact retention values a seed or fallback group's push publishes with,
// decided here so every combination of retention mode and reuse view is
// provable by tests: root mode keeps each
// group's outputs under a temporary per-run seed root, grace mode publishes
// them unretained and requires a positive grace deadline for each.
export function groupRetention(
	inputs: Pick<PlanInputs, 'intermediateRetention' | 'rootPrefix' | 'runId'>,
	key: string
): {
	readonly root: string;
	readonly ttl: string;
	readonly noRetain: boolean;
	readonly requireGrace: boolean;
} {
	if (inputs.intermediateRetention === 'grace') {
		return { root: '', ttl: '', noRetain: true, requireGrace: true };
	}

	const root = joinRoot(
		inputs.rootPrefix,
		`_cupboard-seed/${inputs.runId}/${key}`
	);

	if (!rootNameSchema.safeParse(root).success) {
		throw new IntermediateRootInvalidError(rootNameMaxLength);
	}

	return {
		root,
		ttl: '24h',
		noRetain: false,
		requireGrace: false
	};
}

export function seedMatrix(
	inputs: PlanInputs,
	plan: Pick<PublishPlan, 'seedGroups'>
): readonly object[] {
	return plan.seedGroups.map((group) => ({
		key: group.key,
		system: group.system,
		os: group.os,
		remote: group.remote,
		runsOn: group.os,
		...groupRetention(inputs, group.key)
	}));
}

export function fallbackMatrix(
	inputs: PlanInputs,
	plan: Pick<PublishPlan, 'fallbackGroups'>
): readonly object[] {
	return plan.fallbackGroups.map((group) => ({
		key: group.key,
		system: group.system,
		os: group.os,
		remote: group.remote,
		runsOn: group.os,
		...groupRetention(inputs, group.key)
	}));
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
