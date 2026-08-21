import { describe, expect, it } from 'vitest';

import type { WorkerConfig } from './config.ts';
import {
	databaseIdSchema,
	kvNamespaceIdSchema,
	scriptNameSchema
} from './identifiers.ts';
import {
	buildScriptMetadata,
	MissingResourceError,
	type ResolvedResources
} from './upload.ts';

function thrownBy(run: () => unknown): unknown {
	let thrown: unknown;

	try {
		run();
	} catch (error) {
		thrown = error;
	}

	return thrown;
}

const controlConfig: WorkerConfig = {
	name: scriptNameSchema.parse('cupboard'),
	mainModule: 'worker.js',
	compatibilityDate: '2026-05-15',
	compatibilityFlags: ['nodejs_compat'],
	cpuMs: 300_000,
	observability: true,
	tracing: true,
	vars: { CUPBOARD_AUTH_ISSUER: 'cupboard' },
	durableObjects: [
		{
			binding: 'CUPBOARD_DO',
			className: 'CupboardServer',
			scriptName: scriptNameSchema.parse('cupboard-tenant')
		}
	],
	r2Buckets: [{ binding: 'BLOBS', bucketName: 'cupboard-blobs' }],
	kvNamespaces: [{ binding: 'TENANT_CACHE', title: 'cupboard-tenant-cache' }],
	d1Databases: [{ binding: 'CUPBOARD_DB', databaseName: 'cupboard' }],
	queueProducers: [
		{ binding: 'MAINTENANCE_QUEUE', queue: 'cupboard-maintenance' }
	],
	queueConsumers: [],
	services: [
		{
			binding: 'CUPBOARD_TENANT',
			service: scriptNameSchema.parse('cupboard-tenant'),
			entrypoint: 'CachedTenantReads'
		}
	],
	cacheEnabled: true,
	workersDev: true,
	previewUrls: true,
	crons: ['0 * * * *'],
	migrations: []
};

const resources: ResolvedResources = {
	d1: new Map([['cupboard', databaseIdSchema.parse('db-id-1')]]),
	kv: new Map([['cupboard-tenant-cache', kvNamespaceIdSchema.parse('kv-id-1')]])
};

describe('buildScriptMetadata', () => {
	it('maps config, resolved ids, and the migration into upload metadata', () => {
		const metadata = buildScriptMetadata(controlConfig, resources, {
			new_tag: 'v1',
			new_sqlite_classes: ['CupboardServer']
		});

		expect(metadata).toStrictEqual({
			main_module: 'worker.js',
			compatibility_date: '2026-05-15',
			compatibility_flags: ['nodejs_compat'],
			observability: { enabled: true, traces: { enabled: true } },
			keep_bindings: ['secret_text', 'plain_text'],
			cache_options: { enabled: true, cross_version_cache: true },
			limits: { cpu_ms: 300_000 },
			migrations: { new_tag: 'v1', new_sqlite_classes: ['CupboardServer'] },
			bindings: [
				{
					type: 'durable_object_namespace',
					name: 'CUPBOARD_DO',
					class_name: 'CupboardServer',
					script_name: 'cupboard-tenant'
				},
				{ type: 'r2_bucket', name: 'BLOBS', bucket_name: 'cupboard-blobs' },
				{ type: 'kv_namespace', name: 'TENANT_CACHE', namespace_id: 'kv-id-1' },
				{ type: 'd1', name: 'CUPBOARD_DB', database_id: 'db-id-1' },
				{
					type: 'queue',
					name: 'MAINTENANCE_QUEUE',
					queue_name: 'cupboard-maintenance'
				},
				{
					type: 'service',
					name: 'CUPBOARD_TENANT',
					service: 'cupboard-tenant',
					entrypoint: 'CachedTenantReads'
				},
				{ type: 'plain_text', name: 'CUPBOARD_AUTH_ISSUER', text: 'cupboard' }
			]
		});
	});

	it('omits traces when tracing is disabled', () => {
		const metadata = buildScriptMetadata(
			{ ...controlConfig, tracing: false },
			resources
		);

		expect(metadata.observability).toStrictEqual({ enabled: true });
	});

	it('omits limits and migrations when absent', () => {
		const metadata = buildScriptMetadata(
			{ ...controlConfig, cpuMs: undefined },
			resources
		);

		expect(metadata.limits).toBeUndefined();
		expect(metadata.migrations).toBeUndefined();
	});

	it('throws when a resolved id is missing', () => {
		const thrown = thrownBy(() =>
			buildScriptMetadata(controlConfig, {
				d1: new Map(),
				kv: resources.kv
			})
		);

		expect(thrown).toBeInstanceOf(MissingResourceError);

		if (thrown instanceof MissingResourceError) {
			expect({
				name: thrown.name,
				kind: thrown.kind,
				resourceName: thrown.resourceName
			}).toStrictEqual({
				name: 'MissingResourceError',
				kind: 'D1 database',
				resourceName: 'cupboard'
			});
		}
	});
});
