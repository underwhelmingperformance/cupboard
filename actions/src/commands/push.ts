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

import { runCupboard } from '../cupboard-run.ts';
import {
	InvalidInputError,
	MissingInputError,
	PushSummaryMissingError
} from '../errors.ts';
import { type Environment, requireEnvironment, setOutput } from '../inputs.ts';
import { collectLines, isEnabled, provided } from '../options.ts';
import {
	fallbackReleaseRepository,
	installCupboard,
	normaliseVersion
} from '../release-install.ts';

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
	readonly wait?: string;
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
	readonly wait: boolean;
	readonly waitTimeout: string;
	readonly attestations: readonly string[];
}

interface PushArgumentsOptions {
	readonly url: string;
	readonly paths: readonly string[];
	readonly audience: string;
	readonly root: string;
	readonly cache: string;
	readonly ttl: string;
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
		root:
			provided(options.root) ??
			`github:${requireEnvironment(environment, 'GITHUB_REPOSITORY')}/${requireEnvironment(environment, 'GITHUB_REF_NAME')}`,
		ttl: provided(options.ttl) ?? '',
		wait: isEnabled('wait', options.wait, true),
		waitTimeout: provided(options.waitTimeout) ?? '10m',
		attestations: options.attestations
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
		wait: inputs.wait,
		waitTimeout: inputs.waitTimeout,
		attestations: inputs.attestations
	});

	await setOutput(environment, 'cupboard-path', installedCupboard.binaryPath);
	await setOutput(environment, 'cupboard-version', installedCupboard.version);

	const results = await runCupboard(
		installedCupboard.binaryPath,
		arguments_,
		environment
	);

	await publishPushOutputs(environment, requirePushSummary(results));
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

// A successful push always records its summary. Its absence means the run did
// not report what it did, so there is nothing to publish and the action fails.
function requirePushSummary(
	results: readonly ReporterResultEvent[]
): ParsedPushSummary {
	for (const event of results) {
		if (event.kind === pushSummaryResultKind) {
			return pushSummarySchema.parse(event.data);
		}
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
