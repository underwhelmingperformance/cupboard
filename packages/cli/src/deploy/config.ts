import JSON5 from 'json5';
import { z } from 'zod';

import { controlWorker, tenantWorker } from './source.ts';

/**
 * A Durable Object binding. `scriptName` is set only for the cross-script
 * binding on the control Worker, which reaches the `CupboardServer` class
 * defined in the tenant script.
 */
export interface DurableObjectBinding {
	readonly binding: string;
	readonly className: string;
	readonly scriptName: string | undefined;
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
	readonly name: string;
	readonly mainModule: string;
	readonly compatibilityDate: string;
	readonly compatibilityFlags: readonly string[];
	readonly cpuMs: number | undefined;
	readonly observability: boolean;
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

const rawWranglerSchema = z.object({
	name: z.string(),
	compatibility_date: z.string(),
	compatibility_flags: z.array(z.string()).default([]),
	vars: z.record(z.string(), z.string()).default({}),
	limits: z.object({ cpu_ms: z.number() }).partial().optional(),
	observability: z.object({ enabled: z.boolean() }).optional(),
	durable_objects: z
		.object({
			bindings: z.array(
				z.object({
					name: z.string(),
					class_name: z.string(),
					script_name: z.string().optional()
				})
			)
		})
		.optional(),
	r2_buckets: z
		.array(z.object({ binding: z.string(), bucket_name: z.string() }))
		.default([]),
	kv_namespaces: z
		.array(z.object({ binding: z.string(), id: z.string() }))
		.default([]),
	d1_databases: z
		.array(z.object({ binding: z.string(), database_name: z.string() }))
		.default([]),
	queues: z
		.object({
			producers: z
				.array(z.object({ binding: z.string(), queue: z.string() }))
				.default([]),
			consumers: z
				.array(
					z.object({
						queue: z.string(),
						max_batch_size: z.number().optional(),
						max_batch_timeout: z.number().optional(),
						max_retries: z.number().optional(),
						max_concurrency: z.number().optional(),
						dead_letter_queue: z.string().optional()
					})
				)
				.default([])
		})
		.optional(),
	triggers: z.object({ crons: z.array(z.string()).default([]) }).optional(),
	migrations: z
		.array(
			z.object({
				tag: z.string(),
				new_sqlite_classes: z.array(z.string()).default([])
			})
		)
		.default([])
});

type RawWrangler = z.infer<typeof rawWranglerSchema>;

export class WranglerConfigError extends Error {
	constructor(label: string, detail: string) {
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
		name: raw.name,
		mainModule,
		compatibilityDate: raw.compatibility_date,
		compatibilityFlags: raw.compatibility_flags,
		cpuMs: raw.limits?.cpu_ms,
		observability: raw.observability?.enabled ?? false,
		vars: raw.vars,
		durableObjects: (raw.durable_objects?.bindings ?? []).map((binding) => ({
			binding: binding.name,
			className: binding.class_name,
			scriptName: binding.script_name
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
		throw new WranglerConfigError(label, parsed.error.message);
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
