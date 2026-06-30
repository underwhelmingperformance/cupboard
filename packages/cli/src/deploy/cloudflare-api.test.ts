import Cloudflare from 'cloudflare';
import { describe, expect, it } from 'vitest';

import { createCloudflareApi } from './cloudflare-api.ts';

interface Recorded {
	readonly method: string;
	readonly path: string;
}

/**
 * A Cloudflare client whose HTTP layer is a fake: responses are looked up by
 * `METHOD path` (paths relative to the v4 API root), and every request is
 * recorded. This exercises the real seam code against wire shapes the live
 * API actually produces, which the SDK's published types do not always match.
 */
function fakeCloudflare(routes: Readonly<Record<string, unknown>>): {
	client: Cloudflare;
	requests: Recorded[];
	bodies: unknown[];
} {
	const requests: Recorded[] = [];
	const bodies: unknown[] = [];

	const fetcher: typeof fetch = (input, init) => {
		let rawUrl: string;

		if (typeof input === 'string') {
			rawUrl = input;
		} else if (input instanceof URL) {
			rawUrl = input.href;
		} else {
			rawUrl = input.url;
		}

		const url = new URL(rawUrl);
		const method = init?.method ?? 'GET';
		const path = url.pathname.replace('/client/v4', '');
		requests.push({ method, path });
		bodies.push(
			typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
		);

		const routeKey = `${method} ${path}`;
		const body = routes[routeKey];

		if (body === undefined) {
			return Promise.resolve(
				Response.json(
					{ success: false, errors: [{ code: 0, message: 'no route' }] },
					{ status: 404 }
				)
			);
		}

		return Promise.resolve(
			Response.json({
				success: true,
				errors: [],
				messages: [],
				result: body
			})
		);
	};

	return {
		client: new Cloudflare({ apiToken: 'token', fetch: fetcher }),
		requests,
		bodies
	};
}

// The live consumers endpoint answers `script`, not the `script_name` the
// published schema claims; this fixture mirrors a real response.
const liveWorkerConsumer = {
	queue_name: 'cupboard-maintenance',
	script: 'cupboard',
	type: 'worker',
	consumer_id: 'consumer-1',
	dead_letter_queue: 'cupboard-maintenance-dlq',
	settings: {
		batch_size: 10,
		max_wait_time_ms: 5000,
		max_retries: 3,
		max_concurrency: 4
	}
};

const desiredSettings = {
	maxBatchSize: 10,
	maxBatchTimeout: 5,
	maxRetries: 3,
	maxConcurrency: 4,
	deadLetterQueue: 'cupboard-maintenance-dlq'
};

const consumersPath = '/accounts/acc-1/queues/queue-1/consumers';

describe('ensureQueueConsumer', () => {
	it('does not write when the live consumer already matches', async () => {
		const { client, requests } = fakeCloudflare({
			[`GET ${consumersPath}`]: [liveWorkerConsumer]
		});

		await createCloudflareApi(client, 'acc-1').ensureQueueConsumer(
			'queue-1',
			'cupboard',
			desiredSettings
		);

		expect(requests).toStrictEqual([{ method: 'GET', path: consumersPath }]);
	});

	it('creates the consumer when none exists for the script', async () => {
		const { client, requests } = fakeCloudflare({
			[`GET ${consumersPath}`]: [],
			[`POST ${consumersPath}`]: {}
		});

		await createCloudflareApi(client, 'acc-1').ensureQueueConsumer(
			'queue-1',
			'cupboard',
			desiredSettings
		);

		expect(requests).toStrictEqual([
			{ method: 'GET', path: consumersPath },
			{ method: 'POST', path: consumersPath }
		]);
	});

	it('updates in place when the live settings have drifted', async () => {
		const { client, requests } = fakeCloudflare({
			[`GET ${consumersPath}`]: [
				{
					...liveWorkerConsumer,
					settings: { ...liveWorkerConsumer.settings, batch_size: 1 }
				}
			],
			[`PUT ${consumersPath}/consumer-1`]: {}
		});

		await createCloudflareApi(client, 'acc-1').ensureQueueConsumer(
			'queue-1',
			'cupboard',
			desiredSettings
		);

		expect(requests).toStrictEqual([
			{ method: 'GET', path: consumersPath },
			{ method: 'PUT', path: `${consumersPath}/consumer-1` }
		]);
	});

	it('matches a consumer answering with script_name as the schema claims', async () => {
		const { script: _script, ...schemaShaped } = liveWorkerConsumer;
		const { client, requests } = fakeCloudflare({
			[`GET ${consumersPath}`]: [{ ...schemaShaped, script_name: 'cupboard' }]
		});

		await createCloudflareApi(client, 'acc-1').ensureQueueConsumer(
			'queue-1',
			'cupboard',
			desiredSettings
		);

		expect(requests).toStrictEqual([{ method: 'GET', path: consumersPath }]);
	});
});

describe('ensureSchedules', () => {
	const schedulesPath = '/accounts/acc-1/workers/scripts/cupboard/schedules';

	it('does not write when the live crons already match', async () => {
		const { client, requests } = fakeCloudflare({
			[`GET ${schedulesPath}`]: { schedules: [{ cron: '0 * * * *' }] }
		});

		await createCloudflareApi(client, 'acc-1').ensureSchedules('cupboard', [
			'0 * * * *'
		]);

		expect(requests).toStrictEqual([{ method: 'GET', path: schedulesPath }]);
	});

	it('replaces the schedule when it differs', async () => {
		const { client, requests } = fakeCloudflare({
			[`GET ${schedulesPath}`]: { schedules: [{ cron: '30 * * * *' }] },
			[`PUT ${schedulesPath}`]: { schedules: [{ cron: '0 * * * *' }] }
		});

		await createCloudflareApi(client, 'acc-1').ensureSchedules('cupboard', [
			'0 * * * *'
		]);

		expect(requests).toStrictEqual([
			{ method: 'GET', path: schedulesPath },
			{ method: 'PUT', path: schedulesPath }
		]);
	});
});

describe('ensureStagingLifecycleRule', () => {
	const lifecyclePath = '/accounts/acc-1/r2/buckets/cupboard-blobs/lifecycle';

	const stagingRule = {
		id: 'cupboard-staging-reclaim',
		enabled: true,
		conditions: { prefix: 'staging/' },
		deleteObjectsTransition: {
			condition: { type: 'Age', maxAge: 86_400 }
		},
		abortMultipartUploadsTransition: {
			condition: { type: 'Age', maxAge: 86_400 }
		}
	};

	it('writes the staging rule when the bucket has none', async () => {
		const { client, requests, bodies } = fakeCloudflare({
			[`GET ${lifecyclePath}`]: { rules: [] },
			[`PUT ${lifecyclePath}`]: {}
		});

		await createCloudflareApi(client, 'acc-1').ensureStagingLifecycleRule(
			'cupboard-blobs'
		);

		expect({ requests, putBody: bodies[1] }).toStrictEqual({
			requests: [
				{ method: 'GET', path: lifecyclePath },
				{ method: 'PUT', path: lifecyclePath }
			],
			putBody: { rules: [stagingRule] }
		});
	});

	it('does not write when the staging rule already matches', async () => {
		const { client, requests } = fakeCloudflare({
			[`GET ${lifecyclePath}`]: { rules: [stagingRule] }
		});

		await createCloudflareApi(client, 'acc-1').ensureStagingLifecycleRule(
			'cupboard-blobs'
		);

		expect(requests).toStrictEqual([{ method: 'GET', path: lifecyclePath }]);
	});

	it('does not re-write when R2 echoes extra fields it did not set', async () => {
		const { client, requests } = fakeCloudflare({
			[`GET ${lifecyclePath}`]: {
				rules: [{ ...stagingRule, storageClassTransitions: [] }]
			}
		});

		await createCloudflareApi(client, 'acc-1').ensureStagingLifecycleRule(
			'cupboard-blobs'
		);

		expect(requests).toStrictEqual([{ method: 'GET', path: lifecyclePath }]);
	});

	it('keeps unrelated rules and replaces a drifted staging rule', async () => {
		const otherRule = {
			id: 'keep-me',
			enabled: true,
			conditions: { prefix: 'nar/' },
			deleteObjectsTransition: { condition: { type: 'Age', maxAge: 2_592_000 } }
		};
		const { client, requests, bodies } = fakeCloudflare({
			[`GET ${lifecyclePath}`]: {
				rules: [
					otherRule,
					{
						...stagingRule,
						deleteObjectsTransition: {
							condition: { type: 'Age', maxAge: 604_800 }
						}
					}
				]
			},
			[`PUT ${lifecyclePath}`]: {}
		});

		await createCloudflareApi(client, 'acc-1').ensureStagingLifecycleRule(
			'cupboard-blobs'
		);

		expect({ requests, putBody: bodies[1] }).toStrictEqual({
			requests: [
				{ method: 'GET', path: lifecyclePath },
				{ method: 'PUT', path: lifecyclePath }
			],
			putBody: { rules: [otherRule, stagingRule] }
		});
	});
});

describe('findCustomDomain', () => {
	const domainsPath = '/accounts/acc-1/workers/domains';

	it('answers the hostname routed to the script', async () => {
		const { client } = fakeCloudflare({
			[`GET ${domainsPath}`]: [
				{ hostname: 'other.example.com', service: 'other-worker' },
				{ hostname: 'cupboard.supply', service: 'cupboard' }
			]
		});

		const hostname = await createCloudflareApi(
			client,
			'acc-1'
		).findCustomDomain('cupboard');

		expect(hostname).toBe('cupboard.supply');
	});

	it('answers undefined when no domain is routed to the script', async () => {
		const { client } = fakeCloudflare({
			[`GET ${domainsPath}`]: [
				{ hostname: 'other.example.com', service: 'other-worker' }
			]
		});

		const hostname = await createCloudflareApi(
			client,
			'acc-1'
		).findCustomDomain('cupboard');

		expect(hostname).toBeUndefined();
	});
});
