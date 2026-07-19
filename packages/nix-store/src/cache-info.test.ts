import { describe, expect, it } from 'vitest';

import {
	CacheInfo,
	isDestinationPreferred,
	viewPriorityMargin
} from './cache-info.ts';

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
