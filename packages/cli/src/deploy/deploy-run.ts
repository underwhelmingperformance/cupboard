import type { PhaseContext, Reporter, ResultRow } from '@cupboard/reporter';
import { APIError } from 'cloudflare';
import type { ScriptUpdateParams } from 'cloudflare/resources/workers/scripts/scripts';

import type { DeploymentArtifact } from './artifact.ts';
import type { WorkerBundle } from './bundle.ts';
import type { CloudflareApi, WorkerSecret } from './cloudflare-api.ts';
import type { DeploymentConfig } from './config.ts';
import {
	applyD1Migrations,
	computeDurableObjectMigration
} from './migrations.ts';
import { type OwnerChoice, ownerHint } from './owner.ts';
import type { DeploySecrets } from './secrets.ts';
import { buildScriptMetadata, type ResolvedResources } from './upload.ts';

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
	deps: DeployDeps,
	context: PhaseContext,
	scriptName: string,
	metadata: ScriptUpdateParams.Metadata,
	bundle: WorkerBundle
): Promise<void> {
	try {
		await deps.api.uploadScript(scriptName, metadata, bundle);
	} catch (error) {
		if (!isCpuLimitsUnsupported(error) || metadata.limits === undefined) {
			throw error;
		}

		context.warn(
			'CPU limit not applied',
			`${scriptName}: this plan does not support CPU limits, so the Worker runs within the plan's CPU budget`
		);

		const { limits: _limits, ...withoutLimits } = metadata;
		await deps.api.uploadScript(scriptName, withoutLimits, bundle);
	}
}

export interface DeployOptions {
	readonly domain: string | undefined;
	readonly dryRun: boolean;
	readonly secrets: DeploySecrets;
	/** What `/_version` answered before this deploy, when reachable. */
	readonly liveBuild: string | undefined;
}

export interface DeployDeps {
	readonly artifact: DeploymentArtifact;
	readonly api: CloudflareApi;
	readonly reporter: Reporter;
	readonly options: DeployOptions;
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
	deps: DeployDeps,
	plan: ResourcePlan
): Promise<ResolvedResources> {
	const { api, reporter } = deps;

	return reporter.phase('Reconciling resources', async (context) => {
		await Promise.all(plan.r2Buckets.map((name) => api.ensureR2Bucket(name)));
		await Promise.all(plan.queues.map((name) => api.ensureQueue(name)));

		const d1 = new Map<string, string>();

		for (const name of plan.d1Databases) {
			d1.set(name, await api.ensureD1Database(name));
		}

		const kv = new Map<string, string>();

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
	deps: DeployDeps,
	resources: ResolvedResources
): Promise<void> {
	const { api, reporter, options, artifact } = deps;
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

		if (control.crons.length > 0) {
			await api.ensureSchedules(control.name, control.crons);
		}

		if (options.domain !== undefined) {
			const zoneId = await api.findZoneId(zoneOf(options.domain));

			if (zoneId === undefined) {
				context.warn(
					'No Cloudflare zone for',
					`${options.domain}; add the domain to this account, then re-run.`
				);
			} else {
				await api.ensureCustomDomain(control.name, options.domain, zoneId);
			}
		}

		return resources;
	});
}

// The registrable zone for a hostname is the apex (last two labels), which is
// what `zones.list` matches on.
function zoneOf(hostname: string): string {
	return hostname.split('.').slice(-2).join('.');
}

/**
 * Whether the bindings a deployed script answers match what this deploy would
 * upload. The live list keeps its secrets across uploads, so `secret_text`
 * entries are not part of the comparison; any other difference (an extra
 * field the API reports included) reads as a mismatch, which costs at most a
 * redundant upload.
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
	// absolute order does not matter — only that it is a consistent total order.
	return bindings
		.map((binding) => canonicalJson(binding))
		.toSorted((a, b) => a.localeCompare(b));
}

function isSecretBinding(binding: unknown): boolean {
	return (
		typeof binding === 'object' &&
		binding !== null &&
		'type' in binding &&
		binding.type === 'secret_text'
	);
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
 * Provision, migrate, upload, and wire up a cupboard deployment. The tenant
 * Durable Object script is uploaded before the control plane that binds it
 * cross-script. With `--dry-run` it renders the plan and stops before any
 * mutation.
 */
export async function runDeploy(deps: DeployDeps): Promise<ResultRow[]> {
	const { artifact, api, reporter, options } = deps;

	const resources = await reconcileResources(
		deps,
		collectResources(artifact.config)
	);

	const databaseId = resources.d1.get(
		artifact.config.tenant.d1Databases[0]?.databaseName ?? ''
	);

	if (databaseId !== undefined) {
		const applied = await applyD1Migrations(
			{
				query: (database, sql) => api.d1Query(database, sql),
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

	const tag = await api.getScriptMigrationTag(artifact.config.tenant.name);
	const migration = computeDurableObjectMigration(
		tag,
		artifact.config.tenant.migrations
	);
	const tenantMetadata = buildScriptMetadata(
		artifact.config.tenant,
		resources,
		migration
	);
	const controlMetadata = buildScriptMetadata(
		artifact.config.control,
		resources
	);

	const unchanged = await reporter.phase(
		'Checking the deployed Workers',
		async (context) => {
			context.fact('build', artifact.buildVersion);

			// A dirty build's version cannot distinguish two different working
			// trees, so only a clean build that is already live can converge.
			if (
				options.liveBuild !== artifact.buildVersion ||
				artifact.buildVersion.endsWith('+dirty')
			) {
				context.fact('live', options.liveBuild ?? 'unreachable');

				return { tenant: false, control: false };
			}

			const [tenantLive, controlLive] = await Promise.all([
				api.getScriptBindings(artifact.config.tenant.name),
				api.getScriptBindings(artifact.config.control.name)
			]);

			return {
				tenant:
					migration === undefined &&
					hasMatchingBindings(tenantMetadata.bindings, tenantLive),
				control: hasMatchingBindings(controlMetadata.bindings, controlLive)
			};
		}
	);

	if (unchanged.tenant) {
		reporter.step(
			`${artifact.config.tenant.name} already runs this build and configuration; upload skipped.`
		);
	} else {
		await reporter.phase('Uploading tenant worker', (context) =>
			uploadScriptForPlan(
				deps,
				context,
				artifact.config.tenant.name,
				tenantMetadata,
				artifact.tenantBundle
			)
		);
	}

	if (unchanged.control) {
		reporter.step(
			`${artifact.config.control.name} already runs this build and configuration; upload skipped.`
		);
	} else {
		await reporter.phase('Uploading control worker', (context) =>
			uploadScriptForPlan(
				deps,
				context,
				artifact.config.control.name,
				controlMetadata,
				artifact.controlBundle
			)
		);
	}

	const secretWork: { scriptName: string; secret: WorkerSecret }[] = [
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

	await configureTriggers(deps, resources);

	const rows: ResultRow[] = [
		{ label: 'Control worker', value: artifact.config.control.name },
		{ label: 'Tenant worker', value: artifact.config.tenant.name },
		...(options.domain === undefined
			? []
			: [{ label: 'Cache URL', value: `https://${options.domain}` }])
	];

	reporter.result({
		kind: 'deployment',
		data: {
			controlWorker: artifact.config.control.name,
			tenantWorker: artifact.config.tenant.name,
			cacheUrl:
				options.domain === undefined ? undefined : `https://${options.domain}`
		},
		rows
	});

	return rows;
}
