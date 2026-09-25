import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import type { ScriptConfiguration } from './cloudflare-api.ts';
import { type DeploymentConfig, parseDeploymentConfig } from './config.ts';
import {
	DeadLetterQueueLoopError,
	DuplicateDefaultResourceNameError,
	type ExistingDeploymentApi,
	readExistingConfig,
	type StartingPlan,
	startingPlanLookup
} from './existing-deployment.ts';
import {
	type CloudflareAccountId,
	cloudflareAccountIdSchema,
	databaseIdSchema
} from './identifiers.ts';
import { renameResources, withCrons } from './overrides.ts';

const defaults = parseDeploymentConfig(
	`{
		"name": "cupboard",
		"compatibility_date": "2026-05-15",
		"r2_buckets": [{ "binding": "BLOBS", "bucket_name": "cupboard-blobs" }],
		"d1_databases": [{ "binding": "DB", "database_name": "cupboard" }],
		"queues": {
			"producers": [{ "binding": "Q", "queue": "cupboard-maintenance" }],
			"consumers": [
				{
					"queue": "cupboard-maintenance",
					"dead_letter_queue": "cupboard-maintenance-dlq"
				}
			]
		},
		"triggers": { "crons": ["0 * * * *"] }
	}`,
	`{
		"name": "cupboard-tenant",
		"compatibility_date": "2026-05-15",
		"r2_buckets": [{ "binding": "BLOBS", "bucket_name": "cupboard-blobs" }],
		"d1_databases": [{ "binding": "DB", "database_name": "cupboard" }]
	}`
);

const liveDatabaseId = databaseIdSchema.parse('live-database');

const accountId = (value: string): CloudflareAccountId =>
	cloudflareAccountIdSchema.parse(value);

function isControlWorker(scriptName: string): boolean {
	return scriptName === defaults.control.name;
}

function serverSource(file: string): Promise<string> {
	return readFile(new URL(`../../../server/${file}`, import.meta.url), 'utf8');
}

async function releaseConfig(): Promise<DeploymentConfig> {
	return parseDeploymentConfig(
		await serverSource('wrangler.jsonc'),
		await serverSource('wrangler.tenant.jsonc')
	);
}

function missing(
	tenantNames: readonly string[],
	controlNames: readonly string[]
): string[] {
	return tenantNames.filter((name) => !controlNames.includes(name));
}

interface FakeAccount {
	readonly bindings?: readonly unknown[];
	readonly schedules?: readonly string[];
	readonly databaseName?: string;
	/**
	The dead-letter queue of the control Worker's consumer, keyed by the name of
	the queue that the consumer reads.
	*/
	readonly deadLetters?: Readonly<Record<string, string>>;
	readonly customDomain?: string;
}

/**
 * Reports `account` for the control Worker and reports every other script as
 * undeployed. Code that reads the tenant Worker therefore gets the defaults,
 * and the assertions on renamed values fail.
 */
function fakeApi(account: FakeAccount): ExistingDeploymentApi {
	const control: ScriptConfiguration | undefined =
		account.bindings === undefined
			? undefined
			: {
					bindings: account.bindings,
					cacheEnabled: false,
					crossVersionCache: false
				};

	return {
		getScriptConfiguration: (scriptName) =>
			Promise.resolve(isControlWorker(scriptName) ? control : undefined),
		listSchedules: (scriptName) =>
			Promise.resolve(
				isControlWorker(scriptName) ? [...(account.schedules ?? [])] : []
			),
		findD1DatabaseName: (id) =>
			Promise.resolve(id === liveDatabaseId ? account.databaseName : undefined),
		findConsumerDeadLetterQueue: (queue, scriptName) =>
			Promise.resolve(
				isControlWorker(scriptName) ? account.deadLetters?.[queue] : undefined
			),
		findCustomDomain: (scriptName) =>
			Promise.resolve(
				isControlWorker(scriptName) ? account.customDomain : undefined
			)
	};
}

describe('readExistingConfig', () => {
	it('is undefined before the control Worker is deployed', async () => {
		await expect(
			readExistingConfig(fakeApi({}), defaults)
		).resolves.toBeUndefined();
	});

	it("reads the resource names and schedules from the control Worker's deployment", async () => {
		const existing = await readExistingConfig(
			fakeApi({
				bindings: [
					{ type: 'r2_bucket', name: 'BLOBS', bucket_name: 'my-blobs' },
					{ type: 'd1', name: 'DB', database_id: liveDatabaseId },
					{ type: 'queue', name: 'Q', queue_name: 'my-queue' },
					{ type: 'plain_text', name: 'UNRELATED', text: '' }
				],
				databaseName: 'my-database',
				deadLetters: { 'my-queue': 'my-dead-letters' },
				schedules: ['*/10 * * * *']
			}),
			defaults
		);
		const renamed = renameResources(defaults, {
			bucket: new Map([['cupboard-blobs', 'my-blobs']]),
			database: new Map([['cupboard', 'my-database']]),
			queue: new Map([
				['cupboard-maintenance', 'my-queue'],
				['cupboard-maintenance-dlq', 'my-dead-letters']
			])
		});

		expect(existing).toStrictEqual(withCrons(renamed, ['*/10 * * * *']));
	});

	it('keeps the defaults for a deployment that uses them', async () => {
		const existing = await readExistingConfig(
			fakeApi({
				bindings: [
					{ type: 'r2_bucket', name: 'BLOBS', bucket_name: 'cupboard-blobs' },
					{ type: 'd1', name: 'DB', database_id: liveDatabaseId },
					{ type: 'queue', name: 'Q', queue_name: 'cupboard-maintenance' }
				],
				databaseName: 'cupboard',
				deadLetters: { 'cupboard-maintenance': 'cupboard-maintenance-dlq' },
				schedules: ['0 * * * *']
			}),
			defaults
		);

		expect(existing).toStrictEqual(defaults);
	});

	it.each<[string, FakeAccount]>([
		['the control Worker has no bindings', { bindings: [] }],
		[
			'the bound database id matches no database',
			{
				bindings: [{ type: 'd1', name: 'DB', database_id: 'deleted-database' }]
			}
		],
		[
			'the consumer has no dead-letter queue',
			{
				bindings: [
					{ type: 'queue', name: 'Q', queue_name: 'cupboard-maintenance' }
				],
				deadLetters: {}
			}
		]
	])('keeps the defaults when %s', async (_name, account) => {
		const existing = await readExistingConfig(fakeApi(account), defaults);

		expect(existing).toStrictEqual(defaults);
	});

	it('resolves the database from a D1 binding that has only an `id` field', async () => {
		const existing = await readExistingConfig(
			fakeApi({
				bindings: [{ type: 'd1', name: 'DB', id: liveDatabaseId }],
				databaseName: 'my-database'
			}),
			defaults
		);

		expect(existing).toStrictEqual(
			renameResources(defaults, {
				database: new Map([['cupboard', 'my-database']])
			})
		);
	});

	it.each<[string, readonly string[], readonly string[]]>([
		[
			'keeps the default cron triggers when the schedule list is empty',
			[],
			['0 * * * *']
		],
		[
			'uses the cron triggers from a non-empty schedule list',
			['*/10 * * * *', '30 2 * * *'],
			['*/10 * * * *', '30 2 * * *']
		]
	])('%s', async (_name, schedules, crons) => {
		const existing = await readExistingConfig(
			fakeApi({ bindings: [], schedules }),
			defaults
		);

		expect(existing).toStrictEqual(withCrons(defaults, crons));
	});

	it('renames the producer queue once when its live name equals the default dead-letter queue name', async () => {
		const existing = await readExistingConfig(
			fakeApi({
				bindings: [
					{ type: 'queue', name: 'Q', queue_name: 'cupboard-maintenance-dlq' }
				],
				deadLetters: { 'cupboard-maintenance-dlq': 'custom-dlq' }
			}),
			defaults
		);

		expect(existing).toStrictEqual({
			...defaults,
			control: {
				...defaults.control,
				queueProducers: [{ binding: 'Q', queue: 'cupboard-maintenance-dlq' }],
				queueConsumers: defaults.control.queueConsumers.map((consumer) => ({
					...consumer,
					queue: 'cupboard-maintenance-dlq',
					deadLetterQueue: 'custom-dlq'
				}))
			}
		});
	});

	it('rejects a plan that would make the maintenance queue its own dead-letter queue', async () => {
		await expect(
			readExistingConfig(
				fakeApi({
					bindings: [
						{ type: 'queue', name: 'Q', queue_name: 'cupboard-maintenance-dlq' }
					],
					deadLetters: {}
				}),
				defaults
			)
		).rejects.toStrictEqual(
			new DeadLetterQueueLoopError('cupboard-maintenance-dlq')
		);
	});

	it('rejects a release configuration that uses one bucket name for two bindings', async () => {
		const duplicated = parseDeploymentConfig(
			`{
				"name": "cupboard",
				"compatibility_date": "2026-05-15",
				"r2_buckets": [
					{ "binding": "BLOBS", "bucket_name": "cupboard-blobs" },
					{ "binding": "STAGING", "bucket_name": "cupboard-blobs" }
				]
			}`,
			`{ "name": "cupboard-tenant", "compatibility_date": "2026-05-15" }`
		);

		await expect(
			readExistingConfig(fakeApi({ bindings: [] }), duplicated)
		).rejects.toStrictEqual(
			new DuplicateDefaultResourceNameError('bucket', 'cupboard-blobs')
		);
	});
});

describe('release configuration', () => {
	it('uses each default name once per kind', async () => {
		const release = await releaseConfig();

		await expect(
			readExistingConfig(fakeApi({ bindings: [] }), release)
		).resolves.toStrictEqual(release);
	});

	// readExistingConfig reads only the control Worker's bindings and applies
	// the renames to both Workers. A tenant resource that the control Worker
	// does not bind would be reset to its default name on every deploy.
	it('binds every tenant bucket, database and queue on the control Worker', async () => {
		const { control, tenant } = await releaseConfig();

		expect({
			buckets: missing(
				tenant.r2Buckets.map((bucket) => bucket.bucketName),
				control.r2Buckets.map((bucket) => bucket.bucketName)
			),
			databases: missing(
				tenant.d1Databases.map((database) => database.databaseName),
				control.d1Databases.map((database) => database.databaseName)
			),
			queues: missing(
				tenant.queueProducers.map((producer) => producer.queue),
				control.queueProducers.map((producer) => producer.queue)
			)
		}).toStrictEqual({ buckets: [], databases: [], queues: [] });
	});
});

describe('startingPlanLookup', () => {
	const deployedAccount = accountId('deployed');
	const freshAccount = accountId('fresh');
	const deployed: FakeAccount = {
		bindings: [{ type: 'r2_bucket', name: 'BLOBS', bucket_name: 'my-blobs' }],
		customDomain: 'cache.example.com'
	};
	const lookup = (reads: CloudflareAccountId[] = []) =>
		startingPlanLookup({
			apiFor: (account) => {
				reads.push(account);

				return fakeApi(account === deployedAccount ? deployed : {});
			},
			defaults,
			phase: (_label, read) => read()
		});

	it.each<[string, CloudflareAccountId, StartingPlan]>([
		[
			'starts from the existing deployment and its routed custom domain',
			deployedAccount,
			{
				config: renameResources(defaults, {
					bucket: new Map([['cupboard-blobs', 'my-blobs']])
				}),
				routedDomain: 'cache.example.com'
			}
		],
		[
			'starts from the defaults on an account without a control Worker',
			freshAccount,
			{ config: defaults, routedDomain: undefined }
		]
	])('%s', async (_name, account, expected) => {
		expect(await lookup()(account)).toStrictEqual(expected);
	});

	it("reads each account's existing deployment once", async () => {
		const reads: CloudflareAccountId[] = [];
		const startingPlanFor = lookup(reads);

		const first = await startingPlanFor(deployedAccount);
		const again = await startingPlanFor(deployedAccount);

		expect({ isSame: again === first, reads }).toStrictEqual({
			isSame: true,
			reads: [deployedAccount]
		});
	});
});
