import { isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../db/schema.ts';
import { SubrequestTimeoutError, WorkersCachePurgeError } from '../errors.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	bootstrap,
	currentServer,
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
	}
): void {
	context.db
		.insert(schema.cachePurgeContinuations)
		.values({
			id: row.id,
			kind: 'mutation',
			entriesJson: JSON.stringify([`narinfo-${row.id}`]),
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
				insertRow(instance.context, {
					id: 'second',
					createdAt: now - 1000,
					expiresAt: now + 3_600_000
				});
				const purge = vi
					.spyOn(instance.context, 'purgeCacheTags')
					.mockResolvedValueOnce(undefined)
					.mockRejectedValueOnce(rateLimited(1134));

				try {
					await service.runOnce();
					const afterSuccess = await rateLimitState(state.storage);
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
