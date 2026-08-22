import { describe, expect, it } from 'vitest';

import {
	maximumReleaseDiscoveryCandidates,
	maximumReleaseDiscoveryPageEntries,
	maximumReleaseDiscoveryPages,
	parseResolvedCupboard,
	resolveCupboard,
	type ResolvedCupboard,
	serialiseResolvedCupboard
} from './cupboard-resolution.ts';
import {
	CupboardResolutionJsonError,
	GithubApiError,
	GithubEndpointInvalidError,
	GithubEndpointOriginMismatchError,
	MalformedReleaseDiscoveryResponseError,
	WorkflowShaInvalidError
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
	])(
		'serialises and parses a $kind coordinate without changing it',
		(resolved) => {
			const json = serialiseResolvedCupboard(resolved);

			expect({ json, parsed: parseResolvedCupboard(json) }).toStrictEqual({
				json: JSON.stringify(resolved),
				parsed: resolved
			});
		}
	);

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
	it('rejects a workflow revision that is not a lowercase full commit ID', async () => {
		const run = resolveCupboard(options({ workflowSha: 'A'.repeat(40) }), {
			fetch: fetchingGraphql([])
		});

		await expect(run).rejects.toBeInstanceOf(WorkflowShaInvalidError);
	});

	it('resolves an explicit release through refs/tags when a branch has the same name', async () => {
		const requests: string[] = [];
		const fetcher: typeof fetch = (input) => {
			const url = requestUrl(input);
			requests.push(url);

			if (url.endsWith('/repos/owner/cupboard/releases/tags/production')) {
				return Promise.resolve(
					Response.json({ tag_name: 'production', assets: [] })
				);
			}

			if (url.endsWith('/repos/owner/cupboard/commits/tags%2Fproduction')) {
				return Promise.resolve(Response.json({ sha: otherSha }));
			}

			if (url.endsWith('/repos/owner/cupboard/commits/production')) {
				return Promise.resolve(Response.json({ sha: workflowSha }));
			}

			return Promise.resolve(new Response('not found', { status: 404 }));
		};

		await expect(
			resolveCupboard(options({ cupboardVersion: 'production' }), {
				fetch: fetcher
			})
		).resolves.toStrictEqual({
			kind: 'release',
			repository: 'owner/cupboard',
			tag: 'production',
			sourceCommit: otherSha
		});
		expect(requests).toStrictEqual([
			'https://api.github.com/repos/owner/cupboard/releases/tags/production',
			'https://api.github.com/repos/owner/cupboard/commits/tags%2Fproduction'
		]);
	});

	it('resolves an explicit release without using the reusable workflow ref', async () => {
		const requests: RequestRecord[] = [];
		const fetcher: typeof fetch = (input, init) => {
			const url = requestUrl(input);
			requests.push({ url, body: requestBody(init) });

			if (url.endsWith('/repos/owner/cupboard/releases/tags/1.2.3')) {
				return Promise.resolve(
					Response.json({ tag_name: '1.2.3', assets: [] })
				);
			}

			if (url.endsWith('/repos/owner/cupboard/commits/tags%2F1.2.3')) {
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
			tag: '1.2.3',
			sourceCommit: otherSha
		});
		expect(requests.map(({ url }) => url)).toStrictEqual([
			'https://github.example/api/v3/repos/owner/cupboard/releases/tags/1.2.3',
			'https://github.example/api/v3/repos/owner/cupboard/commits/tags%2F1.2.3'
		]);
	});

	it('retains the legacy v-prefix fallback when an unprefixed semver tag is absent', async () => {
		const requests: string[] = [];
		const fetcher: typeof fetch = (input) => {
			const url = requestUrl(input);
			requests.push(url);

			if (url.endsWith('/repos/owner/cupboard/releases/tags/1.2.3')) {
				return Promise.resolve(new Response('not found', { status: 404 }));
			}

			if (url.endsWith('/repos/owner/cupboard/releases/tags/v1.2.3')) {
				return Promise.resolve(
					Response.json({ tag_name: 'v1.2.3', assets: [] })
				);
			}

			if (url.endsWith('/repos/owner/cupboard/commits/tags%2Fv1.2.3')) {
				return Promise.resolve(Response.json({ sha: otherSha }));
			}

			return Promise.resolve(new Response('not found', { status: 404 }));
		};

		await expect(
			resolveCupboard(options({ cupboardVersion: '1.2.3' }), {
				fetch: fetcher
			})
		).resolves.toStrictEqual({
			kind: 'release',
			repository: 'owner/cupboard',
			tag: 'v1.2.3',
			sourceCommit: otherSha
		});
		expect(requests).toStrictEqual([
			'https://api.github.com/repos/owner/cupboard/releases/tags/1.2.3',
			'https://api.github.com/repos/owner/cupboard/releases/tags/v1.2.3',
			'https://api.github.com/repos/owner/cupboard/commits/tags%2Fv1.2.3'
		]);
	});

	it('resolves latest to the selected release tag and its commit', async () => {
		const fetcher: typeof fetch = (input) => {
			const url = requestUrl(input);

			if (url.endsWith('/repos/owner/cupboard/releases?page=1&per_page=100')) {
				return Promise.resolve(
					Response.json([
						{ draft: true, tag_name: 'draft', assets: [] },
						{ draft: false, tag_name: 'v2.0.0-rc.1', assets: [] }
					])
				);
			}

			if (url.endsWith('/repos/owner/cupboard/commits/tags%2Fv2.0.0-rc.1')) {
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

	it('rejects an oversized release page before processing its entries', async () => {
		let requests = 0;
		const nodes = Array.from(
			{ length: maximumReleaseDiscoveryPageEntries + 1 },
			(_, index) =>
				index === maximumReleaseDiscoveryPageEntries
					? { malformed: true }
					: releaseNode(`release-${String(index)}`, otherSha)
		);
		const releaseDiscoveryPage = (): Promise<unknown> => {
			requests += 1;

			return Promise.resolve(releasePage({ nodes }));
		};

		await expect(
			resolveCupboard(options(), { releaseDiscoveryPage })
		).rejects.toMatchObject({
			name: 'ReleaseDiscoverySearchTooLargeError',
			maximumPageEntries: maximumReleaseDiscoveryPageEntries,
			maximumCandidates: maximumReleaseDiscoveryCandidates,
			maximumPages: maximumReleaseDiscoveryPages,
			observedPageEntries: maximumReleaseDiscoveryPageEntries + 1,
			observedCandidates: maximumReleaseDiscoveryPageEntries + 1,
			observedPages: 1
		});
		expect(requests).toBe(1);
	});

	it('rejects too many release candidates before processing the excess page', async () => {
		let requests = 0;
		const releaseDiscoveryPage = (): Promise<unknown> => {
			requests += 1;
			const isExcessPage = requests === 11;
			const nodes = Array.from(
				{
					length: isExcessPage ? 1 : maximumReleaseDiscoveryPageEntries
				},
				(_, index) =>
					releaseNode(`release-${String(requests)}-${String(index)}`, otherSha)
			);

			return Promise.resolve(
				releasePage({
					nodes,
					hasNextPage: !isExcessPage,
					...(!isExcessPage && { endCursor: `page-${String(requests)}` })
				})
			);
		};

		await expect(
			resolveCupboard(options(), { releaseDiscoveryPage })
		).rejects.toMatchObject({
			name: 'ReleaseDiscoverySearchTooLargeError',
			maximumPageEntries: maximumReleaseDiscoveryPageEntries,
			maximumCandidates: maximumReleaseDiscoveryCandidates,
			maximumPages: maximumReleaseDiscoveryPages,
			observedPageEntries: 1,
			observedCandidates: maximumReleaseDiscoveryCandidates + 1,
			observedPages: 11
		});
		expect(requests).toBe(11);
	});

	it('rejects a continuing sparse cursor chain at the page ceiling', async () => {
		let requests = 0;
		const releaseDiscoveryPage = (): Promise<unknown> => {
			requests += 1;

			if (requests > maximumReleaseDiscoveryPages) {
				throw new Error('test page budget exceeded');
			}

			return Promise.resolve(
				releasePage({
					nodes: [],
					hasNextPage: true,
					endCursor: `page-${String(requests)}`
				})
			);
		};

		await expect(
			resolveCupboard(options(), { releaseDiscoveryPage })
		).rejects.toMatchObject({
			name: 'ReleaseDiscoverySearchTooLargeError',
			maximumPageEntries: maximumReleaseDiscoveryPageEntries,
			maximumCandidates: maximumReleaseDiscoveryCandidates,
			maximumPages: maximumReleaseDiscoveryPages,
			observedPageEntries: 0,
			observedCandidates: 0,
			observedPages: maximumReleaseDiscoveryPages
		});
		expect(requests).toBe(maximumReleaseDiscoveryPages);
	});

	it('accepts a release history exactly at the candidate limit', async () => {
		let requests = 0;
		const releaseDiscoveryPage = (): Promise<unknown> => {
			requests += 1;
			const isLastPage = requests === 10;
			const nodes = Array.from(
				{ length: maximumReleaseDiscoveryPageEntries },
				(_, index) =>
					releaseNode(
						`release-${String(requests)}-${String(index)}`,
						isLastPage && index === 0 ? workflowSha : otherSha
					)
			);

			return Promise.resolve(
				releasePage({
					nodes,
					hasNextPage: !isLastPage,
					...(!isLastPage && { endCursor: `page-${String(requests)}` })
				})
			);
		};

		await expect(
			resolveCupboard(options(), { releaseDiscoveryPage })
		).resolves.toStrictEqual({
			kind: 'release',
			repository: 'owner/cupboard',
			tag: 'release-10-0',
			sourceCommit: workflowSha
		});
		expect(requests).toBe(10);
	});

	it('ignores a release whose tag no longer resolves to a commit', async () => {
		const nodes = [
			{
				tagName: 'deleted-tag',
				isDraft: false,
				tagCommit: new URLSearchParams().get('missing-tag')
			},
			releaseNode('production', workflowSha)
		];

		await expect(
			resolveCupboard(options(), { fetch: fetchingGraphql(nodes) })
		).resolves.toStrictEqual({
			kind: 'release',
			repository: 'owner/cupboard',
			tag: 'production',
			sourceCommit: workflowSha
		});
	});

	it('ignores null release nodes in a valid GraphQL connection', async () => {
		const nodes = [
			new URLSearchParams().get('missing-release'),
			releaseNode('production', workflowSha)
		];

		await expect(
			resolveCupboard(options(), { fetch: fetchingGraphql(nodes) })
		).resolves.toStrictEqual({
			kind: 'release',
			repository: 'owner/cupboard',
			tag: 'production',
			sourceCommit: workflowSha
		});
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

	it('orders fallback release tags by UTF-16 code unit', async () => {
		const nodes = [
			releaseNode('a-release', workflowSha),
			releaseNode('_release', workflowSha),
			releaseNode('A-release', workflowSha)
		];

		await expect(
			resolveCupboard(options(), { fetch: fetchingGraphql(nodes) })
		).resolves.toStrictEqual({
			kind: 'release',
			repository: 'owner/cupboard',
			tag: 'A-release',
			sourceCommit: workflowSha
		});
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

	it('rejects a GraphQL error returned with HTTP 200', async () => {
		const failure = resolveCupboard(options(), {
			fetch: () =>
				Promise.resolve(
					Response.json({
						data: new URLSearchParams().get('missing-data'),
						errors: [
							{
								type: 'FORBIDDEN',
								message: 'Resource not accessible by integration'
							}
						]
					})
				)
		});

		await expect(failure).rejects.toStrictEqual(
			expect.objectContaining({
				name: 'GithubApiError',
				message:
					'failed to discover cupboard releases: FORBIDDEN: Resource not accessible by integration',
				cause: [
					{
						type: 'FORBIDDEN',
						message: 'Resource not accessible by integration'
					}
				]
			})
		);
	});

	it('uses an explicitly supplied GraphQL endpoint', async () => {
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

	it('derives the GHES GraphQL endpoint from its REST API base', async () => {
		const urls: string[] = [];
		const fetcher: typeof fetch = (input) => {
			urls.push(requestUrl(input));

			return Promise.resolve(Response.json(releasePage({ nodes: [] })));
		};

		await resolveCupboard(
			options({ githubApiUrl: 'https://github.example/api/v3' }),
			{
				fetch: fetcher
			}
		);

		expect(urls).toStrictEqual(['https://github.example/api/graphql']);
	});

	it.each([
		{
			name: 'cross-origin GraphQL',
			githubApiUrl: 'https://github.example/api/v3',
			githubGraphqlUrl: 'https://attacker.example/api/graphql',
			errorType: GithubEndpointOriginMismatchError
		},
		{
			name: 'insecure REST',
			githubApiUrl: 'http://github.example/api/v3',
			githubGraphqlUrl: 'http://github.example/api/graphql',
			errorType: GithubEndpointInvalidError
		},
		{
			name: 'credential-bearing REST',
			githubApiUrl: 'https://token@github.example/api/v3',
			githubGraphqlUrl: 'https://github.example/api/graphql',
			errorType: GithubEndpointInvalidError
		},
		{
			name: 'fragment-bearing REST',
			githubApiUrl: 'https://github.example/api/v3#unsafe',
			githubGraphqlUrl: 'https://github.example/api/graphql',
			errorType: GithubEndpointInvalidError
		},
		{
			name: 'insecure GraphQL',
			githubApiUrl: 'https://github.example/api/v3',
			githubGraphqlUrl: 'http://github.example/api/graphql',
			errorType: GithubEndpointInvalidError
		},
		{
			name: 'credential-bearing GraphQL',
			githubApiUrl: 'https://github.example/api/v3',
			githubGraphqlUrl: 'https://token@github.example/api/graphql',
			errorType: GithubEndpointInvalidError
		},
		{
			name: 'fragment-bearing GraphQL',
			githubApiUrl: 'https://github.example/api/v3',
			githubGraphqlUrl: 'https://github.example/api/graphql#unsafe',
			errorType: GithubEndpointInvalidError
		}
	])(
		'rejects a $name endpoint before sending credentials',
		async (testCase) => {
			let requests = 0;
			const fetcher: typeof fetch = () => {
				requests += 1;

				return Promise.resolve(responseFor([]));
			};
			const resolution = resolveCupboard(
				options({
					githubApiUrl: testCase.githubApiUrl,
					githubGraphqlUrl: testCase.githubGraphqlUrl
				}),
				{ fetch: fetcher }
			);

			await expect(resolution).rejects.toBeInstanceOf(testCase.errorType);
			expect(requests).toBe(0);
		}
	);
});
