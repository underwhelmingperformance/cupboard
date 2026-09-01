import { describe, expect, it } from 'vitest';

import {
	cacheUrl,
	parseTenantCacheUrl,
	publicKeyUrl,
	reuseViewUrl,
	tenantUrl,
	urlWithCredential
} from './cache-url.ts';
import {
	InvalidCacheUrlSegmentError,
	InvalidTenantCacheUrlError
} from './errors.ts';
import { cacheScopeSchema } from './scalars.ts';
import { parseBaseUrl } from './url.ts';

function base(value: string): URL {
	return parseBaseUrl(new URL(value));
}

describe('cacheUrl', () => {
	it.each([
		{
			name: 'the default cache returns the bare base URL',
			value: 'https://cupboard.example.workers.dev',
			cache: cacheScopeSchema.parse({ kind: 'default' }),
			expected: 'https://cupboard.example.workers.dev/'
		},
		{
			name: 'uses the canonical path from a parsed base for the default cache',
			value: 'https://cupboard.example.workers.dev/t/acme/',
			cache: cacheScopeSchema.parse({ kind: 'default' }),
			expected: 'https://cupboard.example.workers.dev/t/acme'
		},
		{
			name: 'a named cache appends the cache path to a bare host',
			value: 'https://cupboard.example.workers.dev',
			cache: cacheScopeSchema.parse({
				kind: 'named',
				name: 'builds'
			}),
			expected: 'https://cupboard.example.workers.dev/cache/builds'
		},
		{
			name: 'a named cache preserves a tenant path prefix',
			value: 'https://cupboard.example.workers.dev/t/acme',
			cache: cacheScopeSchema.parse({
				kind: 'named',
				name: 'builds'
			}),
			expected: 'https://cupboard.example.workers.dev/t/acme/cache/builds'
		},
		{
			name: 'appends a named cache to the canonical path from a parsed base',
			value: 'https://cupboard.example.workers.dev/t/acme/',
			cache: cacheScopeSchema.parse({
				kind: 'named',
				name: 'builds'
			}),
			expected: 'https://cupboard.example.workers.dev/t/acme/cache/builds'
		},
		{
			name: 'cache access does not affect the URL',
			value: 'https://cupboard.example.workers.dev',
			cache: cacheScopeSchema.parse({
				kind: 'named',
				name: 'builds'
			}),
			expected: 'https://cupboard.example.workers.dev/cache/builds'
		},
		{
			name: 'a cache called private stays under the cache namespace',
			value: 'https://cupboard.example.workers.dev/t/acme',
			cache: cacheScopeSchema.parse({
				kind: 'named',
				name: 'private'
			}),
			expected: 'https://cupboard.example.workers.dev/t/acme/cache/private'
		}
	])('$name', ({ value, cache, expected }) => {
		expect(cacheUrl(base(value), cache).href).toBe(expected);
	});

	it('does not mutate the base URL', () => {
		const baseUrl = base('https://cupboard.example.workers.dev/t/acme');

		cacheUrl(
			baseUrl,
			cacheScopeSchema.parse({
				kind: 'named',
				name: 'builds'
			})
		).pathname = '/edited';

		expect(baseUrl.href).toBe('https://cupboard.example.workers.dev/t/acme');
	});
});

describe('parseTenantCacheUrl', () => {
	it.each([
		{
			name: 'a tenant URL selects the default cache',
			value: 'https://cupboard.example.workers.dev/t/acme',
			expected: {
				tenantUrl: 'https://cupboard.example.workers.dev/t/acme',
				cache: { kind: 'default' }
			}
		},
		{
			name: 'a trailing slash is canonicalised',
			value: 'https://cupboard.example.workers.dev/t/acme/',
			expected: {
				tenantUrl: 'https://cupboard.example.workers.dev/t/acme',
				cache: { kind: 'default' }
			}
		},
		{
			name: 'a named cache is separated from its tenant URL',
			value: 'https://cupboard.example.workers.dev/t/acme/cache/builds',
			expected: {
				tenantUrl: 'https://cupboard.example.workers.dev/t/acme',
				cache: { kind: 'named', name: 'builds' }
			}
		},
		{
			name: 'a deployment path prefix is preserved',
			value: 'https://example.test/cupboard/t/acme/cache/builds/',
			expected: {
				tenantUrl: 'https://example.test/cupboard/t/acme',
				cache: { kind: 'named', name: 'builds' }
			}
		}
	])('$name', ({ value, expected }) => {
		const parsed = parseTenantCacheUrl(new URL(value));

		expect({
			tenantUrl: parsed.tenantUrl.href,
			cache: parsed.cache
		}).toStrictEqual(expected);
	});

	it.each([
		'https://cupboard.example.workers.dev',
		'https://cupboard.example.workers.dev/t/acme/reuse/nightly',
		'https://cupboard.example.workers.dev/t/acme/archive/builds',
		'https://cupboard.example.workers.dev/t/acme/cache/builds/extra',
		'https://cupboard.example.workers.dev/t/acme/cache/%62uilds',
		'https://cupboard.example.workers.dev/t/acme/cache/%2F',
		'https://cupboard.example.workers.dev/t/%2F',
		'https://cupboard.example.workers.dev/t/acme?cache=builds'
	])('refuses the non-cache target %s', (value) => {
		expect(() => parseTenantCacheUrl(new URL(value))).toThrow(
			InvalidTenantCacheUrlError
		);
	});
});

describe('tenantUrl', () => {
	it.each([
		{
			name: 'appends the tenant path to a bare host',
			value: 'https://cupboard.example.workers.dev',
			tenant: 'acme',
			expected: 'https://cupboard.example.workers.dev/t/acme'
		},
		{
			name: 'appends to the canonical path from a parsed base',
			value: 'https://cupboard.example.workers.dev/',
			tenant: 'acme',
			expected: 'https://cupboard.example.workers.dev/t/acme'
		}
	])('$name', ({ value, tenant, expected }) => {
		expect(tenantUrl(base(value), tenant).href).toBe(expected);
	});

	it.each([[''], ['.'], ['..']])('refuses the tenant slug %j', (tenant) => {
		expect(() =>
			tenantUrl(base('https://cupboard.example.workers.dev'), tenant)
		).toThrow(InvalidCacheUrlSegmentError);
	});
});

describe('reuseViewUrl', () => {
	it.each([
		{
			name: 'appends the reuse view path to a bare host',
			value: 'https://cupboard.example.workers.dev',
			view: 'nightly',
			expected: 'https://cupboard.example.workers.dev/reuse/nightly'
		},
		{
			name: 'preserves a tenant path prefix',
			value: 'https://cupboard.example.workers.dev/t/acme',
			view: 'nightly',
			expected: 'https://cupboard.example.workers.dev/t/acme/reuse/nightly'
		}
	])('$name', ({ value, view, expected }) => {
		expect(reuseViewUrl(base(value), view).href).toBe(expected);
	});

	it.each([[''], ['.'], ['..']])('refuses the view name %j', (view) => {
		expect(() =>
			reuseViewUrl(base('https://cupboard.example.workers.dev'), view)
		).toThrow(InvalidCacheUrlSegmentError);
	});
});

describe('publicKeyUrl', () => {
	it.each([
		{
			name: 'appends the key path to a bare host',
			value: 'https://cupboard.example.workers.dev',
			expected: 'https://cupboard.example.workers.dev/pubkey'
		},
		{
			name: 'preserves a tenant path prefix',
			value: 'https://cupboard.example.workers.dev/t/acme',
			expected: 'https://cupboard.example.workers.dev/t/acme/pubkey'
		},
		{
			name: 'appends to the canonical path from a parsed base',
			value: 'https://cupboard.example.workers.dev/t/acme/',
			expected: 'https://cupboard.example.workers.dev/t/acme/pubkey'
		}
	])('$name', ({ value, expected }) => {
		expect(publicKeyUrl(base(value)).href).toBe(expected);
	});
});

describe('urlWithCredential', () => {
	const url = base('https://cupboard.example.workers.dev/t/acme');

	it.each([
		{
			name: 'a credential of unreserved characters',
			credential: { user: 'alice', password: 'correct-horse' },
			expected:
				'https://alice:correct-horse@cupboard.example.workers.dev/t/acme'
		},
		{
			name: 'a credential carrying userinfo delimiters',
			credential: { user: 'al:ice@x', password: 'p@ss word/' },
			expected:
				'https://al%3Aice%40x:p%40ss%20word%2F@cupboard.example.workers.dev/t/acme'
		},
		{
			name: 'a credential containing a percent sign',
			credential: { user: 'alice', password: '100%pure' },
			expected: 'https://alice:100%25pure@cupboard.example.workers.dev/t/acme'
		}
	])('escapes $name', ({ credential, expected }) => {
		const authenticated = urlWithCredential(url, credential);

		expect({
			href: authenticated.href,
			user: decodeURIComponent(authenticated.username),
			password: decodeURIComponent(authenticated.password)
		}).toStrictEqual({
			href: expected,
			user: credential.user,
			password: credential.password
		});
	});

	it('leaves the given URL unchanged', () => {
		urlWithCredential(url, { user: 'alice', password: 'secret' });

		expect(url.href).toBe('https://cupboard.example.workers.dev/t/acme');
	});
});
