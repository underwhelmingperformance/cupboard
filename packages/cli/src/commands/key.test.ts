import {
	capturingReporter as reporter,
	fakeCliUi
} from '@cupboard/cli-ui/testing';
import {
	keyAbortResponseSchema,
	keyListResponseSchema,
	keyRetireResponseSchema,
	keyRotateResponseSchema,
	type SigningKeyEntry
} from '@cupboard/protocol/keys';
import type { ResultRow } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import {
	describeState,
	type KeyClient,
	runKeyAbort,
	runKeyList,
	runKeyRetire,
	runKeyRotate,
	runKeyStatus
} from './key.ts';

const uuid = '123e4567-e89b-12d3-a456-426614174000';
const runningBackfill = {
	state: 'running' as const,
	startedAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
	resigned: 0,
	remaining: 0
};

function entry(
	id = 'active',
	state: SigningKeyEntry['state'] = 'signing',
	publicKey = 'cupboard-acme-1:cHVi'
): SigningKeyEntry {
	const [parsed] = keyListResponseSchema.parse({
		keys: [
			{
				state,
				key: {
					id,
					publicKey,
					createdAt: '2026-01-01T00:00:00.000Z'
				}
			}
		]
	}).keys;

	if (parsed === undefined) {
		throw new Error('Expected the fixture key to be present');
	}

	return parsed;
}

function keyClient(overrides: Partial<KeyClient>): KeyClient {
	return {
		list: () => Promise.resolve({ keys: [] }),
		rotate: () =>
			Promise.resolve(
				keyRotateResponseSchema.parse({
					rotated: {
						...entry(uuid, 'signing', 'cupboard-acme-2:cHVi'),
						backfill: runningBackfill
					},
					keys: []
				})
			),
		retire: ({ id }) =>
			Promise.resolve(keyRetireResponseSchema.parse({ id, state: 'absent' })),
		abort: ({ id }) =>
			Promise.resolve(keyAbortResponseSchema.parse({ id, state: 'absent' })),
		...overrides
	};
}

describe('describeState', () => {
	it.each([
		{ state: 'signing' as const, expected: 'signing and published' },
		{ state: 'published-only' as const, expected: 'published only' },
		{ state: 'absent' as const, expected: 'removed' }
	])('describes $state', ({ state, expected }) => {
		expect(describeState(state)).toBe(expected);
	});
});

describe('runKeyList', () => {
	it('reports a row per key', async () => {
		const results: ResultRow[][] = [];
		const response = keyListResponseSchema.parse({
			keys: [
				entry('active', 'signing', 'cupboard-acme-1:k1'),
				entry(uuid, 'published-only', 'cupboard-acme-2:k2')
			]
		});

		await runKeyList(reporter(results), {
			list: () => Promise.resolve(response)
		});

		expect(results).toStrictEqual([
			[
				{
					label: 'active',
					raw: true,
					value: 'signing and published; cupboard-acme-1:k1'
				},
				{ label: uuid, raw: true, value: 'published only; cupboard-acme-2:k2' }
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
	it.each([
		{ tenantUrl: undefined, statusTarget: '<tenant-url>' },
		{
			tenantUrl: new URL('https://cupboard.example.workers.dev/t/acme'),
			statusTarget: 'https://cupboard.example.workers.dev/t/acme'
		}
	])(
		'reports signature updates and a status command for $statusTarget',
		async ({ tenantUrl, statusTarget }) => {
			const results: ResultRow[][] = [];
			const infos: string[] = [];
			const response = keyRotateResponseSchema.parse({
				rotated: {
					...entry(uuid, 'signing', 'cupboard-acme-2:k2'),
					backfill: runningBackfill
				},
				keys: [entry(), entry(uuid, 'signing', 'cupboard-acme-2:k2')]
			});

			await runKeyRotate(
				reporter(results, infos),
				{ rotate: () => Promise.resolve(response) },
				tenantUrl
			);

			expect({ results, infos }).toStrictEqual({
				results: [
					[
						{ label: 'New key', value: uuid },
						{ label: 'Public key', raw: true, value: 'cupboard-acme-2:k2' },
						{ label: 'Published keys', value: '2' }
					]
				],
				infos: [
					"Add the new public key to every client's `trusted-public-keys` now. " +
						'The server is updating signatures on existing store paths. Check ' +
						`\`cupboard key status ${statusTarget}\` before retiring the old key once to stop it signing.`
				]
			});
		}
	);
});

describe('runKeyStatus', () => {
	it('reports completed signature updates', async () => {
		const { ui, captured } = fakeCliUi();
		const response = keyListResponseSchema.parse({
			keys: [
				{
					...entry(uuid, 'signing', 'cupboard-acme-2:k2'),
					backfill: {
						state: 'complete',
						startedAt: '2026-01-01T00:00:00.000Z',
						completedAt: '2026-01-01T00:01:00.000Z',
						resigned: 12
					}
				}
			]
		});

		await runKeyStatus(
			ui.reporter(),
			{ list: () => Promise.resolve(response) },
			uuid
		);

		expect(captured.results).toStrictEqual([
			{
				kind: 'key-status',
				title: 'Signing-key status',
				data: response.keys,
				rows: [
					{ label: 'Key', value: uuid },
					{ label: 'State', value: 'signing and published' },
					{ label: 'Public key', raw: true, value: 'cupboard-acme-2:k2' },
					{ label: 'Signature update', value: 'Signature update complete' },
					{ label: 'Store paths updated', value: '12' }
				],
				empty: 'No signing keys.'
			}
		]);
	});
	it.each(['summary', 'details', 'debug'] as const)(
		'shows retry progress without exposing cache-purge mechanics (%s)',
		async (presentation) => {
			const rows: ResultRow[][] = [];
			const response = keyListResponseSchema.parse({
				keys: [
					{
						...entry(uuid, 'signing', 'cupboard-acme-2:k2'),
						backfill: {
							...runningBackfill,
							state: 'retrying',
							resigned: 12,
							remaining: 3,
							failure: {
								operation: 'cache-purge',
								message: 'provider error',
								failedAt: '2026-01-01T00:01:00.000Z'
							}
						}
					}
				]
			});

			await runKeyStatus(
				{ ...reporter(rows), presentation },
				{
					list: () => Promise.resolve(response)
				},
				uuid
			);

			expect(rows).toStrictEqual([
				[
					{ label: 'Key', value: uuid },
					{ label: 'State', value: 'signing and published' },
					{ label: 'Public key', raw: true, value: 'cupboard-acme-2:k2' },
					{ label: 'Signature update', value: 'Retrying signature updates' },
					{ label: 'Store paths updated', value: '12' },
					{ label: 'Remaining', value: '3' },
					...(presentation === 'debug'
						? [
								{ label: 'Failed operation', value: 'cache-purge' },
								{ label: 'Server error', value: 'provider error' }
							]
						: [])
				]
			]);
		}
	);
	it('reports backfill progress for one selected key', async () => {
		const results: ResultRow[][] = [];
		const response = keyListResponseSchema.parse({
			keys: [
				entry(),
				{
					...entry(uuid, 'signing', 'cupboard-acme-2:k2'),
					backfill: {
						state: 'running',
						startedAt: '2026-01-01T00:00:00.000Z',
						updatedAt: '2026-01-01T00:01:00.000Z',
						resigned: 12,
						remaining: 3
					}
				}
			]
		});

		await runKeyStatus(
			reporter(results),
			{ list: () => Promise.resolve(response) },
			uuid
		);

		expect(results).toStrictEqual([
			[
				{ label: 'Key', value: uuid },
				{ label: 'State', value: 'signing and published' },
				{ label: 'Public key', raw: true, value: 'cupboard-acme-2:k2' },
				{ label: 'Signature update', value: 'Updating signatures' },
				{ label: 'Store paths updated', value: '12' },
				{ label: 'Remaining', value: '3' }
			]
		]);
	});
});

describe('runKeyRetire', () => {
	it.each([
		{
			state: 'published-only' as const,
			stateValue: 'published only',
			infos: [
				'The key no longer signs but stays published. Nix caches narinfos and ' +
					'their signatures for `narinfo-cache-positive-ttl`, which defaults to 30 ' +
					"days. Keep this key in each client's `trusted-public-keys` until that " +
					"client's cache window has elapsed, or clear its narinfo cache. Retiring " +
					'the key again removes it from /pubkey but does not change client trust.'
			]
		},
		{ state: 'absent' as const, stateValue: 'removed', infos: [] }
	])(
		'retires to $state once confirmed',
		async ({ state, stateValue, infos }) => {
			const calls: { id: string }[] = [];
			const response = keyRetireResponseSchema.parse({ id: 'active', state });
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
						title: 'Signing key',
						data: response,
						rows: [
							{ label: 'Key', value: 'active' },
							{ label: 'State', value: stateValue }
						]
					}
				],
				infos
			});
		}
	);

	it('leaves the key in place when confirmation is declined', async () => {
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

describe('runKeyAbort', () => {
	it('removes an incomplete incoming key once confirmed', async () => {
		const calls: { id: string }[] = [];
		const response = keyAbortResponseSchema.parse({
			id: uuid,
			state: 'absent'
		});
		const { ui, captured } = fakeCliUi({ confirm: 'yes' });

		await runKeyAbort(
			uuid,
			ui,
			keyClient({
				abort(input) {
					calls.push(input);
					return Promise.resolve(response);
				}
			})
		);

		expect({ calls, results: captured.results }).toStrictEqual({
			calls: [{ id: uuid }],
			results: [
				{
					kind: 'key',
					title: 'Signing key',
					data: response,
					rows: [
						{ label: 'Key', value: uuid },
						{ label: 'State', value: 'removed' }
					]
				}
			]
		});
	});
});
