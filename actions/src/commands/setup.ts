import { randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from 'node:process';

import {
	CacheInfo,
	isDestinationPreferred
} from '@cupboard/nix-store/cache-info';
import { publicKeyUrl } from '@cupboard/nix-store/cache-url';
import { NixConfig, renderNetrc } from '@cupboard/nix-store/nix-config';
import { createGithubReporter, type Reporter } from '@cupboard/reporter';
import { basicAuthHeader } from '@cupboard/shared/http';
import { retryingFetcher } from '@cupboard/shared/retry';
import type { Command } from 'commander';

import { fetchWithProbeDeadline } from '../cache-probe.ts';
import {
	CacheInfoFetchError,
	CacheInfoInvalidError,
	CachePublicKeyEmptyResponseError,
	CachePublicKeyRequestFailedError,
	InvalidInputError,
	ReuseViewPriorityError
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
	cacheUrlFor,
	isHttpUrl,
	reuseViewUrlFor
} from '../substituters.ts';

export interface SetupOptions {
	readonly cupboardVersion?: string;
	readonly includePrereleases?: string;
	readonly githubToken?: string;
	readonly releaseRepository?: string;
	readonly expectedSourceCommit?: string;
	readonly installDir?: string;
	readonly addToPath?: string;
	readonly cacheUrl?: string;
	readonly cache?: string;
	readonly reuseView?: string;
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
	readonly expectedSourceCommit: string;
	readonly installDirectory: string;
	readonly addToPath: boolean;
	readonly cacheUrl: string;
	readonly cache: string;
	readonly reuseView: string;
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
			'--expected-source-commit <commit>',
			'require the release to have been built from this full commit id'
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
			'--reuse-view <name>',
			'named tenant reuse view to add as a second substituter'
		)
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
	// Both credential halves are taken verbatim: surrounding whitespace is
	// part of a credential, so only its complete absence means "not set".
	const readUser = options.readUser ?? '';
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

	const cacheUrl = provided(options.cacheUrl) ?? '';

	if (cacheUrl !== '' && !isHttpUrl(cacheUrl)) {
		throw new InvalidInputError(
			'cache-url',
			'cache-url must be an http(s) URL with nothing beyond origin and path'
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
		addToPath: isEnabled('add-to-path', options.addToPath, true),
		cacheUrl,
		cache: provided(options.cache) ?? '',
		reuseView: provided(options.reuseView) ?? '',
		trustedPublicKey: provided(options.trustedPublicKey) ?? '',
		readUser,
		readPassword,
		nixConfigFile: provided(options.nixConfigFile) ?? ''
	};
}

export async function setupAction(
	options: SetupOptions,
	environment: Environment = env,
	reporter: Reporter = createGithubReporter()
): Promise<void> {
	const inputs = resolveSetupInputs(options, environment);
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

	await configureNix({ ...inputs, environment }, reporter);
}

interface CacheInfoFetchDependencies {
	readonly fetch?: typeof fetch;
}

async function fetchCacheInfoPriority(
	fetcher: typeof fetch,
	url: string,
	side: 'destination' | 'view',
	headers: Readonly<Record<string, string>> | undefined
): Promise<number> {
	const target = `${url.replace(/\/+$/u, '')}/nix-cache-info`;
	// Bounded per request, retries included: a stalled connection must fail
	// promptly, not sit on undici's defaults.
	return fetchWithProbeDeadline(
		fetcher,
		target,
		{ ...(headers !== undefined && { headers }) },
		async (response) => {
			if (!response.ok) {
				throw new CacheInfoFetchError(side, url, response.status);
			}

			try {
				return CacheInfo.parse(await response.text()).priority;
			} catch (error) {
				throw new CacheInfoInvalidError(side, url, { cause: error });
			}
		}
	);
}

export interface ResolveSubstitutersOptions {
	readonly cacheUrl: string;
	readonly cache: string;
	readonly reuseView: string;
	readonly readUser: string;
	readonly readPassword: string;
}

/**
 * The ordered substituter list for generated Nix config: the destination
 * cache first, then, when a reuse view is configured, the view URL once its
 * `nix-cache-info` priority has been checked against the destination's.
 * Destination-before-view is an invariant (see PLAN.md, "Named tenant reuse
 * views"): a divergent input-addressed path already adopted by the
 * destination must never be replaced by a view candidate. Both fetches carry
 * the Basic read credential when one is configured; the runner's netrc only
 * covers Nix's own reads, not this check's.
 */
export async function resolveSubstituters(
	options: ResolveSubstitutersOptions,
	dependencies: CacheInfoFetchDependencies = {}
): Promise<readonly string[]> {
	const destinationUrl = cacheUrlFor(options.cacheUrl, options.cache);

	if (options.reuseView === '') {
		return [destinationUrl];
	}

	const viewUrl = reuseViewUrlFor(options.cacheUrl, options.reuseView);
	const fetcher = retryingFetcher(dependencies.fetch ?? fetch);
	const headers =
		options.readPassword === ''
			? undefined
			: basicAuthHeader(options.readUser, options.readPassword);
	const [destinationPriority, viewPriority] = await Promise.all([
		fetchCacheInfoPriority(fetcher, destinationUrl, 'destination', headers),
		fetchCacheInfoPriority(fetcher, viewUrl, 'view', headers)
	]);

	if (!isDestinationPreferred(destinationPriority, viewPriority)) {
		throw new ReuseViewPriorityError(destinationPriority, viewPriority);
	}

	return [destinationUrl, viewUrl];
}

async function configureNix(
	inputs: ConfigureNixInputs,
	reporter: Reporter
): Promise<void> {
	const trustedPublicKey =
		inputs.trustedPublicKey === ''
			? await fetchTrustedPublicKey(inputs, reporter)
			: inputs.trustedPublicKey;
	// A private tenant's reuse view lives under the same host as its
	// destination cache, so the netrc entry built below already covers it:
	// netrc is host-scoped, not path-scoped.
	const substituters = await resolveSubstituters({
		cacheUrl: inputs.cacheUrl,
		cache: inputs.cache,
		reuseView: inputs.reuseView,
		readUser: inputs.readUser,
		readPassword: inputs.readPassword
	});
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
		substituters,
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
	inputs: ConfigureNixInputs,
	reporter: Reporter
): Promise<string> {
	const url = publicKeyUrl(inputs.cacheUrl);
	const trimmedPublicKey = await fetchCachePublicKeyAt(url);

	reporter.warn(
		'No trusted-public-key was supplied; trusting the cache signing key from /pubkey for this run.'
	);

	return trimmedPublicKey;
}

/** Fetch and validate the signing key returned by a cache's public-key endpoint. */
export async function fetchCachePublicKeyAt(
	url: string,
	fetcher: typeof fetch = fetch
): Promise<string> {
	return fetchWithProbeDeadline(
		retryingFetcher(fetcher),
		url,
		{ headers: cachePublicKeyRequestHeaders() },
		async (response) => {
			if (!response.ok) {
				throw new CachePublicKeyRequestFailedError(url, response.status);
			}

			const responseBody = await response.text();
			const publicKey = responseBody.trim();

			if (publicKey === '') {
				throw new CachePublicKeyEmptyResponseError(url);
			}

			return publicKey;
		}
	);
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
