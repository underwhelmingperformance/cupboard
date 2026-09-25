import { describe, expect, it } from 'vitest';

import type {
	LiveQueueConsumer,
	ScriptConfiguration
} from './cloudflare-api.ts';
import { parseDeploymentConfig } from './config.ts';
import {
	type CurrentDeploymentApi,
	parseLiveBindings,
	readCurrentDeployment,
	readOperator
} from './current-deployment.ts';
import { collectResources } from './deploy-run.ts';
import {
	type DatabaseId,
	databaseIdSchema,
	type KvNamespaceId,
	kvNamespaceIdSchema
} from './identifiers.ts';
import { deployerOwner } from './owner.ts';

const config = parseDeploymentConfig(
	`{
		"name": "cupboard",
		"compatibility_date": "2026-05-15",
		"r2_buckets": [{ "binding": "BLOBS", "bucket_name": "cupboard-blobs" }],
		"kv_namespaces": [
			{ "binding": "TENANT_CACHE", "id": "00000000000000000000000000000000" }
		],
		"d1_databases": [{ "binding": "CUPBOARD_DB", "database_name": "cupboard" }],
		"queues": {
			"producers": [
				{ "binding": "MAINTENANCE_QUEUE", "queue": "cupboard-maintenance" }
			],
			"consumers": [
				{
					"queue": "cupboard-maintenance",
					"dead_letter_queue": "cupboard-maintenance-dlq"
				}
			]
		},
		"vars": {
			"CUPBOARD_SIGNUP_ISSUER": "",
			"CUPBOARD_SIGNUP_AUDIENCE": "",
			"CUPBOARD_SIGNUP_SUBJECT": ""
		},
		"triggers": { "crons": ["0 * * * *"] }
	}`,
	`{
		"name": "cupboard-tenant",
		"compatibility_date": "2026-05-15",
		"r2_buckets": [{ "binding": "BLOBS", "bucket_name": "cupboard-blobs" }],
		"d1_databases": [{ "binding": "CUPBOARD_DB", "database_name": "cupboard" }]
	}`
);

const databaseId = (value: string): DatabaseId => databaseIdSchema.parse(value);
const kvNamespaceId = (value: string): KvNamespaceId =>
	kvNamespaceIdSchema.parse(value);

const operator = deployerOwner('cf-operator');

interface FakeDeployment {
	readonly scripts?: Readonly<Record<string, ScriptConfiguration>>;
	readonly schedules?: Readonly<Record<string, readonly string[]>>;
	readonly databases?: Readonly<Record<string, string>>;
	readonly namespaces?: Readonly<Record<string, string>>;
	readonly consumers?: Readonly<Record<string, LiveQueueConsumer>>;
	readonly operatorRow?: string;
	readonly hasOperatorTable?: boolean;
}

/**
 * A Cloudflare account holding one deployment. Databases and namespaces are
 * keyed by id; consumers by `queue->script`.
 */
function fakeApi(deployment: FakeDeployment): CurrentDeploymentApi {
	const databases = deployment.databases ?? {};

	return {
		getScriptConfiguration: (scriptName) =>
			Promise.resolve(deployment.scripts?.[scriptName]),
		listSchedules: (scriptName) => {
			const crons = deployment.schedules?.[scriptName];

			return Promise.resolve(crons === undefined ? undefined : [...crons]);
		},
		d1DatabaseName: (id) => Promise.resolve(databases[id]),
		kvNamespaceTitle: (id) => Promise.resolve(deployment.namespaces?.[id]),
		findQueueConsumer: (queue, scriptName) =>
			Promise.resolve(deployment.consumers?.[`${queue}->${scriptName}`]),
		findD1Database: (name) => {
			const found = Object.entries(databases).find(
				([, candidate]) => candidate === name
			);

			return Promise.resolve(
				found === undefined ? undefined : databaseId(found[0])
			);
		},
		d1QueryRows: (_id, sql) => {
			if (sql.includes('sqlite_master')) {
				return Promise.resolve(
					deployment.hasOperatorTable === false ? [] : ['global_admin']
				);
			}

			return Promise.resolve(
				deployment.operatorRow === undefined ? [] : [deployment.operatorRow]
			);
		}
	};
}

function scriptWith(bindings: readonly unknown[]): ScriptConfiguration {
	return { bindings, cacheEnabled: false, crossVersionCache: false };
}

describe('readCurrentDeployment', () => {
	it('keeps the build defaults when nothing is deployed', async () => {
		expect(await readCurrentDeployment(fakeApi({}), config)).toStrictEqual({
			config,
			signupGate: undefined,
			operator: undefined
		});
	});

	it('starts from the resources, crons and gate the Workers already use', async () => {
		const bindings = [
			{ type: 'r2_bucket', name: 'BLOBS', bucket_name: 'acme-blobs' },
			{ type: 'd1', name: 'CUPBOARD_DB', database_id: 'db-1' },
			{ type: 'queue', name: 'MAINTENANCE_QUEUE', queue_name: 'acme-chores' }
		];
		const current = await readCurrentDeployment(
			fakeApi({
				scripts: {
					cupboard: scriptWith([
						...bindings,
						{
							type: 'kv_namespace',
							name: 'TENANT_CACHE',
							namespace_id: 'kv-1'
						},
						{
							type: 'plain_text',
							name: 'CUPBOARD_SIGNUP_ISSUER',
							text: operator.issuer
						},
						{
							type: 'plain_text',
							name: 'CUPBOARD_SIGNUP_SUBJECT',
							text: operator.subject
						},
						{
							type: 'plain_text',
							name: 'CUPBOARD_SIGNUP_AUDIENCE',
							text: operator.audience
						},
						{ type: 'secret_text', name: 'CONTROL_KEY_WRAP_SECRET' }
					]),
					'cupboard-tenant': scriptWith(bindings)
				},
				schedules: { cupboard: ['*/30 * * * *'] },
				databases: { 'db-1': 'acme-db' },
				namespaces: { 'kv-1': 'acme-tenant-cache' },
				consumers: {
					'acme-chores->cupboard': { deadLetterQueue: 'acme-chores-dlq' }
				},
				operatorRow: JSON.stringify(operator)
			}),
			config
		);

		expect({
			resources: collectResources(current.config),
			kv: current.config.control.kvNamespaces,
			consumers: current.config.control.queueConsumers.map((consumer) => [
				consumer.queue,
				consumer.deadLetterQueue
			]),
			crons: current.config.control.crons,
			signupGate: current.signupGate,
			operator: current.operator
		}).toStrictEqual({
			resources: {
				r2Buckets: ['acme-blobs'],
				d1Databases: ['acme-db'],
				kvTitles: ['acme-tenant-cache'],
				queues: ['acme-chores', 'acme-chores-dlq']
			},
			kv: [{ binding: 'TENANT_CACHE', title: 'acme-tenant-cache' }],
			consumers: [['acme-chores', 'acme-chores-dlq']],
			crons: ['*/30 * * * *'],
			signupGate: operator,
			operator
		});
	});

	it('keeps an emptied cron schedule on a deployed control Worker', async () => {
		const current = await readCurrentDeployment(
			fakeApi({
				scripts: { cupboard: scriptWith([]) },
				schedules: { cupboard: [] }
			}),
			config
		);

		expect(current.config.control.crons).toStrictEqual([]);
	});

	it('treats cleared signup variables as no gate', async () => {
		const current = await readCurrentDeployment(
			fakeApi({
				scripts: {
					cupboard: scriptWith([
						{ type: 'plain_text', name: 'CUPBOARD_SIGNUP_ISSUER', text: '' },
						{ type: 'plain_text', name: 'CUPBOARD_SIGNUP_SUBJECT', text: '' },
						{ type: 'plain_text', name: 'CUPBOARD_SIGNUP_AUDIENCE', text: '' }
					])
				}
			}),
			config
		);

		expect(current.signupGate).toBeUndefined();
	});
});

describe('readOperator', () => {
	it('reads the claimed operator from the database', async () => {
		const api = fakeApi({
			databases: { 'db-1': 'cupboard' },
			operatorRow: JSON.stringify(operator)
		});

		expect(await readOperator(api, 'cupboard')).toStrictEqual(operator);
	});

	it.each([
		['the database does not exist', {}],
		[
			'the table has not been migrated yet',
			{ databases: { 'db-1': 'cupboard' }, hasOperatorTable: false }
		],
		['nobody has claimed the deployment', { databases: { 'db-1': 'cupboard' } }]
	])('is undefined when %s', async (_name, deployment: FakeDeployment) => {
		expect(await readOperator(fakeApi(deployment), 'cupboard')).toBeUndefined();
	});
});

describe('parseLiveBindings', () => {
	it('reads the older `id` field of a D1 binding and skips other types', () => {
		const live = parseLiveBindings([
			{ type: 'd1', name: 'CUPBOARD_DB', id: 'db-1' },
			{ type: 'secret_text', name: 'R2_ACCESS_KEY_ID' },
			{ type: 'service', name: 'CUPBOARD_TENANT', service: 'cupboard-tenant' },
			{ type: 'kv_namespace', name: 'TENANT_CACHE', namespace_id: 'kv-1' }
		]);

		expect({
			databases: [...live.databases],
			namespaces: [...live.namespaces],
			buckets: [...live.buckets],
			variables: live.variables
		}).toStrictEqual({
			databases: [['CUPBOARD_DB', databaseId('db-1')]],
			namespaces: [['TENANT_CACHE', kvNamespaceId('kv-1')]],
			buckets: [],
			variables: {}
		});
	});
});
