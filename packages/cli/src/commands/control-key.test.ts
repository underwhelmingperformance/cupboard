import type {
	ControlKeyListResponse,
	ControlKeyRotateResponse,
	ControlKeySummary
} from '@cupboard/protocol/control-keys';
import type { Reporter, ResultRow } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import {
	type ControlKeyClient,
	runControlKeyList,
	runControlKeyRetire,
	runControlKeyRotate
} from './control-key.ts';

function summary(overrides: Partial<ControlKeySummary>): ControlKeySummary {
	return { kid: 'kid-1', retired: false, ...overrides };
}

function reporter(results: ResultRow[][], infos: string[] = []): Reporter {
	return {
		phase(_label, body) {
			return Promise.resolve(
				body({
					fact() {
						return;
					}
				})
			);
		},
		result(rows) {
			results.push([...rows]);
		},
		warn() {
			return;
		},
		info(message) {
			infos.push(message);
		}
	};
}

function uncalled(): never {
	throw new Error('client should not be called');
}

function controlKeyClient(
	overrides: Partial<ControlKeyClient>
): ControlKeyClient {
	return {
		list: uncalled,
		rotate: uncalled,
		retire: uncalled,
		...overrides
	};
}

describe('runControlKeyList', () => {
	it('reports a row per key, flagging retired ones', async () => {
		const results: ResultRow[][] = [];
		const response: ControlKeyListResponse = {
			keys: [
				summary({
					kid: 'kid-old',
					retired: false,
					scheduledRetireAt: '2026-01-01T00:20:30.000Z'
				}),
				summary({ kid: 'kid-new' })
			]
		};

		await runControlKeyList(
			reporter(results),
			controlKeyClient({ list: () => Promise.resolve(response) })
		);

		expect(results).toStrictEqual([
			[
				{ label: 'kid-old', value: 'live; retires 2026-01-01T00:20:30.000Z' },
				{ label: 'kid-new', value: 'live' }
			]
		]);
	});
});

describe('runControlKeyRotate', () => {
	it('rotates and reports the scheduled retirement', async () => {
		let rotateCalls = 0;
		const results: ResultRow[][] = [];
		const infos: string[] = [];
		const response: ControlKeyRotateResponse = {
			kid: 'kid-new',
			retiring: {
				kid: 'kid-old',
				scheduledRetireAt: '2026-01-01T00:20:30.000Z'
			}
		};

		await runControlKeyRotate(
			reporter(results, infos),
			controlKeyClient({
				rotate() {
					rotateCalls += 1;
					return Promise.resolve(response);
				}
			})
		);

		expect({ rotateCalls, results, infoCount: infos.length }).toStrictEqual({
			rotateCalls: 1,
			results: [
				[
					{ label: 'New key', value: 'kid-new' },
					{ label: 'Retiring key', value: 'kid-old' },
					{
						label: 'Scheduled retirement',
						value: '2026-01-01T00:20:30.000Z'
					}
				]
			],
			infoCount: 1
		});
	});
});

describe('runControlKeyRetire', () => {
	it.each([
		{ retired: true, value: 'yes' },
		{ retired: false, value: 'not present' }
	])('reports retired=$retired', async ({ retired, value }) => {
		const calls: { kid: string }[] = [];
		const results: ResultRow[][] = [];

		await runControlKeyRetire(
			'kid-old',
			reporter(results),
			controlKeyClient({
				retire(input) {
					calls.push(input);
					return Promise.resolve({ kid: 'kid-old', retired });
				}
			})
		);

		expect({ calls, results }).toStrictEqual({
			calls: [{ kid: 'kid-old' }],
			results: [
				[
					{ label: 'Key', value: 'kid-old' },
					{ label: 'Retired', value }
				]
			]
		});
	});
});
