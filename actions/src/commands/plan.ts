import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from 'node:process';
import { promisify } from 'node:util';

import {
	rootNameMaxLength,
	rootNameSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import {
	type ParsedRootEnsureResponse,
	rootEnsureResponseSchema
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
import type { Command } from 'commander';
import { z } from 'zod';

import {
	ConfirmCommandError,
	ConfirmResultInvalidError,
	ConfirmResultMissingError,
	GraceDeadlineMissingError,
	IntermediateRootInvalidError,
	InvalidInputError,
	MatrixJobLimitError,
	MissingInputError,
	PublishTargetsJsonError,
	PublishTargetsSchemaError,
	RootEnsureCommandError,
	RootEnsureResultInvalidError,
	RootEnsureResultMissingError,
	RunnerNotAllowedError
} from '../errors.ts';
import { type Environment, requireEnvironment, setOutput } from '../inputs.ts';
import { isEnabled, provided } from '../options.ts';
import {
	availableCachePaths,
	cacheProbePaths,
	canonicalRunnerLabel,
	derivationUses,
	disallowedRunners,
	evaluateTargets,
	isValidRunnerLabel,
	joinRoot,
	parseRunnerRoutes,
	planPublish,
	type PublishPlan,
	type PublishTarget,
	publishTargetsSchema,
	type RunnerRoute,
	type TargetEvaluation
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
	readonly audience?: string;
	readonly cupboardPath?: string;
	readonly planFile?: string;
	readonly optimise?: string;
	readonly intermediateRetention?: string;
	readonly runners?: string;
}

export interface PlanInputs {
	readonly targets: readonly PublishTarget[];
	readonly url: string;
	readonly cache: string;
	readonly rootPrefix: string;
	readonly ttl: string;
	readonly readUser: string;
	readonly readPassword: string;
	readonly audience: string;
	readonly cupboardPath: string;
	readonly planFile: string;
	readonly optimise: boolean;
	readonly intermediateRetention: 'root' | 'grace';
	readonly runId: string;
	readonly runnerRoutes: ReadonlyMap<string, RunnerRoute>;
	readonly temporaryDirectory: string;
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
			'--runners <entries>',
			'runner labels the manifest may use, as label or label@group entries'
		)
		.action((options: PlanOptions) => planAction(options, environment));
}

export function resolvePlanInputs(
	options: PlanOptions,
	environment: Environment
): PlanInputs {
	const targets = parseTargets(options.targets);
	const runnersSource = provided(options.runners) ?? '';

	validateRunnerEntries(runnersSource);

	const runnerRoutes = parseRunnerRoutes(runnersSource);
	const badRunners = disallowedRunners(targets, new Set(runnerRoutes.keys()));

	if (badRunners.length > 0) {
		throw new RunnerNotAllowedError(badRunners);
	}

	const url = provided(options.url);

	if (url === undefined) {
		throw new MissingInputError('url');
	}

	const rootPrefix = provided(options.rootPrefix);

	if (rootPrefix === undefined) {
		throw new MissingInputError('root-prefix');
	}

	validateTargetRoots(rootPrefix, targets);

	const cupboardPath = provided(options.cupboardPath);

	if (cupboardPath === undefined) {
		throw new MissingInputError('cupboard-path');
	}

	// The password is taken verbatim: surrounding whitespace is part of a
	// credential, so only its complete absence means "no password".
	const readUser = provided(options.readUser) ?? '';
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
		cache: provided(options.cache) ?? '',
		rootPrefix,
		ttl: provided(options.ttl) ?? '',
		readUser,
		readPassword,
		audience: provided(options.audience) ?? url,
		cupboardPath,
		optimise: isEnabled('optimise', options.optimise, true),
		intermediateRetention,
		runId,
		runnerRoutes,
		temporaryDirectory,
		planFile:
			provided(options.planFile) ??
			path.join(temporaryDirectory, 'cupboard-publish-plan.json')
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

// The manifest is pull-request-controlled, so its runner labels are checked
// against the operator-controlled allow-list, with nothing built in, before
// any matrix is emitted.
function validateRunnerEntries(source: string): void {
	const entries = source.split(/[\s,]+/u).filter((entry) => entry !== '');

	for (const entry of entries) {
		if (!/^[^@\s,]+(?:@[^@\s,]+)?$/u.test(entry)) {
			throw new InvalidInputError(
				'runners',
				`runners entry '${entry}' must be a label or label@group`
			);
		}

		const separator = entry.indexOf('@');
		const label = separator === -1 ? entry : entry.slice(0, separator);

		// The label restriction exists because case folding is only exact within
		// ASCII; the group restriction is this syntax's own grammar, so a group
		// name GitHub would accept (spaces included) must be renamed to use it.
		if (!isValidRunnerLabel(label)) {
			throw new InvalidInputError(
				'runners',
				`runner label '${label}' must be printable ASCII`
			);
		}

		if (separator !== -1 && !isValidRunnerLabel(entry.slice(separator + 1))) {
			throw new InvalidInputError(
				'runners',
				`runner group '${entry.slice(separator + 1)}' must be printable ASCII`
			);
		}
	}
}

export async function planAction(
	options: PlanOptions,
	environment: Environment = env,
	reporter: Reporter = createGithubReporter()
): Promise<void> {
	const inputs = resolvePlanInputs(options, environment);
	const plan = inputs.optimise
		? await optimisedPlan(inputs, reporter)
		: unoptimisedPlan(inputs.targets);

	await writePlan(environment, inputs, plan);
}

async function optimisedPlan(
	inputs: PlanInputs,
	reporter: Reporter
): Promise<PublishPlan> {
	const { evaluations, unevaluated } = await evaluateTargets(inputs.targets);

	for (const failure of unevaluated) {
		reporter.warn(
			`Planning ${failure.target.attr} as a direct build because it did not evaluate: ${failure.reason}`
		);
	}

	const uses = derivationUses(evaluations);
	const availablePaths = await availableCachePaths({
		baseUrl: inputs.url,
		cache: inputs.cache,
		paths: cacheProbePaths(evaluations, uses),
		...(inputs.readUser !== '' && {
			credentials: { user: inputs.readUser, password: inputs.readPassword }
		})
	});
	const retainedRoots = await ensureAvailableTargets(
		inputs,
		evaluations,
		availablePaths
	);
	const plan = planPublish({
		evaluations,
		retainedRoots,
		availablePaths,
		uses,
		unevaluated: unevaluated.map((failure) => failure.target)
	});

	// Grace mode must not rely on a destination-resident intermediate whose
	// deadline is about to lapse: refresh each one and fail closed unless every
	// deadline comes back positive.
	if (inputs.intermediateRetention === 'grace') {
		await confirmDestinationIntermediates(
			inputs,
			plan.destinationIntermediates
		);
	}

	return plan;
}

function unoptimisedPlan(targets: readonly PublishTarget[]): PublishPlan {
	return {
		retained: [],
		targets,
		seedGroups: [],
		fallbackGroups: [],
		destinationIntermediates: []
	};
}

async function writePlan(
	environment: Environment,
	inputs: PlanInputs,
	plan: PublishPlan
): Promise<void> {
	await mkdir(path.dirname(inputs.planFile), { recursive: true });
	await writeFile(inputs.planFile, `${JSON.stringify(plan, undefined, 2)}\n`);
	await setOutput(environment, 'plan-file', inputs.planFile);
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
		inputs.url,
		root,
		...storePaths,
		'--github-oidc',
		'--audience',
		inputs.audience
	];

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
		inputs.url,
		...storePaths,
		'--github-oidc',
		'--audience',
		inputs.audience
	];

	if (inputs.cache !== '') {
		arguments_.push('--cache', inputs.cache);
	}

	try {
		await runner(inputs.cupboardPath, arguments_);
	} catch (error) {
		const replayed = replayCapturedCommandOutput(error);

		throw new ConfirmCommandError({
			cause: error,
			wasReported: replayed.wasReported
		});
	}

	const response = confirmResponse(await readConfirmResults(resultFile));
	const missing = response.paths
		.filter((confirmed) => confirmed.grace?.retainUntil === undefined)
		.map((confirmed) => ({
			storePathHash: confirmed.storePathHash,
			reason:
				confirmed.grace?.graceSeconds === undefined
					? ('no-policy-matched' as const)
					: ('pending' as const)
		}));

	if (missing.length > 0) {
		throw new GraceDeadlineMissingError(missing);
	}
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
// paths a target can take to retention name one root.
// Every matrix entry carries the exact `runs-on` value its job uses, routed
// through the operator's allow-list so a group-qualified entry pins the
// runner group, not just the label spelling. Validation already proved every
// label is named; the fallback to the bare label satisfies the type.
function runsOnFor(inputs: PlanInputs, os: string): RunnerRoute {
	return inputs.runnerRoutes.get(canonicalRunnerLabel(os)) ?? os;
}

function targetMatrix(
	inputs: PlanInputs,
	plan: PublishPlan
): readonly object[] {
	return plan.targets.map((target) => ({
		...target,
		root: joinRoot(inputs.rootPrefix, target.rootSuffix),
		runsOn: runsOnFor(inputs, target.os)
	}));
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
	plan: PublishPlan
): readonly object[] {
	return plan.seedGroups.map((group) => ({
		key: group.key,
		system: group.system,
		os: group.os,
		remote: group.remote,
		runsOn: runsOnFor(inputs, group.os),
		...groupRetention(inputs, group.key)
	}));
}

export function fallbackMatrix(
	inputs: PlanInputs,
	plan: PublishPlan
): readonly object[] {
	return plan.fallbackGroups.map((group) => ({
		key: group.key,
		system: group.system,
		os: group.os,
		remote: group.remote,
		runsOn: runsOnFor(inputs, group.os),
		...groupRetention(inputs, group.key)
	}));
}

// GitHub runs at most this many jobs for a single matrix, so an oversized
// plan is refused here, where the matrix and the counts can be named, rather
// than as an opaque rejection at dispatch.
export const maximumMatrixJobs = 256;

export function matrix(name: string, entries: readonly object[]): string {
	if (entries.length > maximumMatrixJobs) {
		throw new MatrixJobLimitError(name, entries.length, maximumMatrixJobs);
	}

	return JSON.stringify({ include: entries });
}
