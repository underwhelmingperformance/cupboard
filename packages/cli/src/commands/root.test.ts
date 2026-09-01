import {
	capturingReporter as reporter,
	fakeCliUi
} from '@cupboard/cli-ui/testing';
import {
	cacheNameSchema,
	type CacheScope,
	rootNameSchema,
	ttlSecondsSchema
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import {
	rootEnsureResponseSchema,
	rootListEntrySchema,
	type RootListResponse,
	rootListResponseSchema,
	type RootRemoveResponse,
	rootRemoveResponseSchema,
	type RootSummaryInput,
	rootSummarySchema,
	rootTargetsPageSchema
} from '@cupboard/protocol/retention';
import type { ResultRow } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	type RecordedCall,
	recordingCacheScopedClient
} from '../client/cache-scoped.test-support.ts';

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
const namedCache = (value: string): CacheScope => ({
	kind: 'named',
	name: cacheNameSchema.parse(value)
});
const defaultCache: CacheScope = { kind: 'default' };

interface RootBody {
	name: string;
	targets: string[];
	retention:
		{ kind: 'inherit' | 'permanent' } | { kind: 'duration'; seconds: number };
}
interface ListPage {
	cursor?: string;
	limit?: number;
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
		expect(rootListingAuthorizationDetails(namedCache('pr-1'))).toStrictEqual([
			{
				type: 'cupboard_cache',
				actions: ['root:list'],
				cache: { kind: 'named', name: 'pr-1' }
			}
		]);
	});

	it('narrows the grant to the named root for a single root listing', () => {
		expect(
			rootListingAuthorizationDetails(
				namedCache('pr-1'),
				rootName('github:owner/repo/main')
			)
		).toStrictEqual([
			{
				type: 'cupboard_cache',
				actions: ['root:list'],
				cache: { kind: 'named', name: 'pr-1' },
				root: rootName('github:owner/repo/main')
			}
		]);
	});
});

describe('runRootSet', () => {
	it('addresses the cache, sends the fields, and reports', async () => {
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

		const set = recordingCacheScopedClient((_input: RootBody) =>
			Promise.resolve(response)
		);

		await runRootSet(
			defaultCache,
			rootName('github:owner/repo/main'),
			[target],
			{ kind: 'duration', seconds: ttlSecondsSchema.parse(604_800) },
			reporter(results),
			{ set }
		);

		expect(set.calls).toStrictEqual([
			{
				cache: defaultCache,
				input: {
					name: 'github:owner/repo/main',
					targets: [target],
					retention: { kind: 'duration', seconds: 604_800 }
				}
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
		const set = recordingCacheScopedClient((_input: RootBody) =>
			Promise.reject(rejection)
		);

		let error: unknown;
		try {
			await runRootSet(
				defaultCache,
				rootName('main'),
				['/tmp/nope'],
				{ kind: 'inherit' },
				reporter([]),
				{ set }
			);
		} catch (error_: unknown) {
			error = error_;
		}

		expectRootClientRefusal(error);
		expect({ error: { target: error.target }, calls: set.calls }).toStrictEqual(
			{
				error: { target: '/tmp/nope' },
				calls: [
					{
						cache: defaultCache,
						input: {
							name: 'main',
							targets: ['/tmp/nope'],
							retention: { kind: 'inherit' }
						}
					}
				]
			}
		);
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
		const results: ResultRow[][] = [];
		const ensure = recordingCacheScopedClient((_input: RootBody) =>
			Promise.resolve(response)
		);

		await runRootEnsure(
			defaultCache,
			rootName('main'),
			[target],
			{ kind: 'duration', seconds: ttlSecondsSchema.parse(604_800) },
			reporter(results),
			{ ensure }
		);

		expect({ calls: ensure.calls, results }).toStrictEqual({
			calls: [
				{
					cache: defaultCache,
					input: {
						name: 'main',
						targets: [target],
						retention: { kind: 'duration', seconds: 604_800 }
					}
				}
			],
			results: [expectedRows]
		});
	});
});

describe('runRootList', () => {
	it('follows the cursor to exhaustion and reports a row per root', async () => {
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

		const list = recordingCacheScopedClient((_input: ListPage) => {
			const page = pages.shift();

			if (page === undefined) {
				throw new Error('listed past the final page');
			}

			return Promise.resolve(page);
		});

		await runRootList(defaultCache, reporter(results), { list });

		expect({ calls: list.calls, results }).toStrictEqual({
			calls: [
				{ cache: defaultCache, input: {} },
				{ cache: defaultCache, input: { cursor: 'main' } }
			],
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
			defaultCache,
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

		const targets = recordingCacheScopedClient(
			(_input: ListPage & { name: string }) => {
				const page = pages.shift();

				if (page === undefined) {
					throw new Error('listed past the final page');
				}

				return Promise.resolve(page);
			}
		);

		await runRootTargets(defaultCache, rootName('main'), reporter(results), {
			targets
		});

		expect({ calls: targets.calls, results }).toStrictEqual({
			calls: [
				{ cache: defaultCache, input: { name: 'main' } },
				{
					cache: defaultCache,
					input: { name: 'main', cursor: presentTarget().storePathHash }
				}
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
		const { ui, captured } = fakeCliUi({ confirm: 'yes' });
		const response = rootRemoveResponseSchema.parse({
			name: 'pr-123',
			removed: true
		});
		const client = removeClient(response);

		await runRootRemove(namedCache('builds'), rootName('pr-123'), ui, client);

		expect({
			calls: client.remove.calls,
			results: captured.results
		}).toStrictEqual({
			calls: [
				{
					cache: namedCache('builds'),
					input: { cacheName: 'builds', name: 'pr-123' }
				}
			],
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
			namedCache('builds'),
			rootName('pr-123'),
			ui,
			removeClient(
				rootRemoveResponseSchema.parse({ name: 'pr-123', removed: true })
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

function presentTarget(): RootSummaryInput['targets'][number] {
	return {
		storePathHash: '0123456789abcdfghijklmnpqrsvwxyz',
		storePath: target,
		present: true
	};
}

function summary(overrides: Partial<RootSummaryInput>) {
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

function listClient(response: RootListResponse): Pick<RootClient, 'list'> {
	return {
		list: recordingCacheScopedClient(() => Promise.resolve(response))
	};
}

function removeClient(response: RootRemoveResponse): RootClient & {
	readonly remove: {
		readonly calls: readonly RecordedCall<{ name: string }>[];
	};
} {
	return {
		ensure: recordingCacheScopedClient((input: RootBody) => {
			const response = rootEnsureResponseSchema.parse({
				status: 'retained',
				root: summary({
					name: input.name,
					targets: input.targets.map((storePath) => ({
						storePathHash: StorePath.hash(storePath),
						present: true,
						storePath
					}))
				})
			});

			return Promise.resolve(response);
		}),
		set: recordingCacheScopedClient((input: RootBody) =>
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
		list: recordingCacheScopedClient(() => Promise.resolve({ roots: [] })),
		targets: recordingCacheScopedClient(() => Promise.resolve({ targets: [] })),
		remove: recordingCacheScopedClient((_input: { name: string }) =>
			Promise.resolve(response)
		)
	};
}
