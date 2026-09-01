import {
	capturingReporter as reporter,
	fakeCliUi
} from '@cupboard/cli-ui/testing';
import { cacheNameSchema } from '@cupboard/nix-store/scalars';
import {
	reuseViewListResponseSchema,
	reuseViewPrioritySchema,
	reuseViewRemoveResponseSchema,
	type ReuseViewSelector,
	type ReuseViewSelectorInput,
	type ReuseViewSummaryInput,
	reuseViewSummarySchema
} from '@cupboard/protocol/reuse-views';
import type { ResultRow } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import {
	InvalidReuseViewPriorityError,
	InvalidReuseViewSelectorError,
	ReuseViewSelectorRequiredError
} from '../errors.ts';

import {
	parsePriority,
	parseSelector,
	runReuseViewList,
	runReuseViewRemove,
	runReuseViewSet,
	selectorsFromOptions
} from './reuse-view.ts';

const summary = reuseViewSummarySchema.parse({
	name: 'reuse',
	access: 'public',
	revision: 1,
	priority: 50,
	selectors: [
		{ kind: 'named', name: 'release' },
		{ kind: 'prefix', prefix: 'pr-' }
	],
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z'
});

describe('parsePriority', () => {
	it('accepts a decimal integer', () => {
		expect(parsePriority('50')).toBe(50);
	});

	it.each([[''], ['1e2'], ['0x10'], ['-1'], ['1.5'], ['soon'], ['010']])(
		"rejects '%s'",
		(value) => {
			expect(() => parsePriority(value)).toThrow(InvalidReuseViewPriorityError);
		}
	);
});

describe('selectorsFromOptions', () => {
	it('preserves selectors in command-line order', () => {
		expect(
			selectorsFromOptions({
				select: [
					parseSelector('cache:release'),
					parseSelector('prefix:pr-'),
					parseSelector('all-named')
				]
			})
		).toStrictEqual([
			{ kind: 'named', name: 'release' },
			{ kind: 'prefix', prefix: 'pr-' },
			{ kind: 'all-named' }
		]);
	});

	it('rejects a call naming no cache at all', () => {
		expect(() => {
			selectorsFromOptions({ select: [] });
		}).toThrow(ReuseViewSelectorRequiredError);
	});
});

describe('parseSelector', () => {
	const cases: (readonly [string, ReuseViewSelector])[] = [
		['default', { kind: 'default' }],
		['all', { kind: 'all' }],
		['all-named', { kind: 'all-named' }],
		[
			'cache:release',
			{ kind: 'named', name: cacheNameSchema.parse('release') }
		],
		['prefix:pr-', { kind: 'prefix', prefix: 'pr-' }]
	];

	it.each(cases)('parses %s', (value, expected) => {
		expect(parseSelector(value)).toStrictEqual(expected);
	});

	it.each(['cache:', 'prefix:', 'anything'])("rejects '%s'", (value) => {
		expect(() => parseSelector(value)).toThrow(InvalidReuseViewSelectorError);
	});
});

describe('runReuseViewList', () => {
	it('reports a row per view', async () => {
		const results: ResultRow[][] = [];
		const response = reuseViewListResponseSchema.parse({ views: [summary] });

		await runReuseViewList(reporter(results), {
			list: () => Promise.resolve(response)
		});

		expect(results).toStrictEqual([
			[
				{
					label: 'reuse',
					value: 'public; revision 1; priority 50; cache:release, prefix:pr-'
				}
			]
		]);
	});

	it('renders the all selector as matching every cache', async () => {
		const results: ResultRow[][] = [];
		const view: ReuseViewSummaryInput = {
			...summary,
			selectors: [{ kind: 'all' }]
		};

		await runReuseViewList(reporter(results), {
			list: () =>
				Promise.resolve(reuseViewListResponseSchema.parse({ views: [view] }))
		});

		expect(results).toStrictEqual([
			[
				{
					label: 'reuse',
					value: 'public; revision 1; priority 50; all'
				}
			]
		]);
	});

	it('reports an info line when there are no views', async () => {
		const results: ResultRow[][] = [];
		const infos: string[] = [];

		await runReuseViewList(reporter(results, infos), {
			list: () => Promise.resolve({ views: [] })
		});

		expect({ results, infos }).toStrictEqual({
			results: [[]],
			infos: ['No reuse views.']
		});
	});
});

describe('runReuseViewSet', () => {
	it.each([
		{
			name: 'named and prefix selectors, explicit priority',
			selectors: [parseSelector('cache:release'), parseSelector('prefix:pr-')],
			priority: reuseViewPrioritySchema.parse(10),
			row: {
				label: 'Selectors',
				value: 'cache:release, prefix:pr-'
			}
		},
		{
			name: 'the all selector',
			selectors: [parseSelector('all')],
			priority: undefined,
			row: { label: 'Selectors', value: 'all' }
		}
	])(
		'passes the selectors and priority through, reporting the summary for $name',
		async ({ selectors, priority, row }) => {
			const calls: {
				name: string;
				access: 'public' | 'private';
				selectors: readonly ReuseViewSelectorInput[];
				priority?: number;
			}[] = [];
			const results: ResultRow[][] = [];
			const response = reuseViewSummarySchema.parse({
				...summary,
				selectors,
				...(priority !== undefined && { priority })
			});

			await runReuseViewSet(
				'reuse',
				'public',
				selectors,
				priority,
				reporter(results),
				{
					set(input) {
						calls.push(input);
						return Promise.resolve(response);
					}
				}
			);

			expect({ calls, results }).toStrictEqual({
				calls: [
					{
						name: 'reuse',
						access: 'public',
						selectors,
						...(priority !== undefined && { priority })
					}
				],
				results: [
					[
						{ label: 'View', value: 'reuse' },
						{ label: 'Access', value: 'public' },
						{ label: 'Revision', value: String(response.revision) },
						{ label: 'Priority', value: String(response.priority) },
						row
					]
				]
			});
		}
	);
});

describe('runReuseViewRemove', () => {
	it('removes a view and reports the outcome once confirmed', async () => {
		const calls: { name: string }[] = [];
		const { ui, captured } = fakeCliUi({ confirm: 'yes' });
		const response = reuseViewRemoveResponseSchema.parse({
			name: 'reuse',
			removed: true
		});

		await runReuseViewRemove('reuse', ui, {
			remove(input) {
				calls.push(input);
				return Promise.resolve(response);
			}
		});

		expect({ calls, results: captured.results }).toStrictEqual({
			calls: [{ name: 'reuse' }],
			results: [
				{
					kind: 'reuse-view',
					data: response,
					rows: [
						{ label: 'View', value: 'reuse' },
						{ label: 'Removed', value: 'yes' }
					]
				}
			]
		});
	});

	it('reports not present when the view did not exist', async () => {
		const { ui, captured } = fakeCliUi({ confirm: 'yes' });
		const response = reuseViewRemoveResponseSchema.parse({
			name: 'reuse',
			removed: false
		});

		await runReuseViewRemove('reuse', ui, {
			remove: () => Promise.resolve(response)
		});

		expect(captured.results).toStrictEqual([
			{
				kind: 'reuse-view',
				data: response,
				rows: [
					{ label: 'View', value: 'reuse' },
					{ label: 'Removed', value: 'not present' }
				]
			}
		]);
	});

	it('leaves the view in place when the confirmation is declined', async () => {
		const { ui, captured } = fakeCliUi({ confirm: 'no' });

		await runReuseViewRemove('reuse', ui, {
			remove: () =>
				Promise.resolve(
					reuseViewRemoveResponseSchema.parse({ name: 'reuse', removed: true })
				)
		});

		expect({
			results: captured.results,
			cancellations: captured.cancellations
		}).toStrictEqual({
			results: [],
			cancellations: ['The reuse view was left in place.']
		});
	});
});
describe('a private view summary', () => {
	it('reports access independently from the view name', async () => {
		const results: ResultRow[][] = [];
		const calls: { name: string }[] = [];
		const privateSummary = reuseViewSummarySchema.parse({
			...summary,
			access: 'private',
			selectors: [{ kind: 'prefix', prefix: 'pr-' }]
		});

		await runReuseViewSet(
			'reuse',
			'private',
			[{ kind: 'prefix', prefix: 'pr-' }],
			undefined,
			reporter(results),
			{
				set(input) {
					calls.push({ name: input.name });
					return Promise.resolve(privateSummary);
				}
			}
		);

		expect({ calls, results }).toStrictEqual({
			calls: [{ name: 'reuse' }],
			results: [
				[
					{ label: 'View', value: 'reuse' },
					{ label: 'Access', value: 'private' },
					{ label: 'Revision', value: '1' },
					{ label: 'Priority', value: '50' },
					{ label: 'Selectors', value: 'prefix:pr-' }
				]
			]
		});
	});
});
