import JSON5 from 'json5';
import { z } from 'zod';

import {
	kvNamespaceIdSchema,
	type ScriptName,
	scriptNameSchema
} from './identifiers.ts';
import { controlWorker, tenantWorker } from './source.ts';

/**
 * A Durable Object binding. `scriptName` is set only for the cross-script
 * binding on the control Worker, which reaches the `CupboardServer` class
 * defined in the tenant script.
 */
export interface DurableObjectBinding {
	readonly binding: string;
	readonly className: string;
	readonly scriptName: ScriptName | undefined;
}

export interface R2Binding {
	readonly binding: string;
	readonly bucketName: string;
}

/**
 * A KV namespace binding. `title` is the account-level name this command
 * reconciles by, derived from the binding (the wrangler config only carries a
 * placeholder id).
 */
export interface KvBinding {
	readonly binding: string;
	readonly title: string;
}

export interface D1Binding {
	readonly binding: string;
	readonly databaseName: string;
}

export interface QueueProducerBinding {
	readonly binding: string;
	readonly queue: string;
}

export interface QueueConsumerConfig {
	readonly queue: string;
	readonly maxBatchSize: number | undefined;
	readonly maxBatchTimeout: number | undefined;
	readonly maxRetries: number | undefined;
	readonly maxConcurrency: number | undefined;
	readonly deadLetterQueue: string | undefined;
}

export interface DurableObjectMigration {
	readonly tag: string;
	readonly newSqliteClasses: readonly string[];
}

export interface WorkerConfig {
	readonly name: ScriptName;
	readonly mainModule: string;
	readonly compatibilityDate: string;
	readonly compatibilityFlags: readonly string[];
	readonly cpuMs: number | undefined;
	readonly observability: boolean;
	readonly tracing: boolean;
	readonly vars: Readonly<Record<string, string>>;
	readonly durableObjects: readonly DurableObjectBinding[];
	readonly r2Buckets: readonly R2Binding[];
	readonly kvNamespaces: readonly KvBinding[];
	readonly d1Databases: readonly D1Binding[];
	readonly queueProducers: readonly QueueProducerBinding[];
	readonly queueConsumers: readonly QueueConsumerConfig[];
	readonly crons: readonly string[];
	readonly migrations: readonly DurableObjectMigration[];
}

export interface DeploymentConfig {
	readonly control: WorkerConfig;
	readonly tenant: WorkerConfig;
}

// Account-level resource names (Workers, buckets, queues, databases) share
// Cloudflare's shape: lowercase letters, digits and inner hyphens.
function resourceName(what: string, maximumLength: number): z.ZodString {
	return z
		.string()
		.regex(
			/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
			`${what} must be lowercase letters, digits and hyphens (not at the ends)`
		)
		.max(
			maximumLength,
			`${what} must be at most ${String(maximumLength)} characters`
		);
}

const workerName = resourceName('worker name', 63);
const bucketName = resourceName('R2 bucket name', 63).min(
	3,
	'R2 bucket name must be at least 3 characters'
);
const databaseName = resourceName('D1 database name', 63);
const queueName = resourceName('queue name', 63);

/**
What a deploy-time edit can rename; KV titles are derived, not edited.
*/
export type EditableResourceKind = 'bucket' | 'database' | 'queue';

const editableSchemas: Record<EditableResourceKind, () => z.ZodString> = {
	bucket: () => bucketName,
	database: () => databaseName,
	queue: () => queueName
};

/**
 * Why `value` cannot name a resource of `kind`, or undefined when it can.
 * Reuses the wrangler-config schema rules, so interactive edits are held to
 * exactly the bar the checked-in config is.
 */
export function resourceNameProblem(
	kind: EditableResourceKind,
	value: string
): string | undefined {
	const parsed = editableSchemas[kind]().safeParse(value);

	return parsed.success ? undefined : parsed.error.issues[0]?.message;
}

/**
Why `value` cannot be a cron trigger, or undefined when it can.
*/
export function cronProblem(value: string): string | undefined {
	const parsed = cronExpression.safeParse(value);

	return parsed.success ? undefined : parsed.error.issues[0]?.message;
}

// Five whitespace-separated fields of cron vocabulary. Cloudflare evaluates
// the expression itself at deploy time; this catches structural mistakes
// (missing fields, stray characters) before anything is provisioned.
const cronExpression = z.string().refine((value) => {
	const fields = value.trim().split(/\s+/);

	return (
		fields.length === 5 &&
		fields.every((field) => /^[A-Za-z0-9*,/-]+$/.test(field))
	);
}, 'cron trigger must have five fields: minute hour day month weekday');

const durableObjectBinding = z.object({
	name: z.string(),
	class_name: z.string(),
	script_name: z.string().optional()
});

const r2BucketBinding = z.object({
	binding: z.string(),
	bucket_name: bucketName
});

const kvNamespaceBinding = z.object({
	binding: z.string(),
	id: kvNamespaceIdSchema
});

const d1DatabaseBinding = z.object({
	binding: z.string(),
	database_name: databaseName
});

const queueProducer = z.object({ binding: z.string(), queue: queueName });

const queueConsumer = z.object({
	queue: queueName,
	max_batch_size: z.number().optional(),
	max_batch_timeout: z.number().optional(),
	max_retries: z.number().optional(),
	max_concurrency: z.number().optional(),
	dead_letter_queue: queueName.optional()
});

const migration = z.object({
	tag: z.string(),
	new_sqlite_classes: z.array(z.string()).default([])
});

const observability = z.object({
	enabled: z.boolean(),
	traces: z.object({ enabled: z.boolean() }).partial().optional()
});

const rawWranglerSchema = z.object({
	name: workerName,
	compatibility_date: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/, 'compatibility_date must be YYYY-MM-DD'),
	compatibility_flags: z.array(z.string()).default([]),
	vars: z.record(z.string(), z.string()).default({}),
	limits: z.object({ cpu_ms: z.number() }).partial().optional(),
	observability: observability.optional(),
	durable_objects: z
		.object({ bindings: z.array(durableObjectBinding) })
		.optional(),
	r2_buckets: z.array(r2BucketBinding).default([]),
	kv_namespaces: z.array(kvNamespaceBinding).default([]),
	d1_databases: z.array(d1DatabaseBinding).default([]),
	queues: z
		.object({
			producers: z.array(queueProducer).default([]),
			consumers: z.array(queueConsumer).default([])
		})
		.optional(),
	triggers: z.object({ crons: z.array(cronExpression).default([]) }).optional(),
	migrations: z.array(migration).default([])
});

type RawWrangler = z.infer<typeof rawWranglerSchema>;

export type WranglerConfigIssue = z.core.$ZodIssue;

export class WranglerConfigError extends Error {
	constructor(
		public readonly label: string,
		public readonly issues: readonly WranglerConfigIssue[]
	) {
		const detail = issues
			.map(
				(issue) => `${issue.path.join('.')}: ${issue.code}: ${issue.message}`
			)
			.join('; ');

		super(`Invalid ${label} wrangler config: ${detail}`);
		this.name = 'WranglerConfigError';
	}
}

// KV namespaces are referenced in the wrangler config by binding plus a
// placeholder id; the reconcile name is derived so it is stable and
// account-unique: `TENANT_CACHE` -> `cupboard-tenant-cache`.
function kvTitle(binding: string): string {
	return `cupboard-${binding.toLowerCase().replaceAll('_', '-')}`;
}

function toWorkerConfig(raw: RawWrangler, mainModule: string): WorkerConfig {
	return {
		name: scriptNameSchema.parse(raw.name),
		mainModule,
		compatibilityDate: raw.compatibility_date,
		compatibilityFlags: raw.compatibility_flags,
		cpuMs: raw.limits?.cpu_ms,
		observability: raw.observability?.enabled ?? false,
		tracing: raw.observability?.traces?.enabled ?? false,
		vars: raw.vars,
		durableObjects: (raw.durable_objects?.bindings ?? []).map((binding) => ({
			binding: binding.name,
			className: binding.class_name,
			scriptName:
				binding.script_name === undefined
					? undefined
					: scriptNameSchema.parse(binding.script_name)
		})),
		r2Buckets: raw.r2_buckets.map((bucket) => ({
			binding: bucket.binding,
			bucketName: bucket.bucket_name
		})),
		kvNamespaces: raw.kv_namespaces.map((namespace) => ({
			binding: namespace.binding,
			title: kvTitle(namespace.binding)
		})),
		d1Databases: raw.d1_databases.map((database) => ({
			binding: database.binding,
			databaseName: database.database_name
		})),
		queueProducers: raw.queues?.producers ?? [],
		queueConsumers: (raw.queues?.consumers ?? []).map((consumer) => ({
			queue: consumer.queue,
			maxBatchSize: consumer.max_batch_size,
			maxBatchTimeout: consumer.max_batch_timeout,
			maxRetries: consumer.max_retries,
			maxConcurrency: consumer.max_concurrency,
			deadLetterQueue: consumer.dead_letter_queue
		})),
		crons: raw.triggers?.crons ?? [],
		migrations: raw.migrations.map((migration) => ({
			tag: migration.tag,
			newSqliteClasses: migration.new_sqlite_classes
		}))
	};
}

function parseWorker(
	label: string,
	source: string,
	mainModule: string
): WorkerConfig {
	const parsed = rawWranglerSchema.safeParse(JSON5.parse(source));

	if (!parsed.success) {
		throw new WranglerConfigError(label, parsed.error.issues);
	}

	return toWorkerConfig(parsed.data, mainModule);
}

/**
 * Parse the control and tenant `wrangler.jsonc` contents into the typed
 * configuration the deploy pipeline reconciles against. Takes the file contents
 * (not paths) so it is testable and usable from the build-time embed step.
 */
export function parseDeploymentConfig(
	controlSource: string,
	tenantSource: string
): DeploymentConfig {
	return {
		control: parseWorker('control', controlSource, controlWorker.mainModule),
		tenant: parseWorker('tenant', tenantSource, tenantWorker.mainModule)
	};
}
