import Cloudflare from 'cloudflare';
import { describe, expect, it } from 'vitest';

import { createCloudflareApi } from './cloudflare-api.ts';
import {
	cloudflareAccountIdSchema,
	queueIdSchema,
	scriptNameSchema
} from './identifiers.ts';

const accountId = (value: string) => cloudflareAccountIdSchema.parse(value);
const scriptName = (value: string) => scriptNameSchema.parse(value);
const queueId = (value: string) => queueIdSchema.parse(value);

interface Recorded {
	readonly method: string;
	readonly path: string;
}

interface RecordedUploadPart {
	readonly name: string;
	readonly filename?: string;
	readonly type?: string;
	readonly value: string;
}

interface RecordedUpload {
	readonly contentType: string | null;
	readonly parts: readonly RecordedUploadPart[];
}

async function recordWorkerUpload(
	run: (client: Cloudflare) => Promise<void>
): Promise<RecordedUpload | undefined> {
	let upload: RecordedUpload | undefined;

	const fetcher: typeof fetch = async (input, init) => {
		const rawUrl =
			typeof input === 'string'
				? input
				: input instanceof URL
					? input.href
					: input.url;

		if (new URL(rawUrl).protocol === 'data:') {
			return new Response();
		}

		const parts: RecordedUploadPart[] = [];
		const request =
			init?.body instanceof FormData ? new Request(rawUrl, init) : undefined;
		const contentType =
			request?.headers.get('content-type') ??
			new Headers(init?.headers).get('content-type');
		let form: FormData | undefined;

		if (init?.body instanceof FormData) {
			form = init.body;
		} else if (contentType?.startsWith('multipart/form-data; boundary=')) {
			form = await new Response(init?.body, {
				headers: { 'content-type': contentType }
			}).formData();
		}

		if (form !== undefined) {
			for (const [name, value] of form) {
				parts.push(
					typeof value === 'string'
						? { name, value }
						: {
								name,
								filename: value.name,
								type: value.type,
								value: await value.text()
							}
				);
			}
		}

		upload = {
			contentType: contentType?.startsWith('multipart/form-data; boundary=')
				? 'multipart/form-data'
				: contentType,
			parts: parts.toSorted((left, right) =>
				left.name.localeCompare(right.name)
			)
		};

		return Response.json({
			success: true,
			errors: [],
			messages: [],
			result: {}
		});
	};

	await run(new Cloudflare({ apiToken: 'token', fetch: fetcher }));

	return upload;
}

/**
 * A Cloudflare client whose HTTP layer is a fake: responses are looked up by
 * `METHOD path` (paths relative to the v4 API root), and every request is
 * recorded. This exercises the real interface code against wire shapes the live
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

describe('uploadScript', () => {
	it('sends the Worker as Cloudflare multipart upload parts', async () => {
		const upload = await recordWorkerUpload((client) =>
			createCloudflareApi(client, accountId('acc-1')).uploadScript(
				scriptName('cupboard'),
				{
					main_module: 'worker.js',
					compatibility_date: '2026-07-27'
				},
				{
					mainModule: 'worker.js',
					code: 'export default { fetch: () => new Response("ok") };'
				}
			)
		);

		expect(upload).toStrictEqual({
			contentType: 'multipart/form-data',
			parts: [
				{
					name: 'metadata',
					filename: 'metadata',
					type: 'application/json',
					value: JSON.stringify({
						main_module: 'worker.js',
						compatibility_date: '2026-07-27'
					})
				},
				{
					name: 'worker.js',
					filename: 'worker.js',
					type: 'application/javascript+module',
					value: 'export default { fetch: () => new Response("ok") };'
				}
			]
		});
	});
});

describe('ensureQueueConsumer', () => {
	it('does not write when the live consumer already matches', async () => {
		const { client, requests } = fakeCloudflare({
			[`GET ${consumersPath}`]: [liveWorkerConsumer]
		});

		await createCloudflareApi(client, accountId('acc-1')).ensureQueueConsumer(
			queueId('queue-1'),
			scriptName('cupboard'),
			desiredSettings
		);

		expect(requests).toStrictEqual([{ method: 'GET', path: consumersPath }]);
	});

	it('creates the consumer when none exists for the script', async () => {
		const { client, requests } = fakeCloudflare({
			[`GET ${consumersPath}`]: [],
			[`POST ${consumersPath}`]: {}
		});

		await createCloudflareApi(client, accountId('acc-1')).ensureQueueConsumer(
			queueId('queue-1'),
			scriptName('cupboard'),
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

		await createCloudflareApi(client, accountId('acc-1')).ensureQueueConsumer(
			queueId('queue-1'),
			scriptName('cupboard'),
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

		await createCloudflareApi(client, accountId('acc-1')).ensureQueueConsumer(
			queueId('queue-1'),
			scriptName('cupboard'),
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

		await createCloudflareApi(client, accountId('acc-1')).ensureSchedules(
			scriptName('cupboard'),
			['0 * * * *']
		);

		expect(requests).toStrictEqual([{ method: 'GET', path: schedulesPath }]);
	});

	it('replaces the schedule when it differs', async () => {
		const { client, requests } = fakeCloudflare({
			[`GET ${schedulesPath}`]: { schedules: [{ cron: '30 * * * *' }] },
			[`PUT ${schedulesPath}`]: { schedules: [{ cron: '0 * * * *' }] }
		});

		await createCloudflareApi(client, accountId('acc-1')).ensureSchedules(
			scriptName('cupboard'),
			['0 * * * *']
		);

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

		await createCloudflareApi(
			client,
			accountId('acc-1')
		).ensureStagingLifecycleRule('cupboard-blobs');

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

		await createCloudflareApi(
			client,
			accountId('acc-1')
		).ensureStagingLifecycleRule('cupboard-blobs');

		expect(requests).toStrictEqual([{ method: 'GET', path: lifecyclePath }]);
	});

	it('does not re-write when R2 echoes extra fields it did not set', async () => {
		const { client, requests } = fakeCloudflare({
			[`GET ${lifecyclePath}`]: {
				rules: [{ ...stagingRule, storageClassTransitions: [] }]
			}
		});

		await createCloudflareApi(
			client,
			accountId('acc-1')
		).ensureStagingLifecycleRule('cupboard-blobs');

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

		await createCloudflareApi(
			client,
			accountId('acc-1')
		).ensureStagingLifecycleRule('cupboard-blobs');

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
			accountId('acc-1')
		).findCustomDomain(scriptName('cupboard'));

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
			accountId('acc-1')
		).findCustomDomain(scriptName('cupboard'));

		expect(hostname).toBeUndefined();
	});
});
