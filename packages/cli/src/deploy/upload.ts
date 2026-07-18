import type { ScriptUpdateParams } from 'cloudflare/resources/workers/scripts/scripts';
import type { SingleStepMigrationParam } from 'cloudflare/resources/workers/workers';

import type { WorkerConfig } from './config.ts';

type Metadata = ScriptUpdateParams.Metadata;
type Binding = NonNullable<Metadata['bindings']>[number];

/**
 * Live resource identifiers resolved by name during reconciliation. R2 buckets
 * and queues are bound by name, so only D1 and KV need an id lookup.
 */
export interface ResolvedResources {
	readonly d1: ReadonlyMap<string, string>;
	readonly kv: ReadonlyMap<string, string>;
}

export class MissingResourceError extends Error {
	constructor(
		public readonly kind: string,
		public readonly resourceName: string
	) {
		super(`No resolved ${kind} for "${resourceName}"`);
		this.name = 'MissingResourceError';
	}
}

function bindingsFor(
	worker: WorkerConfig,
	resources: ResolvedResources
): Binding[] {
	const bindings: Binding[] = Array.from(
		worker.durableObjects,
		(durableObject) => ({
			type: 'durable_object_namespace',
			name: durableObject.binding,
			class_name: durableObject.className,
			...(durableObject.scriptName !== undefined && {
				script_name: durableObject.scriptName
			})
		})
	);

	for (const bucket of worker.r2Buckets) {
		bindings.push({
			type: 'r2_bucket',
			name: bucket.binding,
			bucket_name: bucket.bucketName
		});
	}

	for (const namespace of worker.kvNamespaces) {
		const namespaceId = resources.kv.get(namespace.title);

		if (namespaceId === undefined) {
			throw new MissingResourceError('KV namespace', namespace.title);
		}

		bindings.push({
			type: 'kv_namespace',
			name: namespace.binding,
			namespace_id: namespaceId
		});
	}

	for (const database of worker.d1Databases) {
		const databaseId = resources.d1.get(database.databaseName);

		if (databaseId === undefined) {
			throw new MissingResourceError('D1 database', database.databaseName);
		}

		bindings.push({
			type: 'd1',
			name: database.binding,
			database_id: databaseId
		});
	}

	for (const producer of worker.queueProducers) {
		bindings.push({
			type: 'queue',
			name: producer.binding,
			queue_name: producer.queue
		});
	}

	for (const [name, text] of Object.entries(worker.vars)) {
		bindings.push({ type: 'plain_text', name, text });
	}

	return bindings;
}

/**
 * Build the multipart upload metadata for a Worker from its config, the resolved
 * resource ids, and the Durable Object migration to apply (if any). `vars`
 * become `plain_text` bindings; `keep_bindings` preserves secrets and
 * variables set out of band across content uploads, the deploy-side half of
 * the worker configurations' `keep_vars` (a binding this metadata names
 * still deploys from here).
 */
export function buildScriptMetadata(
	worker: WorkerConfig,
	resources: ResolvedResources,
	migration?: SingleStepMigrationParam
): Metadata {
	return {
		main_module: worker.mainModule,
		compatibility_date: worker.compatibilityDate,
		compatibility_flags: [...worker.compatibilityFlags],
		observability: {
			enabled: worker.observability,
			...(worker.tracing && { traces: { enabled: true } })
		},
		keep_bindings: ['secret_text', 'plain_text'],
		bindings: bindingsFor(worker, resources),
		...(worker.cpuMs !== undefined && { limits: { cpu_ms: worker.cpuMs } }),
		...(migration !== undefined && { migrations: migration })
	};
}
