import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { parseDeploymentConfig, WranglerConfigError } from './config.ts';

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
	"services": [{ "binding": "CUPBOARD_TENANT", "service": "cupboard-tenant", "entrypoint": "CachedTenantReads" }],
	"r2_buckets": [{ "binding": "BLOBS", "bucket_name": "cupboard-blobs" }],
	"kv_namespaces": [{ "binding": "TENANT_CACHE", "id": "0000" }],
	"d1_databases": [{ "binding": "CUPBOARD_DB", "database_name": "cupboard" }],
	"queues": {
		"producers": [{ "binding": "MAINTENANCE_QUEUE", "queue": "cupboard-maintenance" }],
		"consumers": [
			{ "queue": "cupboard-maintenance", "max_batch_size": 1, "dead_letter_queue": "cupboard-maintenance-dlq" }
		]
	},
	"vars": { "CUPBOARD_AUTH_ISSUER": "cupboard" },
	"limits": { "cpu_ms": 300000 },
	"observability": { "enabled": true, "traces": { "enabled": true } },
	"triggers": { "crons": ["0 * * * *"] }
}`;

const tenantSource = `{
	"name": "cupboard-tenant",
	"workers_dev": false,
	"preview_urls": false,
	"compatibility_date": "2026-05-15",
	"compatibility_flags": ["nodejs_compat"],
	"cache": { "enabled": true },
	"durable_objects": { "bindings": [{ "name": "CUPBOARD_DO", "class_name": "CupboardServer" }] },
	"r2_buckets": [{ "binding": "BLOBS", "bucket_name": "cupboard-blobs" }],
	"d1_databases": [{ "binding": "CUPBOARD_DB", "database_name": "cupboard" }],
	"vars": {},
	"observability": { "enabled": true },
	"exports": {
		"CupboardServer": { "type": "durable-object", "storage": "sqlite" },
		"VersionedR2ObjectRollbackGuard": { "type": "durable-object", "storage": "sqlite" }
	}
}`;

describe('parseDeploymentConfig', () => {
	it('limits production maintenance batches to one D1-budgeted operation', async () => {
		const productionControlSource = await readFile(
			new URL('../../../server/wrangler.jsonc', import.meta.url),
			'utf8'
		);
		const config = parseDeploymentConfig(productionControlSource, tenantSource);

		expect(config.control.queueConsumers).toStrictEqual([
			{
				queue: 'cupboard-maintenance',
				maxBatchSize: 1,
				maxBatchTimeout: 5,
				maxRetries: 3,
				maxConcurrency: 4,
				deadLetterQueue: 'cupboard-maintenance-dlq'
			}
		]);
	});

	it('parses both workers, deriving KV titles and normalising bindings', () => {
		expect(parseDeploymentConfig(controlSource, tenantSource)).toStrictEqual({
			control: {
				name: 'cupboard',
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
						maxBatchSize: 1,
						maxBatchTimeout: undefined,
						maxRetries: undefined,
						maxConcurrency: undefined,
						deadLetterQueue: 'cupboard-maintenance-dlq'
					}
				],
				services: [
					{
						binding: 'CUPBOARD_TENANT',
						service: 'cupboard-tenant',
						entrypoint: 'CachedTenantReads'
					}
				],
				cacheEnabled: false,
				workersDev: true,
				previewUrls: true,
				crons: ['0 * * * *'],
				exports: {}
			},
			tenant: {
				name: 'cupboard-tenant',
				mainModule: 'tenant-worker.js',
				compatibilityDate: '2026-05-15',
				compatibilityFlags: ['nodejs_compat'],
				cpuMs: undefined,
				observability: true,
				tracing: false,
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
				services: [],
				cacheEnabled: true,
				workersDev: false,
				previewUrls: false,
				crons: [],
				exports: {
					CupboardServer: { type: 'durable-object', storage: 'sqlite' },
					VersionedR2ObjectRollbackGuard: {
						type: 'durable-object',
						storage: 'sqlite'
					}
				}
			}
		});
	});
});

function withControl(patch: (config: string) => string): () => void {
	return () => parseDeploymentConfig(patch(controlSource), tenantSource);
}

function thrownBy(function_: () => void): unknown {
	let thrown: unknown;

	try {
		function_();
	} catch (error) {
		thrown = error;
	}

	return thrown;
}

describe('wrangler config validation', () => {
	it('rejects the legacy Durable Object migration flow', () => {
		const legacyTenant = tenantSource.replace(
			/"exports": \{[\s\S]*?\n\t\}/,
			'"migrations": [{ "tag": "v1", "new_sqlite_classes": ["CupboardServer"] }]'
		);
		const error = thrownBy(() =>
			parseDeploymentConfig(controlSource, legacyTenant)
		);

		expect(error).toBeInstanceOf(WranglerConfigError);

		if (error instanceof WranglerConfigError) {
			expect(error.issues).toStrictEqual([
				{
					code: 'custom',
					path: ['migrations'],
					message: 'use declarative exports for Durable Object class lifecycle'
				}
			]);
		}
	});

	it.each([
		[
			'created',
			'{ "type": "durable-object", "state": "created", "storage": "sqlite" }',
			{ type: 'durable-object', state: 'created', storage: 'sqlite' }
		],
		[
			'deleted',
			'{ "type": "durable-object", "state": "deleted" }',
			{ type: 'durable-object', state: 'deleted' }
		],
		[
			'renamed',
			'{ "type": "durable-object", "state": "renamed", "renamed_to": "Successor" }',
			{ type: 'durable-object', state: 'renamed', renamed_to: 'Successor' }
		],
		[
			'transferred',
			'{ "type": "durable-object", "state": "transferred", "transferred_to": "cupboard-successor" }',
			{
				type: 'durable-object',
				state: 'transferred',
				transferred_to: 'cupboard-successor'
			}
		],
		[
			'expecting-transfer',
			'{ "type": "durable-object", "state": "expecting-transfer", "storage": "sqlite", "transfer_from": "cupboard-predecessor" }',
			{
				type: 'durable-object',
				state: 'expecting-transfer',
				storage: 'sqlite',
				transfer_from: 'cupboard-predecessor'
			}
		]
	] as const)(
		'preserves a %s Durable Object lifecycle entry',
		(_state, entry, expected) => {
			const source = tenantSource.replace(
				'{ "type": "durable-object", "storage": "sqlite" }\n\t}',
				() => `${entry}\n\t}`
			);

			expect(
				parseDeploymentConfig(controlSource, source).tenant.exports
			).toStrictEqual({
				CupboardServer: { type: 'durable-object', storage: 'sqlite' },
				VersionedR2ObjectRollbackGuard: expected
			});
		}
	);

	it('rejects the legacy Durable Object migration flow', () => {
		const legacyTenant = tenantSource.replace(
			/"exports": \{[\s\S]*?\n\t\}/,
			'"migrations": [{ "tag": "v1", "new_sqlite_classes": ["CupboardServer"] }]'
		);
		const error = thrownBy(() =>
			parseDeploymentConfig(controlSource, legacyTenant)
		);

		expect(error).toBeInstanceOf(WranglerConfigError);

		if (error instanceof WranglerConfigError) {
			expect(error.issues).toStrictEqual([
				{
					code: 'custom',
					path: ['migrations'],
					message: 'use declarative exports for Durable Object class lifecycle'
				}
			]);
		}
	});

	it.each([
		['an uppercase worker name', '"name": "cupboard"', '"name": "Cupboard"'],
		[
			'a bucket name with a trailing hyphen',
			'"bucket_name": "cupboard-blobs"',
			'"bucket_name": "cupboard-blobs-"'
		],
		[
			'a queue name with invalid characters',
			'"queue": "cupboard-maintenance" }',
			'"queue": "cupboard_maintenance" }'
		],
		[
			'a four-field cron trigger',
			'"crons": ["0 * * * *"]',
			'"crons": ["0 * * *"]'
		],
		[
			'a cron trigger with stray characters',
			'"crons": ["0 * * * *"]',
			'"crons": ["0 * * * *; rm"]'
		],
		[
			'a compatibility date that is not a date',
			'"compatibility_date": "2026-05-15"',
			'"compatibility_date": "next-tuesday"'
		]
	])('rejects %s', (_name, needle, replacement) => {
		const error = thrownBy(
			withControl((config) => config.replace(needle, () => replacement))
		);

		expect(error).toBeInstanceOf(WranglerConfigError);

		if (error instanceof WranglerConfigError) {
			expect(error.label).toBe('control');
		}
	});

	it('accepts cron vocabulary like ranges, steps and day names', () => {
		const config = controlSource.replace(
			'"crons": ["0 * * * *"]',
			'"crons": ["*/15 0-6 1 JAN MON-FRI"]'
		);

		expect(
			parseDeploymentConfig(config, tenantSource).control.crons
		).toStrictEqual(['*/15 0-6 1 JAN MON-FRI']);
	});
});
