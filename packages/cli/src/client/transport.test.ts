import { describe, expect, it } from 'vitest';

import {
	InsecureWorkerUrlError,
	InvalidWorkerUrlBaseError,
	InvalidWorkerUrlError,
	UnreachableHostError
} from '../errors.ts';

import { parseWorkerUrl, reachableFetcher } from './transport.ts';

describe('parseWorkerUrl', () => {
	it.each([
		['a bare host', 'https://cupboard.example.workers.dev'],
		['a tenant path', 'https://cupboard.example.workers.dev/t/acme']
	])('accepts %s', (_name, value) => {
		expect(parseWorkerUrl(value).host).toBe('cupboard.example.workers.dev');
	});

	it.each([
		['a bare host', 'https://cupboard.example.workers.dev///', '/'],
		[
			'a tenant path',
			'https://cupboard.example.workers.dev/t/acme///',
			'/t/acme'
		]
	])('removes redundant trailing slashes from %s', (_name, value, pathname) => {
		expect(parseWorkerUrl(value).pathname).toBe(pathname);
	});

	it.each([
		['localhost', 'http://localhost:8787/t/acme'],
		['127.0.0.1', 'http://127.0.0.1:8787/t/acme'],
		['the IPv6 loopback address', 'http://[::1]:8787/t/acme']
	])('accepts plain HTTP to %s', (_name, value) => {
		expect(parseWorkerUrl(value).href).toBe(value);
	});

	it.each([
		['a public host', 'http://cupboard.example.workers.dev/t/acme'],
		[
			'a host that starts with localhost',
			'http://localhost.example.test/t/acme'
		],
		['a private address', 'http://10.0.0.1:8787/t/acme']
	])('rejects plain HTTP to %s', (_name, value) => {
		let thrown: unknown;

		try {
			parseWorkerUrl(value);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toStrictEqual(new InsecureWorkerUrlError(value));
	});

	it('rejects a malformed URL with a typed usage error', () => {
		expect(() => parseWorkerUrl('not a url')).toThrow(InvalidWorkerUrlError);
	});

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
	])('rejects %s in a Worker URL', (_name, value) => {
		expect(() => parseWorkerUrl(value)).toThrow(
			new InvalidWorkerUrlBaseError()
		);
	});
});

describe('reachableFetcher', () => {
	const ok = new Response('body');

	it('passes a successful response through unchanged', async () => {
		const fetcher = reachableFetcher(() => Promise.resolve(ok));

		expect(await fetcher('https://cupboard.example.workers.dev')).toBe(ok);
	});

	it('translates a rejected TypeError into a host-named unreachable error', async () => {
		const cause = new TypeError('fetch failed', {
			cause: Object.assign(
				new Error('getaddrinfo ENOTFOUND cupboard.example.workers.dev'),
				{ code: 'ENOTFOUND' }
			)
		});
		const fetcher = reachableFetcher(() => Promise.reject(cause));

		let error: unknown;
		try {
			await fetcher('https://cupboard.example.workers.dev/pubkey');
			error = 'resolved';
		} catch (error_: unknown) {
			error = error_;
		}

		expect(error).toBeInstanceOf(UnreachableHostError);

		if (error instanceof UnreachableHostError) {
			expect({ cause: error.cause, host: error.host }).toStrictEqual({
				cause,
				host: 'cupboard.example.workers.dev'
			});
		}
	});

	it('lets a non-network error propagate unchanged', async () => {
		const failure = new Error('boom');
		const fetcher = reachableFetcher(() => Promise.reject(failure));

		await expect(fetcher('https://cupboard.example.workers.dev')).rejects.toBe(
			failure
		);
	});
});
