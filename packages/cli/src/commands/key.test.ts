import {
	capturingReporter as reporter,
	fakeCliUi
} from '@cupboard/cli-ui/testing';
import {
	keyListResponseSchema,
	keyRetireResponseSchema,
	keyRotateResponseSchema,
	type SigningKeyStage,
	type SigningKeySummary
} from '@cupboard/protocol/keys';
import type { ResultRow } from '@cupboard/reporter';
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

function keyClient(overrides: Partial<KeyClient>): KeyClient {
	return {
		list: () => Promise.resolve({ keys: [] }),
		rotate: () =>
			Promise.resolve(
				keyRotateResponseSchema.parse({
					rotated: summary({
						id: uuid,
						publicKey: 'cupboard-2:cHVi',
						stage: 'publication'
					}),
					keys: []
				})
			),
		retire: ({ id }) =>
			Promise.resolve(keyRetireResponseSchema.parse({ id, stage: 'absent' })),
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
		const response = keyListResponseSchema.parse({
			keys: [
				summary({ id: 'active', publicKey: 'cupboard-1:k1', stage: 'signing' }),
				summary({ id: uuid, publicKey: 'cupboard-2:k2', stage: 'publication' })
			]
		});

		await runKeyList(reporter(results), {
			list: () => Promise.resolve(response)
		});

		expect(results).toStrictEqual([
			[
				{ label: 'active', value: 'signing and published; cupboard-1:k1' },
				{ label: uuid, value: 'published only; cupboard-2:k2' }
			]
		]);
	});

	it('reports an empty result and a message when there are no keys', async () => {
		const results: ResultRow[][] = [];
		const infos: string[] = [];

		await runKeyList(
			reporter(results, infos),
			keyClient({ list: () => Promise.resolve({ keys: [] }) })
		);

		expect({ results, infos }).toStrictEqual({
			results: [[]],
			infos: ['No signing keys.']
		});
	});
});

describe('runKeyRotate', () => {
	it('rotates, reports the new key, and prints migration guidance', async () => {
		const results: ResultRow[][] = [];
		const infos: string[] = [];
		const response = keyRotateResponseSchema.parse({
			rotated: summary({
				id: uuid,
				publicKey: 'cupboard-2:k2',
				stage: 'signing'
			}),
			keys: [
				summary({ id: 'active', publicKey: 'cupboard-1:k1' }),
				summary({ id: uuid, publicKey: 'cupboard-2:k2' })
			]
		});

		await runKeyRotate(reporter(results, infos), {
			rotate: () => Promise.resolve(response)
		});

		expect({ results, infos }).toStrictEqual({
			results: [
				[
					{ label: 'New key', value: uuid },
					{ label: 'Public key', value: 'cupboard-2:k2' },
					{ label: 'Published keys', value: '2' }
				]
			],
			infos: [
				'Add the new public key to trusted-public-keys on every client, then ' +
					'`cupboard key retire <id>` the old key once they have updated.'
			]
		});
	});
});

describe('runKeyRetire', () => {
	it.each<{
		stage: SigningKeyStage;
		stageValue: string;
		infos: readonly string[];
	}>([
		{
			stage: 'publication',
			stageValue: 'published only',
			infos: [
				'The key no longer signs but stays published. Retire it again once no ' +
					'client trusts it to remove it entirely.'
			]
		},
		{ stage: 'absent', stageValue: 'removed', infos: [] }
	])(
		'retires to $stage once confirmed',
		async ({ stage, stageValue, infos }) => {
			const calls: { id: string }[] = [];
			const response = keyRetireResponseSchema.parse({ id: 'active', stage });
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
				infos: captured.infos
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
				infos
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
