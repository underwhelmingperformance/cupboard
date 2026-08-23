import type { Reporter } from '@cupboard/reporter';
import { APIError, NotFoundError } from 'cloudflare';
import { describe, expect, it, vi } from 'vitest';

import type { DeploymentArtifact } from './artifact.ts';
import type { CloudflareApi, ScriptConfiguration } from './cloudflare-api.ts';
import type { WorkerConfig } from './config.ts';
import { collectResources, runDeploy } from './deploy-run.ts';
import {
	cloudflareAccountIdSchema,
	databaseIdSchema,
	kvNamespaceIdSchema,
	queueIdSchema,
	scriptNameSchema,
	zoneIdSchema
} from './identifiers.ts';
import { buildScriptMetadata } from './upload.ts';

const scriptName = (value: string) => scriptNameSchema.parse(value);
const databaseId = (value: string) => databaseIdSchema.parse(value);
const queueId = (value: string) => queueIdSchema.parse(value);
const kvNamespaceId = (value: string) => kvNamespaceIdSchema.parse(value);

function worker(overrides: Partial<WorkerConfig>): WorkerConfig {
	return {
		name: scriptName('cupboard'),
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
		services: [],
		cacheEnabled: false,
		workersDev: true,
		previewUrls: true,
		crons: [],
		exports: {},
		...overrides
	};
}

const artifact: DeploymentArtifact = {
	config: {
		control: worker({
			name: scriptName('cupboard'),
			services: [
				{
					binding: 'CUPBOARD_TENANT',
					service: scriptName('cupboard-tenant'),
					entrypoint: 'CachedTenantReads'
				}
			],
			kvNamespaces: [
				{ binding: 'TENANT_CACHE', title: 'cupboard-tenant-cache' }
			],
			queueProducers: [
				{ binding: 'MAINTENANCE_QUEUE', queue: 'cupboard-maintenance' }
			],
			queueConsumers: [
				{
					queue: 'cupboard-maintenance',
					maxBatchSize: 1,
					maxBatchTimeout: 5,
					maxRetries: 3,
					maxConcurrency: 4,
					deadLetterQueue: 'cupboard-maintenance-dlq'
				}
			],
			crons: ['0 * * * *']
		}),
		tenant: worker({
			name: scriptName('cupboard-tenant'),
			cacheEnabled: true,
			workersDev: false,
			previewUrls: false,
			exports: {
				CupboardServer: { type: 'durable-object', storage: 'sqlite' },
				VersionedR2ObjectRollbackGuard: {
					type: 'durable-object',
					storage: 'sqlite'
				}
			}
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

function recordingApi(): { api: CloudflareApi; calls: string[] } {
	const calls: string[] = [];

	return {
		calls,
		api: {
			listAccounts: () =>
				Promise.resolve([
					{ id: cloudflareAccountIdSchema.parse('acc'), name: 'Acme' }
				]),
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
			setWorkersDevRoutes(scriptName, routes) {
				calls.push(
					`workers-dev:${scriptName}:${String(routes.workersDev)}:${String(routes.previewUrls)}`
				);
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
				return Promise.resolve(databaseId('db-id'));
			},
			ensureKvNamespace(title) {
				calls.push(`kv:${title}`);
				return Promise.resolve(kvNamespaceId(`kv-${title}`));
			},
			ensureQueue(name) {
				calls.push(`queue:${name}`);
				return Promise.resolve(queueId(`qid-${name}`));
			},
			d1QueryBatch(_databaseId, statements) {
				calls.push(`d1q:${statements[0]?.slice(0, 12) ?? ''}`);
				return Promise.resolve();
			},
			d1QueryRows(_databaseId, sql) {
				calls.push(`d1qr:${sql.slice(0, 12)}`);
				return Promise.resolve([]);
			},
			getScriptConfiguration: () => {
				recordFallbackApiCall(calls, 'getScriptConfiguration');
				return Promise.resolve(undefined);
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
				return Promise.resolve(zoneIdSchema.parse('zone-1'));
			},
			findCustomDomain: () => {
				recordFallbackApiCall(calls, 'findCustomDomain');
				return Promise.resolve(absentString());
			},
			setCustomDomain(scriptName, domain) {
				calls.push(`domain:${domain?.hostname ?? '(none)'}->${scriptName}`);
				return Promise.resolve();
			}
		}
	};
}

const noBuildVersion = Symbol('no-build-version');

function deployedConfiguration(
	script: string,
	buildVersion: string | typeof noBuildVersion = artifact.buildVersion
): ScriptConfiguration {
	const resources = {
		d1: new Map([['cupboard', databaseId('db-id')]]),
		kv: new Map([
			['cupboard-tenant-cache', kvNamespaceId('kv-cupboard-tenant-cache')]
		])
	};
	const config =
		script === 'cupboard-tenant'
			? artifact.config.tenant
			: artifact.config.control;
	const { bindings } = buildScriptMetadata(config, resources);

	return {
		...(buildVersion !== noBuildVersion && { buildVersion }),
		bindings: [
			{ type: 'secret_text', name: 'R2_SECRET_ACCESS_KEY' },
			...(bindings ?? [])
		],
		cacheEnabled: config.cacheEnabled,
		crossVersionCache: config.cacheEnabled
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
				secrets: {
					control: [{ name: 'CONTROL_KEY_WRAP_SECRET', text: 'k' }],
					tenant: []
				}
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
			'unexpected:getScriptConfiguration',
			'unexpected:getScriptConfiguration',
			'workers-dev:cupboard-tenant:false:false',
			'upload:cupboard-tenant',
			'upload:cupboard',
			'workers-dev:cupboard-tenant:false:false',
			'secret:cupboard:CONTROL_KEY_WRAP_SECRET',
			'queue:cupboard-maintenance',
			'consumer:qid-cupboard-maintenance->cupboard',
			'cron:cupboard:0 * * * *',
			'zone:cupboard.store',
			'domain:cupboard.store->cupboard'
		]);
	});

	it('removes schedules and custom domains that are no longer configured', async () => {
		const { api, calls } = recordingApi();
		const withoutCrons: DeploymentArtifact = {
			...artifact,
			config: {
				...artifact.config,
				control: { ...artifact.config.control, crons: [] }
			}
		};

		await runDeploy({
			artifact: withoutCrons,
			api,
			reporter: silentReporter,
			options: {
				domain: undefined,
				secrets: { control: [], tenant: [] }
			}
		});

		expect(
			calls.filter(
				(call) => call.startsWith('cron:') || call.startsWith('domain:')
			)
		).toStrictEqual(['cron:cupboard:', 'domain:(none)->cupboard']);
	});

	it('uploads control first when the target removes the named entrypoint', async () => {
		const { api, calls } = recordingApi();
		const withoutNamedEntrypoint: DeploymentArtifact = {
			...artifact,
			config: {
				...artifact.config,
				control: {
					...artifact.config.control,
					services: [
						...artifact.config.control.services.map((service) => ({
							...service,
							entrypoint: undefined
						})),
						{
							binding: 'OTHER_SERVICE',
							service: scriptName('cupboard-tenant'),
							entrypoint: 'OtherEntrypoint'
						}
					]
				}
			}
		};

		await runDeploy({
			artifact: withoutNamedEntrypoint,
			api,
			reporter: silentReporter,
			options: {
				domain: undefined,
				secrets: { control: [], tenant: [] }
			}
		});

		expect(calls.filter((call) => call.startsWith('upload:'))).toStrictEqual([
			'upload:cupboard',
			'upload:cupboard-tenant'
		]);
	});

	it.each([
		{ workersDev: true, previewUrls: true, calls: 1 },
		{ workersDev: true, previewUrls: false, calls: 2 },
		{ workersDev: false, previewUrls: true, calls: 2 },
		{ workersDev: false, previewUrls: false, calls: 2 }
	])(
		'reconciles workers.dev=$workersDev and preview URLs=$previewUrls',
		async ({ workersDev, previewUrls, calls: expectedCalls }) => {
			const { api, calls } = recordingApi();
			const configuredArtifact: DeploymentArtifact = {
				...artifact,
				config: {
					...artifact.config,
					tenant: {
						...artifact.config.tenant,
						workersDev,
						previewUrls
					}
				}
			};

			await runDeploy({
				artifact: configuredArtifact,
				api,
				reporter: silentReporter,
				options: {
					domain: undefined,
					secrets: { control: [], tenant: [] }
				}
			});

			expect(
				calls.filter((call) => call.startsWith('workers-dev:'))
			).toStrictEqual(
				Array.from(
					{ length: expectedCalls },
					() =>
						`workers-dev:cupboard-tenant:${String(workersDev)}:${String(previewUrls)}`
				)
			);
		}
	);

	it('tolerates a missing script only while restricting routes before upload', async () => {
		const { api, calls } = recordingApi();
		const missing = APIError.generate(
			404,
			{ errors: [{ code: 10_007, message: 'script not found' }] },
			'not found',
			new Headers()
		);
		expect(missing).toBeInstanceOf(NotFoundError);
		let routeAttempts = 0;
		const missingBeforeUpload: CloudflareApi = {
			...api,
			setWorkersDevRoutes: (scriptName, routes) => {
				routeAttempts += 1;
				calls.push(
					`workers-dev:${scriptName}:${String(routes.workersDev)}:${String(routes.previewUrls)}`
				);

				return routeAttempts === 1
					? Promise.reject(missing)
					: Promise.resolve();
			}
		};

		await runDeploy({
			artifact,
			api: missingBeforeUpload,
			reporter: silentReporter,
			options: {
				domain: undefined,
				secrets: { control: [], tenant: [] }
			}
		});

		expect(routeAttempts).toBe(2);
	});

	it('surfaces other Cloudflare not-found failures before upload', async () => {
		const { api } = recordingApi();
		const missing = APIError.generate(
			404,
			{ errors: [{ code: 1000, message: 'unrelated resource not found' }] },
			'not found',
			new Headers()
		);
		let routeAttempts = 0;
		const failingApi: CloudflareApi = {
			...api,
			setWorkersDevRoutes: () => {
				routeAttempts += 1;

				return routeAttempts === 1
					? Promise.reject(missing)
					: Promise.resolve();
			}
		};

		await expect(
			runDeploy({
				artifact,
				api: failingApi,
				reporter: silentReporter,
				options: {
					domain: undefined,
					secrets: { control: [], tenant: [] }
				}
			})
		).rejects.toBe(missing);
		expect(routeAttempts).toBe(1);
	});

	it('fails when route restriction cannot be confirmed after upload', async () => {
		const { api } = recordingApi();
		const missing = APIError.generate(
			404,
			{ errors: [{ code: 0, message: 'missing' }] },
			'not found',
			new Headers()
		);
		let routeAttempts = 0;
		const missingAfterUpload: CloudflareApi = {
			...api,
			setWorkersDevRoutes: () => {
				routeAttempts += 1;

				return routeAttempts === 2
					? Promise.reject(missing)
					: Promise.resolve();
			}
		};

		await expect(
			runDeploy({
				artifact,
				api: missingAfterUpload,
				reporter: silentReporter,
				options: {
					domain: undefined,
					secrets: { control: [], tenant: [] }
				}
			})
		).rejects.toBe(missing);
	});

	it('finds a delegated zone without querying the public suffix', async () => {
		const { api, calls } = recordingApi();
		const delegatedApi: CloudflareApi = {
			...api,
			findZoneId: (name) => {
				calls.push(`zone:${name}`);

				return Promise.resolve(
					name === 'cache.example.co.uk'
						? zoneIdSchema.parse('delegated-zone')
						: undefined
				);
			}
		};

		await runDeploy({
			artifact,
			api: delegatedApi,
			reporter: silentReporter,
			options: {
				domain: 'api.cache.example.co.uk',
				secrets: { control: [], tenant: [] }
			}
		});

		expect(
			calls.filter(
				(call) => call.startsWith('zone:') || call.startsWith('domain:')
			)
		).toStrictEqual([
			'zone:api.cache.example.co.uk',
			'zone:cache.example.co.uk',
			'domain:api.cache.example.co.uk->cupboard'
		]);
	});

	it('reconciles cache settings when the live build and bindings match', async () => {
		const { api, calls } = recordingApi();
		const skipped: string[] = [];
		const succeeded: string[] = [];

		// What the deployed scripts would answer: exactly the bindings this
		// deploy would upload, plus the secrets the upload keeps but the
		// comparison must ignore.
		const convergedApi: CloudflareApi = {
			...api,
			getScriptConfiguration: (script) =>
				Promise.resolve(deployedConfiguration(script))
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
				secrets: { control: [], tenant: [] }
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
				'workers-dev:cupboard-tenant:false:false',
				'workers-dev:cupboard-tenant:false:false',
				'queue:cupboard-maintenance',
				'consumer:qid-cupboard-maintenance->cupboard',
				'cron:cupboard:0 * * * *',
				'domain:(none)->cupboard'
			],
			succeeded: ['Applying D1 migrations · applied 1'],
			skipped: [
				'cupboard-tenant already runs this build and configuration; upload skipped.',
				'cupboard already runs this build and configuration; upload skipped.',
				'Setting secrets · no secrets to set'
			]
		});
	});

	it('uploads only the Worker whose deployed build does not match', async () => {
		const { api, calls } = recordingApi();
		const partialApi: CloudflareApi = {
			...api,
			getScriptConfiguration: (script) =>
				Promise.resolve(
					deployedConfiguration(
						script,
						script === 'cupboard' ? artifact.buildVersion : 'previous-build'
					)
				)
		};

		await runDeploy({
			artifact,
			api: partialApi,
			reporter: silentReporter,
			options: { domain: undefined, secrets: { control: [], tenant: [] } }
		});

		expect(calls.filter((call) => call.startsWith('upload:'))).toStrictEqual([
			'upload:cupboard-tenant'
		]);
	});

	it('uploads a Worker when a settings update removed its build tag', async () => {
		const { api, calls } = recordingApi();
		const driftedApi: CloudflareApi = {
			...api,
			getScriptConfiguration: (script) =>
				Promise.resolve(
					deployedConfiguration(
						script,
						script === 'cupboard' ? noBuildVersion : artifact.buildVersion
					)
				)
		};

		await runDeploy({
			artifact,
			api: driftedApi,
			reporter: silentReporter,
			options: { domain: undefined, secrets: { control: [], tenant: [] } }
		});

		expect(calls.filter((call) => call.startsWith('upload:'))).toStrictEqual([
			'upload:cupboard'
		]);
	});

	it('never skips a dirty build, whose version cannot be trusted', async () => {
		const { api, calls } = recordingApi();

		await runDeploy({
			artifact: { ...artifact, buildVersion: 'abc123def456+dirty' },
			api,
			reporter: silentReporter,
			options: {
				domain: undefined,
				secrets: { control: [], tenant: [] }
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
			'workers-dev:cupboard-tenant:false:false',
			'upload:cupboard-tenant',
			'upload:cupboard',
			'workers-dev:cupboard-tenant:false:false',
			'queue:cupboard-maintenance',
			'consumer:qid-cupboard-maintenance->cupboard',
			'cron:cupboard:0 * * * *',
			'domain:(none)->cupboard'
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
			new Headers()
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
				secrets: { control: [], tenant: [] }
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
				'unexpected:getScriptConfiguration',
				'unexpected:getScriptConfiguration',
				'workers-dev:cupboard-tenant:false:false',
				'upload:cupboard-tenant',
				'upload:cupboard',
				'workers-dev:cupboard-tenant:false:false',
				'queue:cupboard-maintenance',
				'consumer:qid-cupboard-maintenance->cupboard',
				'cron:cupboard:0 * * * *',
				'domain:(none)->cupboard'
			],
			warnings: [
				"CPU limit not applied: cupboard: this plan does not support CPU limits, so the Worker runs within the plan's CPU budget"
			]
		});
	});
});
