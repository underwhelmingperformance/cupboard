import { fakeCliUi } from '@cupboard/cli-ui/testing';
import type {
	KeyListResponse,
	KeyRetireResponse,
	KeyRotateResponse,
	SigningKeyStage,
	SigningKeySummary
} from '@cupboard/protocol/keys';
import type { Reporter, ResultRow } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import {
	describeStage,
	type KeyClient,
	runKeyList,
	runKeyRetire,
	runKeyRotate
} from './key.ts';

const uuid = '123e4567-e89b-12d3-a456-426614174000';

function summary(overrides: Partial<SigningKeySummary>): SigningKeySummary {
	return {
		id: 'active',
		publicKey: 'cupboard-1:cHVi',
		stage: 'signing',
		createdAt: '2026-01-01T00:00:00.000Z',
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
		result(payload) {
			results.push([...payload.rows]);
		},
		data() {
			return;
		},
		error() {
			return;
		},
		warn() {
			return;
		},
		info(message) {
			infos.push(message);
		}
	};
}

function uncalledClient(): never {
	throw new Error('client should not be called');
}

function keyClient(overrides: Partial<KeyClient>): KeyClient {
	return {
		list: uncalledClient,
		rotate: uncalledClient,
		retire: uncalledClient,
		...overrides
	};
}

describe('describeStage', () => {
	it.each([
		{ stage: 'signing' as const, expected: 'signing and published' },
		{ stage: 'publication' as const, expected: 'published only' },
		{ stage: 'absent' as const, expected: 'removed' }
	])('describes $stage', ({ stage, expected }) => {
		expect(describeStage(stage)).toBe(expected);
	});
});

describe('runKeyList', () => {
	it('reports a row per key', async () => {
		const results: ResultRow[][] = [];
		const response: KeyListResponse = {
			keys: [
				summary({ id: 'active', publicKey: 'cupboard-1:k1', stage: 'signing' }),
				summary({ id: uuid, publicKey: 'cupboard-2:k2', stage: 'publication' })
			]
		};

		await runKeyList(
			reporter(results),
			keyClient({ list: () => Promise.resolve(response) })
		);

		expect(results).toStrictEqual([
			[
				{ label: 'active', value: 'signing and published; cupboard-1:k1' },
				{ label: uuid, value: 'published only; cupboard-2:k2' }
			]
		]);
	});
});

describe('runKeyRotate', () => {
	it('rotates, reports the new key, and prints migration guidance', async () => {
		const results: ResultRow[][] = [];
		const infos: string[] = [];
		const response: KeyRotateResponse = {
			rotated: summary({
				id: uuid,
				publicKey: 'cupboard-2:k2',
				stage: 'signing'
			}),
			keys: [
				summary({ id: 'active', publicKey: 'cupboard-1:k1' }),
				summary({ id: uuid, publicKey: 'cupboard-2:k2' })
			]
		};

		await runKeyRotate(
			reporter(results, infos),
			keyClient({ rotate: () => Promise.resolve(response) })
		);

		expect({ results, infoCount: infos.length }).toStrictEqual({
			results: [
				[
					{ label: 'New key', value: uuid },
					{ label: 'Public key', value: 'cupboard-2:k2' },
					{ label: 'Published keys', value: '2' }
				]
			],
			infoCount: 1
		});
	});
});

describe('runKeyRetire', () => {
	it.each<{ stage: SigningKeyStage; stageValue: string; infoCount: number }>([
		{ stage: 'publication', stageValue: 'published only', infoCount: 1 },
		{ stage: 'absent', stageValue: 'removed', infoCount: 0 }
	])(
		'retires to $stage once confirmed',
		async ({ stage, stageValue, infoCount }) => {
			const calls: { id: string }[] = [];
			const response: KeyRetireResponse = { id: 'active', stage };
			const { ui, captured } = fakeCliUi({ confirm: 'yes' });

			await runKeyRetire(
				'active',
				ui,
				keyClient({
					retire(input) {
						calls.push(input);
						return Promise.resolve(response);
					}
				})
			);

			expect({
				calls,
				results: captured.results,
				infoCount: captured.infos.length
			}).toStrictEqual({
				calls: [{ id: 'active' }],
				results: [
					{
						kind: 'key',
						data: response,
						rows: [
							{ label: 'Key', value: 'active' },
							{ label: 'Stage', value: stageValue }
						]
					}
				],
				infoCount
			});
		}
	);

	it('leaves the key in place when the confirmation is declined', async () => {
		const { ui, captured } = fakeCliUi({ confirm: 'no' });

		await runKeyRetire('active', ui, keyClient({}));

		expect({
			results: captured.results,
			cancellations: captured.cancellations
		}).toStrictEqual({
			results: [],
			cancellations: ['The key was left in place.']
		});
	});
});
