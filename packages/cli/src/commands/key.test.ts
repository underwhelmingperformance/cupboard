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

// The sentences of the advice that `cupboard key status` prints for store
// paths that the signature update skipped.
const advice = {
	skipped:
		'The signature update skipped the store paths listed as not updated, because their stored metadata is invalid or incomplete. ' +
		'They keep only the signatures that they had before the rotation, so Nix ignores them once a client stops trusting the keys that made those signatures.',
	narinfo:
		'To fix a path whose narinfo record is invalid, delete it with `cupboard delete` and push it again. The new upload is signed by every signing key.',
	either:
		'Deleting and pushing again also fixes a path with an unattributed defect, but only if the defect is in its narinfo record.',
	blob: "An invalid URL, compression, file hash or file size is stored in the deployment's shared record of the NAR, which a new push reuses, so no cupboard command fixes it.",
	cache:
		'A path whose cache is missing from the cache registry cannot be deleted or pushed again, so no cupboard command fixes it.',
	missingBlob:
		'A path whose NAR record is missing from the deployment cannot be substituted from the cache with any key.',
	retire:
		'You can retire the outgoing key without fixing them. `cupboard key retire` counts the paths that the key signed, because clients need a key that signed a path for as long as they should accept that path.'
};

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
	it('lists the store paths that a completed signature update set aside', async () => {
		const results: ResultRow[][] = [];
		const infos: string[] = [];
		const response = keyListResponseSchema.parse({
			keys: [
				{
					...entry(uuid, 'signing', 'cupboard-acme-2:k2'),
					backfill: {
						state: 'complete',
						startedAt: '2026-01-01T00:00:00.000Z',
						completedAt: '2026-01-01T00:20:00.000Z',
						resigned: 12,
						unpublishable: {
							total: 6,
							storePaths: [
								{
									storePath: `/nix/store/${'a'.repeat(32)}-app`,
									cache: { kind: 'default' },
									defect: 'ca',
									setAsideAt: '2026-01-01T00:10:00.000Z'
								},
								{
									storePath: `/nix/store/${'b'.repeat(32)}-lib`,
									cache: { kind: 'named', name: 'ci' },
									defect: 'references',
									setAsideAt: '2026-01-01T00:15:00.000Z'
								},
								{
									storePath: `/nix/store/${'c'.repeat(32)}-tool`,
									defect: 'cacheIdentity',
									setAsideAt: '2026-01-01T00:15:00.000Z'
								},
								{
									storePath: `/nix/store/${'d'.repeat(32)}-data`,
									cache: { kind: 'default' },
									defect: 'fileHash',
									setAsideAt: '2026-01-01T00:15:00.000Z'
								},
								{
									storePath: `/nix/store/${'f'.repeat(32)}-misc`,
									cache: { kind: 'default' },
									defect: 'unknown',
									setAsideAt: '2026-01-01T00:15:00.000Z'
								},
								{
									storePath: `/nix/store/${'g'.repeat(32)}-lost`,
									cache: { kind: 'default' },
									defect: 'blobState',
									setAsideAt: '2026-01-01T00:15:00.000Z'
								}
							]
						}
					}
				}
			]
		});

		await runKeyStatus(
			reporter(results, infos),
			{ list: () => Promise.resolve(response) },
			uuid
		);

		expect({ results, infos }).toStrictEqual({
			results: [
				[
					{ label: 'Key', value: uuid },
					{ label: 'State', value: 'signing and published' },
					{ label: 'Public key', raw: true, value: 'cupboard-acme-2:k2' },
					{ label: 'Signature update', value: 'Signature update complete' },
					{ label: 'Store paths updated', value: '12' },
					{ label: 'Store paths not updated', value: '6' },
					{
						label: 'Not updated',
						raw: true,
						value: `/nix/store/${'a'.repeat(32)}-app in (default): its content address is invalid`
					},
					{
						label: 'Not updated',
						raw: true,
						value: `/nix/store/${'b'.repeat(32)}-lib in ci: its references are invalid`
					},
					{
						label: 'Not updated',
						raw: true,
						value: `/nix/store/${'c'.repeat(32)}-tool in a cache missing from the registry: its cache is missing from the cache registry`
					},
					{
						label: 'Not updated',
						raw: true,
						value: `/nix/store/${'d'.repeat(32)}-data in (default): its file hash is invalid`
					},
					{
						label: 'Not updated',
						raw: true,
						value: `/nix/store/${'f'.repeat(32)}-misc in (default): it does not render as a narinfo`
					},
					{
						label: 'Not updated',
						raw: true,
						value: `/nix/store/${'g'.repeat(32)}-lost in (default): its NAR record is missing from the deployment`
					}
				]
			],
			infos: [
				[
					advice.skipped,
					advice.narinfo,
					advice.either,
					advice.blob,
					advice.cache,
					advice.missingBlob
				].join(' ')
			]
		});
	});
	// The outgoing key still signs, but retirement is refused until the
	// signature update has finished, so the advice does not offer it.
	it.each([
		{ total: 2, unlisted: '1 more store path, not listed' },
		{ total: 101, unlisted: '100 more store paths, not listed' }
	])(
		'counts the set-aside store paths that the server does not list ($total)',
		async ({ total, unlisted }) => {
			const results: ResultRow[][] = [];
			const infos: string[] = [];
			const response = keyListResponseSchema.parse({
				keys: [
					entry(),
					{
						...entry(uuid, 'signing', 'cupboard-acme-2:k2'),
						backfill: {
							...runningBackfill,
							resigned: 12,
							remaining: 3,
							unpublishable: {
								total,
								storePaths: [
									{
										storePath: `/nix/store/${'a'.repeat(32)}-app`,
										cache: { kind: 'default' },
										defect: 'deriver',
										setAsideAt: '2026-01-01T00:10:00.000Z'
									}
								]
							}
						}
					}
				]
			});

			await runKeyStatus(
				reporter(results, infos),
				{ list: () => Promise.resolve(response) },
				uuid
			);

			expect({ results, infos }).toStrictEqual({
				results: [
					[
						{ label: 'Key', value: uuid },
						{ label: 'State', value: 'signing and published' },
						{ label: 'Public key', raw: true, value: 'cupboard-acme-2:k2' },
						{ label: 'Signature update', value: 'Updating signatures' },
						{ label: 'Store paths updated', value: '12' },
						{ label: 'Remaining', value: '3' },
						{ label: 'Store paths not updated', value: String(total) },
						{
							label: 'Not updated',
							raw: true,
							value: `/nix/store/${'a'.repeat(32)}-app in (default): its deriver is invalid`
						},
						{ label: 'Not updated', value: unlisted }
					]
				],
				infos: [[advice.skipped, advice.narinfo].join(' ')]
			});
		}
	);
	// The signature update has finished and the outgoing key still signs, so
	// the advice offers retirement.
	it('offers retirement once the signature update has finished', async () => {
		const infos: string[] = [];
		const response = keyListResponseSchema.parse({
			keys: [
				entry(),
				{
					...entry(uuid, 'signing', 'cupboard-acme-2:k2'),
					backfill: {
						state: 'complete',
						startedAt: '2026-01-01T00:00:00.000Z',
						completedAt: '2026-01-01T00:20:00.000Z',
						resigned: 12,
						unpublishable: {
							total: 1,
							storePaths: [
								{
									storePath: `/nix/store/${'a'.repeat(32)}-app`,
									cache: { kind: 'default' },
									defect: 'deriver',
									setAsideAt: '2026-01-01T00:10:00.000Z'
								}
							]
						}
					}
				}
			]
		});

		await runKeyStatus(
			reporter([], infos),
			{ list: () => Promise.resolve(response) },
			uuid
		);

		expect(infos).toStrictEqual([
			[advice.skipped, advice.narinfo, advice.retire].join(' ')
		]);
	});
	// The stored store path of a set-aside narinfo need not parse as a store
	// path. It is reported as it is stored, so one such narinfo does not make
	// the whole response invalid.
	it('lists a set-aside narinfo whose stored store path is invalid', async () => {
		const results: ResultRow[][] = [];
		const response = keyListResponseSchema.parse({
			keys: [
				{
					...entry(uuid, 'signing', 'cupboard-acme-2:k2'),
					backfill: {
						state: 'complete',
						startedAt: '2026-01-01T00:00:00.000Z',
						completedAt: '2026-01-01T00:20:00.000Z',
						resigned: 12,
						unpublishable: {
							total: 1,
							storePaths: [
								{
									storePath: 'not a store path',
									cache: { kind: 'default' },
									defect: 'storePath',
									setAsideAt: '2026-01-01T00:10:00.000Z'
								}
							]
						}
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
				{ label: 'Signature update', value: 'Signature update complete' },
				{ label: 'Store paths updated', value: '12' },
				{ label: 'Store paths not updated', value: '1' },
				{
					label: 'Not updated',
					raw: true,
					value: 'not a store path in (default): its store path is invalid'
				}
			]
		]);
	});
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

	// The warning counts only the skipped paths that the key being retired
	// signed. Another key's count, and the skipped paths of the incoming key's
	// backfill, do not add to it.
	it.each([
		{
			case: 'one path that it signed',
			retiringSigned: 1,
			warning:
				' A signature update skipped 1 store path that this key signed, ' +
				'so that path keeps only the signatures from before that update. ' +
				'Clients need this key, or another key that signed it, in `trusted-public-keys` for as long as they should accept ' +
				'that path, not only until their narinfo cache expires. ' +
				'`cupboard key status` lists the skipped paths.'
		},
		{
			case: 'three paths that it signed',
			retiringSigned: 3,
			warning:
				' A signature update skipped 3 store paths that this key signed, ' +
				'so those paths keep only the signatures from before that update. ' +
				'Clients need this key, or another key that signed them, in `trusted-public-keys` for as long as they should accept ' +
				'those paths, not only until their narinfo cache expires. ' +
				'`cupboard key status` lists the skipped paths.'
		},
		{
			case: 'paths that only another key signed',
			retiringSigned: undefined,
			warning: ''
		}
	])(
		'warns about the skipped store paths of $case',
		async ({ retiringSigned, warning }) => {
			const response = keyRetireResponseSchema.parse({
				id: 'active',
				state: 'published-only'
			});
			const { ui, captured } = fakeCliUi({ confirm: 'yes' });
			const keys = keyListResponseSchema.parse({
				keys: [
					{ ...entry(), unpublishableSigned: retiringSigned },
					{
						...entry(uuid, 'signing', 'cupboard-acme-2:k2'),
						backfill: {
							state: 'complete',
							startedAt: '2026-01-01T00:00:00.000Z',
							completedAt: '2026-01-01T00:20:00.000Z',
							resigned: 12,
							unpublishable: {
								total: 3,
								storePaths: [
									{
										storePath: `/nix/store/${'a'.repeat(32)}-app`,
										cache: { kind: 'default' },
										defect: 'ca',
										setAsideAt: '2026-01-01T00:10:00.000Z'
									}
								]
							}
						},
						unpublishableSigned: 2
					}
				]
			});

			await runKeyRetire(
				'active',
				ui,
				keyClient({
					list: () => Promise.resolve(keys),
					retire: () => Promise.resolve(response)
				})
			);

			expect({
				details: captured.confirms.map((confirm) => confirm.detail),
				infos: captured.infos
			}).toStrictEqual({
				details: [
					'The first retirement stops the key signing. A client that trusts only ' +
						'this key will then reject newly published store paths. The second ' +
						"retirement removes the key from /pubkey. Keep the key in each client's " +
						'`trusted-public-keys` until its positive narinfo cache has expired.' +
						warning
				],
				infos: [
					'The key no longer signs but stays published. Nix caches narinfos and ' +
						'their signatures for `narinfo-cache-positive-ttl`, which defaults to 30 ' +
						"days. Keep this key in each client's `trusted-public-keys` until that " +
						"client's cache window has elapsed, or clear its narinfo cache. Retiring " +
						'the key again removes it from /pubkey but does not change client trust.' +
						warning
				]
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
