import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { env } from 'node:process';

import { Nix } from '@cupboard/nix';
import { type CacheScope } from '@cupboard/nix-store/scalars';
import { canonicalHref } from '@cupboard/nix-store/url';
import {
	type PushSummary,
	pushSummaryResultKind,
	pushSummarySchema
} from '@cupboard/protocol/reports';
import {
	createGithubReporter,
	type Reporter,
	type ReporterResultEvent
} from '@cupboard/reporter';
import type { Command } from 'commander';
import { z } from 'zod';

import {
	observeChildProcess,
	waitForAbortableChildProcess
} from '../child-process.ts';
import {
	type CupboardResultProtocol,
	type CupboardRunResult,
	detectCupboardResultProtocol,
	runCupboardWithProtocol
} from '../cupboard-run.ts';
import {
	CommandFailedError,
	CupboardReleaseSelectionConflictError,
	CupboardVersionOutputMissingError,
	GraceDeadlineMissingError,
	GracePolicyMissingError,
	GraceWaitConflictError,
	LegacyPushSummaryError,
	type MissingGracePath,
	MissingInputError,
	PushPathsMissingError,
	PushSummaryMissingError,
	PushSummaryResponseError,
	ReferenceSourcePairingError,
	RootGroupsJsonInvalidError,
	RootGroupsPathsConflictError,
	RootGroupsRetentionConflictError,
	RootGroupsRootConflictError,
	RootGroupsSchemaError,
	RootRetentionConflictError,
	RunRootRequiredError,
	TtlRetentionConflictError
} from '../errors.ts';
import { type Environment, requireEnvironment, setOutput } from '../inputs.ts';
import {
	collectLines,
	isEnabled,
	provided,
	providedCacheSelection,
	providedUrl
} from '../options.ts';
import {
	fallbackReleaseRepository,
	installCupboard,
	normaliseVersion
} from '../release-install.ts';
import { cacheUrlFor } from '../substituters.ts';

const legacyPushSummarySchema = pushSummarySchema.omit({ paths: true });

export interface RootGroup {
	readonly root: string;
	readonly paths: readonly string[];
}

const rootGroupSchema = z.object({
	root: z.string().min(1),
	paths: z.array(z.string().min(1)).min(1)
});
const rootGroupsSchema = z.array(rootGroupSchema);

export interface PushOptions {
	readonly url?: string;
	readonly paths: readonly string[];
	readonly cupboardPath?: string;
	readonly cupboardVersion?: string;
	readonly includePrereleases?: string;
	readonly githubToken?: string;
	readonly releaseRepository?: string;
	readonly expectedSourceCommit?: string;
	readonly installDir?: string;
	readonly cache?: string;
	readonly store?: string;
	readonly audience?: string;
	readonly root?: string;
	readonly ttl?: string;
	readonly retain?: string;
	readonly wait?: string;
	readonly requireGrace?: string;
	readonly waitTimeout?: string;
	readonly attestations: readonly string[];
	readonly intermediatePathsFile?: string;
	readonly referencePathsFile?: string;
	readonly referenceSource?: string;
	readonly runRoot?: string;
	readonly runRootTtl?: string;
	readonly rootGroups?: string;
}

export interface PushInputs {
	readonly cupboardPath: string;
	readonly version: string;
	readonly includePrereleases: boolean;
	readonly githubToken: string;
	readonly releaseRepository: string;
	readonly expectedSourceCommit: string;
	readonly installDirectory: string;
	readonly url: URL;
	readonly paths: readonly string[];
	readonly cache: CacheScope;
	readonly store: string;
	readonly audience: string;
	readonly root: string;
	readonly ttl: string;
	readonly retain: boolean;
	readonly wait: boolean;
	readonly waitTimeout: string;
	readonly attestations: readonly string[];
	readonly requireGrace: boolean;
	readonly intermediatePathsFile: string;
	readonly referencePathsFile: string;
	readonly referenceSource: string;
	readonly runRoot: string;
	readonly runRootTtl: string;
	readonly rootGroups: readonly RootGroup[];
}

interface RunPushCupboardOptions {
	readonly binaryPath: string;
	readonly arguments: readonly string[];
	readonly environment: Environment;
	readonly requireGrace: boolean;
	readonly version: string;
	readonly signal?: AbortSignal;
}

export interface PushActionDependencies {
	readonly signal?: AbortSignal;
}

interface RunPushCupboardDependencies {
	readonly detectResultProtocol: typeof detectCupboardResultProtocol;
	readonly run: typeof runCupboardWithProtocol;
}

const defaultRunPushCupboardDependencies: RunPushCupboardDependencies = {
	detectResultProtocol: detectCupboardResultProtocol,
	run: runCupboardWithProtocol
};

interface PushArgumentsOptions {
	readonly url: URL;
	readonly paths: readonly string[];
	readonly audience: string;
	readonly root: string;
	readonly cache: CacheScope;
	readonly store: string;
	readonly ttl: string;
	readonly retain: boolean;
	readonly wait: boolean;
	readonly waitTimeout: string;
	readonly attestations: readonly string[];
	readonly intermediatePathsFile: string;
	readonly referencePathsFile: string;
	readonly referenceSource: string;
	readonly runRoot: string;
	readonly runRootTtl: string;
}

export function registerPushCommand(
	program: Command,
	environment: Environment = env,
	signal?: AbortSignal
): void {
	program
		.command('push')
		.description('Push local Nix store paths to a cupboard cache.')
		.requiredOption('--url <url>', 'URL of the cupboard Worker')
		.option(
			'--paths <path>',
			'local Nix store path, derivation or installable to push (repeatable, or newline-delimited)',
			collectLines,
			[]
		)
		.option(
			'--cupboard-path <path>',
			'use this pre-acquired cupboard executable and skip release installation'
		)
		.option(
			'--cupboard-version <version>',
			'cupboard version to install: latest or an exact published release tag'
		)
		.option(
			'--include-prereleases <value>',
			'include prereleases when resolving latest: true or false'
		)
		.option('--github-token <token>', 'GitHub token used for release API calls')
		.option(
			'--release-repository <repository>',
			'repository that publishes cupboard release assets'
		)
		.option(
			'--expected-source-commit <commit>',
			'require the release to have been built from this full commit id'
		)
		.option(
			'--install-dir <directory>',
			'directory for the downloaded cupboard binary'
		)
		.option('--cache <name>', 'Push to a named cache.')
		.option(
			'--store <uri>',
			'read path metadata and NAR bytes from this remote ssh-ng store'
		)
		.option(
			'--audience <audience>',
			'GitHub OIDC audience (defaults to the canonical Worker URL)'
		)
		.option('--root <root>', 'retention root to update with the pushed paths')
		.option('--ttl <ttl>', 'retention TTL such as 7d or 12h')
		.option(
			'--retain <value>',
			'add the pushed paths to the retention root: true or false'
		)
		.option(
			'--require-grace <value>',
			'fail if any pushed path has no retention grace deadline: true or false'
		)
		.option(
			'--wait <value>',
			'wait for deferred blobs to become servable: true or false'
		)
		.option(
			'--wait-timeout <timeout>',
			'wait timeout, applied separately to commit capacity and to deferred blobs'
		)
		.option(
			'--attestations <path>',
			'local Sigstore DSSE bundle to attach (repeatable, or newline-delimited)',
			collectLines,
			[]
		)
		.option(
			'--intermediate-paths-file <path>',
			'newline-delimited store paths to publish alongside the targets without retaining them as targets'
		)
		.option(
			'--reference-paths-file <path>',
			'newline-delimited store paths to publish from the reference source; their NAR blobs must already exist in the tenant'
		)
		.option(
			'--reference-source <url>',
			'cache endpoint that serves the reference paths (required with --reference-paths-file)'
		)
		.option('--run-root <name>', 'add every committed path to this run root')
		.option('--run-root-ttl <ttl>', 'expire the run root after this duration')
		.option(
			'--root-groups <json>',
			'JSON array of {root, paths} groups; replaces paths and root and runs one push per group'
		)
		.action((options: PushOptions) =>
			pushAction(options, environment, undefined, {
				...(signal !== undefined && { signal })
			})
		);
}

export function resolvePushInputs(
	options: PushOptions,
	environment: Environment
): PushInputs {
	const url = providedUrl('url', options.url);

	if (url === undefined) {
		throw new MissingInputError('url');
	}

	const rootGroups = parseRootGroups(options.rootGroups);

	if (rootGroups.length === 0 && options.paths.length === 0) {
		throw new PushPathsMissingError();
	}

	if (rootGroups.length > 0 && options.paths.length > 0) {
		throw new RootGroupsPathsConflictError();
	}

	const isRetained = isEnabled('retain', options.retain, true);
	const explicitRoot = provided(options.root);

	if (explicitRoot !== undefined && rootGroups.length > 0) {
		throw new RootGroupsRootConflictError();
	}

	if (!isRetained && rootGroups.length > 0) {
		throw new RootGroupsRetentionConflictError();
	}

	// Disabling retention suppresses the action's implicit default root. An
	// explicit root or TTL still requests retention, so reject either one when
	// retention is disabled.
	if (!isRetained && explicitRoot !== undefined) {
		throw new RootRetentionConflictError();
	}

	const explicitTtl = provided(options.ttl);

	if (!isRetained && explicitTtl !== undefined) {
		throw new TtlRetentionConflictError();
	}

	const shouldWait = isEnabled('wait', options.wait, true);
	const requiresGrace = isEnabled('require-grace', options.requireGrace, false);

	// A path has no grace deadline until verification finishes. `require-grace`
	// therefore cannot succeed when waiting is disabled.
	if (requiresGrace && !shouldWait) {
		throw new GraceWaitConflictError();
	}

	const referencePathsFile = provided(options.referencePathsFile);
	const referenceSource = provided(options.referenceSource);

	if ((referencePathsFile === undefined) !== (referenceSource === undefined)) {
		throw new ReferenceSourcePairingError();
	}

	const runRoot = provided(options.runRoot);
	const runRootTtl = provided(options.runRootTtl);

	if (runRootTtl !== undefined && runRoot === undefined) {
		throw new RunRootRequiredError(runRootTtl);
	}

	const cupboardPath = provided(options.cupboardPath) ?? '';
	const releaseSelectors = [
		options.cupboardVersion,
		options.includePrereleases,
		options.releaseRepository,
		options.expectedSourceCommit
	];

	if (
		cupboardPath !== '' &&
		releaseSelectors.some((value) => provided(value) !== undefined)
	) {
		throw new CupboardReleaseSelectionConflictError('cupboard-path');
	}

	return {
		cupboardPath,
		version: normaliseVersion(provided(options.cupboardVersion) ?? 'latest'),
		includePrereleases: isEnabled(
			'include-prereleases',
			options.includePrereleases,
			true
		),
		githubToken: provided(options.githubToken) ?? '',
		releaseRepository:
			provided(options.releaseRepository) ??
			environment.GITHUB_ACTION_REPOSITORY ??
			environment.GITHUB_REPOSITORY ??
			fallbackReleaseRepository,
		expectedSourceCommit: provided(options.expectedSourceCommit) ?? '',
		installDirectory:
			provided(options.installDir) ??
			path.join(requireEnvironment(environment, 'RUNNER_TEMP'), 'cupboard-bin'),
		url,
		paths: options.paths,
		cache: providedCacheSelection(options.cache),
		store: provided(options.store) ?? '',
		audience: provided(options.audience) ?? '',
		root: isRetained
			? (explicitRoot ??
				`github:${requireEnvironment(environment, 'GITHUB_REPOSITORY')}/${requireEnvironment(environment, 'GITHUB_REF_NAME')}`)
			: '',
		ttl: explicitTtl ?? '',
		retain: isRetained,
		wait: shouldWait,
		waitTimeout: provided(options.waitTimeout) ?? '10m',
		attestations: options.attestations,
		requireGrace: requiresGrace,
		intermediatePathsFile: provided(options.intermediatePathsFile) ?? '',
		referencePathsFile: referencePathsFile ?? '',
		referenceSource: referenceSource ?? '',
		runRoot: runRoot ?? '',
		runRootTtl: runRootTtl ?? '',
		rootGroups
	};
}

function parseRootGroups(value: string | undefined): readonly RootGroup[] {
	const trimmed = provided(value);

	if (trimmed === undefined) {
		return [];
	}

	let parsedJson: unknown;

	try {
		parsedJson = JSON.parse(trimmed);
	} catch (error) {
		throw new RootGroupsJsonInvalidError(error);
	}

	const parsed = rootGroupsSchema.safeParse(parsedJson);

	if (!parsed.success) {
		throw new RootGroupsSchemaError(parsed.error);
	}

	return parsed.data;
}

export interface PushInvocation {
	readonly root: string;
	readonly paths: readonly string[];
}

export async function pushAction(
	options: PushOptions,
	environment: Environment = env,
	reporter: Reporter = createGithubReporter(),
	dependencies: PushActionDependencies = {}
): Promise<void> {
	dependencies.signal?.throwIfAborted();

	const inputs = resolvePushInputs(options, environment);
	const installedCupboard = await acquirePushCupboard(
		inputs,
		environment,
		reporter,
		defaultAcquirePushCupboardDependencies,
		dependencies.signal
	);
	dependencies.signal?.throwIfAborted();

	const nix = Nix.open();
	const pushes: readonly PushInvocation[] =
		inputs.rootGroups.length > 0
			? inputs.rootGroups.map((group) => ({
					root: group.root,
					paths: resolveStorePaths(nix, group.paths)
				}))
			: [{ root: inputs.root, paths: resolveStorePaths(nix, inputs.paths) }];

	await publishPushAcquisitionOutputs(environment, installedCupboard);

	const argumentsPerPush = pushArgumentsForInvocations(inputs, pushes);
	const summaries: PushSummary[] = [];

	for (const arguments_ of argumentsPerPush) {
		const run = await runPushCupboard({
			binaryPath: installedCupboard.binaryPath,
			arguments: arguments_,
			environment,
			requireGrace: inputs.requireGrace,
			version: installedCupboard.version,
			signal: dependencies.signal
		});

		summaries.push(requirePushSummary(run.results, run.protocol));
	}

	const summary = aggregatePushSummaries(summaries);

	await publishPushOutputs(environment, summary);

	if (inputs.requireGrace) {
		// A missing grace fact means that no policy covers the cache. Report this
		// at cache level because the remedy is a cache policy change.
		if (hasUngracedPath(summary)) {
			throw new GracePolicyMissingError(inputs.cache);
		}

		const missing = pathsMissingGraceDeadline(summary);

		if (missing.length > 0) {
			throw new GraceDeadlineMissingError(missing);
		}
	}
}

export interface PushCupboard {
	readonly binaryPath: string;
	readonly version: string;
}

export async function publishPushAcquisitionOutputs(
	environment: Environment,
	cupboard: PushCupboard
): Promise<void> {
	await setOutput(environment, 'cupboard-path', cupboard.binaryPath);
	await setOutput(environment, 'cupboard-version', cupboard.version);
}

interface AcquirePushCupboardDependencies {
	readonly install: typeof installCupboard;
	readonly inspectVersion: typeof inspectCupboardVersion;
}

const defaultAcquirePushCupboardDependencies: AcquirePushCupboardDependencies =
	{
		install: installCupboard,
		inspectVersion: inspectCupboardVersion
	};

export async function acquirePushCupboard(
	inputs: Pick<
		PushInputs,
		| 'cupboardPath'
		| 'installDirectory'
		| 'releaseRepository'
		| 'version'
		| 'includePrereleases'
		| 'githubToken'
		| 'expectedSourceCommit'
	>,
	environment: Environment,
	reporter: Reporter,
	dependencies: AcquirePushCupboardDependencies = defaultAcquirePushCupboardDependencies,
	signal?: AbortSignal
): Promise<PushCupboard> {
	if (inputs.cupboardPath !== '') {
		const binaryPath = path.resolve(inputs.cupboardPath);

		return {
			binaryPath,
			version: await dependencies.inspectVersion(binaryPath, signal)
		};
	}

	const installDirectory = path.resolve(inputs.installDirectory);

	await mkdir(installDirectory, { recursive: true });

	return dependencies.install(
		{
			installDirectory,
			releaseRepository: inputs.releaseRepository,
			version: inputs.version,
			includePrereleases: inputs.includePrereleases,
			githubToken: inputs.githubToken,
			environment,
			...(inputs.expectedSourceCommit !== '' && {
				expectedSourceCommit: inputs.expectedSourceCommit
			}),
			...(signal !== undefined && { signal })
		},
		reporter
	);
}

export async function inspectCupboardVersion(
	binaryPath: string,
	signal?: AbortSignal
): Promise<string> {
	signal?.throwIfAborted();

	const child = spawn(binaryPath, ['--version'], {
		stdio: ['ignore', 'pipe', 'inherit']
	});
	let stdout = '';

	child.stdout.setEncoding('utf8');
	child.stdout.on('data', (chunk: string) => {
		stdout += chunk;
	});

	const result = await waitForAbortableChildProcess(
		observeChildProcess(child),
		signal
	);

	if (result.error !== undefined) {
		throw new CommandFailedError(
			binaryPath,
			result.status,
			result.error.message,
			{ cause: result.error }
		);
	}

	if (result.status !== 0) {
		throw new CommandFailedError(binaryPath, result.status);
	}

	const version = stdout.trim();

	if (version === '') {
		throw new CupboardVersionOutputMissingError(binaryPath);
	}

	return version;
}

/**
 * A grouped action run is one publication even though it invokes
 * `cupboard push` once per root. Combine the summaries before publishing action
 * outputs and checking grace deadlines.
 */
export function aggregatePushSummaries(
	summaries: readonly PushSummary[]
): PushSummary {
	let uploadedPaths = 0;
	let reusedBlobs = 0;
	let skipped = 0;
	let uploadedBytes = 0;
	const failures: PushSummary['failures'][number][] = [];
	const paths: PushSummary['paths'][number][] = [];

	for (const summary of summaries) {
		uploadedPaths += summary.uploadedPaths;
		reusedBlobs += summary.reusedBlobs;
		skipped += summary.skipped;
		uploadedBytes += summary.uploadedBytes;
		failures.push(...summary.failures);
		paths.push(...summary.paths);
	}

	return {
		uploadedPaths,
		reusedBlobs,
		skipped,
		uploadedBytes,
		failures,
		paths
	};
}

export async function runPushCupboard(
	options: RunPushCupboardOptions,
	dependencies: RunPushCupboardDependencies = defaultRunPushCupboardDependencies
): Promise<CupboardRunResult> {
	const protocol = await dependencies.detectResultProtocol(
		options.binaryPath,
		options.signal
	);

	if (options.requireGrace) {
		requireGraceResultProtocol(protocol, options.version);
	}

	return dependencies.run(
		options.binaryPath,
		options.arguments,
		options.environment,
		protocol,
		options.signal === undefined ? {} : { signal: options.signal }
	);
}

export function requireGraceResultProtocol(
	protocol: CupboardResultProtocol,
	version: string
): void {
	if (protocol === 'legacy-stderr') {
		throw new LegacyPushSummaryError(version);
	}
}

/**
 * A path with neither `retainUntil` nor `graceSeconds` matched no cache grace
 * policy. {@link GracePolicyMissingError} reports this cache-level condition.
 */
export function hasUngracedPath(summary: PushSummary): boolean {
	return summary.paths.some(
		(path) =>
			path.grace?.retainUntil === undefined &&
			path.grace?.graceSeconds === undefined
	);
}

/**
 * Grace mode fails closed unless every reported path has a materialised
 * `retainUntil` value (see PLAN.md, "Planning and destination adoption"). An
 * empty grace fact means that no cache policy matched. A `graceSeconds` value
 * without `retainUntil` means that verification is still pending.
 */
export function pathsMissingGraceDeadline(
	summary: PushSummary
): readonly MissingGracePath[] {
	return summary.paths
		.filter(
			(path) =>
				path.grace?.retainUntil === undefined &&
				path.grace?.graceSeconds !== undefined
		)
		.map((path) => ({
			storePathHash: path.storePathHash,
			...(path.storePath !== undefined && { storePath: path.storePath }),
			reason: 'pending' as const
		}));
}

async function publishPushOutputs(
	environment: Environment,
	summary: PushSummary
): Promise<void> {
	await setOutput(environment, 'uploaded-paths', String(summary.uploadedPaths));
	await setOutput(environment, 'reused-blobs', String(summary.reusedBlobs));
	await setOutput(environment, 'skipped-paths', String(summary.skipped));
	await setOutput(environment, 'uploaded-bytes', String(summary.uploadedBytes));
}

// A successful push must record a summary that matches the protocol schema.
// Reject an incompatible summary instead of treating it as empty, and fail if
// the run records no summary.
export function requirePushSummary(
	results: readonly ReporterResultEvent[],
	protocol: CupboardResultProtocol = 'result-file'
): PushSummary {
	for (const event of results) {
		if (event.kind !== pushSummaryResultKind) {
			continue;
		}

		if (protocol === 'legacy-stderr') {
			const parsed = legacyPushSummarySchema.safeParse(event.data);

			if (!parsed.success) {
				throw new PushSummaryResponseError(parsed.error);
			}

			return { ...parsed.data, paths: [] };
		}

		const parsed = pushSummarySchema.safeParse(event.data);

		if (!parsed.success) {
			throw new PushSummaryResponseError(parsed.error);
		}

		return parsed.data;
	}

	throw new PushSummaryMissingError(results.map((event) => event.kind));
}

function resolveStorePaths(nix: Nix, paths: readonly string[]): string[] {
	return paths.map((storePath) => nix.toStorePath(storePath));
}

export function buildPushArguments(
	options: PushArgumentsOptions
): readonly string[] {
	const arguments_ = [
		'--no-colour',
		'push',
		canonicalHref(cacheUrlFor(options.url, options.cache)),
		...options.paths,
		'--github-oidc'
	];
	// Let the CLI derive the default audience from its canonical Worker URL so
	// canonicalisation and defaulting happen in one place.
	if (options.audience !== '') {
		arguments_.push('--audience', options.audience);
	}

	if (options.root !== '') {
		arguments_.push('--root', options.root);
	}

	if (options.store !== '') {
		arguments_.push('--store', options.store);
	}

	if (options.ttl !== '') {
		arguments_.push('--ttl', options.ttl);
	}

	if (!options.retain) {
		arguments_.push('--no-retain');
	}

	if (!options.wait) {
		arguments_.push('--no-wait');
	}

	if (options.waitTimeout !== '') {
		arguments_.push('--wait-timeout', options.waitTimeout);
	}

	for (const attestation of options.attestations) {
		arguments_.push('--attestation', attestation);
	}

	if (options.intermediatePathsFile !== '') {
		arguments_.push('--intermediate-paths-file', options.intermediatePathsFile);
	}

	if (options.referencePathsFile !== '') {
		arguments_.push('--reference-paths-file', options.referencePathsFile);
	}

	if (options.referenceSource !== '') {
		arguments_.push('--reference-source', options.referenceSource);
	}

	if (options.runRoot !== '') {
		arguments_.push('--run-root', options.runRoot);
	}

	if (options.runRootTtl !== '') {
		arguments_.push('--run-root-ttl', options.runRootTtl);
	}

	return arguments_;
}

/**
 * Keep root groups and paths in input order. Intermediate and reference paths
 * apply to the cohort rather than to one target root, so pass their files only
 * to the first invocation and avoid publishing them again for later roots.
 */
export function pushArgumentsForInvocations(
	inputs: Pick<
		PushInputs,
		| 'url'
		| 'audience'
		| 'cache'
		| 'store'
		| 'ttl'
		| 'retain'
		| 'wait'
		| 'waitTimeout'
		| 'attestations'
		| 'intermediatePathsFile'
		| 'referencePathsFile'
		| 'referenceSource'
		| 'runRoot'
		| 'runRootTtl'
	>,
	pushes: readonly PushInvocation[]
): readonly (readonly string[])[] {
	return pushes.map((push, index) =>
		buildPushArguments({
			url: inputs.url,
			paths: push.paths,
			audience: inputs.audience,
			root: push.root,
			cache: inputs.cache,
			store: inputs.store,
			ttl: inputs.ttl,
			retain: inputs.retain,
			wait: inputs.wait,
			waitTimeout: inputs.waitTimeout,
			attestations: inputs.attestations,
			intermediatePathsFile: index === 0 ? inputs.intermediatePathsFile : '',
			referencePathsFile: index === 0 ? inputs.referencePathsFile : '',
			referenceSource: index === 0 ? inputs.referenceSource : '',
			runRoot: inputs.runRoot,
			runRootTtl: inputs.runRootTtl
		})
	);
}
