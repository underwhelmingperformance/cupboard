import { describe, expect, it } from 'vitest';

import { formatRows } from './ui.ts';

const escape = String.fromCodePoint(27);

function stripColours(value: string): string {
	return value
		.split(escape)
		.map((part, index) => (index === 0 ? part : part.replace(/^\[\d+m/, '')))
		.join('');
}

describe('formatRows', () => {
	it('aligns values to the widest label', () => {
		const formatted = stripColours(
			formatRows([
				{ label: 'Account', value: 'acc-1' },
				{ label: 'Custom domain', value: 'cache.example.com' }
			])
		);

		expect(formatted).toBe(
			['Account        acc-1', 'Custom domain  cache.example.com'].join('\n')
		);
	});

	it('renders a single row without padding beyond its own label', () => {
		expect(
			stripColours(formatRows([{ label: 'Account', value: 'acc-1' }]))
		).toBe('Account  acc-1');
	});
});
