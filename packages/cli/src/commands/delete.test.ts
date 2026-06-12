import { InvalidStorePathError } from '@cupboard/nix/errors';
import type { DeletePathResponse } from '@cupboard/protocol/upload';
import type { Reporter, ResultRow } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import { type DeleteClient, describeNarOutcome, runDelete } from './delete.ts';

describe('describeNarOutcome', () => {
	it.each([
		{
			deleted: true,
			narScheduledForDeletion: true,
			expected: 'scheduled for deletion'
		},
		{
			deleted: true,
			narScheduledForDeletion: false,
			expected: 'retained (still referenced)'
		},
		{ deleted: false, narScheduledForDeletion: false, expected: 'n/a' }
	])(
		'describes "$expected"',
		({ deleted, narScheduledForDeletion, expected }) => {
			const result: DeletePathResponse = {
				storePathHash: '0123456789abcdfghijklmnpqrsvwxyz',
				deleted,
				narScheduledForDeletion
			};

			expect(describeNarOutcome(result)).toBe(expected);
		}
	);
});

describe('runDelete', () => {
	it('derives the hash, addresses the cache, and reports', async () => {
		const calls: { cacheName: string; hash: string }[] = [];
		const results: ResultRow[][] = [];
		const client: DeleteClient = {
			remove(input) {
				calls.push(input);

				return Promise.resolve({
					storePathHash: input.hash,
					deleted: true,
					narScheduledForDeletion: false
				});
			}
		};

		await runDelete(
			'_default',
			'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app',
			reporter(results),
			client
		);

		expect(calls).toStrictEqual([
			{
				cacheName: '_default',
				hash: '0123456789abcdfghijklmnpqrsvwxyz'
			}
		]);
		expect(results).toStrictEqual([
			[
				{
					label: 'Store path hash',
					value: '0123456789abcdfghijklmnpqrsvwxyz'
				},
				{ label: 'Deleted', value: 'yes' },
				{ label: 'NAR', value: 'retained (still referenced)' }
			]
		]);
	});

	it('rejects an argument that is not a store path', async () => {
		await expect(
			runDelete('_default', '/tmp/not-a-store-path', reporter([]), {
				remove() {
					throw new Error('client should not be called');
				}
			})
		).rejects.toThrow(InvalidStorePathError);
	});
});

function reporter(results: ResultRow[][]): Reporter {
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
		info() {
			return;
		}
	};
}
