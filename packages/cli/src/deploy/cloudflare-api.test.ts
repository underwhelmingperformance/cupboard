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
} {
	const requests: Recorded[] = [];

	const fetcher: typeof fetch = (input, init) => {
		const url = new URL(
			typeof input === 'string'
				? input
				: input instanceof URL
					? input.toString()
					: input.url
		);
		const method = init?.method ?? 'GET';
		const path = url.pathname.replace('/client/v4', '');
		requests.push({ method, path });

		const body = routes[`${method} ${path}`];

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
		requests
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
