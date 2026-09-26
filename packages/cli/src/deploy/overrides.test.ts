import { describe, expect, it } from 'vitest';

import { parseDeploymentConfig } from './config.ts';
import { collectResources } from './deploy-run.ts';
import {
	renameResource,
	renameResources,
	withCrons,
	withWorkersInvocationAllowance
} from './overrides.ts';

const config = parseDeploymentConfig(
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

describe('renameResource', () => {
	it('renames a bucket in both workers', () => {
		const renamed = renameResource(config, 'bucket', 'cupboard-blobs', 'mine');

		expect({
			resources: collectResources(renamed).r2Buckets,
			control: renamed.control.r2Buckets.map((bucket) => bucket.bucketName),
			tenant: renamed.tenant.r2Buckets.map((bucket) => bucket.bucketName)
		}).toStrictEqual({
			resources: ['mine'],
			control: ['mine'],
			tenant: ['mine']
		});
	});

	it('renames a database in both workers', () => {
		const renamed = renameResource(config, 'database', 'cupboard', 'pantry');

		expect(collectResources(renamed).d1Databases).toStrictEqual(['pantry']);
	});

	it('renames a queue across producers, consumers and dead letters', () => {
		const renamed = renameResource(
			config,
			'queue',
			'cupboard-maintenance',
			'chores'
		);

		expect({
			producers: renamed.control.queueProducers,
			consumers: renamed.control.queueConsumers
		}).toStrictEqual({
			producers: [{ binding: 'Q', queue: 'chores' }],
			consumers: [
				{
					queue: 'chores',
					deadLetterQueue: 'cupboard-maintenance-dlq',
					maxBatchSize: undefined,
					maxBatchTimeout: undefined,
					maxConcurrency: undefined,
					maxRetries: undefined
				}
			]
		});
	});

	it('leaves names that do not match untouched', () => {
		expect(renameResource(config, 'queue', 'nope', 'chores')).toStrictEqual(
			config
		);
	});
});

describe('renameResources', () => {
	it('renames each reference once when a new name equals another old name', () => {
		const renamed = renameResources(config, {
			queue: new Map([
				['cupboard-maintenance', 'cupboard-maintenance-dlq'],
				['cupboard-maintenance-dlq', 'cupboard-maintenance']
			])
		});

		expect(renamed).toStrictEqual({
			...config,
			control: {
				...config.control,
				queueProducers: [{ binding: 'Q', queue: 'cupboard-maintenance-dlq' }],
				queueConsumers: config.control.queueConsumers.map((consumer) => ({
					...consumer,
					queue: 'cupboard-maintenance-dlq',
					deadLetterQueue: 'cupboard-maintenance'
				}))
			}
		});
	});
});

describe('withCrons', () => {
	it('replaces the control crons and leaves the tenant alone', () => {
		const updated = withCrons(config, ['*/5 * * * *']);

		expect({
			control: updated.control.crons,
			tenant: updated.tenant.crons
		}).toStrictEqual({ control: ['*/5 * * * *'], tenant: [] });
	});
});

describe('withWorkersInvocationAllowance', () => {
	it('sets the allowance on both workers, preserving other vars', () => {
		const updated = withWorkersInvocationAllowance(config, {
			subrequests: 1000
		});
		const expected = { CUPBOARD_SUBREQUESTS_PER_INVOCATION: '1000' };

		expect({
			control: updated.control.vars,
			tenant: updated.tenant.vars
		}).toStrictEqual({
			control: { ...config.control.vars, ...expected },
			tenant: { ...config.tenant.vars, ...expected }
		});
	});
});
