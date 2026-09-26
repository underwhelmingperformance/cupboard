import { readFile } from 'node:fs/promises';

import { capturingReporter } from '@cupboard/cli-ui/testing';
import {
	CacheInfo,
	servedStoreDirectory
} from '@cupboard/nix-store/cache-info';
import { cachePrioritySchema } from '@cupboard/nix-store/scalars';
import { cacheListResponseSchema } from '@cupboard/protocol/caches';
import {
	oidcTrustListResponseSchema,
	oidcTrustSummarySchema
} from '@cupboard/protocol/oidc';
import {
	reuseViewListResponseSchema,
	type ReuseViewSummary,
	reuseViewSummarySchema
} from '@cupboard/protocol/reuse-views';
import type { ResultPayload, ResultRow } from '@cupboard/reporter';
import { expect, it } from 'vitest';

import {
	WorkflowReferenceMutableError,
	WorkflowReferenceNotFoundError
} from '../../errors.ts';
import { githubBranchAddBody, githubPrAddBody } from '../oidc-trust.ts';
import {
	buildAddBody,
	buildCacheGrant,
	jobWorkflowReferenceClaim
} from '../oidc-trust/rule-builder.ts';

import { type GithubCheckClient } from './check.ts';
import {
	type DiscoveredGithubCheckDependencies,
	DiscoveryUnverifiedFinding,
	inspectDiscoveredGithubCheck,
	SharedPullRequestCacheFinding,
	WorkflowPinFailedFinding
} from './discovered-check.ts';
import { type WorkflowSource } from './discovery.ts';
import {
	PassedCheckFinding,
	ReuseViewMissingFinding,
	ReuseViewPriorityInsufficientFinding,
	RootGrantPrefixUnverifiedFinding
} from './finding.ts';
import {
	CustomReuseViewFinding,
	ForkPullRequestFinding,
	PublicationUnmodelledFinding,
	ReferenceFilterExcludesFinding
} from './publication.ts';
import {
	RepositoryTrustRuleMissingFinding,
	TrustRuleClaimMismatchFinding
} from './trust-selection.ts';

const tenant = new URL('https://cupboard.supply/t/laney');
const repository = 'iainlane/dotfiles';
const path = '.github/workflows/publish.yml';
const workflow = `
on:
  push:
    branches: [main]
jobs:
  packages:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      cache: packages
  systems:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.36
    with:
      url: https://cupboard.supply/t/laney
      cache: systems
`;

const source: WorkflowSource = {
	resolveBranch: () => Promise.resolve('a'.repeat(40)),
	list: () => Promise.resolve([path]),
	read: () => Promise.resolve(workflow)
};

function fixture(
	options: {
		readonly rules?: readonly unknown[];
		readonly views?: readonly ReuseViewSummary[];
		readonly dependencies?: Partial<DiscoveredGithubCheckDependencies>;
	} = {}
): {
	readonly client: GithubCheckClient;
	readonly dependencies: DiscoveredGithubCheckDependencies;
} {
	return {
		client: {
			caches: {
				list: () =>
					Promise.resolve(cacheListResponseSchema.parse({ caches: [] }))
			},
			reuseViews: {
				list: () =>
					Promise.resolve(
						reuseViewListResponseSchema.parse({ views: options.views ?? [] })
					)
			},
			oidcTrust: {
				list: () =>
					Promise.resolve(
						oidcTrustListResponseSchema.parse({ rules: options.rules ?? [] })
					)
			}
		},
		dependencies: defaultDependencies(options.dependencies)
	};
}

function defaultDependencies(
	overrides: Partial<DiscoveredGithubCheckDependencies> = {}
): DiscoveredGithubCheckDependencies {
	return {
		source,
		lookupRepository: () =>
			Promise.resolve({
				repositoryId: 1234,
				repositoryOwnerId: 5678,
				fullName: repository,
				defaultBranch: 'main'
			}),
		verifyWorkflowReference: () => Promise.resolve(),
		fetchCacheInfo: () =>
			Promise.reject(new Error('unexpected cache-info read')),
		...overrides
	};
}

function expectedRuleLines(audience: string): ResultRow[] {
	return String.raw`issuer: https://token.actions.githubusercontent.com
audience: ${audience}
claims:
  repository_id: "1234"
  repository_owner_id: "5678"
  ref: refs/heads/main
  job_workflow_ref:
    pattern: ^underwhelmingperformance/cupboard/\.github/workflows/cupboard-flake-publish\.yml@refs/tags/v[^/]*$
permittedGrants:
  - type: cupboard_wildcard`
		.split('\n')
		.map((value) => ({ label: '', value }));
}

it('reports every matching publishing job', async () => {
	const results: ResultRow[][] = [];
	const { client, dependencies } = fixture();
	const result = await inspectDiscoveredGithubCheck(
		tenant,
		{ repo: repository, branch: 'main' },
		capturingReporter(results),
		client,
		dependencies
	);

	expect({ jobs: result.jobs, rows: results }).toStrictEqual({
		jobs: [
			{
				caller: path,
				job: 'packages',
				workflowRef:
					'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.35',
				status: 'failed',
				findings: [
					{
						trigger: 'push',
						finding: new RepositoryTrustRuleMissingFinding('trust rule')
					}
				]
			},
			{
				caller: path,
				job: 'systems',
				workflowRef:
					'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.36',
				status: 'failed',
				findings: [
					{
						trigger: 'push',
						finding: new RepositoryTrustRuleMissingFinding('trust rule')
					}
				]
			}
		],
		rows: [
			[
				{
					label: 'Workflow revision',
					value: `${repository}@${'a'.repeat(40)}`
				},
				{
					label: `${path}, packages`,
					value: 'failed: push: no rule pins this repository'
				},
				{
					label: `${path}, systems`,
					value: 'failed: push: no rule pins this repository'
				}
			]
		]
	});
});

it('checks a proposed schedule and notes when it will start running', async () => {
	const results: ResultRow[][] = [];
	const rule = oidcTrustSummarySchema.parse({
		id: 'schedule-rule',
		issuer: 'https://token.actions.githubusercontent.com',
		audience: tenant.href,
		claims: { repository_id: '1234', ref: 'refs/heads/main' },
		permittedGrants: [buildCacheGrant({ allow: ['push', 'attest'] })],
		disabled: false
	});
	const result = await inspectDiscoveredGithubCheck(
		tenant,
		{ repo: repository, branch: 'feature/add-schedule' },
		capturingReporter(results),
		fixture({ rules: [rule] }).client,
		defaultDependencies({
			source: {
				resolveBranch: () => Promise.resolve('a'.repeat(40)),
				list: () => Promise.resolve([path]),
				read: () =>
					Promise.resolve(`
on: schedule
jobs:
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
`)
			}
		})
	);

	expect({
		jobs: result.jobs,
		scheduleNote: result.scheduleNote,
		rows: results
	}).toStrictEqual({
		jobs: [
			{
				caller: path,
				job: 'publish',
				workflowRef:
					'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.35',
				status: 'ready',
				findings: [
					{
						trigger: 'schedule',
						finding: new PassedCheckFinding('trust rule')
					},
					{
						trigger: 'schedule',
						finding: new PassedCheckFinding('root grant')
					}
				]
			}
		],
		scheduleNote:
			'GitHub runs schedules from the default branch main. Schedule changes on feature/add-schedule take effect after feature/add-schedule is merged into main.',
		rows: [
			[
				{
					label: 'Workflow revision',
					value: `${repository}@${'a'.repeat(40)}`
				},
				{ label: `${path}, publish`, value: 'ready' },
				{
					label: 'Schedule',
					value:
						'GitHub runs schedules from the default branch main. Schedule changes on feature/add-schedule take effect after feature/add-schedule is merged into main.'
				}
			]
		]
	});
});

it('notes when a preset push is checked for the default branch', async () => {
	const results: ResultRow[][] = [];
	const { client, dependencies } = fixture({
		dependencies: {
			source: {
				resolveBranch: () => Promise.resolve('a'.repeat(40)),
				list: () => Promise.resolve([path]),
				read: () =>
					Promise.resolve(`
on:
  push:
    branches: [main]
jobs:
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      preset: pull-request-and-branch
`)
			}
		}
	});
	const result = await inspectDiscoveredGithubCheck(
		tenant,
		{ repo: repository, branch: 'feature/add-push' },
		capturingReporter(results),
		client,
		dependencies
	);

	expect({
		branchNote: result.branchNote,
		rows: results[0]?.filter((row) => row.label === 'Branch')
	}).toStrictEqual({
		branchNote:
			"The check models the preset's push and manual runs on the default branch main, using the workflow files from feature/add-push. Changes on feature/add-push take effect after feature/add-push is merged into main.",
		rows: [
			{
				label: 'Branch',
				value:
					"The check models the preset's push and manual runs on the default branch main, using the workflow files from feature/add-push. Changes on feature/add-push take effect after feature/add-push is merged into main."
			}
		]
	});
});

it('shows structured candidate rules when a dynamic push input prevents verification', async () => {
	const reference =
		'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v0.0.35';
	const matching = oidcTrustSummarySchema.parse({
		id: 'matching',
		issuer: 'https://token.actions.githubusercontent.com',
		audience: tenant.href,
		claims: {
			repository_id: '1234',
			repository_owner_id: '5678',
			ref: 'refs/heads/main',
			job_workflow_ref: jobWorkflowReferenceClaim(
				'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v*'
			)
		},
		permittedGrants: [{ type: 'cupboard_wildcard' }],
		disabled: false
	});
	const otherAudience = oidcTrustSummarySchema.parse({
		...matching,
		id: 'other-audience',
		audience: 'https://elsewhere.test'
	});
	const rules = [
		matching,
		{ ...matching, id: 'disabled', disabled: true },
		{
			...matching,
			id: 'other-repository',
			claims: { ...matching.claims, repository_id: '9999' }
		},
		{
			...matching,
			id: 'other-subject',
			claims: { sub: 'repo:someone/else:ref:refs/heads/main' }
		},
		{
			...matching,
			id: 'other-workflow',
			claims: { ...matching.claims, job_workflow_ref: 'other/workflow@v1' }
		},
		otherAudience
	];
	const results: ResultPayload[] = [];
	const reporter = {
		...capturingReporter([]),
		result: (payload: ResultPayload) => {
			results.push(payload);
		}
	};
	const result = await inspectDiscoveredGithubCheck(
		tenant,
		{ repo: repository, branch: 'main' },
		reporter,
		fixture({ rules }).client,
		defaultDependencies({
			source: {
				...source,
				read: () =>
					Promise.resolve(`
on:
  push:
    branches: [main]
jobs:
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      preset: pull-request-and-branch
      push: \${{ inputs.push }}
`)
			}
		})
	);
	expect({ jobs: result.jobs, rules: results.at(1) }).toStrictEqual({
		jobs: [
			{
				caller: path,
				job: 'publish',
				workflowRef: reference,
				status: 'unverified',
				findings: [
					{
						finding: new DiscoveryUnverifiedFinding(
							'the push input is dynamic, so the check cannot determine whether this job publishes'
						)
					}
				]
			}
		],
		rules: {
			kind: 'github-check-trust-rules',
			data: [matching, otherAudience],
			rows: [
				{
					label: 'Note',
					value:
						'Active GitHub rules that match this repository and the workflow references of the unverified jobs. The check cannot determine whether the unverified jobs publish or whether these rules authorise a run.'
				},
				{
					label: 'Rule 1',
					value: 'matching'
				},
				...expectedRuleLines(tenant.href),
				{ label: '', value: '' },
				{
					label: 'Rule 2',
					value: 'other-audience'
				},
				...expectedRuleLines('https://elsewhere.test')
			]
		}
	});
});

it('reports an invalid cache input as unverified', async () => {
	const result = await inspectDiscoveredGithubCheck(
		tenant,
		{ repo: repository, branch: 'main' },
		capturingReporter([]),
		fixture().client,
		defaultDependencies({
			source: {
				...source,
				read: () =>
					Promise.resolve(`
on:
  push:
    branches: [main]
jobs:
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      cache: Not_Valid!
`)
			}
		})
	);

	expect(result.jobs).toStrictEqual([
		{
			caller: path,
			job: 'publish',
			workflowRef:
				'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.35',
			status: 'unverified',
			findings: [
				{
					finding: new PublicationUnmodelledFinding(
						"cache 'Not_Valid!' is invalid"
					)
				}
			]
		}
	]);
});

it('reports a missing custom reuse view', async () => {
	const content = `
on:
  push:
    branches: [main]
jobs:
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      root-prefix: packages
      reuse-view: shared
`;
	const result = await inspectDiscoveredGithubCheck(
		tenant,
		{ repo: repository, branch: 'main' },
		capturingReporter([]),
		fixture().client,
		defaultDependencies({
			source: { ...source, read: () => Promise.resolve(content) }
		})
	);

	expect(result.jobs).toStrictEqual([
		{
			caller: path,
			job: 'publish',
			workflowRef:
				'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v0.0.35',
			status: 'failed',
			findings: [
				{ finding: new CustomReuseViewFinding('shared') },
				{
					trigger: 'push',
					finding: new RepositoryTrustRuleMissingFinding('trust rule')
				},
				{
					trigger: 'push',
					finding: new ReuseViewMissingFinding('reuse view', 'shared')
				}
			]
		}
	]);
});

it("compares a reuse view with the job's named destination cache", async () => {
	const content = `
on:
  push:
    branches: [main]
jobs:
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      cache: packages
      root-prefix: builds
      reuse-view: shared
`;
	const view = reuseViewSummarySchema.parse({
		name: 'shared',
		access: 'public',
		selectors: [{ kind: 'prefix', prefix: 'gh-' }],
		priority: 70,
		revision: 1,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z'
	});
	const result = await inspectDiscoveredGithubCheck(
		tenant,
		{ repo: repository, branch: 'main' },
		capturingReporter([]),
		fixture({ views: [view] }).client,
		defaultDependencies({
			source: { ...source, read: () => Promise.resolve(content) },
			fetchCacheInfo: (url) => {
				const priority = url.pathname.includes('/cache/packages')
					? 80
					: url.pathname.includes('/reuse/shared')
						? 70
						: 50;

				return Promise.resolve(
					new CacheInfo(
						servedStoreDirectory,
						true,
						cachePrioritySchema.parse(priority)
					)
				);
			}
		})
	);

	expect(result.jobs).toStrictEqual([
		{
			caller: path,
			job: 'publish',
			workflowRef:
				'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v0.0.35',
			status: 'failed',
			findings: [
				{ finding: new CustomReuseViewFinding('shared') },
				{
					trigger: 'push',
					finding: new RepositoryTrustRuleMissingFinding('trust rule')
				},
				{
					trigger: 'push',
					finding: new ReuseViewPriorityInsufficientFinding(
						'reuse view',
						cachePrioritySchema.parse(70),
						cachePrioritySchema.parse(80)
					)
				}
			]
		}
	]);
});

it.each([
	{ pin: 'v0.0.35', hint: '' },
	{
		pin: 'develop',
		hint: "; if 'develop' is a branch, use an immutable release tag or full commit ID"
	},
	{
		pin: 'main',
		hint: "; if 'main' is a branch, use an immutable release tag or full commit ID"
	}
])(
	'fails a job whose workflow release is missing at $pin',
	async ({ pin, hint }) => {
		const reference = `underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/${pin}`;
		const failure = new WorkflowReferenceNotFoundError(reference);
		const detail = `GitHub could not find a published release or workflow file for the discovered reference '${reference}'; check the workflow path and pin${hint}`;
		const results: ResultRow[][] = [];
		const result = await inspectDiscoveredGithubCheck(
			tenant,
			{ repo: repository, branch: 'main' },
			capturingReporter(results),
			fixture().client,
			defaultDependencies({
				source: {
					resolveBranch: () => Promise.resolve('a'.repeat(40)),
					list: () => Promise.resolve([path]),
					read: () =>
						Promise.resolve(`
on:
  push:
    branches: [main]
jobs:
  packages:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@${pin}
    with:
      url: https://cupboard.supply/t/laney
`)
				},
				verifyWorkflowReference: () => Promise.reject(failure)
			})
		);

		expect({ jobs: result.jobs, rows: results }).toStrictEqual({
			jobs: [
				{
					caller: path,
					job: 'packages',
					workflowRef: reference,
					status: 'failed',
					findings: [{ finding: new WorkflowPinFailedFinding(failure) }]
				}
			],
			rows: [
				[
					{
						label: 'Workflow revision',
						value: `${repository}@${'a'.repeat(40)}`
					},
					{
						label: `${path}, packages`,
						value: `failed: ${detail}`
					}
				]
			]
		});
	}
);

it('does not treat an exact root grant as permission for every published root', async () => {
	const reference =
		'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.35';
	const body = buildAddBody({
		issuer: 'https://token.actions.githubusercontent.com',
		audience: tenant.href,
		claims: {
			repository_id: '1234',
			repository_owner_id: '5678',
			ref: 'refs/heads/main',
			job_workflow_ref: reference
		},
		permittedGrants: [
			buildCacheGrant({
				cache: 'packages',
				root: 'github:iainlane/dotfiles/main/x86_64-linux',
				allow: ['push', 'attest', 'root']
			})
		]
	});
	const rule = oidcTrustSummarySchema.parse({
		...body,
		id: 'exact-root',
		disabled: false
	});
	const result = await inspectDiscoveredGithubCheck(
		tenant,
		{ repo: repository, branch: 'main' },
		capturingReporter([]),
		fixture({ rules: [rule] }).client,
		defaultDependencies({
			source: {
				resolveBranch: () => Promise.resolve('a'.repeat(40)),
				list: () => Promise.resolve([path]),
				read: () =>
					Promise.resolve(`
on:
  push:
    branches: [main]
jobs:
  packages:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      cache: packages
      root: github:iainlane/dotfiles/main
`)
			}
		})
	);

	expect(result.jobs).toStrictEqual([
		{
			caller: path,
			job: 'packages',
			workflowRef: reference,
			status: 'unverified',
			findings: [
				{ trigger: 'push', finding: new PassedCheckFinding('trust rule') },
				{
					trigger: 'push',
					finding: new RootGrantPrefixUnverifiedFinding(
						'root grant',
						'github:iainlane/dotfiles/main/x86_64-linux'
					)
				}
			]
		}
	]);
});

it('does not accept a branch rule for a tag-only publishing workflow', async () => {
	const reference =
		'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.35';
	const rule = oidcTrustSummarySchema.parse({
		id: 'main-branch',
		issuer: 'https://token.actions.githubusercontent.com',
		audience: tenant.href,
		claims: {
			repository_id: '1234',
			ref: 'refs/heads/main',
			job_workflow_ref: reference
		},
		permittedGrants: [{ type: 'cupboard_wildcard' }],
		disabled: false
	});
	const result = await inspectDiscoveredGithubCheck(
		tenant,
		{ repo: repository, branch: 'main' },
		capturingReporter([]),
		fixture({ rules: [rule] }).client,
		defaultDependencies({
			source: {
				...source,
				read: () =>
					Promise.resolve(`
on:
  push:
    tags: ['v*']
jobs:
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
`)
			}
		})
	);

	expect(result.jobs).toStrictEqual([
		{
			caller: path,
			job: 'publish',
			workflowRef: reference,
			status: 'failed',
			findings: [
				{
					trigger: 'push',
					finding: new TrustRuleClaimMismatchFinding(
						'trust rule',
						{
							id: rule.id,
							issuer: rule.issuer,
							audience: rule.audience,
							claims: rule.claims,
							permittedGrants: rule.permittedGrants
						},
						{
							claim: 'ref',
							expected: 'refs/heads/main',
							presented: 'refs/tags/v0'
						}
					)
				}
			]
		}
	]);
});

it('reports a branch filter that excludes the selected branch as unverified', async () => {
	const result = await inspectDiscoveredGithubCheck(
		tenant,
		{ repo: repository, branch: 'main' },
		capturingReporter([]),
		fixture().client,
		defaultDependencies({
			source: {
				...source,
				read: () =>
					Promise.resolve(`
on:
  push:
    branches: [release]
jobs:
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
`)
			}
		})
	);

	expect(result.jobs).toStrictEqual([
		{
			caller: path,
			job: 'publish',
			workflowRef:
				'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.35',
			status: 'unverified',
			findings: [
				{
					trigger: 'push',
					finding: new ReferenceFilterExcludesFinding(
						'branches',
						['release'],
						'main',
						'select-branch'
					)
				}
			]
		}
	]);
});

it('omits candidate rules when the repository has no publishing job', async () => {
	const results: ResultPayload[] = [];
	const reporter = {
		...capturingReporter([]),
		result: (payload: ResultPayload) => {
			results.push(payload);
		}
	};

	await inspectDiscoveredGithubCheck(
		tenant,
		{ repo: repository, branch: 'main' },
		reporter,
		fixture().client,
		defaultDependencies({
			source: {
				...source,
				read: () =>
					Promise.resolve(`
on:
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`)
			}
		})
	);

	expect(results.map((payload) => payload.kind)).toStrictEqual([
		'github-check-discovered'
	]);
});

it('compares the pull-request view with a named destination cache', async () => {
	const view = reuseViewSummarySchema.parse({
		name: 'pull-requests-1234',
		access: 'public',
		selectors: [{ kind: 'prefix', prefix: 'gh-1234-pr-' }],
		priority: 70,
		revision: 1,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z'
	});
	const result = await inspectDiscoveredGithubCheck(
		tenant,
		{ repo: repository, branch: 'main' },
		capturingReporter([]),
		fixture({ views: [view] }).client,
		defaultDependencies({
			source: {
				...source,
				read: () =>
					Promise.resolve(`
on:
  push:
    branches: [main]
jobs:
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      cache: packages
      root-prefix: builds
      reuse-view: pull-requests-1234
`)
			},
			fetchCacheInfo: (url) => {
				const priority = url.pathname.includes('/cache/packages')
					? 80
					: url.pathname.includes('/reuse/')
						? 70
						: 50;

				return Promise.resolve(
					new CacheInfo(
						servedStoreDirectory,
						true,
						cachePrioritySchema.parse(priority)
					)
				);
			}
		})
	);

	expect(result.jobs.map((job) => job.findings.at(-1))).toStrictEqual([
		{
			trigger: 'push',
			finding: new ReuseViewPriorityInsufficientFinding(
				'reuse view',
				cachePrioritySchema.parse(70),
				cachePrioritySchema.parse(80)
			)
		}
	]);
});

it('reads the repository before its workflows and defaults to its default branch', async () => {
	const calls: string[] = [];
	const result = await inspectDiscoveredGithubCheck(
		tenant,
		{ repo: repository },
		capturingReporter([]),
		fixture().client,
		defaultDependencies({
			lookupRepository: () => {
				calls.push('lookup');

				return Promise.resolve({
					repositoryId: 1234,
					repositoryOwnerId: 5678,
					fullName: repository,
					defaultBranch: 'trunk'
				});
			},
			source: {
				...source,
				resolveBranch: (_repository, branch) => {
					calls.push(`branch ${branch}`);

					return Promise.resolve('a'.repeat(40));
				}
			}
		})
	);

	expect({ calls, branch: result.branch }).toStrictEqual({
		calls: ['lookup', 'branch trunk'],
		branch: 'trunk'
	});
});

it.each([
	{
		pin: 'refs/heads/main',
		detail:
			"the discovered reference 'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/heads/main' pins a branch, which can move; use an immutable release tag or full commit ID"
	},
	{
		pin: 'refs/tags/v0.0.35',
		detail:
			"the discovered reference 'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.35' pins the tag v0.0.35, and GitHub does not report its release as immutable; use an immutable release tag or full commit ID"
	}
])(
	'reports a mutable pin at $pin as a failed workflow reference',
	async ({ pin, detail }) => {
		const reference = `underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@${pin}`;
		const failure = new WorkflowReferenceMutableError(reference, pin);
		const results: ResultRow[][] = [];
		const result = await inspectDiscoveredGithubCheck(
			tenant,
			{ repo: repository, branch: 'main' },
			capturingReporter(results),
			fixture().client,
			defaultDependencies({
				source: {
					...source,
					read: () =>
						Promise.resolve(`
on:
  push:
    branches: [main]
jobs:
  packages:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@${pin}
    with:
      url: https://cupboard.supply/t/laney
`)
				},
				verifyWorkflowReference: () => Promise.reject(failure)
			})
		);

		expect({ jobs: result.jobs, rows: results[0]?.slice(1) }).toStrictEqual({
			jobs: [
				{
					caller: path,
					job: 'packages',
					workflowRef: reference,
					status: 'failed',
					findings: [{ finding: new WorkflowPinFailedFinding(failure) }]
				}
			],
			rows: [{ label: `${path}, packages`, value: `failed: ${detail}` }]
		});
	}
);

it('checks each guarded job only for the events that its condition allows', async () => {
	const result = await inspectDiscoveredGithubCheck(
		tenant,
		{ repo: repository, branch: 'main' },
		capturingReporter([]),
		fixture().client,
		defaultDependencies({
			source: {
				...source,
				read: () =>
					Promise.resolve(`
on:
  pull_request:
  push:
    branches: [main]
jobs:
  publish-pr:
    if: github.event_name == 'pull_request'
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      cache: pull-requests
  publish-main:
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      root: github:iainlane/dotfiles/main
`)
			}
		})
	);

	expect(
		result.jobs.map((job) => ({
			job: job.job,
			triggers: job.findings.map(({ trigger }) => trigger)
		}))
	).toStrictEqual([
		{ job: 'publish-pr', triggers: ['pull_request'] },
		{ job: 'publish-main', triggers: ['push', 'push'] }
	]);
});

async function quickstartWorkflow(): Promise<string> {
	const guide = await readFile(
		new URL('../../../../../docs/github-actions.md', import.meta.url),
		'utf8'
	);
	const section = guide.slice(
		guide.indexOf('### 4. Call the reusable workflow')
	);
	const block = /```yaml\n([\s\S]*?)```/u.exec(section)?.[1];

	if (block === undefined) {
		throw new Error('expected a workflow block in the quickstart');
	}

	return block;
}

it("reports the guide's quickstart workflow as ready after github setup", async () => {
	const quickstartTenant = new URL(
		'https://cupboard.example.workers.dev/t/acme'
	);
	const identity = {
		repositoryId: 1234,
		repositoryOwnerId: 5678,
		fullName: 'acme/app',
		defaultBranch: 'main'
	};
	const workflowPattern =
		'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v*';
	const rules = [
		{
			...githubPrAddBody(quickstartTenant, identity, {
				repo: identity.fullName,
				jobWorkflowRef: workflowPattern
			}),
			id: 'pr',
			disabled: false
		},
		{
			...githubBranchAddBody(quickstartTenant, identity, {
				repo: identity.fullName,
				branch: 'main',
				jobWorkflowRef: workflowPattern
			}),
			id: 'branch',
			disabled: false
		}
	];
	const view = reuseViewSummarySchema.parse({
		name: 'pull-requests-1234',
		access: 'public',
		selectors: [{ kind: 'prefix', prefix: 'gh-1234-pr-' }],
		priority: 50,
		revision: 1,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z'
	});
	const workflow = await quickstartWorkflow();
	const result = await inspectDiscoveredGithubCheck(
		quickstartTenant,
		{ repo: identity.fullName },
		capturingReporter([]),
		fixture({ rules, views: [view] }).client,
		defaultDependencies({
			lookupRepository: () => Promise.resolve(identity),
			source: {
				resolveBranch: () => Promise.resolve('a'.repeat(40)),
				list: () => Promise.resolve(['.github/workflows/cupboard.yml']),
				read: () => Promise.resolve(workflow)
			},
			fetchCacheInfo: (url) => {
				const priority = cachePrioritySchema.parse(
					url.pathname.includes('/reuse/') ? 50 : 40
				);

				return Promise.resolve(
					new CacheInfo(servedStoreDirectory, true, priority)
				);
			}
		})
	);

	expect(
		result.jobs.map((job) => ({
			job: job.job,
			status: job.status,
			notes: job.findings.filter(
				({ finding }) => finding.detail() !== undefined
			)
		}))
	).toStrictEqual([
		{
			job: 'publish',
			status: 'ready',
			notes: [
				{ trigger: 'pull_request', finding: new ForkPullRequestFinding() }
			]
		}
	]);
});

it.each([
	{
		name: 'with a matching trust rule',
		rules: ['repository'],
		status: 'unverified'
	},
	{ name: 'without a trust rule', rules: [], status: 'failed' }
])(
	'reports pull-request runs that share the branch cache for manual review $name',
	async ({ rules, status }) => {
		const result = await inspectDiscoveredGithubCheck(
			tenant,
			{ repo: repository, branch: 'main' },
			capturingReporter([]),
			fixture({
				rules: rules.map((id) =>
					oidcTrustSummarySchema.parse({
						id,
						issuer: 'https://token.actions.githubusercontent.com',
						audience: tenant.href,
						claims: { repository_id: '1234' },
						permittedGrants: [buildCacheGrant({ allow: ['push', 'attest'] })],
						disabled: false
					})
				)
			}).client,
			defaultDependencies({
				source: {
					...source,
					read: () =>
						Promise.resolve(`
on:
  push:
    branches: [main]
  pull_request:
jobs:
  packages:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
`)
				}
			})
		);

		expect(
			result.jobs.map((job) => ({
				status: job.status,
				pullRequest: job.findings.filter(
					({ trigger }) => trigger === 'pull_request'
				)
			}))
		).toStrictEqual([
			{
				status,
				pullRequest: [
					{
						trigger: 'pull_request',
						finding: new SharedPullRequestCacheFinding()
					}
				]
			}
		]);
	}
);
