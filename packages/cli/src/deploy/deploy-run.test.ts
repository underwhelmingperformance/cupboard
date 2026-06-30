import type { Reporter } from '@cupboard/reporter';
import { APIError } from 'cloudflare';
import { describe, expect, it, vi } from 'vitest';

import type { DeploymentArtifact } from './artifact.ts';
import type { CloudflareApi } from './cloudflare-api.ts';
import type { WorkerConfig } from './config.ts';
import { collectResources, runDeploy } from './deploy-run.ts';
import { buildScriptMetadata } from './upload.ts';

function worker(overrides: Partial<WorkerConfig>): WorkerConfig {
	return {
		name: 'cupboard',
		mainModule: 'worker.js',
		compatibilityDate: '2026-05-15',
		compatibilityFlags: ['nodejs_compat'],
		cpuMs: 300_000,
		observability: true,
		tracing: false,
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
	d1Migrations: [{ name: '0000_a.sql', statements: ['CREATE TABLE a (id);'] }],
	buildVersion: 'abc123def456'
};

const silentReporter: Reporter = {
	phase: (_label, body) =>
		Promise.resolve(body({ fact: vi.fn(), warn: vi.fn() })),
	progress: (_label, _options, body) =>
		Promise.resolve(body({ advance: vi.fn(), fact: vi.fn(), warn: vi.fn() })),
	steps: (_label, body) =>
		Promise.resolve(
			body({
				message: vi.fn(),
				group: () => ({ message: vi.fn(), success: vi.fn(), error: vi.fn() }),
				warn: vi.fn()
			})
		),
	result: vi.fn(),
	data: vi.fn(),
	warn: vi.fn(),
	info: vi.fn(),
	success: vi.fn(),
	step: vi.fn(),
	error: vi.fn()
};

function recordFallbackApiCall(calls: string[], member: string): void {
	const call = `unexpected:${member}`;
	calls.push(call);
}

function absentString(): string | undefined {
	return undefined;
}

function absentRows(): readonly unknown[] | undefined {
	return undefined;
}

function recordingApi(): { api: CloudflareApi; calls: string[] } {
	const calls: string[] = [];

	return {
		calls,
		api: {
			listAccounts: () => Promise.resolve([{ id: 'acc', name: 'Acme' }]),
			r2BucketExists: () => {
				recordFallbackApiCall(calls, 'r2BucketExists');
				return Promise.resolve(false);
			},
			listTokenPermissionGroups: () => {
				recordFallbackApiCall(calls, 'listTokenPermissionGroups');
				return Promise.resolve([]);
			},
			findApiTokenId: () => {
				recordFallbackApiCall(calls, 'findApiTokenId');
				return Promise.resolve(absentString());
			},
			createApiToken: () => {
				recordFallbackApiCall(calls, 'createApiToken');
				return Promise.resolve({ id: '', value: '' });
			},
			rollApiTokenSecret: () => {
				recordFallbackApiCall(calls, 'rollApiTokenSecret');
				return Promise.resolve('');
			},
			getWorkersDevSubdomain: () => {
				recordFallbackApiCall(calls, 'getWorkersDevSubdomain');
				return Promise.resolve(absentString());
			},
			enableWorkersDevRoute: () => {
				recordFallbackApiCall(calls, 'enableWorkersDevRoute');
				return Promise.resolve();
			},
			queryWorkerLogs: () => Promise.resolve([]),
			ensureR2Bucket(name) {
				calls.push(`r2:${name}`);
				return Promise.resolve();
			},
			ensureStagingLifecycleRule(name) {
				calls.push(`lifecycle:${name}`);
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
			d1QueryRows(_databaseId, sql) {
				calls.push(`d1qr:${sql.slice(0, 12)}`);
				return Promise.resolve([]);
			},
			getScriptMigrationTag: () => Promise.resolve('v0'),
			getScriptBindings: () => {
				recordFallbackApiCall(calls, 'getScriptBindings');
				return Promise.resolve(absentRows());
			},
			uploadScript(scriptName) {
				calls.push(`upload:${scriptName}`);
				return Promise.resolve();
			},
			ensureQueueConsumer(queueId, scriptName) {
				calls.push(`consumer:${queueId}->${scriptName}`);
				return Promise.resolve();
			},
			ensureSchedules(scriptName, crons) {
				calls.push(`cron:${scriptName}:${crons.join(',')}`);
				return Promise.resolve();
			},
			putSecret(scriptName, secret) {
				calls.push(`secret:${scriptName}:${secret.name}`);
				return Promise.resolve();
			},
			listScriptSecrets(scriptName) {
				calls.push(`secrets:${scriptName}`);
				return Promise.resolve([]);
			},
			findZoneId(name) {
				calls.push(`zone:${name}`);
				return Promise.resolve('zone-1');
			},
			findCustomDomain: () => {
				recordFallbackApiCall(calls, 'findCustomDomain');
				return Promise.resolve(absentString());
			},
			ensureCustomDomain(scriptName, hostname) {
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
				},
				liveBuild: undefined
			}
		});

		expect(calls).toStrictEqual([
			'r2:cupboard-blobs',
			'lifecycle:cupboard-blobs',
			'queue:cupboard-maintenance',
			'queue:cupboard-maintenance-dlq',
			'd1:cupboard',
			'kv:cupboard-tenant-cache',
			'd1q:CREATE TABLE',
			'd1qr:SELECT name ',
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

	it('skips both uploads when the live build and configuration match', async () => {
		const { api, calls } = recordingApi();
		const skipped: string[] = [];
		const succeeded: string[] = [];

		// What the deployed scripts would answer: exactly the bindings this
		// deploy would upload, plus the secrets the upload keeps but the
		// comparison must ignore.
		const convergedApi: CloudflareApi = {
			...api,
			getScriptMigrationTag: () => Promise.resolve('v1'),
			getScriptBindings: (scriptName) => {
				const resources = {
					d1: new Map([['cupboard', 'db-id']]),
					kv: new Map([['cupboard-tenant-cache', 'kv-cupboard-tenant-cache']])
				};
				const config =
					scriptName === 'cupboard-tenant'
						? artifact.config.tenant
						: artifact.config.control;
				const { bindings } = buildScriptMetadata(config, resources);

				return Promise.resolve([
					{ type: 'secret_text', name: 'R2_SECRET_ACCESS_KEY' },
					...(bindings ?? [])
				]);
			}
		};

		await runDeploy({
			artifact,
			api: convergedApi,
			reporter: {
				...silentReporter,
				success: (message) => {
					succeeded.push(message);
				},
				step: (message) => {
					skipped.push(message);
				}
			},
			options: {
				domain: undefined,
				dryRun: false,
				secrets: { control: [], tenant: [] },
				liveBuild: 'abc123def456'
			}
		});

		expect({ calls, succeeded, skipped }).toStrictEqual({
			calls: [
				'r2:cupboard-blobs',
				'lifecycle:cupboard-blobs',
				'queue:cupboard-maintenance',
				'queue:cupboard-maintenance-dlq',
				'd1:cupboard',
				'kv:cupboard-tenant-cache',
				'd1q:CREATE TABLE',
				'd1qr:SELECT name ',
				'd1q:CREATE TABLE',
				'd1q:INSERT INTO ',
				'queue:cupboard-maintenance',
				'consumer:qid-cupboard-maintenance->cupboard',
				'cron:cupboard:0 * * * *'
			],
			succeeded: ['Applying D1 migrations · applied 1'],
			skipped: [
				'cupboard-tenant already runs this build and configuration; upload skipped.',
				'cupboard already runs this build and configuration; upload skipped.',
				'Setting secrets · no secrets to set'
			]
		});
	});

	it('never skips a dirty build, whose version cannot be trusted', async () => {
		const { api, calls } = recordingApi();

		await runDeploy({
			artifact: { ...artifact, buildVersion: 'abc123def456+dirty' },
			api,
			reporter: silentReporter,
			options: {
				domain: undefined,
				dryRun: false,
				secrets: { control: [], tenant: [] },
				liveBuild: 'abc123def456+dirty'
			}
		});

		expect(calls).toStrictEqual([
			'r2:cupboard-blobs',
			'lifecycle:cupboard-blobs',
			'queue:cupboard-maintenance',
			'queue:cupboard-maintenance-dlq',
			'd1:cupboard',
			'kv:cupboard-tenant-cache',
			'd1q:CREATE TABLE',
			'd1qr:SELECT name ',
			'd1q:CREATE TABLE',
			'd1q:INSERT INTO ',
			'upload:cupboard-tenant',
			'upload:cupboard',
			'queue:cupboard-maintenance',
			'consumer:qid-cupboard-maintenance->cupboard',
			'cron:cupboard:0 * * * *'
		]);
	});

	it('retries an upload without CPU limits when the plan rejects them', async () => {
		const { api, calls } = recordingApi();
		const warnings: string[] = [];
		const cpuLimitsRejected = APIError.generate(
			400,
			{
				errors: [
					{
						code: 100_328,
						message: 'CPU limits are not supported for the Free plan.'
					}
				]
			},
			'400 CPU limits are not supported',
			{}
		);

		const planLimitedApi: CloudflareApi = {
			...api,
			uploadScript: (scriptName, metadata, bundle) => {
				if (metadata.limits !== undefined) {
					return Promise.reject(cpuLimitsRejected);
				}

				return api.uploadScript(scriptName, metadata, bundle);
			}
		};

		await runDeploy({
			artifact: {
				...artifact,
				config: {
					control: artifact.config.control,
					tenant: { ...artifact.config.tenant, cpuMs: undefined }
				}
			},
			api: planLimitedApi,
			reporter: {
				...silentReporter,
				phase: (_label, body) =>
					Promise.resolve(
						body({
							fact: vi.fn(),
							warn: (label, value) => {
								warnings.push(`${label}: ${value ?? ''}`);
							}
						})
					)
			},
			options: {
				domain: undefined,
				dryRun: false,
				secrets: { control: [], tenant: [] },
				liveBuild: undefined
			}
		});

		expect({ calls, warnings }).toStrictEqual({
			calls: [
				'r2:cupboard-blobs',
				'lifecycle:cupboard-blobs',
				'queue:cupboard-maintenance',
				'queue:cupboard-maintenance-dlq',
				'd1:cupboard',
				'kv:cupboard-tenant-cache',
				'd1q:CREATE TABLE',
				'd1qr:SELECT name ',
				'd1q:CREATE TABLE',
				'd1q:INSERT INTO ',
				'upload:cupboard-tenant',
				'upload:cupboard',
				'queue:cupboard-maintenance',
				'consumer:qid-cupboard-maintenance->cupboard',
				'cron:cupboard:0 * * * *'
			],
			warnings: [
				"CPU limit not applied: cupboard: this plan does not support CPU limits, so the Worker runs within the plan's CPU budget"
			]
		});
	});
});
