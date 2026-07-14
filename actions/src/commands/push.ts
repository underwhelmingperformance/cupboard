import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { env } from 'node:process';

import { Nix } from '@cupboard/nix';
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

import {
	type CupboardResultProtocol,
	type CupboardRunResult,
	detectCupboardResultProtocol,
	runCupboardWithProtocol
} from '../cupboard-run.ts';
import {
	GraceDeadlineMissingError,
	InvalidInputError,
	LegacyPushSummaryError,
	type MissingGracePath,
	MissingInputError,
	PushSummaryMissingError,
	PushSummaryResponseError
} from '../errors.ts';
import { type Environment, requireEnvironment, setOutput } from '../inputs.ts';
import { collectLines, isEnabled, provided } from '../options.ts';
import {
	fallbackReleaseRepository,
	installCupboard,
	normaliseVersion
} from '../release-install.ts';

const legacyPushSummarySchema = pushSummarySchema.omit({ paths: true });

export interface PushOptions {
	readonly url?: string;
	readonly paths: readonly string[];
	readonly cupboardVersion?: string;
	readonly includePrereleases?: string;
	readonly githubToken?: string;
	readonly releaseRepository?: string;
	readonly expectedSourceCommit?: string;
	readonly installDir?: string;
	readonly cache?: string;
	readonly audience?: string;
	readonly root?: string;
	readonly ttl?: string;
	readonly retain?: string;
	readonly wait?: string;
	readonly requireGrace?: string;
	readonly waitTimeout?: string;
	readonly attestations: readonly string[];
}

export interface PushInputs {
	readonly version: string;
	readonly includePrereleases: boolean;
	readonly githubToken: string;
	readonly releaseRepository: string;
	readonly expectedSourceCommit: string;
	readonly installDirectory: string;
	readonly url: string;
	readonly paths: readonly string[];
	readonly cache: string;
	readonly audience: string;
	readonly root: string;
	readonly ttl: string;
	readonly retain: boolean;
	readonly wait: boolean;
	readonly waitTimeout: string;
	readonly attestations: readonly string[];
	readonly requireGrace: boolean;
}

interface RunPushCupboardOptions {
	readonly binaryPath: string;
	readonly arguments: readonly string[];
	readonly environment: Environment;
	readonly requireGrace: boolean;
	readonly version: string;
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
	readonly url: string;
	readonly paths: readonly string[];
	readonly audience: string;
	readonly root: string;
	readonly cache: string;
	readonly ttl: string;
	readonly retain: boolean;
	readonly wait: boolean;
	readonly waitTimeout: string;
	readonly attestations: readonly string[];
}

export function registerPushCommand(
	program: Command,
	environment: Environment = env
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
			'--cupboard-version <version>',
			'cupboard version to install: latest or an exact version such as 1.2.3'
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
		.action((options: PushOptions) => pushAction(options, environment));
}

export function resolvePushInputs(
	options: PushOptions,
	environment: Environment
): PushInputs {
	const url = provided(options.url);

	if (url === undefined) {
		throw new MissingInputError('url');
	}

	if (options.paths.length === 0) {
		throw new InvalidInputError(
			'paths',
			'paths is required and must contain at least one path'
		);
	}

	const isRetained = isEnabled('retain', options.retain, true);
	const explicitRoot = provided(options.root);

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

	return {
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
		cache: provided(options.cache) ?? '',
		audience: provided(options.audience) ?? url,
		root: isRetained
			? (explicitRoot ??
				`github:${requireEnvironment(environment, 'GITHUB_REPOSITORY')}/${requireEnvironment(environment, 'GITHUB_REF_NAME')}`)
			: '',
		ttl: explicitTtl ?? '',
		retain: isRetained,
		wait: shouldWait,
		waitTimeout: provided(options.waitTimeout) ?? '10m',
		attestations: options.attestations,
		requireGrace: requiresGrace
	};
}

export async function pushAction(
	options: PushOptions,
	environment: Environment = env,
	reporter: Reporter = createGithubReporter()
): Promise<void> {
	const inputs = resolvePushInputs(options, environment);
	const installDirectory = path.resolve(inputs.installDirectory);

	await mkdir(installDirectory, { recursive: true });

	const installedCupboard = await installCupboard(
		{
			installDirectory,
			releaseRepository: inputs.releaseRepository,
			version: inputs.version,
			includePrereleases: inputs.includePrereleases,
			githubToken: inputs.githubToken,
			environment,
			...(inputs.expectedSourceCommit !== '' && {
				expectedSourceCommit: inputs.expectedSourceCommit
			})
		},
		reporter
	);

	const paths = resolveStorePaths(Nix.open(), inputs.paths);
	const arguments_ = buildPushArguments({
		url: inputs.url,
		paths,
		audience: inputs.audience,
		root: inputs.root,
		cache: inputs.cache,
		ttl: inputs.ttl,
		retain: inputs.retain,
		wait: inputs.wait,
		waitTimeout: inputs.waitTimeout,
		attestations: inputs.attestations
	});

	await setOutput(environment, 'cupboard-path', installedCupboard.binaryPath);
	await setOutput(environment, 'cupboard-version', installedCupboard.version);

	const run = await runPushCupboard({
		binaryPath: installedCupboard.binaryPath,
		arguments: arguments_,
		environment,
		requireGrace: inputs.requireGrace,
		version: installedCupboard.version
	});
	const summary = requirePushSummary(run.results, run.protocol);

	await publishPushOutputs(environment, summary);

	if (inputs.requireGrace) {
		const missing = pathsMissingGraceDeadline(summary);

		if (missing.length > 0) {
			throw new GraceDeadlineMissingError(missing);
		}
	}
}

export async function runPushCupboard(
	options: RunPushCupboardOptions,
	dependencies: RunPushCupboardDependencies = defaultRunPushCupboardDependencies
): Promise<CupboardRunResult> {
	const protocol = await dependencies.detectResultProtocol(options.binaryPath);

	if (options.requireGrace) {
		requireGraceResultProtocol(protocol, options.version);
	}

	return dependencies.run(
		options.binaryPath,
		options.arguments,
		options.environment,
		protocol
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
		.filter((path) => path.grace?.retainUntil === undefined)
		.map((path) => ({
			storePathHash: path.storePathHash,
			...(path.storePath !== undefined && { storePath: path.storePath }),
			reason:
				path.grace?.graceSeconds === undefined ? 'no-policy-matched' : 'pending'
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
		options.url,
		...options.paths,
		'--github-oidc'
	];
	const audience = options[options.audience === '' ? 'url' : 'audience'];

	arguments_.push('--audience', audience);

	if (options.root !== '') {
		arguments_.push('--root', options.root);
	}

	if (options.cache !== '') {
		arguments_.push('--cache', options.cache);
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

	return arguments_;
}
