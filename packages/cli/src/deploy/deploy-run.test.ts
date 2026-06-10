import type { Reporter } from '@cupboard/reporter';
import { describe, expect, it, vi } from 'vitest';

import type { DeploymentArtifact } from './artifact.ts';
import type { CloudflareApi } from './cloudflare-api.ts';
import type { WorkerConfig } from './config.ts';
import { collectResources, runDeploy } from './deploy-run.ts';

function worker(overrides: Partial<WorkerConfig>): WorkerConfig {
	return {
		name: 'cupboard',
		mainModule: 'worker.js',
		compatibilityDate: '2026-05-15',
		compatibilityFlags: ['nodejs_compat'],
		cpuMs: 300_000,
		observability: true,
		vars: {},
		durableObjects: [],
		r2Buckets: [{ binding: 'BLOBS', bucketName: 'cupboard-blobs' }],
		kvNamespaces: [],
		d1Databases: [{ binding: 'CUPBOARD_DB', databaseName: 'cupboard' }],
		queueProducers: [],
		queueConsumers: [],
		crons: [],
		migrations: [],
		...overrides
	};
}

const artifact: DeploymentArtifact = {
	config: {
		control: worker({
			name: 'cupboard',
			kvNamespaces: [
				{ binding: 'TENANT_CACHE', title: 'cupboard-tenant-cache' }
			],
			queueProducers: [
				{ binding: 'MAINTENANCE_QUEUE', queue: 'cupboard-maintenance' }
			],
			queueConsumers: [
				{
					queue: 'cupboard-maintenance',
					maxBatchSize: 10,
					maxBatchTimeout: 5,
					maxRetries: 3,
					maxConcurrency: 4,
					deadLetterQueue: 'cupboard-maintenance-dlq'
				}
			],
			crons: ['0 * * * *']
		}),
		tenant: worker({
			name: 'cupboard-tenant',
			migrations: [{ tag: 'v1', newSqliteClasses: ['CupboardServer'] }]
		})
	},
	controlBundle: { mainModule: 'worker.js', code: 'control' },
	tenantBundle: { mainModule: 'tenant-worker.js', code: 'tenant' },
	d1Migrations: [{ name: '0000_a.sql', statements: ['CREATE TABLE a (id);'] }]
};

const silentReporter: Reporter = {
	phase: (_label, body) => Promise.resolve(body({ fact: vi.fn() })),
	result: vi.fn(),
	warn: vi.fn(),
	info: vi.fn()
};

function recordingApi(): { api: CloudflareApi; calls: string[] } {
	const calls: string[] = [];

	return {
		calls,
		api: {
			listAccounts: () => Promise.resolve([{ id: 'acc', name: 'Acme' }]),
			ensureR2Bucket(name) {
				calls.push(`r2:${name}`);
				return Promise.resolve();
			},
			ensureD1Database(name) {
				calls.push(`d1:${name}`);
				return Promise.resolve('db-id');
			},
			ensureKvNamespace(title) {
				calls.push(`kv:${title}`);
				return Promise.resolve(`kv-${title}`);
			},
			ensureQueue(name) {
				calls.push(`queue:${name}`);
				return Promise.resolve(`qid-${name}`);
			},
			d1Query(_databaseId, sql) {
				calls.push(`d1q:${sql.slice(0, 12)}`);
				return Promise.resolve();
			},
			d1QueryRows() {
				return Promise.resolve([]);
			},
			getScriptMigrationTag() {
				return Promise.resolve('v0');
			},
			uploadScript(scriptName) {
				calls.push(`upload:${scriptName}`);
				return Promise.resolve();
			},
			putQueueConsumer(queueId, scriptName) {
				calls.push(`consumer:${queueId}->${scriptName}`);
				return Promise.resolve();
			},
			putSchedules(scriptName, crons) {
				calls.push(`cron:${scriptName}:${crons.join(',')}`);
				return Promise.resolve();
			},
			putSecret(scriptName, secret) {
				calls.push(`secret:${scriptName}:${secret.name}`);
				return Promise.resolve();
			},
			findZoneId(name) {
				calls.push(`zone:${name}`);
				return Promise.resolve('zone-1');
			},
			attachCustomDomain(scriptName, hostname) {
				calls.push(`domain:${hostname}->${scriptName}`);
				return Promise.resolve();
			}
		}
	};
}

describe('collectResources', () => {
	it('dedupes resources across both workers, including the dead-letter queue', () => {
		expect(collectResources(artifact.config)).toStrictEqual({
			r2Buckets: ['cupboard-blobs'],
			d1Databases: ['cupboard'],
			kvTitles: ['cupboard-tenant-cache'],
			queues: ['cupboard-maintenance', 'cupboard-maintenance-dlq']
		});
	});
});

describe('runDeploy', () => {
	it('provisions, migrates, uploads tenant before control, sets secrets and triggers', async () => {
		const { api, calls } = recordingApi();

		await runDeploy({
			artifact,
			api,
			reporter: silentReporter,
			options: {
				domain: 'cupboard.store',
				dryRun: false,
				secrets: {
					control: [{ name: 'CONTROL_KEY_WRAP_SECRET', text: 'k' }],
					tenant: []
				}
			}
		});

		expect(calls).toStrictEqual([
			'r2:cupboard-blobs',
			'queue:cupboard-maintenance',
			'queue:cupboard-maintenance-dlq',
			'd1:cupboard',
			'kv:cupboard-tenant-cache',
			'd1q:CREATE TABLE',
			'd1q:CREATE TABLE',
			'd1q:INSERT INTO ',
			'upload:cupboard-tenant',
			'upload:cupboard',
			'secret:cupboard:CONTROL_KEY_WRAP_SECRET',
			'queue:cupboard-maintenance',
			'consumer:qid-cupboard-maintenance->cupboard',
			'cron:cupboard:0 * * * *',
			'zone:cupboard.store',
			'domain:cupboard.store->cupboard'
		]);
	});
});
