import { isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedCache } from '../db/cache.ts';
import * as schema from '../db/schema.ts';
import { SubrequestTimeoutError, WorkersCachePurgeError } from '../errors.ts';
import { narInfoCacheTag } from '../http/cache-tags.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	bootstrap,
	currentServer,
	defaultCache,
	fakeAlarm,
	narHash,
	resetTestServer,
	resolvedCache,
	syntheticStorePathHash,
	withoutAlarmArming
} from '../test-support.ts';

import { cachePurgeRateLimitKey } from './cache-purge-backoff.ts';
import { CachePurgeQueueService } from './cache-purge-queue-service.ts';
import { CachePurgeRetryPolicy } from './cache-purge-retry.ts';
import type { ServerContext } from './context.ts';

// The jitter source returns the midpoint, so each delay is three quarters of
// its ceiling.
const retryPolicy = new CachePurgeRetryPolicy(() => 0.5);

function rateLimited(code: number): WorkersCachePurgeError {
	return new WorkersCachePurgeError([
		{ code, message: 'Unable to purge, rate limit reached.' }
	]);
}

function queuedRows(context: ServerContext) {
	return context.db
		.select()
		.from(schema.cachePurgeContinuations)
		.orderBy(schema.cachePurgeContinuations.createdAt)
		.all()
		.map((row) => ({
			id: row.id,
			lastAttemptAt: row.lastAttemptAt ?? undefined,
			hasLastError: row.lastError !== null,
			nextAttemptAt: row.nextAttemptAt ?? undefined,
			failedAttempts: row.failedAttempts
		}));
}

// `count` numbered tags with the prefix, starting at `from`.
function tags(prefix: string, from: number, count: number): string[] {
	return Array.from(
		{ length: count },
		(_, index) => `${prefix}-${String(from + index).padStart(2, '0')}`
	);
}

function queuedTags(context: ServerContext): unknown[] {
	return context.db
		.select({ entriesJson: schema.cachePurgeContinuations.entriesJson })
		.from(schema.cachePurgeContinuations)
		.orderBy(schema.cachePurgeContinuations.createdAt)
		.all()
		.map((row) => JSON.parse(row.entriesJson) as unknown);
}

function rateLimitState(storage: DurableObjectStorage): Promise<unknown> {
	return storage.get(cachePurgeRateLimitKey);
}

function insertRow(
	context: ServerContext,
	row: {
		readonly id: string;
		readonly createdAt: number;
		readonly expiresAt: number;
		readonly nextAttemptAt?: number;
		readonly failedAttempts?: number;
		readonly tags?: readonly string[];
	}
): void {
	context.db
		.insert(schema.cachePurgeContinuations)
		.values({
			id: row.id,
			kind: 'mutation',
			entriesJson: JSON.stringify(row.tags ?? [`narinfo-${row.id}`]),
			createdAt: isoTimestamp(new Date(row.createdAt)),
			expiresAt: isoTimestamp(new Date(row.expiresAt)),
			nextAttemptAt:
				row.nextAttemptAt === undefined
					? undefined
					: isoTimestamp(new Date(row.nextAttemptAt)),
			failedAttempts: row.failedAttempts ?? 0
		})
		.run();
}

describe('cache purge queue', () => {
	beforeEach(resetTestServer);

	// A NAR response stored at the edge before the tag carried the cache is
	// tagged by tenant and hash alone, and it lives for the NAR TTL. A purge
	// queues that tag beside the cache's own so the old response goes too.
	it('queues the per-cache tag and the tenant-wide tag for a retired NAR', async () => {
		await bootstrap();

		const queued = await withoutAlarmArming(() =>
			runInDurableObject(currentServer(), async (instance) => {
				await new CachePurgeQueueService(instance.context).enqueueNars(
					resolvedCache(instance.context),
					[narHash]
				);

				return instance.context.db
					.select({ entriesJson: schema.cachePurgeContinuations.entriesJson })
					.from(schema.cachePurgeContinuations)
					.all()
					.map((row) => JSON.parse(row.entriesJson) as unknown);
			})
		);

		expect(queued).toStrictEqual([
			[
				`nar:${fixtureTenant}:default:${narHash}`,
				`nar:${fixtureTenant}:${narHash}`
			]
		]);
	});

	// Workers Cache never stores a private cache's responses, so a change to a
	// private cache queues no purge.
	it.each([
		{
			kind: 'narinfos',
			enqueue: (service: CachePurgeQueueService, cache: ResolvedCache) =>
				service.enqueueNarInfos(cache, [syntheticStorePathHash(1)])
		},
		{
			kind: 'NARs',
			enqueue: (service: CachePurgeQueueService, cache: ResolvedCache) =>
				service.enqueueNars(cache, [narHash])
		}
	])('queues no purge of $kind for a private cache', async ({ enqueue }) => {
		await bootstrap();

		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const service = new CachePurgeQueueService(
					instance.context,
					retryPolicy
				);
				const alarm = fakeAlarm(state.storage);
				const purge = vi
					.spyOn(instance.context, 'purgeCacheTags')
					.mockResolvedValue(undefined);

				try {
					const cache = instance.context.cacheRepository.setAccess(
						resolvedCache(instance.context),
						'private'
					);
					await enqueue(service, cache);
					await service.runOnce();

					return {
						purgeCalls: purge.mock.calls,
						rows: queuedRows(instance.context),
						alarm: alarm.scheduled()
					};
				} finally {
					purge.mockRestore();
					alarm.restore();
				}
			}
		);

		expect(result).toStrictEqual({ purgeCalls: [], rows: [], alarm: Infinity });
	});

	// Each pass sends one request. The rows' tags fill it up to the platform's
	// limit of 100 tags, oldest row first.
	it('merges queued rows into requests of up to 100 tags', async () => {
		await bootstrap();
		const now = Date.now();
		const ids = Array.from({ length: 250 }, (_, index) =>
			String(index).padStart(3, '0')
		);

		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const service = new CachePurgeQueueService(
					instance.context,
					retryPolicy
				);
				const alarm = fakeAlarm(state.storage);

				for (const [index, id] of ids.entries()) {
					insertRow(instance.context, {
						id,
						createdAt: now - 250_000 + index * 1000,
						expiresAt: now + 3_600_000
					});
				}

				const purge = vi
					.spyOn(instance.context, 'purgeCacheTags')
					.mockResolvedValue(undefined);
				const meter = instance.context.dbCost;
				const rowsWritten: number[] = [];

				try {
					for (let pass = 0; pass < 4; pass += 1) {
						meter.recordOutstanding();
						const before = meter.rowsWritten;
						await service.runOnce();
						meter.recordOutstanding();
						rowsWritten.push(meter.rowsWritten - before);
					}

					return {
						purgeCalls: purge.mock.calls.map(([tags]) => tags),
						rowsWritten,
						rows: queuedRows(instance.context)
					};
				} finally {
					purge.mockRestore();
					alarm.restore();
				}
			}
		);

		const tags = ids.map((id) => `narinfo-${id}`);

		expect(result).toStrictEqual({
			purgeCalls: [tags.slice(0, 100), tags.slice(100, 200), tags.slice(200)],
			rowsWritten: [100, 100, 50, 0],
			rows: []
		});
	});

	// A request takes rows while their distinct tags fit in 100. The first row's
	// 60 tags and the second row's 60 do not fit together, so the second row
	// starts the next request. The third row shares 10 tags with the second, and
	// the fourth row shares all of its tags with the second and third rows, so
	// the second request takes all three rows with 80 tags.
	it('stops a request at the row whose tags would exceed 100', async () => {
		await bootstrap();
		const now = Date.now();
		const rows = [
			{ id: 'first', tags: tags('a', 0, 60) },
			{ id: 'second', tags: tags('b', 0, 60) },
			{ id: 'third', tags: [...tags('b', 50, 10), ...tags('c', 0, 20)] },
			{ id: 'fourth', tags: [...tags('b', 0, 10), ...tags('c', 0, 20)] }
		];

		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const service = new CachePurgeQueueService(
					instance.context,
					retryPolicy
				);
				const alarm = fakeAlarm(state.storage);

				for (const [index, row] of rows.entries()) {
					insertRow(instance.context, {
						...row,
						createdAt: now - 4000 + index * 1000,
						expiresAt: now + 3_600_000
					});
				}

				const purge = vi
					.spyOn(instance.context, 'purgeCacheTags')
					.mockResolvedValue(undefined);

				try {
					await service.runOnce();
					await service.runOnce();
					await service.runOnce();

					return {
						purgeCalls: purge.mock.calls.map(([sent]) => sent),
						rows: queuedRows(instance.context)
					};
				} finally {
					purge.mockRestore();
					alarm.restore();
				}
			}
		);

		expect(result).toStrictEqual({
			purgeCalls: [
				tags('a', 0, 60),
				[...tags('b', 0, 60), ...tags('c', 0, 20)]
			],
			rows: []
		});
	});

	// The first row leaves one free place in the request. Each of the ten rows
	// after it repeats one of its tags, so they add no tag and all go out in
	// the same request.
	it('merges rows whose tags are already in the request', async () => {
		await bootstrap();
		const now = Date.now();
		const head = tags('a', 0, 99);

		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const service = new CachePurgeQueueService(
					instance.context,
					retryPolicy
				);
				const alarm = fakeAlarm(state.storage);
				insertRow(instance.context, {
					id: 'head',
					createdAt: now - 11_000,
					expiresAt: now + 3_600_000,
					tags: head
				});

				for (let index = 0; index < 10; index += 1) {
					insertRow(instance.context, {
						id: `repeat-${String(index)}`,
						createdAt: now - 10_000 + index * 1000,
						expiresAt: now + 3_600_000,
						tags: tags('a', index, 1)
					});
				}

				const purge = vi
					.spyOn(instance.context, 'purgeCacheTags')
					.mockResolvedValue(undefined);

				try {
					await service.runOnce();

					return {
						purgeCalls: purge.mock.calls.map(([sent]) => sent),
						rows: queuedRows(instance.context)
					};
				} finally {
					purge.mockRestore();
					alarm.restore();
				}
			}
		);

		expect(result).toStrictEqual({ purgeCalls: [head], rows: [] });
	});

	// Each of 150 queued rows has 100 tags of its own, so every request contains
	// one row. The run still reads up to 100 rows after the first row, because
	// a row whose tags all repeat the first row's would join the request.
	it('reads a bounded number of rows for a request with a full first row', async () => {
		await bootstrap();
		const now = Date.now();

		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const service = new CachePurgeQueueService(
					instance.context,
					retryPolicy
				);
				const alarm = fakeAlarm(state.storage);

				for (let index = 0; index < 150; index += 1) {
					insertRow(instance.context, {
						id: `full-${String(index).padStart(3, '0')}`,
						createdAt: now - 150_000 + index * 1000,
						expiresAt: now + 3_600_000,
						tags: tags(`r${String(index)}`, 0, 100)
					});
				}

				const purge = vi
					.spyOn(instance.context, 'purgeCacheTags')
					.mockResolvedValue(undefined);
				const meter = instance.context.dbCost;

				try {
					meter.recordOutstanding();
					const before = {
						rowsRead: meter.rowsRead,
						rowsWritten: meter.rowsWritten
					};
					await service.runOnce();
					meter.recordOutstanding();

					return {
						purgeCalls: purge.mock.calls.map(([sent]) => sent),
						rowsRead: meter.rowsRead - before.rowsRead,
						rowsWritten: meter.rowsWritten - before.rowsWritten
					};
				} finally {
					purge.mockRestore();
					alarm.restore();
				}
			}
		);

		expect(result).toStrictEqual({
			purgeCalls: [tags('r0', 0, 100)],
			rowsRead: 404,
			rowsWritten: 1
		});
	});

	// The purge request is an RPC, and the tenant object accepts other events
	// while it waits. A row queued then is not part of the request, so it
	// remains queued after the run deletes the rows that it sent.
	it('keeps a row queued while a purge request is in flight', async () => {
		await bootstrap();
		const now = Date.now();

		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const service = new CachePurgeQueueService(
					instance.context,
					retryPolicy
				);
				const alarm = fakeAlarm(state.storage);
				insertRow(instance.context, {
					id: 'sent',
					createdAt: now - 1000,
					expiresAt: now + 3_600_000
				});
				const purge = vi
					.spyOn(instance.context, 'purgeCacheTags')
					.mockImplementationOnce(async () => {
						await service.enqueueNarInfos(resolvedCache(instance.context), [
							syntheticStorePathHash(1)
						]);
					});

				try {
					await service.runOnce();

					return {
						purgeCalls: purge.mock.calls.map(([sent]) => sent),
						rows: queuedTags(instance.context)
					};
				} finally {
					purge.mockRestore();
					alarm.restore();
				}
			}
		);

		expect(result).toStrictEqual({
			purgeCalls: [['narinfo-sent']],
			rows: [
				[
					narInfoCacheTag(
						fixtureTenant,
						defaultCache(),
						syntheticStorePathHash(1)
					)
				]
			]
		});
	});

	// The second pass simulates an alarm caused by other work. It must not send
	// the purge again before the retry time. A rate-limit refusal sets the wait
	// for every purge of the tenant object, and any other failure sets the
	// row's own wait.
	it.each([
		{
			failure: 'error 1134',
			error: rateLimited(1134),
			row: { nextAttemptAt: undefined, failedAttempts: 0 },
			rateLimit: { delayMs: 45_000, refusals: 1 },
			delayMs: 45_000
		},
		{
			failure: 'error 971',
			error: rateLimited(971),
			row: { nextAttemptAt: undefined, failedAttempts: 0 },
			rateLimit: { delayMs: 45_000, refusals: 1 },
			delayMs: 45_000
		},
		{
			failure: 'a timeout',
			error: new SubrequestTimeoutError('cache.purge'),
			row: { nextAttemptAt: 9000, failedAttempts: 1 },
			rateLimit: undefined,
			delayMs: 9000
		}
	])(
		'waits for the retry time after a purge fails with $failure',
		async ({ error, row, rateLimit, delayMs }) => {
			await bootstrap();
			const failedAt = Date.now();

			const result = await runInDurableObject(
				currentServer(),
				async (instance, state) => {
					const service = new CachePurgeQueueService(
						instance.context,
						retryPolicy
					);
					const alarm = fakeAlarm(state.storage);
					const purge = vi
						.spyOn(instance.context, 'purgeCacheTags')
						.mockRejectedValue(error);

					try {
						await service.enqueueNarInfos(resolvedCache(instance.context), [
							syntheticStorePathHash(1)
						]);
						alarm.clear();
						await service.runOnce();
						await service.runOnce();

						return {
							purgeCalls: purge.mock.calls.length,
							rows: queuedRows(instance.context).map(
								({ id: _, ...queued }) => queued
							),
							rateLimit: await rateLimitState(state.storage),
							alarm: alarm.scheduled()
						};
					} finally {
						purge.mockRestore();
						alarm.restore();
					}
				}
			);

			expect(result).toStrictEqual({
				purgeCalls: 1,
				rows: [
					{
						lastAttemptAt: isoTimestamp(new Date(failedAt)),
						hasLastError: true,
						nextAttemptAt:
							row.nextAttemptAt === undefined
								? undefined
								: isoTimestamp(new Date(failedAt + row.nextAttemptAt)),
						failedAttempts: row.failedAttempts
					}
				],
				rateLimit:
					rateLimit === undefined
						? undefined
						: {
								notBefore: failedAt + rateLimit.delayMs,
								refusals: rateLimit.refusals
							},
				alarm: failedAt + delayMs
			});
		}
	);

	// Equal jitter keeps each wait between half and all of its ceiling.
	it.each([
		{ jitter: 0, delayMs: 30_000 },
		{ jitter: 0.999, delayMs: 59_970 }
	])(
		'applies a jitter of $jitter to the rate-limit wait',
		async ({ jitter, delayMs }) => {
			await bootstrap();
			const failedAt = Date.now();

			const result = await runInDurableObject(
				currentServer(),
				async (instance, state) => {
					const service = new CachePurgeQueueService(
						instance.context,
						new CachePurgeRetryPolicy(() => jitter)
					);
					const alarm = fakeAlarm(state.storage);
					insertRow(instance.context, {
						id: 'head',
						createdAt: failedAt,
						expiresAt: failedAt + 3_600_000
					});
					const purge = vi
						.spyOn(instance.context, 'purgeCacheTags')
						.mockRejectedValue(rateLimited(1134));

					try {
						await service.runOnce();

						return {
							rateLimit: await rateLimitState(state.storage),
							alarm: alarm.scheduled()
						};
					} finally {
						purge.mockRestore();
						alarm.restore();
					}
				}
			);

			expect(result).toStrictEqual({
				rateLimit: { notBefore: failedAt + delayMs, refusals: 1 },
				alarm: failedAt + delayMs
			});
		}
	);

	it('doubles the wait after each further rate-limit refusal', async () => {
		await bootstrap();
		const failedAt = Date.now();
		const retriedAt = failedAt + 45_000;

		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const service = new CachePurgeQueueService(
					instance.context,
					retryPolicy
				);
				const alarm = fakeAlarm(state.storage);
				insertRow(instance.context, {
					id: 'head',
					createdAt: failedAt,
					expiresAt: failedAt + 3_600_000
				});
				const purge = vi
					.spyOn(instance.context, 'purgeCacheTags')
					.mockRejectedValue(rateLimited(1134));

				try {
					await service.runOnce();
					vi.setSystemTime(retriedAt);
					alarm.clear();
					await service.runOnce();

					return {
						purgeCalls: purge.mock.calls.length,
						rateLimit: await rateLimitState(state.storage),
						alarm: alarm.scheduled()
					};
				} finally {
					purge.mockRestore();
					alarm.restore();
				}
			}
		);

		expect(result).toStrictEqual({
			purgeCalls: 2,
			rateLimit: { notBefore: retriedAt + 90_000, refusals: 2 },
			alarm: retriedAt + 90_000
		});
	});

	it('starts from the shortest wait after a purge succeeds', async () => {
		await bootstrap();
		const now = Date.now();

		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const service = new CachePurgeQueueService(
					instance.context,
					retryPolicy
				);
				const alarm = fakeAlarm(state.storage);
				await state.storage.put(cachePurgeRateLimitKey, {
					notBefore: now,
					refusals: 3
				});
				insertRow(instance.context, {
					id: 'first',
					createdAt: now - 2000,
					expiresAt: now + 3_600_000
				});
				const purge = vi
					.spyOn(instance.context, 'purgeCacheTags')
					.mockResolvedValueOnce(undefined)
					.mockRejectedValueOnce(rateLimited(1134));

				try {
					await service.runOnce();
					const afterSuccess = await rateLimitState(state.storage);
					// A row queued before the first pass would go out in the same
					// request, so the second row is queued after it.
					insertRow(instance.context, {
						id: 'second',
						createdAt: now - 1000,
						expiresAt: now + 3_600_000
					});
					alarm.clear();
					await service.runOnce();

					return {
						purgeCalls: purge.mock.calls,
						afterSuccess,
						rateLimit: await rateLimitState(state.storage),
						alarm: alarm.scheduled()
					};
				} finally {
					purge.mockRestore();
					alarm.restore();
				}
			}
		);

		expect(result).toStrictEqual({
			purgeCalls: [[['narinfo-first']], [['narinfo-second']]],
			afterSuccess: undefined,
			rateLimit: { notBefore: now + 45_000, refusals: 1 },
			alarm: now + 45_000
		});
	});

	// A refusal long after the previous wait ended starts a new run of
	// refusals. A refusal soon after it continues the run.
	it.each([
		{
			previous: 'ended longer ago than the cap',
			endedMsAgo: 300_001,
			rateLimit: { delayMs: 45_000, refusals: 1 }
		},
		{
			previous: 'ended within the cap',
			endedMsAgo: 300_000,
			rateLimit: { delayMs: 225_000, refusals: 6 }
		}
	])(
		'counts a refusal after a wait that $previous',
		async ({ endedMsAgo, rateLimit }) => {
			await bootstrap();
			const now = Date.now();

			const result = await runInDurableObject(
				currentServer(),
				async (instance, state) => {
					const service = new CachePurgeQueueService(
						instance.context,
						retryPolicy
					);
					const alarm = fakeAlarm(state.storage);
					await state.storage.put(cachePurgeRateLimitKey, {
						notBefore: now - endedMsAgo,
						refusals: 5
					});
					insertRow(instance.context, {
						id: 'head',
						createdAt: now,
						expiresAt: now + 3_600_000
					});
					const purge = vi
						.spyOn(instance.context, 'purgeCacheTags')
						.mockRejectedValue(rateLimited(1134));

					try {
						await service.runOnce();

						return await rateLimitState(state.storage);
					} finally {
						purge.mockRestore();
						alarm.restore();
					}
				}
			);

			expect(result).toStrictEqual({
				notBefore: now + rateLimit.delayMs,
				refusals: rateLimit.refusals
			});
		}
	);

	// A waiting row that expires passes its own retry time and failure count to
	// the next row, so the expiry does not send the next purge at once. When no
	// queued purge remains, the shared rate-limit wait is removed.
	it.each([
		{
			expiring: 'a row with failures',
			expiredFailures: 2,
			hasNext: true,
			result: {
				purgeCalls: 0,
				rows: [
					{
						id: 'next',
						lastAttemptAt: undefined,
						hasLastError: false,
						nextAttemptAt: 60_000,
						failedAttempts: 2
					}
				],
				alarm: 60_000,
				keepsRateLimit: true
			}
		},
		{
			expiring: 'a row without failures',
			expiredFailures: 0,
			hasNext: true,
			result: {
				purgeCalls: 1,
				rows: [],
				alarm: Infinity,
				keepsRateLimit: false
			}
		},
		{
			expiring: 'the last queued row',
			expiredFailures: 2,
			hasNext: false,
			result: {
				purgeCalls: 0,
				rows: [],
				alarm: Infinity,
				keepsRateLimit: false
			}
		}
	])(
		'continues after $expiring expires',
		async ({ expiredFailures, hasNext, result: expected }) => {
			await bootstrap();
			const now = Date.now();

			const result = await runInDurableObject(
				currentServer(),
				async (instance, state) => {
					const service = new CachePurgeQueueService(
						instance.context,
						retryPolicy
					);
					const alarm = fakeAlarm(state.storage);
					await state.storage.put(cachePurgeRateLimitKey, {
						notBefore: now - 1000,
						refusals: 2
					});
					insertRow(instance.context, {
						id: 'expired',
						createdAt: now - 3_600_000,
						expiresAt: now,
						nextAttemptAt: expiredFailures === 0 ? undefined : now + 60_000,
						failedAttempts: expiredFailures
					});

					if (hasNext) {
						insertRow(instance.context, {
							id: 'next',
							createdAt: now - 1000,
							expiresAt: now + 3_600_000
						});
					}

					const purge = vi
						.spyOn(instance.context, 'purgeCacheTags')
						.mockResolvedValue(undefined);

					try {
						await service.runOnce();
						alarm.clear();
						await service.runOnce();

						return {
							purgeCalls: purge.mock.calls.length,
							rows: queuedRows(instance.context),
							alarm: alarm.scheduled(),
							rateLimit: await rateLimitState(state.storage)
						};
					} finally {
						purge.mockRestore();
						alarm.restore();
					}
				}
			);

			expect(result).toStrictEqual({
				purgeCalls: expected.purgeCalls,
				rows: expected.rows.map((row) => ({
					...row,
					nextAttemptAt: isoTimestamp(new Date(now + row.nextAttemptAt))
				})),
				alarm: now + expected.alarm,
				rateLimit: expected.keepsRateLimit
					? { notBefore: now - 1000, refusals: 2 }
					: undefined
			});
		}
	);
});
