import { describe, expect, it } from 'vitest';

import {
	cachePublicKeyRequestHeaders,
	cachePublicKeyUrl,
	cacheUrlFor
} from './substituters.ts';

describe('cacheUrlFor', () => {
	it.each([
		['https://cache.example.test/', '', 'https://cache.example.test'],
		['https://cache.example.test', 'ci', 'https://cache.example.test/cache/ci']
	])('builds a substituter URL', (baseUrl, cache, expected) => {
		expect(cacheUrlFor(baseUrl, cache)).toBe(expected);
	});
});

describe('cachePublicKeyUrl', () => {
	it.each([
		[
			'https://cache.example.test/t/acme',
			'https://cache.example.test/t/acme/pubkey'
		],
		[
			'https://cache.example.test/t/acme/',
			'https://cache.example.test/t/acme/pubkey'
		],
		['https://cache.example.test', 'https://cache.example.test/pubkey']
	])('keeps the tenant path for %s', (cacheUrl, expected) => {
		expect(cachePublicKeyUrl(cacheUrl)).toBe(expected);
	});
});

describe('cachePublicKeyRequestHeaders', () => {
	it('does not include GitHub authentication headers', () => {
		expect(cachePublicKeyRequestHeaders()).toStrictEqual({
			accept: 'text/plain',
			'user-agent': 'cupboard-action'
		});
	});
});
