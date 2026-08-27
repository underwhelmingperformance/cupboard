import { randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from 'node:process';

import { CacheInfo } from '@cupboard/nix-store/cache-info';
import { publicKeyUrl } from '@cupboard/nix-store/cache-url';
import { NixConfig, renderNetrc } from '@cupboard/nix-store/nix-config';
import { parsePublishedNixPublicKeys } from '@cupboard/nix-store/public-key';
import {
	type CachePriority,
	DEFAULT_CACHE,
	privateStoredCache
} from '@cupboard/nix-store/scalars';
import { canonicalHref } from '@cupboard/nix-store/url';
import {
	isDestinationPreferred,
	reuseViewPrioritySchema
} from '@cupboard/protocol/reuse-views';
import { createGithubReporter, type Reporter } from '@cupboard/reporter';
import { workflowCommands } from '@cupboard/shared/github-actions';
import {
	basicAuthHeader,
	type BasicCredential,
	type ReadUser
} from '@cupboard/shared/http';
import { readResponseText } from '@cupboard/shared/response-body';
import { retryingFetcher } from '@cupboard/shared/retry';
import type { Command } from 'commander';

import { fetchWithProbeDeadline } from '../cache-probe.ts';
import { acquireCupboard } from '../cupboard-acquisition.ts';
import {
	parseResolvedCupboard,
	type ResolvedCupboard,
	serialiseResolvedCupboard
} from '../cupboard-resolution.ts';
import {
	CacheInfoFetchError,
	CacheInfoInvalidError,
	CachePublicKeyEmptyResponseError,
	CachePublicKeyRequestFailedError,
	CupboardReleaseSelectionConflictError,
	PrivateCacheCredentialMissingError,
	ReadPasswordRequiredError,
	ReadUserRequiredError,
	ReuseViewPriorityError
} from '../errors.ts';
import {
	appendEnvironmentFile,
	type Environment,
	requireEnvironment,
	setOutput
} from '../inputs.ts';
import {
	isEnabled,
	provided,
	providedCaches,
	providedPrivateCacheCredentials,
	providedPrivateCacheNames,
	providedReadUser,
	providedUrl
} from '../options.ts';
import {
	fallbackReleaseRepository,
	installCupboard,
	normaliseVersion
} from '../release-install.ts';
import {
	cachePublicKeyRequestHeaders,
	type CacheSelection,
	cacheUrlFor,
	reuseViewUrlFor,
	substituterUrlFor
} from '../substituters.ts';

export interface SetupOptions {
	readonly cupboard?: string;
	readonly cupboardVersion?: string;
	readonly includePrereleases?: string;
	readonly githubToken?: string;
	readonly releaseRepository?: string;
	readonly expectedSourceCommit?: string;
	readonly installDir?: string;
	readonly addToPath?: string;
	readonly cacheUrl?: string;
	readonly cache?: string;
	readonly privateCache?: string;
	readonly privateCacheCredentials?: string;
	readonly reuseView?: string;
	readonly trustedPublicKey?: string;
	readonly readUser?: string;
	readonly readPassword?: string;
	readonly nixConfigFile?: string;
	readonly checkoutDir?: string;
}

export interface SetupInputs {
	readonly cupboard: ResolvedCupboard | undefined;
	readonly version: string;
	readonly includePrereleases: boolean;
	readonly githubToken: string;
	readonly releaseRepository: string;
	readonly expectedSourceCommit: string;
	readonly installDirectory: string;
	readonly addToPath: boolean;
	readonly cacheUrl: URL | undefined;
	readonly caches: readonly CacheSelection[];
	readonly reuseView: string;
	readonly trustedPublicKey: string;
	readonly readUser: ReadUser | '';
	readonly readPassword: string;
	readonly nixConfigFile: string;
	readonly checkoutDirectory: string;
}

export interface SetupActionDependencies {
	readonly acquire?: typeof acquireCupboard;
	readonly fetch?: typeof fetch;
	readonly installRelease?: typeof installCupboard;
	readonly mask?: (value: string) => void;
	readonly signal?: AbortSignal;
}

interface ConfigureNixInputs extends SetupInputs {
	readonly cacheUrl: URL;
	readonly environment: Environment;
}

interface WriteNetrcOptions {
	readonly cacheUrl: URL;
	readonly readUser: ReadUser;
	readonly readPassword: string;
	readonly runnerTemporaryDirectory: string;
}

type NixIncludeKind = 'required' | 'optional';

export function registerSetupCommand(
	program: Command,
	environment: Environment = env,
	signal?: AbortSignal
): void {
	program
		.command('setup')
		.description(
			'Acquire cupboard and optionally export Nix binary cache configuration.'
		)
		.option(
			'--cupboard <json>',
			'canonical acquisition JSON from resolve-cupboard'
		)
		.option('--cupboard-version <version>', 'release tag to install, or latest')
		.option(
			'--include-prereleases <value>',
			'when resolving latest, consider prereleases: true or false'
		)
		.option(
			'--github-token <token>',
			'GitHub token for release, asset and attestation requests'
		)
		.option(
			'--release-repository <repository>',
			'repository that publishes cupboard releases and provenance'
		)
		.option(
			'--expected-source-commit <commit>',
			'require the release provenance to identify this full commit id'
		)
		.option(
			'--install-dir <directory>',
			'directory for acquired cupboard files'
		)
		.option(
			'--add-to-path <value>',
			'add the directory containing the acquired binary to PATH: true or false'
		)
		.option(
			'--cache-url <url>',
			'cupboard tenant URL to add to Nix substituters'
		)
		.option(
			'--cache <name>',
			'Add public caches at the tenant URL, one per line or comma-separated. ' +
				'Can be combined with --private-cache.'
		)
		.option(
			'--private-cache <name>',
			'Add private caches at the tenant URL, one per line or comma-separated. ' +
				'Supply each credential through --private-cache-credentials or ' +
				'through --read-user and --read-password.'
		)
		.option(
			'--private-cache-credentials <json>',
			'Supply private cache credentials as a JSON object mapping each ' +
				"cache's local name to its user and password."
		)
		.option(
			'--reuse-view <name>',
			'named tenant reuse view to add as a second substituter'
		)
		.option(
			'--trusted-public-key <key>',
			'Nix signing key to trust for cache reads'
		)
		.option('--read-user <user>', 'username for private cache reads')
		.option('--read-password <password>', 'password for private cache reads')
		.option(
			'--nix-config-file <path>',
			'existing Nix config file to append generated settings to'
		)
		.option(
			'--checkout-dir <directory>',
			'source checkout to build for a source acquisition'
		)
		.action((options: SetupOptions) =>
			setupAction(options, environment, undefined, {
				...(signal !== undefined && { signal })
			})
		);
}

export function resolveSetupInputs(
	options: SetupOptions,
	environment: Environment
): SetupInputs {
	// Both credential halves are taken verbatim: surrounding whitespace is
	// part of a credential, so only its complete absence means "not set".
	const readUser = providedReadUser(options.readUser);
	const readPassword = options.readPassword ?? '';

	if (readUser !== '' && readPassword === '') {
		throw new ReadPasswordRequiredError();
	}

	if (readPassword !== '' && readUser === '') {
		throw new ReadUserRequiredError();
	}

	const cacheUrl = providedUrl('cache-url', options.cacheUrl);

	const cupboardValue = provided(options.cupboard);
	const cupboard =
		cupboardValue === undefined
			? undefined
			: parseResolvedCupboard(cupboardValue);
	const releaseSelectors = [
		options.cupboardVersion,
		options.includePrereleases,
		options.releaseRepository,
		options.expectedSourceCommit
	];

	if (
		cupboard !== undefined &&
		releaseSelectors.some((value) => provided(value) !== undefined)
	) {
		throw new CupboardReleaseSelectionConflictError('cupboard');
	}

	return {
		cupboard,
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
		caches: resolveCaches(options, readUser, readPassword),
		reuseView: provided(options.reuseView) ?? '',
		trustedPublicKey: provided(options.trustedPublicKey) ?? '',
		readUser,
		readPassword,
		nixConfigFile: provided(options.nixConfigFile) ?? '',
		checkoutDirectory:
			provided(options.checkoutDir) ??
			(cupboard?.kind === 'source'
				? path.resolve(
						requireEnvironment(environment, 'GITHUB_ACTION_PATH'),
						'../..'
					)
				: '')
	};
}

/**
 * Resolves the caches to configure. Public caches from `cache` come first,
 * followed by private caches from `private-cache`. If both inputs are empty,
 * the run configures the tenant's default cache.
 *
 * Every private cache requires a credential. Its entry in
 * `private-cache-credentials` takes precedence over the shared `read-user` and
 * `read-password`. The run fails if neither source provides a credential.
 */
function resolveCaches(
	options: SetupOptions,
	readUser: ReadUser | '',
	readPassword: string
): readonly CacheSelection[] {
	const publicCaches = providedCaches(options.cache);
	const privateNames = providedPrivateCacheNames(options.privateCache);

	if (publicCaches.length === 0 && privateNames.length === 0) {
		return [{ cache: DEFAULT_CACHE }];
	}

	const credentials = providedPrivateCacheCredentials(
		options.privateCacheCredentials,
		privateNames
	);
	const shared: BasicCredential | undefined =
		readUser === '' ? undefined : { user: readUser, password: readPassword };

	return [
		...publicCaches.map((cache) => ({ cache })),
		...privateNames.map((name) => {
			const credential = credentials.get(name) ?? shared;

			if (credential === undefined) {
				throw new PrivateCacheCredentialMissingError(name);
			}

			return { cache: privateStoredCache(name), credential };
		})
	];
}

/**
 * Registers every private-cache password and credential-bearing URL as a run
 * secret. The runner replaces each exact value with `***` in the log.
 *
 * Percent-encoding can change a password when the URL places it in userinfo, so
 * masking the raw password does not necessarily mask the complete URL. Register
 * both forms before setup writes any output.
 *
 * GitHub Actions applies a mask only to log output written after the command.
 */
function maskPrivateCacheCredentials(
	inputs: SetupInputs,
	mask: (value: string) => void
): void {
	for (const selection of inputs.caches) {
		if (selection.credential === undefined) {
			continue;
		}

		mask(selection.credential.password);

		if (inputs.cacheUrl !== undefined) {
			mask(canonicalHref(substituterUrlFor(inputs.cacheUrl, selection)));
		}
	}
}

export async function setupAction(
	options: SetupOptions,
	environment: Environment = env,
	reporter: Reporter = createGithubReporter(),
	dependencies: SetupActionDependencies = {}
): Promise<void> {
	dependencies.signal?.throwIfAborted();

	const inputs = resolveSetupInputs(options, environment);

	maskPrivateCacheCredentials(
		inputs,
		dependencies.mask ??
			((value) => {
				workflowCommands().addMask(value);
			})
	);

	const installDirectory = path.resolve(inputs.installDirectory);

	await mkdir(installDirectory, { recursive: true });

	const acquire = dependencies.acquire ?? acquireCupboard;
	const acquired =
		inputs.cupboard === undefined
			? await installReleasedCupboard(
					inputs,
					installDirectory,
					environment,
					reporter,
					dependencies.installRelease,
					dependencies.signal
				)
			: await acquire(
					{
						cupboard: inputs.cupboard,
						installDirectory,
						checkoutDirectory: inputs.checkoutDirectory,
						githubToken: inputs.githubToken,
						environment,
						...(dependencies.signal !== undefined && {
							signal: dependencies.signal
						})
					},
					reporter
				);

	if (inputs.addToPath) {
		await appendEnvironmentFile(
			environment.GITHUB_PATH,
			cupboardPathEntry(acquired.binaryPath)
		);
	}

	await setOutput(environment, 'cupboard-path', acquired.binaryPath);
	await setOutput(
		environment,
		'cupboard',
		serialiseResolvedCupboard(acquired.cupboard)
	);
	await setOutput(
		environment,
		'cupboard-version',
		acquired.cupboard.kind === 'release' ? acquired.cupboard.tag : ''
	);

	if (inputs.cacheUrl === undefined) {
		return;
	}

	await configureNix(
		{ ...inputs, cacheUrl: inputs.cacheUrl, environment },
		reporter,
		{
			...(dependencies.fetch !== undefined && { fetch: dependencies.fetch }),
			...(dependencies.signal !== undefined && { signal: dependencies.signal })
		}
	);
}

export function cupboardPathEntry(binaryPath: string): string {
	return `${path.dirname(binaryPath)}\n`;
}

async function installReleasedCupboard(
	inputs: SetupInputs,
	installDirectory: string,
	environment: Environment,
	reporter: Reporter,
	installRelease: typeof installCupboard = installCupboard,
	signal?: AbortSignal
): Promise<{
	readonly binaryPath: string;
	readonly cupboard: ResolvedCupboard;
}> {
	const installed = await installRelease(
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

	return {
		binaryPath: installed.binaryPath,
		cupboard: {
			kind: 'release',
			repository: inputs.releaseRepository,
			tag: installed.version,
			sourceCommit: installed.sourceCommit
		}
	};
}

interface CacheInfoFetchDependencies {
	readonly fetch?: typeof fetch;
	readonly signal?: AbortSignal;
}

const maximumCacheInfoBytes = 1024 * 1024;
const maximumPublishedKeyBytes = 64 * 1024;

async function fetchCacheInfoPriority(
	fetcher: typeof fetch,
	substituter: URL,
	side: 'destination' | 'view',
	headers: Readonly<Record<string, string>> | undefined,
	signal: AbortSignal | undefined
): Promise<CachePriority> {
	const url = canonicalHref(substituter);
	const target = `${url}/nix-cache-info`;
	// Each request, retries included, is bounded by the probe deadline, so a
	// stalled connection fails promptly instead of waiting out undici's much
	// longer default timeout.
	return fetchWithProbeDeadline(
		fetcher,
		target,
		{
			...(headers !== undefined && { headers }),
			...(signal !== undefined && { signal })
		},
		async (response) => {
			if (!response.ok) {
				throw new CacheInfoFetchError(side, url, response.status);
			}

			try {
				return CacheInfo.parse(
					await readResponseText(response, {
						description: `${side} cache information`,
						maximumBytes: maximumCacheInfoBytes,
						...(signal !== undefined && { signal })
					})
				).priority;
			} catch (error) {
				throw new CacheInfoInvalidError(side, url, { cause: error });
			}
		}
	);
}

export interface ResolveSubstitutersOptions {
	readonly cacheUrl: URL;
	readonly caches: readonly CacheSelection[];
	readonly reuseView: string;
	readonly readUser: ReadUser | '';
	readonly readPassword: string;
}

/**
 * When a reuse view is configured, fetches `nix-cache-info` for every configured
 * cache and for the view. Each cache must have a numerically lower priority than
 * the view. The returned list puts the caches before the view. This ordering
 * prevents a divergent input-addressed path in the view from replacing the path
 * selected from a destination cache.
 * The probes use Basic authentication because the runner's netrc applies only
 * to later Nix reads, and fetch ignores a credential in the URL.
 */
export async function resolveSubstituters(
	options: ResolveSubstitutersOptions,
	dependencies: CacheInfoFetchDependencies = {}
): Promise<readonly URL[]> {
	const substituters = options.caches.map((selection) =>
		substituterUrlFor(options.cacheUrl, selection)
	);

	if (options.reuseView === '') {
		return substituters;
	}

	const viewUrl = reuseViewUrlFor(options.cacheUrl, options.reuseView);
	const fetcher = retryingFetcher(dependencies.fetch ?? fetch, 'replay-safe');
	const tenantHeaders =
		options.readUser === ''
			? undefined
			: basicAuthHeader({
					user: options.readUser,
					password: options.readPassword
				});
	const [rawViewPriority, destinationPriorities] = await Promise.all([
		fetchCacheInfoPriority(
			fetcher,
			viewUrl,
			'view',
			tenantHeaders,
			dependencies.signal
		),
		Promise.all(
			options.caches.map((selection) =>
				fetchCacheInfoPriority(
					fetcher,
					cacheUrlFor(options.cacheUrl, selection.cache),
					'destination',
					selection.credential === undefined
						? tenantHeaders
						: basicAuthHeader(selection.credential),
					dependencies.signal
				)
			)
		)
	]);
	const viewPriority = reuseViewPrioritySchema.parse(rawViewPriority);

	for (const destinationPriority of destinationPriorities) {
		if (!isDestinationPreferred(destinationPriority, viewPriority)) {
			throw new ReuseViewPriorityError(destinationPriority, viewPriority);
		}
	}

	return [...substituters, viewUrl];
}

async function configureNix(
	inputs: ConfigureNixInputs,
	reporter: Reporter,
	dependencies: CacheInfoFetchDependencies = {}
): Promise<void> {
	dependencies.signal?.throwIfAborted();

	const trustedPublicKey =
		inputs.trustedPublicKey === ''
			? await fetchTrustedPublicKey(inputs, reporter, dependencies)
			: inputs.trustedPublicKey;
	// A reuse view and its destination use the same host. If the tenant requires
	// authentication, one host-scoped netrc entry supplies both reads.
	const substituters = await resolveSubstituters(
		{
			cacheUrl: inputs.cacheUrl,
			caches: inputs.caches,
			reuseView: inputs.reuseView,
			readUser: inputs.readUser,
			readPassword: inputs.readPassword
		},
		dependencies
	);
	dependencies.signal?.throwIfAborted();
	const runnerTemporaryDirectory = requireEnvironment(
		inputs.environment,
		'RUNNER_TEMP'
	);
	const netrcFile =
		inputs.readUser === ''
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
	const generatedConfigFile = path.resolve(
		runnerTemporaryDirectory,
		`cupboard-nix-${randomUUID()}.conf`
	);
	const requiredInclude = renderNixInclude(generatedConfigFile, 'required');

	dependencies.signal?.throwIfAborted();
	await writeFile(generatedConfigFile, nixConfig, { flag: 'wx', mode: 0o600 });
	dependencies.signal?.throwIfAborted();
	await appendEnvironmentFile(
		inputs.environment.GITHUB_ENV,
		environmentFileBlock('NIX_CONFIG', requiredInclude)
	);
	dependencies.signal?.throwIfAborted();
	await setOutput(inputs.environment, 'nix-config-file', generatedConfigFile);

	if (inputs.nixConfigFile === '') {
		return;
	}

	dependencies.signal?.throwIfAborted();
	await appendEnvironmentFile(
		inputs.nixConfigFile,
		renderNixInclude(generatedConfigFile, 'optional')
	);
}

function renderNixInclude(filePath: string, kind: NixIncludeKind): string {
	const directive = kind === 'required' ? 'include' : '!include';

	return `${directive} ${filePath}\n`;
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
	reporter: Reporter,
	dependencies: CacheInfoFetchDependencies
): Promise<string> {
	const trimmedPublicKey = await fetchCachePublicKeyAt(
		publicKeyUrl(inputs.cacheUrl),
		dependencies.fetch ?? fetch,
		dependencies.signal
	);

	reporter.warn(
		"No trusted-public-key was supplied. This run will trust the key returned by the cache's /pubkey endpoint."
	);

	return trimmedPublicKey;
}

export async function fetchCachePublicKeyAt(
	endpoint: URL,
	fetcher: typeof fetch = fetch,
	signal?: AbortSignal
): Promise<string> {
	const url = canonicalHref(endpoint);

	return fetchWithProbeDeadline(
		retryingFetcher(fetcher, 'replay-safe'),
		url,
		{
			headers: cachePublicKeyRequestHeaders(),
			...(signal !== undefined && { signal })
		},
		async (response) => {
			if (!response.ok) {
				throw new CachePublicKeyRequestFailedError(url, response.status);
			}

			const responseBody = await readResponseText(response, {
				description: 'cache public key',
				maximumBytes: maximumPublishedKeyBytes,
				...(signal !== undefined && { signal })
			});
			const publicKey = responseBody.trim();

			if (publicKey === '') {
				throw new CachePublicKeyEmptyResponseError(url);
			}

			return parsePublishedNixPublicKeys(publicKey)
				.map((key) => key.value)
				.join('\n');
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
		renderNetrc(options.cacheUrl, options.readUser, options.readPassword),
		{ mode: 0o600 }
	);
	await chmod(netrcFile, 0o600);

	return netrcFile;
}
