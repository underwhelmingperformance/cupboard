import { describe, expect, it } from 'vitest';

import { QuotaExceededError } from './errors.ts';

describe('QuotaExceededError', () => {
	it.each([
		{ detail: '', equivalent: 'The cache is over its storage quota.' },
		{
			detail: "This upload would exceed the tenant's storage quota",
			equivalent: "This upload would exceed the tenant's storage quota."
		},
		{
			detail: 'Cache builds is over its 10 GB quota. ',
			equivalent: 'Cache builds is over its 10 GB quota.'
		}
	])(
		'gives detail $detail the same message as $equivalent',
		({ detail, equivalent }) => {
			expect(new QuotaExceededError(detail).message).toBe(
				new QuotaExceededError(equivalent).message
			);
		}
	);

	it('gives different details different messages', () => {
		const messages = [
			'Cache builds is over its 10 GB quota.',
			'Cache docs is over its 5 GB quota.'
		].map((detail) => new QuotaExceededError(detail).message);

		expect(new Set(messages).size).toBe(messages.length);
	});
});
