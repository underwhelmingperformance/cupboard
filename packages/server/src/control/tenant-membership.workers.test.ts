import { type TenantId, tenantIdSchema } from '@cupboard/nix-store/scalars';
import {
	kvOperationsPerInvocation,
	kvOperationsReserve
} from '@cupboard/protocol/platform';
import { env as tenantEnv } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import { NarReadBufferPool } from '../blob/nar-read-buffers.ts';
import { passThrough } from '../http/stalled-body.test-support.ts';
import {
	enqueueMaintenanceJobs,
	handleMaintenanceQueue,
	type MaintenanceQueueMessage
} from '../routing/scheduled.ts';
import { resetTestServer, testControlEnv } from '../test-support.ts';

import { insertBulkTenants } from './bulk-tenants.test-support.ts';
import { controlMembershipRebuild } from './control-plane.ts';
import { tenantMemberKey } from './tenant-member-key.ts';

const baseEnv = Object.assign({}, tenantEnv, testControlEnv);

const filterKey = 'tenant-filter';

const pageSize = kvOperationsPerInvocation - kvOperationsReserve;

function recordingSendBatch(messages: MaintenanceQueueMessage[]) {
	return (
		batch: Iterable<{ readonly body: MaintenanceQueueMessage }>
	): Promise<void> => {
		for (const entry of batch) {
			messages.push(entry.body);
		}

		return Promise.resolve();
	};
}

async function liveSlugs(): Promise<TenantId[]> {
	const { results } = await baseEnv.CUPBOARD_DB.prepare(
		"SELECT id FROM tenant WHERE status != 'offboarded' ORDER BY id"
	).all<{ id: string }>();

	return results.map((row) => tenantIdSchema.parse(row.id));
}

function markerKeys(slugs: readonly TenantId[]): string[] {
	return slugs.map((slug) => tenantMemberKey(slug));
}

// An environment whose KV namespace records its puts and whose queue records
// its messages.
function recordedEnvironment() {
	const puts: string[] = [];
	const messages: MaintenanceQueueMessage[] = [];
	const kv = new Proxy(baseEnv.TENANT_CACHE, {
		get(target, property) {
			if (property !== 'put') {
				return passThrough(target, property);
			}

			return (key: string, value: string | ArrayBuffer) => {
				puts.push(key);

				return target.put(key, value);
			};
		}
	});
	const queue = new Proxy(baseEnv.MAINTENANCE_QUEUE, {
		get(target, property) {
			if (property !== 'sendBatch') {
				return passThrough(target, property);
			}

			return recordingSendBatch(messages);
		}
	});

	return {
		puts,
		messages,
		queue,
		environment: {
			...baseEnv,
			TENANT_CACHE: kv,
			MAINTENANCE_QUEUE: queue
		}
	};
}

// A batch of one queue message, which records how the consumer answers it.
function queueBatch(body: unknown, answers: string[]): MessageBatch {
	return {
		queue: 'cupboard-maintenance',
		metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } },
		messages: [
			{
				id: 'membership',
				timestamp: new Date(0),
				attempts: 1,
				body,
				ack: () => {
					answers.push('ack');
				},
				retry: () => {
					answers.push('retry');
				}
			}
		],
		ackAll: () => {
			answers.push('ackAll');
		},
		retryAll: () => {
			answers.push('retryAll');
		}
	};
}

describe('membership rebuild', () => {
	beforeEach(resetTestServer);

	it.each([1000, 2000])(
		'writes one page of markers and the filter for a paged request with %i tenants',
		async (tenants) => {
			await insertBulkTenants(tenants);
			const slugs = await liveSlugs();
			const recorded = recordedEnvironment();

			const response = await controlMembershipRebuild(recorded.environment, {
				page: {}
			});

			expect({ response, puts: recorded.puts }).toStrictEqual({
				response: { tenants: pageSize, cursor: slugs[pageSize - 1] },
				puts: [...markerKeys(slugs.slice(0, pageSize)), filterKey]
			});
		}
	);

	it.each(['1000', '10000'])(
		'writes a page of the same size when the plan allows %s subrequests',
		async (allowance) => {
			await insertBulkTenants(1000);
			const slugs = await liveSlugs();
			const recorded = recordedEnvironment();

			const response = await controlMembershipRebuild(
				{
					...recorded.environment,
					CUPBOARD_SUBREQUESTS_PER_INVOCATION: allowance
				},
				{ page: {} }
			);

			expect(response).toStrictEqual({
				tenants: pageSize,
				cursor: slugs[pageSize - 1]
			});
		}
	);

	it('writes every marker once when the caller follows the cursor', async () => {
		await insertBulkTenants(2000);
		const slugs = await liveSlugs();
		const recorded = recordedEnvironment();
		const pages: { tenants: number; cursor?: string }[] = [];

		let after: TenantId | undefined;
		do {
			const page = await controlMembershipRebuild(recorded.environment, {
				page: after === undefined ? {} : { after }
			});
			pages.push(page);
			after = page.cursor;
		} while (after !== undefined);

		expect({ pages, puts: recorded.puts }).toStrictEqual({
			pages: [
				{ tenants: pageSize, cursor: slugs[pageSize - 1] },
				{ tenants: pageSize, cursor: slugs[2 * pageSize - 1] },
				{ tenants: slugs.length - 2 * pageSize }
			],
			// Only the first page rebuilds the filter.
			puts: [
				...markerKeys(slugs.slice(0, pageSize)),
				filterKey,
				...markerKeys(slugs.slice(pageSize))
			]
		});
	});

	it('answers a request without a page in the legacy shape, with every marker and no cursor', async () => {
		await insertBulkTenants(1000);
		const slugs = await liveSlugs();
		const recorded = recordedEnvironment();

		const response = await controlMembershipRebuild(recorded.environment, {});

		expect({ response, puts: recorded.puts }).toStrictEqual({
			response: { tenants: slugs.length },
			puts: [...markerKeys(slugs), filterKey]
		});
	});

	it('queues the later pages from the cron tick and writes them through the queue consumer', async () => {
		await insertBulkTenants(2000);
		const slugs = await liveSlugs();
		const recorded = recordedEnvironment();
		const answers: string[] = [];
		const putsPerStep: number[] = [];

		await enqueueMaintenanceJobs(recorded.environment, recorded.queue);
		putsPerStep.push(recorded.puts.length);
		const queued = recorded.messages.filter(
			(message) => message.kind === 'membership-refresh'
		);
		recorded.messages.length = 0;

		// The consumer parses each body with the queue's schema, so a body that
		// the schema rejects would be acknowledged without writing a page.
		let message: MaintenanceQueueMessage | undefined = queued[0];

		while (message !== undefined) {
			const before = recorded.puts.length;
			await handleMaintenanceQueue(
				queueBatch(message, answers),
				recorded.environment,
				new NarReadBufferPool()
			);
			putsPerStep.push(recorded.puts.length - before);
			message = recorded.messages.shift();
		}

		expect({ queued, putsPerStep, answers, puts: recorded.puts }).toStrictEqual(
			{
				queued: [{ kind: 'membership-refresh', after: slugs[pageSize - 1] }],
				putsPerStep: [pageSize + 1, pageSize, slugs.length - 2 * pageSize],
				answers: ['ack', 'ack'],
				puts: [
					...markerKeys(slugs.slice(0, pageSize)),
					filterKey,
					...markerKeys(slugs.slice(pageSize))
				]
			}
		);
	});
});
