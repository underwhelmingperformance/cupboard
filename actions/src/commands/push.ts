import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { env } from 'node:process';

import { Nix } from '@cupboard/nix';
import { type StoredCache } from '@cupboard/nix-store/scalars';
import { canonicalHref } from '@cupboard/nix-store/url';
import {
	type ParsedPushSummary,
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
	CupboardVersionOutputMissingError,
	GraceDeadlineMissingError,
	GracePolicyMissingError,
	InvalidInputError,
	LegacyPushSummaryError,
	type MissingGracePath,
	MissingInputError,
	PushSummaryMissingError,
	PushSummaryResponseError
} from '../errors.ts';
import { type Environment, requireEnvironment, setOutput } from '../inputs.ts';
import {
	collectLines,
	isEnabled,
	provided,
	providedCache,
	providedUrl
} from '../options.ts';
import {
	fallbackReleaseRepository,
	installCupboard,
	normaliseVersion
} from '../release-install.ts';

const legacyPushSummarySchema = pushSummarySchema.omit({ paths: true });

/** One root group's own target paths, from a cohort declaring several roots. */
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
	readonly cache: StoredCache;
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
	readonly cache: StoredCache;
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
		.description(
			'Push Nix store paths to a cupboard cache from GitHub Actions.'
		)
		.requiredOption('--url <url>', 'cupboard Worker URL')
		.option(
			'--paths <path>',
			'local Nix store path, derivation or installable to push (repeatable, or newline-delimited)',
			collectLines,
			[]
		)
		.option(
			'--cupboard-path <path>',
			'pre-acquired cupboard executable; skips release installation'
		)
		.option(
			'--cupboard-version <version>',
			'cupboard version to install: latest or an exact published release tag'
		)
		.option(
			'--include-prereleases <value>',
			'when resolving latest, consider prereleases: true or false'
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
		.option('--cache <name>', 'named cache to push to')
		.option(
			'--store <uri>',
			'remote ssh-ng store the push reads metadata and NAR bytes from'
		)
		.option('--audience <audience>', 'GitHub OIDC audience (defaults to url)')
		.option('--root <root>', 'retention root for pushed paths')
		.option('--ttl <ttl>', 'retention TTL such as 7d or 12h')
		.option(
			'--retain <value>',
			'record retention for the pushed paths: true or false'
		)
		.option(
			'--require-grace <value>',
			'fail unless every pushed path reports a grace deadline: true or false'
		)
		.option(
			'--wait <value>',
			'wait for deferred blobs to become servable: true or false'
		)
		.option('--wait-timeout <timeout>', 'wait timeout for deferred blobs')
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
			'newline-delimited store paths the tenant already holds, published from the reference source with no local store read or NAR upload'
		)
		.option(
			'--reference-source <url>',
			'served cache endpoint the reference paths are read from (required with --reference-paths-file)'
		)
		.option(
			'--run-root <name>',
			'bind a run root: every pushed path also joins this root as it commits'
		)
		.option('--run-root-ttl <ttl>', 'expire the run root after this duration')
		.option(
			'--root-groups <json>',
			'JSON array of {root, paths} groups: one push per group, replacing the flat paths and root inputs'
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
	// A malformed URL would otherwise surface much later as a confusing OIDC
	// or fetch failure.
	const url = providedUrl('url', options.url);

	if (url === undefined) {
		throw new MissingInputError('url');
	}

	const rootGroups = parseRootGroups(options.rootGroups);

	if (rootGroups.length === 0 && options.paths.length === 0) {
		throw new InvalidInputError(
			'paths',
			'paths is required and must contain at least one path'
		);
	}

	if (rootGroups.length > 0 && options.paths.length > 0) {
		throw new InvalidInputError(
			'root-groups',
			'root-groups cannot be combined with paths'
		);
	}

	const isRetained = isEnabled('retain', options.retain, true);
	const explicitRoot = provided(options.root);

	if (explicitRoot !== undefined && rootGroups.length > 0) {
		throw new InvalidInputError(
			'root-groups',
			'root-groups cannot be combined with root: each group names its own root'
		);
	}

	if (!isRetained && rootGroups.length > 0) {
		throw new InvalidInputError(
			'root-groups',
			'root-groups cannot be combined with no-retain: a group publishes under its own root'
		);
	}

	// Unretained publication never conflicts with the action's own implicit
	// default root: it simply suppresses it, the same way the CLI's
	// `--no-retain` needs no `--root` to be given for it to take effect. It
	// does conflict with an EXPLICITLY named root or ttl, since those ask for
	// retention an unretained push then refuses to record.
	if (!isRetained && explicitRoot !== undefined) {
		throw new InvalidInputError(
			'root',
			'root cannot be combined with no-retain'
		);
	}

	const explicitTtl = provided(options.ttl);

	if (!isRetained && explicitTtl !== undefined) {
		throw new InvalidInputError('ttl', 'ttl cannot be combined with no-retain');
	}

	const shouldWait = isEnabled('wait', options.wait, true);
	const requiresGrace = isEnabled('require-grace', options.requireGrace, false);

	// A still-verifying path has no concrete deadline to check; the reusable
	// workflow always waits, so `require-grace` with an explicit `wait: false`
	// can never be satisfied.
	if (requiresGrace && !shouldWait) {
		throw new InvalidInputError(
			'require-grace',
			'require-grace cannot be combined with wait: false'
		);
	}

	const referencePathsFile = provided(options.referencePathsFile);
	const referenceSource = provided(options.referenceSource);

	if ((referencePathsFile === undefined) !== (referenceSource === undefined)) {
		throw new InvalidInputError(
			'reference-source',
			'reference-paths-file and reference-source must be supplied together'
		);
	}

	const runRoot = provided(options.runRoot);
	const runRootTtl = provided(options.runRootTtl);

	if (runRootTtl !== undefined && runRoot === undefined) {
		throw new InvalidInputError(
			'run-root-ttl',
			'run-root-ttl requires run-root'
		);
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
		throw new InvalidInputError(
			'cupboard-path',
			'cupboard-path cannot be combined with release selection inputs'
		);
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
		cache: providedCache(options.cache),
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

/**
 * A cohort's `{root, paths}[]` grouping, replacing the flat `paths`/`root`
 * inputs when a cohort declares more than one target root: the all-or-nothing
 * replacement rule applies per root, so each group is its own push.
 */
function parseRootGroups(value: string | undefined): readonly RootGroup[] {
	const trimmed = provided(value);

	if (trimmed === undefined) {
		return [];
	}

	let parsedJson: unknown;

	try {
		parsedJson = JSON.parse(trimmed);
	} catch (error) {
		throw new InvalidInputError(
			'root-groups',
			`root-groups is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
		);
	}

	const parsed = rootGroupsSchema.safeParse(parsedJson);

	if (!parsed.success) {
		throw new InvalidInputError(
			'root-groups',
			`root-groups does not match {root, paths}[]:\n${z.prettifyError(parsed.error)}`
		);
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
	const summaries: ParsedPushSummary[] = [];

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
		// A pushed path with no grace fact at all means no policy covers the
		// cache; resolution is cache-level, so the cache-level error names the
		// remedy.
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
 * Combines one summary per root-group push into the totals and combined path
 * list this action reports as its own outputs and require-grace checks
 * against: a grouped push is still one logical publication, whatever number
 * of `cupboard push` invocations it took to reach every root.
 */
export function aggregatePushSummaries(
	summaries: readonly ParsedPushSummary[]
): ParsedPushSummary {
	let uploadedPaths = 0;
	let reusedBlobs = 0;
	let skipped = 0;
	let uploadedBytes = 0;
	const failures: ParsedPushSummary['failures'][number][] = [];
	const paths: ParsedPushSummary['paths'][number][] = [];

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
 * Whether the push report carries any path with no grace fact at all: with
 * `require-grace` that means no policy covers the cache, the cache-level
 * condition {@link GracePolicyMissingError} models.
 */
export function hasUngracedPath(summary: ParsedPushSummary): boolean {
	return summary.paths.some(
		(path) =>
			path.grace?.retainUntil === undefined &&
			path.grace?.graceSeconds === undefined
	);
}

/**
 * The publication half of grace mode's fail-closed rule (see PLAN.md,
 * "Planning and destination adoption"): every path the push reports must
 * carry a materialised `retainUntil`. A path whose `grace` fact is empty
 * matched no cache policy; one that only carries `graceSeconds` is a deferred
 * upload still awaiting the verdict that would materialise its deadline.
 */
export function pathsMissingGraceDeadline(
	summary: ParsedPushSummary
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
	summary: ParsedPushSummary
): Promise<void> {
	await setOutput(environment, 'uploaded-paths', String(summary.uploadedPaths));
	await setOutput(environment, 'reused-blobs', String(summary.reusedBlobs));
	await setOutput(environment, 'skipped-paths', String(summary.skipped));
	await setOutput(environment, 'uploaded-bytes', String(summary.uploadedBytes));
}

// A successful push always records its summary, parsed against the protocol's
// own schema so a shape the two sides do not agree on (a mismatched cupboard
// version, say) fails loudly rather than reading as a vacuous pass. Its
// absence means the run did not report what it did, so there is nothing to
// publish and the action fails.
export function requirePushSummary(
	results: readonly ReporterResultEvent[],
	protocol: CupboardResultProtocol = 'result-file'
): ParsedPushSummary {
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
		canonicalHref(options.url),
		...options.paths,
		'--github-oidc'
	];
	// No default here: the CLI derives the audience from the canonical form of
	// the URL it parses, so one defaulting site serves the whole system.
	if (options.audience !== '') {
		arguments_.push('--audience', options.audience);
	}

	if (options.root !== '') {
		arguments_.push('--root', options.root);
	}

	if (options.cache !== '') {
		arguments_.push('--cache', options.cache);
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
 * The `cupboard push` argv for each of a run's invocations, one per root
 * group (or the single flat push when the run declares none). The
 * cohort-wide intermediate and reference paths are not scoped to any one
 * target root, so only the first invocation carries them; a later one would
 * otherwise republish the same paths.
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
