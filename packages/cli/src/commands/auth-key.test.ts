import {
	capturingReporter as reporter,
	fakeCliUi
} from '@cupboard/cli-ui/testing';
import { authKeyIdSchema } from '@cupboard/nix-store/scalars';
import type {
	AuthKeySummary,
	ParsedAuthKeyListResponse,
	ParsedAuthKeyRotateResponse,
	ParsedAuthKeySummary
} from '@cupboard/protocol/keys';
import type { ResultRow } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import {
	type AuthKeyClient,
	runAuthKeyList,
	runAuthKeyRetire,
	runAuthKeyRotate
} from './auth-key.ts';

function summary(overrides: Partial<AuthKeySummary>): ParsedAuthKeySummary {
	const { kid = 'kid-1', ...rest } = overrides;

	return {
		kid: authKeyIdSchema.parse(kid),
		createdAt: '2026-01-01T00:00:00.000Z',
		active: true,
		...rest
	};
}

function authKeyClient(overrides: Partial<AuthKeyClient>): AuthKeyClient {
	return {
		list: () => Promise.resolve({ keys: [] }),
		rotate: () =>
			Promise.resolve({
				rotated: authKeyIdSchema.parse('kid-1'),
				keys: []
			}),
		retire: ({ kid }) => Promise.resolve({ kid, retired: false }),
		...overrides
	};
}

describe('runAuthKeyList', () => {
	it('reports a row per live key, flagging the active one', async () => {
		const results: ResultRow[][] = [];
		const response: ParsedAuthKeyListResponse = {
			keys: [
				summary({
					kid: 'kid-old',
					active: false,
					scheduledRetireAt: '2026-01-01T00:20:30.000Z'
				}),
				summary({ kid: 'kid-new', active: true })
			]
		};

		await runAuthKeyList(reporter(results), {
			list: () => Promise.resolve(response)
		});

		expect(results).toStrictEqual([
			[
				{
					label: 'kid-old',
					value:
						'retained; created 2026-01-01 00:00 UTC; retires 2026-01-01 00:20 UTC'
				},
				{ label: 'kid-new', value: 'active; created 2026-01-01 00:00 UTC' }
			]
		]);
	});

	it('reports nothing when there are no keys', async () => {
		const results: ResultRow[][] = [];
		const infos: string[] = [];

		await runAuthKeyList(
			reporter(results, infos),
			authKeyClient({ list: () => Promise.resolve({ keys: [] }) })
		);

		expect({ results, infos }).toStrictEqual({
			results: [[]],
			infos: ['No auth keys.']
		});
	});
});

describe('runAuthKeyRotate', () => {
	it('rotates and reports the scheduled retirement', async () => {
		const results: ResultRow[][] = [];
		const infos: string[] = [];
		const response: ParsedAuthKeyRotateResponse = {
			rotated: authKeyIdSchema.parse('kid-new'),
			retiring: {
				kid: authKeyIdSchema.parse('kid-old'),
				scheduledRetireAt: '2026-01-01T00:20:30.000Z'
			},
			keys: [
				summary({
					kid: 'kid-old',
					active: false,
					scheduledRetireAt: '2026-01-01T00:20:30.000Z'
				}),
				summary({ kid: 'kid-new' })
			]
		};

		await runAuthKeyRotate(reporter(results, infos), {
			rotate: () => Promise.resolve(response)
		});

		expect({ results, infos }).toStrictEqual({
			results: [
				[
					{ label: 'New key', value: 'kid-new' },
					{ label: 'Retiring key', value: 'kid-old' },
					{
						label: 'Scheduled retirement',
						value: '2026-01-01 00:20 UTC'
					},
					{ label: 'Keys in set', value: '2' }
				]
			],
			infos: ['New tokens are signed with this key.']
		});
	});
});

describe('runAuthKeyRetire', () => {
	it.each([
		{ retired: true, value: 'yes' },
		{ retired: false, value: 'not present' }
	])('reports retired=$retired once confirmed', async ({ retired, value }) => {
		const calls: { kid: string }[] = [];
		const { ui, captured } = fakeCliUi({ confirm: 'yes' });
		const response = { kid: authKeyIdSchema.parse('kid-old'), retired };

		await runAuthKeyRetire(
			authKeyIdSchema.parse('kid-old'),
			ui,
			authKeyClient({
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
					kind: 'auth-key',
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

		await runAuthKeyRetire(
			authKeyIdSchema.parse('kid-old'),
			ui,
			authKeyClient({})
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
