import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process, { env } from 'node:process';
import { fileURLToPath } from 'node:url';

import { withReadAuthentication } from '@cupboard/nix';
import { CacheInfo } from '@cupboard/nix-store/cache-info';
import { publicKeyUrl } from '@cupboard/nix-store/cache-url';
import { NixConfig, renderNetrc } from '@cupboard/nix-store/nix-config';
import { parsePublishedNixPublicKeys } from '@cupboard/nix-store/public-key';
import {
	cacheNameSchema,
	type CachePriority,
	type CacheScope,
	cacheScopeSchema,
	isSameCacheScope
} from '@cupboard/nix-store/scalars';
import { canonicalHref } from '@cupboard/nix-store/url';
import { cacheSummarySchema } from '@cupboard/protocol/caches';
import {
	isDestinationPreferred,
	reuseViewPrioritySchema
} from '@cupboard/protocol/reuse-views';
import { createGithubReporter, type Reporter } from '@cupboard/reporter';
import {
	observeChildProcess,
	waitForAbortableChildProcess
} from '@cupboard/shared/child-process';
import { discardResponseBody } from '@cupboard/shared/cleanup';
import { workflowCommands } from '@cupboard/shared/github-actions';
import {
	basicAuthHeader,
	type BasicCredential,
	type ReadUser,
	readUserInputSchema
} from '@cupboard/shared/http';
import { readResponseText } from '@cupboard/shared/response-body';
import { retryingFetcher } from '@cupboard/shared/retry';
import type { Command } from 'commander';
import { z } from 'zod';

import { fetchWithProbeDeadline } from '../cache-probe.ts';
import { acquireCupboard } from '../cupboard-acquisition.ts';
import {
	parseResolvedCupboard,
	type ResolvedCupboard,
	serialiseResolvedCupboard
} from '../cupboard-resolution.ts';
import { inspectCommandOptions, runCupboard } from '../cupboard-run.ts';
import {
	CacheAccessProbeError,
	CacheInfoFetchError,
	CacheInfoInvalidError,
	CachePublicKeyEmptyResponseError,
	CachePublicKeyRequestFailedError,
	CommandFailedError,
	CupboardReleaseSelectionConflictError,
	DestinationReadCredentialCacheCountError,
	DestinationReadCredentialConflictError,
	DestinationReadPasswordRequiredError,
	DestinationReadUserRequiredError,
	PrivateSubstitutersCacheUrlRequiredError,
	ProvisionCacheResultError,
	ProvisionCacheUrlRequiredError,
	ReadConfigurationFailedError,
	ReadConfigurationScopeError,
	ReadConfigurationUnavailableError,
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
	providedPrivateSubstituters,
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
	readonly includeDefaultCache?: string;
	readonly provisionCache?: string;
	readonly cacheAccessMode?: string;
	readonly provisionCacheAccess?: string;
	readonly provisionCacheTtl?: string;
	readonly cacheCredentials?: string;
	readonly privateSubstituters?: string;
	readonly destinationReadUser?: string;
	readonly destinationReadPassword?: string;
	readonly reuseView?: string;
	readonly trustedPublicKey?: string;
	readonly readUser?: string;
	readonly readPassword?: string;
	readonly nixConfigFile?: string;
	readonly checkoutDir?: string;
}

/**
 * Properties to use when setup creates a missing cache before configuring Nix.
 * An existing cache keeps its properties, but its access must match.
 */
export interface ProvisionCache {
	readonly name: string;
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
	readonly privateSubstituters: readonly URL[];
	readonly provisionCache: ProvisionCache | undefined;
	readonly cacheAccessMode: 'public' | 'private' | undefined;
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
	readonly configureWithReadAccess?: (
		binaryPath: string,
		inputs: ConfigureNixInputs,
		target: URL,
		reuseView: string,
		signal?: AbortSignal
	) => Promise<void>;
	readonly signal?: AbortSignal;
}

interface ConfigureNixInputs extends Pick<
	SetupInputs,
	| 'caches'
	| 'privateSubstituters'
	| 'reuseView'
	| 'trustedPublicKey'
	| 'readUser'
	| 'readPassword'
	| 'nixConfigFile'
> {
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
			'--private-substituters <urls>',
			'Authenticated HTTP(S) substituter URLs, one per line.'
		)
		.option(
			'--include-default-cache <boolean>',
			"Also configure the tenant's default cache, alongside any named caches."
		)
		.option(
			'--destination-read-user <user>',
			'Username accepted by the single selected destination cache.'
		)
		.option(
			'--destination-read-password <password>',
			'Password accepted by the single selected destination cache.'
		)
		.option(
			'--provision-cache <name>',
			"Create a missing cache with the run's OIDC token before configuring Nix."
		)
		.option('--cache-access-mode <mode>', 'Cache access: public or private.')
		.option(
			'--provision-cache-access <mode>',
			'Deprecated alias for --cache-access-mode.'
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

	program
		.command('setup-configure')
		.description('Configure Nix during an owned read session.')
		.requiredOption('--input-file <path>')
		.action((options: { readonly inputFile: string }) =>
			setupConfigureAction(options.inputFile, environment, undefined, {
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
	const readUser = providedReadUser(options.readUser ?? environment.READ_USER);
	const readPassword = options.readPassword ?? environment.READ_PASSWORD ?? '';
	const destinationReadUser = providedReadUser(
		options.destinationReadUser ?? environment.DESTINATION_READ_USER
	);
	const destinationReadPassword =
		options.destinationReadPassword ??
		environment.DESTINATION_READ_PASSWORD ??
		'';

	if (destinationReadUser !== '' && destinationReadPassword === '') {
		throw new DestinationReadPasswordRequiredError();
	}

	if (destinationReadPassword !== '' && destinationReadUser === '') {
		throw new DestinationReadUserRequiredError();
	}

	if (readUser !== '' && readPassword === '') {
		throw new ReadPasswordRequiredError();
	}

	if (readPassword !== '' && readUser === '') {
		throw new ReadUserRequiredError();
	}

	const cacheUrl = providedUrl('cache-url', options.cacheUrl);
	const privateSubstituters = providedPrivateSubstituters(
		options.privateSubstituters ?? environment.PRIVATE_SUBSTITUTERS
	);

	if (cacheUrl === undefined && privateSubstituters.length > 0) {
		throw new PrivateSubstitutersCacheUrlRequiredError();
	}

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
	const provisionCache = resolveProvisionCache(options, cacheUrl);

	return {
		cupboard,
		version: normaliseVersion(provided(options.cupboardVersion) ?? 'latest'),
		includePrereleases: isEnabled(
			'include-prereleases',
			options.includePrereleases,
			true
		),
		githubToken: provided(options.githubToken ?? environment.GH_TOKEN) ?? '',
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
		caches: resolveCaches(
			{
				...options,
				cacheCredentials:
					options.cacheCredentials ?? environment.CACHE_CREDENTIALS
			},
			destinationReadUser === ''
				? undefined
				: {
						user: destinationReadUser,
						password: destinationReadPassword
					}
		),
		privateSubstituters,
		provisionCache,
		cacheAccessMode: resolveCacheAccessMode(
			options,
			provisionCache !== undefined
		),
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

	return {
		name,
		rootTtl: provided(options.provisionCacheTtl) ?? ''
	};
}

function resolveCacheAccessMode(
	options: SetupOptions,
	isProvisioning: boolean
): 'public' | 'private' | undefined {
	const mode = provided(options.cacheAccessMode);
	const legacyMode = isProvisioning
		? provided(options.provisionCacheAccess)
		: undefined;
	if (mode !== undefined && legacyMode !== undefined && mode !== legacyMode) {
		throw new ProvisionCacheResultError(
			'cache-access-mode and provision-cache-access specify different access modes.'
		);
	}
	const access = mode ?? legacyMode;
	if (access !== undefined && access !== 'public' && access !== 'private') {
		throw new ProvisionCacheResultError(
			`Unknown cache access mode "${access}". Use public or private.`
		);
	}

	return access;
}

/**
 * Resolves the caches to configure and attaches cache-specific credentials.
 * If the cache input is empty, the run configures the default cache.
 */
function resolveCaches(
	options: SetupOptions,
	destinationCredential: BasicCredential | undefined
): readonly CacheSelection[] {
	const caches = providedCaches(options.cache);
	const hasDefaultCache = isEnabled(
		'include-default-cache',
		options.includeDefaultCache,
		false
	);

	if (
		destinationCredential !== undefined &&
		provided(options.cacheCredentials) !== undefined
	) {
		throw new DestinationReadCredentialConflictError();
	}

	const defaultCache: CacheScope = { kind: 'default' };
	const requested = caches.length === 0 ? [defaultCache] : caches;
	const selected = hasDefaultCache
		? [defaultCache, ...requested.filter((cache) => cache.kind !== 'default')]
		: requested;

	if (destinationCredential !== undefined && selected.length !== 1) {
		throw new DestinationReadCredentialCacheCountError(selected.length);
	}

	const credentials = providedCacheCredentials(
		options.cacheCredentials,
		selected
	);

	return selected.map((cache) => {
		const credential =
			destinationCredential ??
			credentials.find((entry) => isSameCacheScope(entry.cache, cache))
				?.credential;

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

	for (const substituter of inputs.privateSubstituters) {
		const password = decodeURIComponent(substituter.password);

		mask(password);

		if (substituter.password !== password) {
			mask(substituter.password);
		}

		mask(canonicalHref(substituter));
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
	const cacheUrl = inputs.cacheUrl;
	const viewAccess = await probeReuseViewAccess(
		cacheUrl,
		inputs.reuseView,
		dependencies
	);

	if (inputs.provisionCache !== undefined) {
		const targetAccess = await probeCacheAccess(
			cacheUrlFor(cacheUrl, {
				kind: 'named',
				name: cacheNameSchema.parse(inputs.provisionCache.name)
			}),
			dependencies,
			true
		);
		const requestedAccess =
			inputs.cacheAccessMode ??
			targetAccess ??
			(await probeCacheAccess(
				cacheUrlFor(cacheUrl, { kind: 'default' }),
				dependencies
			));
		if (viewAccess !== undefined && requestedAccess !== viewAccess) {
			throw new ProvisionCacheResultError(
				`Reuse view "${inputs.reuseView}" has ${viewAccess} access; ${requestedAccess} cache access is required. Choose matching access before rerunning this workflow.`
			);
		}
		if (
			targetAccess !== undefined &&
			inputs.cacheAccessMode !== undefined &&
			targetAccess !== inputs.cacheAccessMode
		) {
			throw new ProvisionCacheResultError(
				`Cache "${inputs.provisionCache.name}" has ${targetAccess} access; ${inputs.cacheAccessMode} access is required. Ask the cache administrator to change its access before rerunning this workflow.`
			);
		}
		const results = await (dependencies.run ?? runCupboard)(
			acquired.binaryPath,
			provisionCacheArguments(cacheUrl, inputs.provisionCache, requestedAccess),
			environment,
			{
				...(dependencies.signal !== undefined && {
					signal: dependencies.signal
				})
			}
		);
		const result = results.findLast((event) => event.kind === 'cache');
		const parsed = cacheSummarySchema.safeParse(result?.data);
		if (
			!parsed.success ||
			parsed.data.scope.kind !== 'named' ||
			parsed.data.scope.name !== inputs.provisionCache.name
		) {
			throw new ProvisionCacheResultError(
				'The cache creation command did not report the requested cache. Upgrade cupboard and retry.'
			);
		}
		if (
			(inputs.cacheAccessMode !== undefined &&
				parsed.data.access !== requestedAccess) ||
			(viewAccess !== undefined && parsed.data.access !== viewAccess)
		) {
			throw new ProvisionCacheResultError(
				`Cache "${inputs.provisionCache.name}" has ${parsed.data.access} access; ${viewAccess ?? requestedAccess} access is required. Ask the cache administrator to change its access before rerunning this workflow.`
			);
		}
	}

	const configureInputs = { ...inputs, cacheUrl, environment };
	const privateDestinations = await Promise.all(
		inputs.caches.map(async (selection) => {
			const destination = cacheUrlFor(cacheUrl, selection.cache);
			const access = await probeCacheAccess(destination, dependencies);
			if (
				inputs.cacheAccessMode !== undefined &&
				access !== inputs.cacheAccessMode
			) {
				throw new ProvisionCacheResultError(
					`Cache at ${canonicalHref(destination)} has ${access} access; ${inputs.cacheAccessMode} access is required.`
				);
			}
			if (viewAccess !== undefined && access !== viewAccess) {
				throw new ProvisionCacheResultError(
					`Cache at ${canonicalHref(destination)} has ${access} access; reuse view "${inputs.reuseView}" has ${viewAccess} access.`
				);
			}

			return access === 'private' &&
				inputs.readUser === '' &&
				selection.credential === undefined
				? destination
				: undefined;
		})
	);
	const oidcDestinations = privateDestinations.filter(
		(url) => url !== undefined
	);
	if (oidcDestinations.length > 1) {
		throw new ReadConfigurationScopeError();
	}
	const requiresOidcView = viewAccess === 'private' && inputs.readUser === '';
	const oidcDestination = oidcDestinations[0];
	if (requiresOidcView || oidcDestination !== undefined) {
		const target =
			oidcDestination ?? reuseViewUrlFor(cacheUrl, inputs.reuseView);
		const readSessionView =
			oidcDestination === undefined || !requiresOidcView
				? ''
				: inputs.reuseView;
		await setOutput(environment, 'read-session-target', canonicalHref(target));
		await setOutput(environment, 'read-session-view', readSessionView);
		await (dependencies.configureWithReadAccess ?? configureWithReadAccess)(
			acquired.binaryPath,
			configureInputs,
			target,
			readSessionView,
			dependencies.signal
		);
		return;
	}

	await setOutput(environment, 'read-session-target', '');
	await setOutput(environment, 'read-session-view', '');
	await configureNix(configureInputs, reporter, {
		...(dependencies.fetch !== undefined && { fetch: dependencies.fetch }),
		...(dependencies.signal !== undefined && { signal: dependencies.signal })
	});
}

const configureCredentialSchema = z.object({
	user: readUserInputSchema,
	password: z.string()
});
const configureCacheSelectionSchema = z.object({
	cache: cacheScopeSchema,
	credential: configureCredentialSchema.optional()
});
const configureNixPayloadSchema = z.object({
	cacheUrl: z.url(),
	caches: z.array(configureCacheSelectionSchema),
	privateSubstituters: z.array(z.url()),
	reuseView: z.string(),
	trustedPublicKey: z.string(),
	readUser: z.union([z.literal(''), readUserInputSchema]),
	readPassword: z.string(),
	nixConfigFile: z.string()
});

export async function setupConfigureAction(
	inputFile: string,
	environment: Environment = env,
	reporter: Reporter = createGithubReporter(),
	dependencies: CacheInfoFetchDependencies = {}
): Promise<void> {
	const contents = await readFile(inputFile, 'utf8');
	const payload: unknown = JSON.parse(contents);
	const parsed = configureNixPayloadSchema.parse(payload);

	const configureInputs = {
		...parsed,
		cacheUrl: new URL(parsed.cacheUrl),
		privateSubstituters: parsed.privateSubstituters.map((url) => new URL(url)),
		environment
	};
	await configureNix(configureInputs, reporter, dependencies);
}

async function configureWithReadAccess(
	binaryPath: string,
	inputs: ConfigureNixInputs,
	target: URL,
	reuseView: string,
	signal?: AbortSignal
): Promise<void> {
	let isSupported: boolean;
	try {
		const options = await inspectCommandOptions(binaryPath, ['run'], signal);
		isSupported = options.has('--github-oidc');
	} catch (error) {
		signal?.throwIfAborted();
		if (!(error instanceof CommandFailedError)) {
			throw error;
		}
		isSupported = false;
	}
	if (!isSupported) {
		throw new ReadConfigurationUnavailableError();
	}

	const inputFile = path.join(
		requireEnvironment(inputs.environment, 'RUNNER_TEMP'),
		`cupboard-setup-configure-${randomUUID()}.json`
	);
	await writeFile(
		inputFile,
		JSON.stringify({
			cacheUrl: canonicalHref(inputs.cacheUrl),
			caches: inputs.caches,
			privateSubstituters: inputs.privateSubstituters.map((url) =>
				canonicalHref(url)
			),
			reuseView: inputs.reuseView,
			trustedPublicKey: inputs.trustedPublicKey,
			readUser: inputs.readUser,
			readPassword: inputs.readPassword,
			nixConfigFile: inputs.nixConfigFile
		}),
		{ flag: 'wx', mode: 0o600 }
	);

	try {
		const child = spawn(
			binaryPath,
			[
				'run',
				canonicalHref(target),
				'--github-oidc',
				...(reuseView === '' ? [] : ['--reuse-view', reuseView]),
				'--',
				process.execPath,
				'--experimental-transform-types',
				'--disable-warning=ExperimentalWarning',
				fileURLToPath(new URL('../main.ts', import.meta.url)),
				'setup-configure',
				'--input-file',
				inputFile
			],
			{ stdio: 'inherit', env: process.env }
		);
		const result = await waitForAbortableChildProcess(
			observeChildProcess(child),
			signal
		);
		if (result.error !== undefined || result.status !== 0) {
			throw new ReadConfigurationFailedError(result.status);
		}
	} finally {
		await rm(inputFile, { force: true });
	}
}

async function probeReuseViewAccess(
	cacheUrl: URL,
	reuseView: string,
	dependencies: CacheInfoFetchDependencies
): Promise<'public' | 'private' | undefined> {
	if (reuseView === '') {
		return undefined;
	}

	return probeCacheAccess(reuseViewUrlFor(cacheUrl, reuseView), dependencies);
}

function probeCacheAccess(
	cacheUrl: URL,
	dependencies: CacheInfoFetchDependencies
): Promise<'public' | 'private'>;
function probeCacheAccess(
	cacheUrl: URL,
	dependencies: CacheInfoFetchDependencies,
	isAbsentAllowed: true
): Promise<'public' | 'private' | undefined>;
async function probeCacheAccess(
	cacheUrl: URL,
	dependencies: CacheInfoFetchDependencies,
	isAbsentAllowed = false
): Promise<'public' | 'private' | undefined> {
	const target = `${canonicalHref(cacheUrl)}/nix-cache-info`;

	return fetchWithProbeDeadline(
		retryingFetcher(dependencies.fetch ?? fetch, 'replay-safe'),
		target,
		{
			...(dependencies.signal !== undefined && {
				signal: dependencies.signal
			})
		},
		async (response) => {
			if (response.status === 200) {
				try {
					CacheInfo.parse(
						await readResponseText(response, {
							description: 'cache information',
							maximumBytes: maximumCacheInfoBytes,
							...(dependencies.signal !== undefined && {
								signal: dependencies.signal
							})
						})
					);
				} catch (error) {
					throw new CacheInfoInvalidError('destination', target, {
						cause: error
					});
				}

				return 'public';
			}

			await discardResponseBody(response);
			if (response.status === 401) {
				return 'private';
			}
			if (isAbsentAllowed && response.status === 404) {
				return;
			}

			throw new CacheAccessProbeError(target, response.status);
		}
	);
}

function provisionCacheArguments(
	cacheUrl: URL,
	provision: ProvisionCache,
	access: 'public' | 'private'
): readonly string[] {
	return [
		'cache',
		'create',
		canonicalHref(cacheUrl),
		provision.name,
		'--github-oidc',
		'--if-absent',
		'--access',
		access,
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
	const fetcher = retryingFetcher(
		withReadAuthentication(dependencies.fetch ?? fetch, {
			tenantUrl: options.cacheUrl
		}),
		'replay-safe'
	);
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
	const cupboardSubstituters = await resolveSubstituters(
		{
			cacheUrl: inputs.cacheUrl,
			caches: inputs.caches,
			reuseView: inputs.reuseView,
			readUser: inputs.readUser,
			readPassword: inputs.readPassword
		},
		dependencies
	);
	const substituters = [...cupboardSubstituters, ...inputs.privateSubstituters];
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
