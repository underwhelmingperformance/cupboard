import { describe, expect, it } from 'vitest';

import { canonicalCacheRequest } from './cache-request.ts';

describe('canonicalCacheRequest', () => {
	it('removes query parameters and fragments without changing the request', () => {
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
			url: 'https://cache.example/t/acme/abc.narinfo',
			method: 'HEAD',
			ifNoneMatch: '"abc"'
		});
	});
});
