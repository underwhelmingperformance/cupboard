import {
	currentLocalStep,
	type DeploymentPhaseName,
	deploymentPhaseRowId
} from '@cupboard/protocol/deployment';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { describe, expect, it } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import { SharedFactsUnavailableError } from '../errors.ts';
import { testBase } from '../test-support.ts';

import { DeploymentPhaseGate, phaseCacheMs } from './deployment-phase-gate.ts';

async function recordPhase(phase: string): Promise<void> {
	await env.CUPBOARD_DB.prepare(
		'INSERT INTO deployment_phase (id, phase, required_local_step, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET phase = excluded.phase'
	)
		.bind(
			deploymentPhaseRowId,
			phase,
			currentLocalStep,
			isoTimestampSchema.parse('2026-01-01T00:00:00.000Z')
		)
		.run();
}

// Every phase's answer at once, so a test compares the whole ordering.
async function reached(
	gate: DeploymentPhaseGate
): Promise<Record<DeploymentPhaseName, boolean>> {
	return {
		current: await gate.hasReached('current'),
		expanded: await gate.hasReached('expanded'),
		'native-reads': await gate.hasReached('native-reads'),
		contracted: await gate.hasReached('contracted')
	};
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

describe('deployment phase gate', () => {
	it('has reached no phase while no deploy has recorded one', async () => {
		const gate = new DeploymentPhaseGate(
			drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
		);

		expect(await reached(gate)).toStrictEqual({
			current: false,
			expanded: false,
			'native-reads': false,
			contracted: false
		});
	});

	it('has reached the recorded phase and the ones before it', async () => {
		await recordPhase('expanded');
		const gate = new DeploymentPhaseGate(
			drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
		);

		expect(await reached(gate)).toStrictEqual({
			current: true,
			expanded: true,
			'native-reads': false,
			contracted: false
		});
	});

	it('reads the row again only once its last reading is older than the interval', async () => {
		let clock = testBase.getTime();
		const gate = new DeploymentPhaseGate(
			drizzleD1(env.CUPBOARD_DB, { schema: d1Schema }),
			() => clock
		);

		const hasReachedBeforeRecord = await gate.hasReached('expanded');
		await recordPhase('expanded');
		clock += phaseCacheMs - 1;
		const hasReachedWithinInterval = await gate.hasReached('expanded');
		clock += 1;
		const hasReachedAfterInterval = await gate.hasReached('expanded');

		expect({
			hasReachedBeforeRecord,
			hasReachedWithinInterval,
			hasReachedAfterInterval
		}).toStrictEqual({
			hasReachedBeforeRecord: false,
			hasReachedWithinInterval: false,
			hasReachedAfterInterval: true
		});
	});

	it('treats a phase name this build does not define as no phase', async () => {
		await recordPhase('legacy-dropped');
		const gate = new DeploymentPhaseGate(
			drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
		);

		expect(await reached(gate)).toStrictEqual({
			current: false,
			expanded: false,
			'native-reads': false,
			contracted: false
		});
	});

	it('refuses retryably after the read fails twice', async () => {
		const attempts = { count: 0 };
		const gate = new DeploymentPhaseGate(
			drizzleD1(failingD1(attempts), { schema: d1Schema })
		);

		let caught: unknown;

		try {
			await gate.hasReached('expanded');
		} catch (error) {
			caught = error;
		}

		expect({
			caught: caught instanceof SharedFactsUnavailableError,
			attempts: attempts.count
		}).toStrictEqual({ caught: true, attempts: 2 });
	});
});
