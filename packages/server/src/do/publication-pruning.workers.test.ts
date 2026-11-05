import { rootLogger } from '@cupboard/logger';
import { uploadIdSchema } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../db/schema.ts';
import {
	asOneInvocation,
	currentServer,
	initialise,
	resetTestServer,
	testPushId,
	verificationOf
} from '../test-support.ts';

import { PublicationStore } from './publication-store.ts';
import { type CupboardServer } from './server.ts';

const fiveMinutes = 5 * 60 * 1000;

interface SeededOperation {
	readonly state: 'accepted' | 'servable' | 'failed' | 'expired';
	readonly recoveryDeadline: number;
	readonly pruneAfter: number;
}

function insertOperations(
	instance: CupboardServer,
	operations: readonly SeededOperation[]
): void {
	const cache = instance.context.db.select().from(schema.cacheIdentities).get();
	if (cache === undefined) {
		throw new Error('Expected the default cache');
	}
	const now = new Date().toISOString();
	for (const [index, operation] of operations.entries()) {
		instance.context.db
			.insert(schema.publicationOperations)
			.values({
				id: uploadIdSchema.parse(index.toString(16).padStart(64, '0')),
				cacheId: cache.id,
				cacheGeneration: cache.generation,
				pushId: testPushId,
				canonicalJson: '[]',
				acceptedAt: now,
				pushExpiresAt: now,
				recoveryDeadline: new Date(operation.recoveryDeadline).toISOString(),
				pruneAfter: new Date(operation.pruneAfter).toISOString(),
				graceDecisionJson: '{"reportsGrace":true}',
				state: operation.state
			})
			.run();
	}
}

function remainingOperations(instance: CupboardServer): number {
	return instance.context.db
		.select({ id: schema.publicationOperations.id })
		.from(schema.publicationOperations)
		.all().length;
}

// A five-minute boundary an hour ahead of the real clock. Durable Object
// alarms use the real clock, so no alarm armed in these tests becomes due.
function futureWindowStart(): number {
	return Math.ceil((Date.now() + 60 * 60 * 1000) / fiveMinutes) * fiveMinutes;
}

function terminalBurst(
	start: number,
	count: number,
	spacingMs: number
): SeededOperation[] {
	const states = ['servable', 'failed', 'expired'] as const;
	return Array.from({ length: count }, (_, index) => ({
		state: states[index % states.length] ?? 'servable',
		recoveryDeadline: start,
		pruneAfter: start + index * spacingMs
	}));
}

describe('publication pruning alarms', () => {
	beforeEach(async () => {
		vi.setSystemTime(vi.getRealSystemTime());
		await resetTestServer();
	});

	it.each([
		{
			name: 'wakes once at the end of the window for a burst of terminal records',
			operations: (start: number) => terminalBurst(start + 1000, 50, 100),
			notBefore: (start: number) => start - fiveMinutes,
			alarm: (start: number) => start + fiveMinutes
		},
		{
			name: 'arms the recovery deadline of an accepted operation exactly',
			operations: (start: number) => [
				...terminalBurst(start + 1000, 50, 100),
				{
					state: 'accepted' as const,
					recoveryDeadline: start + 30_123,
					pruneAfter: start + fiveMinutes * 4
				}
			],
			notBefore: (start: number) => start - fiveMinutes,
			alarm: (start: number) => start + 30_123
		},
		{
			name: 'arms at notBefore when a terminal record is already due',
			operations: (start: number) => terminalBurst(start + 1000, 50, 100),
			notBefore: (start: number) => start + 2000,
			alarm: (start: number) => start + 2000
		}
	])('$name', async ({ operations, notBefore, alarm }) => {
		await initialise();
		const start = futureWindowStart();
		const armed = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				insertOperations(instance, operations(start));
				await state.storage.deleteAlarm();
				await new PublicationStore(instance.context).armRecoveryAlarm(
					notBefore(start)
				);
				return state.storage.getAlarm();
			}
		);
		expect(armed).toBe(alarm(start));
	});

	it('continues pruning when one pass reaches its limit', async () => {
		await initialise();
		const passedAt = Date.now();
		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				insertOperations(instance, terminalBurst(Date.now(), 1001, 0));
				await state.storage.deleteAlarm();
				await instance.alarm();
				const next = await state.storage.getAlarm();
				return {
					remaining: remainingOperations(instance),
					// The pass arms the alarm at once. Durable Object storage keeps
					// real time, so the stored alarm lies between the frozen test
					// clock and the real clock.
					isArmedNow:
						next !== null && next >= passedAt && next <= vi.getRealSystemTime()
				};
			}
		);
		expect(result).toStrictEqual({ remaining: 1, isArmedNow: true });
	});

	it('prunes a burst that spans two windows in two alarm passes', async () => {
		await initialise();
		const start = futureWindowStart();
		const wakes = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				// 60 records 5 s apart, from 2.5 minutes into the first window to
				// 2.4 minutes into the second.
				insertOperations(instance, terminalBurst(start + 150_000, 60, 5000));
				await state.storage.deleteAlarm();
				await new PublicationStore(instance.context).armRecoveryAlarm(
					Date.now()
				);
				const passes: { at: number; remaining: number }[] = [];
				let alarm = await state.storage.getAlarm();
				// Bound the loop so a regression fails on the result instead of
				// running until the test times out.
				while (alarm !== null && passes.length < 100) {
					vi.setSystemTime(alarm);
					await state.storage.deleteAlarm();
					await asOneInvocation(() =>
						verificationOf(instance).expirePublications(rootLogger())
					);
					passes.push({ at: alarm, remaining: remainingOperations(instance) });
					alarm = await state.storage.getAlarm();
				}
				return passes;
			}
		);
		expect(wakes).toStrictEqual([
			{ at: start + fiveMinutes, remaining: 29 },
			{ at: start + 2 * fiveMinutes, remaining: 0 }
		]);
	});

	it('waits for the window for a record that became due during the pass', async () => {
		await initialise();
		const start = futureWindowStart();
		const outcome = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				insertOperations(instance, [
					{
						state: 'accepted',
						recoveryDeadline: start - 1000,
						pruneAfter: start + fiveMinutes * 4
					},
					...terminalBurst(start + 500, 1, 0)
				]);
				vi.setSystemTime(start);
				// The clock passes the terminal record's `pruneAfter` while the run
				// expires the accepted operation, which is after the run starts and
				// before it prunes.
				const finishing = vi.spyOn(PublicationStore.prototype, 'finish');
				finishing.mockImplementationOnce(function (
					this: PublicationStore,
					id,
					finished,
					resultJson
				) {
					vi.setSystemTime(start + 1000);
					finishing.mockRestore();
					this.finish(id, finished, resultJson);
				});
				try {
					await state.storage.deleteAlarm();
					await asOneInvocation(() =>
						verificationOf(instance).expirePublications(rootLogger())
					);
				} finally {
					finishing.mockRestore();
				}
				return {
					alarm: await state.storage.getAlarm(),
					states: instance.context.db
						.select({ state: schema.publicationOperations.state })
						.from(schema.publicationOperations)
						.orderBy(schema.publicationOperations.id)
						.all()
				};
			}
		);
		expect(outcome).toStrictEqual({
			alarm: start + fiveMinutes,
			states: [{ state: 'expired' }, { state: 'servable' }]
		});
	});
});
