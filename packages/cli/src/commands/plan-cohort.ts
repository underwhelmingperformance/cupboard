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
	type RootName,
	selectorForCache,
	type StorePathString,
	type TtlSeconds
} from '@cupboard/nix-store/scalars';
import {
	describeUnknownPath,
	type PlanStore,
	type UnknownPathDetail
} from '@cupboard/protocol/plan';
import type { ParsedRootEnsureResponse } from '@cupboard/protocol/retention';
import type { Reporter } from '@cupboard/reporter';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import type { ReadUser } from '@cupboard/shared/http';
import { type Command, InvalidArgumentError } from 'commander';

import { type Audience, audienceSchema, parseAudience } from '../audience.ts';
import { rootEnsureAuthorizationDetails } from '../auth/attenuate.ts';
import { authenticateForPush } from '../auth/auth.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { CupboardClient, storedCacheFor } from '../client/client.ts';
import { tenantRpc } from '../client/orpc.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { parseTtl } from '../duration.ts';
import {
	InvalidCohortTargetsFileError,
	ReadCredentialPairError
} from '../errors.ts';
import { reportUnknownSettings } from '../nix/settings.ts';
import {
	type AvailabilityCeiling,
	type AvailabilityCeilingConfig,
	type AvailabilityPartition,
	type AvailabilityTarget,
	partitionAvailability,
	type PlannedSubstitutionPolicy,
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
	cohortPlanInputSchema,
	type ParsedCohortPlanInput,
	type ParsedCohortTarget,
	type ParsedPlannedLocalOutput
} from '../plan/cohort-target.ts';
import { tenantProbesFor } from '../plan/destination-probe.ts';
import {
	confirmUpstreamAvailabilityWith,
	upstreamConfirmationOverrides
} from '../plan/upstream-confirmation.ts';
import { parseReadUser } from '../read-user.ts';
import { parseStoreUri } from '../store-uri.ts';
import { tenantUrlArgument } from '../url-argument.ts';

import { registerPlanMeasureCommand } from './plan-measure.ts';
import { registerPlanReprobeCommand } from './plan-reprobe.ts';
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
	readonly cache?: string;
	readonly reuseView?: string;
	readonly readUser?: ReadUser;
	readonly readPassword?: string;
	readonly ttl?: TtlSeconds;
	readonly githubOidc?: boolean;
	readonly audience?: Audience;
	readonly planFile?: string;
	readonly store?: string;
	readonly storePath?: string;
	readonly requireAttested?: boolean;
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
	readonly rootClient: Pick<RootClient, 'ensure'>;
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
	readonly attestedServed: (
		paths: readonly StorePathString[]
	) => Promise<ReadonlySet<StorePathString>>;
	readonly capacityProbe: StoreCapacityProbe;
}

export interface PlanCohortRunOptions {
	readonly targets: readonly ParsedCohortTarget[];
	readonly plannedLocalClosure?: readonly StorePathString[];
	readonly plannedSubstitutableDerivations?: readonly StorePathString[];
	readonly plannedFloatingOutputs?: readonly NixDerivedPathString[];
	readonly plannedSubstitutionPolicy: PlannedSubstitutionPolicy;
	readonly plannedLocalOutputs?: readonly ParsedPlannedLocalOutput[];
	readonly cacheName: string;
	readonly ttlSeconds?: TtlSeconds;
	readonly storeIdentity: PlanStore;
	readonly storePath: string;
	readonly planFile: string;
	/**
	 * Whether the destination cache must hold build provenance for a served
	 * output path before the plan leaves that target unbuilt.
	 */
	readonly requireAttested?: boolean;
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
		.command('plan')
		.description('Plan a build against this store.');

	plan
		.command('cohort')
		.description(
			"Report a cohort's realisation and publication partition, and " +
				'whether this store has room to build it.'
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.requiredOption(
			'--targets-file <path>',
			"JSON file describing the cohort's targets"
		)
		.option('--cache <name>', 'target a named cache rather than the default')
		.option(
			'--reuse-view <name>',
			'named tenant reuse view to probe for substitutable paths'
		)
		.option(
			'--read-user <user>',
			'username for private cache reads',
			parseReadUser
		)
		.option('--read-password <password>', 'password for private cache reads')
		.option(
			'--ttl <duration>',
			'retention TTL refreshed when a target is already retained',
			parseTtl
		)
		.option(
			'--github-oidc',
			'authenticate with a GitHub Actions OIDC token (default: the cached owner login)'
		)
		.option(
			'--audience <audience>',
			'OIDC audience to request with --github-oidc (default: the tenant URL)',
			parseAudience
		)
		.option(
			'--plan-file <path>',
			'destination for the detailed JSON partition and capacity result'
		)
		.option(
			'--store <uri>',
			'remote ssh-ng store to query for path availability and sizes (default: the local daemon)',
			parseStoreUri
		)
		.option(
			'--store-path <path>',
			`store path for the capacity probe (default: ${defaultStorePath})`
		)
		.option(
			'--require-attested',
			'rebuild a cached target unless the cache also holds its build provenance'
		)
		.option(
			'--unknown-ceiling <count>',
			'unknown-availability paths tolerated on a trusted connection',
			parseCount
		)
		.option(
			'--unknown-ceiling-untrusted-fallback <count>',
			'unknown-availability paths tolerated when the connection is not trusted',
			parseCount
		)
		.option(
			'--headroom-absolute-minimum <bytes>',
			'minimum capacity headroom in bytes',
			parseCount
		)
		.option(
			'--headroom-fraction <fraction>',
			'capacity headroom as a fraction of the store capacity',
			parseFraction
		)
		.option(
			'--cohort-split-possible',
			'record that this cohort could still be split across separate build/publish attempts'
		)
		.option(
			'--remote-store-configured',
			'record that a remote store is configured for this workflow'
		)
		.option(
			'--component-publication-applicable',
			'record that component publication applies to this cohort'
		)
		.action(async (url: URL, options: PlanCohortOptions) => {
			const reporter = commandUi(program, programOptions).reporter();
			const input = await readCohortPlanInput(options.targetsFile);
			const { targets } = input;
			const cacheName = selectorForCache(storedCacheFor(options.cache));
			const uniqueRoots = [...new Set(targets.map((target) => target.root))];
			const credential = await authenticateForPush(
				CupboardClient.fromUrl(url, {
					cache: options.cache,
					signal: programOptions.signal
				}),
				{
					githubOidc: options.githubOidc,
					audience: options.audience ?? audienceSchema.parse(url),
					authorizationDetails: uniqueRoots.flatMap((root) =>
						rootEnsureAuthorizationDetails({ cacheSelector: cacheName, root })
					)
				}
			);
			const rpc = tenantRpc(url, {
				credential,
				signal: programOptions.signal
			});
			const credentials = readCredentials(options);
			// Pass the run's abort signal to every store. Aborting the plan then
			// cancels any substituter query still in progress.
			const storeSelection = {
				...(options.store !== undefined && { storeUri: options.store }),
				...(programOptions.signal !== undefined && {
					signal: programOptions.signal
				})
			};
			const nix = Nix.openForAvailability(undefined, storeSelection);

			reportUnknownSettings(reporter, nix.unknownSettings);
			const probes = tenantProbesFor({
				baseUrl: url,
				cache: storedCacheFor(options.cache),
				...(options.reuseView !== undefined && { view: options.reuseView }),
				...(credentials !== undefined && { credentials })
			});
			const { substitution, signatures } = discoverNixStoreConfig();
			const plannedSubstitutionPolicy = await resolvePlannedSubstitutionPolicy(
				nix,
				substitution
			);
			// Confirm upstream availability through a separate store. Its override
			// includes only externally usable, non-tenant substituters and disables
			// positive narinfo caching, so each check uses their current offer.
			const permittedStore = Nix.openForAvailability(undefined, {
				...storeSelection,
				overrides: upstreamConfirmationOverrides(substitution, url)
			});

			await runPlanCohort(
				{
					targets,
					cacheName,
					plannedSubstitutionPolicy,
					...(options.ttl !== undefined && { ttlSeconds: options.ttl }),
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
					...(options.requireAttested === true && { requireAttested: true }),
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
					rootClient: rpc.roots,
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
					attestedServed: probes.attestedServed,
					capacityProbe: defaultCapacityProbe
				}
			);
		});

	registerPlanMeasureCommand(plan, program, programOptions);
	registerPlanReprobeCommand(plan, program, programOptions);
}

export async function runPlanCohort(
	options: PlanCohortRunOptions,
	reporter: Reporter,
	dependencies: PlanCohortDependencies
): Promise<void> {
	const rootEnsureResults = await reporter.phase(
		'Checking retention roots',
		() =>
			ensureCohortRoots(
				options.targets,
				options.cacheName,
				options.ttlSeconds,
				dependencies.rootClient
			)
	);
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
			() =>
				partitionAvailability({
					targets: availabilityTargets,
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
					...(options.requireAttested === true && {
						attestedServed: dependencies.attestedServed
					}),
					rootEnsureResults,
					storeIdentity: options.storeIdentity,
					requeryUnknown: dependencies.requeryUnknown,
					confirmUpstreamAvailability: dependencies.confirmUpstreamAvailability,
					ceiling: options.ceiling
				})
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
			...(partition.unattested.length === 0
				? []
				: [
						{
							label: 'Served but not attested',
							value: String(partition.unattested.length)
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
		return await reporter.phase('Checking store capacity', () =>
			checkStoreCapacity({
				measurement: {
					downloadSize: partition.downloadSize,
					narSize: partition.narSize,
					unknownCount: partition.unknownCount
				},
				storePath: options.storePath,
				probe: dependencies.capacityProbe,
				detected: options.detected,
				...(options.headroom !== undefined && { headroom: options.headroom })
			})
		);
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
	targets: readonly ParsedCohortTarget[],
	cacheName: string,
	ttlSeconds: TtlSeconds | undefined,
	client: Pick<RootClient, 'ensure'>
): Promise<ReadonlyMap<RootName, ParsedRootEnsureResponse>> {
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
		async (root): Promise<readonly [RootName, ParsedRootEnsureResponse]> => {
			const storePaths = targetsByRoot.get(root) ?? [];
			const response = await client.ensure({
				cacheName,
				name: root,
				targets: [...storePaths],
				...(ttlSeconds !== undefined && { ttlSeconds })
			});

			return [root, response];
		}
	);

	return new Map(entries);
}

export async function readCohortPlanInput(
	targetsFile: string
): Promise<ParsedCohortPlanInput> {
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
): Promise<readonly ParsedCohortTarget[]> {
	const input = await readCohortPlanInput(targetsFile);

	return input.targets;
}

export interface ReadCredentialOptions {
	readonly readUser?: ReadUser;
	readonly readPassword?: string;
}

// Reject an incomplete pair before a private-cache probe makes an
// unauthenticated request and receives a 401 response.
export function readCredentials(
	options: ReadCredentialOptions
): { readonly user: ReadUser; readonly password: string } | undefined {
	if (
		(options.readUser === undefined) !==
		(options.readPassword === undefined)
	) {
		throw new ReadCredentialPairError();
	}

	if (options.readUser === undefined || options.readPassword === undefined) {
		return undefined;
	}

	return { user: options.readUser, password: options.readPassword };
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

function parseFraction(value: string): number {
	const parsed = Number(value);

	if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
		throw new InvalidArgumentError('must be a number between 0 and 1');
	}

	return parsed;
}
