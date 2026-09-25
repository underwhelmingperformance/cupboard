import {
	buildRequiresCompleteBefore,
	currentLocalStep,
	type LocalStep
} from '@cupboard/protocol/deployment';
import { workersInvocationAllowances } from '@cupboard/protocol/platform';
import type { PhaseContext, Reporter, ResultRow } from '@cupboard/reporter';
import { APIError, NotFoundError } from 'cloudflare';
import { z } from 'zod';

import { throwIfAborted } from '../abort.ts';
import { DeploymentPhaseUnsettledError } from '../errors.ts';

import type { DeploymentArtifact } from './artifact.ts';
import type { WorkerBundle } from './bundle.ts';
import type { CloudflareApi, WorkerSecret } from './cloudflare-api.ts';
import type { DeploymentConfig } from './config.ts';
import { cloudflareZoneCandidates } from './domain.ts';
import type { DatabaseId, KvNamespaceId, ScriptName } from './identifiers.ts';
import { type OwnerChoice, ownerHint } from './owner.ts';
import { type PhaseApi, readLocalStepReadiness } from './phase.ts';
import type { DeploySecrets } from './secrets.ts';
import type { DeploymentPlan } from './transition.ts';
import {
	completeTransitions,
	prepareTransitions,
	type TransitionEvent,
	type TransitionWalk
} from './transitions.ts';
import {
	buildScriptMetadata,
	type ResolvedResources,
	type ScriptMetadata
} from './upload.ts';

// Cloudflare's error code for `limits` on a plan that does not allow them.
const cpuLimitsUnsupportedCode = 100_328;

function isCpuLimitsUnsupported(error: unknown): boolean {
	return (
		error instanceof APIError &&
		error.errors.some((detail) => detail.code === cpuLimitsUnsupportedCode)
	);
}

/**
 * Upload a script, dropping the CPU limit if the plan does not support one
 * (the Free plan rejects the `limits` field outright). The Worker still
 * deploys and runs within the plan's own CPU budget.
 */
async function uploadScriptForPlan(
	dependencies: DeployDependencies,
	context: PhaseContext,
	scriptName: ScriptName,
	metadata: ScriptMetadata,
	bundle: WorkerBundle
): Promise<void> {
	try {
		await dependencies.api.uploadScript(scriptName, metadata, bundle);
	} catch (error) {
		if (!isCpuLimitsUnsupported(error) || metadata.limits === undefined) {
			throw error;
		}

		context.warn(
			'CPU limit not applied',
			`${scriptName}: this plan does not support CPU limits, so the Worker runs within the plan's CPU budget`
		);

		const { limits: _limits, ...withoutLimits } = metadata;
		await dependencies.api.uploadScript(scriptName, withoutLimits, bundle);
	}
}

export interface DeployOptions {
	readonly domain: string | undefined;
	readonly secrets: DeploySecrets;
}

export interface DeployDependencies {
	readonly plan: DeploymentPlan;
	readonly api: CloudflareApi;
	readonly reporter: Reporter;
	readonly options: DeployOptions;
	readonly signal?: AbortSignal;
	readonly settleTenants?: (requiredStep: LocalStep) => Promise<void>;
	readonly now?: () => Date;
}

interface ResourcePlan {
	readonly r2Buckets: readonly string[];
	readonly d1Databases: readonly string[];
	readonly kvTitles: readonly string[];
	readonly queues: readonly string[];
}

function uniqueSorted(values: Iterable<string>): string[] {
	return [...new Set(values)].toSorted((left, right) =>
		left.localeCompare(right)
	);
}

/**
 * The full set of named resources both Workers depend on, deduped. Drives both
 * the dry-run plan and the reconcile step.
 */
export function collectResources(config: DeploymentConfig): ResourcePlan {
	const workers = [config.control, config.tenant];

	const queues = [
		...config.control.queueProducers.map((producer) => producer.queue),
		...config.control.queueConsumers.flatMap((consumer) => [
			consumer.queue,
			...(consumer.deadLetterQueue === undefined
				? []
				: [consumer.deadLetterQueue])
		])
	];

	return {
		r2Buckets: uniqueSorted(
			workers.flatMap((worker) =>
				worker.r2Buckets.map((bucket) => bucket.bucketName)
			)
		),
		d1Databases: uniqueSorted(
			workers.flatMap((worker) =>
				worker.d1Databases.map((database) => database.databaseName)
			)
		),
		kvTitles: uniqueSorted(
			workers.flatMap((worker) =>
				worker.kvNamespaces.map((namespace) => namespace.title)
			)
		),
		queues: uniqueSorted(queues)
	};
}

/**
 * The plan facts that are derived from the built artifact and cannot be
 * changed at deploy time: bundle sizes, derived KV titles, migration count,
 * and which secrets will be set.
 */
export function derivedPlanRows(
	artifact: DeploymentArtifact,
	secrets: DeploySecrets,
	annotatedSecrets: readonly string[] = []
): ResultRow[] {
	const resources = collectResources(artifact.config);
	const secretNames = [
		...[...secrets.control, ...secrets.tenant].map((secret) => secret.name),
		...annotatedSecrets
	];

	return [
		{ label: 'Build', value: artifact.buildVersion },
		{
			label: 'Subrequests per invocation',
			value:
				artifact.config.tenant.vars.CUPBOARD_SUBREQUESTS_PER_INVOCATION ??
				String(workersInvocationAllowances.free.subrequests)
		},
		{
			label: 'Control worker',
			value: `${(artifact.controlBundle.code.length / 1024).toFixed(0)} KiB`
		},
		{
			label: 'Tenant worker',
			value: `${(artifact.tenantBundle.code.length / 1024).toFixed(0)} KiB`
		},
		{ label: 'KV namespaces', value: resources.kvTitles.join(', ') },
		{ label: 'D1 migrations', value: String(artifact.d1Migrations.length) },
		{ label: 'Secrets', value: secretNames.join(', ') || '(none)' }
	];
}

/**
 * The plan facts the user may change while reviewing: resource names, cron
 * triggers, the custom domain, and the admin identity.
 */
export function choicePlanRows(
	config: DeploymentConfig,
	domain: string | undefined,
	owner: OwnerChoice
): ResultRow[] {
	const resources = collectResources(config);

	return [
		{ label: 'R2 buckets', value: resources.r2Buckets.join(', ') },
		{ label: 'D1 databases', value: resources.d1Databases.join(', ') },
		{ label: 'Queues', value: resources.queues.join(', ') },
		{
			label: 'Cron triggers',
			value: config.control.crons.join(', ') || '(none)'
		},
		{ label: 'Custom domain', value: domain ?? '(none)' },
		{ label: 'Admin', value: ownerHint(owner) }
	];
}

interface ReconciledResources {
	readonly resources: ResolvedResources;
	// The D1 databases this run created. A fresh database has no old Workers
	// to drain and no tenants, so every schema transition completes before the
	// upload.
	readonly freshDatabases: ReadonlySet<string>;
}

async function reconcileResources(
	dependencies: DeployDependencies,
	plan: ResourcePlan
): Promise<ReconciledResources> {
	const { api, reporter } = dependencies;

	return reporter.phase('Reconciling resources', async (context) => {
		await Promise.all(
			plan.r2Buckets.map(async (name) => {
				await api.ensureR2Bucket(name);
				await api.ensureStagingLifecycleRule(name);
			})
		);
		await Promise.all(plan.queues.map((name) => api.ensureQueue(name)));

		const d1 = new Map<string, DatabaseId>();
		const freshDatabases = new Set<string>();

		for (const name of plan.d1Databases) {
			if ((await api.findD1Database(name)) === undefined) {
				freshDatabases.add(name);
			}

			d1.set(name, await api.ensureD1Database(name));
		}

		const kv = new Map<string, KvNamespaceId>();

		for (const title of plan.kvTitles) {
			kv.set(title, await api.ensureKvNamespace(title));
		}

		context.fact(
			'resources',
			plan.r2Buckets.length +
				plan.d1Databases.length +
				plan.kvTitles.length +
				plan.queues.length
		);

		return { resources: { d1, kv }, freshDatabases };
	});
}

async function configureTriggers(
	dependencies: DeployDependencies
): Promise<void> {
	const { api, reporter, options, plan } = dependencies;
	const { artifact } = plan;
	const control = artifact.config.control;

	await reporter.phase('Configuring triggers', async (context) => {
		for (const consumer of control.queueConsumers) {
			const queueId = await api.ensureQueue(consumer.queue);

			await api.ensureQueueConsumer(queueId, control.name, {
				maxBatchSize: consumer.maxBatchSize,
				maxBatchTimeout: consumer.maxBatchTimeout,
				maxRetries: consumer.maxRetries,
				maxConcurrency: consumer.maxConcurrency,
				deadLetterQueue: consumer.deadLetterQueue
			});
		}

		await api.ensureSchedules(control.name, control.crons);

		if (options.domain === undefined) {
			await api.setCustomDomain(control.name, undefined);

			return;
		}

		const zoneId = await findZoneId(api, options.domain);

		if (zoneId === undefined) {
			context.warn(
				'No Cloudflare zone for',
				`${options.domain}; add the domain to this account, then re-run.`
			);

			return;
		}

		await api.setCustomDomain(control.name, {
			hostname: options.domain,
			zoneId
		});
	});
}

async function findZoneId(
	api: CloudflareApi,
	hostname: string
): Promise<Awaited<ReturnType<CloudflareApi['findZoneId']>>> {
	for (const candidate of cloudflareZoneCandidates(hostname)) {
		const zoneId = await api.findZoneId(candidate);

		if (zoneId !== undefined) {
			return zoneId;
		}
	}

	return undefined;
}

/**
 * Whether the bindings a deployed script reports match what this deploy would
 * upload. The live list keeps its secrets across uploads, so `secret_text`
 * entries are left out of the comparison. Any other difference counts as a
 * mismatch, including an extra field the API adds of its own, and the cost of
 * treating that as a mismatch is at most one redundant upload.
 */
export function hasMatchingBindings(
	planned: readonly unknown[] | undefined,
	live: readonly unknown[] | undefined
): boolean {
	if (planned === undefined || live === undefined) {
		return false;
	}

	const keptLive = live.filter((binding) => !isSecretBinding(binding));

	if (keptLive.length !== planned.length) {
		return false;
	}

	const plannedCanonical = canonicalise(planned);

	return canonicalise(keptLive).every(
		(binding, index) => binding === plannedCanonical[index]
	);
}

function canonicalise(bindings: readonly unknown[]): string[] {
	// Both sides of the equality check run through this same comparator, so the
	// absolute order does not matter, only that it is a consistent total order.
	return bindings
		.map((binding) => canonicalJson(binding))
		.toSorted((a, b) => a.localeCompare(b));
}

function isSecretBinding(binding: unknown): boolean {
	return z.looseObject({ type: z.literal('secret_text') }).safeParse(binding)
		.success;
}

// JSON with object keys sorted at every level, so two structurally equal
// bindings serialise identically regardless of property order.
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
	}

	if (typeof value === 'object' && value !== null) {
		const entries = Object.entries(value)
			.toSorted(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);

		return `{${entries.join(',')}}`;
	}

	return JSON.stringify(value);
}

/**
 * Provisions, migrates, uploads, and configures a Cupboard deployment after the
 * caller has accepted the plan. The command handles `--dry-run` before it calls
 * this mutating operation.
 */
export async function runDeploy(
	dependencies: DeployDependencies
): Promise<ResultRow[]> {
	throwIfAborted(dependencies.signal);

	try {
		const result = await performDeploy(dependencies);
		throwIfAborted(dependencies.signal);

		return result;
	} catch (error) {
		throwIfAborted(dependencies.signal);

		throw error;
	}
}

async function performDeploy(
	dependencies: DeployDependencies
): Promise<ResultRow[]> {
	const { api, reporter, options, plan } = dependencies;
	const { artifact } = plan;

	const { resources, freshDatabases } = await reconcileResources(
		dependencies,
		collectResources(artifact.config)
	);

	const d1Name = artifact.config.tenant.d1Databases[0]?.databaseName;
	const databaseId =
		d1Name === undefined ? undefined : resources.d1.get(d1Name);

	if (databaseId !== undefined && d1Name !== undefined) {
		// The walk reads the recorded transitions before a migration or an
		// upload. A transition this build does not define stops the deploy here,
		// before this build's Workers are put in front of storage a newer build
		// shaped.
		await reporter.phase('Preparing schema transitions', (context) =>
			prepareTransitions(
				transitionWalk(dependencies, databaseId, context),
				freshDatabases.has(d1Name)
			)
		);
	}

	const withBuildVersion = (metadata: ScriptMetadata): ScriptMetadata => ({
		...metadata,
		annotations: {
			...metadata.annotations,
			'workers/tag': artifact.buildVersion
		}
	});
	const tenantMetadata = withBuildVersion(
		buildScriptMetadata(artifact.config.tenant, resources)
	);
	const controlMetadata = withBuildVersion(
		buildScriptMetadata(artifact.config.control, resources)
	);

	const unchanged = await reporter.phase(
		'Checking the deployed Workers',
		async (context) => {
			context.fact('build', artifact.buildVersion);

			// A dirty build's version cannot distinguish two different working trees.
			if (artifact.buildVersion.endsWith('+dirty')) {
				return { tenant: false, control: false };
			}

			const [tenantLive, controlLive] = await Promise.all([
				api.getScriptConfiguration(artifact.config.tenant.name),
				api.getScriptConfiguration(artifact.config.control.name)
			]);

			return {
				tenant:
					tenantLive?.buildVersion === artifact.buildVersion &&
					hasMatchingBindings(tenantMetadata.bindings, tenantLive.bindings) &&
					tenantLive.cacheEnabled === artifact.config.tenant.cacheEnabled &&
					tenantLive.crossVersionCache === artifact.config.tenant.cacheEnabled,
				control:
					controlLive?.buildVersion === artifact.buildVersion &&
					hasMatchingBindings(controlMetadata.bindings, controlLive.bindings) &&
					controlLive.cacheEnabled === artifact.config.control.cacheEnabled &&
					controlLive.crossVersionCache === artifact.config.control.cacheEnabled
			};
		}
	);

	const uploadTenant = async (): Promise<void> => {
		if (unchanged.tenant) {
			reporter.step(
				`${artifact.config.tenant.name} already runs this build and configuration; upload skipped.`
			);

			return;
		}

		await reporter.phase('Uploading tenant worker', (context) =>
			uploadScriptForPlan(
				dependencies,
				context,
				artifact.config.tenant.name,
				tenantMetadata,
				artifact.tenantBundle
			)
		);
	};
	const uploadControl = async (): Promise<void> => {
		if (unchanged.control) {
			reporter.step(
				`${artifact.config.control.name} already runs this build and configuration; upload skipped.`
			);

			return;
		}

		await reporter.phase('Uploading control worker', (context) =>
			uploadScriptForPlan(
				dependencies,
				context,
				artifact.config.control.name,
				controlMetadata,
				artifact.controlBundle
			)
		);
	};
	const tenantRoutes = {
		workersDev: artifact.config.tenant.workersDev,
		previewUrls: artifact.config.tenant.previewUrls
	};
	const shouldRestrictTenantRoutes =
		!tenantRoutes.workersDev || !tenantRoutes.previewUrls;

	if (shouldRestrictTenantRoutes) {
		try {
			await api.setWorkersDevRoutes(artifact.config.tenant.name, tenantRoutes);
		} catch (error) {
			// The settings route does not exist before the first script upload. The
			// required call after upload must still confirm the restricted routes.
			if (!isMissingWorkerScriptError(error)) {
				throw error;
			}
		}
	}

	const hasNamedTenantEntrypoint = artifact.config.control.services.some(
		(service) =>
			service.binding === 'CUPBOARD_TENANT' && service.entrypoint !== undefined
	);

	if (hasNamedTenantEntrypoint) {
		await uploadTenant();
		await uploadControl();
	} else {
		await uploadControl();
		await uploadTenant();
	}

	await api.setWorkersDevRoutes(artifact.config.tenant.name, tenantRoutes);

	const secretWork: { scriptName: ScriptName; secret: WorkerSecret }[] = [
		...options.secrets.control.map((secret) => ({
			scriptName: artifact.config.control.name,
			secret
		})),
		...options.secrets.tenant.map((secret) => ({
			scriptName: artifact.config.tenant.name,
			secret
		}))
	];

	if (secretWork.length > 0) {
		await reporter.phase('Setting secrets', async (context) => {
			for (const { scriptName, secret } of secretWork) {
				await api.putSecret(scriptName, secret);
			}

			context.fact('secrets', secretWork.length);
		});
	} else {
		reporter.step('Setting secrets · no secrets to set');
	}

	await configureTriggers(dependencies);

	if (databaseId !== undefined) {
		await reporter.phase('Completing schema transitions', (context) =>
			completeTransitions(transitionWalk(dependencies, databaseId, context))
		);
		if (dependencies.settleTenants !== undefined) {
			const readiness = await readLocalStepReadiness(
				d1QueryApiOf(api),
				databaseId,
				currentLocalStep
			);
			if (readiness.pending > 0) {
				await dependencies.settleTenants(currentLocalStep);
			}
		}
	}

	const d1Database =
		databaseId === undefined || d1Name === undefined
			? undefined
			: { name: d1Name, id: databaseId };

	const rows: ResultRow[] = [
		{ label: 'Control worker', value: artifact.config.control.name },
		{ label: 'Tenant worker', value: artifact.config.tenant.name },
		...(d1Database === undefined
			? []
			: [
					{
						label: 'D1 database',
						value: `${d1Database.name} · ${d1Database.id}`
					}
				]),
		...(options.domain === undefined
			? []
			: [{ label: 'Cache URL', value: `https://${options.domain}` }])
	];

	reporter.result({
		kind: 'deployment',
		data: {
			controlWorker: artifact.config.control.name,
			tenantWorker: artifact.config.tenant.name,
			d1Database,
			cacheUrl:
				options.domain === undefined ? undefined : `https://${options.domain}`
		},
		rows
	});

	return rows;
}

// The D1 query surface the transition walk and the readiness reads share.
function d1QueryApiOf(api: CloudflareApi): PhaseApi {
	return {
		queryBatch: (database, statements) =>
			api.d1QueryBatch(database, statements),
		queryRows: (database, sql) => api.d1QueryRows(database, sql)
	};
}

function transitionEventText(event: TransitionEvent): string {
	switch (event.kind) {
		case 'reconciled': {
			return `${event.state} (from the recorded phase)`;
		}

		case 'deferred': {
			return 'deferred until the earlier transitions contract';
		}

		case 'expanded': {
			return `expanded · applied ${String(event.applied.length)}`;
		}

		case 'settled': {
			return `tenants at local step ${String(event.step)}`;
		}

		case 'complete': {
			return `complete · applied ${String(event.applied.length)}`;
		}
	}
}

function transitionWalk(
	dependencies: DeployDependencies,
	databaseId: DatabaseId,
	context: PhaseContext
): TransitionWalk {
	const { api, plan } = dependencies;

	return {
		api: d1QueryApiOf(api),
		databaseId,
		transitions: plan.transitions,
		requiresCompleteBefore: buildRequiresCompleteBefore,
		hooks: {
			now: dependencies.now ?? (() => new Date()),
			awaitServing: () => awaitServing(api, plan.artifact),
			settleTenants: dependencies.settleTenants,
			report: (event) => {
				context.fact(event.transition, transitionEventText(event));
			}
		}
	};
}

function isMissingWorkerScriptError(error: unknown): boolean {
	return (
		error instanceof NotFoundError &&
		error.errors.some((item) => item.code === 10_007)
	);
}

/**
 * Returns the build a script is serving, or undefined when its deployment does
 * not send every request to one version. A gradual deployment splits traffic
 * between two versions, and there is then no single build to report.
 *
 * This reads the deployment's intended allocation. Cloudflare has accepted a
 * deployment that sends every request to this build; whether every colo is
 * already serving it is not reported, and nothing here measures that
 * propagation or the completion of requests already in flight.
 */
async function servingBuildVersion(
	api: CloudflareApi,
	scriptName: ScriptName
): Promise<string | undefined> {
	const versions = await api.listDeployedVersions(scriptName);
	const [only] = versions;

	if (versions.length !== 1 || only?.percentage !== 100) {
		return undefined;
	}

	const configuration = await api.getScriptConfiguration(scriptName);

	return configuration?.buildVersion;
}

/**
 * Confirms both Workers serve this build from a single version before a
 * transition contracts what the earlier build reads.
 *
 * The deployments API reports the configured allocation, not whether old
 * requests have finished; contracted schemas must reject incompatible writes.
 * If a script is still split across versions, or still serves an earlier
 * build, this throws {@link DeploymentPhaseUnsettledError} and the walk
 * leaves the transitions where they are.
 */
async function awaitServing(
	api: CloudflareApi,
	artifact: DeploymentArtifact
): Promise<void> {
	const unsettled: ScriptName[] = [];

	for (const scriptName of [
		artifact.config.control.name,
		artifact.config.tenant.name
	]) {
		const serving = await servingBuildVersion(api, scriptName);

		if (serving !== artifact.buildVersion) {
			unsettled.push(scriptName);
		}
	}

	if (unsettled.length > 0) {
		throw new DeploymentPhaseUnsettledError(unsettled, artifact.buildVersion);
	}
}
