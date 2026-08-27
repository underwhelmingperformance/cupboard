import { describe, expect, it } from 'vitest';

import { canonicalCacheRequest } from './cache-request.ts';

function headerSet(request: Request): Record<string, string> {
	return Object.fromEntries(request.headers);
}

describe('canonicalCacheRequest', () => {
	it('replaces query parameters and fragments with the key version', () => {
		const request = new Request(
			'https://cache.example/t/acme/abc.narinfo?token=one#part',
			{
				method: 'HEAD',
				headers: { 'if-none-match': '"abc"' }
			}
		);

		const canonical = canonicalCacheRequest(request);

		expect({
			url: canonical.url,
			method: canonical.method,
			ifNoneMatch: canonical.headers.get('if-none-match')
		}).toStrictEqual({
			url: 'https://cache.example/t/acme/abc.narinfo?cache-key-version=2',
			method: 'HEAD',
			ifNoneMatch: '"abc"'
		});
	});

	it('strips the reader credentials and keeps every other header', () => {
		const request = new Request(
			'https://cache.example/t/acme/abc.narinfo?token=one#part',
			{
				headers: {
					accept: 'text/x-nix-narinfo',
					authorization: `Basic ${btoa('alice:secret')}`,
					cookie: 'session=abc',
					'if-none-match': '"abc"',
					'user-agent': 'Nix/2.24.9'
				}
			}
		);

		const canonical = canonicalCacheRequest(request);

		expect({
			url: canonical.url,
			method: canonical.method,
			headers: headerSet(canonical)
		}).toStrictEqual({
			url: 'https://cache.example/t/acme/abc.narinfo?cache-key-version=2',
			method: 'GET',
			headers: {
				accept: 'text/x-nix-narinfo',
				'if-none-match': '"abc"',
				'user-agent': 'Nix/2.24.9'
			}
		});
	});
});
