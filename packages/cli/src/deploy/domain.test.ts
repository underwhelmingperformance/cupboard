import { describe, expect, it } from 'vitest';

import {
	checkDomainOption,
	domainProblem,
	InvalidDomainError
} from './domain.ts';

describe('domainProblem', () => {
	it.each([
		['cache.example.com'],
		['a-b.example.co.uk'],
		['xn--bcher-kva.example']
	])('accepts %s', (value) => {
		expect(domainProblem(value)).toBeUndefined();
	});

	it.each([
		['', 'a domain cannot be empty'],
		['https://cache.example.com', 'without a scheme or path'],
		['cache.example.com/path', 'without a scheme or path'],
		['localhost', 'fully qualified hostname'],
		['-bad.example.com', 'labels must be letters, digits and inner hyphens'],
		['bad-.example.com', 'labels must be letters, digits and inner hyphens'],
		[`${'a'.repeat(254)}.com`, 'at most 253 characters']
	])('rejects %s', (value, reason) => {
		expect(domainProblem(value)).toContain(reason);
	});
});

describe('checkDomainOption', () => {
	it('returns a valid domain unchanged', () => {
		expect(checkDomainOption('cache.example.com')).toBe('cache.example.com');
	});

	it('throws the typed error for an invalid domain', () => {
		expect(() => checkDomainOption('not a domain')).toThrow(InvalidDomainError);
	});
});
