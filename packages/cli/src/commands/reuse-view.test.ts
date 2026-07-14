import {
	capturingReporter as reporter,
	fakeCliUi
} from '@cupboard/cli-ui/testing';
import type {
	ReuseViewListResponse,
	ReuseViewRemoveResponse,
	ReuseViewSelector,
	ReuseViewSummary
} from '@cupboard/protocol/reuse-views';
import type { ResultRow } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import {
	InvalidReuseViewPriorityError,
	ReuseViewSelectorRequiredError
} from '../errors.ts';

import {
	parsePriority,
	runReuseViewList,
	runReuseViewRemove,
	runReuseViewSet,
	selectorsFromOptions
} from './reuse-view.ts';

const summary: ReuseViewSummary = {
	name: 'reuse',
	revision: 1,
	priority: 50,
	selectors: [
		{ kind: 'exact', pattern: 'release' },
		{ kind: 'prefix', pattern: 'pr-' }
	],
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z'
};

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
	it('orders exacts before prefixes, each as given', () => {
		expect(
			selectorsFromOptions({
				exact: ['release', 'hotfix'],
				prefix: ['pr-', 'staging-']
			})
		).toStrictEqual([
			{ kind: 'exact', pattern: 'release' },
			{ kind: 'exact', pattern: 'hotfix' },
			{ kind: 'prefix', pattern: 'pr-' },
			{ kind: 'prefix', pattern: 'staging-' }
		]);
	});

	it('accepts an empty prefix as one selector matching every cache', () => {
		expect(selectorsFromOptions({ exact: [], prefix: [''] })).toStrictEqual([
			{ kind: 'prefix', pattern: '' }
		]);
	});

	it('rejects neither --exact nor --prefix given', () => {
		expect(() => {
			selectorsFromOptions({ exact: [], prefix: [] });
		}).toThrow(ReuseViewSelectorRequiredError);
	});
});

describe('runReuseViewList', () => {
	it('reports a row per view', async () => {
		const results: ResultRow[][] = [];
		const response: ReuseViewListResponse = { views: [summary] };

		await runReuseViewList(reporter(results), {
			list: () => Promise.resolve(response)
		});

		expect(results).toStrictEqual([
			[
				{
					label: 'reuse',
					value: 'revision 1; priority 50; exact:release, prefix:pr-'
				}
			]
		]);
	});

	it('renders an empty prefix selector as matching every cache', async () => {
		const results: ResultRow[][] = [];
		const view: ReuseViewSummary = {
			...summary,
			selectors: [{ kind: 'prefix', pattern: '' }]
		};

		await runReuseViewList(reporter(results), {
			list: () => Promise.resolve({ views: [view] })
		});

		expect(results).toStrictEqual([
			[
				{
					label: 'reuse',
					value: 'revision 1; priority 50; prefix:(all caches)'
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
			name: 'exact and prefix selectors, explicit priority',
			selectors: [
				{ kind: 'exact', pattern: 'release' },
				{ kind: 'prefix', pattern: 'pr-' }
			] satisfies ReuseViewSelector[],
			priority: 10,
			row: {
				label: 'Selectors',
				value: 'exact:release, prefix:pr-'
			}
		},
		{
			name: 'a single empty prefix selector',
			selectors: [
				{ kind: 'prefix', pattern: '' }
			] satisfies ReuseViewSelector[],
			priority: undefined,
			row: { label: 'Selectors', value: 'prefix:(all caches)' }
		}
	])(
		'passes the selectors and priority through, reporting the summary for $name',
		async ({ selectors, priority, row }) => {
			const calls: {
				name: string;
				selectors: readonly ReuseViewSelector[];
				priority?: number;
			}[] = [];
			const results: ResultRow[][] = [];
			const response: ReuseViewSummary = {
				...summary,
				selectors,
				...(priority !== undefined && { priority })
			};

			await runReuseViewSet('reuse', selectors, priority, reporter(results), {
				set(input) {
					calls.push(input);
					return Promise.resolve(response);
				}
			});

			expect({ calls, results }).toStrictEqual({
				calls: [
					{
						name: 'reuse',
						selectors,
						...(priority !== undefined && { priority })
					}
				],
				results: [
					[
						{ label: 'View', value: 'reuse' },
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
		const response: ReuseViewRemoveResponse = {
			name: 'reuse',
			removed: true
		};

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
		const response: ReuseViewRemoveResponse = {
			name: 'reuse',
			removed: false
		};

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
			remove: () => Promise.resolve({ name: 'reuse', removed: true })
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
