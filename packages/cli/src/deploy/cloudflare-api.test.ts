import { ProgressiveCollectionLimitError } from '@cupboard/shared/collections';
import Cloudflare, { NotFoundError } from 'cloudflare';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

import {
	createCloudflareApi,
	D1BookmarkMissingError,
	maximumCloudflareCollectionPages,
	QueueConsumerIdMissingError
} from './cloudflare-api.ts';
import {
	cloudflareAccountIdSchema,
	databaseIdSchema,
	queueIdSchema,
	scriptNameSchema,
	zoneIdSchema
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
 * recorded. This exercises the real interface code against the response shapes
 * the live API actually produces, which the SDK's published types do not always
 * match.
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
					{ status: StatusCodes.NOT_FOUND }
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

function paginatedD1Client(
	itemsForPage: (page: number) => readonly unknown[]
): { client: Cloudflare; pages: number[] } {
	const pages: number[] = [];
	const fetcher: typeof fetch = (input) => {
		const rawUrl =
			typeof input === 'string'
				? input
				: input instanceof URL
					? input.href
					: input.url;
		const url = new URL(rawUrl);
		const page = Number(url.searchParams.get('page') ?? '1');
		pages.push(page);

		return Promise.resolve(
			Response.json({
				success: true,
				errors: [],
				messages: [],
				result: itemsForPage(page),
				result_info: { page, per_page: 1 }
			})
		);
	};

	return {
		client: new Cloudflare({ apiToken: 'token', fetch: fetcher }),
		pages
	};
}

// The live consumers endpoint returns `script`, not the `script_name` the
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
					compatibility_date: '2026-07-27',
					cache_options: { enabled: true, cross_version_cache: true },
					exports: {
						CupboardServer: { type: 'durable-object', storage: 'sqlite' }
					}
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
						compatibility_date: '2026-07-27',
						cache_options: { enabled: true, cross_version_cache: true },
						exports: {
							CupboardServer: {
								type: 'durable-object',
								storage: 'sqlite'
							}
						}
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

describe('d1QueryBatch', () => {
	it('sends one transactional batch to the D1 query endpoint', async () => {
		const path = '/accounts/acc-1/d1/database/db-1/query';
		const { client, requests, bodies } = fakeCloudflare({
			[`POST ${path}`]: []
		});

		await createCloudflareApi(client, accountId('acc-1')).d1QueryBatch(
			databaseIdSchema.parse('db-1'),
			['CREATE TABLE example (id INTEGER);', 'INSERT INTO example VALUES (1);']
		);

		expect({ requests, bodies }).toStrictEqual({
			requests: [{ method: 'POST', path }],
			bodies: [
				{
					batch: [
						{ sql: 'CREATE TABLE example (id INTEGER);' },
						{ sql: 'INSERT INTO example VALUES (1);' }
					]
				}
			]
		});
	});
});

describe('getD1Bookmark', () => {
	const path = '/accounts/acc-1/d1/database/db-1/time_travel/bookmark';

	it('returns the current Time Travel bookmark', async () => {
		const { client, requests } = fakeCloudflare({
			[`GET ${path}`]: { bookmark: 'bookmark-1' }
		});

		await expect(
			createCloudflareApi(client, accountId('acc-1')).getD1Bookmark(
				databaseIdSchema.parse('db-1')
			)
		).resolves.toBe('bookmark-1');
		expect(requests).toStrictEqual([{ method: 'GET', path }]);
	});

	it('refuses a response without a bookmark', async () => {
		const { client } = fakeCloudflare({ [`GET ${path}`]: {} });

		await expect(
			createCloudflareApi(client, accountId('acc-1')).getD1Bookmark(
				databaseIdSchema.parse('db-1')
			)
		).rejects.toBeInstanceOf(D1BookmarkMissingError);
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

	it('clears live settings that were removed from the deployment', async () => {
		const { client, requests, bodies } = fakeCloudflare({
			[`GET ${consumersPath}`]: [liveWorkerConsumer],
			[`PUT ${consumersPath}/consumer-1`]: {}
		});

		await createCloudflareApi(client, accountId('acc-1')).ensureQueueConsumer(
			queueId('queue-1'),
			scriptName('cupboard'),
			{
				maxBatchSize: undefined,
				maxBatchTimeout: undefined,
				maxRetries: undefined,
				maxConcurrency: undefined,
				deadLetterQueue: undefined
			}
		);

		expect({ requests, update: bodies[1] }).toStrictEqual({
			requests: [
				{ method: 'GET', path: consumersPath },
				{ method: 'PUT', path: `${consumersPath}/consumer-1` }
			],
			update: {
				type: 'worker',
				script_name: 'cupboard',
				settings: {}
			}
		});
	});

	it('rejects drift when the live consumer has no addressable id', async () => {
		const { consumer_id: _consumerId, ...withoutId } = liveWorkerConsumer;
		const { client, requests } = fakeCloudflare({
			[`GET ${consumersPath}`]: [
				{
					...withoutId,
					settings: { ...withoutId.settings, batch_size: 1 }
				}
			]
		});
		const api = createCloudflareApi(client, accountId('acc-1'));

		await expect(
			api.ensureQueueConsumer(
				queueId('queue-1'),
				scriptName('cupboard'),
				desiredSettings
			)
		).rejects.toStrictEqual(
			new QueueConsumerIdMissingError(
				queueId('queue-1'),
				scriptName('cupboard')
			)
		);
		expect(requests).toStrictEqual([{ method: 'GET', path: consumersPath }]);
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

describe('R2 bucket lookup', () => {
	const bucketPath = '/accounts/acc-1/r2/buckets/cupboard-blobs';
	const bucketsPath = '/accounts/acc-1/r2/buckets';

	it('checks the exact bucket instead of a potentially truncated list', async () => {
		const { client, requests } = fakeCloudflare({
			[`GET ${bucketPath}`]: { name: 'cupboard-blobs' }
		});

		const isPresent = await createCloudflareApi(
			client,
			accountId('acc-1')
		).r2BucketExists('cupboard-blobs');

		expect({ isPresent, requests }).toStrictEqual({
			isPresent: true,
			requests: [{ method: 'GET', path: bucketPath }]
		});
	});

	it('creates a bucket only after its exact lookup returns 404', async () => {
		const { client, requests } = fakeCloudflare({
			[`POST ${bucketsPath}`]: { name: 'cupboard-blobs' }
		});

		await createCloudflareApi(client, accountId('acc-1')).ensureR2Bucket(
			'cupboard-blobs'
		);

		expect(requests).toStrictEqual([
			{ method: 'GET', path: bucketPath },
			{ method: 'POST', path: bucketsPath }
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

describe('bounded Cloudflare pagination', () => {
	it('stops requesting pages when it finds the database', async () => {
		const { client, pages } = paginatedD1Client((page) =>
			page === 1
				? [{ name: 'other', uuid: 'db-other' }]
				: [{ name: 'cupboard', uuid: 'db-cupboard' }]
		);

		const found = await createCloudflareApi(
			client,
			accountId('acc-1')
		).ensureD1Database('cupboard');

		expect({ found, pages }).toStrictEqual({
			found: 'db-cupboard',
			pages: [1, 2]
		});
	});

	it('does not request a page beyond the collection limit', async () => {
		const { client, pages } = paginatedD1Client((page) => [
			{ name: `other-${String(page)}`, uuid: `db-${String(page)}` }
		]);

		await expect(
			createCloudflareApi(client, accountId('acc-1')).ensureD1Database(
				'cupboard'
			)
		).rejects.toBeInstanceOf(ProgressiveCollectionLimitError);
		expect(pages).toStrictEqual(
			Array.from(
				{ length: maximumCloudflareCollectionPages },
				(_value, index) => index + 1
			)
		);
	});
});

describe('findCustomDomain', () => {
	const domainsPath = '/accounts/acc-1/workers/domains';

	it('returns the hostname routed to the script', async () => {
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

	it('returns undefined when no domain is routed to the script', async () => {
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

describe('setCustomDomain', () => {
	const domainsPath = '/accounts/acc-1/workers/domains';

	it('detaches every domain routed to the script when none is configured', async () => {
		const { client, requests } = fakeCloudflare({
			[`GET ${domainsPath}`]: [
				{ id: 'keep', hostname: 'other.example.com', service: 'other-worker' },
				{ id: 'old-a', hostname: 'old-a.example.com', service: 'cupboard' },
				{ id: 'old-b', hostname: 'old-b.example.com', service: 'cupboard' }
			],
			[`DELETE ${domainsPath}/old-a`]: { success: true },
			[`DELETE ${domainsPath}/old-b`]: { success: true }
		});

		await createCloudflareApi(client, accountId('acc-1')).setCustomDomain(
			scriptName('cupboard'),
			undefined
		);

		expect(requests).toStrictEqual([
			{ method: 'GET', path: domainsPath },
			{ method: 'DELETE', path: `${domainsPath}/old-a` },
			{ method: 'DELETE', path: `${domainsPath}/old-b` }
		]);
	});

	it('attaches the configured domain before detaching an old domain', async () => {
		const { client, requests } = fakeCloudflare({
			[`GET ${domainsPath}`]: [
				{ id: 'old', hostname: 'old.example.com', service: 'cupboard' }
			],
			[`PUT ${domainsPath}`]: {
				id: 'new',
				hostname: 'new.example.com',
				service: 'cupboard'
			},
			[`DELETE ${domainsPath}/old`]: { success: true }
		});

		await createCloudflareApi(client, accountId('acc-1')).setCustomDomain(
			scriptName('cupboard'),
			{
				hostname: 'new.example.com',
				zoneId: zoneIdSchema.parse('zone-1')
			}
		);

		expect(requests).toStrictEqual([
			{ method: 'GET', path: domainsPath },
			{ method: 'PUT', path: domainsPath },
			{ method: 'DELETE', path: `${domainsPath}/old` }
		]);
	});
});

describe('getScriptConfiguration', () => {
	it('returns live bindings and cache settings', async () => {
		const path = '/accounts/acc-1/workers/scripts/cupboard-tenant/settings';
		const { client } = fakeCloudflare({
			[`GET ${path}`]: {
				annotations: { 'workers/tag': 'abc123' },
				bindings: [{ type: 'r2_bucket', name: 'BLOBS' }],
				cache_options: { enabled: true, cross_version_cache: true }
			}
		});

		const configuration = await createCloudflareApi(
			client,
			accountId('acc-1')
		).getScriptConfiguration(scriptName('cupboard-tenant'));

		expect(configuration).toStrictEqual({
			buildVersion: 'abc123',
			bindings: [{ type: 'r2_bucket', name: 'BLOBS' }],
			cacheEnabled: true,
			crossVersionCache: true
		});
	});
});

describe('getActiveScriptDeployment', () => {
	it('returns the version receiving all traffic', async () => {
		const path = '/accounts/acc-1/workers/scripts/cupboard-tenant/deployments';
		const { client } = fakeCloudflare({
			[`GET ${path}`]: {
				deployments: [
					{
						id: 'deployment-1',
						created_on: '2026-09-01T00:00:00Z',
						source: 'api',
						strategy: 'percentage',
						versions: [{ version_id: 'version-1', percentage: 100 }]
					}
				]
			}
		});

		await expect(
			createCloudflareApi(client, accountId('acc-1')).getActiveScriptDeployment(
				scriptName('cupboard-tenant')
			)
		).resolves.toStrictEqual({ versionId: 'version-1', trafficPercent: 100 });
	});

	it('does not report a gradual deployment as fully active', async () => {
		const path = '/accounts/acc-1/workers/scripts/cupboard-tenant/deployments';
		const { client } = fakeCloudflare({
			[`GET ${path}`]: {
				deployments: [
					{
						id: 'deployment-1',
						created_on: '2026-09-01T00:00:00Z',
						source: 'api',
						strategy: 'percentage',
						versions: [
							{ version_id: 'version-1', percentage: 90 },
							{ version_id: 'version-0', percentage: 10 }
						]
					}
				]
			}
		});

		await expect(
			createCloudflareApi(client, accountId('acc-1')).getActiveScriptDeployment(
				scriptName('cupboard-tenant')
			)
		).resolves.toBeUndefined();
	});
});

describe('setWorkersDevRoutes', () => {
	it('sets the workers.dev and preview URL states independently', async () => {
		const path = '/accounts/acc-1/workers/scripts/cupboard-tenant/subdomain';
		const { client, requests, bodies } = fakeCloudflare({
			[`POST ${path}`]: { enabled: false, previews_enabled: false }
		});

		await createCloudflareApi(client, accountId('acc-1')).setWorkersDevRoutes(
			scriptName('cupboard-tenant'),
			{
				workersDev: false,
				previewUrls: true
			}
		);

		expect({ requests, bodies }).toStrictEqual({
			requests: [{ method: 'POST', path }],
			bodies: [{ enabled: false, previews_enabled: true }]
		});
	});

	it('reports a missing script to the caller', async () => {
		const { client } = fakeCloudflare({});

		await expect(
			createCloudflareApi(client, accountId('acc-1')).setWorkersDevRoutes(
				scriptName('cupboard-tenant'),
				{ workersDev: false, previewUrls: false }
			)
		).rejects.toBeInstanceOf(NotFoundError);
	});
});
