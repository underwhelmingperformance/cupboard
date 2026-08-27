import {
	cacheNameSchema,
	DEFAULT_CACHE,
	privateStoredCache,
	storedCacheSchema
} from '@cupboard/nix-store/scalars';
import { canonicalHref } from '@cupboard/nix-store/url';
import { readUserInputSchema } from '@cupboard/shared/http';
import { describe, expect, it } from 'vitest';

import {
	cachePublicKeyRequestHeaders,
	cacheUrlFor,
	substituterUrlFor
} from './substituters.ts';

describe('cacheUrlFor', () => {
	it.each([
		[
			'https://cache.example.test/',
			DEFAULT_CACHE,
			'https://cache.example.test'
		],
		['https://cache.example.test', 'ci', 'https://cache.example.test/cache/ci']
	])('builds a substituter URL', (baseUrl, cache, expected) => {
		const substituter = cacheUrlFor(
			new URL(baseUrl),
			storedCacheSchema.parse(cache)
		);

		expect(canonicalHref(substituter)).toBe(expected);
	});
});

describe('substituterUrlFor', () => {
	const credential = {
		user: readUserInputSchema.parse('ci'),
		password: 'p@ss word/%'
	};

	it('leaves a public cache URL without a credential', () => {
		const substituter = substituterUrlFor(
			new URL('https://cache.example.test/t/acme'),
			{ cache: cacheNameSchema.parse('builds') }
		);

		expect(canonicalHref(substituter)).toBe(
			'https://cache.example.test/t/acme/cache/builds'
		);
	});

	it('carries a private cache credential in the URL', () => {
		const substituter = substituterUrlFor(
			new URL('https://cache.example.test/t/acme'),
			{
				cache: privateStoredCache(cacheNameSchema.parse('release')),
				credential
			}
		);

		expect({
			href: canonicalHref(substituter),
			user: decodeURIComponent(substituter.username),
			password: decodeURIComponent(substituter.password)
		}).toStrictEqual({
			href: 'https://ci:p%40ss%20word%2F%25@cache.example.test/t/acme/private-cache/release',
			user: credential.user,
			password: credential.password
		});
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
