import { describe, expect, it } from 'vitest';

import { parseDeploymentConfig } from './config.ts';

const controlSource = `{
	// the control-plane Worker
	"name": "cupboard",
	"main": "src/worker.ts",
	"compatibility_date": "2026-05-15",
	"compatibility_flags": ["nodejs_compat"],
	"durable_objects": {
		"bindings": [
			{ "name": "CUPBOARD_DO", "class_name": "CupboardServer", "script_name": "cupboard-tenant" }
		]
	},
	"r2_buckets": [{ "binding": "BLOBS", "bucket_name": "cupboard-blobs" }],
	"kv_namespaces": [{ "binding": "TENANT_CACHE", "id": "0000" }],
	"d1_databases": [{ "binding": "CUPBOARD_DB", "database_name": "cupboard" }],
	"queues": {
		"producers": [{ "binding": "MAINTENANCE_QUEUE", "queue": "cupboard-maintenance" }],
		"consumers": [
			{ "queue": "cupboard-maintenance", "max_batch_size": 10, "dead_letter_queue": "cupboard-maintenance-dlq" }
		]
	},
	"vars": { "CUPBOARD_AUTH_ISSUER": "cupboard" },
	"limits": { "cpu_ms": 300000 },
	"observability": { "enabled": true },
	"triggers": { "crons": ["0 * * * *"] }
}`;

const tenantSource = `{
	"name": "cupboard-tenant",
	"compatibility_date": "2026-05-15",
	"compatibility_flags": ["nodejs_compat"],
	"durable_objects": { "bindings": [{ "name": "CUPBOARD_DO", "class_name": "CupboardServer" }] },
	"r2_buckets": [{ "binding": "BLOBS", "bucket_name": "cupboard-blobs" }],
	"d1_databases": [{ "binding": "CUPBOARD_DB", "database_name": "cupboard" }],
	"vars": {},
	"observability": { "enabled": true },
	"migrations": [{ "tag": "v1", "new_sqlite_classes": ["CupboardServer"] }]
}`;

describe('parseDeploymentConfig', () => {
	it('parses both workers, deriving KV titles and normalising bindings', () => {
		expect(parseDeploymentConfig(controlSource, tenantSource)).toStrictEqual({
			control: {
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
				kvNamespaces: [
					{ binding: 'TENANT_CACHE', title: 'cupboard-tenant-cache' }
				],
				d1Databases: [{ binding: 'CUPBOARD_DB', databaseName: 'cupboard' }],
				queueProducers: [
					{ binding: 'MAINTENANCE_QUEUE', queue: 'cupboard-maintenance' }
				],
				queueConsumers: [
					{
						queue: 'cupboard-maintenance',
						maxBatchSize: 10,
						maxBatchTimeout: undefined,
						maxRetries: undefined,
						maxConcurrency: undefined,
						deadLetterQueue: 'cupboard-maintenance-dlq'
					}
				],
				crons: ['0 * * * *'],
				migrations: []
			},
			tenant: {
				name: 'cupboard-tenant',
				mainModule: 'tenant-worker.js',
				compatibilityDate: '2026-05-15',
				compatibilityFlags: ['nodejs_compat'],
				cpuMs: undefined,
				observability: true,
				vars: {},
				durableObjects: [
					{
						binding: 'CUPBOARD_DO',
						className: 'CupboardServer',
						scriptName: undefined
					}
				],
				r2Buckets: [{ binding: 'BLOBS', bucketName: 'cupboard-blobs' }],
				kvNamespaces: [],
				d1Databases: [{ binding: 'CUPBOARD_DB', databaseName: 'cupboard' }],
				queueProducers: [],
				queueConsumers: [],
				crons: [],
				migrations: [{ tag: 'v1', newSqliteClasses: ['CupboardServer'] }]
			}
		});
	});
});

function withControl(patch: (config: string) => string): () => void {
	return () => parseDeploymentConfig(patch(controlSource), tenantSource);
}

describe('wrangler config validation', () => {
	it.each([
		[
			'an uppercase worker name',
			'"name": "cupboard"',
			'"name": "Cupboard"',
			'name: worker name must be lowercase'
		],
		[
			'a bucket name with a trailing hyphen',
			'"bucket_name": "cupboard-blobs"',
			'"bucket_name": "cupboard-blobs-"',
			'bucket_name: R2 bucket name must be lowercase'
		],
		[
			'a queue name with invalid characters',
			'"queue": "cupboard-maintenance" }',
			'"queue": "cupboard_maintenance" }',
			'queue: queue name must be lowercase'
		],
		[
			'a four-field cron trigger',
			'"crons": ["0 * * * *"]',
			'"crons": ["0 * * *"]',
			'cron trigger must have five fields'
		],
		[
			'a cron trigger with stray characters',
			'"crons": ["0 * * * *"]',
			'"crons": ["0 * * * *; rm"]',
			'cron trigger must have five fields'
		],
		[
			'a compatibility date that is not a date',
			'"compatibility_date": "2026-05-15"',
			'"compatibility_date": "next-tuesday"',
			'compatibility_date must be YYYY-MM-DD'
		]
	])('rejects %s', (_name, needle, replacement, message) => {
		expect(
			withControl((config) => config.replace(needle, replacement))
		).toThrow(message);
	});

	it('accepts cron vocabulary like ranges, steps and day names', () => {
		const config = controlSource.replace(
			'"crons": ["0 * * * *"]',
			'"crons": ["*/15 0-6 1 JAN MON-FRI"]'
		);

		expect(() => parseDeploymentConfig(config, tenantSource)).not.toThrow();
	});
});
