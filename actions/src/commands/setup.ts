import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process, { env } from 'node:process';
import { fileURLToPath } from 'node:url';

import { withReadAuthentication } from '@cupboard/nix';
import { CacheInfo } from '@cupboard/nix-store/cache-info';
import {
	parseTenantCacheUrl,
	publicKeyUrl
} from '@cupboard/nix-store/cache-url';
import { InvalidTenantCacheUrlError } from '@cupboard/nix-store/errors';
import { NixConfig, renderNetrc } from '@cupboard/nix-store/nix-config';
import { parsePublishedNixPublicKeys } from '@cupboard/nix-store/public-key';
import {
	cacheAccessModeSchema,
	cacheNameSchema,
	type CachePriority,
	type CacheScope,
	cacheScopeSchema,
	isSameCacheScope
} from '@cupboard/nix-store/scalars';
import { canonicalHref } from '@cupboard/nix-store/url';
import {
	type CacheSummary,
	cacheSummarySchema
} from '@cupboard/protocol/caches';
import {
	readAccessFileEnvironment,
	readAccessSnapshotSchema,
	type ReadResource,
	readResourcesSchema,
	type ReadResourceState
} from '@cupboard/protocol/read-access';
import {
	isDestinationPreferred,
	reuseViewNameSchema,
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
import { StatusCodes } from 'http-status-codes';
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
	ReadConfigurationUnavailableError,
	ReadPasswordRequiredError,
	ReadUserRequiredError,
	ReuseViewPriorityError,
	StaticReadCredentialRejectedError
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
	readonly audience?: string;
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
	readonly audience: string;
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
	| 'audience'
	| 'trustedPublicKey'
	| 'readUser'
	| 'readPassword'
	| 'nixConfigFile'
	| 'cacheAccessMode'
	| 'provisionCache'
> {
	readonly cacheUrl: URL;
	readonly environment: Environment;
	readonly binaryPath: string;
	readonly inheritedNixConfig: string;
	readonly cacheMetadata?: boolean;
	readonly readFacts?: readonly ReadResourceState[];
	readonly readResources?: readonly ReadResource[];
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
		.option('--audience <audience>', 'audience of the GitHub OIDC token')
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
		audience: provided(options.audience) ?? '',
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

	await setOutput(environment, 'read-session-audience', inputs.audience);

	if (inputs.cacheUrl === undefined) {
		return;
	}
	const cacheUrl = inputs.cacheUrl;
	parseTenantCacheUrl(cacheUrl);
	const staticCredential: BasicCredential | undefined =
		inputs.readUser === ''
			? undefined
			: { user: inputs.readUser, password: inputs.readPassword };
	const metadataDestinations = await Promise.all(
		inputs.caches.map(async (selection) => {
			const credential = selection.credential ?? staticCredential;

			if (credential === undefined) {
				return;
			}

			const state = await probeCacheAccessState(
				cacheUrlFor(cacheUrl, selection.cache),
				dependencies,
				credential
			);

			if (state !== 'absent') {
				return;
			}

			const defaults = await probeCacheAccessState(
				cacheUrlFor(cacheUrl, { kind: 'default' }),
				dependencies,
				staticCredential
			);

			return defaults === 'challenge' ? selection : undefined;
		})
	);
	const metadataDestination = metadataDestinations.find(
		(selection) => selection !== undefined
	);
	const configureInputs = {
		...inputs,
		cacheUrl,
		environment,
		binaryPath: acquired.binaryPath,
		inheritedNixConfig: environment.NIX_CONFIG ?? '',
		cacheMetadata: metadataDestination !== undefined
	};
	const readDestinations = inputs.caches.filter(
		(selection) =>
			selection.credential === undefined && staticCredential === undefined
	);
	const isOidcView = inputs.reuseView !== '' && staticCredential === undefined;
	const destinationStates = await Promise.all(
		readDestinations.map(async (selection) => ({
			selection,
			state: await probeCacheAccessState(
				cacheUrlFor(cacheUrl, selection.cache),
				dependencies
			)
		}))
	);
	const oidcDestinations = destinationStates.flatMap(({ selection, state }) =>
		state === 'challenge' || state === 'absent' ? [selection] : []
	);
	const viewState = isOidcView
		? await probeCacheAccessState(
				reuseViewUrlFor(cacheUrl, inputs.reuseView),
				dependencies
			)
		: undefined;
	const isNeedsSession =
		oidcDestinations.length > 0 || viewState === 'challenge';

	if (metadataDestination !== undefined || isNeedsSession) {
		const destination =
			metadataDestination ?? oidcDestinations[0] ?? readDestinations[0];
		const sessionDestinations =
			destination === undefined
				? []
				: [
						destination,
						...inputs.caches.filter(
							(selection) =>
								!isSameCacheScope(selection.cache, destination.cache) &&
								(readDestinations.includes(selection) ||
									metadataDestinations.includes(selection))
						)
					];
		const readResources: ReadResource[] = readResourcesSchema.parse([
			...sessionDestinations.map((selection) => ({
				type: 'cupboard_cache' as const,
				cache: selection.cache,
				mode: metadataDestinations.some(
					(metadata) =>
						metadata !== undefined &&
						isSameCacheScope(metadata.cache, selection.cache)
				)
					? 'metadata'
					: 'content'
			})),
			...(isOidcView
				? [
						{
							type: 'cupboard_view' as const,
							view: reuseViewNameSchema.parse(inputs.reuseView)
						}
					]
				: [])
		]);
		const target =
			destination === undefined
				? reuseViewUrlFor(cacheUrl, inputs.reuseView)
				: cacheUrlFor(cacheUrl, destination.cache);
		const readSessionView =
			destination === undefined || !isOidcView ? '' : inputs.reuseView;

		const contentDestinations = readResources.flatMap((resource) =>
			resource.type === 'cupboard_cache' && resource.mode === 'content'
				? [resource]
				: []
		);
		const downstreamDestination = contentDestinations[0];
		const downstreamTarget =
			downstreamDestination === undefined
				? isOidcView
					? reuseViewUrlFor(cacheUrl, inputs.reuseView)
					: undefined
				: cacheUrlFor(cacheUrl, downstreamDestination.cache);
		await setOutput(
			environment,
			'read-session-target',
			downstreamTarget === undefined ? '' : canonicalHref(downstreamTarget)
		);
		await setOutput(
			environment,
			'read-session-view',
			downstreamDestination === undefined || !isOidcView ? '' : inputs.reuseView
		);
		await setOutput(
			environment,
			'read-session-caches',
			JSON.stringify(
				contentDestinations
					.slice(1)
					.map((selection) =>
						canonicalHref(cacheUrlFor(cacheUrl, selection.cache))
					)
			)
		);
		await (dependencies.configureWithReadAccess ?? configureWithReadAccess)(
			acquired.binaryPath,
			{
				...configureInputs,
				readResources,
				cacheMetadata:
					readResources[0]?.type === 'cupboard_cache' &&
					readResources[0].mode === 'metadata'
			},
			target,
			readSessionView,
			dependencies.signal
		);

		return;
	}

	await setOutput(environment, 'read-session-target', '');
	await setOutput(environment, 'read-session-view', '');
	await setOutput(environment, 'read-session-caches', '[]');
	await performSetupConfiguration(configureInputs, reporter, dependencies);
}

async function performSetupConfiguration(
	inputs: ConfigureNixInputs,
	reporter: Reporter,
	dependencies: SetupActionDependencies
): Promise<void> {
	const { cacheUrl, environment } = inputs;
	const staticCredential =
		inputs.readUser === ''
			? undefined
			: { user: inputs.readUser, password: inputs.readPassword };
	const factsFile = environment[readAccessFileEnvironment];
	const facts =
		factsFile === undefined
			? []
			: readAccessSnapshotSchema.parse(
					JSON.parse(await readFile(factsFile, 'utf8'))
				).read_resources;

	if (inputs.readResources !== undefined) {
		const expected = new Set(
			readResourcesSchema
				.parse(inputs.readResources)
				.map((resource) => JSON.stringify(resource))
		);
		const actual = readResourcesSchema.parse(
			facts.map(({ state: _state, ...resource }) => resource)
		);

		if (
			actual.length !== expected.size ||
			actual.some((resource) => !expected.has(JSON.stringify(resource)))
		) {
			throw new ProvisionCacheResultError(
				'The read session does not describe exactly the configured resources.'
			);
		}
	}
	const acquired = { binaryPath: inputs.binaryPath };
	if (
		facts.some((fact) =>
			fact.type === 'cupboard_cache'
				? inputs.caches.every(
						(selection) => !isSameCacheScope(selection.cache, fact.cache)
					)
				: fact.view !== inputs.reuseView
		)
	) {
		throw new ProvisionCacheResultError(
			'The read session describes resources outside this setup operation.'
		);
	}

	let provisioned: CacheSummary | undefined;

	const factForCache = (cache: CacheScope): ReadResourceState | undefined =>
		facts.find(
			(fact) =>
				fact.type === 'cupboard_cache' && isSameCacheScope(fact.cache, cache)
		);
	const accessFor = async (
		cache: CacheScope,
		credential: BasicCredential | undefined
	): Promise<'public' | 'private' | undefined> => {
		if (
			provisioned !== undefined &&
			isSameCacheScope(provisioned.scope, cache)
		) {
			return provisioned.access;
		}

		const fact = factForCache(cache);

		if (fact !== undefined) {
			return fact.state.kind === 'existing' ? fact.state.access : undefined;
		}

		return probeCacheAccess(
			cacheUrlFor(cacheUrl, cache),
			dependencies,
			true,
			credential
		);
	};

	const viewFact = facts.find(
		(fact) => fact.type === 'cupboard_view' && fact.view === inputs.reuseView
	);

	if (viewFact?.state.kind === 'absent') {
		throw new CacheAccessProbeError(
			canonicalHref(reuseViewUrlFor(cacheUrl, inputs.reuseView)),
			StatusCodes.NOT_FOUND
		);
	}

	const viewAccess =
		viewFact?.state.kind === 'existing'
			? viewFact.state.access
			: await probeReuseViewAccess(
					cacheUrl,
					inputs.reuseView,
					dependencies,
					staticCredential
				);

	await resolveSubstituters({ ...inputs, readFacts: facts }, dependencies);

	if (inputs.provisionCache !== undefined) {
		const provisionScope: CacheScope = {
			kind: 'named',
			name: cacheNameSchema.parse(inputs.provisionCache.name)
		};
		const targetCredential =
			inputs.caches.find((selection) =>
				isSameCacheScope(selection.cache, provisionScope)
			)?.credential ?? staticCredential;
		const targetAccess = await accessFor(provisionScope, targetCredential);
		const pendingFact = factForCache(provisionScope);
		const firstWriteAccess =
			pendingFact?.type === 'cupboard_cache' &&
			pendingFact.state.kind === 'absent'
				? pendingFact.state.firstWrite?.access
				: undefined;
		const requestedAccess =
			inputs.cacheAccessMode ??
			targetAccess ??
			firstWriteAccess ??
			(await probeCacheAccess(
				cacheUrlFor(cacheUrl, { kind: 'default' }),
				dependencies,
				false,
				staticCredential
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
			provisionCacheArguments(
				cacheUrl,
				inputs.provisionCache,
				requestedAccess,
				inputs.audience
			),
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

		provisioned = parsed.data;

		if (parsed.data.access === 'private') {
			await fetchCacheInfoPriority(
				withReadAuthentication(dependencies.fetch ?? fetch, {
					tenantUrl: cacheUrl
				}),
				cacheUrlFor(cacheUrl, provisionScope),
				'destination',
				targetCredential === undefined
					? undefined
					: basicAuthHeader(targetCredential),
				dependencies.signal
			);
		}
	}

	await Promise.all(
		inputs.caches.map(async (selection) => {
			const destination = cacheUrlFor(cacheUrl, selection.cache);
			const credential = selection.credential ?? staticCredential;
			const observed = await accessFor(selection.cache, credential);
			const fact = factForCache(selection.cache);
			const firstWriteAccess =
				fact?.type === 'cupboard_cache' && fact.state.kind === 'absent'
					? fact.state.firstWrite?.access
					: undefined;
			const pendingAccess =
				observed ??
				firstWriteAccess ??
				(await probeCacheAccess(
					cacheUrlFor(cacheUrl, { kind: 'default' }),
					dependencies,
					false,
					staticCredential
				));

			if (
				inputs.cacheAccessMode !== undefined &&
				pendingAccess !== inputs.cacheAccessMode
			) {
				throw new ProvisionCacheResultError(
					`Cache at ${canonicalHref(destination)} has ${pendingAccess} access; ${inputs.cacheAccessMode} access is required.`
				);
			}
			if (viewAccess !== undefined && pendingAccess !== viewAccess) {
				throw new ProvisionCacheResultError(
					`Cache at ${canonicalHref(destination)} has ${pendingAccess} access; reuse view "${inputs.reuseView}" has ${viewAccess} access.`
				);
			}
		})
	);

	await configureNix({ ...inputs, readFacts: facts }, reporter, {
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
	nixConfigFile: z.string(),
	cacheAccessMode: cacheAccessModeSchema.optional(),
	provisionCache: z
		.object({ name: z.string(), rootTtl: z.string() })
		.optional(),
	binaryPath: z.string(),
	inheritedNixConfig: z.string().default(''),
	audience: z.string().default(''),
	readResources: readResourcesSchema.optional()
});

export async function setupConfigureAction(
	inputFile: string,
	environment: Environment = env,
	reporter: Reporter = createGithubReporter(),
	dependencies: SetupActionDependencies = {}
): Promise<void> {
	const contents = await readFile(inputFile, 'utf8');
	const payload: unknown = JSON.parse(contents);
	const parsed = configureNixPayloadSchema.parse(payload);

	const configureInputs = {
		...parsed,
		cacheAccessMode: parsed.cacheAccessMode,
		provisionCache: parsed.provisionCache,
		cacheUrl: new URL(parsed.cacheUrl),
		privateSubstituters: parsed.privateSubstituters.map((url) => new URL(url)),
		environment
	};
	await performSetupConfiguration(configureInputs, reporter, dependencies);
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
		const additionalCaches = (inputs.readResources ?? []).flatMap((resource) =>
			resource.type === 'cupboard_cache' &&
			canonicalHref(cacheUrlFor(inputs.cacheUrl, resource.cache)) !==
				canonicalHref(target)
				? [resource]
				: []
		);
		isSupported =
			options.has('--github-oidc') &&
			options.has('--cache-metadata') &&
			additionalCaches.every((resource) =>
				options.has(
					resource.mode === 'metadata'
						? '--read-cache-metadata'
						: '--read-cache'
				)
			);
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
			nixConfigFile: inputs.nixConfigFile,
			cacheAccessMode: inputs.cacheAccessMode,
			provisionCache: inputs.provisionCache,
			binaryPath: inputs.binaryPath,
			inheritedNixConfig: inputs.inheritedNixConfig,
			audience: inputs.audience,
			readResources: inputs.readResources
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
				...(inputs.audience === '' ? [] : ['--audience', inputs.audience]),
				...(inputs.readResources ?? []).flatMap((resource) =>
					resource.type === 'cupboard_cache' &&
					canonicalHref(cacheUrlFor(inputs.cacheUrl, resource.cache)) !==
						canonicalHref(target)
						? [
								resource.mode === 'metadata'
									? '--read-cache-metadata'
									: '--read-cache',
								canonicalHref(cacheUrlFor(inputs.cacheUrl, resource.cache))
							]
						: []
				),
				...(inputs.cacheMetadata === true ? ['--cache-metadata'] : []),
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
	dependencies: CacheInfoFetchDependencies,
	credential?: BasicCredential
): Promise<'public' | 'private' | undefined> {
	if (reuseView === '') {
		return undefined;
	}

	return probeCacheAccess(
		reuseViewUrlFor(cacheUrl, reuseView),
		dependencies,
		false,
		credential
	);
}

function probeCacheAccess(
	cacheUrl: URL,
	dependencies: CacheInfoFetchDependencies,
	isAbsentAllowed?: false,
	credential?: BasicCredential
): Promise<'public' | 'private'>;
function probeCacheAccess(
	cacheUrl: URL,
	dependencies: CacheInfoFetchDependencies,
	isAbsentAllowed: true,
	credential?: BasicCredential
): Promise<'public' | 'private' | undefined>;
async function probeCacheAccess(
	cacheUrl: URL,
	dependencies: CacheInfoFetchDependencies,
	isAbsentAllowed = false,
	credential?: BasicCredential
): Promise<'public' | 'private' | undefined> {
	const access = await probeCacheAccessState(
		cacheUrl,
		dependencies,
		credential
	);
	if (access === 'challenge') {
		throw new CacheAccessProbeError(
			`${canonicalHref(cacheUrl)}/nix-cache-info`,
			StatusCodes.UNAUTHORIZED
		);
	}

	const isPending = access === 'absent';
	if (!isPending) {
		return access;
	}
	if (isAbsentAllowed) {
		return undefined;
	}
	const tenantUrl = parsedNamedCacheTenant(cacheUrl);
	if (tenantUrl === undefined) {
		throw new CacheAccessProbeError(
			`${canonicalHref(cacheUrl)}/nix-cache-info`,
			StatusCodes.NOT_FOUND
		);
	}
	const inheritedAccess = await probeCacheAccessState(
		tenantUrl,
		dependencies,
		credential
	);
	if (inheritedAccess === 'absent') {
		throw new CacheAccessProbeError(
			`${canonicalHref(tenantUrl)}/nix-cache-info`,
			StatusCodes.NOT_FOUND
		);
	}
	if (inheritedAccess === 'challenge') {
		throw new CacheAccessProbeError(
			`${canonicalHref(tenantUrl)}/nix-cache-info`,
			StatusCodes.UNAUTHORIZED
		);
	}

	return inheritedAccess;
}

async function probeCacheAccessState(
	cacheUrl: URL,
	dependencies: CacheInfoFetchDependencies,
	credential?: BasicCredential
): Promise<'public' | 'private' | 'absent' | 'challenge'> {
	const target = `${canonicalHref(cacheUrl)}/nix-cache-info`;
	const unauthorised = await fetchCacheAccessState(
		target,
		cacheUrl,
		dependencies
	);
	if (unauthorised !== 'challenge') {
		return unauthorised;
	}

	const authenticated = await fetchCacheAccessState(
		target,
		cacheUrl,
		dependencies,
		credential,
		true
	);

	if (authenticated === 'challenge' && credential !== undefined) {
		throw new StaticReadCredentialRejectedError(cacheUrl);
	}

	return authenticated;
}

async function fetchCacheAccessState(
	target: string,
	cacheUrl: URL,
	dependencies: CacheInfoFetchDependencies,
	credential?: BasicCredential,
	isAuthenticated = false
): Promise<'public' | 'private' | 'absent' | 'challenge'> {
	const plain = retryingFetcher(dependencies.fetch ?? fetch, 'replay-safe');
	const fetcher =
		credential === undefined && isAuthenticated
			? withReadAuthentication(plain, {
					tenantUrl: parsedNamedCacheTenant(cacheUrl) ?? cacheUrl
				})
			: plain;

	return fetchWithProbeDeadline<'public' | 'private' | 'absent' | 'challenge'>(
		fetcher,
		target,
		{
			...(credential !== undefined && { headers: basicAuthHeader(credential) }),
			...(dependencies.signal !== undefined && {
				signal: dependencies.signal
			})
		},
		async (response) => {
			const status: StatusCodes = response.status;

			if (status === StatusCodes.OK) {
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

				return isAuthenticated ? 'private' : 'public';
			}

			await discardResponseBody(response);
			if (status === StatusCodes.UNAUTHORIZED) {
				return 'challenge';
			}
			if (status === StatusCodes.NOT_FOUND) {
				return 'absent';
			}

			throw new CacheAccessProbeError(target, status);
		}
	);
}

function parsedNamedCacheTenant(url: URL): URL | undefined {
	try {
		const target = parseTenantCacheUrl(url);
		return target.cache.kind === 'named' ? target.tenantUrl : undefined;
	} catch (error) {
		if (error instanceof InvalidTenantCacheUrlError) {
			return undefined;
		}
		throw error;
	}
}

function provisionCacheArguments(
	cacheUrl: URL,
	provision: ProvisionCache,
	access: 'public' | 'private',
	audience: string
): readonly string[] {
	return [
		'cache',
		'create',
		canonicalHref(cacheUrl),
		provision.name,
		'--github-oidc',
		...(audience === '' ? [] : ['--audience', audience]),
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
			const status: StatusCodes = response.status;

			if (
				side === 'destination' &&
				status === StatusCodes.NOT_FOUND &&
				parsedNamedCacheTenant(substituter) !== undefined
			) {
				await discardResponseBody(response);
				return CacheInfo.default.priority;
			}
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
	readonly readFacts?: readonly ReadResourceState[];
}

/**
 * When a reuse view is configured, checks the priority of every configured
 * cache and the view. An absent named cache uses the default first-write
 * priority. Each cache must have a numerically lower priority than the view.
 * The returned list puts the caches before the view. This ordering
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
			tenantUrl: parsedNamedCacheTenant(options.cacheUrl) ?? options.cacheUrl
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
	const viewFact = options.readFacts?.find(
		(fact) => fact.type === 'cupboard_view' && fact.view === options.reuseView
	);

	if (viewFact?.state.kind === 'absent') {
		throw new CacheAccessProbeError(viewUrl.href, StatusCodes.NOT_FOUND);
	}

	const [rawViewPriority, destinationPriorities] = await Promise.all([
		viewFact?.state.kind === 'existing'
			? Promise.resolve(viewFact.state.priority)
			: fetchCacheInfoPriority(
					fetcher,
					viewUrl,
					'view',
					tenantHeaders,
					dependencies.signal
				),
		Promise.all(
			options.caches.map((selection) => {
				const fact = options.readFacts?.find(
					(resource) =>
						resource.type === 'cupboard_cache' &&
						isSameCacheScope(resource.cache, selection.cache)
				);

				if (fact?.state.kind === 'existing') {
					return Promise.resolve(fact.state.priority);
				}

				if (
					fact?.type === 'cupboard_cache' &&
					fact.state.firstWrite !== undefined
				) {
					return Promise.resolve(fact.state.firstWrite.priority);
				}

				return fetchCacheInfoPriority(
					fetcher,
					cacheUrlFor(options.cacheUrl, selection.cache),
					'destination',
					selection.credential === undefined
						? tenantHeaders
						: basicAuthHeader(selection.credential),
					dependencies.signal
				);
			})
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
			readPassword: inputs.readPassword,
			readFacts: inputs.readFacts
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
	const separator =
		inputs.inheritedNixConfig === '' || inputs.inheritedNixConfig.endsWith('\n')
			? ''
			: '\n';
	const exportedConfig = `${inputs.inheritedNixConfig}${separator}${requiredInclude}`;

	dependencies.signal?.throwIfAborted();
	await writeFile(generatedConfigFile, nixConfig, { flag: 'wx', mode: 0o600 });
	dependencies.signal?.throwIfAborted();
	await appendEnvironmentFile(
		inputs.environment.GITHUB_ENV,
		environmentFileBlock('NIX_CONFIG', exportedConfig)
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
