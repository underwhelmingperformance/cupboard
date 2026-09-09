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
	type CacheScope,
	isSameCacheScope
} from '@cupboard/nix-store/scalars';
import { canonicalHref } from '@cupboard/nix-store/url';
import {
	isDestinationPreferred,
	reuseViewPrioritySchema
} from '@cupboard/protocol/reuse-views';
import { createGithubReporter, type Reporter } from '@cupboard/reporter';
import { workflowCommands } from '@cupboard/shared/github-actions';
import { basicAuthHeader, type ReadUser } from '@cupboard/shared/http';
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
import { runCupboard } from '../cupboard-run.ts';
import {
	CacheInfoFetchError,
	CacheInfoInvalidError,
	CachePublicKeyEmptyResponseError,
	CachePublicKeyRequestFailedError,
	CupboardReleaseSelectionConflictError,
	ProvisionCacheAccessRequiredError,
	ProvisionCacheUrlRequiredError,
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
	providedCacheCredentials,
	providedCaches,
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
	readonly provisionCache?: string;
	readonly provisionCacheAccess?: string;
	readonly provisionCacheTtl?: string;
	readonly cacheCredentials?: string;
	readonly reuseView?: string;
	readonly trustedPublicKey?: string;
	readonly readUser?: string;
	readonly readPassword?: string;
	readonly nixConfigFile?: string;
	readonly checkoutDir?: string;
}

/**
 * The cache a run creates before it publishes. A pull-request cache does not
 * exist before the pull request's first run, and the run holds only its own
 * token, so it creates the cache itself. The access and TTL come from the
 * workflow, not from a server default: a workflow that names no access is
 * refused, and the TTL is what expires an abandoned pull request's contents.
 */
export interface ProvisionCache {
	readonly name: string;
	readonly access: string;
	readonly rootTtl: string;
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
	readonly provisionCache: ProvisionCache | undefined;
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
	readonly run?: typeof runCupboard;
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
			'Add named caches at the tenant URL, one per line or comma-separated.'
		)
		.option(
			'--cache-credentials <json>',
			'Supply cache-specific credentials as a JSON array of cache scopes and credentials.'
		)
		.option(
			'--provision-cache <name>',
			"Create this cache with the run's own OIDC token before anything reads it."
		)
		.option(
			'--provision-cache-access <mode>',
			'Read access for the created cache: public or private.'
		)
		.option(
			'--provision-cache-ttl <duration>',
			'Default root TTL for the created cache, e.g. 14d.'
		)
		.option(
			'--reuse-view <name>',
			'named tenant reuse view to add as a second substituter'
		)
		.option(
			'--trusted-public-key <key>',
			'Nix signing key to trust for cache reads'
		)
		.option('--read-user <user>', 'username for cache reads')
		.option('--read-password <password>', 'password for cache reads')
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
		caches: resolveCaches(options),
		provisionCache: resolveProvisionCache(options, cacheUrl),
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
 * Reads the cache the run should create, if any. `provision-cache` names it,
 * and the remaining inputs supply its access and default root TTL.
 */
function resolveProvisionCache(
	options: SetupOptions,
	cacheUrl: URL | undefined
): ProvisionCache | undefined {
	const name = provided(options.provisionCache);

	if (name === undefined) {
		return undefined;
	}

	if (cacheUrl === undefined) {
		throw new ProvisionCacheUrlRequiredError();
	}

	const access = provided(options.provisionCacheAccess);

	if (access === undefined) {
		throw new ProvisionCacheAccessRequiredError();
	}

	return {
		name,
		access,
		rootTtl: provided(options.provisionCacheTtl) ?? ''
	};
}

/**
 * Resolves the caches to configure and attaches cache-specific credentials.
 * If the cache input is empty, the run configures the default cache.
 */
function resolveCaches(options: SetupOptions): readonly CacheSelection[] {
	const caches = providedCaches(options.cache);
	const defaultCache: CacheScope = { kind: 'default' };
	const selected = caches.length === 0 ? [defaultCache] : caches;

	const credentials = providedCacheCredentials(
		options.cacheCredentials,
		selected
	);

	return selected.map((cache) => {
		const credential = credentials.find((entry) =>
			isSameCacheScope(entry.cache, cache)
		)?.credential;

		return {
			cache,
			...(credential !== undefined && { credential })
		};
	});
}

/**
 * Registers every cache-specific password and credential-bearing URL as a run
 * secret. The runner replaces each exact value with `***` in the log.
 *
 * Percent-encoding can change a password when the URL places it in userinfo, so
 * masking the raw password does not necessarily mask the complete URL. Register
 * both forms before setup writes any output.
 *
 * GitHub Actions applies a mask only to log output written after the command.
 */
function maskCacheCredentials(
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

	maskCacheCredentials(
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

	// Create the cache before anything reads it. A pull request's first run has
	// no cache to publish to, and every later step, from the substituter probe
	// to upload negotiation, expects one to exist.
	if (inputs.provisionCache !== undefined) {
		await (dependencies.run ?? runCupboard)(
			acquired.binaryPath,
			provisionCacheArguments(inputs.cacheUrl, inputs.provisionCache),
			environment,
			{
				...(dependencies.signal !== undefined && {
					signal: dependencies.signal
				})
			}
		);
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

/**
 * The `cupboard cache create` argv a run uses to create its own cache. The run
 * authenticates with its GitHub Actions token, so the trust rule's binding
 * decides which cache it may create.
 */
function provisionCacheArguments(
	cacheUrl: URL,
	provision: ProvisionCache
): readonly string[] {
	return [
		'cache',
		'create',
		canonicalHref(cacheUrl),
		provision.name,
		'--github-oidc',
		// Every push after the first finds the cache the first run created.
		'--if-absent',
		'--access',
		provision.access,
		...(provision.rootTtl === '' ? [] : ['--root-ttl', provision.rootTtl])
	];
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
