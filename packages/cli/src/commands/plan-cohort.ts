import { readFileSync } from 'node:fs';
import { readFile, statfs, writeFile } from 'node:fs/promises';

import {
	discoverNixStoreConfig,
	Nix,
	type NixDerivedPathString,
	type NixSubstitutionSettings,
	offerAcceptance,
	type ReadKeyFile
} from '@cupboard/nix';
import {
	type CacheScope,
	type RootName,
	type StorePathString,
	type TtlSeconds
} from '@cupboard/nix-store/scalars';
import {
	describeUnknownPath,
	type PlanStore,
	type UnknownPathDetail
} from '@cupboard/protocol/plan';
import type {
	RootEnsureResponse,
	RootRetentionRequest
} from '@cupboard/protocol/retention';
import { formatBytes, formatCount, type Reporter } from '@cupboard/reporter';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import type { ReadUser } from '@cupboard/shared/http';
import { type Command, InvalidArgumentError } from 'commander';

import { type Audience, audienceSchema, parseAudience } from '../audience.ts';
import { rootEnsureAuthorizationDetails } from '../auth/attenuate.ts';
import { authenticateForPush } from '../auth/auth.ts';
import { cacheTargetFromUrl, cacheTargetWithName } from '../cache-target.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { callInCache } from '../client/cache-scoped.ts';
import { CupboardClient } from '../client/client.ts';
import { tenantRpc } from '../client/orpc.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { parseTtl } from '../duration.ts';
import { InvalidCohortTargetsFileError } from '../errors.ts';
import { reportUnknownSettings } from '../nix/settings.ts';
import {
	type AvailabilityCeiling,
	type AvailabilityCeilingConfig,
	type AvailabilityPartition,
	type AvailabilityTarget,
	type BuildPolicy,
	partitionAvailability,
	type PlannedSubstitutionPolicy,
	type PublishScope,
	type SubstituterPolicy,
	UnknownPathsCeilingError,
	type UnknownRequeryOutcome,
	type UpstreamAvailabilityCandidate,
	type UpstreamAvailabilityVerdict
} from '../plan/availability-partition.ts';
import {
	type CapacityCheckResult,
	type CapacityMeasurement,
	checkStoreCapacity,
	type DetectedCapacityOptions,
	type HeadroomConfig,
	StoreCapacityError,
	type StoreCapacityProbe
} from '../plan/capacity.ts';
import {
	type CohortPlanInput,
	cohortPlanInputSchema,
	type CohortTarget,
	type PlannedLocalOutput
} from '../plan/cohort-target.ts';
import {
	cacheReferenceSource,
	tenantProbesFor
} from '../plan/destination-probe.ts';
import {
	confirmUpstreamAvailabilityWith,
	upstreamConfirmationOverrides
} from '../plan/upstream-confirmation.ts';
import { parseReadUser } from '../read-user.ts';
import { parseStoreUri } from '../store-uri.ts';
import { tenantUrlArgument } from '../url-argument.ts';

import { registerPlanMeasureCommand } from './plan-measure.ts';
import { registerPlanReprobeCommand } from './plan-reprobe.ts';
import { readCredentials } from './read-credentials.ts';
import { rootRetentionChoice } from './retention-choice.ts';
import type { RootClient } from './root.ts';

const maximumConcurrentRootEnsures = 8;
const defaultStorePath = '/nix/store';

// Trusted queries require every path to resolve. Untrusted queries permit a
// small number of misses because one missing narinfo can be transient.
const defaultUnknownCeiling = 0;
const defaultUnknownCeilingUntrustedFallback = 5;

const negativeNarinfoCacheBypass = { 'narinfo-cache-negative-ttl': '0' };

/**
 * Re-queries paths whose availability remained unknown, bypassing the negative
 * narinfo cache when the selected store accepts the override.
 *
 * A store that does not cache substituter responses needs no second query. For
 * a caching store, a separate client sets the negative narinfo TTL to zero.
 * The daemon applies that setting only when it honours client overrides.
 */
export async function requeryUnknownWith(
	store: Pick<Nix, 'cachesSubstituterQueries' | 'honoursSubstituterSettings'>,
	openBypass: () => Pick<Nix, 'queryMissing' | 'querySubstitutablePathInfos'>,
	storePaths: readonly StorePathString[]
): Promise<UnknownRequeryOutcome> {
	if (!store.cachesSubstituterQueries) {
		return { kind: 'already-fresh' };
	}

	const settings = await store.honoursSubstituterSettings();

	if (!settings.isHonoured) {
		const reason =
			settings.reason === 'daemon-options-preserved'
				? 'the remote transport does not pass per-command settings to the Nix daemon'
				: 'Cupboard cannot confirm the Nix daemon applied its per-command settings on this connection';

		return {
			kind: 'refused',
			reason
		};
	}

	// Use the bypass client for both the partition and the per-path costs, so
	// neither result comes from the negative narinfo cache.
	const bypass = openBypass();
	const partition = await bypass.queryMissing(storePaths);
	const offers = await bypass.querySubstitutablePathInfos(
		partition.willSubstitute
	);

	return {
		kind: 'answered',
		partition,
		sizes: new Map(
			offers.map((offer) => [
				offer.storePath,
				{ downloadSize: offer.downloadSize, narSize: offer.narSize }
			])
		)
	};
}

/**
 * Resolves the substitution policy used to estimate work after the action
 * copies a planned derivation. The policy is unknown when the selected store
 * preserves settings that belong to another Nix daemon.
 */
export async function resolvePlannedSubstitutionPolicy(
	store: Pick<Nix, 'honoursSubstituterSettings'>,
	settings: NixSubstitutionSettings
): Promise<PlannedSubstitutionPolicy> {
	const outcome = await store.honoursSubstituterSettings();

	if (!outcome.isHonoured) {
		return { kind: 'unknown' };
	}

	return {
		kind: 'known',
		substitute: settings.substitute,
		alwaysAllowSubstitutes: settings.alwaysAllowSubstitutes
	};
}

export interface PlanCohortOptions {
	readonly targetsFile: string;
	readonly reuseView?: string;
	readonly referenceSource?: URL;
	readonly readUser?: ReadUser;
	readonly readPassword?: string;
	readonly viewReadUser?: ReadUser;
	readonly viewReadPassword?: string;
	readonly ttl?: TtlSeconds;
	readonly permanent?: boolean;
	readonly githubOidc?: boolean;
	readonly audience?: Audience;
	readonly planFile?: string;
	readonly store?: string;
	readonly storePath?: string;
	readonly build?: BuildPolicy;
	readonly substituter?: SubstituterPolicy;
	readonly publish?: PublishScope;
	readonly unknownCeiling?: number;
	readonly unknownCeilingUntrustedFallback?: number;
	readonly headroomAbsoluteMinimum?: number;
	readonly headroomFraction?: number;
	readonly cohortSplitPossible?: boolean;
	readonly remoteStoreConfigured?: boolean;
	readonly componentPublicationApplicable?: boolean;
}

/**
 * SSH does not expose the remote filesystem to `statfs`, and local runner
 * capacity does not constrain a build performed in the remote store.
 */
export interface RemoteStoreCapacitySkip {
	readonly skipped: 'remote-store';
}

export interface PlanCohortResult {
	readonly partition: AvailabilityPartition;
	readonly capacity: CapacityCheckResult | RemoteStoreCapacitySkip;
}

export type PlanCohortRefusal =
	| {
			readonly reason: 'unknown-paths-ceiling';
			readonly unknownCount: number;
			readonly unknownPaths: readonly UnknownPathDetail[];
			readonly store: PlanStore;
			readonly unreachableSubstituters: readonly string[];
			readonly ceiling: AvailabilityCeiling;
			readonly downloadSize: number;
			readonly narSize: number;
	  }
	| {
			readonly reason: 'store-capacity';
			readonly measured: CapacityMeasurement;
			readonly available: number;
			readonly headroom: number;
			readonly detected: DetectedCapacityOptions;
	  };

export interface PlanCohortDependencies {
	readonly rootClient?: Pick<RootClient, 'ensure'>;
	readonly store: Pick<
		Nix,
		| 'queryMissing'
		| 'querySubstitutablePathInfos'
		| 'querySubstitutablePaths'
		| 'queryValidPaths'
		| 'unreachableSubstituters'
	>;
	readonly requeryUnknown: (
		storePaths: readonly StorePathString[]
	) => Promise<UnknownRequeryOutcome>;
	readonly confirmUpstreamAvailability: (
		candidate: UpstreamAvailabilityCandidate
	) => Promise<UpstreamAvailabilityVerdict>;
	readonly destinationServed: (
		paths: readonly StorePathString[]
	) => Promise<ReadonlySet<StorePathString>>;
	readonly viewServed: (
		paths: readonly StorePathString[]
	) => Promise<ReadonlySet<StorePathString>>;
	readonly capacityProbe: StoreCapacityProbe;
}

export function planRootClient(
	publish: PublishScope,
	create: () => Promise<Pick<RootClient, 'ensure'>>
): Promise<Pick<RootClient, 'ensure'> | undefined> {
	return publish === 'none' ? Promise.resolve(undefined) : create();
}

export interface PlanCohortRunOptions {
	readonly targets: readonly CohortTarget[];
	readonly plannedLocalClosure?: readonly StorePathString[];
	readonly plannedSubstitutableDerivations?: readonly StorePathString[];
	readonly plannedFloatingOutputs?: readonly NixDerivedPathString[];
	readonly plannedSubstitutionPolicy: PlannedSubstitutionPolicy;
	readonly plannedLocalOutputs?: readonly PlannedLocalOutput[];
	readonly cache: CacheScope;
	readonly retention: RootRetentionRequest;
	readonly storeIdentity: PlanStore;
	readonly storePath: string;
	readonly planFile: string;
	readonly build?: BuildPolicy;
	readonly substituter?: SubstituterPolicy;
	readonly publish?: PublishScope;
	readonly ceiling: AvailabilityCeilingConfig;
	readonly detected: DetectedCapacityOptions;
	readonly headroom?: Partial<HeadroomConfig>;
}

// An unreadable key file is ordinary on a machine whose keys belong to another
// user, so it does not fail the plan.
const readKeyFile: ReadKeyFile = (filePath) => {
	try {
		return readFileSync(filePath, 'utf8');
	} catch {
		return;
	}
};

export function registerPlanCommands(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	const plan = program
		.command('plan', { hidden: true })
		.description('Automation helpers used by the flake publish workflow.');

	plan
		.command('cohort')
		.description(
			'Plan builds for a group of targets in the flake publish workflow. ' +
				"Decide which of a cohort's targets to build and which the cache " +
				'already has, and check that the store has room for the build.'
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('[cache]', 'cache name, if the URL is a tenant URL')
		.requiredOption(
			'--targets-file <path>',
			"JSON file that describes the cohort's targets"
		)
		.option(
			'--reference-source <url>',
			'cache URL to query for publication by reference',
			parseWorkerUrl
		)
		.option(
			'--reuse-view <name>',
			'reuse view to query for store paths that other caches already have'
		)
		.option(
			'--read-user <user>',
			'user name of the read credential for a private cache',
			parseReadUser
		)
		.option(
			'--read-password <password>',
			'password of the read credential for a private cache'
		)
		.option(
			'--view-read-user <user>',
			'user name of the read credential for a private reuse view',
			parseReadUser
		)
		.option(
			'--view-read-password <password>',
			'password of the read credential for a private reuse view'
		)
		.option(
			'--ttl <duration>',
			'TTL for the roots that the plan sets for targets that the cache already has',
			parseTtl
		)
		.option('--permanent', 'keep those roots permanently')
		.option(
			'--github-oidc',
			"sign in with the job's GitHub Actions OIDC token instead of your saved `cupboard login` session"
		)
		.option(
			'--audience <audience>',
			'OIDC audience to request with --github-oidc (default: the tenant URL)',
			parseAudience
		)
		.option('--plan-file <path>', 'file to write the detailed plan to, as JSON')
		.option(
			'--store <uri>',
			'remote ssh-ng store to query for store paths and their sizes (default: the local Nix daemon)',
			parseStoreUri
		)
		.option(
			'--store-path <path>',
			`directory whose free space to check (default: ${defaultStorePath})`
		)
		.option(
			'--build <mode>',
			'Control when to build the requested outputs (default: missing): missing uses an available output and builds it otherwise; rebuild builds each output again on the configured builder, even if it is already available. Nix may still fetch dependencies from substituters.',
			parseBuildPolicy,
			'missing'
		)
		.option(
			'--substituter <mode>',
			'how to handle externally served target outputs: leave keeps them upstream; copy publishes them to the destination (default: leave)',
			parseSubstituterPolicy,
			'leave'
		)
		.option(
			'--publish <mode>',
			'which paths to publish: none skips publication; outputs selects target outputs; built includes observed builds; closure includes their runtime references (default: outputs)',
			parsePublishScope,
			'outputs'
		)
		.option(
			'--unknown-ceiling <count>',
			'maximum number of store paths whose availability is still unknown after the store checks them again (default: 0)',
			parseCount
		)
		.option(
			'--unknown-ceiling-untrusted-fallback <count>',
			'the same maximum when the store refuses to check them again (default: 5)',
			parseCount
		)
		.option(
			'--headroom-absolute-minimum <bytes>',
			'minimum free space to leave in the store, in bytes',
			parseCount
		)
		.option(
			'--headroom-fraction <fraction>',
			"free space to leave in the store, as a fraction of the store's capacity",
			parseFraction
		)
		.option(
			'--cohort-split-possible',
			'record in the plan that this cohort could still be split into smaller build and publish attempts'
		)
		.option(
			'--remote-store-configured',
			'record in the plan that the workflow uses a remote store'
		)
		.option(
			'--component-publication-applicable',
			'record in the plan that component publication applies to this cohort'
		)
		.action(
			async (
				url: URL,
				cacheName: string | undefined,
				options: PlanCohortOptions
			) => {
				const credentials = readCredentials(options);
				const viewCredentials = readCredentials(options, 'view');
				const reporter = commandUi(program, programOptions).reporter();
				const input = await readCohortPlanInput(options.targetsFile);
				const { targets } = input;
				const urlTarget = cacheTargetFromUrl(url);
				const target =
					cacheName === undefined
						? urlTarget
						: cacheTargetWithName(urlTarget, cacheName);
				const cache = target.cache;
				const rootClient = await planRootClient(
					options.publish ?? 'outputs',
					async () => {
						const uniqueRoots = [
							...new Set(targets.map((target) => target.root))
						];
						const credential = await authenticateForPush(
							CupboardClient.fromUrl(target.tenantUrl, {
								cache,
								signal: programOptions.signal
							}),
							{
								githubOidc: options.githubOidc,
								audience:
									options.audience ?? audienceSchema.parse(target.tenantUrl),
								authorizationDetails: uniqueRoots.flatMap((root) =>
									rootEnsureAuthorizationDetails({ cache, root })
								)
							}
						);

						return tenantRpc(target.tenantUrl, {
							credential,
							signal: programOptions.signal
						}).roots;
					}
				);
				// Pass the run's abort signal to every store. Aborting the plan then
				// cancels any substituter query still in progress.
				const storeSelection = {
					...(options.store !== undefined && { storeUri: options.store }),
					...(programOptions.signal !== undefined && {
						signal: programOptions.signal
					})
				};
				const nix = Nix.openForAvailability(undefined, {
					...storeSelection,
					localStoreQueries: 'scoped-daemon'
				});

				reportUnknownSettings(reporter, nix.unknownSettings);
				const probes = tenantProbesFor({
					baseUrl: target.tenantUrl,
					cache,
					...(options.reuseView !== undefined && { view: options.reuseView }),
					...(options.referenceSource !== undefined && {
						referenceSource: cacheReferenceSource(
							target.tenantUrl,
							options.referenceSource
						)
					}),
					...(credentials !== undefined && { credentials }),
					...(viewCredentials !== undefined && { viewCredentials })
				});
				const { substitution, signatures } = discoverNixStoreConfig();
				const plannedSubstitutionPolicy =
					await resolvePlannedSubstitutionPolicy(nix, substitution);
				// Confirm upstream availability through a separate store. Its override
				// includes only externally usable, non-tenant substituters and disables
				// positive narinfo caching, so each check uses their current offer.
				const permittedStore = Nix.openForAvailability(undefined, {
					...storeSelection,
					requirePublicNar: true,
					overrides: upstreamConfirmationOverrides(
						substitution,
						target.tenantUrl
					)
				});

				await runPlanCohort(
					{
						targets,
						cache,
						plannedSubstitutionPolicy,
						retention: rootRetentionChoice(options.ttl, options.permanent),
						storeIdentity: {
							kind: nix.storeKind,
							...(options.store !== undefined && { uri: options.store })
						},
						storePath: options.storePath ?? defaultStorePath,
						planFile: options.planFile ?? defaultPlanFile(),
						...(input.plannedLocalClosure !== undefined && {
							plannedLocalClosure: input.plannedLocalClosure
						}),
						...(input.plannedSubstitutableDerivations !== undefined && {
							plannedSubstitutableDerivations:
								input.plannedSubstitutableDerivations
						}),
						...(input.plannedFloatingOutputs !== undefined && {
							plannedFloatingOutputs: input.plannedFloatingOutputs
						}),
						...(input.plannedLocalOutputs !== undefined && {
							plannedLocalOutputs: input.plannedLocalOutputs
						}),
						build: options.build ?? 'missing',
						substituter: options.substituter ?? 'leave',
						publish: options.publish ?? 'outputs',
						ceiling: {
							value: options.unknownCeiling ?? defaultUnknownCeiling,
							untrustedFallback:
								options.unknownCeilingUntrustedFallback ??
								defaultUnknownCeilingUntrustedFallback
						},
						detected: {
							cohortSplitPossible: options.cohortSplitPossible === true,
							remoteStoreConfigured: options.remoteStoreConfigured === true,
							componentPublicationApplicable:
								options.componentPublicationApplicable === true
						},
						...((options.headroomAbsoluteMinimum !== undefined ||
							options.headroomFraction !== undefined) && {
							headroom: {
								...(options.headroomAbsoluteMinimum !== undefined && {
									absoluteMinimum: options.headroomAbsoluteMinimum
								}),
								...(options.headroomFraction !== undefined && {
									fraction: options.headroomFraction
								})
							}
						})
					},
					reporter,
					{
						...(rootClient !== undefined && { rootClient }),
						store: nix,
						requeryUnknown: (storePaths) =>
							requeryUnknownWith(
								nix,
								() =>
									Nix.openForAvailability(undefined, {
										...storeSelection,
										overrides: negativeNarinfoCacheBypass
									}),
								storePaths
							),
						confirmUpstreamAvailability: confirmUpstreamAvailabilityWith({
							substitution,
							store: permittedStore,
							// Exclude a target from publication only when the consumer's
							// signature policy accepts each source narinfo in its closure.
							accepts: offerAcceptance(signatures, readKeyFile),
							closure:
								programOptions.signal === undefined
									? {}
									: { signal: programOptions.signal }
						}),
						destinationServed: probes.destinationServed,
						viewServed: probes.viewServed,
						capacityProbe: defaultCapacityProbe
					}
				);
			}
		);

	registerPlanMeasureCommand(plan, program, programOptions);
	registerPlanReprobeCommand(plan, program, programOptions);
}

export async function runPlanCohort(
	options: PlanCohortRunOptions,
	reporter: Reporter,
	dependencies: PlanCohortDependencies
): Promise<void> {
	if (options.publish !== 'none') {
		const rootClient = dependencies.rootClient;

		if (rootClient === undefined) {
			throw new TypeError('A root client is required when publishing paths');
		}

		await reporter.phase('Checking retention roots', async (phase) => {
			const roots = await ensureCohortRoots(
				options.targets,
				options.cache,
				options.retention,
				rootClient
			);
			const responses = roots.values().toArray();
			const retained = responses.filter(
				(response) => response.status === 'retained'
			).length;

			phase.fact('retained', formatCount(retained), {
				humanLabel: 'Roots retained'
			});
			phase.fact('build required', formatCount(responses.length - retained), {
				humanLabel: 'Roots not yet retained'
			});
		});
	}
	const availabilityTargets: AvailabilityTarget[] = options.targets.map(
		(target) => ({
			attr: target.attr,
			installable: target.installable,
			...(target.plannedLocalDerivation !== undefined && {
				plannedLocalDerivation: target.plannedLocalDerivation
			}),
			...(target.expectedPath !== undefined && {
				expectedPath: target.expectedPath
			}),
			root: target.root
		})
	);

	let partition: AvailabilityPartition;

	try {
		partition = await reporter.phase(
			'Computing the availability partition',
			async (phase) => {
				const computed = await partitionAvailability({
					targets: availabilityTargets,
					build: options.build ?? 'missing',
					substituter: options.substituter ?? 'leave',
					publish: options.publish ?? 'outputs',
					plannedSubstitutionPolicy: options.plannedSubstitutionPolicy,
					...(options.plannedLocalClosure !== undefined && {
						plannedLocalClosure: new Set(options.plannedLocalClosure)
					}),
					...(options.plannedSubstitutableDerivations !== undefined && {
						plannedSubstitutableDerivations: new Set(
							options.plannedSubstitutableDerivations
						)
					}),
					...(options.plannedFloatingOutputs !== undefined && {
						plannedFloatingOutputs: new Set(options.plannedFloatingOutputs)
					}),
					...(options.plannedLocalOutputs !== undefined && {
						plannedLocalOutputs: new Map(
							Map.groupBy(options.plannedLocalOutputs, ({ path }) => path)
								.entries()
								.map(([path, outputs]) => [
									path,
									outputs.map(({ installable }) => installable)
								])
						)
					}),
					store: dependencies.store,
					destinationProbes: {
						destinationServed: dependencies.destinationServed,
						viewServed: dependencies.viewServed
					},
					storeIdentity: options.storeIdentity,
					requeryUnknown: dependencies.requeryUnknown,
					confirmUpstreamAvailability: dependencies.confirmUpstreamAvailability,
					ceiling: options.ceiling
				});

				phase.fact('to build', formatCount(computed.buildSet.length), {
					humanLabel: 'To build'
				});
				phase.fact('download size', formatBytes(computed.downloadSize), {
					humanLabel: 'Download size'
				});

				return computed;
			},
			{ humanLabel: 'Checking which targets need a build' }
		);
	} catch (error) {
		if (error instanceof UnknownPathsCeilingError) {
			const refusal: PlanCohortRefusal = {
				reason: 'unknown-paths-ceiling',
				unknownCount: error.unknownCount,
				unknownPaths: error.unknownPaths,
				store: error.store,
				unreachableSubstituters: error.unreachableSubstituters,
				ceiling: error.ceiling,
				downloadSize: error.downloadSize,
				narSize: error.narSize
			};

			reporter.result({
				kind: 'plan-cohort-refusal',
				data: refusal,
				rows: [
					{
						label: 'Refusal',
						value: 'Nix cannot obtain one or more required store paths'
					},
					{ label: 'Unavailable paths', value: String(error.unknownCount) },
					{ label: 'Limit', value: String(error.ceiling.value) },
					...(error.ceiling.fallbackReason === undefined
						? []
						: [
								{
									label: 'Limit applied because',
									value: error.ceiling.fallbackReason
								}
							]),
					...error.unknownPaths.map((detail) => ({
						label: 'Unavailable path',
						value: describeUnknownPath(detail, error.store)
					})),
					...(error.unreachableSubstituters.length === 0
						? []
						: [
								{
									label: 'Substituters not reached',
									value: error.unreachableSubstituters.join(' ')
								}
							])
				]
			});
		}

		throw error;
	}

	// Remote store paths do not exist on the runner's filesystem, and ssh-ng
	// cannot expose statfs for the remote filesystem. Skip the local capacity
	// preflight for a remote plan.
	const capacity: PlanCohortResult['capacity'] =
		options.storeIdentity.kind === 'ssh-ng'
			? { skipped: 'remote-store' }
			: await checkLocalCapacity(options, partition, reporter, dependencies);

	const result: PlanCohortResult = { partition, capacity };

	await writeFile(
		options.planFile,
		`${JSON.stringify(result, undefined, 2)}\n`
	);

	reporter.result({
		kind: 'plan-cohort',
		title: 'Build plan',
		data: result,
		rows: [
			{
				label: 'Already served by the cache',
				value: String(partition.attachOnly.length)
			},
			{
				label: 'Reused from the tenant',
				value: String(partition.publishByReference.length)
			},
			{
				label: 'Left to upstream caches',
				value: String(partition.leftUpstream.length)
			},
			{ label: 'To build', value: String(partition.buildSet.length) },
			...(partition.dependencyBuilds.length === 0
				? []
				: [
						{
							label: 'Dependencies to build',
							value: String(partition.dependencyBuilds.length)
						}
					]),
			// Availability results exclude these substituters because their queries
			// failed. Report them beside the counts so a miss is not read as a check
			// of every configured cache.
			...(partition.unreachableSubstituters.length === 0
				? []
				: [
						{
							label: 'Substituters not reached',
							value: partition.unreachableSubstituters
								.map(({ uri }) => uri)
								.join(' ')
						}
					]),
			{ label: 'Plan file', value: options.planFile }
		]
	});
}

async function checkLocalCapacity(
	options: PlanCohortRunOptions,
	partition: AvailabilityPartition,
	reporter: Reporter,
	dependencies: PlanCohortDependencies
): Promise<CapacityCheckResult> {
	try {
		return await reporter.phase('Checking store capacity', async (phase) => {
			const capacity = await checkStoreCapacity({
				measurement: {
					downloadSize: partition.downloadSize,
					narSize: partition.narSize,
					unknownCount: partition.unknownCount
				},
				storePath: options.storePath,
				probe: dependencies.capacityProbe,
				detected: options.detected,
				...(options.headroom !== undefined && { headroom: options.headroom })
			});

			phase.fact('needed', formatBytes(partition.narSize), {
				humanLabel: 'Substitutable NAR size'
			});
			phase.fact('available', formatBytes(capacity.available), {
				humanLabel: 'Space available'
			});
			phase.fact('headroom', formatBytes(capacity.headroom), {
				humanLabel: 'Headroom'
			});

			return capacity;
		});
	} catch (error) {
		if (error instanceof StoreCapacityError) {
			const refusal: PlanCohortRefusal = {
				reason: 'store-capacity',
				measured: error.measured,
				available: error.available,
				headroom: error.headroom,
				detected: error.detected
			};

			reporter.result({
				kind: 'plan-cohort-refusal',
				data: refusal,
				rows: [
					{ label: 'Refusal', value: 'insufficient store capacity' },
					{ label: 'Available', value: String(error.available) },
					{ label: 'Headroom', value: String(error.headroom) }
				]
			});
		}

		throw error;
	}
}

// Send one `roots.ensure` request per completely known root. Each request
// includes the root's full target list. A root with a floating or multi-output
// target must remain untouched until publication knows all of that target's
// outputs.
async function ensureCohortRoots(
	targets: readonly CohortTarget[],
	cache: CacheScope,
	retention: RootRetentionRequest,
	client: Pick<RootClient, 'ensure'>
): Promise<ReadonlyMap<RootName, RootEnsureResponse>> {
	const targetsByRoot = new Map<RootName, StorePathString[]>();
	const incompleteRoots = new Set<RootName>();

	for (const target of targets) {
		if (target.expectedPath === undefined) {
			incompleteRoots.add(target.root);
			targetsByRoot.delete(target.root);
			continue;
		}

		if (incompleteRoots.has(target.root)) {
			continue;
		}

		const existing = targetsByRoot.get(target.root);

		if (existing === undefined) {
			targetsByRoot.set(target.root, [target.expectedPath]);
			continue;
		}

		existing.push(target.expectedPath);
	}

	const roots = targetsByRoot.keys().toArray();
	const entries = await mapWithConcurrency(
		roots,
		maximumConcurrentRootEnsures,
		async (root): Promise<readonly [RootName, RootEnsureResponse]> => {
			const storePaths = targetsByRoot.get(root) ?? [];
			const response = await callInCache(client.ensure, cache, {
				name: root,
				targets: [...storePaths],
				retention
			});

			return [root, response];
		}
	);

	return new Map(entries);
}

export async function readCohortPlanInput(
	targetsFile: string
): Promise<CohortPlanInput> {
	let json: unknown;

	try {
		json = JSON.parse(await readFile(targetsFile, 'utf8'));
	} catch (error) {
		throw new InvalidCohortTargetsFileError(
			targetsFile,
			error instanceof Error ? error.message : 'not valid JSON'
		);
	}

	const parsed = cohortPlanInputSchema.safeParse(json);

	if (!parsed.success) {
		throw new InvalidCohortTargetsFileError(targetsFile, parsed.error.message);
	}

	return parsed.data;
}

export async function readCohortTargets(
	targetsFile: string
): Promise<readonly CohortTarget[]> {
	const input = await readCohortPlanInput(targetsFile);

	return input.targets;
}

async function defaultCapacityProbe(
	storePath: string
): Promise<{ readonly available: number; readonly capacity: number }> {
	const stats = await statfs(storePath);

	return {
		available: stats.bavail * stats.bsize,
		capacity: stats.blocks * stats.bsize
	};
}

function defaultPlanFile(): string {
	return `cupboard-plan-cohort-${String(Date.now())}.json`;
}

function parseCount(value: string): number {
	if (!/^\d+$/.test(value)) {
		throw new InvalidArgumentError('must be a non-negative integer');
	}

	return Number(value);
}

function parseBuildPolicy(value: string): BuildPolicy {
	switch (value) {
		case 'missing': {
			return 'missing';
		}
		case 'rebuild': {
			return 'rebuild';
		}
		default: {
			throw new InvalidArgumentError('must be missing or rebuild');
		}
	}
}

function parseSubstituterPolicy(value: string): SubstituterPolicy {
	switch (value) {
		case 'leave': {
			return 'leave';
		}
		case 'copy': {
			return 'copy';
		}
		default: {
			throw new InvalidArgumentError('must be leave or copy');
		}
	}
}

function parsePublishScope(value: string): PublishScope {
	switch (value) {
		case 'none': {
			return 'none';
		}
		case 'outputs': {
			return 'outputs';
		}
		case 'built': {
			return 'built';
		}
		case 'closure': {
			return 'closure';
		}
		default: {
			throw new InvalidArgumentError('must be none, outputs, built or closure');
		}
	}
}

function parseFraction(value: string): number {
	const parsed = Number(value);

	if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
		throw new InvalidArgumentError('must be a number between 0 and 1');
	}

	return parsed;
}
