import { env } from 'cloudflare:workers';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { describe, expect, it } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import { SharedFactsUnavailableError } from '../errors.ts';
import { recordTransition, testBase } from '../test-support.ts';

import { transitionCacheMs, TransitionGate } from './transition-gate.ts';

async function recordRow(id: string, state: string): Promise<void> {
	await env.CUPBOARD_DB.prepare(
		'INSERT INTO deployment_transition (id, state, updated_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET state = excluded.state'
	)
		.bind(id, state, '2026-01-01T00:00:00.000Z')
		.run();
}

// Both states of the cache-identity transition at once, so a test compares
// the whole ordering.
async function reached(
	gate: TransitionGate
): Promise<{ expanded: boolean; complete: boolean }> {
	return {
		expanded: await gate.hasReached('cache-identity', 'expanded'),
		complete: await gate.hasReached('cache-identity', 'complete')
	};
}

function gateOver(d1: D1Database = env.CUPBOARD_DB, now?: () => number) {
	return new TransitionGate(drizzleD1(d1, { schema: d1Schema }), now);
}

function failingD1(attempts: { count: number }): D1Database {
	const inner = env.CUPBOARD_DB;

	return {
		prepare: () => {
			attempts.count += 1;

			throw new Error('simulated D1 outage');
		},
		batch: inner.batch.bind(inner),
		exec: inner.exec.bind(inner),
		withSession: inner.withSession.bind(inner),
		dump: () => Promise.reject(new Error('dump is not supported here'))
	};
}

describe('transition gate', () => {
	it('has reached no state while no deploy has recorded the transition', async () => {
		expect(await reached(gateOver())).toStrictEqual({
			expanded: false,
			complete: false
		});
	});

	it('has reached the recorded state and the ones before it', async () => {
		await recordTransition('cache-identity', 'expanded');
		const expanded = await reached(gateOver());
		await recordTransition('cache-identity', 'complete');
		const complete = await reached(gateOver());

		expect({ expanded, complete }).toStrictEqual({
			expanded: { expanded: true, complete: false },
			complete: { expanded: true, complete: true }
		});
	});

	it('answers for each transition from its own row', async () => {
		await recordTransition('deployment-transitions', 'complete');
		const gate = gateOver();

		expect({
			cacheIdentity: await reached(gate),
			deploymentTransitions: await gate.hasReached(
				'deployment-transitions',
				'complete'
			)
		}).toStrictEqual({
			cacheIdentity: { expanded: false, complete: false },
			deploymentTransitions: true
		});
	});

	it('reads the rows again only once its last reading is older than the interval', async () => {
		let clock = testBase.getTime();
		const gate = gateOver(env.CUPBOARD_DB, () => clock);

		const isBeforeRecord = await gate.hasReached('cache-identity', 'complete');
		await recordTransition('cache-identity', 'complete');
		clock += transitionCacheMs - 1;
		const isWithinInterval = await gate.hasReached(
			'cache-identity',
			'complete'
		);
		clock += 1;
		const isAfterInterval = await gate.hasReached('cache-identity', 'complete');

		expect({
			beforeRecord: isBeforeRecord,
			withinInterval: isWithinInterval,
			afterInterval: isAfterInterval
		}).toStrictEqual({
			beforeRecord: false,
			withinInterval: false,
			afterInterval: true
		});
	});

	it('answers from a fresh reading after a refresh', async () => {
		const clock = testBase.getTime();
		const gate = gateOver(env.CUPBOARD_DB, () => clock);

		const isBeforeRecord = await gate.hasReached('cache-identity', 'complete');
		await recordTransition('cache-identity', 'complete');
		const isStale = await gate.hasReached('cache-identity', 'complete');
		await gate.refresh();
		const isRefreshed = await gate.hasReached('cache-identity', 'complete');

		expect({
			beforeRecord: isBeforeRecord,
			stale: isStale,
			refreshed: isRefreshed
		}).toStrictEqual({
			beforeRecord: false,
			stale: false,
			refreshed: true
		});
	});

	it.each([
		{ name: 'a transition id', id: 'later-transition', state: 'complete' },
		{ name: 'a state', id: 'cache-identity', state: 'later-state' }
	])(
		'treats $name this build does not define as nothing recorded',
		async ({ id, state }) => {
			await recordRow(id, state);

			expect(await reached(gateOver())).toStrictEqual({
				expanded: false,
				complete: false
			});
		}
	);

	it('refuses retryably after the read fails twice', async () => {
		const attempts = { count: 0 };
		const gate = gateOver(failingD1(attempts));

		let caught: unknown;

		try {
			await gate.hasReached('cache-identity', 'expanded');
		} catch (error) {
			caught = error;
		}

		expect({
			caught: caught instanceof SharedFactsUnavailableError,
			attempts: attempts.count
		}).toStrictEqual({ caught: true, attempts: 2 });
	});
});
