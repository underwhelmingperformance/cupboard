import type {
	AuthKeyListResponse,
	AuthKeyRotateResponse,
	AuthKeySummary
} from '@cupboard/protocol/keys';
import { describe, expect, it } from 'vitest';

import type { AccessCredential } from '../client/client.ts';
import type { Reporter, ResultRow } from '../reporter.ts';

import {
	type AuthKeyClient,
	runAuthKeyList,
	runAuthKeyRetire,
	runAuthKeyRotate
} from './auth-key.ts';

function summary(overrides: Partial<AuthKeySummary>): AuthKeySummary {
	return {
		kid: 'kid-1',
		createdAt: '2026-01-01T00:00:00.000Z',
		active: true,
		...overrides
	};
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

function authKeyClient(overrides: Partial<AuthKeyClient>): AuthKeyClient {
	return {
		listAuthKeys: uncalled,
		rotateAuthKey: uncalled,
		retireAuthKey: uncalled,
		...overrides
	};
}

describe('runAuthKeyList', () => {
	it('reports a row per live key, flagging the active one', async () => {
		const results: ResultRow[][] = [];
		const response: AuthKeyListResponse = {
			keys: [
				summary({ kid: 'kid-old', active: false }),
				summary({ kid: 'kid-new', active: true })
			]
		};

		await runAuthKeyList(
			'admin-token',
			reporter(results),
			authKeyClient({ listAuthKeys: () => Promise.resolve(response) })
		);

		expect(results).toStrictEqual([
			[
				{
					label: 'kid-old',
					value: 'retained; created 2026-01-01T00:00:00.000Z'
				},
				{ label: 'kid-new', value: 'active; created 2026-01-01T00:00:00.000Z' }
			]
		]);
	});
});

describe('runAuthKeyRotate', () => {
	it('rotates, reports the new key, and prints retirement guidance', async () => {
		const calls: AccessCredential[] = [];
		const results: ResultRow[][] = [];
		const infos: string[] = [];
		const response: AuthKeyRotateResponse = {
			rotated: 'kid-new',
			keys: [
				summary({ kid: 'kid-old', active: false }),
				summary({ kid: 'kid-new' })
			]
		};

		await runAuthKeyRotate(
			'admin-token',
			reporter(results, infos),
			authKeyClient({
				rotateAuthKey(token) {
					calls.push(token);
					return Promise.resolve(response);
				}
			})
		);

		expect({ calls, results, infoCount: infos.length }).toStrictEqual({
			calls: ['admin-token'],
			results: [
				[
					{ label: 'New key', value: 'kid-new' },
					{ label: 'Keys in set', value: '2' }
				]
			],
			infoCount: 1
		});
	});
});

describe('runAuthKeyRetire', () => {
	it.each([
		{ retired: true, value: 'yes' },
		{ retired: false, value: 'not present' }
	])('reports retired=$retired', async ({ retired, value }) => {
		const calls: { token: AccessCredential; kid: string }[] = [];
		const results: ResultRow[][] = [];

		await runAuthKeyRetire(
			'kid-old',
			'admin-token',
			reporter(results),
			authKeyClient({
				retireAuthKey(token, kid) {
					calls.push({ token, kid });
					return Promise.resolve({ kid: 'kid-old', retired });
				}
			})
		);

		expect({ calls, results }).toStrictEqual({
			calls: [{ token: 'admin-token', kid: 'kid-old' }],
			results: [
				[
					{ label: 'Key', value: 'kid-old' },
					{ label: 'Retired', value }
				]
			]
		});
	});
});
