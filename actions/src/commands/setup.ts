import { randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from 'node:process';

import { NixConfig, renderNetrc } from '@cupboard/nix-store/nix-config';
import { workflowCommands } from '@cupboard/shared/github-actions';
import { retryingFetcher } from '@cupboard/shared/retry';

import {
	CachePublicKeyEmptyResponseError,
	CachePublicKeyRequestFailedError,
	InvalidInputError
} from '../errors.ts';
import {
	appendEnvironmentFile,
	type Environment,
	input,
	isInputEnabled,
	requireInput,
	setOutput
} from '../inputs.ts';
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

export async function setupAction(
	environment: Environment = env
): Promise<void> {
	const inputs = setupInputs(environment);
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
	const runnerTemporaryDirectory = requireInput(
		inputs.environment.RUNNER_TEMP,
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

export function setupInputs(environment: Environment): SetupInputs {
	const readUser = input(environment, 'READ_USER');
	const readPassword = input(environment, 'READ_PASSWORD');

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

	const cacheUrl = input(environment, 'CACHE_URL');

	if (cacheUrl !== '' && !isHttpUrl(cacheUrl)) {
		throw new InvalidInputError(
			'cache-url',
			`cache-url must be an http(s) URL, got '${cacheUrl}'`
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
		addToPath: isInputEnabled(environment, 'ADD_TO_PATH', true),
		cacheUrl,
		cache: input(environment, 'CACHE'),
		trustedPublicKey: input(environment, 'TRUSTED_PUBLIC_KEY'),
		readUser,
		readPassword,
		nixConfigFile: input(environment, 'NIX_CONFIG_FILE')
	};
}
