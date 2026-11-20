import {
	cacheNameSchema,
	type CacheScope,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import {
	buildInputsRecordBodySchema,
	type BuildInputsRecordEntry,
	buildInputsRecordResponseSchema,
	type BuildInputsRecordResult
} from '@cupboard/protocol/build-inputs';
import { dependencyStatusResponseSchema } from '@cupboard/protocol/dependency-status';
import { PageResultCountError } from '@cupboard/shared/paging';
import { describe, expect, it } from 'vitest';

import {
	DuplicateBuildInputsEntryError,
	PathResponseMismatchError
} from '../errors.ts';

import { dependencyStatuses, recordBuildInputs } from './build-inputs.ts';
import { recordingCacheScopedClient } from './cache-scoped.test-support.ts';

const caches: readonly CacheScope[] = [
	{ kind: 'default' },
	{ kind: 'named', name: cacheNameSchema.parse('ci') }
];

function hash(index: number): string {
	return String(index).padStart(32, '0');
}

function storePath(index: number): string {
	return `/nix/store/${hash(index)}-path`;
}

function entries(counts: readonly number[]): readonly BuildInputsRecordEntry[] {
	return buildInputsRecordBodySchema.parse({
		entries: counts.map((count, index) => ({
			storePath: storePath(index),
			buildInputs: Array.from(
				{ length: count },
				(_, input) => `${hash(input)}-input`
			),
			buildInputsVersion: 1
		}))
	}).entries;
}

async function rejection(pending: Promise<unknown>): Promise<unknown> {
	try {
		await pending;
	} catch (error) {
		return error;
	}

	return undefined;
}

describe('dependencyStatuses', () => {
	it.each(caches)(
		'asks about 1,024 hashes a request in the $kind cache',
		async (cache) => {
			const hashes = Array.from({ length: 2049 }, (_, index) =>
				storePathHashSchema.parse(hash(index))
			);
			const dependencyStatus = recordingCacheScopedClient(
				(input: { storePathHashes: string[] }) =>
					Promise.resolve(
						dependencyStatusResponseSchema.parse({
							paths: input.storePathHashes.map((storePathHash) => ({
								storePathHash,
								state: 'absent'
							}))
						})
					)
			);

			const statuses = await dependencyStatuses(
				{ dependencyStatus },
				cache,
				hashes
			);

			expect({
				requests: dependencyStatus.calls.map((call) => ({
					cache: call.cache,
					hashes: call.input.storePathHashes.length
				})),
				statuses
			}).toStrictEqual({
				requests: [1024, 1024, 1].map((count) => ({ cache, hashes: count })),
				statuses: hashes.map((storePathHash) => ({
					storePathHash,
					state: 'absent'
				}))
			});
		}
	);

	it('refuses an answer for other hashes than it asked about', async () => {
		const dependencyStatus = recordingCacheScopedClient(() =>
			Promise.resolve(
				dependencyStatusResponseSchema.parse({
					paths: [{ storePathHash: hash(2), state: 'present' }]
				})
			)
		);

		const requested = [storePathHashSchema.parse(hash(1))];

		const failure = await rejection(
			dependencyStatuses({ dependencyStatus }, { kind: 'default' }, requested)
		);

		expect({
			isMismatch: failure instanceof PathResponseMismatchError,
			storePath:
				failure instanceof PathResponseMismatchError
					? failure.storePath
					: undefined
		}).toStrictEqual({ isMismatch: true, storePath: hash(1) });
	});
});

describe('recordBuildInputs', () => {
	it.each([
		{
			name: '129 entries',
			counts: Array.from({ length: 129 }, () => 1),
			pages: [128, 1]
		},
		{
			name: 'entries of 5,000 build inputs',
			counts: [5000, 5000, 5000],
			pages: [1, 1, 1]
		},
		{
			name: 'entries of 4,096 build inputs',
			counts: [4096, 4096, 4096, 1],
			pages: [2, 2]
		}
	])('pages $name by entries and build inputs', async ({ counts, pages }) => {
		const record = recordingCacheScopedClient(
			(input: { entries: BuildInputsRecordEntry[] }) =>
				Promise.resolve(
					buildInputsRecordResponseSchema.parse({
						entries: input.entries.map((entry) => ({
							storePath: entry.storePath,
							status: 'recorded'
						}))
					})
				)
		);
		const requested = entries(counts);

		const results = await recordBuildInputs(
			{ record },
			{ kind: 'default' },
			requested
		);

		expect({
			pages: record.calls.map((call) => call.input.entries.length),
			results
		}).toStrictEqual({
			pages,
			results: requested.map((entry) => ({
				storePath: entry.storePath,
				status: 'recorded'
			}))
		});
	});

	it('sends deferred entries again and returns every final result', async () => {
		const answers: (readonly BuildInputsRecordResult['status'][])[] = [
			['recorded', 'limit-exceeded', 'deferred', 'deferred'],
			['invalid-stored', 'absent']
		];
		const record = recordingCacheScopedClient(
			(input: { entries: BuildInputsRecordEntry[] }) => {
				const statuses = answers.shift() ?? [];

				return Promise.resolve(
					buildInputsRecordResponseSchema.parse({
						entries: input.entries.map((entry, index) => ({
							storePath: entry.storePath,
							status: statuses[index]
						}))
					})
				);
			}
		);

		const results = await recordBuildInputs(
			{ record },
			{ kind: 'default' },
			entries([1, 1, 1, 1])
		);

		expect({
			requests: record.calls.map((call) =>
				call.input.entries.map((entry) => entry.storePath)
			),
			results
		}).toStrictEqual({
			requests: [
				[storePath(0), storePath(1), storePath(2), storePath(3)],
				[storePath(2), storePath(3)]
			],
			results: [
				{ storePath: storePath(0), status: 'recorded' },
				{ storePath: storePath(1), status: 'limit-exceeded' },
				{ storePath: storePath(2), status: 'invalid-stored' },
				{ storePath: storePath(3), status: 'absent' }
			]
		});
	});

	it.each([
		{
			name: 'more than 8,192 build inputs',
			buildInputs: Array.from(
				{ length: 8193 },
				(_, input) => `${hash(input)}-input`
			)
		},
		{
			name: 'build inputs over 1,000,000 bytes of JSON',
			buildInputs: Array.from(
				{ length: 5000 },
				(_, input) => `${hash(input)}-${'x'.repeat(170)}`
			)
		}
	])(
		'reports a path with $name as limit-exceeded without sending it',
		async ({ buildInputs }) => {
			const record = recordingCacheScopedClient(
				(input: { entries: BuildInputsRecordEntry[] }) =>
					Promise.resolve(
						buildInputsRecordResponseSchema.parse({
							entries: input.entries.map((entry) => ({
								storePath: entry.storePath,
								status: 'recorded'
							}))
						})
					)
			);
			const requested = buildInputsRecordBodySchema.parse({
				entries: [0, 1, 2].map((index) => ({
					storePath: storePath(index),
					buildInputs: index === 1 ? buildInputs : [`${hash(9)}-input`],
					buildInputsVersion: 1
				}))
			}).entries;

			const results = await recordBuildInputs(
				{ record },
				{ kind: 'default' },
				requested
			);

			expect({
				requests: record.calls.map((call) =>
					call.input.entries.map((entry) => entry.storePath)
				),
				results
			}).toStrictEqual({
				requests: [[storePath(0), storePath(2)]],
				results: [
					{ storePath: storePath(0), status: 'recorded' },
					{ storePath: storePath(1), status: 'limit-exceeded' },
					{ storePath: storePath(2), status: 'recorded' }
				]
			});
		}
	);

	it('refuses two entries for one store path before sending any', async () => {
		const record = recordingCacheScopedClient(
			(input: { entries: BuildInputsRecordEntry[] }) =>
				Promise.resolve(
					buildInputsRecordResponseSchema.parse({
						entries: input.entries.map((entry) => ({
							storePath: entry.storePath,
							status: 'recorded'
						}))
					})
				)
		);
		const [first, second] = entries([1, 8193]);

		if (first === undefined || second === undefined) {
			throw new Error('expected two entries');
		}

		const failure = await rejection(
			recordBuildInputs({ record }, { kind: 'default' }, [
				first,
				{ ...second, storePath: first.storePath }
			])
		);

		expect({
			isDuplicate: failure instanceof DuplicateBuildInputsEntryError,
			storePath:
				failure instanceof DuplicateBuildInputsEntryError
					? failure.storePath
					: undefined,
			requests: record.calls.length
		}).toStrictEqual({
			isDuplicate: true,
			storePath: first.storePath,
			requests: 0
		});
	});

	it('stops when the server defers the first entry of a request', async () => {
		const record = recordingCacheScopedClient(
			(input: { entries: BuildInputsRecordEntry[] }) =>
				Promise.resolve(
					buildInputsRecordResponseSchema.parse({
						entries: input.entries.map((entry) => ({
							storePath: entry.storePath,
							status: 'deferred'
						}))
					})
				)
		);

		const failure = await rejection(
			recordBuildInputs({ record }, { kind: 'default' }, entries([1, 1]))
		);

		expect({
			isPageResultCount: failure instanceof PageResultCountError,
			requests: record.calls.length
		}).toStrictEqual({ isPageResultCount: true, requests: 1 });
	});
});
