import { describe, expect, it } from 'vitest';

import { InvalidCacheUrlBaseError } from './errors.ts';
import { canonicalHref, isHttpsOrLoopbackHttp, parseBaseUrl } from './url.ts';

describe('parseBaseUrl', () => {
	it.each([
		[
			'normalises a bare host to the root path',
			'https://cupboard.example.workers.dev',
			'/'
		],
		[
			'preserves a tenant path',
			'https://cupboard.example.workers.dev/t/acme',
			'/t/acme'
		],
		['accepts an HTTP URL', 'http://localhost:8787/t/acme', '/t/acme'],
		[
			'collapses redundant trailing slashes to the root path',
			'https://cupboard.example.workers.dev///',
			'/'
		],
		[
			'removes trailing slashes from a tenant path',
			'https://cupboard.example.workers.dev/t/acme///',
			'/t/acme'
		]
	])('%s', (_name, value, pathname) => {
		expect(parseBaseUrl(new URL(value)).pathname).toBe(pathname);
	});

	it.each([
		['rejects an FTP URL', 'ftp://cupboard.example.workers.dev/t/acme'],
		['rejects a file URL', 'file:///tmp/cupboard'],
		['rejects a mailto URL', 'mailto:cupboard@example.test'],
		[
			'rejects a base URL with a query',
			'https://cupboard.example.workers.dev/t/acme?tab=keys'
		],
		[
			'rejects a base URL with a fragment',
			'https://cupboard.example.workers.dev/t/acme#copied'
		],
		[
			'rejects a base URL with a username',
			'https://ci@cupboard.example.workers.dev/t/acme'
		],
		[
			'rejects a base URL with credentials',
			'https://ci:secret@cupboard.example.workers.dev/t/acme'
		]
	])('%s', (_name, value) => {
		expect(() => parseBaseUrl(new URL(value))).toThrow(
			new InvalidCacheUrlBaseError()
		);
	});

	it('does not mutate the input URL', () => {
		const url = new URL('https://cupboard.example.workers.dev/t/acme/');

		parseBaseUrl(url).pathname = '/edited';

		expect(url.href).toBe('https://cupboard.example.workers.dev/t/acme/');
	});
});

describe('canonicalHref', () => {
	it.each([
		[
			'removes the slash URL adds to a bare origin',
			'https://cupboard.example.workers.dev',
			'https://cupboard.example.workers.dev'
		],
		[
			'preserves a tenant path exactly',
			'https://cupboard.example.workers.dev/t/acme',
			'https://cupboard.example.workers.dev/t/acme'
		],
		[
			'removes a trailing slash from a path',
			'https://cupboard.example.workers.dev/t/acme/',
			'https://cupboard.example.workers.dev/t/acme'
		],
		[
			'preserves an explicit port',
			'http://localhost:8787/t/acme',
			'http://localhost:8787/t/acme'
		]
	])('%s', (_name, value, expected) => {
		expect(canonicalHref(new URL(value))).toBe(expected);
	});
});

describe('isHttpsOrLoopbackHttp', () => {
	it.each([
		{
			name: 'an HTTPS URL',
			value: 'https://cupboard.example.workers.dev',
			allowed: true
		},
		{
			name: 'HTTP to localhost',
			value: 'http://localhost:8787',
			allowed: true
		},
		{
			name: 'HTTP to 127.0.0.1',
			value: 'http://127.0.0.1:8787',
			allowed: true
		},
		{
			name: 'HTTP to the IPv6 loopback',
			value: 'http://[::1]:8787',
			allowed: true
		},
		{
			name: 'HTTP to a public host',
			value: 'http://cupboard.example.workers.dev',
			allowed: false
		},
		{
			name: 'HTTP to a host that starts with localhost',
			value: 'http://localhost.example.test',
			allowed: false
		},
		{
			name: 'HTTP to another loopback address',
			value: 'http://127.0.0.2:8787',
			allowed: false
		},
		{ name: 'an FTP URL', value: 'ftp://localhost', allowed: false }
	])('returns $allowed for $name', ({ value, allowed }) => {
		expect(isHttpsOrLoopbackHttp(new URL(value))).toBe(allowed);
	});
});
