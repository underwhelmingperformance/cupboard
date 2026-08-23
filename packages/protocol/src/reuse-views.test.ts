import { cachePrioritySchema } from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import {
	isDestinationPreferred,
	reuseViewDefaultPriority,
	reuseViewListResponseSchema,
	reuseViewMaxSelectors,
	reuseViewNameSchema,
	reuseViewPrioritySchema,
	reuseViewRemoveResponseSchema,
	reuseViewSelectorSchema,
	reuseViewSetBodySchema,
	reuseViewSummarySchema,
	viewPriorityMargin
} from './reuse-views.ts';

const destinationPriority = (value: number) => cachePrioritySchema.parse(value);
const viewPriority = (value: number) => reuseViewPrioritySchema.parse(value);

describe('reuseViewNameSchema', () => {
	it.each(['reuse', 'reuse-1', 'a'.repeat(63)])('accepts %s', (value) => {
		expect(reuseViewNameSchema.safeParse(value).success).toBe(true);
	});

	it.each([
		['the empty string', ''],
		['an uppercase name', 'Reuse'],
		['a name over the length bound', 'a'.repeat(64)],
		['a name starting with a separator', '-reuse']
	])('rejects %s', (_name, value) => {
		expect(reuseViewNameSchema.safeParse(value).success).toBe(false);
	});
});

describe('reuseViewSelectorSchema', () => {
	it.each([
		{
			name: 'an exact selector for a valid cache',
			kind: 'exact',
			pattern: 'pr-1'
		},
		{
			name: 'an exact selector for the default cache',
			kind: 'exact',
			pattern: '_default'
		},
		{ name: 'a prefix selector', kind: 'prefix', pattern: 'pr-' },
		{
			name: 'the empty prefix, matching every cache',
			kind: 'prefix',
			pattern: ''
		},
		{
			name: 'a prefix that is itself a full valid cache name',
			kind: 'prefix',
			pattern: 'a'.repeat(63)
		}
	])('accepts $name', ({ kind, pattern }) => {
		expect(reuseViewSelectorSchema.safeParse({ kind, pattern }).success).toBe(
			true
		);
	});

	it.each([
		{
			name: 'an exact selector with an invalid cache name',
			kind: 'exact',
			pattern: ''
		},
		{
			name: 'an exact selector with an uppercase cache name',
			kind: 'exact',
			pattern: 'PR-1'
		},
		{
			name: 'a pattern over the length bound',
			kind: 'prefix',
			pattern: 'a'.repeat(64)
		},
		{ name: 'an unknown kind', kind: 'wildcard', pattern: 'pr-' },
		{
			name: 'a prefix with an uppercase character',
			kind: 'prefix',
			pattern: 'Pr-'
		},
		{ name: 'a prefix containing a space', kind: 'prefix', pattern: 'pr 1' },
		{ name: 'a prefix containing a slash', kind: 'prefix', pattern: 'pr/1' },
		{
			name: 'a prefix containing a Unicode character',
			kind: 'prefix',
			pattern: 'préfix'
		},
		{
			name: 'a prefix starting with a separator',
			kind: 'prefix',
			pattern: '-pr'
		}
	])('rejects $name', ({ kind, pattern }) => {
		expect(reuseViewSelectorSchema.safeParse({ kind, pattern }).success).toBe(
			false
		);
	});
});

describe('reuseViewSetBodySchema', () => {
	it('accepts a non-empty selector list without duplicates or a priority', () => {
		const value = {
			selectors: [
				{ kind: 'exact', pattern: 'pr-1' },
				{ kind: 'prefix', pattern: 'pr-' }
			]
		};

		expect(reuseViewSetBodySchema.parse(value)).toStrictEqual(value);
	});

	it('accepts an explicit priority', () => {
		const value = {
			selectors: [{ kind: 'prefix', pattern: '' }],
			priority: 10
		};

		expect(reuseViewSetBodySchema.parse(value)).toStrictEqual(value);
	});

	it.each([
		{
			name: 'an empty selector list',
			value: { selectors: [] }
		},
		{
			name: 'a selector count over the cap',
			value: {
				selectors: Array.from(
					{ length: reuseViewMaxSelectors + 1 },
					(_, index) => ({
						kind: 'prefix',
						pattern: `p${String(index)}`
					})
				)
			}
		},
		{
			name: 'a duplicated (kind, pattern) selector',
			value: {
				selectors: [
					{ kind: 'prefix', pattern: 'pr-' },
					{ kind: 'prefix', pattern: 'pr-' }
				]
			}
		},
		{
			name: 'a negative priority',
			value: { selectors: [{ kind: 'prefix', pattern: '' }], priority: -1 }
		},
		{
			name: 'a fractional priority',
			value: { selectors: [{ kind: 'prefix', pattern: '' }], priority: 1.5 }
		}
	])('rejects $name', ({ value }) => {
		expect(reuseViewSetBodySchema.safeParse(value).success).toBe(false);
	});
});

describe('reuseViewSummarySchema, list and remove responses', () => {
	it('accepts a summary and the list and remove responses', () => {
		const view = {
			name: 'reuse',
			revision: 1,
			priority: reuseViewDefaultPriority,
			selectors: [{ kind: 'exact', pattern: 'pr-1' }],
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z'
		};
		const remove = { name: 'reuse', removed: true };

		expect({
			summary: reuseViewSummarySchema.parse(view),
			list: reuseViewListResponseSchema.parse({ views: [view] }),
			remove: reuseViewRemoveResponseSchema.parse(remove)
		}).toStrictEqual({
			summary: view,
			list: { views: [view] },
			remove
		});
	});

	it('rejects a summary with a revision below 1', () => {
		const view = {
			name: 'reuse',
			revision: 0,
			priority: reuseViewDefaultPriority,
			selectors: [],
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z'
		};

		expect(reuseViewSummarySchema.safeParse(view).success).toBe(false);
	});
});

describe('isDestinationPreferred', () => {
	it.each([
		{
			name: 'a greater numeric view priority keeps the destination preferred',
			view: 50,
			expected: true
		},
		{
			name: 'an equal numeric priority does not prefer the destination',
			view: 40,
			expected: false
		},
		{
			name: 'a lower numeric view priority prefers the view',
			view: 30,
			expected: false
		}
	])('$name', ({ view, expected }) => {
		expect(
			isDestinationPreferred(destinationPriority(40), viewPriority(view))
		).toBe(expected);
	});

	it("keeps the destination preferred when the view's numeric priority is 10 greater than the destination's", () => {
		expect(
			isDestinationPreferred(
				destinationPriority(40),
				viewPriority(40 + viewPriorityMargin)
			)
		).toBe(true);
	});
});
