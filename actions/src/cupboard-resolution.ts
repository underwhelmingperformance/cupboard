import { createOctokitClient, RequestError } from '@cupboard/shared/octokit';
import { z } from 'zod';

import {
	AmbiguousReleaseForCommitError,
	CupboardResolutionJsonError,
	GithubApiError,
	InvalidInputError,
	MalformedReleaseDiscoveryResponseError,
	MalformedReleaseResponseError
} from './errors.ts';
import {
	fetchRelease,
	fetchTagCommit,
	normaliseVersion,
	splitRepository
} from './release-install.ts';

const commitSchema = z
	.string()
	.regex(/^[\da-f]{40}$/u, 'must be a lowercase, full Git commit id');
const repositorySchema = z
	.string()
	.regex(/^[\w.-]+\/[\w.-]+$/u, 'must be an owner/name repository');
const tagSchema = z
	.string()
	.min(1)
	.refine((tag) => tag.trim() === tag, {
		message: 'must not have leading or trailing whitespace'
	});

const resolvedReleaseSchema = z.strictObject({
	kind: z.literal('release'),
	repository: repositorySchema,
	tag: tagSchema,
	sourceCommit: commitSchema
});

const resolvedSourceSchema = z.strictObject({
	kind: z.literal('source'),
	repository: repositorySchema,
	sourceCommit: commitSchema
});

/** The one canonical coordinate every downstream acquisition path consumes. */
export const resolvedCupboardSchema = z.discriminatedUnion('kind', [
	resolvedReleaseSchema,
	resolvedSourceSchema
]);

export type ResolvedCupboard = z.infer<typeof resolvedCupboardSchema>;

export interface ResolveCupboardOptions {
	/** An explicit published release tag or `latest`; blank resolves from the workflow. */
	readonly cupboardVersion?: string;
	/** Whether an explicit `latest` may select a prerelease. */
	readonly includePrereleases: boolean;
	readonly releaseRepository: string;
	readonly githubToken: string;
	readonly workflowSha: string;
	readonly workflowRef: string;
	/** REST root such as GitHub Enterprise's `https://host/api/v3`. */
	readonly githubApiUrl?: string;
	/** Exact GraphQL endpoint supplied by the Actions `github.graphql_url` context. */
	readonly githubGraphqlUrl?: string;
}

export interface ResolveCupboardDependencies {
	readonly fetch?: typeof fetch;
}

interface ReleaseAtCommit {
	readonly tag: string;
	readonly sourceCommit: string;
}

const releaseNodeSchema = z.strictObject({
	tagName: tagSchema,
	isDraft: z.boolean(),
	tagCommit: z
		.strictObject({ oid: commitSchema })
		.nullable()
		.transform((value) => value ?? undefined)
});

const releasePageInfoSchema = z.strictObject({
	hasNextPage: z.boolean(),
	endCursor: z
		.string()
		.min(1)
		.nullable()
		.transform((value) => value ?? undefined)
});

const releaseConnectionSchema = z.strictObject({
	nodes: z
		.array(releaseNodeSchema.nullable().transform((node) => node ?? undefined))
		.transform((nodes) =>
			nodes.flatMap((node) => (node === undefined ? [] : [node]))
		),
	pageInfo: releasePageInfoSchema
});

const releaseRepositorySchema = z.strictObject({
	releases: releaseConnectionSchema
});

const releasePageSchema = z.strictObject({
	data: z.strictObject({
		repository: releaseRepositorySchema
	})
});

const graphqlErrorSchema = z.looseObject({
	message: z.string().min(1),
	type: z.string().min(1).optional()
});
const graphqlFailureSchema = z.looseObject({
	errors: z.array(graphqlErrorSchema).min(1)
});

const releaseDiscoveryQuery = `
query CupboardReleases($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    releases(first: 100, after: $cursor, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        tagName
        isDraft
        tagCommit {
          oid
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}`;

const publicGraphqlUrl = 'https://api.github.com/graphql';

/** Encode a validated canonical coordinate for transport through a job output. */
export function serialiseResolvedCupboard(resolved: ResolvedCupboard): string {
	return JSON.stringify(resolvedCupboardSchema.parse(resolved));
}

/** Decode a job output without accepting unknown fields or noncanonical values. */
export function parseResolvedCupboard(value: string): ResolvedCupboard {
	try {
		return resolvedCupboardSchema.parse(JSON.parse(value) as unknown);
	} catch (error) {
		throw new CupboardResolutionJsonError(error);
	}
}

/**
 * Resolve caller input and reusable-workflow identity into one exact release or
 * source coordinate. No unresolved `latest` or implicit selection crosses this
 * boundary.
 */
export async function resolveCupboard(
	options: ResolveCupboardOptions,
	dependencies: ResolveCupboardDependencies = {}
): Promise<ResolvedCupboard> {
	const [owner, name] = splitRepository(options.releaseRepository);
	const providedVersion = nonBlank(options.cupboardVersion);
	const client = createOctokitClient({
		...(options.githubToken !== '' && { auth: options.githubToken }),
		...(options.githubApiUrl !== undefined && {
			baseUrl: options.githubApiUrl
		}),
		...(dependencies.fetch !== undefined && {
			request: { fetch: dependencies.fetch }
		})
	});

	if (providedVersion !== undefined) {
		const version = normaliseVersion(providedVersion);
		let release;
		let sourceCommit;

		try {
			release = await fetchRelease(client, {
				releaseRepository: options.releaseRepository,
				version,
				includePrereleases: options.includePrereleases
			});
			sourceCommit = await fetchTagCommit(client, owner, name, release.tagName);
		} catch (error) {
			if (error instanceof RequestError) {
				throw new GithubApiError('failed to resolve the cupboard release', {
					status: error.status,
					cause: error
				});
			}

			throw error;
		}

		const parsed = resolvedCupboardSchema.safeParse({
			kind: 'release',
			repository: options.releaseRepository,
			tag: release.tagName,
			sourceCommit
		});

		if (!parsed.success) {
			throw new MalformedReleaseResponseError({ cause: parsed.error });
		}

		return parsed.data;
	}

	const workflowSha = canonicalWorkflowSha(options.workflowSha);
	const releases = await releasesAtCommit(client, {
		owner,
		name,
		repository: options.releaseRepository,
		workflowSha,
		workflowReference: options.workflowRef,
		graphqlUrl: options.githubGraphqlUrl ?? publicGraphqlUrl
	});

	if (releases.length === 0) {
		return {
			kind: 'source',
			repository: options.releaseRepository,
			sourceCommit: workflowSha
		};
	}

	const [release] = releases;

	if (release === undefined) {
		throw new MalformedReleaseDiscoveryResponseError();
	}

	return {
		kind: 'release',
		repository: options.releaseRepository,
		tag: release.tag,
		sourceCommit: release.sourceCommit
	};
}

function nonBlank(value: string | undefined): string | undefined {
	const trimmed = value?.trim();

	return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function canonicalWorkflowSha(value: string): string {
	const parsed = commitSchema.safeParse(value);

	if (!parsed.success) {
		throw new InvalidInputError(
			'workflow-sha',
			'workflow-sha must be a lowercase, full 40-character Git commit id'
		);
	}

	return parsed.data;
}

interface ReleaseDiscoveryOptions {
	readonly owner: string;
	readonly name: string;
	readonly repository: string;
	readonly workflowSha: string;
	readonly workflowReference: string;
	readonly graphqlUrl: string;
}

type Octokit = ReturnType<typeof createOctokitClient>;

async function releasesAtCommit(
	client: Octokit,
	options: ReleaseDiscoveryOptions
): Promise<readonly ReleaseAtCommit[]> {
	let cursor = new URLSearchParams().get('cursor');
	const visitedCursors = new Set<string>();
	const matches = new Map<string, ReleaseAtCommit>();

	for (;;) {
		const page = await fetchReleasePage(client, options, cursor);

		collectMatchingReleases(
			matches,
			page.data.repository.releases.nodes,
			options.workflowSha
		);

		const { hasNextPage, endCursor } = page.data.repository.releases.pageInfo;

		if (!hasNextPage) {
			break;
		}

		if (endCursor === undefined || visitedCursors.has(endCursor)) {
			throw new MalformedReleaseDiscoveryResponseError();
		}

		visitedCursors.add(endCursor);
		cursor = endCursor;
	}

	const releases = matches
		.values()
		.toArray()
		.toSorted((left, right) => left.tag.localeCompare(right.tag));

	if (releases.length <= 1) {
		return releases;
	}

	const workflowTag = workflowTagFor(
		options.workflowReference,
		options.repository
	);
	const selected = releases.find((release) => release.tag === workflowTag);

	if (selected !== undefined) {
		return [selected];
	}

	throw new AmbiguousReleaseForCommitError(
		options.repository,
		options.workflowSha,
		releases.map((release) => release.tag)
	);
}

function collectMatchingReleases(
	matches: Map<string, ReleaseAtCommit>,
	releases: readonly z.infer<typeof releaseNodeSchema>[],
	workflowSha: string
): void {
	for (const release of releases) {
		if (release.isDraft || release.tagCommit?.oid !== workflowSha) {
			continue;
		}

		const existing = matches.get(release.tagName);

		if (
			existing !== undefined &&
			existing.sourceCommit !== release.tagCommit.oid
		) {
			throw new MalformedReleaseDiscoveryResponseError();
		}

		matches.set(release.tagName, {
			tag: release.tagName,
			sourceCommit: release.tagCommit.oid
		});
	}
}

async function fetchReleasePage(
	client: Octokit,
	options: ReleaseDiscoveryOptions,
	cursor: string | null
): Promise<z.infer<typeof releasePageSchema>> {
	let response: Awaited<ReturnType<Octokit['request']>>;

	try {
		response = await client.request(`POST ${options.graphqlUrl}`, {
			query: releaseDiscoveryQuery,
			variables: {
				owner: options.owner,
				name: options.name,
				cursor
			}
		});
	} catch (error) {
		throw new GithubApiError('failed to discover cupboard releases', {
			status: error instanceof RequestError ? error.status : undefined,
			cause: error
		});
	}

	const failure = graphqlFailureSchema.safeParse(response.data);

	if (failure.success) {
		const detail = failure.data.errors
			.map((error) =>
				error.type === undefined
					? error.message
					: `${error.type}: ${error.message}`
			)
			.join('; ');

		throw new GithubApiError('failed to discover cupboard releases', {
			detail,
			cause: failure.data.errors
		});
	}

	const parsed = releasePageSchema.safeParse(response.data);

	if (!parsed.success) {
		throw new MalformedReleaseDiscoveryResponseError({ cause: parsed.error });
	}

	return parsed.data;
}

function workflowTagFor(
	workflowReference: string,
	releaseRepository: string
): string | undefined {
	const repositoryPrefix = `${releaseRepository}/.github/workflows/`;

	if (!workflowReference.startsWith(repositoryPrefix)) {
		return undefined;
	}

	const marker = '@refs/tags/';
	const markerIndex = workflowReference.lastIndexOf(marker);

	if (markerIndex === -1) {
		return undefined;
	}

	return nonBlank(workflowReference.slice(markerIndex + marker.length));
}
