import { describe, expect, it } from 'vitest';

import { InvalidWorkerUrlError, UnreachableHostError } from '../errors.ts';

import { parseWorkerUrl, reachableFetcher } from './transport.ts';

describe('parseWorkerUrl', () => {
	it('parses a valid URL', () => {
		expect(parseWorkerUrl('https://cupboard.example.workers.dev').host).toBe(
			'cupboard.example.workers.dev'
		);
	});

	it('rejects a malformed URL with a typed usage error', () => {
		expect(() => parseWorkerUrl('not a url')).toThrow(InvalidWorkerUrlError);
	});
});

describe('reachableFetcher', () => {
	const ok = new Response('body');

	it('passes a successful response through unchanged', async () => {
		const fetcher = reachableFetcher(() => Promise.resolve(ok));

		expect(await fetcher('https://cupboard.example.workers.dev')).toBe(ok);
	});

	it('turns a network failure into a host-named unreachable error', async () => {
		const cause = new TypeError('fetch failed', {
			cause: new Error('getaddrinfo ENOTFOUND cupboard.example.workers.dev')
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
