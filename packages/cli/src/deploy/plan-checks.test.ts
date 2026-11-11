import { readdir, readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import type { HostnameWorkers, ScriptConfiguration } from './cloudflare-api.ts';
import { parseDeploymentConfig } from './config.ts';
import { deploymentNameSchema, withDeploymentName } from './deployment-name.ts';
import type { DomainChange } from './existing-deployment.ts';
import {
	databaseIdSchema,
	kvNamespaceIdSchema,
	scriptNameSchema,
	zoneIdSchema
} from './identifiers.ts';
import { type D1Migration, parseD1Migrations } from './migrations.ts';
import { renameResource } from './overrides.ts';
import {
	accountScanCache,
	type AccountWorkers,
	AccountWorkersUnlistedError,
	bookkeepingTables,
	checkPlan,
	DomainServedByOtherWorkerError,
	DomainZoneUnavailableError,
	type PlanArtifact,
	type PlanCheck,
	type PlanCheckApi,
	ResourceOfOtherWorkerError,
	RoutesPermissionRequiredError,
	scanAccountWorkers,
	UnrecognisedDatabaseError,
	UnrecognisedResourceError,
	UnrecognisedWorkerError,
	WorkerBindingsUnreadableError
} from './plan-checks.ts';

function serverSource(file: string): Promise<string> {
	return readFile(new URL(`../../../server/${file}`, import.meta.url), 'utf8');
}

async function serverMigrations(directory: string): Promise<D1Migration[]> {
	const entries = await readdir(
		new URL(`../../../server/${directory}`, import.meta.url)
	);

	return parseD1Migrations(
		await Promise.all(
			entries
				.filter((name) => name.endsWith('.sql'))
				.map(async (name) => ({
					name,
					sql: await serverSource(`${directory}/${name}`)
				}))
		)
	);
}

const releaseConfig = parseDeploymentConfig(
	await serverSource('wrangler.jsonc'),
	await serverSource('wrangler.tenant.jsonc')
);
const sharedMigrations = await serverMigrations('drizzle-d1');
const controlMigrations = await serverMigrations('drizzle-control-d1');
const named = (name: string | undefined): PlanArtifact => ({
	config: withDeploymentName(
		releaseConfig,
		name === undefined ? undefined : deploymentNameSchema.parse(name)
	),
	d1Migrations: sharedMigrations,
	d1MigrationSets: {
		CUPBOARD_DB: sharedMigrations,
		CONTROL_DB: controlMigrations
	}
});
const release = named(undefined);
const staging = named('staging');
const firstSharedMigration =
	sharedMigrations
		.map((migration) => migration.name)
		.toSorted((left, right) => left.localeCompare(right))[0] ?? '';
const script = (value: string) => scriptNameSchema.parse(value);
const bindingsFailure = new Error('settings unavailable');

const cupboardControlBindings: readonly unknown[] = [
	{
		type: 'durable_object_namespace',
		name: 'CUPBOARD_DO',
		class_name: 'CupboardServer',
		script_name: 'cupboard-tenant'
	},
	{ type: 'r2_bucket', name: 'BLOBS', bucket_name: 'cupboard-blobs' },
	{ type: 'd1', name: 'CUPBOARD_DB', database_id: 'cupboard' },
	{ type: 'd1', name: 'CONTROL_DB', database_id: 'cupboard-control' },
	{ type: 'kv_namespace', name: 'TENANT_CACHE', namespace_id: 'kv-tenant' },
	{ type: 'kv_namespace', name: 'CRON_STATE', namespace_id: 'kv-cron' },
	{
		type: 'queue',
		name: 'MAINTENANCE_QUEUE',
		queue_name: 'cupboard-maintenance'
	}
];
const cupboardTenantBindings: readonly unknown[] = [
	{
		type: 'durable_object_namespace',
		name: 'CUPBOARD_DO',
		class_name: 'CupboardServer'
	}
];
const unrelatedBindings: readonly unknown[] = [
	{ type: 'kv_namespace', name: 'CACHE' }
];

/**
A D1 database: its tables, and the names that its `d1_migrations` table
records.
*/
interface FakeDatabase {
	readonly tables: readonly string[];
	readonly migrations?: readonly string[];
}

interface FakeAccount {
	/**
	The live bindings of each deployed script, by script name.
	*/
	readonly scripts?: Readonly<Record<string, readonly unknown[]>>;
	/**
	Each existing D1 database, by database name.
	*/
	readonly databases?: Readonly<Record<string, FakeDatabase>>;
	/**
	Each existing bucket and queue, by name, and whether it is in use.
	*/
	readonly buckets?: Readonly<Record<string, boolean>>;
	readonly queues?: Readonly<Record<string, boolean>>;
	/**
	Each existing KV namespace, by title.
	*/
	readonly namespaces?: Readonly<
		Record<string, { readonly id: string; readonly isUsed: boolean }>
	>;
	/**
	The dead-letter queue of the control Worker's consumer, by the queue that
	the consumer reads.
	*/
	readonly deadLetters?: Readonly<Record<string, string>>;
	/**
	The Workers whose queue consumers use a queue as their dead-letter queue,
	by the dead-letter queue's name.
	*/
	readonly deadLetterUsers?: Readonly<Record<string, readonly string[]>>;
	readonly hostnameWorkers?: HostnameWorkers;
	/**
	A Worker on the account whose bindings cannot be read.
	*/
	readonly unreadableWorker?: string;
	/**
	Whether the Workers on the account cannot be listed.
	*/
	readonly isUnlisted?: boolean;
	/**
	The custom domains in zones whose Workers routes the token may not list.
	*/
	readonly unreadableRouteHostnames?: readonly string[];
	/**
	The zones that the token can see. `example.com` when absent.
	*/
	readonly zones?: readonly string[];
}

/**
A fake account, and the number of times that the checks read the bindings
of every Worker on it.
*/
function countingApi(account: FakeAccount): {
	api: PlanCheckApi;
	scans: () => number;
} {
	let scans = 0;
	const api = fakeApi(account);

	return {
		api: {
			...api,
			accountWorkers: () => {
				scans += 1;
				return api.accountWorkers();
			}
		},
		scans: () => scans
	};
}

function fakeApi(account: FakeAccount): PlanCheckApi {
	return {
		getScriptConfiguration: (scriptName) => {
			const bindings = account.scripts?.[scriptName];
			const live: ScriptConfiguration | undefined =
				bindings === undefined
					? undefined
					: { bindings, cacheEnabled: false, crossVersionCache: false };

			return Promise.resolve(live);
		},
		findD1Database: (name) =>
			Promise.resolve(
				account.databases?.[name] === undefined
					? undefined
					: databaseIdSchema.parse(name)
			),
		d1QueryRows: (id, sql) => {
			const database = account.databases?.[id];

			return Promise.resolve(
				sql.includes('FROM d1_migrations')
					? [...(database?.migrations ?? [])]
					: [...(database?.tables ?? [])]
			);
		},
		findR2Bucket: (name) => {
			const isUsed = account.buckets?.[name];

			return Promise.resolve(isUsed === undefined ? undefined : { isUsed });
		},
		findQueue: (name) => {
			const isUsed = account.queues?.[name];

			return Promise.resolve(
				isUsed === undefined
					? undefined
					: {
							isUsed,
							deadLetterOf: (account.deadLetterUsers?.[name] ?? []).map(
								(worker) => script(worker)
							)
						}
			);
		},
		findKvNamespace: (title) => {
			const namespace = account.namespaces?.[title];

			return Promise.resolve(
				namespace === undefined
					? undefined
					: {
							id: kvNamespaceIdSchema.parse(namespace.id),
							isUsed: namespace.isUsed
						}
			);
		},
		findConsumerDeadLetterQueue: (queue, scriptName) =>
			Promise.resolve(
				scriptName === 'cupboard' ? account.deadLetters?.[queue] : undefined
			),
		findZoneId: (name) =>
			Promise.resolve(
				(account.zones ?? ['example.com']).includes(name)
					? zoneIdSchema.parse(`zone-${name}`)
					: undefined
			),
		accountWorkers: () =>
			Promise.resolve(
				account.isUnlisted === true
					? { kind: 'unlisted' as const, cause: bindingsFailure }
					: account.unreadableWorker === undefined
						? {
								kind: 'read' as const,
								bindings: new Map(
									Object.entries(account.scripts ?? {}).map(
										([name, bindings]) => [script(name), bindings] as const
									)
								)
							}
						: {
								kind: 'unreadable' as const,
								worker: script(account.unreadableWorker),
								cause: bindingsFailure
							}
			),
		findHostnameWorkers: (hostname, zoneId) => {
			const workers = account.hostnameWorkers ?? {
				customDomain: undefined,
				routes: []
			};

			// Like Cloudflare's, this lists no routes without a zone.
			if (zoneId === undefined) {
				return Promise.resolve({ ...workers, routes: [] });
			}

			return Promise.resolve(
				account.unreadableRouteHostnames?.includes(hostname) === true
					? { ...workers, routes: undefined }
					: workers
			);
		}
	};
}

it('lists the tables that the deploy creates before the first migration', () => {
	expect([...bookkeepingTables]).toStrictEqual([
		'deployment_transition',
		'deployment_phase',
		'd1_migrations'
	]);
});

describe('checkPlan', () => {
	it.each<[string, PlanArtifact, FakeAccount, string | undefined, PlanCheck]>([
		[
			'accepts the default deployment that is already deployed',
			release,
			{
				scripts: {
					cupboard: cupboardControlBindings,
					'cupboard-tenant': cupboardTenantBindings
				},
				databases: {
					cupboard: {
						tables: ['d1_migrations', 'tenant'],
						migrations: sharedMigrations.map((migration) => migration.name)
					},
					'cupboard-control': {
						tables: ['d1_migrations', 'global_admin'],
						migrations: controlMigrations.map((migration) => migration.name)
					}
				},
				buckets: { 'cupboard-blobs': true },
				queues: {
					'cupboard-maintenance': true,
					'cupboard-maintenance-dlq': false
				},
				namespaces: {
					'cupboard-tenant-cache': { id: 'kv-tenant', isUsed: true },
					'cupboard-cron-state': { id: 'kv-cron', isUsed: true }
				},
				deadLetters: { 'cupboard-maintenance': 'cupboard-maintenance-dlq' },
				hostnameWorkers: {
					customDomain: script('cupboard'),
					routes: []
				}
			},
			'cache.example.com',
			{ refusal: undefined, routeWorkers: [] }
		],
		[
			'accepts unused resources that a new deployment will use',
			staging,
			{
				buckets: { 'staging-blobs': false },
				queues: { 'staging-maintenance': false },
				namespaces: { 'staging-cron-state': { id: 'kv-1', isUsed: false } }
			},
			undefined,
			{ refusal: undefined, routeWorkers: [] }
		],
		...(
			[
				['bucket', 'staging-blobs', { buckets: { 'staging-blobs': true } }],
				[
					'queue',
					'staging-maintenance',
					{ queues: { 'staging-maintenance': true } }
				],
				[
					'queue',
					'staging-maintenance-dlq',
					{ queues: { 'staging-maintenance-dlq': true } }
				],
				[
					'kv-namespace',
					'staging-tenant-cache',
					{
						namespaces: {
							'staging-tenant-cache': { id: 'kv-1', isUsed: true }
						}
					}
				]
			] as const
		).map(
			([kind, name, account]): [
				string,
				PlanArtifact,
				FakeAccount,
				undefined,
				PlanCheck
			] => [
				`refuses the ${kind} ${name}, which is in use and which no Worker of the deployment uses`,
				staging,
				account,
				undefined,
				{
					refusal: new UnrecognisedResourceError(kind, name),
					routeWorkers: []
				}
			]
		),
		[
			'accepts a new deployment with an empty database',
			staging,
			{ databases: { staging: { tables: [] } } },
			undefined,
			{ refusal: undefined, routeWorkers: [] }
		],
		[
			'refuses an unrelated Worker with the control Worker name',
			staging,
			{
				scripts: { staging: unrelatedBindings }
			},
			undefined,
			{
				refusal: new UnrecognisedWorkerError(script('staging')),
				routeWorkers: []
			}
		],
		[
			'refuses an unrelated database with a database name',
			staging,
			{ databases: { staging: { tables: ['users', 'orders'] } } },
			undefined,
			{
				refusal: new UnrecognisedDatabaseError('staging', firstSharedMigration),
				routeWorkers: []
			}
		],
		...[release, staging].flatMap(
			(
				artifact
			): [string, PlanArtifact, FakeAccount, undefined, PlanCheck][] => {
				const name = artifact.config.control.name;

				return [
					[
						`accepts the database of ${name} after a first deploy stopped before its migrations`,
						artifact,
						{
							databases: {
								[name]: {
									tables: ['deployment_transition', 'deployment_phase']
								}
							}
						},
						undefined,
						{ refusal: undefined, routeWorkers: [] }
					],
					[
						`accepts the database of ${name} after a first deploy stopped before recording its first migration`,
						artifact,
						{
							databases: {
								[name]: {
									tables: [
										'deployment_transition',
										'deployment_phase',
										'd1_migrations'
									],
									migrations: []
								}
							}
						},
						undefined,
						{ refusal: undefined, routeWorkers: [] }
					]
				];
			}
		),
		[
			"refuses a database that another deployment's Workers use",
			{
				...staging,
				config: renameResource(
					staging.config,
					'database',
					'staging',
					'cupboard'
				)
			},
			{
				scripts: { cupboard: cupboardControlBindings },
				databases: {
					cupboard: {
						tables: ['d1_migrations', 'tenant'],
						migrations: sharedMigrations.map((migration) => migration.name)
					}
				}
			},
			undefined,
			{
				refusal: new ResourceOfOtherWorkerError(
					'database',
					'cupboard',
					script('cupboard')
				),
				routeWorkers: []
			}
		],
		[
			'refuses a database that Wrangler migrated with other migrations',
			staging,
			{
				databases: {
					staging: {
						tables: ['d1_migrations', 'users'],
						migrations: ['0000_users.sql', '0001_orders.sql']
					}
				}
			},
			undefined,
			{
				refusal: new UnrecognisedDatabaseError('staging', firstSharedMigration),
				routeWorkers: []
			}
		],
		[
			'refuses an unrelated Worker with the tenant Worker name',
			named('api'),
			{ scripts: { 'api-tenant': unrelatedBindings } },
			undefined,
			{
				refusal: new UnrecognisedWorkerError(script('api-tenant')),
				routeWorkers: []
			}
		],
		[
			'accepts the tenant Worker of a deployment without its control Worker',
			release,
			{ scripts: { 'cupboard-tenant': cupboardTenantBindings } },
			undefined,
			{ refusal: undefined, routeWorkers: [] }
		],
		[
			"refuses another Worker's custom domain",
			staging,
			{
				hostnameWorkers: {
					customDomain: script('cupboard'),
					routes: []
				}
			},
			'cache.example.com',
			{
				refusal: new DomainServedByOtherWorkerError(
					'cache.example.com',
					script('cupboard')
				),
				routeWorkers: []
			}
		],
		[
			'reports that the routes could not be read without blocking',
			release,
			{
				scripts: { cupboard: cupboardControlBindings },
				hostnameWorkers: { customDomain: script('cupboard'), routes: undefined }
			},
			'cache.example.com',
			{ refusal: undefined, routeWorkers: undefined }
		],
		[
			'reports the Workers of routes without blocking',
			release,
			{
				scripts: { cupboard: cupboardControlBindings },
				hostnameWorkers: {
					customDomain: script('cupboard'),
					routes: [script('router')]
				}
			},
			'cache.example.com',
			{ refusal: undefined, routeWorkers: [script('router')] }
		]
	])('%s', async (_name, artifact, account, domain, expected) => {
		expect(
			await checkPlan(fakeApi(account), artifact, domain, undefined)
		).toStrictEqual(expected);
	});
});

describe('checkPlan for resources that another deployment uses', () => {
	const renamed = (
		kind: 'bucket' | 'queue',
		from: string,
		to: string
	): PlanArtifact => ({
		...staging,
		config: renameResource(staging.config, kind, from, to)
	});
	const recognisedCupboard: FakeDatabase = {
		tables: ['d1_migrations', 'tenant'],
		migrations: sharedMigrations.map((migration) => migration.name)
	};

	it.each<[string, PlanArtifact, FakeAccount, PlanCheck]>([
		[
			"refuses an empty bucket that another deployment's Worker binds",
			renamed('bucket', 'staging-blobs', 'cupboard-blobs'),
			{
				scripts: { cupboard: cupboardControlBindings },
				buckets: { 'cupboard-blobs': false }
			},
			{
				refusal: new ResourceOfOtherWorkerError(
					'bucket',
					'cupboard-blobs',
					script('cupboard')
				),
				routeWorkers: []
			}
		],
		[
			"refuses an unused queue that another deployment's Worker binds",
			renamed('queue', 'staging-maintenance', 'cupboard-maintenance'),
			{
				scripts: { cupboard: cupboardControlBindings },
				queues: { 'cupboard-maintenance': false }
			},
			{
				refusal: new ResourceOfOtherWorkerError(
					'queue',
					'cupboard-maintenance',
					script('cupboard')
				),
				routeWorkers: []
			}
		],
		[
			"refuses the dead-letter queue of another deployment's consumer",
			renamed('queue', 'staging-maintenance-dlq', 'cupboard-maintenance-dlq'),
			{
				scripts: { cupboard: cupboardControlBindings },
				queues: { 'cupboard-maintenance-dlq': false },
				deadLetterUsers: { 'cupboard-maintenance-dlq': ['cupboard'] }
			},
			{
				refusal: new ResourceOfOtherWorkerError(
					'queue',
					'cupboard-maintenance-dlq',
					script('cupboard')
				),
				routeWorkers: []
			}
		],
		[
			'refuses a database that another Worker binds by an `id` field',
			{
				...staging,
				config: renameResource(
					staging.config,
					'database',
					'staging',
					'cupboard'
				)
			},
			{
				scripts: {
					other: [{ type: 'd1', name: 'DB', id: 'cupboard' }]
				},
				databases: { cupboard: recognisedCupboard }
			},
			{
				refusal: new ResourceOfOtherWorkerError(
					'database',
					'cupboard',
					script('other')
				),
				routeWorkers: []
			}
		],
		[
			'refuses an empty database that another Worker binds',
			staging,
			{
				scripts: {
					analytics: [{ type: 'd1', name: 'DB', database_id: 'staging' }]
				},
				databases: { staging: { tables: [] } }
			},
			{
				refusal: new ResourceOfOtherWorkerError(
					'database',
					'staging',
					script('analytics')
				),
				routeWorkers: []
			}
		],
		[
			'accepts a cupboard database that no other Worker binds',
			release,
			{
				scripts: { other: unrelatedBindings },
				databases: { cupboard: recognisedCupboard }
			},
			{ refusal: undefined, routeWorkers: [] }
		],
		[
			'refuses the plan when the Workers cannot be listed',
			release,
			{ databases: { cupboard: recognisedCupboard }, isUnlisted: true },
			{
				refusal: new AccountWorkersUnlistedError({ cause: bindingsFailure }),
				routeWorkers: []
			}
		],
		[
			"refuses the plan when a Worker's bindings cannot be read",
			release,
			{
				databases: { cupboard: recognisedCupboard },
				unreadableWorker: 'other'
			},
			{
				refusal: new WorkerBindingsUnreadableError(script('other'), {
					cause: bindingsFailure
				}),
				routeWorkers: []
			}
		]
	])('%s', async (_name, artifact, account, expected) => {
		expect(
			await checkPlan(fakeApi(account), artifact, undefined, undefined)
		).toStrictEqual(expected);
	});

	it("does not read the account's Workers when the deployment's Workers bind every resource", async () => {
		const { api, scans } = countingApi({
			scripts: {
				cupboard: cupboardControlBindings,
				'cupboard-tenant': cupboardTenantBindings
			},
			databases: {
				cupboard: recognisedCupboard,
				'cupboard-control': {
					tables: ['d1_migrations', 'global_admin'],
					migrations: controlMigrations.map((migration) => migration.name)
				}
			},
			buckets: { 'cupboard-blobs': true },
			queues: {
				'cupboard-maintenance': true,
				'cupboard-maintenance-dlq': false
			},
			deadLetters: { 'cupboard-maintenance': 'cupboard-maintenance-dlq' }
		});

		expect({
			check: await checkPlan(api, release, undefined, undefined),
			scans: scans()
		}).toStrictEqual({
			check: { refusal: undefined, routeWorkers: [] },
			scans: 0
		});
	});
});

describe('checkPlan when the token may not list routes', () => {
	const account = (
		unreadable: readonly string[],
		customDomain: string | undefined
	): FakeAccount => ({
		scripts: {
			cupboard: cupboardControlBindings,
			'cupboard-tenant': cupboardTenantBindings
		},
		hostnameWorkers: {
			customDomain:
				customDomain === undefined ? undefined : script(customDomain),
			routes: []
		},
		unreadableRouteHostnames: unreadable
	});

	it.each<
		[
			string,
			FakeAccount,
			string | undefined,
			DomainChange | undefined,
			PlanCheck
		]
	>([
		[
			'warns when the deployment keeps the domain that it serves',
			account(['cache.example.com'], 'cupboard'),
			'cache.example.com',
			undefined,
			{ refusal: undefined, routeWorkers: undefined }
		],
		[
			'refuses to attach a first custom domain',
			account(['cache.example.com'], undefined),
			'cache.example.com',
			{ kind: 'first-domain', from: [], to: 'cache.example.com' },
			{
				refusal: new RoutesPermissionRequiredError(
					'cache.example.com',
					'attach'
				),
				routeWorkers: undefined
			}
		],
		[
			'refuses a move that removes a domain in another zone',
			{
				...account(['old.example.net'], undefined),
				zones: ['example.com', 'example.net']
			},
			'cache.example.com',
			{ kind: 'move', from: ['old.example.net'], to: 'cache.example.com' },
			{
				refusal: new RoutesPermissionRequiredError('old.example.net', 'remove'),
				routeWorkers: []
			}
		],
		[
			'accepts a removal while the kept, attached domain has no visible zone',
			{ ...account([], 'cupboard'), zones: ['example.net'] },
			'a.example.com',
			{
				kind: 'removal',
				from: ['a.example.com', 'b.example.net'],
				to: 'a.example.com'
			},
			{ refusal: undefined, routeWorkers: [] }
		],
		[
			'refuses a move off a domain in a zone that the token cannot see',
			account([], undefined),
			'cache.example.com',
			{ kind: 'move', from: ['old.example.org'], to: 'cache.example.com' },
			{
				refusal: new DomainZoneUnavailableError('old.example.org', 'remove'),
				routeWorkers: []
			}
		],
		[
			'refuses to attach a domain in a zone that the token cannot see',
			account([], undefined),
			'cache.example.org',
			{ kind: 'first-domain', from: [], to: 'cache.example.org' },
			{
				refusal: new DomainZoneUnavailableError('cache.example.org', 'attach'),
				routeWorkers: []
			}
		],
		[
			'refuses a deploy without --domain that removes the second of two domains',
			account(['old.example.com'], 'cupboard'),
			'cache.example.com',
			{
				kind: 'removal',
				from: ['cache.example.com', 'old.example.com'],
				to: 'cache.example.com'
			},
			{
				refusal: new RoutesPermissionRequiredError('old.example.com', 'remove'),
				routeWorkers: []
			}
		],
		[
			'refuses a plan that clears the custom domain',
			account(['cache.example.com'], 'cupboard'),
			undefined,
			{ kind: 'move', from: ['cache.example.com'], to: undefined },
			{
				refusal: new RoutesPermissionRequiredError(
					'cache.example.com',
					'remove'
				),
				routeWorkers: []
			}
		]
	])('%s', async (_name, fake, domain, domainChange, expected) => {
		expect(
			await checkPlan(fakeApi(fake), release, domain, domainChange)
		).toStrictEqual(expected);
	});
});

describe('scanAccountWorkers', () => {
	const many = Array.from(
		{ length: 8 },
		(_unused, index) => `w${String(index)}`
	);

	it.each<
		[string, readonly string[], boolean, AccountWorkers, readonly string[]]
	>([
		[
			"reads the bindings of every Worker except the deployment's own",
			[],
			false,
			{
				kind: 'read',
				bindings: new Map(many.map((name) => [script(name), unrelatedBindings]))
			},
			many
		],
		[
			'starts no more reads after a Worker whose bindings cannot be read',
			['w0'],
			false,
			{ kind: 'unreadable', worker: script('w0'), cause: bindingsFailure },
			many.slice(0, 6)
		],
		[
			'reports that the Workers could not be listed',
			[],
			true,
			{ kind: 'unlisted', cause: bindingsFailure },
			[]
		]
	])('%s', async (_name, failing, isUnlisted, expected, read) => {
		const reads: string[] = [];
		const scan = await scanAccountWorkers(
			{
				listScriptNames: () =>
					isUnlisted
						? Promise.reject(bindingsFailure)
						: Promise.resolve(
								['cupboard', ...many].map((name) => script(name))
							),
				getScriptConfiguration: (name) => {
					reads.push(name);

					return failing.includes(name)
						? Promise.reject(bindingsFailure)
						: Promise.resolve({
								bindings: unrelatedBindings,
								cacheEnabled: false,
								crossVersionCache: false
							});
				}
			},
			new Set(['cupboard'])
		);

		expect({ scan, reads }).toStrictEqual({ scan: expected, reads: [...read] });
	});
});

describe('accountScanCache', () => {
	const read: AccountWorkers = { kind: 'read', bindings: new Map() };

	it.each<[string, () => Promise<AccountWorkers>, number]>([
		['keeps a scan that read the Workers', () => Promise.resolve(read), 1],
		[
			'reads again after a Worker could not be read',
			() =>
				Promise.resolve({
					kind: 'unreadable',
					worker: script('other'),
					cause: bindingsFailure
				}),
			2
		],
		[
			'reads again after the Workers could not be listed',
			() => Promise.resolve({ kind: 'unlisted', cause: bindingsFailure }),
			2
		],
		[
			'reads again after the scan failed',
			() => Promise.reject(bindingsFailure),
			2
		]
	])('%s', async (_name, result, expectedScans) => {
		let scans = 0;
		const cached = accountScanCache((_account: string) => {
			scans += 1;
			return result();
		});
		const settle = async (): Promise<void> => {
			try {
				await cached('acc-1');
			} catch {
				// A rejected scan is one of the cases.
			}

			await new Promise((resolve) => {
				setImmediate(resolve);
			});
		};

		await settle();
		await settle();

		expect(scans).toBe(expectedScans);
	});
});
