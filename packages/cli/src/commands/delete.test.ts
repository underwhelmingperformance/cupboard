import { fakeCliUi } from '@cupboard/cli-ui/testing';
import { InvalidStorePathError } from '@cupboard/nix/errors';
import type { DeletePathResponse } from '@cupboard/protocol/upload';
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

const storePathHash = '0123456789abcdfghijklmnpqrsvwxyz';
const storePath = `/nix/store/${storePathHash}-app`;

/** A delete client that records its calls and reports the path as present. */
function recordingClient(): {
	client: DeleteClient;
	calls: { cacheName: string; hash: string }[];
} {
	const calls: { cacheName: string; hash: string }[] = [];

	return {
		calls,
		client: {
			remove(input) {
				calls.push(input);

				return Promise.resolve({
					storePathHash: input.hash,
					deleted: true,
					narScheduledForDeletion: false
				});
			}
		}
	};
}

describe('runDelete', () => {
	it('derives the hash, addresses the cache, and reports once confirmed', async () => {
		const { client, calls } = recordingClient();
		const { ui, captured } = fakeCliUi({ confirm: 'yes' });

		await runDelete('_default', storePath, ui, client);

		expect({ calls, results: captured.results }).toStrictEqual({
			calls: [{ cacheName: '_default', hash: storePathHash }],
			results: [
				{
					kind: 'deleted-path',
					data: {
						storePathHash,
						deleted: true,
						narScheduledForDeletion: false
					},
					rows: [
						{ label: 'Store path hash', value: storePathHash },
						{ label: 'Deleted', value: 'yes' },
						{ label: 'NAR', value: 'retained (still referenced)' }
					]
				}
			]
		});
	});

	it('deletes nothing when the confirmation is declined', async () => {
		const { client, calls } = recordingClient();
		const { ui, captured } = fakeCliUi({ confirm: 'no' });

		await runDelete('_default', storePath, ui, client);

		expect({ calls, cancellations: captured.cancellations }).toStrictEqual({
			calls: [],
			cancellations: ['Nothing was deleted.']
		});
	});

	it('rejects an argument that is not a store path', async () => {
		const { ui } = fakeCliUi({ confirm: 'yes' });

		await expect(
			runDelete('_default', '/tmp/not-a-store-path', ui, {
				remove() {
					throw new Error('client should not be called');
				}
			})
		).rejects.toThrow(InvalidStorePathError);
	});
});
