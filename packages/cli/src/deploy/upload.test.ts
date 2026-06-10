import { describe, expect, it } from 'vitest';

import type { WorkerConfig } from './config.ts';
import {
	buildScriptMetadata,
	MissingResourceError,
	type ResolvedResources
} from './upload.ts';

const controlConfig: WorkerConfig = {
	name: 'cupboard',
	mainModule: 'worker.js',
	compatibilityDate: '2026-05-15',
	compatibilityFlags: ['nodejs_compat'],
	cpuMs: 300_000,
	observability: true,
	vars: { CUPBOARD_AUTH_ISSUER: 'cupboard' },
	durableObjects: [
		{
			binding: 'CUPBOARD_DO',
			className: 'CupboardServer',
			scriptName: 'cupboard-tenant'
		}
	],
	r2Buckets: [{ binding: 'BLOBS', bucketName: 'cupboard-blobs' }],
	kvNamespaces: [{ binding: 'TENANT_CACHE', title: 'cupboard-tenant-cache' }],
	d1Databases: [{ binding: 'CUPBOARD_DB', databaseName: 'cupboard' }],
	queueProducers: [
		{ binding: 'MAINTENANCE_QUEUE', queue: 'cupboard-maintenance' }
	],
	queueConsumers: [],
	crons: ['0 * * * *'],
	migrations: []
};

const resources: ResolvedResources = {
	d1: new Map([['cupboard', 'db-id-1']]),
	kv: new Map([['cupboard-tenant-cache', 'kv-id-1']])
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
			observability: { enabled: true },
			keep_bindings: ['secret_text'],
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
				{ type: 'plain_text', name: 'CUPBOARD_AUTH_ISSUER', text: 'cupboard' }
			]
		});
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
		expect(() =>
			buildScriptMetadata(controlConfig, { d1: new Map(), kv: resources.kv })
		).toThrow(MissingResourceError);
	});
});
