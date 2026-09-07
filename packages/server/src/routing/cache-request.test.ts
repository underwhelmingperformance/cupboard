import { describe, expect, it } from 'vitest';

import {
	type CacheLifecycleVersion,
	firstCacheGeneration,
	firstCacheReadRevision,
	secondCacheGeneration,
	secondCacheReadRevision
} from '../db/cache-generation.ts';

import { cacheRequestVersion, canonicalCacheRequest } from './cache-request.ts';

const firstVersion: CacheLifecycleVersion = {
	generation: firstCacheGeneration,
	readRevision: firstCacheReadRevision
};

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

		const canonical = canonicalCacheRequest(request, firstVersion);

		expect({
			url: canonical.url,
			method: canonical.method,
			ifNoneMatch: canonical.headers.get('if-none-match')
		}).toStrictEqual({
			url: 'https://cache.example/t/acme/abc.narinfo?cache-key-version=2&cache-generation=1&cache-read-revision=1',
			method: 'HEAD',
			ifNoneMatch: '"abc"'
		});
	});

	it('keys a deleted and recreated cache apart from its previous incarnation', () => {
		const request = new Request('https://cache.example/t/acme/abc.narinfo');

		expect(
			canonicalCacheRequest(request, {
				generation: secondCacheGeneration,
				readRevision: secondCacheReadRevision
			}).url
		).toStrictEqual(
			'https://cache.example/t/acme/abc.narinfo?cache-key-version=2&cache-generation=2&cache-read-revision=2'
		);
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

		const canonical = canonicalCacheRequest(request, firstVersion);

		expect({
			url: canonical.url,
			method: canonical.method,
			headers: headerSet(canonical)
		}).toStrictEqual({
			url: 'https://cache.example/t/acme/abc.narinfo?cache-key-version=2&cache-generation=1&cache-read-revision=1',
			method: 'GET',
			headers: {
				accept: 'text/x-nix-narinfo',
				'if-none-match': '"abc"',
				'user-agent': 'Nix/2.24.9'
			}
		});
	});
});

describe('cacheRequestVersion', () => {
	const url = 'https://cache.example/t/acme/abc.narinfo';

	it('reads back the version the canonical request carries', () => {
		const version = {
			generation: secondCacheGeneration,
			readRevision: secondCacheReadRevision
		};

		const canonical = canonicalCacheRequest(new Request(url), version);

		expect(cacheRequestVersion(canonical)).toStrictEqual(version);
	});

	it.each([
		{ scenario: 'neither parameter', search: '' },
		{ scenario: 'no read revision', search: '?cache-generation=2' },
		{ scenario: 'no generation', search: '?cache-read-revision=2' },
		{
			scenario: 'a generation below the first',
			search: '?cache-generation=0&cache-read-revision=1'
		},
		{
			scenario: 'a generation that is not a number',
			search: '?cache-generation=two&cache-read-revision=1'
		}
	])('refuses a request with $scenario', ({ search }) => {
		expect(cacheRequestVersion(new Request(`${url}${search}`))).toBeUndefined();
	});
});
