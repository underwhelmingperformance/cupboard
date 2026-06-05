import type {
	ControlKeyListResponse,
	ControlKeyRotateResponse,
	ControlKeySummary
} from '@cupboard/protocol/control-keys';
import { describe, expect, it } from 'vitest';

import type { AccessCredential } from '../client/client.ts';
import type { Reporter, ResultRow } from '../reporter.ts';

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
		listControlKeys: uncalled,
		rotateControlKey: uncalled,
		retireControlKey: uncalled,
		...overrides
	};
}

describe('runControlKeyList', () => {
	it('reports a row per key, flagging retired ones', async () => {
		const results: ResultRow[][] = [];
		const response: ControlKeyListResponse = {
			keys: [
				summary({ kid: 'kid-old', retired: true }),
				summary({ kid: 'kid-new' })
			]
		};

		await runControlKeyList(
			'admin-token',
			reporter(results),
			controlKeyClient({ listControlKeys: () => Promise.resolve(response) })
		);

		expect(results).toStrictEqual([
			[
				{ label: 'kid-old', value: 'retired' },
				{ label: 'kid-new', value: 'live' }
			]
		]);
	});
});

describe('runControlKeyRotate', () => {
	it('rotates, reports the new key, and prints retirement guidance', async () => {
		const calls: AccessCredential[] = [];
		const results: ResultRow[][] = [];
		const infos: string[] = [];
		const response: ControlKeyRotateResponse = { kid: 'kid-new' };

		await runControlKeyRotate(
			'admin-token',
			reporter(results, infos),
			controlKeyClient({
				rotateControlKey(token) {
					calls.push(token);
					return Promise.resolve(response);
				}
			})
		);

		expect({ calls, results, infoCount: infos.length }).toStrictEqual({
			calls: ['admin-token'],
			results: [[{ label: 'New key', value: 'kid-new' }]],
			infoCount: 1
		});
	});
});

describe('runControlKeyRetire', () => {
	it.each([
		{ retired: true, value: 'yes' },
		{ retired: false, value: 'not present' }
	])('reports retired=$retired', async ({ retired, value }) => {
		const calls: { token: AccessCredential; kid: string }[] = [];
		const results: ResultRow[][] = [];

		await runControlKeyRetire(
			'kid-old',
			'admin-token',
			reporter(results),
			controlKeyClient({
				retireControlKey(token, kid) {
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
