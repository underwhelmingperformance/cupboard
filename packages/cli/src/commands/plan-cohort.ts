import { readFile, statfs, writeFile } from 'node:fs/promises';

import {
	discoverNixStoreConfig,
	Nix,
	type NixDaemonTrust,
	type NixStoreKind
} from '@cupboard/nix';
import {
	type RootName,
	selectorForCache,
	type StorePathString,
	type TtlSeconds
} from '@cupboard/nix-store/scalars';
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
import {
	type AvailabilityCeiling,
	type AvailabilityCeilingConfig,
	type AvailabilityPartition,
	type AvailabilityTarget,
	type LeftUpstreamCandidate,
	type LeftUpstreamVerdict,
	partitionAvailability,
	UnknownPathsCeilingError
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
	type ParsedCohortTarget
} from '../plan/cohort-target.ts';
import { destinationAnswersFor } from '../plan/destination-probe.ts';
import {
	confirmLeftUpstreamWith,
	permittedSubstituterOverrides
} from '../plan/upstream-confirmation.ts';
import { parseReadUser } from '../read-user.ts';
import { parseStoreUri } from '../store-uri.ts';
import { tenantUrlArgument } from '../url-argument.ts';

import { registerPlanMeasureCommand } from './plan-measure.ts';
import { registerPlanReprobeCommand } from './plan-reprobe.ts';
import type { RootClient } from './root.ts';

const maximumConcurrentRootEnsures = 8;
const defaultStorePath = '/nix/store';

// Provisional, per PLAN.md: unset until the rollout fixture's measurements
// tune them. Zero suits a trusted connection that requires every path to
// resolve; the untrusted fallback stays small but nonzero, since an
// untrusted connection missing one narinfo answer is a routine transient.
const defaultUnknownCeiling = 0;
const defaultUnknownCeilingUntrustedFallback = 5;

const negativeNarinfoCacheBypass = { 'narinfo-cache-negative-ttl': '0' };

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
	readonly unknownCeiling?: number;
	readonly unknownCeilingUntrustedFallback?: number;
	readonly headroomAbsoluteMinimum?: number;
	readonly headroomFraction?: number;
	readonly cohortSplitPossible?: boolean;
	readonly remoteStoreConfigured?: boolean;
	readonly componentPublicationApplicable?: boolean;
}

/**
 * The capacity entry a plan over a remote store records: ssh cannot statfs
 * the remote filesystem, and a remote store is itself the design's answer to
 * a runner whose local store is too small, so the local preflight does not
 * apply and its skip is recorded in the plan.
 */
export interface RemoteStoreCapacitySkip {
	readonly skipped: 'remote-store';
}

/** The realisation and publication partition {@link runPlanCohort} reports. */
export interface PlanCohortResult {
	readonly partition: AvailabilityPartition;
	readonly capacity: CapacityCheckResult | RemoteStoreCapacitySkip;
}

/**
 * A typed, non-zero-exit outcome of a cohort plan: either the unknown-path
 * count settled over the configured ceiling, or the measured substitutable
 * bytes would not fit this store. Reported over the result protocol with the
 * measured numbers before the underlying error propagates.
 */
export type PlanCohortRefusal =
	| {
			readonly reason: 'unknown-paths-ceiling';
			readonly unknownCount: number;
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

/**
 * What {@link runPlanCohort} needs from this run's environment, all
 * injectable so a command test can drive it with doubles: a root client for
 * the ensure calls, the selected store's own availability queries, the
 * daemon-trust and re-query facilities {@link partitionAvailability} settles
 * unknowns with, the destination/view HTTP probes, and the store capacity
 * probe.
 */
export interface PlanCohortDependencies {
	readonly rootClient: Pick<RootClient, 'ensure'>;
	readonly store: Pick<
		Nix,
		'queryMissing' | 'querySubstitutablePaths' | 'queryValidPaths'
	>;
	readonly daemonTrust: () => Promise<NixDaemonTrust>;
	readonly openReQueryClient: () => Pick<Nix, 'queryMissing'>;
	readonly confirmLeftUpstream: (
		candidate: LeftUpstreamCandidate
	) => Promise<LeftUpstreamVerdict>;
	readonly destinationServed: (
		paths: readonly StorePathString[]
	) => Promise<ReadonlySet<StorePathString>>;
	readonly viewServed: (
		paths: readonly StorePathString[]
	) => Promise<ReadonlySet<StorePathString>>;
	readonly capacityProbe: StoreCapacityProbe;
}

export interface PlanCohortRunOptions {
	readonly targets: readonly ParsedCohortTarget[];
	readonly cacheName: string;
	readonly ttlSeconds?: TtlSeconds;
	/** The kind of store the selected client reads through. */
	readonly storeKind: NixStoreKind;
	readonly storePath: string;
	readonly planFile: string;
	readonly ceiling: AvailabilityCeilingConfig;
	readonly detected: DetectedCapacityOptions;
	readonly headroom?: Partial<HeadroomConfig>;
}

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
			'remote ssh-ng store whose own answers drive the partition (default: the local daemon)',
			parseStoreUri
		)
		.option(
			'--store-path <path>',
			`store path the capacity probe measures (default: ${defaultStorePath})`
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
			const targets = await readCohortTargets(options.targetsFile);
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
			const storeSelection =
				options.store === undefined ? {} : { storeUri: options.store };
			const nix = Nix.openDaemon(undefined, storeSelection);
			const answers = destinationAnswersFor({
				baseUrl: url,
				cache: storedCacheFor(options.cache),
				...(options.reuseView !== undefined && { view: options.reuseView }),
				...(credentials !== undefined && { credentials })
			});
			const { substitution } = discoverNixStoreConfig();
			// A separate connection for the upstream confirmation: its
			// substituter list holds only what a consumer elsewhere could
			// also reach, so content the tenant alone holds never reads as
			// available upstream.
			const permittedStore = Nix.openDaemon(undefined, {
				...storeSelection,
				overrides: permittedSubstituterOverrides(substitution, url)
			});

			await runPlanCohort(
				{
					targets,
					cacheName,
					...(options.ttl !== undefined && { ttlSeconds: options.ttl }),
					storeKind: nix.storeKind,
					storePath: options.storePath ?? defaultStorePath,
					planFile: options.planFile ?? defaultPlanFile(),
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
					daemonTrust: () => nix.daemonTrust(),
					openReQueryClient: () =>
						Nix.openDaemon(undefined, {
							...storeSelection,
							overrides: negativeNarinfoCacheBypass
						}),
					confirmLeftUpstream: confirmLeftUpstreamWith({
						substitution,
						store: permittedStore,
						closure:
							programOptions.signal === undefined
								? {}
								: { signal: programOptions.signal }
					}),
					destinationServed: answers.destinationServed,
					viewServed: answers.viewServed,
					capacityProbe: defaultCapacityProbe
				}
			);
		});

	registerPlanMeasureCommand(plan, program, programOptions);
	registerPlanReprobeCommand(plan, program, programOptions);
}

/**
 * Computes a cohort's availability partition and checks it against this
 * store's capacity, reporting the result (or a typed refusal) over `reporter`
 * and writing the detailed JSON to `options.planFile`. Every external effect
 * is injected through `dependencies`, so a command test drives this with
 * doubles for the root client, the store, the destination probes and the
 * capacity probe.
 */
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
			installable: target.installable,
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
					store: dependencies.store,
					destinationAnswers: {
						destinationServed: dependencies.destinationServed,
						viewServed: dependencies.viewServed
					},
					rootEnsureResults,
					daemonTrust: dependencies.daemonTrust,
					openReQueryClient: dependencies.openReQueryClient,
					confirmLeftUpstream: dependencies.confirmLeftUpstream,
					ceiling: options.ceiling
				})
		);
	} catch (error) {
		if (error instanceof UnknownPathsCeilingError) {
			const refusal: PlanCohortRefusal = {
				reason: 'unknown-paths-ceiling',
				unknownCount: error.unknownCount,
				ceiling: error.ceiling,
				downloadSize: error.downloadSize,
				narSize: error.narSize
			};

			reporter.result({
				kind: 'plan-cohort-refusal',
				data: refusal,
				rows: [
					{ label: 'Refusal', value: 'unknown paths over ceiling' },
					{ label: 'Unknown count', value: String(error.unknownCount) },
					{ label: 'Ceiling', value: String(error.ceiling.value) }
				]
			});
		}

		throw error;
	}

	// A remote store's paths never land on this runner's filesystem, and ssh
	// cannot statfs the remote one, so the capacity preflight only applies to
	// a store on this machine; a remote plan records the skip.
	const capacity: PlanCohortResult['capacity'] =
		options.storeKind === 'ssh-ng'
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
			{ label: 'Attach only', value: String(partition.attachOnly.length) },
			{
				label: 'Publish by reference',
				value: String(partition.publishByReference.length)
			},
			{ label: 'Left upstream', value: String(partition.leftUpstream.length) },
			{ label: 'Build set', value: String(partition.buildSet.length) },
			{ label: 'Plan file', value: options.planFile }
		]
	});
}

// The local store's capacity preflight, reporting a typed refusal with the
// measured numbers before the underlying error propagates.
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

// One `roots.ensure` call per root named by a known-output target, carrying
// every target that root declares: the call reconciles the root's whole
// target set, so a target sharing a root with another must not be checked in
// isolation.
async function ensureCohortRoots(
	targets: readonly ParsedCohortTarget[],
	cacheName: string,
	ttlSeconds: TtlSeconds | undefined,
	client: Pick<RootClient, 'ensure'>
): Promise<ReadonlyMap<RootName, ParsedRootEnsureResponse>> {
	const targetsByRoot = new Map<RootName, StorePathString[]>();

	for (const target of targets) {
		if (target.expectedPath === undefined) {
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

/**
 * Reads the cohort targets file every plan command over a cohort consumes: the
 * targets as `build-cohort` writes them from a plan job's cohort-matrix entry.
 */
export async function readCohortTargets(
	targetsFile: string
): Promise<readonly ParsedCohortTarget[]> {
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

	return parsed.data.targets;
}

/** The read-credential options a private cache's own probes are given. */
export interface ReadCredentialOptions {
	readonly readUser?: ReadUser;
	readonly readPassword?: string;
}

/**
 * The credential pair a private cache's probes carry, or nothing at all for a
 * public one. A half-supplied pair refuses: a probe that quietly dropped the
 * password would report a private cache as serving nothing.
 */
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
