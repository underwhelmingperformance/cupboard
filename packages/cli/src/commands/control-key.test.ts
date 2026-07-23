import {
	capturingReporter as reporter,
	fakeCliUi
} from '@cupboard/cli-ui/testing';
import { authKeyIdSchema } from '@cupboard/nix-store/scalars';
import type {
	ControlKeySummary,
	ParsedControlKeyListResponse,
	ParsedControlKeyRotateResponse,
	ParsedControlKeySummary
} from '@cupboard/protocol/control-keys';
import type { ResultRow } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import {
	type ControlKeyClient,
	runControlKeyList,
	runControlKeyRetire,
	runControlKeyRotate
} from './control-key.ts';

function summary(
	overrides: Partial<ControlKeySummary>
): ParsedControlKeySummary {
	const { kid = 'kid-1', ...rest } = overrides;

	return { kid: authKeyIdSchema.parse(kid), retired: false, ...rest };
}

function controlKeyClient(
	overrides: Partial<ControlKeyClient>
): ControlKeyClient {
	return {
		list: () => Promise.resolve({ keys: [] }),
		rotate: () =>
			Promise.resolve({
				kid: authKeyIdSchema.parse('kid-1'),
				publicJwk: {},
				retiring: undefined,
				keys: []
			}),
		retire: ({ kid }) => Promise.resolve({ kid, retired: false }),
		...overrides
	};
}

describe('runControlKeyList', () => {
	it('reports a row per key, flagging retired ones', async () => {
		const results: ResultRow[][] = [];
		const response: ParsedControlKeyListResponse = {
			keys: [
				summary({
					kid: 'kid-old',
					retired: false,
					scheduledRetireAt: '2026-01-01T00:20:30.000Z'
				}),
				summary({ kid: 'kid-new' })
			]
		};

		await runControlKeyList(reporter(results), {
			list: () => Promise.resolve(response)
		});

		expect(results).toStrictEqual([
			[
				{ label: 'kid-old', value: 'live; retires 2026-01-01 00:20 UTC' },
				{ label: 'kid-new', value: 'live' }
			]
		]);
	});

	it('reports nothing when there are no keys', async () => {
		const results: ResultRow[][] = [];
		const infos: string[] = [];

		await runControlKeyList(
			reporter(results, infos),
			controlKeyClient({ list: () => Promise.resolve({ keys: [] }) })
		);

		expect({ results, infos }).toStrictEqual({
			results: [[]],
			infos: ['No control keys.']
		});
	});
});

describe('runControlKeyRotate', () => {
	it('rotates and reports the scheduled retirement', async () => {
		let rotateCalls = 0;
		const results: ResultRow[][] = [];
		const infos: string[] = [];
		const response: ParsedControlKeyRotateResponse = {
			kid: authKeyIdSchema.parse('kid-new'),
			retiring: {
				kid: authKeyIdSchema.parse('kid-old'),
				scheduledRetireAt: '2026-01-01T00:20:30.000Z'
			}
		};

		await runControlKeyRotate(reporter(results, infos), {
			rotate() {
				rotateCalls += 1;
				return Promise.resolve(response);
			}
		});

		expect({ rotateCalls, results, infos }).toStrictEqual({
			rotateCalls: 1,
			results: [
				[
					{ label: 'New key', value: 'kid-new' },
					{ label: 'Retiring key', value: 'kid-old' },
					{
						label: 'Scheduled retirement',
						value: '2026-01-01 00:20 UTC'
					}
				]
			],
			infos: ['New control tokens are signed with this key.']
		});
	});
});

describe('runControlKeyRetire', () => {
	it.each([
		{ retired: true, value: 'yes' },
		{ retired: false, value: 'not present' }
	])('reports retired=$retired once confirmed', async ({ retired, value }) => {
		const calls: { kid: string }[] = [];
		const { ui, captured } = fakeCliUi({ confirm: 'yes' });
		const response = { kid: authKeyIdSchema.parse('kid-old'), retired };

		await runControlKeyRetire(
			authKeyIdSchema.parse('kid-old'),
			ui,
			controlKeyClient({
				retire(input) {
					calls.push(input);
					return Promise.resolve(response);
				}
			})
		);

		expect({ calls, results: captured.results }).toStrictEqual({
			calls: [{ kid: 'kid-old' }],
			results: [
				{
					kind: 'control-key',
					data: response,
					rows: [
						{ label: 'Key', value: 'kid-old' },
						{ label: 'Retired', value }
					]
				}
			]
		});
	});

	it('leaves the key in place when the confirmation is declined', async () => {
		const { ui, captured } = fakeCliUi({ confirm: 'no' });

		await runControlKeyRetire(
			authKeyIdSchema.parse('kid-old'),
			ui,
			controlKeyClient({})
		);

		expect({
			results: captured.results,
			cancellations: captured.cancellations
		}).toStrictEqual({
			results: [],
			cancellations: ['The key was left in place.']
		});
	});
});
