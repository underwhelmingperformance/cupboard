import { readFile } from 'node:fs/promises';

import { capturingReporter } from '@cupboard/cli-ui/testing';
import {
	CacheInfo,
	servedStoreDirectory
} from '@cupboard/nix-store/cache-info';
import { cachePrioritySchema } from '@cupboard/nix-store/scalars';
import {
	cacheListResponseSchema,
	type CacheSummaryInput
} from '@cupboard/protocol/caches';
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
	buildCacheContentReadGrant,
	buildCacheGrant,
	jobWorkflowReferenceClaim
} from '../oidc-trust/rule-builder.ts';

import { type GithubCheckClient } from './check.ts';
import {
	type DiscoveredGithubCheckDependencies,
	DiscoveryUnverifiedFinding,
	inspectDiscoveredGithubCheck,
	isRepairOffered,
	SharedPullRequestCacheFinding,
	WorkflowPinFailedFinding
} from './discovered-check.ts';
import { type WorkflowSource } from './discovery.ts';
import {
	PassedCheckFinding,
	ReadAuthenticationConfiguredFinding,
	ReadAuthenticationIncompleteFinding,
	ReadAuthenticationUnverifiedFinding,
	ReuseViewAccessModeMismatchFinding,
	ReuseViewMissingFinding,
	ReuseViewPriorityInsufficientFinding,
	RootGrantPrefixUnverifiedFinding
} from './finding.ts';
import {
	BranchFilterCoverageFinding,
	CustomReuseViewFinding,
	ForkPullRequestFinding,
	ManualRunBranchFinding,
	PublicationUnmodelledFinding,
	PushCoverageFinding,
	ReferenceFilterExcludesFinding,
	TagPatternCoverageFinding
} from './publication.ts';
import { RepositoryTrustRuleMissingFinding } from './trust-selection.ts';

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
		readonly caches?: readonly CacheSummaryInput[];
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
					Promise.resolve(
						cacheListResponseSchema.parse({ caches: options.caches ?? [] })
					)
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
		fetchCacheAccess: () => Promise.resolve('public'),
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
				},
				{
					label: 'Review a repair',
					value: `cupboard github check ${tenant.href.replace(/\/$/u, '')} --repo ${repository} --branch main --fix`
				}
			]
		]
	});
});

it.each([
	{
		selected: 'public' as const,
		input: '',
		status: 'failed',
		mismatches: [
			new ReuseViewAccessModeMismatchFinding(
				'pull-request cache access',
				'pull-requests-1234',
				'private',
				'public'
			)
		]
	},
	{
		selected: 'private' as const,
		input: '      cache-access-mode: private\n',
		status: 'ready',
		mismatches: []
	}
])('compares the PR view with the $selected cache policy', async (scenario) => {
	const view = reuseViewSummarySchema.parse({
		name: 'pull-requests-1234',
		access: 'private',
		selectors: [{ kind: 'prefix', prefix: 'gh-1234-pr-' }],
		priority: 50,
		revision: 1,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z'
	});
	const cache: CacheSummaryInput = {
		scope: { kind: 'named', name: 'gh-1234-pr-42' },
		access: 'private',
		priority: 30,
		storePaths: 0,
		defaultRootRetention: { kind: 'permanent' },
		grace: { kind: 'none' },
		rootRetentionOverrides: []
	};
	const rule = oidcTrustSummarySchema.parse({
		...githubPrAddBody(
			tenant,
			{
				repositoryId: 1234,
				repositoryOwnerId: 5678,
				fullName: repository,
				defaultBranch: 'main'
			},
			{
				repo: repository,
				jobWorkflowRef:
					'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v0.0.35',
				readCache: true
			}
		),
		id: 'pr',
		disabled: false
	});
	const content = `
on: pull_request
jobs:
  build:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      preset: pull-request-and-branch
${scenario.input}`;
	const { client, dependencies } = fixture({
		rules: [rule],
		views: [view],
		caches: [cache],
		dependencies: {
			source: { ...source, read: () => Promise.resolve(content) },
			fetchCacheAccess: () => Promise.resolve('public')
		}
	});
	const result = await inspectDiscoveredGithubCheck(
		tenant,
		{ repo: repository, branch: 'main' },
		capturingReporter([]),
		client,
		dependencies
	);

	expect({
		status: result.jobs.map((job) => job.status),
		mismatches: result.jobs.flatMap((job) =>
			job.findings
				.map(({ finding }) => finding)
				.filter(
					(finding) => finding instanceof ReuseViewAccessModeMismatchFinding
				)
		),
		repairOffered: isRepairOffered(result)
	}).toStrictEqual({
		status: [scenario.status],
		mismatches: scenario.mismatches,
		repairOffered: false
	});
});

it.each(
	[
		{
			access: 'public' as const,
			rules: [] as readonly unknown[],
			secrets: '',
			status: 'ready',
			findings: []
		},
		{
			access: 'private' as const,
			rules: [
				oidcTrustSummarySchema.parse({
					id: 'read-only',
					issuer: 'https://token.actions.githubusercontent.com',
					audience: tenant.href,
					claims: { repository_id: '1234', event_name: 'pull_request' },
					permittedGrants: [buildCacheContentReadGrant({})],
					disabled: false
				})
			],
			secrets: '',
			status: 'ready',
			findings: [new PassedCheckFinding('trust rule')]
		},
		{
			access: 'private' as const,
			rules: [] as readonly unknown[],
			secrets: `
    secrets:
      destination_read_user: \${{ secrets.CACHE_USER }}
      destination_read_password: \${{ secrets.CACHE_PASSWORD }}`,
			status: 'ready',
			findings: [new ReadAuthenticationConfiguredFinding('cache')]
		},
		{
			access: 'private' as const,
			rules: [] as readonly unknown[],
			secrets: '\n    secrets: inherit',
			status: 'unverified',
			findings: [new ReadAuthenticationUnverifiedFinding('cache')]
		},
		{
			access: 'private' as const,
			rules: [] as readonly unknown[],
			secrets:
				'\n    secrets:\n      destination_read_user: ${{ secrets.CACHE_USER }}',
			status: 'failed',
			findings: [new ReadAuthenticationIncompleteFinding('cache')]
		},
		{
			access: 'public' as const,
			rules: [] as readonly unknown[],
			secrets:
				'\n    secrets:\n      destination_read_user: ${{ secrets.CACHE_USER }}',
			status: 'failed',
			findings: [new ReadAuthenticationIncompleteFinding('cache')]
		}
	].flatMap((scenario) =>
		['push: false', 'publish: none'].map((publicationInput) => ({
			...scenario,
			publicationInput
		}))
	)
)(
	'checks $access read-only pull requests with $publicationInput and declared secrets $secrets',
	async (scenario) => {
		const readOnlyWorkflow = `
on: pull_request
jobs:
  build:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      preset: pull-request-and-branch
      ${scenario.publicationInput}${scenario.secrets}
`;
		const { client, dependencies } = fixture({
			rules: scenario.rules,
			dependencies: {
				source: { ...source, read: () => Promise.resolve(readOnlyWorkflow) },
				fetchCacheAccess: () => Promise.resolve(scenario.access)
			}
		});
		const result = await inspectDiscoveredGithubCheck(
			tenant,
			{ repo: repository, branch: 'main' },
			capturingReporter([]),
			client,
			dependencies
		);

		expect(
			result.jobs.map((job) => ({
				status: job.status,
				findings: job.findings.map(({ finding }) => finding)
			}))
		).toStrictEqual([{ status: scenario.status, findings: scenario.findings }]);
		expect(result.repairableJobs).toStrictEqual([]);
	}
);

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

it('checks a private cache read separately from publication authority', async () => {
	const rule = oidcTrustSummarySchema.parse({
		id: 'publication-only',
		issuer: 'https://token.actions.githubusercontent.com',
		audience: tenant.href,
		claims: { repository_id: '1234', ref: 'refs/heads/main' },
		permittedGrants: [buildCacheGrant({ allow: ['push', 'attest'] })],
		disabled: false
	});
	const { client, dependencies } = fixture({
		rules: [rule],
		dependencies: {
			fetchCacheAccess: () => Promise.resolve('private'),
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
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
`)
			}
		}
	});
	const result = await inspectDiscoveredGithubCheck(
		tenant,
		{ repo: repository, branch: 'main' },
		capturingReporter([]),
		client,
		dependencies
	);

	expect(
		result.jobs.map((job) => ({
			status: job.status,
			findings: job.findings.map(({ finding }) => finding.toJSON())
		}))
	).toStrictEqual([
		{
			status: 'failed',
			findings: [
				{
					check: 'trust rule',
					status: 'failed',
					detail:
						'rule publication-only matches the modelled claims but does not permit cache:content-read on cache (default); add a rule with the required grant, or add a corrected rule and remove this one'
				}
			]
		}
	]);
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
							'the push input is dynamic, so the check cannot determine whether this job publishes or only reads'
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

it('does not offer to create a custom reuse view', async () => {
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

	expect({
		jobs: result.jobs,
		isRepairOffered: isRepairOffered(result)
	}).toStrictEqual({
		jobs: [
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
		],
		isRepairOffered: false
	});
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

it('does not decide wildcard tag coverage from one fabricated tag', async () => {
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
			status: 'unverified',
			findings: [
				{
					trigger: 'push',
					finding: new TagPatternCoverageFinding('v*')
				}
			]
		}
	]);
});

it.each([
	{
		name: 'an unfiltered push',
		filter: '',
		ref: 'refs/heads/main',
		coverage: new PushCoverageFinding('main'),
		checksModelledRef: true
	},
	{
		name: 'a wildcard tag filter',
		filter: "    tags: ['v*']",
		ref: 'refs/tags/v1.2.3',
		coverage: new TagPatternCoverageFinding('v*'),
		checksModelledRef: false
	},
	{
		name: 'a wildcard branch filter',
		filter: "    branches: ['ma*']",
		ref: 'refs/heads/main',
		coverage: new BranchFilterCoverageFinding('branches', ['ma*'], 'main'),
		checksModelledRef: true
	},
	{
		name: 'a branches-ignore filter',
		filter: "    branches-ignore: ['develop']",
		ref: 'refs/heads/main',
		coverage: new BranchFilterCoverageFinding(
			'branches-ignore',
			['develop'],
			'main'
		),
		checksModelledRef: true
	}
])(
	'does not report ready for $name on one matching ref',
	async ({ filter, ref, coverage, checksModelledRef }) => {
		const reference =
			'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.35';
		const rule = oidcTrustSummarySchema.parse({
			id: 'one-ref',
			issuer: 'https://token.actions.githubusercontent.com',
			audience: tenant.href,
			claims: { repository_id: '1234', ref, job_workflow_ref: reference },
			permittedGrants: [buildCacheGrant({ allow: ['push', 'attest'] })],
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
${filter}
jobs:
  publish:
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
				findings: job.findings.map(({ finding }) => finding)
			}))
		).toStrictEqual([
			{
				status: 'unverified',
				findings: checksModelledRef
					? [
							coverage,
							new PassedCheckFinding('trust rule'),
							new PassedCheckFinding('root grant')
						]
					: [coverage]
			}
		]);
	}
);

it('does not report ready for manual runs on other branches', async () => {
	const reference =
		'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.35';
	const rule = oidcTrustSummarySchema.parse({
		id: 'main-only',
		issuer: 'https://token.actions.githubusercontent.com',
		audience: tenant.href,
		claims: {
			repository_id: '1234',
			ref: 'refs/heads/main',
			job_workflow_ref: reference
		},
		permittedGrants: [buildCacheGrant({ allow: ['push', 'attest'] })],
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
on: workflow_dispatch
jobs:
  publish:
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
			findings: job.findings.map(({ finding }) => finding)
		}))
	).toStrictEqual([
		{
			status: 'unverified',
			findings: [
				new ManualRunBranchFinding('main'),
				new PassedCheckFinding('trust rule'),
				new PassedCheckFinding('root grant')
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

	expect({
		jobs: result.jobs,
		isRepairOffered: isRepairOffered(result)
	}).toStrictEqual({
		jobs: [
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
		],
		isRepairOffered: false
	});
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

it('does not offer a repair for a job whose pull-request runs share the branch cache', async () => {
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
on: [push, pull_request]
jobs:
  packages:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
`)
			}
		})
	);

	expect({
		jobs: result.jobs,
		repairableJobs: result.repairableJobs
	}).toStrictEqual({
		jobs: [
			{
				caller: path,
				job: 'packages',
				workflowRef:
					'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.35',
				status: 'failed',
				findings: [
					{ trigger: 'push', finding: new PushCoverageFinding('main') },
					{
						trigger: 'push',
						finding: new RepositoryTrustRuleMissingFinding('trust rule')
					},
					{
						trigger: 'pull_request',
						finding: new SharedPullRequestCacheFinding()
					}
				]
			}
		],
		repairableJobs: []
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

it.each([
	{
		name: 'includes the read credential options in the repair command',
		options: { readUser: 'reader' },
		rows: [
			{
				label: 'Review a repair',
				value: `cupboard github check ${tenant.href.replace(/\/$/u, '')} --repo ${repository} --branch main --read-user <user> --read-password <password> --fix`
			}
		]
	},
	{
		name: 'omits the repair command from the output under --fix',
		options: { isFixRequested: true },
		rows: []
	}
])('$name', async ({ options, rows }) => {
	const results: ResultRow[][] = [];

	await inspectDiscoveredGithubCheck(
		tenant,
		{ repo: repository, branch: 'main', ...options },
		capturingReporter(results),
		fixture().client,
		defaultDependencies()
	);

	expect(
		results[0]?.filter((row) => row.label === 'Review a repair')
	).toStrictEqual(rows);
});

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
		new URL('../../../../../docs/ci/quickstart.md', import.meta.url),
		'utf8'
	);
	const section = guide.slice(guide.indexOf('## 4. Add the workflow'));
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

it('offers a repair for the quickstart workflow on an empty tenant', async () => {
	const workflow = await quickstartWorkflow();
	const result = await inspectDiscoveredGithubCheck(
		new URL('https://cupboard.example.workers.dev/t/acme'),
		{ repo: 'acme/app' },
		capturingReporter([]),
		fixture().client,
		defaultDependencies({
			lookupRepository: () =>
				Promise.resolve({
					repositoryId: 1234,
					repositoryOwnerId: 5678,
					fullName: 'acme/app',
					defaultBranch: 'main'
				}),
			source: {
				resolveBranch: () => Promise.resolve('a'.repeat(40)),
				list: () => Promise.resolve(['.github/workflows/cupboard.yml']),
				read: () => Promise.resolve(workflow)
			},
			fetchCacheInfo: () =>
				Promise.resolve(
					new CacheInfo(
						servedStoreDirectory,
						true,
						cachePrioritySchema.parse(40)
					)
				)
		})
	);

	expect({
		statuses: result.jobs.map((job) => [job.job, job.status]),
		repairable: result.repairableJobs.map((job) => job.job)
	}).toStrictEqual({
		statuses: [['publish', 'failed']],
		repairable: ['publish']
	});
});
