import { describe, expect, it } from 'vitest';

import {
	parseResolvedCupboard,
	resolveCupboard,
	type ResolvedCupboard,
	serialiseResolvedCupboard
} from './cupboard-resolution.ts';
import {
	AmbiguousReleaseForCommitError,
	CupboardResolutionJsonError,
	GithubApiError,
	MalformedReleaseDiscoveryResponseError
} from './errors.ts';

const workflowSha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);

interface RequestRecord {
	readonly url: string;
	readonly body: unknown;
}

function requestUrl(input: string | URL | Request): string {
	if (typeof input === 'string') {
		return input;
	}

	if (input instanceof URL) {
		return input.href;
	}

	return input.url;
}

function requestBody(init: RequestInit | undefined): unknown {
	if (typeof init?.body !== 'string') {
		return undefined;
	}

	return JSON.parse(init.body) as unknown;
}

function releasePage(options: {
	readonly nodes: readonly unknown[];
	readonly hasNextPage?: boolean;
	readonly endCursor?: string | null;
}): unknown {
	return {
		data: {
			repository: {
				releases: {
					nodes: options.nodes,
					pageInfo: {
						hasNextPage: options.hasNextPage ?? false,
						endCursor:
							options.endCursor ?? new URLSearchParams().get('missing-cursor')
					}
				}
			}
		}
	};
}

function responseFor(
	nodes: readonly unknown[],
	options: Omit<Parameters<typeof releasePage>[0], 'nodes'> = {}
): Response {
	return Response.json(releasePage({ nodes, ...options }));
}

function fetchingGraphql(nodes: readonly unknown[]): typeof fetch {
	return () => Promise.resolve(responseFor(nodes));
}

function graphqlRequestShape(record: RequestRecord): {
	readonly url: string;
	readonly queryIncludesPageSize: boolean;
	readonly variables: unknown;
} {
	if (typeof record.body !== 'object' || record.body === null) {
		throw new Error('expected a GraphQL request body');
	}

	const { query, variables } = record.body as Record<string, unknown>;

	return {
		url: record.url,
		queryIncludesPageSize:
			typeof query === 'string' && query.includes('releases(first: 100'),
		variables
	};
}

function releaseNode(
	tagName: string,
	commit: string,
	isDraft = false
): unknown {
	return { tagName, isDraft, tagCommit: { oid: commit } };
}

function options(
	overrides: Partial<Parameters<typeof resolveCupboard>[0]> = {}
): Parameters<typeof resolveCupboard>[0] {
	return {
		includePrereleases: true,
		releaseRepository: 'owner/cupboard',
		githubToken: 'token',
		workflowSha,
		workflowRef:
			'owner/cupboard/.github/workflows/cupboard-publish.yml@refs/heads/main',
		...overrides
	};
}

describe('resolved cupboard JSON', () => {
	it.each<ResolvedCupboard>([
		{
			kind: 'release',
			repository: 'owner/cupboard',
			tag: 'v1.2.3',
			sourceCommit: workflowSha
		},
		{
			kind: 'source',
			repository: 'owner/cupboard',
			sourceCommit: workflowSha
		}
	])('round trips $kind coordinates in canonical form', (resolved) => {
		const json = serialiseResolvedCupboard(resolved);

		expect({ json, parsed: parseResolvedCupboard(json) }).toStrictEqual({
			json: JSON.stringify(resolved),
			parsed: resolved
		});
	});

	it.each([
		JSON.stringify({
			kind: 'source',
			repository: 'owner/cupboard',
			sourceCommit: workflowSha,
			extra: true
		}),
		JSON.stringify({
			kind: 'source',
			repository: 'owner/cupboard',
			sourceCommit: workflowSha.toUpperCase()
		}),
		'{'
	])('rejects noncanonical JSON %s', (json) => {
		expect(() => parseResolvedCupboard(json)).toThrow(
			CupboardResolutionJsonError
		);
	});
});

describe('resolveCupboard', () => {
	it('canonicalises an explicit exact version independently of the workflow ref', async () => {
		const requests: RequestRecord[] = [];
		const fetcher: typeof fetch = (input, init) => {
			const url = requestUrl(input);
			requests.push({ url, body: requestBody(init) });

			if (url.endsWith('/repos/owner/cupboard/releases/tags/v1.2.3')) {
				return Promise.resolve(
					Response.json({ tag_name: 'v1.2.3', assets: [] })
				);
			}

			if (url.endsWith('/repos/owner/cupboard/commits/v1.2.3')) {
				return Promise.resolve(Response.json({ sha: otherSha }));
			}

			return Promise.resolve(new Response('not found', { status: 404 }));
		};

		await expect(
			resolveCupboard(
				options({
					cupboardVersion: '1.2.3',
					githubApiUrl: 'https://github.example/api/v3',
					workflowRef:
						'owner/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v9.9.9'
				}),
				{ fetch: fetcher }
			)
		).resolves.toStrictEqual({
			kind: 'release',
			repository: 'owner/cupboard',
			tag: 'v1.2.3',
			sourceCommit: otherSha
		});
		expect(requests.map(({ url }) => url)).toStrictEqual([
			'https://github.example/api/v3/repos/owner/cupboard/releases/tags/v1.2.3',
			'https://github.example/api/v3/repos/owner/cupboard/commits/v1.2.3'
		]);
	});

	it('canonicalises explicit latest to the exact release and commit', async () => {
		const fetcher: typeof fetch = (input) => {
			const url = requestUrl(input);

			if (url.endsWith('/repos/owner/cupboard/releases?per_page=20')) {
				return Promise.resolve(
					Response.json([
						{ draft: true, tag_name: 'draft', assets: [] },
						{ draft: false, tag_name: 'v2.0.0-rc.1', assets: [] }
					])
				);
			}

			if (url.endsWith('/repos/owner/cupboard/commits/v2.0.0-rc.1')) {
				return Promise.resolve(Response.json({ sha: otherSha }));
			}

			return Promise.resolve(new Response('not found', { status: 404 }));
		};

		await expect(
			resolveCupboard(options({ cupboardVersion: 'latest' }), {
				fetch: fetcher
			})
		).resolves.toStrictEqual({
			kind: 'release',
			repository: 'owner/cupboard',
			tag: 'v2.0.0-rc.1',
			sourceCommit: otherSha
		});
	});

	it('searches every release page and accepts any published tag at the workflow SHA', async () => {
		const requests: RequestRecord[] = [];
		const fetcher: typeof fetch = (input, init) => {
			requests.push({
				url: requestUrl(input),
				body: requestBody(init)
			});

			const nodes =
				requests.length === 1
					? [
							releaseNode('draft-at-sha', workflowSha, true),
							releaseNode('other', otherSha)
						]
					: [releaseNode('production', workflowSha)];

			return Promise.resolve(
				responseFor(nodes, {
					hasNextPage: requests.length === 1,
					...(requests.length === 1 && { endCursor: 'next' })
				})
			);
		};

		await expect(
			resolveCupboard(options(), { fetch: fetcher })
		).resolves.toStrictEqual({
			kind: 'release',
			repository: 'owner/cupboard',
			tag: 'production',
			sourceCommit: workflowSha
		});
		expect(
			requests.map((request) => graphqlRequestShape(request))
		).toStrictEqual([
			{
				url: 'https://api.github.com/graphql',
				queryIncludesPageSize: true,
				variables: {
					owner: 'owner',
					name: 'cupboard',
					cursor: new URLSearchParams().get('missing-cursor')
				}
			},
			{
				url: 'https://api.github.com/graphql',
				queryIncludesPageSize: true,
				variables: {
					owner: 'owner',
					name: 'cupboard',
					cursor: 'next'
				}
			}
		]);
	});

	it('falls back to the exact workflow source when no release matches', async () => {
		const nodes = [releaseNode('other', otherSha)];

		await expect(
			resolveCupboard(options(), { fetch: fetchingGraphql(nodes) })
		).resolves.toStrictEqual({
			kind: 'source',
			repository: 'owner/cupboard',
			sourceCommit: workflowSha
		});
	});

	it('uses the exact workflow tag to disambiguate releases at one commit', async () => {
		const nodes = [
			releaseNode('stable', workflowSha),
			releaseNode('channel/one', workflowSha)
		];

		await expect(
			resolveCupboard(
				options({
					workflowRef:
						'owner/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/channel/one'
				}),
				{ fetch: fetchingGraphql(nodes) }
			)
		).resolves.toStrictEqual({
			kind: 'release',
			repository: 'owner/cupboard',
			tag: 'channel/one',
			sourceCommit: workflowSha
		});
	});

	it('fails closed when several releases at the SHA remain ambiguous', async () => {
		const nodes = [
			releaseNode('one', workflowSha),
			releaseNode('two', workflowSha)
		];

		await expect(
			resolveCupboard(options(), { fetch: fetchingGraphql(nodes) })
		).rejects.toThrow(AmbiguousReleaseForCommitError);
	});

	it('fails closed on an unexpected GraphQL response', async () => {
		const malformed = {
			data: { repository: new URLSearchParams().get('none') }
		};

		await expect(
			resolveCupboard(options(), {
				fetch: () => Promise.resolve(Response.json(malformed))
			})
		).rejects.toThrow(MalformedReleaseDiscoveryResponseError);
	});

	it('wraps a failed GraphQL request as a GitHub API error', async () => {
		await expect(
			resolveCupboard(options(), {
				fetch: () =>
					Promise.resolve(new Response('unavailable', { status: 503 }))
			})
		).rejects.toThrow(GithubApiError);
	});

	it('uses the explicit GHES GraphQL endpoint', async () => {
		const urls: string[] = [];
		const fetcher: typeof fetch = (input) => {
			urls.push(requestUrl(input));

			return Promise.resolve(Response.json(releasePage({ nodes: [] })));
		};

		await resolveCupboard(
			options({
				githubApiUrl: 'https://github.example/api/v3',
				githubGraphqlUrl: 'https://github.example/api/graphql'
			}),
			{ fetch: fetcher }
		);

		expect(urls).toStrictEqual(['https://github.example/api/graphql']);
	});
});
