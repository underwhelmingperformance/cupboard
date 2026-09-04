import { fakeCliUi } from '@cupboard/cli-ui/testing';
import { InvalidStorePathError } from '@cupboard/nix-store/errors';
import { cacheNameSchema, DEFAULT_CACHE } from '@cupboard/nix-store/scalars';
import {
	type DeletePathResponse,
	pathDeletionResponseSchema
} from '@cupboard/protocol/upload';
import { describe, expect, it } from 'vitest';

import { cacheScopedDouble } from '../test-support.ts';

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

/**
A delete client that records its calls and reports the path as present.
*/
function recordingClient(): {
	client: DeleteClient;
	calls: { cacheName?: string; hash: string }[];
} {
	const calls: { cacheName?: string; hash: string }[] = [];

	return {
		calls,
		client: {
			remove: cacheScopedDouble((input) => {
				calls.push(input);

				return Promise.resolve(
					pathDeletionResponseSchema.parse({
						storePathHash: input.hash,
						deleted: true,
						narScheduledForDeletion: false
					})
				);
			})
		}
	};
}

describe('runDelete', () => {
	it('derives the hash, addresses a named cache, and reports once confirmed', async () => {
		const { client, calls } = recordingClient();
		const { ui, captured } = fakeCliUi({ confirm: 'yes' });

		await runDelete(cacheNameSchema.parse('builds'), storePath, ui, client);

		expect({ calls, results: captured.results }).toStrictEqual({
			calls: [{ cacheName: 'builds', hash: storePathHash }],
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

		await runDelete(DEFAULT_CACHE, storePath, ui, client);

		expect({ calls, cancellations: captured.cancellations }).toStrictEqual({
			calls: [],
			cancellations: ['Nothing was deleted.']
		});
	});

	it('rejects an argument that is not a store path', async () => {
		const calls: { hash: string }[] = [];
		const { ui, captured } = fakeCliUi({ confirm: 'yes' });

		let outcome:
			| { value: Awaited<ReturnType<typeof runDelete>> }
			| { error: { name: string; storePath: string } };
		try {
			await runDelete(DEFAULT_CACHE, '/tmp/not-a-store-path', ui, {
				remove: cacheScopedDouble((input) => {
					calls.push(input);

					return Promise.resolve(
						pathDeletionResponseSchema.parse({
							storePathHash: input.hash,
							deleted: false,
							narScheduledForDeletion: false
						})
					);
				})
			});
			outcome = { value: undefined };
		} catch (error_: unknown) {
			expect(error_).toBeInstanceOf(InvalidStorePathError);

			const name =
				error_ instanceof InvalidStorePathError ? error_.name : String(error_);
			const storePath =
				error_ instanceof InvalidStorePathError
					? error_.storePath
					: String(error_);

			outcome = { error: { name, storePath } };
		}

		expect({ outcome, calls, results: captured.results }).toStrictEqual({
			outcome: {
				error: {
					name: 'InvalidStorePathError',
					storePath: '/tmp/not-a-store-path'
				}
			},
			calls: [],
			results: []
		});
	});
});
