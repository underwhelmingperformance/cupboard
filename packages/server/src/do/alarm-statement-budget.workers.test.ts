import { cacheNameSchema } from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { type ParsedUploadPathMetadata } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeEach, describe, expect, it } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import { narInfoDeletions } from '../db/schema.ts';
import {
	d1StatementsPerReaperInvocation,
	requestOriginSchema
} from '../http/http.ts';
import {
	bootstrap,
	countingD1,
	currentServer,
	narBytes,
	pushPath,
	resetTestServer,
	uploadMetadata,
	useTestServer
} from '../test-support.ts';

import { boundedD1 } from './bounded-io.ts';
import { teardownEntryPrefix } from './cache-admin-service.ts';
import { gcContinuationKey, maintenancePassCursorKey } from './server.ts';

const buildsCache = cacheNameSchema.parse('builds');
const origin = requestOriginSchema.parse('https://cache.example');
const storePathAlphabet = '0123456789abcdfghijklmnpqrsvwxyz';

// A Durable Object may hold six outgoing connections at once, so push in groups
// of that size to fill a large cache without queueing behind the cap.
const pushConcurrency = 6;

// More paths than one teardown pass can retire, so the drain stops on its
// statement budget and later alarms have to resume it.
const committedPaths = 360;

// The scope a bounded collection pass leaves behind when it runs out of
// allowance.
const collectLimit = 100;

interface AlarmObservation {
	readonly alarmNumber: number;
	readonly statements: number;
	readonly pass: string;
	readonly queuedDeletions: number;
}

function indexedMetadata(index: number): ParsedUploadPathMetadata {
	const suffix =
		storePathAlphabet.charAt(Math.floor(index / 32)) +
		storePathAlphabet.charAt(index % 32);

	return uploadMetadata({
		storePathHash: `${'0'.repeat(30)}${suffix}`,
		name: `path-${suffix}`,
		fileSize: narBytes.byteLength
	});
}

async function publishCommittedPaths(server: string): Promise<void> {
	await useTestServer(server);

	const { token } = await bootstrap();

	for (let start = 0; start < committedPaths; start += pushConcurrency) {
		await Promise.all(
			Array.from({ length: pushConcurrency }, (_, offset) =>
				pushPath(token, indexedMetadata(start + offset), 'builds')
			)
		);
	}
}

/**
 * Deletes the cache, leaves a garbage-collection continuation beside the
 * teardown backlog, and runs alarms until both are drained. Reports the D1
 * statement count, maintenance pass, and queued deletion count for each alarm.
 *
 * The deletion, continuation setup and alarm loop run inside one Durable
 * Object invocation. The loop uses `blockConcurrencyWhile` so scheduled
 * alarm delivery cannot interleave with its per-alarm observations.
 */
async function driveAlarms(
	server: string,
	maxAlarms: number
): Promise<{
	readonly alarms: readonly AlarmObservation[];
	readonly teardownPending: unknown;
	readonly collectionPending: unknown;
	readonly queuedDeletions: number;
}> {
	await publishCommittedPaths(server);

	const counting = countingD1(env.CUPBOARD_DB);

	return runInDurableObject(currentServer(), async (instance, state) => {
		const real = instance.context.d1;

		Object.defineProperty(instance.context, 'd1', {
			configurable: true,
			value: drizzleD1(boundedD1(counting.binding), { schema: d1Schema })
		});

		await instance.runCacheTeardown(buildsCache, origin);
		await state.storage.put(gcContinuationKey, [
			{ scope: 'tenant', collectLimit }
		]);

		const teardownKey = `${teardownEntryPrefix}${buildsCache}`;
		const queueDepth = (): number =>
			drizzle(state.storage, { schema: { narInfoDeletions } })
				.select({ storePathHash: narInfoDeletions.storePathHash })
				.from(narInfoDeletions)
				.all().length;
		const alarms: AlarmObservation[] = [];

		// Deletion arms a real alarm, and each manually driven alarm arms the
		// next. Fake timers freeze Date in the isolate while the alarm scheduler
		// uses real time, so the object has a genuinely armed, permanently due
		// alarm throughout the loop. One runInDurableObject invocation does not
		// prevent the runtime from delivering that alarm across an await.
		// blockConcurrencyWhile defers other event deliveries until its callback
		// finishes, so no scheduled alarm can run a maintenance pass between two
		// recorded observations.
		await state.blockConcurrencyWhile(async () => {
			for (let taken = 0; taken < maxAlarms; taken += 1) {
				const hasTeardown =
					(await state.storage.get(teardownKey)) !== undefined;
				const hasCollection =
					(await state.storage.get(gcContinuationKey)) !== undefined;

				if (!hasTeardown && !hasCollection) {
					break;
				}

				const before = counting.statementsSent();
				const queuedDeletions = queueDepth();
				await instance.alarm();
				alarms.push({
					alarmNumber: taken + 1,
					statements: counting.statementsSent() - before,
					pass:
						(await state.storage.get<string>(maintenancePassCursorKey)) ??
						'none',
					queuedDeletions
				});
			}
		});

		Object.defineProperty(instance.context, 'd1', {
			configurable: true,
			value: real
		});

		return {
			alarms,
			teardownPending: await state.storage.get(teardownKey),
			collectionPending: await state.storage.get(gcContinuationKey),
			queuedDeletions: queueDepth()
		};
	});
}

describe('alarm D1 statement budget', () => {
	beforeEach(resetTestServer);

	it('keeps teardown and garbage-collection alarms within the 50-statement D1 limit', async () => {
		const driven = await driveAlarms('alarm-budget-cap', 12);

		// A teardown drain and a collection pass each size their page for a whole
		// invocation, so an alarm that runs both together would exceed the limit.
		// Counting whole invocations means a costlier pass fails here instead of
		// on Workers Free.
		//
		// The first alarm issues 44 statements: two for maintenance eligibility
		// and six for each of seven retirement chunks. Each later count depends on
		// the rows processed earlier, so assert only that it does not exceed the
		// budget.
		expect({
			queuedDeletionsAtFirstAlarm: driven.alarms[0]?.queuedDeletions,
			firstAlarmStatements: driven.alarms[0]?.statements,
			overBudgetAlarms: driven.alarms.filter(
				(alarm) => alarm.statements > d1StatementsPerReaperInvocation
			),
			statementBudget: d1StatementsPerReaperInvocation,
			passes: [...new Set(driven.alarms.map((alarm) => alarm.pass))].toSorted(
				byCodeUnit
			),
			teardownPending: driven.teardownPending,
			collectionPending: driven.collectionPending,
			queuedDeletions: driven.queuedDeletions
		}).toStrictEqual({
			queuedDeletionsAtFirstAlarm: committedPaths,
			firstAlarmStatements: 44,
			overBudgetAlarms: [],
			statementBudget: 50,
			// Only teardown and garbage collection are due in this fixture. Any
			// other value identifies unrelated maintenance work that ran during the
			// alarm loop.
			passes: ['garbage-collection', 'teardown'],
			teardownPending: undefined,
			collectionPending: undefined,
			queuedDeletions: 0
		});
	}, 240_000);

	it('finishes both the teardown backlog and the collection continuation across successive alarms', async () => {
		const driven = await driveAlarms('alarm-budget-fairness', 12);

		// Each alarm starts its search after the maintenance pass recorded by the
		// previous alarm, so garbage collection runs before teardown finishes.
		// Given 360 queued deletions and the configured pass limits, both work
		// sources complete in the three alarms asserted below.
		expect({
			queuedDeletionsAtFirstAlarm: driven.alarms[0]?.queuedDeletions,
			passes: driven.alarms.map((alarm) => alarm.pass),
			teardownPending: driven.teardownPending,
			collectionPending: driven.collectionPending,
			queuedDeletions: driven.queuedDeletions
		}).toStrictEqual({
			queuedDeletionsAtFirstAlarm: committedPaths,
			passes: ['teardown', 'garbage-collection', 'teardown'],
			teardownPending: undefined,
			collectionPending: undefined,
			queuedDeletions: 0
		});
	}, 240_000);
});
