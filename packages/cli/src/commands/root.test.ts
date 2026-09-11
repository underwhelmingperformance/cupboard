import {
	capturingReporter as reporter,
	fakeCliUi
} from '@cupboard/cli-ui/testing';
import {
	cacheNameSchema,
	DEFAULT_CACHE,
	rootNameSchema,
	ttlSecondsSchema
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import {
	type ParsedRootListResponse,
	type ParsedRootRemoveResponse,
	type ParsedRootSetResponse,
	rootEnsureResponseSchema,
	rootListEntrySchema,
	rootListResponseSchema,
	rootRemoveResponseSchema,
	type RootSummary,
	rootSummarySchema,
	rootTargetsPageSchema
} from '@cupboard/protocol/retention';
import type { ResultRow } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { cacheScopedDouble } from '../test-support.ts';

import {
	describeExpiry,
	type RootClient,
	rootListingAuthorizationDetails,
	runRootEnsure,
	runRootList,
	runRootRemove,
	runRootSet,
	runRootTargets
} from './root.ts';

const rootName = (value: string) => rootNameSchema.parse(value);
const buildsCache = cacheNameSchema.parse('builds');

interface RootWriteInput {
	readonly cacheName?: string;
	readonly name: string;
	readonly targets: string[];
	readonly ttlSeconds?: number;
}

interface ListPageInput {
	readonly cacheName?: string;
	readonly name?: string;
	readonly cursor?: string;
	readonly limit?: number;
}

const target = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app';

class RootClientRefusal extends Error {
	constructor(public readonly target: string) {
		super('root target refused');
	}
}

function expectRootClientRefusal(
	error: unknown
): asserts error is RootClientRefusal {
	expect(error).toBeInstanceOf(RootClientRefusal);
}

describe('describeExpiry', () => {
	it.each([
		{ root: summary({ expired: false }), expected: 'permanent' },
		{
			root: summary({ expiresAt: '2026-01-08T00:00:00.000Z', expired: false }),
			expected: 'expires 2026-01-08 00:00 UTC'
		},
		{
			root: summary({ expiresAt: '2026-01-01T00:00:00.000Z', expired: true }),
			expected: 'expired (2026-01-01 00:00 UTC)'
		}
	])('describes "$expected"', ({ root, expected }) => {
		expect(describeExpiry(root)).toBe(expected);
	});
});

describe('rootListingAuthorizationDetails', () => {
	it('requests a cache-wide root:list grant when no root is named', () => {
		expect(rootListingAuthorizationDetails('pr-1')).toStrictEqual([
			{
				type: 'cupboard_cache',
				actions: ['root:list'],
				cache: 'pr-1'
			}
		]);
	});

	it('narrows the grant to the named root for a single root listing', () => {
		expect(
			rootListingAuthorizationDetails(
				'pr-1',
				rootName('github:owner/repo/main')
			)
		).toStrictEqual([
			{
				type: 'cupboard_cache',
				actions: ['root:list'],
				cache: 'pr-1',
				root: rootName('github:owner/repo/main')
			}
		]);
	});
});

describe('runRootSet', () => {
	it('addresses the default cache, sends the fields, and reports', async () => {
		const calls: RootWriteInput[] = [];
		const results: ResultRow[][] = [];
		const response = summary({
			name: 'github:owner/repo/main',
			expiresAt: '2026-01-08T00:00:00.000Z',
			targets: [
				{
					storePathHash: '0123456789abcdfghijklmnpqrsvwxyz',
					storePath: target,
					present: true
				}
			]
		});

		await runRootSet(
			DEFAULT_CACHE,
			rootName('github:owner/repo/main'),
			[target],
			ttlSecondsSchema.parse(604_800),
			reporter(results),
			setRootClient(response, calls)
		);

		expect(calls).toStrictEqual([
			{
				name: 'github:owner/repo/main',
				targets: [target],
				ttlSeconds: 604_800
			}
		]);
		expect(results).toStrictEqual([
			[
				{ label: 'Root', value: 'github:owner/repo/main' },
				{ label: 'Targets', value: '1' },
				{ label: 'Expiry', value: 'expires 2026-01-08 00:00 UTC' }
			]
		]);
	});

	it('rejects a target the client refuses', async () => {
		const rejection = new RootClientRefusal('/tmp/nope');
		const calls: RootWriteInput[] = [];

		let error: unknown;
		try {
			await runRootSet(
				buildsCache,
				rootName('main'),
				['/tmp/nope'],
				undefined,
				reporter([]),
				{
					set: cacheScopedDouble((input) => {
						calls.push(input);

						return Promise.reject(rejection);
					})
				}
			);
		} catch (error_: unknown) {
			error = error_;
		}

		expectRootClientRefusal(error);
		expect({ error: { target: error.target }, calls }).toStrictEqual({
			error: { target: '/tmp/nope' },
			calls: [
				{
					cacheName: 'builds',
					name: 'main',
					targets: ['/tmp/nope']
				}
			]
		});
	});
});

describe('runRootEnsure', () => {
	const retainedRoot = summary({ name: 'main', targets: [presentTarget()] });

	it.each([
		{
			name: 'a retained root',
			response: rootEnsureResponseSchema.parse({
				status: 'retained',
				root: retainedRoot
			}),
			expectedRows: [
				{ label: 'Root', value: 'main' },
				{ label: 'Status', value: 'retained' },
				{ label: 'Expiry', value: 'permanent' }
			]
		},
		{
			name: 'a build requirement',
			response: rootEnsureResponseSchema.parse({
				status: 'build-required',
				unavailable: [target]
			}),
			expectedRows: [
				{ label: 'Root', value: 'main' },
				{ label: 'Status', value: 'build required' },
				{ label: 'Unavailable', value: target }
			]
		}
	])('reports $name', async ({ response, expectedRows }) => {
		const calls: RootWriteInput[] = [];
		const results: ResultRow[][] = [];

		await runRootEnsure(
			DEFAULT_CACHE,
			rootName('main'),
			[target],
			ttlSecondsSchema.parse(604_800),
			reporter(results),
			{
				ensure: cacheScopedDouble((input) => {
					calls.push(input);

					return Promise.resolve(response);
				})
			}
		);

		expect({ calls, results }).toStrictEqual({
			calls: [
				{
					name: 'main',
					targets: [target],
					ttlSeconds: 604_800
				}
			],
			results: [expectedRows]
		});
	});
});

describe('runRootList', () => {
	it('follows the cursor to exhaustion and reports a row per root', async () => {
		const calls: ListPageInput[] = [];
		const results: ResultRow[][] = [];
		const pages = [
			rootListResponseSchema.parse({
				roots: [entry({ name: 'main', targetCount: 1 })],
				cursor: 'main'
			}),
			rootListResponseSchema.parse({
				roots: [
					entry({
						name: 'pr-123',
						expiresAt: '2026-01-08T00:00:00.000Z',
						targetCount: 3
					})
				]
			})
		];

		await runRootList(buildsCache, reporter(results), {
			list: cacheScopedDouble((input) => {
				calls.push(input);

				const page = pages.shift();

				if (page === undefined) {
					throw new Error('listed past the final page');
				}

				return Promise.resolve(page);
			})
		});

		expect({ calls, results }).toStrictEqual({
			calls: [{ cacheName: 'builds' }, { cacheName: 'builds', cursor: 'main' }],
			results: [
				[
					{ label: 'main', value: '1 target(s); permanent' },
					{
						label: 'pr-123',
						value: '3 target(s); expires 2026-01-08 00:00 UTC'
					}
				]
			]
		});
	});

	it('reports nothing but an info line when there are no roots', async () => {
		const results: ResultRow[][] = [];
		const infos: string[] = [];

		await runRootList(
			DEFAULT_CACHE,
			reporter(results, infos),
			listClient({ roots: [] })
		);

		expect({ results, infos }).toStrictEqual({
			results: [[]],
			infos: ['No retention roots.']
		});
	});
});

describe('runRootTargets', () => {
	it('follows the cursor to exhaustion and reports each target', async () => {
		const calls: ListPageInput[] = [];
		const results: ResultRow[][] = [];
		const missingTarget = `/nix/store/${'b'.repeat(32)}-tool`;
		const pages = [
			rootTargetsPageSchema.parse({
				targets: [presentTarget()],
				cursor: presentTarget().storePathHash
			}),
			rootTargetsPageSchema.parse({
				targets: [
					{
						storePathHash: 'b'.repeat(32),
						storePath: missingTarget,
						present: false
					}
				]
			})
		];

		await runRootTargets(DEFAULT_CACHE, rootName('main'), reporter(results), {
			targets: cacheScopedDouble((input) => {
				calls.push(input);

				const page = pages.shift();

				if (page === undefined) {
					throw new Error('listed past the final page');
				}

				return Promise.resolve(page);
			})
		});

		expect({ calls, results }).toStrictEqual({
			calls: [
				{ name: 'main' },
				{ name: 'main', cursor: presentTarget().storePathHash }
			],
			results: [
				[
					{ label: target, value: 'present' },
					{ label: missingTarget, value: 'missing' }
				]
			]
		});
	});
});

describe('runRootRemove', () => {
	it('removes the root and reports the outcome once confirmed', async () => {
		const calls: { cacheName?: string; name: string }[] = [];
		const { ui, captured } = fakeCliUi({ confirm: 'yes' });
		const response = rootRemoveResponseSchema.parse({
			name: 'pr-123',
			removed: true
		});

		await runRootRemove(
			buildsCache,
			rootName('pr-123'),
			ui,
			removeClient(response, calls)
		);

		expect({ calls, results: captured.results }).toStrictEqual({
			calls: [{ cacheName: 'builds', name: 'pr-123' }],
			results: [
				{
					kind: 'root',
					data: response,
					rows: [
						{ label: 'Root', value: 'pr-123' },
						{ label: 'Removed', value: 'yes' }
					]
				}
			]
		});
	});

	it('leaves the root in place when the confirmation is declined', async () => {
		const { ui, captured } = fakeCliUi({ confirm: 'no' });

		await runRootRemove(
			buildsCache,
			rootName('pr-123'),
			ui,
			removeClient(
				rootRemoveResponseSchema.parse({ name: 'pr-123', removed: true }),
				[]
			)
		);

		expect({
			results: captured.results,
			cancellations: captured.cancellations
		}).toStrictEqual({
			results: [],
			cancellations: ['The retention root was left in place.']
		});
	});
});

function presentTarget(): RootSummary['targets'][number] {
	return {
		storePathHash: '0123456789abcdfghijklmnpqrsvwxyz',
		storePath: target,
		present: true
	};
}

function summary(overrides: Partial<RootSummary>) {
	return rootSummarySchema.parse({
		name: 'root',
		expired: false,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		targets: [],
		...overrides
	});
}

function entry(
	overrides: Partial<z.input<typeof rootListEntrySchema>>
): z.output<typeof rootListEntrySchema> {
	return rootListEntrySchema.parse({
		name: 'root',
		expired: false,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		targetCount: 0,
		...overrides
	});
}

function setRootClient(
	response: ParsedRootSetResponse,
	calls: RootWriteInput[]
): Pick<RootClient, 'set'> {
	return {
		set: cacheScopedDouble((input) => {
			calls.push(input);

			return Promise.resolve(response);
		})
	};
}

function listClient(
	response: ParsedRootListResponse
): Pick<RootClient, 'list'> {
	return {
		list: cacheScopedDouble(() => Promise.resolve(response))
	};
}

function removeClient(
	response: ParsedRootRemoveResponse,
	calls: { cacheName?: string; name: string }[]
): RootClient {
	return {
		ensure: cacheScopedDouble((input) =>
			Promise.resolve({
				status: 'retained',
				root: summary({
					name: input.name,
					targets: input.targets.map((storePath) => ({
						storePathHash: StorePath.hash(storePath),
						present: true,
						storePath
					}))
				})
			})
		),
		set: cacheScopedDouble((input) =>
			Promise.resolve(
				summary({
					name: input.name,
					targets: input.targets.map((storePath) => ({
						storePathHash: StorePath.hash(storePath),
						present: true,
						storePath
					}))
				})
			)
		),
		list: cacheScopedDouble(() => Promise.resolve({ roots: [] })),
		targets: cacheScopedDouble(() => Promise.resolve({ targets: [] })),
		remove: cacheScopedDouble((input) => {
			calls.push(input);

			return Promise.resolve(response);
		})
	};
}
