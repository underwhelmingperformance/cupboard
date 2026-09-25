import { DatabaseSync } from 'node:sqlite';

import {
	currentLocalStep,
	expansionLocalStep,
	type SchemaTransition,
	schemaTransitions
} from '@cupboard/protocol/deployment';
import type { Reporter, ResultRow } from '@cupboard/reporter';
import { APIError, NotFoundError } from 'cloudflare';
import { describe, expect, it, vi } from 'vitest';

import {
	DeploymentPhaseUnsettledError,
	LocalStepUnreachedError,
	MisclassifiedD1MigrationsError
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
import { applyD1Migrations, type D1Migration } from './migrations.ts';
import { UnknownDeploymentTransitionError } from './phase.ts';
import {
	planDeployment,
	planOfflineDeployment,
	transitionPlanRows
} from './transition.ts';
import { planTransitions } from './transitions.ts';
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

// The schema transitions the deploy tests walk: one with a contract that waits
// for the tenants to settle, and an independent one with no contract.
const testTransitions: readonly SchemaTransition[] = [
	{
		id: 'cache-identity',
		expand: ['0000_a.sql'],
		contract: ['0001_contract.sql'],
		settleStep: expansionLocalStep,
		completedBy: 'v0.0.34'
	},
	{
		id: 'deployment-transitions',
		expand: ['0002_independent.sql'],
		contract: [],
		independent: true
	}
];

const expandMigration: D1Migration = {
	name: '0000_a.sql',
	sha256: '7f07f8d020fed7a8f79462634bc21708339f44069448533d8d9a9973f4386065',
	statements: [
		'CREATE TABLE tenant (id TEXT PRIMARY KEY, status TEXT NOT NULL, local_step INTEGER, legacy TEXT);',
		'CREATE TABLE deployment_phase (id TEXT PRIMARY KEY, phase TEXT NOT NULL, required_local_step INTEGER NOT NULL, updated_at TEXT NOT NULL);'
	]
};
const contractMigration: D1Migration = {
	name: '0001_contract.sql',
	sha256: 'a'.repeat(64),
	statements: ['ALTER TABLE tenant DROP COLUMN legacy;']
};
const independentMigration: D1Migration = {
	name: '0002_independent.sql',
	sha256: 'b'.repeat(64),
	statements: ['CREATE TABLE sweep (id INTEGER PRIMARY KEY);']
};

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
	d1Migrations: [expandMigration, contractMigration, independentMigration],
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
		plan: {
			artifact: source,
			allowanceSource: { kind: 'offline' },
			observation: { kind: 'offline' },
			transitions: planTransitions(source.d1Migrations, testTransitions)
		}
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

// A reporter whose phase facts are collected, in order.
function factReporter(facts: [string, unknown][]): Reporter {
	return {
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
	};
}

function recordFallbackApiCall(calls: string[], member: string): void {
	const call = `unexpected:${member}`;
	calls.push(call);
}

function absentString(): string | undefined {
	return undefined;
}

interface RecordingApiOptions {
	// Whether the D1 database exists before the deploy. A deploy of a fresh
	// database walks every transition before the upload.
	readonly existing?: boolean;
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
 * D1 is an in-memory SQLite database, so the transition walk's reads see what
 * its writes and migrations did. It starts empty; a test seeds it through
 * `database` for a deployment in an earlier state.
 */
function recordingApi(
	alreadyDeployed: Readonly<Record<string, DeployedBuild>> = {},
	options: RecordingApiOptions = {}
): { api: CloudflareApi; calls: string[]; database: DatabaseSync } {
	const calls: string[] = [];
	const database = new DatabaseSync(':memory:');
	const deployedBuilds = new Map<string, DeployedBuild>(
		Object.entries(alreadyDeployed)
	);

	return {
		calls,
		database,
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
			findD1Database: () =>
				Promise.resolve(
					options.existing === true ? databaseId('db-id') : undefined
				),
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
				for (const statement of statements) {
					database.exec(statement);
				}
				return Promise.resolve();
			},
			d1QueryRows(_databaseId, sql) {
				calls.push(`d1qr:${sql.slice(0, 12)}`);
				const rows = database.prepare(sql).all();

				return Promise.resolve(
					rows.flatMap((row) => {
						const [value] = Object.values(row);

						return typeof value === 'string' ? [value] : [];
					})
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

/**
 * Applies `migrations` as an earlier release's deploy did, then forgets the
 * calls it took, so a test starts from that deployment's state.
 */
async function seedApplied(
	recording: ReturnType<typeof recordingApi>,
	migrations: readonly D1Migration[]
): Promise<void> {
	await applyD1Migrations(
		{
			queryBatch: (id, statements) =>
				recording.api.d1QueryBatch(id, statements),
			queryRows: (id, sql) => recording.api.d1QueryRows(id, sql)
		},
		databaseId('db-id'),
		migrations
	);
	recording.calls.length = 0;
}

function insertTenants(
	database: DatabaseSync,
	tenants: readonly { id: string; localStep: number | undefined }[]
): void {
	const insertStepped = database.prepare(
		'INSERT INTO tenant (id, status, local_step) VALUES (?, ?, ?)'
	);
	const insertUnstepped = database.prepare(
		'INSERT INTO tenant (id, status) VALUES (?, ?)'
	);

	for (const tenant of tenants) {
		if (tenant.localStep === undefined) {
			insertUnstepped.run(tenant.id, 'active');
			continue;
		}

		insertStepped.run(tenant.id, 'active', tenant.localStep);
	}
}

function appliedMigrations(database: DatabaseSync): string[] {
	return database
		.prepare('SELECT name FROM d1_migrations ORDER BY name')
		.all()
		.flatMap((row) => (typeof row.name === 'string' ? [row.name] : []));
}

function recordedTransitions(database: DatabaseSync): Record<string, string> {
	const rows = database
		.prepare('SELECT id, state, updated_at FROM deployment_transition')
		.all();

	return Object.fromEntries(
		rows.map((row) => [
			String(row.id),
			`${String(row.state)}@${String(row.updated_at)}`
		])
	);
}

function recordedPhase(database: DatabaseSync): string | undefined {
	const row = database
		.prepare("SELECT phase FROM deployment_phase WHERE id = 'current'")
		.get();

	return typeof row?.phase === 'string' ? row.phase : undefined;
}

// The D1 calls of the walk before the upload on a database this deploy
// created: it finds neither state table, creates the transition table, and
// then applies and records every transition, contracts included.
const preparedFreshDatabase = [
	'd1qr:SELECT tbl_n',
	'd1qr:SELECT tbl_n',
	'd1q:CREATE TABLE',
	'd1q:CREATE TABLE',
	'd1qr:SELECT name ',
	'd1q:ALTER TABLE ',
	'd1qr:SELECT name ',
	'd1q:CREATE TABLE',
	'd1q:INSERT INTO ',
	'd1q:CREATE TABLE',
	'd1qr:SELECT name ',
	'd1qr:SELECT name ',
	'd1q:ALTER TABLE ',
	'd1q:INSERT INTO ',
	'd1q:INSERT INTO ',
	'd1q:CREATE TABLE',
	'd1qr:SELECT name ',
	'd1qr:SELECT name ',
	'd1q:CREATE TABLE',
	'd1q:INSERT INTO ',
	'd1q:INSERT INTO '
];

// The walk after the upload once every transition is complete only reads the
// recorded states.
const completedTransitions = [
	'd1qr:SELECT tbl_n',
	'd1qr:SELECT id ||',
	'd1qr:SELECT tbl_n',
	'd1qr:SELECT phase',
	'd1q:CREATE TABLE'
];

const fixedNow = (): Date => new Date('2026-01-01T00:00:00.000Z');

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
			...preparedFreshDatabase,
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
			...completedTransitions
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
				...preparedFreshDatabase,
				'config:cupboard-tenant',
				'config:cupboard',
				'workers-dev:cupboard-tenant:false:false',
				'workers-dev:cupboard-tenant:false:false',
				'queue:cupboard-maintenance',
				'consumer:qid-cupboard-maintenance->cupboard',
				'cron:cupboard:0 * * * *',
				'domain:(none)->cupboard',
				...completedTransitions
			],
			succeeded: [],
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
			...preparedFreshDatabase,
			'workers-dev:cupboard-tenant:false:false',
			'upload:cupboard-tenant',
			'upload:cupboard',
			'workers-dev:cupboard-tenant:false:false',
			'queue:cupboard-maintenance',
			'consumer:qid-cupboard-maintenance->cupboard',
			'cron:cupboard:0 * * * *',
			'domain:(none)->cupboard',
			...completedTransitions
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
				...preparedFreshDatabase,
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
				...completedTransitions
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
	])(
		'does not contract a transition when $label',
		async ({ versions, scripts }) => {
			const recording = recordingApi({}, { existing: true });
			const splitApi: CloudflareApi = {
				...recording.api,
				listDeployedVersions: () => Promise.resolve(versions)
			};

			let failure: unknown;

			try {
				await runDeploy({
					artifact,
					api: splitApi,
					now: fixedNow,
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

			// The expansion ran before the upload; the contract waits for the
			// rollout to settle.
			expect({
				scripts: failure.scripts,
				buildVersion: failure.buildVersion,
				applied: appliedMigrations(recording.database),
				transitions: recordedTransitions(recording.database),
				phase: recordedPhase(recording.database)
			}).toStrictEqual({
				scripts,
				buildVersion: artifact.buildVersion,
				applied: ['0000_a.sql', '0002_independent.sql'],
				transitions: {
					'cache-identity': 'expanded@2026-01-01T00:00:00.000Z',
					'deployment-transitions': 'complete@2026-01-01T00:00:00.000Z'
				},
				phase: undefined
			});
		}
	);

	it('does not contract a transition while a tenant is behind its settle step', async () => {
		const recording = recordingApi({}, { existing: true });
		await seedApplied(recording, [expandMigration]);
		insertTenants(recording.database, [
			{ id: 'alpha', localStep: undefined },
			{ id: 'beta', localStep: 1 },
			{ id: 'gamma', localStep: expansionLocalStep }
		]);

		let failure: unknown;

		try {
			await runDeploy({
				artifact,
				api: recording.api,
				now: fixedNow,
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
			applied: appliedMigrations(recording.database),
			transitions: recordedTransitions(recording.database),
			phase: recordedPhase(recording.database)
		}).toStrictEqual({
			pending: 2,
			requiredStep: expansionLocalStep,
			stragglers: ['alpha', 'beta'],
			applied: ['0000_a.sql', '0002_independent.sql'],
			transitions: {
				'cache-identity': 'expanded@2026-01-01T00:00:00.000Z',
				'deployment-transitions': 'complete@2026-01-01T00:00:00.000Z'
			},
			phase: undefined
		});
	});

	it('stops before a migration or an upload when a recorded transition is one this build does not define', async () => {
		const recording = recordingApi({}, { existing: true });
		recording.database.exec(
			"CREATE TABLE deployment_transition (id TEXT PRIMARY KEY NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL); INSERT INTO deployment_transition VALUES ('cache-identity', 'later-state', '2026-01-01T00:00:00.000Z');"
		);

		let failure: unknown;

		try {
			await runDeploy({
				artifact,
				api: recording.api,
				now: fixedNow,
				reporter: silentReporter,
				options: { domain: undefined, secrets: { control: [], tenant: [] } }
			});
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(UnknownDeploymentTransitionError);

		if (!(failure instanceof UnknownDeploymentTransitionError)) {
			return;
		}

		expect({
			transition: failure.transition,
			state: failure.state,
			calls: recording.calls
		}).toStrictEqual({
			transition: 'cache-identity',
			state: 'later-state',
			calls: [
				'r2:cupboard-blobs',
				'lifecycle:cupboard-blobs',
				'queue:cupboard-maintenance',
				'queue:cupboard-maintenance-dlq',
				'd1:cupboard',
				'kv:cupboard-tenant-cache',
				'd1qr:SELECT tbl_n',
				'd1qr:SELECT id ||'
			]
		});
	});

	it('reconciles the phase the preceding release recorded and applies only the new transition', async () => {
		const recording = recordingApi({}, { existing: true });
		await seedApplied(recording, [expandMigration, contractMigration]);
		recording.database.exec(
			"INSERT INTO deployment_phase VALUES ('current', 'contracted', 5, '2025-12-01T00:00:00.000Z')"
		);
		const facts: [string, unknown][] = [];

		await runDeploy({
			artifact,
			api: recording.api,
			now: fixedNow,
			reporter: factReporter(facts),
			options: { domain: undefined, secrets: { control: [], tenant: [] } }
		});

		expect({
			facts,
			serving: recording.calls.filter((call) => call.startsWith('versions:')),
			applied: appliedMigrations(recording.database),
			transitions: recordedTransitions(recording.database),
			phase: recordedPhase(recording.database)
		}).toStrictEqual({
			facts: [
				['resources', 5],
				['cache-identity', 'complete (from the recorded phase)'],
				['deployment-transitions', 'expanded · applied 1'],
				['deployment-transitions', 'complete · applied 0'],
				['build', 'abc123def456']
			],
			// Nothing is pending after the upload, so the rollout is not checked.
			serving: [],
			applied: ['0000_a.sql', '0001_contract.sql', '0002_independent.sql'],
			transitions: {
				'cache-identity': 'complete@2026-01-01T00:00:00.000Z',
				'deployment-transitions': 'complete@2026-01-01T00:00:00.000Z'
			},
			phase: 'contracted'
		});
	});

	it('leaves a completed deployment as it is when the deploy is run again', async () => {
		const recording = recordingApi({}, { existing: true });
		const first: [string, unknown][] = [];
		const second: [string, unknown][] = [];

		await runDeploy({
			artifact,
			api: recording.api,
			now: fixedNow,
			reporter: factReporter(first),
			options: { domain: undefined, secrets: { control: [], tenant: [] } }
		});
		const afterFirst = recordedTransitions(recording.database);
		recording.calls.length = 0;

		await runDeploy({
			artifact,
			api: recording.api,
			reporter: factReporter(second),
			now: () => new Date('2026-02-01T00:00:00.000Z'),
			options: { domain: undefined, secrets: { control: [], tenant: [] } }
		});

		expect({
			first,
			second,
			afterFirst,
			afterSecond: recordedTransitions(recording.database),
			rerun: recording.calls.filter(
				(call) =>
					call.startsWith('upload:') ||
					call.startsWith('versions:') ||
					call === 'd1q:ALTER TABLE '
			)
		}).toStrictEqual({
			first: [
				['resources', 5],
				['cache-identity', 'expanded · applied 1'],
				['deployment-transitions', 'expanded · applied 1'],
				['deployment-transitions', 'complete · applied 0'],
				['build', 'abc123def456'],
				['cache-identity', 'expanded · applied 0'],
				[
					'cache-identity',
					`tenants at local step ${String(expansionLocalStep)}`
				],
				['cache-identity', 'complete · applied 1']
			],
			second: [
				['resources', 5],
				['build', 'abc123def456']
			],
			afterFirst: {
				'cache-identity': 'complete@2026-01-01T00:00:00.000Z',
				'deployment-transitions': 'complete@2026-01-01T00:00:00.000Z'
			},
			afterSecond: {
				'cache-identity': 'complete@2026-01-01T00:00:00.000Z',
				'deployment-transitions': 'complete@2026-01-01T00:00:00.000Z'
			},
			rerun: []
		});
	});
});

describe('contraction within a deploy', () => {
	it('contracts after both Workers settle and records the transition complete afterwards', async () => {
		const recording = recordingApi({}, { existing: true });
		const events: string[] = [];
		const observed: CloudflareApi = {
			...recording.api,
			async uploadScript(name, metadata, bundle) {
				events.push(`upload:${name}`);
				return recording.api.uploadScript(name, metadata, bundle);
			},
			async listDeployedVersions(name) {
				events.push(`settle:${name}`);
				return recording.api.listDeployedVersions(name);
			},
			async d1QueryBatch(database, statements) {
				for (const statement of statements) {
					if (statement === contractMigration.statements[0]) {
						events.push('contract');
					}
					if (statement.startsWith('INSERT INTO deployment_phase')) {
						events.push(
							statement.includes("VALUES ('current', 'native-reads'")
								? 'phase:native-reads'
								: 'phase:contracted'
						);
					}
					if (
						statement.startsWith('INSERT INTO deployment_transition') &&
						statement.includes("'cache-identity'")
					) {
						events.push(
							statement.includes("VALUES ('cache-identity', 'complete'")
								? 'cache-identity:complete'
								: 'cache-identity:expanded'
						);
					}
				}
				return recording.api.d1QueryBatch(database, statements);
			}
		};
		await runDeploy({
			artifact,
			api: observed,
			now: fixedNow,
			reporter: silentReporter,
			options: { domain: undefined, secrets: { control: [], tenant: [] } }
		});
		expect(events).toStrictEqual([
			'cache-identity:expanded',
			'upload:cupboard-tenant',
			'upload:cupboard',
			'settle:cupboard',
			'settle:cupboard-tenant',
			'phase:native-reads',
			'contract',
			'cache-identity:complete',
			'phase:contracted'
		]);
	});
});

describe('automatic tenant settlement', () => {
	it('settles the transition step before its contract and the current step afterwards', async () => {
		const recording = recordingApi({}, { existing: true });
		await seedApplied(recording, [expandMigration]);
		insertTenants(recording.database, [{ id: 'alpha', localStep: undefined }]);
		const steps: number[] = [];
		await runDeploy({
			artifact,
			api: recording.api,
			settleTenants: (requiredStep) => {
				steps.push(requiredStep);
				recording.database
					.prepare('UPDATE tenant SET local_step = ?')
					.run(requiredStep);
				return Promise.resolve();
			},
			now: fixedNow,
			reporter: silentReporter,
			options: { domain: undefined, secrets: { control: [], tenant: [] } }
		});
		expect({
			steps,
			transitions: recordedTransitions(recording.database)
		}).toStrictEqual({
			steps: [expansionLocalStep, currentLocalStep],
			transitions: {
				'cache-identity': 'complete@2026-01-01T00:00:00.000Z',
				'deployment-transitions': 'complete@2026-01-01T00:00:00.000Z'
			}
		});
	});
});

describe('refused deployments', () => {
	it('rejects a migration outside the transitions before changing D1 or uploading a Worker', async () => {
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
				now: fixedNow,
				reporter: silentReporter,
				options: { domain: undefined, secrets: { control: [], tenant: [] } }
			})
		).rejects.toBeInstanceOf(MisclassifiedD1MigrationsError);
		expect(
			calls.filter(
				(call) => call.startsWith('d1q:') || call.startsWith('upload:')
			)
		).toStrictEqual([]);
	});
});

describe('reviewed deployment plan', () => {
	const releaseMigrations = schemaTransitions
		.flatMap((transition) => [...transition.expand, ...transition.contract])
		.map((name) => ({ name, sha256: 'digest', statements: ['SELECT 1;'] }));

	it.each([
		{ override: 'paid' as const, allowance: '10000' },
		{ override: 'free' as const, allowance: '1000' }
	])(
		'applies the explicit $override allowance in an offline plan',
		({ override, allowance }) => {
			const plan = planOfflineDeployment(
				{ ...artifact, d1Migrations: releaseMigrations },
				override
			);
			expect({
				control:
					plan.artifact.config.control.vars.CUPBOARD_SUBREQUESTS_PER_INVOCATION,
				tenant:
					plan.artifact.config.tenant.vars.CUPBOARD_SUBREQUESTS_PER_INVOCATION,
				observation: plan.observation
			}).toStrictEqual({
				control: allowance,
				tenant: allowance,
				observation: { kind: 'offline' }
			});
		}
	);

	it("keeps every transition's migrations in the reviewed execution plan", () => {
		const source = { ...artifact, d1Migrations: releaseMigrations };
		const plan = planDeployment(source, { kind: 'new' });
		expect({
			transitions: plan.transitions.map((planned) => ({
				id: planned.transition.id,
				expand: planned.expand.map((migration) => migration.name),
				contract: planned.contract.map((migration) => migration.name)
			})),
			artifact: plan.artifact
		}).toStrictEqual({
			transitions: schemaTransitions.map((transition) => ({
				id: transition.id,
				expand: transition.expand,
				contract: transition.contract
			})),
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

	it.each([
		{
			name: 'an offline plan',
			observation: { kind: 'offline' as const },
			stage:
				'unknown (offline); expand before upload: 0000_a.sql; contract after upload once every tenant reaches local step 4: 0001_contract.sql',
			readiness: 'unknown (offline)'
		},
		{
			name: 'a new deployment',
			observation: { kind: 'new' as const },
			stage: 'new deployment; expand and contract before upload',
			readiness: 'no existing tenants'
		},
		{
			name: 'a deployment that recorded nothing',
			observation: {
				kind: 'existing' as const,
				transitions: new Map(),
				readiness: { pending: 2, stragglers: ['alpha', 'beta'] }
			},
			stage:
				'pending; expand before upload: 0000_a.sql; contract after upload once every tenant reaches local step 4: 0001_contract.sql',
			readiness: '2 pending at local step 4'
		},
		{
			name: 'an expanded deployment',
			observation: {
				kind: 'existing' as const,
				transitions: new Map([
					['cache-identity' as const, 'expanded' as const]
				]),
				readiness: { pending: 0, stragglers: [] }
			},
			stage:
				'expanded; contract after upload once every tenant reaches local step 4: 0001_contract.sql',
			readiness: '0 pending at local step 4'
		},
		{
			name: 'a complete deployment',
			observation: {
				kind: 'existing' as const,
				transitions: new Map([
					['cache-identity' as const, 'complete' as const]
				]),
				readiness: { pending: 0, stragglers: [] }
			},
			stage: 'complete',
			readiness: '0 pending at local step 5'
		}
	])(
		'describes the cache-identity transition for $name',
		({ observation, stage, readiness }) => {
			const rows = transitionPlanRows({
				artifact,
				allowanceSource: { kind: 'offline' },
				observation,
				transitions: planTransitions(artifact.d1Migrations, testTransitions)
			});

			expect(
				rows.filter(
					(row) =>
						row.label === 'Transition cache-identity' ||
						row.label === 'Tenant readiness'
				)
			).toStrictEqual([
				{ label: 'Transition cache-identity', value: stage },
				{ label: 'Tenant readiness', value: readiness }
			]);
		}
	);
});
