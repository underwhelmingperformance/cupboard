import { describe, expect, it } from 'vitest';

import { GithubTokenMissingError } from '../../errors.ts';

import {
	githubToken,
	requireGithubToken,
	variablesClient
} from './variables.ts';

interface RecordedRequest {
	readonly method: string;
	readonly url: string;
	readonly body?: unknown;
}

function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === 'string') {
		return input;
	}

	if (input instanceof URL) {
		return input.href;
	}

	return input.url;
}

// A fetch that records every request and answers from the given responder,
// standing in for the GitHub API without a network.
function recordingFetch(
	requests: RecordedRequest[],
	respond: (request: RecordedRequest) => Response
): typeof fetch {
	return (input, init) => {
		const request: RecordedRequest = {
			method: init?.method ?? 'GET',
			url: requestUrl(input),
			...(typeof init?.body === 'string' && {
				body: JSON.parse(init.body) as unknown
			})
		};

		requests.push(request);

		return Promise.resolve(respond(request));
	};
}

const variableUrl =
	'https://api.github.com/repos/acme/app/actions/variables/CUPBOARD_URL';
const collectionUrl = 'https://api.github.com/repos/acme/app/actions/variables';

describe('githubToken', () => {
	it('prefers GH_TOKEN, falls back to GITHUB_TOKEN, and treats empty as unset', () => {
		expect({
			preferred: githubToken({ GH_TOKEN: 'a', GITHUB_TOKEN: 'b' }),
			fallback: githubToken({ GITHUB_TOKEN: 'b' }),
			emptyFallsThrough: githubToken({ GH_TOKEN: '', GITHUB_TOKEN: 'b' }),
			unset: githubToken({})
		}).toStrictEqual({
			preferred: 'a',
			fallback: 'b',
			emptyFallsThrough: 'b',
			unset: undefined
		});
	});

	it('requireGithubToken rejects an environment without a token', () => {
		expect(() => requireGithubToken({})).toThrow(GithubTokenMissingError);
	});
});

describe('variablesClient', () => {
	it('updates an existing variable in place', async () => {
		const requests: RecordedRequest[] = [];
		const client = variablesClient('token', {
			fetch: recordingFetch(requests, () => new Response(undefined))
		});

		await client.set('acme/app', 'CUPBOARD_URL', 'https://cupboard.example');

		expect(requests).toStrictEqual([
			{
				method: 'PATCH',
				url: variableUrl,
				body: { value: 'https://cupboard.example' }
			}
		]);
	});

	it('creates the variable when the update finds none', async () => {
		const requests: RecordedRequest[] = [];
		const client = variablesClient('token', {
			fetch: recordingFetch(requests, (request) =>
				request.method === 'PATCH'
					? new Response(undefined, { status: 404 })
					: new Response(undefined, { status: 201 })
			)
		});

		await client.set('acme/app', 'CUPBOARD_URL', 'https://cupboard.example');

		expect(requests).toStrictEqual([
			{
				method: 'PATCH',
				url: variableUrl,
				body: { value: 'https://cupboard.example' }
			},
			{
				method: 'POST',
				url: collectionUrl,
				body: { name: 'CUPBOARD_URL', value: 'https://cupboard.example' }
			}
		]);
	});

	it('reads a stored variable and answers undefined for one not set', async () => {
		const client = variablesClient('token', {
			fetch: recordingFetch([], (request) =>
				request.url === variableUrl
					? Response.json({ name: 'CUPBOARD_URL', value: 'stored' })
					: new Response(undefined, { status: 404 })
			)
		});

		expect({
			stored: await client.read('acme/app', 'CUPBOARD_URL'),
			unset: await client.read('acme/app', 'CUPBOARD_RUNNERS')
		}).toStrictEqual({ stored: 'stored', unset: undefined });
	});
});
