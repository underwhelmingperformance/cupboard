import { randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from 'node:process';

import { NixConfig, renderNetrc } from '@cupboard/nix-store/nix-config';
import { workflowCommands } from '@cupboard/shared/github-actions';
import { retryingFetcher } from '@cupboard/shared/retry';
import type { Command } from 'commander';

import {
	CachePublicKeyEmptyResponseError,
	CachePublicKeyRequestFailedError,
	InvalidInputError
} from '../errors.ts';
import {
	appendEnvironmentFile,
	type Environment,
	requireEnvironment,
	setOutput
} from '../inputs.ts';
import { isEnabled, provided } from '../options.ts';
import {
	fallbackReleaseRepository,
	installCupboard,
	normaliseVersion
} from '../release-install.ts';
import {
	cachePublicKeyRequestHeaders,
	cachePublicKeyUrl,
	cacheUrlFor,
	isHttpUrl
} from '../substituters.ts';

const githubActions = workflowCommands();

export interface SetupOptions {
	readonly cupboardVersion?: string;
	readonly includePrereleases?: string;
	readonly githubToken?: string;
	readonly releaseRepository?: string;
	readonly installDir?: string;
	readonly addToPath?: string;
	readonly cacheUrl?: string;
	readonly cache?: string;
	readonly trustedPublicKey?: string;
	readonly readUser?: string;
	readonly readPassword?: string;
	readonly nixConfigFile?: string;
}

export interface SetupInputs {
	readonly version: string;
	readonly includePrereleases: boolean;
	readonly githubToken: string;
	readonly releaseRepository: string;
	readonly installDirectory: string;
	readonly addToPath: boolean;
	readonly cacheUrl: string;
	readonly cache: string;
	readonly trustedPublicKey: string;
	readonly readUser: string;
	readonly readPassword: string;
	readonly nixConfigFile: string;
}

interface ConfigureNixInputs extends SetupInputs {
	readonly environment: Environment;
}

interface WriteNetrcOptions {
	readonly cacheUrl: string;
	readonly readUser: string;
	readonly readPassword: string;
	readonly runnerTemporaryDirectory: string;
}

export function registerSetupCommand(
	program: Command,
	environment: Environment = env
): void {
	program
		.command('setup')
		.description(
			'Install cupboard and optionally export Nix binary cache configuration.'
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
			'--install-dir <directory>',
			'directory for the downloaded cupboard binary'
		)
		.option(
			'--add-to-path <value>',
			'add the install directory to PATH: true or false'
		)
		.option(
			'--cache-url <url>',
			'cupboard Worker URL to add to Nix substituters'
		)
		.option('--cache <name>', 'named cache to read from')
		.option(
			'--trusted-public-key <key>',
			'Nix trusted public key for the cupboard cache'
		)
		.option('--read-user <user>', 'username for private cache reads')
		.option('--read-password <password>', 'password for private cache reads')
		.option('--nix-config-file <path>', 'Nix config file to append to')
		.action((options: SetupOptions) => setupAction(options, environment));
}

export function resolveSetupInputs(
	options: SetupOptions,
	environment: Environment
): SetupInputs {
	const readUser = provided(options.readUser) ?? '';
	const readPassword = provided(options.readPassword) ?? '';

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

	const cacheUrl = provided(options.cacheUrl) ?? '';

	if (cacheUrl !== '' && !isHttpUrl(cacheUrl)) {
		throw new InvalidInputError(
			'cache-url',
			`cache-url must be an http(s) URL, got '${cacheUrl}'`
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
		installDirectory:
			provided(options.installDir) ??
			path.join(requireEnvironment(environment, 'RUNNER_TEMP'), 'cupboard-bin'),
		addToPath: isEnabled('add-to-path', options.addToPath, true),
		cacheUrl,
		cache: provided(options.cache) ?? '',
		trustedPublicKey: provided(options.trustedPublicKey) ?? '',
		readUser,
		readPassword,
		nixConfigFile: provided(options.nixConfigFile) ?? ''
	};
}

export async function setupAction(
	options: SetupOptions,
	environment: Environment = env
): Promise<void> {
	const inputs = resolveSetupInputs(options, environment);
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

	if (inputs.addToPath) {
		await appendEnvironmentFile(
			environment.GITHUB_PATH,
			`${installDirectory}\n`
		);
	}

	await setOutput(environment, 'cupboard-path', installedCupboard.binaryPath);
	await setOutput(environment, 'cupboard-version', installedCupboard.version);

	if (inputs.cacheUrl === '') {
		return;
	}

	await configureNix({ ...inputs, environment });
}

async function configureNix(inputs: ConfigureNixInputs): Promise<void> {
	const trustedPublicKey =
		inputs.trustedPublicKey === ''
			? await fetchTrustedPublicKey(inputs)
			: inputs.trustedPublicKey;
	const substituter = cacheUrlFor(inputs.cacheUrl, inputs.cache);
	const runnerTemporaryDirectory = requireEnvironment(
		inputs.environment,
		'RUNNER_TEMP'
	);
	const netrcFile =
		inputs.readPassword === ''
			? undefined
			: await writeNetrc({
					cacheUrl: inputs.cacheUrl,
					readUser: inputs.readUser,
					readPassword: inputs.readPassword,
					runnerTemporaryDirectory
				});
	const nixConfig = new NixConfig(
		substituter,
		trustedPublicKey,
		netrcFile === undefined ? {} : { netrcFile }
	).render();
	const generatedConfigFile = path.join(
		runnerTemporaryDirectory,
		'cupboard-nix.conf'
	);

	await writeFile(generatedConfigFile, nixConfig, { mode: 0o600 });
	await appendEnvironmentFile(
		inputs.environment.GITHUB_ENV,
		environmentFileBlock('NIX_CONFIG', nixConfig)
	);
	await setOutput(inputs.environment, 'nix-config-file', generatedConfigFile);

	if (inputs.nixConfigFile !== '') {
		await appendEnvironmentFile(inputs.nixConfigFile, nixConfig);
	}
}

function environmentFileBlock(name: string, value: string): string {
	let delimiter: string;

	do {
		delimiter = `${name}_${randomUUID().replaceAll('-', '_')}`;
	} while (value.includes(delimiter));

	return `${name}<<${delimiter}\n${value}${delimiter}\n`;
}

async function fetchTrustedPublicKey(
	inputs: ConfigureNixInputs
): Promise<string> {
	const url = cachePublicKeyUrl(inputs.cacheUrl);
	const response = await retryingFetcher(fetch)(url, {
		headers: cachePublicKeyRequestHeaders()
	});

	if (!response.ok) {
		throw new CachePublicKeyRequestFailedError(url, response.status);
	}

	const publicKey = await response.text();
	const trimmedPublicKey = publicKey.trim();

	if (trimmedPublicKey === '') {
		throw new CachePublicKeyEmptyResponseError(url);
	}

	githubActions.warning(
		'No trusted-public-key was supplied; trusting the cache signing key from /pubkey for this run.'
	);

	return trimmedPublicKey;
}

export async function writeNetrc(options: WriteNetrcOptions): Promise<string> {
	const netrcFile = path.join(
		options.runnerTemporaryDirectory,
		'cupboard-netrc'
	);

	await writeFile(
		netrcFile,
		renderNetrc(
			new URL(options.cacheUrl),
			options.readUser,
			options.readPassword
		),
		{ mode: 0o600 }
	);
	await chmod(netrcFile, 0o600);

	return netrcFile;
}
