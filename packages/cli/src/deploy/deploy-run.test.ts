import {
	contractionMigrations,
	currentLocalStep,
	expansionLocalStep
} from '@cupboard/protocol/deployment';
import type { Reporter, ResultRow } from '@cupboard/reporter';
import { APIError, NotFoundError } from 'cloudflare';
import { describe, expect, it, vi } from 'vitest';

import {
	DeploymentPhaseUnsettledError,
	LocalStepUnreachedError,
	UnclassifiedD1MigrationError
} from '../errors.ts';

import type { DeploymentArtifact } from './artifact.ts';
import type { CloudflareApi, ScriptConfiguration } from './cloudflare-api.ts';
import type { WorkerConfig } from './config.ts';
import type { DeployDependencies } from './deploy-run.ts';
import {
	collectResources,
	runDeploy as runPlannedDeploy
} from './deploy-run.ts';
import {
	cloudflareAccountIdSchema,
	databaseIdSchema,
	kvNamespaceIdSchema,
	queueIdSchema,
	scriptNameSchema,
	zoneIdSchema
} from './identifiers.ts';
import { UnknownDeploymentPhaseError } from './phase.ts';
import {
	planDeployment,
	planOfflineDeployment,
	transitionPlanRows
} from './transition.ts';
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
	d1Migrations: [
		{
			name: '0000_a.sql',
			sha256:
				'7f07f8d020fed7a8f79462634bc21708339f44069448533d8d9a9973f4386065',
			statements: ['CREATE TABLE a (id);']
		}
	],
	buildVersion: 'abc123def456'
};

async function runDeploy(
	dependencies: Omit<DeployDependencies, 'plan'> & {
		readonly artifact: DeploymentArtifact;
	}
): Promise<ResultRow[]> {
	const { artifact: source, ...rest } = dependencies;
	return runPlannedDeploy({
		...rest,
		plan: planDeployment(source, { kind: 'offline' })
	});
}

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

/**
 * A Cloudflare API that records every call and tracks each script's deployed
 * build. A script has no configuration until it is uploaded, and afterwards
 * reports the build of that upload. `alreadyDeployed` sets the build each script
 * is running when the deploy starts.
 *
 * The deploy checks the deployed build twice: before the uploads, to decide
 * which scripts to upload, and after them, to confirm the new build is serving.
 * Tracking the state lets both checks see what they would see in production.
 *
 * The D1 database has no `deployment_phase` table unless `recordedPhase` is
 * given, in which case the table exists and holds that row.
 */
function recordingApi(
	alreadyDeployed: Readonly<Record<string, DeployedBuild>> = {},
	recordedPhase?: string
): { api: CloudflareApi; calls: string[] } {
	const calls: string[] = [];
	const deployedBuilds = new Map<string, DeployedBuild>(
		Object.entries(alreadyDeployed)
	);

	return {
		calls,
		api: {
			listAccounts: () =>
				Promise.resolve([
					{ id: cloudflareAccountIdSchema.parse('acc'), name: 'Acme' }
				]),
			listAccountSubscriptions: () =>
				Promise.resolve({ kind: 'listed' as const, subscriptions: [] }),
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
			findD1Database: () => Promise.resolve(undefined),
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

				// No tenant is behind the required step.
				if (sql.startsWith('SELECT CAST(')) {
					return Promise.resolve(['0']);
				}

				if (recordedPhase === undefined) {
					return Promise.resolve([]);
				}

				if (sql.includes('sqlite_master')) {
					return Promise.resolve(['deployment_phase']);
				}

				return Promise.resolve(
					sql.startsWith('SELECT phase') ? [recordedPhase] : []
				);
			},
			getScriptConfiguration(scriptName) {
				calls.push(`config:${scriptName}`);

				const build = deployedBuilds.get(scriptName);

				return Promise.resolve(
					build === undefined
						? undefined
						: deployedConfiguration(scriptName, build)
				);
			},
			uploadScript(scriptName, metadata) {
				calls.push(`upload:${scriptName}`);
				deployedBuilds.set(
					scriptName,
					metadata.annotations?.['workers/tag'] ?? ''
				);
				return Promise.resolve();
			},
			listDeployedVersions(scriptName) {
				calls.push(`versions:${scriptName}`);
				return Promise.resolve([{ versionId: 'v1', percentage: 100 }]);
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

// What a deployed script reports as its build. A settings update can drop the
// build tag altogether, and `noBuildVersion` stands for that.
type DeployedBuild = string | typeof noBuildVersion;

function deployedConfiguration(
	script: string,
	buildVersion: DeployedBuild = artifact.buildVersion
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
			// Keep this secret binding. Without it nothing checks that
			// hasMatchingBindings ignores secrets.
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
	it('does not start a deploy after cancellation', async () => {
		const controller = new AbortController();
		const reason = new Error('stop the deploy');
		const { api, calls } = recordingApi();
		controller.abort(reason);

		await expect(
			runDeploy({
				artifact,
				api,
				reporter: silentReporter,
				options: {
					domain: undefined,
					secrets: { control: [], tenant: [] }
				},
				signal: controller.signal
			})
		).rejects.toBe(reason);
		expect(calls).toStrictEqual([]);
	});

	it('reports cancellation that occurs during the final Cloudflare operation', async () => {
		const controller = new AbortController();
		const reason = new Error('stop the deploy');
		const { api } = recordingApi();
		const cancellingApi: CloudflareApi = {
			...api,
			setCustomDomain: () => {
				controller.abort(reason);

				return Promise.resolve();
			}
		};

		await expect(
			runDeploy({
				artifact,
				api: cancellingApi,
				reporter: silentReporter,
				options: {
					domain: 'cupboard.store',
					secrets: { control: [], tenant: [] }
				},
				signal: controller.signal
			})
		).rejects.toBe(reason);
	});

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
			'd1qr:SELECT tbl_n',
			'd1q:CREATE TABLE',
			'd1qr:SELECT name ',
			'd1q:ALTER TABLE ',
			'd1qr:SELECT name ',
			'd1q:CREATE TABLE',
			'config:cupboard-tenant',
			'config:cupboard',
			'workers-dev:cupboard-tenant:false:false',
			'upload:cupboard-tenant',
			'upload:cupboard',
			'workers-dev:cupboard-tenant:false:false',
			'secret:cupboard:CONTROL_KEY_WRAP_SECRET',
			'queue:cupboard-maintenance',
			'consumer:qid-cupboard-maintenance->cupboard',
			'cron:cupboard:0 * * * *',
			'zone:cupboard.store',
			'domain:cupboard.store->cupboard',
			'd1qr:SELECT tbl_n',
			'versions:cupboard',
			'config:cupboard',
			'versions:cupboard-tenant',
			'config:cupboard-tenant',
			'd1qr:SELECT CAST(',
			'd1q:INSERT INTO ',
			'd1q:INSERT INTO '
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
		const { api, calls } = recordingApi({
			cupboard: artifact.buildVersion,
			'cupboard-tenant': artifact.buildVersion
		});
		const skipped: string[] = [];
		const succeeded: string[] = [];

		await runDeploy({
			artifact,
			api,
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
				'd1qr:SELECT tbl_n',
				'd1q:CREATE TABLE',
				'd1qr:SELECT name ',
				'd1q:ALTER TABLE ',
				'd1qr:SELECT name ',
				'd1q:CREATE TABLE',
				'config:cupboard-tenant',
				'config:cupboard',
				'workers-dev:cupboard-tenant:false:false',
				'workers-dev:cupboard-tenant:false:false',
				'queue:cupboard-maintenance',
				'consumer:qid-cupboard-maintenance->cupboard',
				'cron:cupboard:0 * * * *',
				'domain:(none)->cupboard',
				'd1qr:SELECT tbl_n',
				'versions:cupboard',
				'config:cupboard',
				'versions:cupboard-tenant',
				'config:cupboard-tenant',
				'd1qr:SELECT CAST(',
				'd1q:INSERT INTO ',
				'd1q:INSERT INTO '
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
		const { api, calls } = recordingApi({
			cupboard: artifact.buildVersion,
			'cupboard-tenant': 'previous-build'
		});

		await runDeploy({
			artifact,
			api,
			reporter: silentReporter,
			options: { domain: undefined, secrets: { control: [], tenant: [] } }
		});

		expect(calls.filter((call) => call.startsWith('upload:'))).toStrictEqual([
			'upload:cupboard-tenant'
		]);
	});

	it('uploads a Worker when a settings update removed its build tag', async () => {
		const { api, calls } = recordingApi({
			cupboard: noBuildVersion,
			'cupboard-tenant': artifact.buildVersion
		});

		await runDeploy({
			artifact,
			api,
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
			'd1qr:SELECT tbl_n',
			'd1q:CREATE TABLE',
			'd1qr:SELECT name ',
			'd1q:ALTER TABLE ',
			'd1qr:SELECT name ',
			'd1q:CREATE TABLE',
			'workers-dev:cupboard-tenant:false:false',
			'upload:cupboard-tenant',
			'upload:cupboard',
			'workers-dev:cupboard-tenant:false:false',
			'queue:cupboard-maintenance',
			'consumer:qid-cupboard-maintenance->cupboard',
			'cron:cupboard:0 * * * *',
			'domain:(none)->cupboard',
			'd1qr:SELECT tbl_n',
			'versions:cupboard',
			'config:cupboard',
			'versions:cupboard-tenant',
			'config:cupboard-tenant',
			'd1qr:SELECT CAST(',
			'd1q:INSERT INTO ',
			'd1q:INSERT INTO '
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
				'd1qr:SELECT tbl_n',
				'd1q:CREATE TABLE',
				'd1qr:SELECT name ',
				'd1q:ALTER TABLE ',
				'd1qr:SELECT name ',
				'd1q:CREATE TABLE',
				'config:cupboard-tenant',
				'config:cupboard',
				'workers-dev:cupboard-tenant:false:false',
				'upload:cupboard-tenant',
				'upload:cupboard',
				'workers-dev:cupboard-tenant:false:false',
				'queue:cupboard-maintenance',
				'consumer:qid-cupboard-maintenance->cupboard',
				'cron:cupboard:0 * * * *',
				'domain:(none)->cupboard',
				'd1qr:SELECT tbl_n',
				'versions:cupboard',
				'config:cupboard',
				'versions:cupboard-tenant',
				'config:cupboard-tenant',
				'd1qr:SELECT CAST(',
				'd1q:INSERT INTO ',
				'd1q:INSERT INTO '
			],
			warnings: [
				"CPU limit not applied: cupboard: this plan does not support CPU limits, so the Worker runs within the plan's CPU budget"
			]
		});
	});

	it.each([
		{
			label: 'a script still splits traffic across versions',
			versions: [
				{ versionId: 'v1', percentage: 60 },
				{ versionId: 'v2', percentage: 40 }
			],
			scripts: ['cupboard', 'cupboard-tenant']
		},
		{
			label: 'a script has no deployment at all',
			versions: [],
			scripts: ['cupboard', 'cupboard-tenant']
		}
	])('does not record the phase when $label', async ({ versions, scripts }) => {
		const { api, calls } = recordingApi();
		const splitApi: CloudflareApi = {
			...api,
			listDeployedVersions: () => Promise.resolve(versions)
		};

		let failure: unknown;

		try {
			await runDeploy({
				artifact,
				api: splitApi,
				reporter: silentReporter,
				options: { domain: undefined, secrets: { control: [], tenant: [] } }
			});
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(DeploymentPhaseUnsettledError);

		if (!(failure instanceof DeploymentPhaseUnsettledError)) {
			return;
		}

		expect({
			scripts: failure.scripts,
			buildVersion: failure.buildVersion,
			recorded: calls.filter((call) => call.startsWith('d1q:INSERT INTO'))
		}).toStrictEqual({
			scripts,
			buildVersion: artifact.buildVersion,
			recorded: []
		});
	});

	it('does not record the phase while a tenant is behind', async () => {
		const { api, calls } = recordingApi();
		const behindApi: CloudflareApi = {
			...api,
			d1QueryRows(databaseId, sql) {
				if (sql.startsWith('SELECT CAST(')) {
					calls.push(`d1qr:${sql.slice(0, 12)}`);
					return Promise.resolve(['2']);
				}

				if (sql.startsWith('SELECT id')) {
					calls.push(`d1qr:${sql.slice(0, 12)}`);
					return Promise.resolve(['alpha', 'beta']);
				}

				return api.d1QueryRows(databaseId, sql);
			}
		};

		let failure: unknown;

		try {
			await runDeploy({
				artifact,
				api: behindApi,
				reporter: silentReporter,
				options: { domain: undefined, secrets: { control: [], tenant: [] } }
			});
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(LocalStepUnreachedError);

		if (!(failure instanceof LocalStepUnreachedError)) {
			return;
		}

		expect({
			pending: failure.pending,
			requiredStep: failure.requiredStep,
			stragglers: failure.stragglers,
			recorded: calls.filter((call) => call.startsWith('d1q:INSERT INTO'))
		}).toStrictEqual({
			pending: 2,
			requiredStep: expansionLocalStep,
			stragglers: ['alpha', 'beta'],
			recorded: []
		});
	});

	it('stops before a migration or an upload when the recorded phase is one this build does not define', async () => {
		const { api, calls } = recordingApi(
			{},
			'later-phase|1|2026-01-01T00:00:00.000Z'
		);

		let failure: unknown;

		try {
			await runDeploy({
				artifact,
				api,
				reporter: silentReporter,
				options: { domain: undefined, secrets: { control: [], tenant: [] } }
			});
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(UnknownDeploymentPhaseError);

		if (!(failure instanceof UnknownDeploymentPhaseError)) {
			return;
		}

		expect({ recorded: failure.recorded, calls }).toStrictEqual({
			recorded: 'later-phase',
			calls: [
				'r2:cupboard-blobs',
				'lifecycle:cupboard-blobs',
				'queue:cupboard-maintenance',
				'queue:cupboard-maintenance-dlq',
				'd1:cupboard',
				'kv:cupboard-tenant-cache',
				'd1qr:SELECT tbl_n',
				'd1qr:SELECT phase'
			]
		});
	});

	it('deploys over a recorded phase this build defines and records it again', async () => {
		const { api, calls } = recordingApi(
			{},
			'current|0|2026-01-01T00:00:00.000Z'
		);
		const facts: [string, unknown][] = [];

		await runDeploy({
			artifact,
			api,
			reporter: {
				...silentReporter,
				phase: (_label, body) =>
					Promise.resolve(
						body({
							fact: (label, value) => {
								facts.push([label, value]);
							},
							warn: vi.fn()
						})
					)
			},
			options: { domain: undefined, secrets: { control: [], tenant: [] } }
		});

		expect({ calls, facts }).toStrictEqual({
			calls: [
				'r2:cupboard-blobs',
				'lifecycle:cupboard-blobs',
				'queue:cupboard-maintenance',
				'queue:cupboard-maintenance-dlq',
				'd1:cupboard',
				'kv:cupboard-tenant-cache',
				'd1qr:SELECT tbl_n',
				'd1qr:SELECT phase',
				'd1q:CREATE TABLE',
				'd1qr:SELECT name ',
				'd1q:ALTER TABLE ',
				'd1qr:SELECT name ',
				'd1q:CREATE TABLE',
				'config:cupboard-tenant',
				'config:cupboard',
				'workers-dev:cupboard-tenant:false:false',
				'upload:cupboard-tenant',
				'upload:cupboard',
				'workers-dev:cupboard-tenant:false:false',
				'queue:cupboard-maintenance',
				'consumer:qid-cupboard-maintenance->cupboard',
				'cron:cupboard:0 * * * *',
				'domain:(none)->cupboard',
				'd1qr:SELECT tbl_n',
				'd1qr:SELECT phase',
				'versions:cupboard',
				'config:cupboard',
				'versions:cupboard-tenant',
				'config:cupboard-tenant',
				'd1qr:SELECT CAST(',
				'd1q:INSERT INTO ',
				'd1q:INSERT INTO '
			],
			facts: [
				['resources', 5],
				['build', 'abc123def456'],
				['from', 'current'],
				['tenants behind', '0'],
				['phase', 'native-reads'],
				['migrations', '0'],
				['phase', 'contracted']
			]
		});
	});
});

describe('contraction within a deploy', () => {
	const contraction = {
		name: contractionMigrations[0] ?? '',
		sha256: 'a'.repeat(64),
		statements: ['ALTER TABLE prior DROP COLUMN legacy;']
	};
	it('contracts after both Workers settle and records contracted afterwards', async () => {
		const { api } = recordingApi();
		const events: string[] = [];
		const observed: CloudflareApi = {
			...api,
			async uploadScript(name, metadata, bundle) {
				events.push(`upload:${name}`);
				return api.uploadScript(name, metadata, bundle);
			},
			async listDeployedVersions(name) {
				events.push(`settle:${name}`);
				return api.listDeployedVersions(name);
			},
			async d1QueryBatch(database, statements) {
				for (const statement of statements) {
					if (statement === contraction.statements[0]) {
						events.push('contract');
					}
					if (statement.startsWith('INSERT INTO deployment_phase')) {
						events.push(
							statement.includes("VALUES ('current', 'native-reads'")
								? 'native-reads'
								: 'contracted'
						);
					}
				}
				return api.d1QueryBatch(database, statements);
			}
		};
		await runDeploy({
			artifact: {
				...artifact,
				d1Migrations: [...artifact.d1Migrations, contraction]
			},
			api: observed,
			reporter: silentReporter,
			options: { domain: undefined, secrets: { control: [], tenant: [] } }
		});
		expect(events).toStrictEqual([
			'upload:cupboard-tenant',
			'upload:cupboard',
			'settle:cupboard',
			'settle:cupboard-tenant',
			'native-reads',
			'contract',
			'contracted'
		]);
	});
});

describe('automatic tenant settlement', () => {
	it('settles expansion before contraction and finishes current local work afterwards', async () => {
		const { api } = recordingApi();
		const steps: number[] = [];
		let isPending = true;
		await runDeploy({
			artifact,
			api: {
				...api,
				d1QueryRows(database, query) {
					if (query.startsWith('SELECT CAST(count(*) AS TEXT) FROM tenant')) {
						return Promise.resolve([
							isPending || query.includes('local_step < 5') ? '1' : '0'
						]);
					}
					return api.d1QueryRows(database, query);
				}
			},
			settleTenants: (requiredStep) => {
				steps.push(requiredStep);
				isPending = false;
				return Promise.resolve();
			},
			reporter: silentReporter,
			options: { domain: undefined, secrets: { control: [], tenant: [] } }
		});
		expect(steps).toStrictEqual([expansionLocalStep, currentLocalStep]);
	});
});

describe('refused deployment contractions', () => {
	it.each(['versions', 'tenants'] as const)(
		'does not contract when %s have not settled',
		async (reason) => {
			const { api } = recordingApi();
			const mutations: string[] = [];
			const observed: CloudflareApi = {
				...api,
				listDeployedVersions: (name) =>
					reason === 'versions'
						? Promise.resolve([])
						: api.listDeployedVersions(name),
				d1QueryRows: (id, query) =>
					reason === 'tenants' && query.startsWith('SELECT CAST(')
						? Promise.resolve(['1'])
						: api.d1QueryRows(id, query),
				d1QueryBatch: async (id, statements) => {
					mutations.push(...statements);
					await api.d1QueryBatch(id, statements);
				}
			};
			const contraction = {
				name: contractionMigrations[0] ?? '',
				sha256: 'a'.repeat(64),
				statements: ['ALTER TABLE prior DROP COLUMN legacy;']
			};
			await expect(
				runDeploy({
					artifact: {
						...artifact,
						d1Migrations: [...artifact.d1Migrations, contraction]
					},
					api: observed,
					reporter: silentReporter,
					options: { domain: undefined, secrets: { control: [], tenant: [] } }
				})
			).rejects.toBeInstanceOf(
				reason === 'versions'
					? DeploymentPhaseUnsettledError
					: LocalStepUnreachedError
			);
			expect(
				mutations.filter(
					(query) =>
						query === contraction.statements[0] ||
						query.startsWith('INSERT INTO deployment_phase')
				)
			).toStrictEqual([]);
		}
	);
	it('rejects an unclassified migration before changing D1 or uploading a Worker', async () => {
		const { api, calls } = recordingApi();
		const migration = {
			name: '9999_unclassified.sql',
			sha256: 'a'.repeat(64),
			statements: ['SELECT 1;']
		};
		await expect(
			runDeploy({
				artifact: {
					...artifact,
					d1Migrations: [...artifact.d1Migrations, migration]
				},
				api,
				reporter: silentReporter,
				options: { domain: undefined, secrets: { control: [], tenant: [] } }
			})
		).rejects.toBeInstanceOf(UnclassifiedD1MigrationError);
		expect(
			calls.filter(
				(call) => call.startsWith('d1q:') || call.startsWith('upload:')
			)
		).toStrictEqual([]);
	});
});

describe('reviewed deployment plan', () => {
	it.each([
		{ override: 'paid' as const, allowance: '1000' },
		{ override: 'free' as const, allowance: '50' }
	])(
		'applies the explicit $override allowance in an offline plan',
		({ override, allowance }) => {
			const plan = planOfflineDeployment(artifact, override);
			expect({
				control:
					plan.artifact.config.control.vars
						.CUPBOARD_D1_STATEMENTS_PER_INVOCATION,
				tenant:
					plan.artifact.config.tenant.vars
						.CUPBOARD_D1_STATEMENTS_PER_INVOCATION,
				observation: plan.observation
			}).toStrictEqual({
				control: allowance,
				tenant: allowance,
				observation: { kind: 'offline' }
			});
		}
	);

	it('keeps preparation and contraction in the reviewed execution plan', () => {
		const contraction = {
			name: '0028_cache_identity_contract.sql',
			sha256: 'digest',
			statements: ['SELECT 1;']
		};
		const source = {
			...artifact,
			d1Migrations: [...artifact.d1Migrations, contraction]
		};
		const plan = planDeployment(source, { kind: 'new' });
		expect({
			preparation: plan.preparation,
			contraction: plan.contraction,
			artifact: plan.artifact
		}).toStrictEqual({
			preparation: artifact.d1Migrations,
			contraction: [contraction],
			artifact: source
		});
		expect(
			transitionPlanRows(plan).filter(
				(row) => row.label === 'Rollback boundary'
			)
		).toStrictEqual([
			{
				label: 'Rollback boundary',
				value:
					'Uploading the tenant Worker allows each object to contract its local SQLite schema. After that point, recover by completing this deployment; redeploying an older Worker cannot restore removed tables.'
			}
		]);
	});
});
