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

	it('parses its own rendering back', () => {
		const info = new CacheInfo('/nix/store', true, 50);

		expect(CacheInfo.parse(info.render())).toStrictEqual(info);
	});

	it.each([
		{
			name: 'fields in any order with extra whitespace',
			text: 'Priority: 30\nStoreDir:  /nix/store\nWantMassQuery: 0\n',
			expected: new CacheInfo('/nix/store', false, 30)
		},
		{
			name: 'unknown lines ignored',
			text: 'StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 40\nFuture: x\n',
			expected: new CacheInfo('/nix/store', true, 40)
		}
	])('parses $name', ({ text, expected }) => {
		expect(CacheInfo.parse(text)).toStrictEqual(expected);
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

	it('reads a missing WantMassQuery as disabled', () => {
		expect(
			CacheInfo.parse('StoreDir: /nix/store\nPriority: 40\n')
		).toStrictEqual(new CacheInfo('/nix/store', false, 40));
	});

	it.each([
		['StoreDir', 'WantMassQuery: 1\nPriority: 40\n'],
		['StoreDir', ''],
		[
			'WantMassQuery',
			'StoreDir: /nix/store\nWantMassQuery: maybe\nPriority: 40\n'
		],
		['Priority', 'StoreDir: /nix/store\nWantMassQuery: 1\n'],
		['Priority', 'StoreDir: /nix/store\nWantMassQuery: 1\nPriority: soon\n'],
		['Priority', 'StoreDir: /nix/store\nPriority:\n'],
		['Priority', 'StoreDir: /nix/store\nPriority: 0x10\n'],
		['Priority', 'StoreDir: /nix/store\nPriority: 1e2\n'],
		['Priority', 'StoreDir: /nix/store\nPriority: 9007199254740993\n']
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
