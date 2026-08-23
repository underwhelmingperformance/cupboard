import { describe, expect, it } from 'vitest';

import { InvalidCacheUrlBaseError } from './errors.ts';
import { canonicalHref, parseBaseUrl } from './url.ts';

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
