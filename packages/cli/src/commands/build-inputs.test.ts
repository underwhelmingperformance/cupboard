import { fakeCliUi } from '@cupboard/cli-ui/testing';
import { cacheNameSchema, type CacheScope } from '@cupboard/nix-store/scalars';
import {
	buildInputsClearResponseSchema,
	buildInputsReadResponseSchema
} from '@cupboard/protocol/build-inputs';
import { describe, expect, it } from 'vitest';

import { recordingCacheScopedClient } from '../client/cache-scoped.test-support.ts';
import { PathResponseMismatchError } from '../errors.ts';

import { runBuildInputsClear, runBuildInputsShow } from './build-inputs.ts';

function hash(index: number): string {
	return String(index).padStart(32, '0');
}

function storePath(index: number): string {
	return `/nix/store/${hash(index)}-app`;
}

const compiler = `${'1'.repeat(32)}-compiler`;
const namedCache: CacheScope = {
	kind: 'named',
	name: cacheNameSchema.parse('ci')
};

describe('runBuildInputsShow', () => {
	it.each([
		{
			answer: {
				storePathHash: hash(0),
				status: 'recorded',
				buildInputs: [compiler],
				buildInputsVersion: 1
			},
			rows: [
				{ label: 'Version', value: '1' },
				{ label: 'Build input', value: compiler }
			]
		},
		{
			answer: { storePathHash: hash(0), status: 'none' },
			rows: [{ label: 'Status', value: 'no build inputs recorded' }]
		},
		{
			answer: { storePathHash: hash(0), status: 'absent' },
			rows: [{ label: 'Status', value: 'not in this cache' }]
		},
		{
			answer: { storePathHash: hash(0), status: 'invalid-stored' },
			rows: [
				{
					label: 'Status',
					value: 'the stored build inputs cannot be read; clear them'
				}
			]
		}
	])(
		'reports a path whose build inputs are $answer.status',
		async ({ answer, rows }) => {
			const read = recordingCacheScopedClient(() =>
				Promise.resolve(buildInputsReadResponseSchema.parse(answer))
			);
			const { ui, captured } = fakeCliUi();

			await runBuildInputsShow(namedCache, storePath(0), ui.reporter(), {
				read
			});

			expect({ calls: read.calls, results: captured.results }).toStrictEqual({
				calls: [
					{
						cache: namedCache,
						input: { hash: hash(0), cacheName: 'ci' }
					}
				],
				results: [
					{
						kind: 'build-inputs',
						title: 'Build inputs',
						data: answer,
						rows: [{ label: 'Store path', value: `${hash(0)}-app` }, ...rows]
					}
				]
			});
		}
	);
});

describe('runBuildInputsClear', () => {
	it('clears 128 store paths a request and reports each one', async () => {
		const clear = recordingCacheScopedClient(
			(input: { storePathHashes: string[] }) =>
				Promise.resolve(
					buildInputsClearResponseSchema.parse({
						entries: input.storePathHashes.map((storePathHash) => ({
							storePathHash,
							status: 'cleared'
						}))
					})
				)
		);
		const storePaths = Array.from({ length: 129 }, (_, index) =>
			storePath(index)
		);
		const { ui, captured } = fakeCliUi({ confirm: 'yes' });

		await runBuildInputsClear(
			{ kind: 'default' },
			[...storePaths, storePath(0)],
			ui,
			{ clear }
		);

		expect({
			requests: clear.calls.map((call) => call.input.storePathHashes),
			rows: captured.results.flatMap((result) => result.rows)
		}).toStrictEqual({
			requests: [
				storePaths.slice(0, 128).map((_, index) => hash(index)),
				[hash(128)]
			],
			rows: storePaths.map((_, index) => ({
				label: `${hash(index)}-app`,
				value: 'cleared'
			}))
		});
	});

	it('refuses an answer for other store paths than it asked about', async () => {
		const clear = recordingCacheScopedClient(() =>
			Promise.resolve(
				buildInputsClearResponseSchema.parse({
					entries: [{ storePathHash: hash(2), status: 'cleared' }]
				})
			)
		);
		const { ui, captured } = fakeCliUi({ confirm: 'yes' });
		let failure: unknown;

		try {
			await runBuildInputsClear({ kind: 'default' }, [storePath(1)], ui, {
				clear
			});
		} catch (error) {
			failure = error;
		}

		expect({
			isMismatch: failure instanceof PathResponseMismatchError,
			storePath:
				failure instanceof PathResponseMismatchError
					? failure.storePath
					: undefined,
			results: captured.results
		}).toStrictEqual({ isMismatch: true, storePath: hash(1), results: [] });
	});

	it('clears nothing when the confirmation is declined', async () => {
		const clear = recordingCacheScopedClient(() =>
			Promise.resolve(buildInputsClearResponseSchema.parse({ entries: [] }))
		);
		const { ui, captured } = fakeCliUi({ confirm: 'no' });

		await runBuildInputsClear({ kind: 'default' }, [storePath(0)], ui, {
			clear
		});

		expect({
			calls: clear.calls,
			cancellations: captured.cancellations
		}).toStrictEqual({
			calls: [],
			cancellations: ['No build inputs were cleared.']
		});
	});
});
