import { describe, expect, it } from 'vitest';

import { parseDeploymentConfig } from './config.ts';
import { collectResources } from './deploy-run.ts';
import { renameResource, withCrons, withSignupGate } from './overrides.ts';

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
			producer: renamed.control.queueProducers[0]?.queue,
			consumer: renamed.control.queueConsumers[0]?.queue,
			deadLetter: renamed.control.queueConsumers[0]?.deadLetterQueue
		}).toStrictEqual({
			producer: 'chores',
			consumer: 'chores',
			deadLetter: 'cupboard-maintenance-dlq'
		});
	});

	it('leaves names that do not match untouched', () => {
		expect(renameResource(config, 'queue', 'nope', 'chores')).toStrictEqual(
			config
		);
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

describe('withSignupGate', () => {
	const admin = {
		issuer: 'https://dash.cloudflare.com',
		subject: 'cf-user-1',
		audience: 'client-1'
	};

	it('sets the gate vars on the control worker, preserving other vars', () => {
		const updated = withSignupGate(config, admin);
		const expected = {
			CUPBOARD_SIGNUP_ISSUER: 'https://dash.cloudflare.com',
			CUPBOARD_SIGNUP_SUBJECT: 'cf-user-1',
			CUPBOARD_SIGNUP_AUDIENCE: 'client-1'
		};

		expect({
			control: updated.control.vars,
			tenant: updated.tenant.vars
		}).toStrictEqual({
			control: { ...config.control.vars, ...expected },
			tenant: config.tenant.vars
		});
	});

	it('writes empty strings when nobody may claim admin', () => {
		const updated = withSignupGate(withSignupGate(config, admin));

		expect(updated.control.vars.CUPBOARD_SIGNUP_SUBJECT).toBe('');
	});
});
