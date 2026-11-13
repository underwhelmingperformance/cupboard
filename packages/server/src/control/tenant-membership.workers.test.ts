import { type TenantId, tenantIdSchema } from '@cupboard/nix-store/scalars';
import {
	kvOperationsPerInvocation,
	kvOperationsReserve
} from '@cupboard/protocol/platform';
import { env as tenantEnv } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';

import { NarReadBufferPool } from '../blob/nar-read-buffers.ts';
import { passThrough } from '../http/stalled-body.test-support.ts';
import {
	enqueueMaintenanceJobs,
	handleMaintenanceQueue,
	type MaintenanceQueueMessage
} from '../routing/scheduled.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import { resetTestServer, testControlEnv } from '../test-support.ts';

import { insertBulkTenants } from './bulk-tenants.test-support.ts';
import { controlMembershipRebuild } from './control-plane.ts';
import { tenantMemberKey } from './tenant-member-key.ts';
import { reconcileTenantMembership } from './tenant-membership.ts';

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

/**
The KV operations that an invocation made. `gets` counts every read of a
key, and `lists` counts every listing.
*/
interface KvOperations {
	readonly puts: string[];
	readonly deletes: string[];
	readonly gets: number;
	readonly lists: number;
}

// An environment whose KV namespace records its operations and whose queue
// records its messages. `puts` accumulates every put. `take` returns the
// operations since the previous call and resets the per-call record.
// `listOverride` can replace the keys and the cursor of an incomplete listing,
// from the options of the call and the number of the call. It returns
// `undefined` to use the real listing.
function recordedEnvironment(
	options: {
		readonly failure?: Error;
		readonly listOverride?: (
			listOptions: KVNamespaceListOptions | undefined,
			call: number
		) =>
			| { readonly keys: { name: string }[]; readonly cursor: string }
			| undefined;
	} = {}
) {
	let listCalls = 0;
	const overriddenCursors = new Set<string>();
	const puts: string[] = [];
	let sinceTake: {
		puts: string[];
		deletes: string[];
		gets: number;
		lists: number;
	} = {
		puts: [],
		deletes: [],
		gets: 0,
		lists: 0
	};
	const messages: MaintenanceQueueMessage[] = [];
	const kv = new Proxy(baseEnv.TENANT_CACHE, {
		get(target, property) {
			if (property === 'put') {
				return (key: string, value: string | ArrayBuffer) => {
					puts.push(key);
					sinceTake.puts.push(key);

					return options.failure === undefined
						? target.put(key, value)
						: Promise.reject(options.failure);
				};
			}

			if (property === 'delete') {
				return (key: string) => {
					sinceTake.deletes.push(key);

					return target.delete(key);
				};
			}

			if (property === 'get') {
				return (key: string, type: 'arrayBuffer') => {
					sinceTake.gets += 1;

					return target.get(key, type);
				};
			}

			if (property === 'list') {
				return async (listOptions?: KVNamespaceListOptions) => {
					sinceTake.lists += 1;
					listCalls += 1;

					if (options.failure !== undefined) {
						throw options.failure;
					}

					// A cursor that an override returned leads to the real listing from the
					// start, which models a cursor that leads to the remaining keys.
					const { cursor, ...withoutCursor } = listOptions ?? {};
					const listing = await target.list(
						typeof cursor === 'string' && overriddenCursors.has(cursor)
							? withoutCursor
							: listOptions
					);
					const overridden = options.listOverride?.(listOptions, listCalls);

					if (overridden === undefined) {
						return listing;
					}

					overriddenCursors.add(overridden.cursor);

					return { ...listing, ...overridden, list_complete: false as const };
				};
			}

			return passThrough(target, property);
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
		take(): KvOperations {
			const taken = sinceTake;
			sinceTake = { puts: [], deletes: [], gets: 0, lists: 0 };

			return taken;
		},
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
});

type Recorded = ReturnType<typeof recordedEnvironment>;

// Runs one cron tick and every queued membership message that follows from
// it, in order. Returns the KV operations of each invocation.
async function runMembershipTick(recorded: Recorded): Promise<KvOperations[]> {
	const answers: string[] = [];
	const invocations: KvOperations[] = [];

	await enqueueMaintenanceJobs(recorded.environment, recorded.queue);
	invocations.push(recorded.take());

	let queued = recorded.messages.filter(
		(message) => message.kind === 'membership-refresh'
	);

	while (queued[0] !== undefined) {
		recorded.messages.length = 0;
		await handleMaintenanceQueue(
			queueBatch(queued[0], answers),
			recorded.environment,
			new NarReadBufferPool()
		);
		invocations.push(recorded.take());
		queued = recorded.messages.filter(
			(message) => message.kind === 'membership-refresh'
		);
	}

	recorded.messages.length = 0;

	return invocations;
}

// A tick that finds nothing to change: one listing, and one read of the stored
// filter to compare it with the rebuilt one.
const unchangedInvocation: KvOperations = {
	puts: [],
	deletes: [],
	gets: 1,
	lists: 1
};

describe('membership refresh from the cron', () => {
	beforeEach(resetTestServer);

	it.each([1, 50])(
		'makes no KV write in a tick when %i live tenants already have markers',
		async (tenants) => {
			await insertBulkTenants(tenants);
			const recorded = recordedEnvironment();
			await runMembershipTick(recorded);

			expect(await runMembershipTick(recorded)).toStrictEqual([
				unchangedInvocation
			]);
		}
	);

	it('writes only the marker and the filter for a tenant that has no marker', async () => {
		const recorded = recordedEnvironment();
		await runMembershipTick(recorded);
		await insertBulkTenants(1);

		expect(await runMembershipTick(recorded)).toStrictEqual([
			{
				puts: [tenantMemberKey(tenantIdSchema.parse('bulk000001')), filterKey],
				deletes: [],
				gets: 1,
				lists: 1
			}
		]);
	});

	it('deletes the marker of a tenant that is no longer live and rewrites the filter', async () => {
		await insertBulkTenants(3);
		const recorded = recordedEnvironment();
		await runMembershipTick(recorded);
		await baseEnv.CUPBOARD_DB.prepare(
			"UPDATE tenant SET status = 'offboarded' WHERE id = 'bulk000002'"
		).run();

		expect(await runMembershipTick(recorded)).toStrictEqual([
			{
				puts: [filterKey],
				deletes: [tenantMemberKey(tenantIdSchema.parse('bulk000002'))],
				gets: 1,
				lists: 1
			}
		]);
	});

	it('sends the maintenance jobs and then rejects when the membership refresh fails', async () => {
		const healthy = recordedEnvironment();
		await enqueueMaintenanceJobs(healthy.environment, healthy.queue);
		const failure = new Error('KV unavailable');
		const failing = recordedEnvironment({ failure });

		await expect(
			enqueueMaintenanceJobs(failing.environment, failing.queue)
		).rejects.toBe(failure);
		expect(failing.messages).toStrictEqual(healthy.messages);
	});

	// The fixture tenant already has a marker, and it sorts after the bulk
	// tenants. The third invocation lists two pages: the first page now ends
	// before the point where the chain continues, so it skips that page.
	it('writes the missing markers once through the queued invocations', async () => {
		await insertBulkTenants(2000);
		const slugs = await liveSlugs();
		const bulk = slugs.slice(0, 2000);
		const recorded = recordedEnvironment();

		const invocations = await runMembershipTick(recorded);

		expect({ invocations, puts: recorded.puts }).toStrictEqual({
			invocations: [
				{
					puts: [...markerKeys(bulk.slice(0, pageSize)), filterKey],
					deletes: [],
					gets: 1,
					lists: 1
				},
				{
					puts: markerKeys(bulk.slice(pageSize, 2 * pageSize)),
					deletes: [],
					gets: 0,
					lists: 1
				},
				{
					puts: markerKeys(bulk.slice(2 * pageSize)),
					deletes: [],
					gets: 0,
					lists: 2
				}
			],
			puts: [
				...markerKeys(bulk.slice(0, pageSize)),
				filterKey,
				...markerKeys(bulk.slice(pageSize))
			]
		});
	});

	it('lists one page of markers in each invocation and deletes a stale marker on the page that contains it', async () => {
		await insertBulkTenants(1200);
		const recorded = recordedEnvironment();
		await runMembershipTick(recorded);
		const stale = tenantMemberKey(tenantIdSchema.parse('bulk001201'));
		await baseEnv.TENANT_CACHE.put(stale, '1');

		expect(await runMembershipTick(recorded)).toStrictEqual([
			unchangedInvocation,
			{ puts: [], deletes: [stale], gets: 0, lists: 1 }
		]);
	});

	// KV can answer a listing with no keys and `list_complete: false` while it
	// steps over the tombstones of deleted keys. The namespace of the test
	// environment cannot produce such a page, so the override answers the first
	// call with one. The cursor that it returns leads to the real listing.
	it('rewrites no marker when the first listing page is empty but incomplete', async () => {
		await insertBulkTenants(50);
		await runMembershipTick(recordedEnvironment());
		const recorded = recordedEnvironment({
			listOverride: (listOptions, call) =>
				call === 1 ? { keys: [], cursor: 'after-tombstones' } : undefined
		});

		expect(await runMembershipTick(recorded)).toStrictEqual([
			{ puts: [], deletes: [], gets: 1, lists: 2 }
		]);
	});

	// Every listing answers with a page that ends before `after`, so the step
	// skips as many pages as its budget allows and then continues by cursor.
	it('keeps its position and continues by cursor when the skipped pages reach the cap', async () => {
		await insertBulkTenants(3);
		const after = tenantIdSchema.parse('bulk000002');
		const recorded = recordedEnvironment({
			listOverride: (_listOptions, call) => ({
				keys: [{ name: tenantMemberKey(tenantIdSchema.parse('bulk000001')) }],
				cursor: `page-${String(call)}`
			})
		});

		const step = await reconcileTenantMembership(recorded.environment, {
			after,
			listCursor: 'start'
		});

		expect({ step, operations: recorded.take() }).toStrictEqual({
			step: {
				written: 0,
				deleted: 0,
				next: { after, listCursor: 'page-101' }
			},
			operations: { puts: [], deletes: [], gets: 0, lists: 101 }
		});
	});

	// With 1,000 of the 1,900 bulk markers present, the first step reads 1,900
	// live tenants and one more, and writes the 900 missing markers, which is
	// the whole write budget. It continues after the last tenant that it read.
	it('continues after the last tenant that it read when the live tenants fill the step', async () => {
		await insertBulkTenants(1900);
		await runMembershipTick(recordedEnvironment());
		const slugs = await liveSlugs();
		const bulk = slugs.slice(0, 1900);
		const missing = bulk.slice(100, 1000);
		await Promise.all(
			[...markerKeys(missing), tenantMemberKey(fixtureTenant)].map((key) =>
				baseEnv.TENANT_CACHE.delete(key)
			)
		);
		const recorded = recordedEnvironment();

		expect(await runMembershipTick(recorded)).toStrictEqual([
			{ puts: markerKeys(missing), deletes: [], gets: 1, lists: 1 },
			{
				puts: [tenantMemberKey(fixtureTenant)],
				deletes: [],
				gets: 0,
				lists: 2
			}
		]);
	});

	// 950 stale markers sort before the fixture tenant's marker. The first step
	// deletes 900 of them, so the next step continues after a deleted slug.
	it('continues after a deleted marker when the deletes fill the step', async () => {
		const settled = recordedEnvironment();
		await runMembershipTick(settled);
		const stale = Array.from({ length: 950 }, (_, index) =>
			tenantMemberKey(
				tenantIdSchema.parse(`stale${String(index + 1).padStart(6, '0')}`)
			)
		);
		await Promise.all(stale.map((key) => baseEnv.TENANT_CACHE.put(key, '1')));
		onTestFinished(async () => {
			await Promise.all(stale.map((key) => baseEnv.TENANT_CACHE.delete(key)));
		});
		const recorded = recordedEnvironment();

		expect(await runMembershipTick(recorded)).toStrictEqual([
			{ puts: [], deletes: stale.slice(0, 900), gets: 1, lists: 1 },
			{ puts: [], deletes: stale.slice(900), gets: 0, lists: 1 }
		]);
	});

	// A message from the previous build has only `after`. The step lists from the
	// start and queues the step that follows its page.
	it('continues a queued message that has only the slug', async () => {
		await insertBulkTenants(1200);
		await runMembershipTick(recordedEnvironment());
		const recorded = recordedEnvironment();
		const answers: string[] = [];

		await handleMaintenanceQueue(
			queueBatch(
				{
					kind: 'membership-refresh',
					after: tenantIdSchema.parse('bulk000500')
				},
				answers
			),
			recorded.environment,
			new NarReadBufferPool()
		);

		const [queued] = recorded.messages;
		const listCursor =
			queued?.kind === 'membership-refresh' ? queued.listCursor : undefined;

		expect({
			answers,
			operations: recorded.take(),
			queued,
			hasListCursor: listCursor !== undefined
		}).toStrictEqual({
			answers: ['ack'],
			operations: { puts: [], deletes: [], gets: 0, lists: 1 },
			queued: {
				kind: 'membership-refresh',
				after: tenantIdSchema.parse('bulk001000'),
				listCursor
			},
			hasListCursor: true
		});
	});

	// The first step reads 101 empty incomplete pages, which is the skip budget
	// plus the first listing. It writes the filter, because the tenant set
	// changed, and continues from the cursor of the last page. The queued step
	// then finds the real markers and writes the one that is missing.
	it('publishes the filter and continues from the cursor when the first step reaches only empty pages', async () => {
		await runMembershipTick(recordedEnvironment());
		await insertBulkTenants(1);
		const recorded = recordedEnvironment({
			listOverride: (_listOptions, call) =>
				call <= 101 ? { keys: [], cursor: `empty-${String(call)}` } : undefined
		});

		expect(await runMembershipTick(recorded)).toStrictEqual([
			{ puts: [filterKey], deletes: [], gets: 1, lists: 101 },
			{
				puts: [tenantMemberKey(tenantIdSchema.parse('bulk000001'))],
				deletes: [],
				gets: 0,
				lists: 1
			}
		]);
	});

	it('continues from the cursor of the last page when a queued step reaches only empty pages', async () => {
		await insertBulkTenants(3);
		const after = tenantIdSchema.parse('bulk000002');
		const recorded = recordedEnvironment({
			listOverride: (_listOptions, call) => ({
				keys: [],
				cursor: `empty-${String(call)}`
			})
		});

		const step = await reconcileTenantMembership(recorded.environment, {
			after,
			listCursor: 'start'
		});

		expect({ step, operations: recorded.take() }).toStrictEqual({
			step: {
				written: 0,
				deleted: 0,
				next: { after, listCursor: 'empty-101' }
			},
			operations: { puts: [], deletes: [], gets: 0, lists: 101 }
		});
	});

	// One skipped page leaves 899 of the 900 operations for writes. A step that
	// has more changes than that writes 899 markers, so the invocation stays
	// within its KV operations.
	it('reduces the writes of a step by the pages that it skipped', async () => {
		await insertBulkTenants(2000);
		await baseEnv.TENANT_CACHE.delete(filterKey);
		const slugs = await liveSlugs();
		const bulk = slugs.slice(0, 2000);
		const recorded = recordedEnvironment({
			listOverride: (_listOptions, call) =>
				call === 1 ? { keys: [], cursor: 'skipped' } : undefined
		});

		const step = await reconcileTenantMembership(recorded.environment);

		expect({ step, operations: recorded.take() }).toStrictEqual({
			step: {
				written: 899,
				deleted: 0,
				next: { after: bulk[898], listCursor: 'skipped' }
			},
			operations: {
				puts: [...markerKeys(bulk.slice(0, 899)), filterKey],
				deletes: [],
				gets: 1,
				lists: 2
			}
		});
	});
});
