import { describe, expect, it } from 'vitest';

import {
	CacheInfo,
	isDestinationPreferred,
	viewPriorityMargin
} from './cache-info.ts';
import { CacheInfoParseError } from './errors.ts';

describe('CacheInfo', () => {
	it('renders nix-cache-info', () => {
		expect(CacheInfo.default.render()).toBe(
			['StoreDir: /nix/store', 'WantMassQuery: 1', 'Priority: 40', ''].join(
				'\n'
			)
		);
	});
});

describe('isDestinationPreferred', () => {
	it.each([
		{
			name: 'a higher view priority keeps the destination preferred',
			view: 50,
			expected: true
		},
		{
			name: 'an equal view priority does not keep the destination preferred',
			view: 40,
			expected: false
		},
		{
			name: 'a lower view priority does not keep the destination preferred',
			view: 30,
			expected: false
		}
	])('$name', ({ view, expected }) => {
		expect(isDestinationPreferred(40, view)).toBe(expected);
	});

	it('keeps the destination preferred when the view sits a margin below', () => {
		expect(isDestinationPreferred(40, 40 + viewPriorityMargin)).toBe(true);
	});
});

describe('CacheInfo.parse', () => {
	it('round-trips a rendered document', () => {
		const rendered = new CacheInfo('/nix/store', true, 41).render();

		expect(CacheInfo.parse(rendered)).toStrictEqual(
			new CacheInfo('/nix/store', true, 41)
		);
	});

	it('parses a document with extra fields and windows line endings', () => {
		const source =
			'StoreDir: /nix/store\r\nWantMassQuery: 0\r\nPriority: 30\r\nExtra: 1\r\n';

		expect(CacheInfo.parse(source)).toStrictEqual(
			new CacheInfo('/nix/store', false, 30)
		);
	});

	it.each([
		['StoreDir', 'WantMassQuery: 1\nPriority: 40\n'],
		['WantMassQuery', 'StoreDir: /nix/store\nPriority: 40\n'],
		['Priority', 'StoreDir: /nix/store\nWantMassQuery: 1\n'],
		['Priority', 'StoreDir: /nix/store\nWantMassQuery: 1\nPriority: soon\n']
	])('refuses a document with a bad %s', (field, source) => {
		let failure: unknown;

		try {
			CacheInfo.parse(source);
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(CacheInfoParseError);

		if (failure instanceof CacheInfoParseError) {
			expect(failure.field).toBe(field);
		}
	});
});
