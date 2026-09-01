import type { PhaseContext, Reporter, ResultRow } from '@cupboard/reporter';
import { APIError, NotFoundError } from 'cloudflare';
import { z } from 'zod';

import { throwIfAborted } from '../abort.ts';

import type { DeploymentArtifact } from './artifact.ts';
import type { WorkerBundle } from './bundle.ts';
import { canonicalJson } from './canonical-json.ts';
import type { CloudflareApi, WorkerSecret } from './cloudflare-api.ts';
import type { DeploymentConfig } from './config.ts';
import { cloudflareZoneCandidates } from './domain.ts';
import type { DatabaseId, KvNamespaceId, ScriptName } from './identifiers.ts';
import { applyD1Migrations } from './migrations.ts';
import { type OwnerChoice, ownerHint } from './owner.ts';
import type { DeploySecrets } from './secrets.ts';
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
	readonly artifact: DeploymentArtifact;
	readonly api: CloudflareApi;
	readonly reporter: Reporter;
	readonly options: DeployOptions;
	readonly signal?: AbortSignal;
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

async function reconcileResources(
	dependencies: DeployDependencies,
	plan: ResourcePlan
): Promise<ResolvedResources> {
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

		for (const name of plan.d1Databases) {
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

		return { d1, kv };
	});
}

async function configureTriggers(
	dependencies: DeployDependencies
): Promise<void> {
	const { api, reporter, options, artifact } = dependencies;
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
	const { artifact, api, reporter, options } = dependencies;

	const resources = await reconcileResources(
		dependencies,
		collectResources(artifact.config)
	);

	const databaseId = resources.d1.get(
		artifact.config.tenant.d1Databases[0]?.databaseName ?? ''
	);

	if (databaseId !== undefined) {
		const applied = await applyD1Migrations(
			{
				queryBatch: (database, statements) =>
					api.d1QueryBatch(database, statements),
				queryRows: (database, sql) => api.d1QueryRows(database, sql)
			},
			databaseId,
			artifact.d1Migrations
		);

		if (applied.length > 0) {
			reporter.success(
				`Applying D1 migrations · applied ${String(applied.length)}`
			);
		} else {
			reporter.step('Applying D1 migrations · no migrations to apply');
		}
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

	const d1Name = artifact.config.tenant.d1Databases[0]?.databaseName;
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

function isMissingWorkerScriptError(error: unknown): boolean {
	return (
		error instanceof NotFoundError &&
		error.errors.some((item) => item.code === 10_007)
	);
}
