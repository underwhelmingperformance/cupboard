import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { env } from 'node:process';

import { Nix } from '@cupboard/nix';

import { runCupboard } from '../cupboard-run.ts';
import { InvalidInputError, MissingInputError } from '../errors.ts';
import {
	type Environment,
	input,
	isInputEnabled,
	parseLines,
	requireInput,
	setOutput
} from '../inputs.ts';
import {
	fallbackReleaseRepository,
	installCupboard,
	normaliseVersion
} from '../release-install.ts';

export interface PushInputs {
	readonly version: string;
	readonly includePrereleases: boolean;
	readonly githubToken: string;
	readonly releaseRepository: string;
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

export async function pushAction(
	environment: Environment = env
): Promise<void> {
	const inputs = pushInputs(environment);
	const installDirectory = path.resolve(inputs.installDirectory);

	await mkdir(installDirectory, { recursive: true });

	const installedCupboard = await installCupboard({
		installDirectory,
		releaseRepository: inputs.releaseRepository,
		version: inputs.version,
		includePrereleases: inputs.includePrereleases,
		githubToken: inputs.githubToken,
		environment
	});

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
	await runCupboard(installedCupboard.binaryPath, arguments_);
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

export function pushInputs(environment: Environment): PushInputs {
	const url = input(environment, 'URL');

	if (url === '') {
		throw new MissingInputError('url');
	}

	const paths = parseLines(input(environment, 'PATHS'));

	if (paths.length === 0) {
		throw new InvalidInputError(
			'paths',
			'paths is required and must contain at least one path'
		);
	}

	return {
		version: normaliseVersion(input(environment, 'CUPBOARD_VERSION', 'latest')),
		includePrereleases: isInputEnabled(
			environment,
			'INCLUDE_PRERELEASES',
			true
		),
		githubToken: input(environment, 'GITHUB_TOKEN'),
		releaseRepository: input(
			environment,
			'RELEASE_REPOSITORY',
			environment.GITHUB_ACTION_REPOSITORY ??
				environment.GITHUB_REPOSITORY ??
				fallbackReleaseRepository
		),
		installDirectory: input(environment, 'INSTALL_DIR', () =>
			path.join(
				requireInput(environment.RUNNER_TEMP, 'RUNNER_TEMP'),
				'cupboard-bin'
			)
		),
		url,
		paths,
		cache: input(environment, 'CACHE'),
		audience: input(environment, 'AUDIENCE', url),
		root: input(
			environment,
			'ROOT',
			() =>
				`github:${requireInput(environment.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY')}/${requireInput(environment.GITHUB_REF_NAME, 'GITHUB_REF_NAME')}`
		),
		ttl: input(environment, 'TTL'),
		wait: isInputEnabled(environment, 'WAIT', true),
		waitTimeout: input(environment, 'WAIT_TIMEOUT', '10m'),
		attestations: parseLines(input(environment, 'ATTESTATIONS'))
	};
}
