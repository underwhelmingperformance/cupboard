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
		{ label: 'a named cache', selector: { kind: 'named', name: 'pr-1' } },
		{ label: 'the default cache', selector: { kind: 'default' } },
		{ label: 'a prefix', selector: { kind: 'prefix', prefix: 'pr-' } },
		{ label: 'every cache', selector: { kind: 'all' } },
		{
			label: 'a prefix that is itself a full valid cache name',
			selector: { kind: 'prefix', prefix: 'a'.repeat(63) }
		}
	])('accepts $label', ({ selector }) => {
		expect(reuseViewSelectorSchema.safeParse(selector).success).toBe(true);
	});

	it.each([
		{ label: 'an empty cache name', selector: { kind: 'named', name: '' } },
		{
			label: 'an uppercase cache name',
			selector: { kind: 'named', name: 'PR-1' }
		},
		{
			label: 'the default cache carrying a name',
			selector: { kind: 'default', name: 'pr-1' }
		},
		{
			label: 'a prefix over the length bound',
			selector: { kind: 'prefix', prefix: 'a'.repeat(64) }
		},
		{ label: 'an unknown kind', selector: { kind: 'wildcard', prefix: 'pr-' } },
		{
			label: 'a prefix with an uppercase character',
			selector: { kind: 'prefix', prefix: 'Pr-' }
		},
		{
			label: 'a prefix containing a space',
			selector: { kind: 'prefix', prefix: 'pr 1' }
		},
		{
			label: 'a prefix containing a slash',
			selector: { kind: 'prefix', prefix: 'pr/1' }
		},
		{
			label: 'a prefix containing a Unicode character',
			selector: { kind: 'prefix', prefix: 'pr\u{E9}fix' }
		},
		{
			label: 'a prefix starting with a separator',
			selector: { kind: 'prefix', prefix: '-pr' }
		}
	])('rejects $label', ({ selector }) => {
		expect(reuseViewSelectorSchema.safeParse(selector).success).toBe(false);
	});
});

describe('reuseViewSetBodySchema', () => {
	it('accepts a non-empty selector list without duplicates or a priority', () => {
		const value = {
			access: 'public',
			selectors: [
				{ kind: 'named', name: 'pr-1' },
				{ kind: 'prefix', prefix: 'pr-' }
			]
		};

		expect(reuseViewSetBodySchema.parse(value)).toStrictEqual(value);
	});

	it('accepts an explicit priority', () => {
		const value = {
			access: 'private',
			selectors: [{ kind: 'all' }],
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
						prefix: `p${String(index)}`
					})
				)
			}
		},
		{
			name: 'a duplicated (kind, pattern) selector',
			value: {
				selectors: [
					{ kind: 'prefix', prefix: 'pr-' },
					{ kind: 'prefix', prefix: 'pr-' }
				]
			}
		},
		{
			name: 'a negative priority',
			value: { selectors: [{ kind: 'all' }], priority: -1 }
		},
		{
			name: 'a fractional priority',
			value: { selectors: [{ kind: 'all' }], priority: 1.5 }
		}
	])('rejects $name', ({ value }) => {
		expect(reuseViewSetBodySchema.safeParse(value).success).toBe(false);
	});
});

describe('reuseViewSummarySchema, list and remove responses', () => {
	it('accepts a summary and the list and remove responses', () => {
		const view = {
			name: 'reuse',
			access: 'public',
			revision: 1,
			priority: reuseViewDefaultPriority,
			selectors: [{ kind: 'named', name: 'pr-1' }],
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
			access: 'public',
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

describe('private reuse views', () => {
	it('uses the local name and records private access separately', () => {
		const view = {
			name: 'reuse',
			access: 'private',
			revision: 1,
			priority: reuseViewDefaultPriority,
			selectors: [{ kind: 'named', name: 'builds' }],
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z'
		};

		expect({
			summary: reuseViewSummarySchema.parse(view),
			remove: reuseViewRemoveResponseSchema.parse({
				name: 'reuse',
				removed: true
			})
		}).toStrictEqual({
			summary: view,
			remove: { name: 'reuse', removed: true }
		});
	});
});
