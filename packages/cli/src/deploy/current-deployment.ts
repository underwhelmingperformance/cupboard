import { z } from 'zod';

import type { CloudflareApi } from './cloudflare-api.ts';
import type {
	DeploymentConfig,
	EditableResourceKind,
	WorkerConfig
} from './config.ts';
import {
	type DatabaseId,
	databaseIdSchema,
	type KvNamespaceId,
	kvNamespaceIdSchema
} from './identifiers.ts';
import { renameResources, withCrons, withKvTitles } from './overrides.ts';
import { configuredOwner, type OwnerBinding } from './owner.ts';

/**
 * The Cloudflare reads that establish what an existing deployment uses.
 */
export type CurrentDeploymentApi = Pick<
	CloudflareApi,
	| 'getScriptConfiguration'
	| 'listSchedules'
	| 'd1DatabaseName'
	| 'kvNamespaceTitle'
	| 'findQueueConsumer'
	| 'findD1Database'
	| 'd1QueryRows'
>;

/**
 * What the deployment on an account already runs with, as the starting point
 * for a deploy's plan.
 */
export interface CurrentDeployment {
	/**
	 * The build's configuration with the resource names and cron triggers the
	 * deployed Workers use in place of the build's defaults. It equals the
	 * build's configuration when nothing is deployed yet.
	 */
	readonly config: DeploymentConfig;
	/**
	 * The signup gate the deployed control Worker holds, when it names one.
	 */
	readonly signupGate: OwnerBinding | undefined;
	/**
	 * The operator the deployment's database records, when one has claimed it.
	 */
	readonly operator: OwnerBinding | undefined;
}

const r2Binding = z.looseObject({
	type: z.literal('r2_bucket'),
	name: z.string(),
	bucket_name: z.string()
});

// The settings endpoint has reported a D1 binding's database as `id` and,
// more recently, as `database_id`.
const d1Binding = z.looseObject({
	type: z.literal('d1'),
	name: z.string(),
	database_id: z.string().optional(),
	id: z.string().optional()
});

const kvBinding = z.looseObject({
	type: z.literal('kv_namespace'),
	name: z.string(),
	namespace_id: z.string()
});

const queueBinding = z.looseObject({
	type: z.literal('queue'),
	name: z.string(),
	queue_name: z.string()
});

const plainTextBinding = z.looseObject({
	type: z.literal('plain_text'),
	name: z.string(),
	text: z.string()
});

const liveBinding = z.union([
	r2Binding,
	d1Binding,
	kvBinding,
	queueBinding,
	plainTextBinding
]);

/**
 * A deployed Worker's resource bindings and plain-text variables, keyed by
 * binding name.
 */
interface LiveBindings {
	readonly buckets: Map<string, string>;
	readonly databases: Map<string, DatabaseId>;
	readonly namespaces: Map<string, KvNamespaceId>;
	readonly queues: Map<string, string>;
	readonly variables: Record<string, string>;
}

function emptyBindings(): LiveBindings {
	return {
		buckets: new Map(),
		databases: new Map(),
		namespaces: new Map(),
		queues: new Map(),
		variables: {}
	};
}

type LiveBinding = z.infer<typeof liveBinding>;

function recordBinding(live: LiveBindings, binding: LiveBinding): void {
	switch (binding.type) {
		case 'r2_bucket': {
			live.buckets.set(binding.name, binding.bucket_name);
			return;
		}

		case 'd1': {
			const id = databaseIdSchema.safeParse(binding.database_id ?? binding.id);

			if (id.success) {
				live.databases.set(binding.name, id.data);
			}

			return;
		}

		case 'kv_namespace': {
			const id = kvNamespaceIdSchema.safeParse(binding.namespace_id);

			if (id.success) {
				live.namespaces.set(binding.name, id.data);
			}

			return;
		}

		case 'queue': {
			live.queues.set(binding.name, binding.queue_name);
			return;
		}

		case 'plain_text': {
			live.variables[binding.name] = binding.text;
			return;
		}
	}
}

/**
 * Reads the bindings this deploy manages out of a script's live settings.
 * Bindings of other types, and any this parser does not recognise, are left
 * out.
 */
export function parseLiveBindings(bindings: readonly unknown[]): LiveBindings {
	const live = emptyBindings();

	for (const candidate of bindings) {
		const parsed = liveBinding.safeParse(candidate);

		if (parsed.success) {
			recordBinding(live, parsed.data);
		}
	}

	return live;
}

type Renames = Record<EditableResourceKind, Map<string, string>>;

// The first deployed name seen for a resource wins, so two Workers that
// disagree cannot rename a resource twice.
function noteRename(
	renames: Map<string, string>,
	from: string,
	to: string | undefined
): void {
	if (to === undefined || to === from || renames.has(from)) {
		return;
	}

	renames.set(from, to);
}

async function collectRenames(
	api: CurrentDeploymentApi,
	workers: readonly (readonly [WorkerConfig, LiveBindings])[]
): Promise<{
	readonly renames: Renames;
	readonly kvTitles: ReadonlyMap<string, string>;
}> {
	const renames: Renames = {
		bucket: new Map(),
		database: new Map(),
		queue: new Map()
	};
	const kvTitles = new Map<string, string>();

	for (const [worker, live] of workers) {
		for (const bucket of worker.r2Buckets) {
			noteRename(
				renames.bucket,
				bucket.bucketName,
				live.buckets.get(bucket.binding)
			);
		}

		for (const producer of worker.queueProducers) {
			noteRename(
				renames.queue,
				producer.queue,
				live.queues.get(producer.binding)
			);
		}

		for (const database of worker.d1Databases) {
			const id = live.databases.get(database.binding);

			if (id === undefined || renames.database.has(database.databaseName)) {
				continue;
			}

			noteRename(
				renames.database,
				database.databaseName,
				await api.d1DatabaseName(id)
			);
		}

		for (const namespace of worker.kvNamespaces) {
			const id = live.namespaces.get(namespace.binding);

			if (id === undefined || kvTitles.has(namespace.binding)) {
				continue;
			}

			const title = await api.kvNamespaceTitle(id);

			if (title !== undefined) {
				kvTitles.set(namespace.binding, title);
			}
		}
	}

	return { renames, kvTitles };
}

function applyRenames(
	config: DeploymentConfig,
	renames: Renames,
	kvTitles: ReadonlyMap<string, string>
): DeploymentConfig {
	let renamed = config;

	for (const kind of ['bucket', 'database', 'queue'] as const) {
		renamed = renameResources(renamed, kind, renames[kind]);
	}

	return withKvTitles(renamed, kvTitles);
}

/**
 * Dead-letter queues are consumer settings, not bindings, so they are read
 * from the control Worker's consumers after the consumed queues are known.
 */
async function adoptDeadLetterQueues(
	api: CurrentDeploymentApi,
	config: DeploymentConfig
): Promise<DeploymentConfig> {
	const renames = new Map<string, string>();

	for (const consumer of config.control.queueConsumers) {
		if (consumer.deadLetterQueue === undefined) {
			continue;
		}

		const live = await api.findQueueConsumer(
			consumer.queue,
			config.control.name
		);

		noteRename(renames, consumer.deadLetterQueue, live?.deadLetterQueue);
	}

	return renameResources(config, 'queue', renames);
}

// `d1QueryRows` returns one string per row, so the row is read as one JSON
// object.
const operatorQuery =
	"SELECT json_object('issuer', issuer, 'subject', subject, 'audience', audience) FROM global_admin WHERE id = 'singleton';";

// The table is created by a D1 migration, so a database that has not yet run
// it has no table to query.
const operatorTableQuery =
	"SELECT tbl_name FROM sqlite_master WHERE type = 'table' AND tbl_name = 'global_admin';";

const operatorRowSchema = z.object({
	issuer: z.string(),
	subject: z.string(),
	audience: z.string()
});

/**
 * The operator the deployment's database records, or `undefined` when the
 * database does not exist yet or nobody has claimed the deployment.
 */
export async function readOperator(
	api: Pick<CloudflareApi, 'findD1Database' | 'd1QueryRows'>,
	databaseName: string
): Promise<OwnerBinding | undefined> {
	const databaseId = await api.findD1Database(databaseName);

	if (databaseId === undefined) {
		return undefined;
	}

	const tables = await api.d1QueryRows(databaseId, operatorTableQuery);

	if (tables.length === 0) {
		return undefined;
	}

	const [row] = await api.d1QueryRows(databaseId, operatorQuery);

	if (row === undefined) {
		return undefined;
	}

	return operatorRowSchema.parse(JSON.parse(row));
}

/**
 * Reads what the deployment on this account already uses: the resources its
 * Workers are bound to, the control Worker's cron triggers and signup gate,
 * and its operator. A deploy that starts its plan from these keeps the same
 * resources and settings unless they are changed deliberately.
 */
export async function readCurrentDeployment(
	api: CurrentDeploymentApi,
	config: DeploymentConfig
): Promise<CurrentDeployment> {
	const [controlLive, tenantLive, liveCrons] = await Promise.all([
		api.getScriptConfiguration(config.control.name),
		api.getScriptConfiguration(config.tenant.name),
		api.listSchedules(config.control.name)
	]);
	const control =
		controlLive === undefined
			? emptyBindings()
			: parseLiveBindings(controlLive.bindings);
	const tenant =
		tenantLive === undefined
			? emptyBindings()
			: parseLiveBindings(tenantLive.bindings);

	const { renames, kvTitles } = await collectRenames(api, [
		[config.tenant, tenant],
		[config.control, control]
	]);
	const renamed = await adoptDeadLetterQueues(
		api,
		applyRenames(config, renames, kvTitles)
	);
	const adopted =
		liveCrons === undefined ? renamed : withCrons(renamed, liveCrons);
	const databaseName = adopted.tenant.d1Databases[0]?.databaseName;

	return {
		config: adopted,
		signupGate: configuredOwner(control.variables),
		operator:
			databaseName === undefined
				? undefined
				: await readOperator(api, databaseName)
	};
}
