import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOctokitClient } from './octokit.ts';

function countingFetch(status: number): {
	readonly fetch: typeof fetch;
	calls: () => number;
} {
	let calls = 0;

	return {
		fetch: () => {
			calls += 1;

			return Promise.resolve(
				new Response('{}', {
					status,
					headers: { 'content-type': 'application/json' }
				})
			);
		},
		calls: () => calls
	};
}

async function fetchCountFor(status: number): Promise<number> {
	const counter = countingFetch(status);
	const octokit = createOctokitClient({ request: { fetch: counter.fetch } });

	try {
		await octokit.request('GET /repos/{owner}/{repo}', {
			owner: 'o',
			repo: 'r'
		});
	} catch {
		// Ignore the expected response error; only the number of attempts matters.
	}

	return counter.calls();
}

describe('createOctokitClient', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it.each([
		['a rate-limit response', 429],
		['a forbidden response', 403],
		['a not-found response', 404],
		['a bad-request response', 400]
	])('fails fast on %s', async (_name, status) => {
		expect(await fetchCountFor(status)).toBe(1);
	});

	it('sends an explicitly selected REST API version', async () => {
		let headers: Headers | undefined;
		const octokit = createOctokitClient({
			apiVersion: '2026-03-10',
			request: {
				fetch: (input: string | URL | Request, init?: RequestInit) => {
					headers = new Request(input, init).headers;

					return Promise.resolve(Response.json({}));
				}
			}
		});

		await octokit.request('GET /repos/{owner}/{repo}', {
			owner: 'o',
			repo: 'r'
		});

		expect(headers?.get('x-github-api-version')).toBe('2026-03-10');
	});

	it('retries a transient server error', async () => {
		vi.useFakeTimers();

		const pending = fetchCountFor(500);
		await vi.runAllTimersAsync();

		expect(await pending).toBe(4);
	});
});
