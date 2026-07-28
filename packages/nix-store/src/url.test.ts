import { describe, expect, it } from 'vitest';

import { InvalidCacheUrlBaseError } from './errors.ts';
import { canonicalHref, parseBaseUrl } from './url.ts';

describe('parseBaseUrl', () => {
	it.each([
		['a bare host', 'https://cupboard.example.workers.dev', '/'],
		['a tenant path', 'https://cupboard.example.workers.dev/t/acme', '/t/acme'],
		['an http URL', 'http://localhost:8787/t/acme', '/t/acme'],
		[
			'redundant trailing slashes',
			'https://cupboard.example.workers.dev///',
			'/'
		],
		[
			'a trailing slash on a tenant path',
			'https://cupboard.example.workers.dev/t/acme///',
			'/t/acme'
		]
	])('accepts %s', (_name, value, pathname) => {
		expect(parseBaseUrl(new URL(value)).pathname).toBe(pathname);
	});

	// Every URL built from a base derives from its origin and path alone, so a
	// base smuggling anything else in, credentials that would be sent on every
	// request or a query or fragment that would corrupt the built URL, is
	// refused rather than partially honoured.
	it.each([
		['an FTP scheme', 'ftp://cupboard.example.workers.dev/t/acme'],
		['a file scheme', 'file:///tmp/cupboard'],
		['a mail scheme', 'mailto:cupboard@example.test'],
		['a query string', 'https://cupboard.example.workers.dev/t/acme?tab=keys'],
		['a fragment', 'https://cupboard.example.workers.dev/t/acme#copied'],
		['an embedded username', 'https://ci@cupboard.example.workers.dev/t/acme'],
		[
			'embedded credentials',
			'https://ci:secret@cupboard.example.workers.dev/t/acme'
		]
	])('refuses a base carrying %s', (_name, value) => {
		expect(() => parseBaseUrl(new URL(value))).toThrow(
			new InvalidCacheUrlBaseError()
		);
	});

	it('leaves the URL it was given untouched', () => {
		const url = new URL('https://cupboard.example.workers.dev/t/acme/');

		parseBaseUrl(url).pathname = '/edited';

		expect(url.href).toBe('https://cupboard.example.workers.dev/t/acme/');
	});
});

describe('canonicalHref', () => {
	it.each([
		[
			'a bare origin loses the slash `URL` adds',
			'https://cupboard.example.workers.dev',
			'https://cupboard.example.workers.dev'
		],
		[
			'a tenant path is rendered verbatim',
			'https://cupboard.example.workers.dev/t/acme',
			'https://cupboard.example.workers.dev/t/acme'
		],
		[
			'a trailing slash on a path is dropped',
			'https://cupboard.example.workers.dev/t/acme/',
			'https://cupboard.example.workers.dev/t/acme'
		],
		[
			'a port is kept',
			'http://localhost:8787/t/acme',
			'http://localhost:8787/t/acme'
		]
	])('%s', (_name, value, expected) => {
		expect(canonicalHref(new URL(value))).toBe(expected);
	});
});
