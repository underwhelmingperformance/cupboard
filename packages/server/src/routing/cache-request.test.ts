import { firstCacheGeneration } from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import {
	type CacheLifecycleVersion,
	firstCacheReadRevision,
	secondCacheGeneration,
	secondCacheReadRevision
} from '../db/cache-generation.ts';

import {
	cacheRequestVersion,
	canonicalCacheRequest,
	hasCurrentCacheKeyVersion
} from './cache-request.ts';

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
			url: 'https://cache.example/t/acme/abc.narinfo?cache-key-version=4&cache-generation=1&cache-read-revision=1',
			method: 'HEAD',
			ifNoneMatch: '"abc"'
		});
	});

	it('uses the same content key for different request and trace identifiers', () => {
		const requests = ['first', 'second'].map((value) =>
			canonicalCacheRequest(
				new Request('https://cache.example/t/acme/abc.narinfo', {
					headers: {
						'x-request-id': value,
						'x-cupboard-client-trace-id': value,
						traceparent: value
					}
				}),
				firstVersion
			)
		);

		expect(requests.map((request) => request.url)).toStrictEqual([
			'https://cache.example/t/acme/abc.narinfo?cache-key-version=4&cache-generation=1&cache-read-revision=1',
			'https://cache.example/t/acme/abc.narinfo?cache-key-version=4&cache-generation=1&cache-read-revision=1'
		]);
	});

	it('keys a deleted and recreated cache apart from its previous incarnation', () => {
		const request = new Request('https://cache.example/t/acme/abc.narinfo');

		expect(
			canonicalCacheRequest(request, {
				generation: secondCacheGeneration,
				readRevision: secondCacheReadRevision
			}).url
		).toStrictEqual(
			'https://cache.example/t/acme/abc.narinfo?cache-key-version=4&cache-generation=2&cache-read-revision=2'
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
			url: 'https://cache.example/t/acme/abc.narinfo?cache-key-version=4&cache-generation=1&cache-read-revision=1',
			method: 'GET',
			headers: {
				accept: 'text/x-nix-narinfo',
				'if-none-match': '"abc"',
				'user-agent': 'Nix/2.24.9'
			}
		});
	});
});

describe('cache key versions', () => {
	// A narinfo key changed when narinfo bodies gained a deadline, so a fill that
	// an earlier Worker left stalled cannot be joined. A NAR key did not.
	it.each([
		{ path: '/t/acme/abc.narinfo', version: '4' },
		{ path: '/t/acme/cache/builds/abc.narinfo', version: '4' },
		{ path: '/t/acme/abc%2Enarinfo', version: '4' },
		{ path: '/t/acme/abc%2enar%69nfo', version: '4' },
		{ path: '/t/acme/nar/abc.nar.zst', version: '3' }
	])('keys $path with version $version', ({ path, version }) => {
		const canonical = canonicalCacheRequest(
			new Request(`https://cache.example${path}`),
			firstVersion
		);
		const earlier = new URL(canonical.url);
		earlier.searchParams.set('cache-key-version', String(Number(version) - 1));

		expect({
			version: new URL(canonical.url).searchParams.get('cache-key-version'),
			isCurrent: hasCurrentCacheKeyVersion(canonical),
			isEarlierCurrent: hasCurrentCacheKeyVersion(new Request(earlier))
		}).toStrictEqual({ version, isCurrent: true, isEarlierCurrent: false });
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
	])('reads no version from a request with $scenario', ({ search }) => {
		expect(cacheRequestVersion(new Request(`${url}${search}`))).toBeUndefined();
	});
});
