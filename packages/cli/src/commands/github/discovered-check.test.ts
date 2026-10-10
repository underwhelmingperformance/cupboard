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
	GithubCheckFailedError,
	GithubCheckIncompleteError,
	WorkflowReferenceMutableError,
	WorkflowReferenceNotFoundError
} from '../../errors.ts';
import {
	githubBranchAddBody,
	githubPrAddBody,
	githubPrCloseAddBody
} from '../oidc-trust.ts';
import {
	buildAddBody,
	buildCacheContentReadGrant,
	buildCacheGrant,
	buildViewContentReadGrant,
	jobWorkflowReferenceClaim
} from '../oidc-trust/rule-builder.ts';

import { type GithubCheckClient } from './check.ts';
import {
	type DiscoveredGithubCheckDependencies,
	DiscoveryUnverifiedFinding,
	finishDiscoveredGithubCheck,
	inspectDiscoveredGithubCheck,
	isRepairOffered,
	SharedPullRequestCacheFinding,
	WorkflowPinFailedFinding
} from './discovered-check.ts';
import { type WorkflowSource } from './discovery.ts';
import {
	PassedCheckFinding,
	PullRequestCacheAccessMismatchFinding,
	ReadAuthenticationConfiguredFinding,
	ReadAuthenticationIncompleteFinding,
	ReadAuthenticationUnverifiedFinding,
	ReuseViewMissingFinding,
	ReuseViewPriorityInsufficientFinding,
	RootGrantPrefixUnverifiedFinding
} from './finding.ts';
import {
	BranchFilterCoverageFinding,
	CustomReuseViewFinding,
	ForkPullRequestFinding,
	ManualRunBranchFinding,
	modelPublishingJob,
	PresetPushFilterFinding,
	PresetTagPushFinding,
	PublicationUnmodelledFinding,
	PushCoverageFinding,
	ReferenceFilterExcludesFinding,
	TagPatternCoverageFinding
} from './publication.ts';
import { publicationReadAuthority } from './read-authority.ts';
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

const legacyPublishingWorkflow = `
on:
  workflow_call:
jobs:
  publish:
    steps:
      - uses: $/actions/push
`;

it.each([
	{
		name: 'default activity types',
		trigger: 'pull_request:',
		condition: '',
		expected: ['closed', 'merged-close']
	},
	{
		name: 'explicit publication activities',
		trigger: 'pull_request:\n    types: [opened, synchronize]',
		condition: '',
		expected: ['closed', 'merged-close', 'reopened']
	},
	{
		name: 'closed-only activity',
		trigger: 'pull_request:\n    types: [closed]',
		condition: '',
		expected: ['reopened']
	},
	{
		name: 'closed exclusion',
		trigger:
			'pull_request:\n    types: [opened, synchronize, reopened, closed]',
		condition: "github.event.action != 'closed'",
		expected: ['closed', 'merged-close']
	},
	{
		name: 'merged exclusion',
		trigger: 'pull_request:\n    types: [reopened, closed]',
		condition: '!github.event.pull_request.merged',
		expected: ['merged-close']
	},
	{
		name: 'event exclusion',
		trigger: 'pull_request:\n    types: [reopened, closed]',
		condition: "github.event_name == 'push'",
		expected: ['closed', 'merged-close', 'reopened']
	}
])(
	'fails lifecycle coverage for $name',
	async ({ trigger, condition, expected }) => {
		const { client, dependencies } = fixture({
			dependencies: {
				source: {
					...source,
					read: () =>
						Promise.resolve(`
on:
  ${trigger}
jobs:
  publish:
    ${condition === '' ? '' : `if: \${{ ${condition} }}`}
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      cache: pr-cache
      manage-pr-cache: true
`)
				}
			}
		});
		const result = await inspectDiscoveredGithubCheck(
			tenant,
			{ repo: repository },
			capturingReporter([]),
			client,
			dependencies
		);
		expect(
			result.jobs.flatMap((job) =>
				job.findings
					.filter(({ finding }) => finding.check === 'pull-request lifecycle')
					.map(({ trigger, finding }) => ({ trigger, status: finding.status }))
			)
		).toStrictEqual(expected.map((trigger) => ({ trigger, status: 'failed' })));
		expect(result.repairableJobs).toStrictEqual([]);
	}
);

it.each([
	{
		name: 'dynamic types',
		types: '${{ inputs.activities }}',
		condition: undefined
	},
	{
		name: 'an unknown type',
		types: '[closed, reopened, unknown_activity]',
		condition: undefined
	},
	{
		name: 'a dynamic type in a list',
		types: "[closed, reopened, '${{ inputs.activity }}']",
		condition: undefined
	},
	{
		name: 'a dependency condition',
		types: '[closed, reopened]',
		condition: "needs.build.result == 'success'"
	},
	{
		name: 'an invalid condition shape',
		types: '[closed, reopened]',
		condition: '[true]'
	}
])(
	'reports lifecycle analysis as unverified for $name',
	async ({ types, condition }) => {
		const { client, dependencies } = fixture({
			dependencies: {
				source: {
					...source,
					read: () =>
						Promise.resolve(`
on:
  pull_request:
    types: ${types}
jobs:
  publish:
    ${condition === undefined ? '' : `if: ${condition}`}
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      cache: pr-cache
      manage-pr-cache: true
`)
				}
			}
		});
		const result = await inspectDiscoveredGithubCheck(
			tenant,
			{ repo: repository },
			capturingReporter([]),
			client,
			dependencies
		);
		expect(
			result.jobs.flatMap((job) =>
				job.findings
					.filter(({ finding }) => finding.check === 'pull-request lifecycle')
					.map(({ trigger, finding }) => ({ trigger, status: finding.status }))
			)
		).toStrictEqual(
			['closed', 'merged-close', 'reopened'].map((trigger) => ({
				trigger,
				status: 'unverified'
			}))
		);
		expect(result.repairableJobs).toStrictEqual([]);
	}
);

it.each([
	{
		name: 'unmanaged simple job',
		workflow: 'cupboard-publish.yml',
		inputs: 'cache: pr-cache'
	},
	{
		name: 'read-only simple job',
		workflow: 'cupboard-publish.yml',
		inputs: 'cache: pr-cache\n      manage-pr-cache: true\n      publish: none'
	},
	{
		name: 'read-only preset job',
		workflow: 'cupboard-flake-publish.yml',
		inputs: 'preset: pull-request-and-branch\n      publish: none'
	},
	{
		name: 'legacy read-only preset job',
		workflow: 'cupboard-flake-publish.yml',
		inputs: 'preset: pull-request-and-branch\n      push: false'
	}
])(
	'does not require lifecycle coverage for $name',
	async ({ workflow, inputs }) => {
		const { client, dependencies } = fixture({
			dependencies: {
				source: {
					...source,
					read: () =>
						Promise.resolve(`
on: pull_request
jobs:
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/${workflow}@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      ${inputs}
`)
				}
			}
		});
		const result = await inspectDiscoveredGithubCheck(
			tenant,
			{ repo: repository },
			capturingReporter([]),
			client,
			dependencies
		);
		expect(
			result.jobs.flatMap((job) =>
				job.findings.filter(
					({ finding }) => finding.check === 'pull-request lifecycle'
				)
			)
		).toStrictEqual([]);
	}
);

it.each([
	{
		name: 'matching cache across pins',
		cache: 'pr-cache',
		management: 'true',
		publish: 'outputs',
		isUnverified: false,
		expected: []
	},
	{
		name: 'different cache',
		cache: 'other-cache',
		management: 'true',
		publish: 'outputs',
		isUnverified: false,
		expected: ['closed', 'merged-close', 'reopened']
	},
	{
		name: 'dynamic cache',
		cache: '${{ inputs.cache }}',
		management: 'true',
		publish: 'outputs',
		isUnverified: true,
		expected: ['closed', 'merged-close', 'reopened']
	},
	{
		name: 'dynamic management',
		cache: 'pr-cache',
		management: '${{ inputs.manage }}',
		publish: 'outputs',
		isUnverified: true,
		expected: ['closed', 'merged-close']
	},
	{
		name: 'dynamic publication',
		cache: 'pr-cache',
		management: 'true',
		publish: '${{ inputs.publish }}',
		isUnverified: true,
		expected: ['closed', 'merged-close']
	}
])(
	'checks split lifecycle jobs with $name',
	async ({ cache, management, publish, isUnverified, expected }) => {
		const { client, dependencies } = fixture({
			dependencies: {
				source: {
					...source,
					read: () =>
						Promise.resolve(`
on:
  pull_request:
    types: [opened, synchronize, reopened, closed]
jobs:
  publish:
    if: github.event.action != 'closed'
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      cache: pr-cache
      manage-pr-cache: true
  close:
    if: github.event.action == 'closed'
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.36
    with:
      url: https://cupboard.supply/t/laney
      cache: ${cache}
      manage-pr-cache: ${management}
      publish: ${publish}
`)
				}
			}
		});
		const result = await inspectDiscoveredGithubCheck(
			tenant,
			{ repo: repository },
			capturingReporter([]),
			client,
			dependencies
		);
		expect(
			result.jobs.flatMap((job) =>
				job.findings
					.filter(({ finding }) => finding.check === 'pull-request lifecycle')
					.map(({ trigger, finding }) => ({ trigger, status: finding.status }))
			)
		).toStrictEqual(
			expected.map((trigger) => ({
				trigger,
				status: isUnverified ? 'unverified' : 'failed'
			}))
		);
	}
);

it('checks nested caller conditions without granting blocked lifecycle operations', async () => {
	const files: Readonly<Record<string, string>> = {
		[path]: `
on:
  pull_request:
    types: [closed, reopened]
jobs:
  call:
    if: github.event.action != 'closed'
    uses: ./.github/workflows/inner.yml
`,
		'.github/workflows/inner.yml': `
on: workflow_call
jobs:
  publish:
    if: github.event.action != 'reopened'
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      cache: pr-cache
      manage-pr-cache: true
`
	};
	const { client, dependencies } = fixture({
		dependencies: {
			source: {
				...source,
				read: (_repository, selectedPath) =>
					Promise.resolve(files[selectedPath] ?? '')
			}
		}
	});
	const result = await inspectDiscoveredGithubCheck(
		tenant,
		{ repo: repository },
		capturingReporter([]),
		client,
		dependencies
	);
	expect(
		result.jobs.map((job) => ({
			job: job.job,
			lifecycle: job.findings
				.filter(({ finding }) => finding.check === 'pull-request lifecycle')
				.map(({ trigger, finding }) => ({ trigger, status: finding.status })),
			trust: job.findings.filter(
				({ finding }) => finding.check === 'trust rule'
			)
		}))
	).toStrictEqual([
		{
			job: 'call (inner.yml: publish)',
			lifecycle: ['closed', 'merged-close', 'reopened'].map((trigger) => ({
				trigger,
				status: 'failed'
			})),
			trust: []
		}
	]);
});

it('verifies split preset publication and close jobs with only their required authority', async () => {
	const identity = {
		repositoryId: 1234,
		repositoryOwnerId: 5678,
		fullName: repository,
		defaultBranch: 'main'
	};
	const reference =
		'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v0.0.35';
	const closeReference = reference.replace('v0.0.35', 'v0.0.36');
	const pr = githubPrAddBody(tenant, identity, {
		repo: repository,
		jobWorkflowRef: reference
	});
	const close = githubPrCloseAddBody(tenant, identity, {
		repo: repository,
		jobWorkflowRef: closeReference
	});
	const { client, dependencies } = fixture({
		views: [
			reuseViewSummarySchema.parse({
				name: 'pull-requests-1234',
				access: 'public',
				selectors: [{ kind: 'prefix', prefix: 'gh-1234-pr-' }],
				priority: 50,
				revision: 1,
				createdAt: '2026-01-01T00:00:00.000Z',
				updatedAt: '2026-01-01T00:00:00.000Z'
			})
		],
		rules: [
			{
				...pr,
				id: 'publication',
				disabled: false,
				permittedGrants: pr.permittedGrants.map((grant) => ({
					...grant,
					...(grant.type === 'cupboard_cache' && {
						actions: grant.actions.filter((action) => action !== 'cache:close')
					})
				}))
			},
			{
				...pr,
				id: 'close',
				disabled: false,
				claims: { ...pr.claims, job_workflow_ref: closeReference },
				permittedGrants: pr.permittedGrants.flatMap((grant) =>
					grant.type === 'cupboard_cache'
						? [
								{
									...grant,
									actions: ['cache:close'],
									resources: { cache: grant.resources.cache }
								}
							]
						: []
				)
			},
			{ ...close, id: 'merged-close', disabled: false }
		],
		dependencies: {
			source: {
				...source,
				read: () =>
					Promise.resolve(`
on:
  pull_request:
    types: [opened, synchronize, reopened, closed]
jobs:
  publish:
    if: github.event.action != 'closed'
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      preset: pull-request-and-branch
  close:
    if: github.event.action == 'closed'
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@v0.0.36
    with:
      url: https://cupboard.supply/t/laney
      preset: pull-request-and-branch
`)
			}
		}
	});
	const result = await inspectDiscoveredGithubCheck(
		tenant,
		{ repo: repository },
		capturingReporter([]),
		client,
		dependencies
	);
	expect(
		result.jobs.map((job) => ({
			job: job.job,
			status: job.status,
			failures: job.findings
				.filter(({ finding }) => finding.status === 'failed')
				.map(({ trigger, finding }) => ({ trigger, ...finding.toJSON() })),
			lifecycle: job.findings.filter(
				({ finding }) => finding.check === 'pull-request lifecycle'
			)
		}))
	).toStrictEqual([
		{ job: 'publish', status: 'ready', failures: [], lifecycle: [] },
		{ job: 'close', status: 'ready', failures: [], lifecycle: [] }
	]);
});

it.each([
	{
		name: 'implicit success on a skipped publisher',
		needs: 'publish',
		condition: "github.event.action == 'closed'",
		status: 'failed'
	},
	{
		name: 'explicit success on a skipped publisher',
		needs: 'publish',
		condition: "success() && github.event.action == 'closed'",
		status: 'failed'
	},
	{
		name: 'a transitively skipped dependency',
		needs: '[middle]',
		condition: "github.event.action == 'closed'",
		status: 'failed'
	},
	{
		name: 'a dynamic dependency',
		needs: '${{ inputs.job }}',
		condition: "github.event.action == 'closed'",
		status: 'unverified'
	},
	{
		name: 'a dependency chain beyond the analysis bound',
		needs: 'chain0',
		condition: "github.event.action == 'closed'",
		status: 'unverified'
	},
	{
		name: 'an always override',
		needs: 'publish',
		condition: "always() && github.event.action == 'closed'",
		status: undefined
	},
	{
		name: 'a non-cancelled override',
		needs: 'publish',
		condition: "!cancelled() && github.event.action == 'closed'",
		status: undefined
	}
])(
	'checks lifecycle dependency gates for $name',
	async ({ needs, condition, status }) => {
		const { client, dependencies } = fixture({
			dependencies: {
				source: {
					...source,
					read: () =>
						Promise.resolve(`
on:
  pull_request:
    types: [opened, synchronize, reopened, closed]
jobs:
  publish:
    if: github.event.action != 'closed'
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      preset: pull-request-and-branch
  middle:
    needs: publish
    steps:
      - run: echo middle
${Array.from({ length: 40 }, (_, index) => `  chain${String(index)}:\n    needs: ${index === 39 ? 'publish' : `chain${String(index + 1)}`}\n    steps:\n      - run: echo chain\n`).join('')}
  close:
    needs: ${needs}
    if: \${{ ${condition} }}
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@v0.0.36
    with:
      url: https://cupboard.supply/t/laney
      preset: pull-request-and-branch
`)
				}
			}
		});
		const result = await inspectDiscoveredGithubCheck(
			tenant,
			{ repo: repository },
			capturingReporter([]),
			client,
			dependencies
		);
		expect(
			result.jobs.map((job) => ({
				job: job.job,
				lifecycle: job.findings
					.filter(({ finding }) => finding.check === 'pull-request lifecycle')
					.map(({ trigger, finding }) => ({ trigger, status: finding.status }))
			}))
		).toStrictEqual(
			['publish', 'close'].map((job) => ({
				job,
				lifecycle:
					status === undefined
						? []
						: ['closed', 'merged-close'].map((trigger) => ({ trigger, status }))
			}))
		);
	}
);

it.each(
	['constructor', 'toString'].flatMap((id) =>
		[false, true].map((declared) => ({ id, declared }))
	)
)(
	'treats $id as a lifecycle dependency only when declared ($declared)',
	async ({ id, declared }) => {
		const { client, dependencies } = fixture({
			dependencies: {
				source: {
					...source,
					read: () =>
						Promise.resolve(`
on:
  pull_request:
    types: [opened, synchronize, reopened, closed]
jobs:
  publish:
    if: github.event.action != 'closed'
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      preset: pull-request-and-branch
${declared ? `  ${id}:\n    steps:\n      - run: echo dependency\n` : ''}
  close:
    needs: ${id}
    if: \${{ !cancelled() && github.event.action == 'closed' }}
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@v0.0.36
    with:
      url: https://cupboard.supply/t/laney
      preset: pull-request-and-branch
`)
				}
			}
		});
		const result = await inspectDiscoveredGithubCheck(
			tenant,
			{ repo: repository },
			capturingReporter([]),
			client,
			dependencies
		);
		expect(
			result.jobs.map((job) => ({
				job: job.job,
				lifecycle: job.findings
					.filter(({ finding }) => finding.check === 'pull-request lifecycle')
					.map(({ trigger, finding }) => ({ trigger, status: finding.status }))
			}))
		).toStrictEqual(
			['publish', 'close'].map((job) => ({
				job,
				lifecycle: declared
					? []
					: ['closed', 'merged-close'].map((trigger) => ({
							trigger,
							status: 'unverified'
						}))
			}))
		);
	}
);

it('does not read a custom view for a closed-only non-preset flake job', async () => {
	const { client, dependencies } = fixture({
		dependencies: {
			source: {
				...source,
				read: () =>
					Promise.resolve(`
on:
  pull_request:
    types: [closed]
jobs:
  close:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      root-prefix: ci/
      reuse-view: shared
`)
			}
		}
	});
	const result = await inspectDiscoveredGithubCheck(
		tenant,
		{ repo: repository },
		capturingReporter([]),
		client,
		dependencies
	);
	expect(
		result.jobs.map((job) => ({
			status: job.status,
			checks: job.findings.map(({ finding }) => finding.toJSON())
		}))
	).toStrictEqual([{ status: 'ready', checks: [] }]);
});

const source: WorkflowSource = {
	resolveBranch: () => Promise.resolve('a'.repeat(40)),
	list: () => Promise.resolve([path]),
	read: () => Promise.resolve(workflow)
};

it('models existing branch workflow trust and reports future edits', async () => {
	const workflowReference =
		'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/heads/main';
	const branch = githubBranchAddBody(
		tenant,
		{
			repositoryId: 1234,
			repositoryOwnerId: 5678,
			fullName: repository,
			defaultBranch: 'main'
		},
		{ repo: repository, branch: 'main', jobWorkflowRef: workflowReference }
	);
	const checks: unknown[] = [];
	const { client, dependencies } = fixture({
		rules: [{ ...branch, id: 'branch', disabled: false }],
		dependencies: {
			source: {
				...source,
				read: () =>
					Promise.resolve(
						`on:\n  push:\n    branches: [main]\njobs:\n  packages:\n    uses: ${workflowReference}\n    with:\n      url: ${tenant.href}\n`
					)
			},
			verifyWorkflowReference: (reference, options) => {
				checks.push({ reference, options });
				return Promise.resolve();
			}
		}
	});
	const result = await inspectDiscoveredGithubCheck(
		tenant,
		{ repo: repository },
		capturingReporter([]),
		client,
		dependencies
	);
	expect({
		checks,
		jobs: result.jobs.map((job) => ({
			...job,
			findings: job.findings.map(({ trigger, finding }) => ({
				...(trigger !== undefined && { trigger }),
				finding: finding.toJSON()
			}))
		})),
		verified: [...result.verifiedWorkflowReferences]
	}).toStrictEqual({
		checks: [
			{
				reference: {
					reference: workflowReference,
					owner: 'underwhelmingperformance',
					repo: 'cupboard',
					path: '.github/workflows/cupboard-publish.yml',
					pin: { kind: 'branch', value: 'refs/heads/main', branch: 'main' }
				},
				options: { allowBranchWorkflow: true }
			}
		],
		jobs: [
			{
				caller: path,
				job: 'packages',
				workflowRef: workflowReference,
				status: 'ready',
				findings: [
					{
						finding: {
							check: 'branch workflow trust',
							status: 'ok',
							detail: `${workflowReference}; trust rules accept future edits to this branch workflow`
						}
					},
					{ trigger: 'push', finding: { check: 'trust rule', status: 'ok' } },
					{ trigger: 'push', finding: { check: 'root grant', status: 'ok' } }
				]
			}
		],
		verified: [workflowReference]
	});
});

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
	overrides: Partial<DiscoveredGithubCheckDependencies> = {},
	publishingWorkflow = legacyPublishingWorkflow
): DiscoveredGithubCheckDependencies {
	const callerSource = overrides.source ?? source;

	return {
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
		...overrides,
		source: {
			...callerSource,
			read: (selectedRepository, selectedPath, reference) =>
				selectedRepository === 'underwhelmingperformance/cupboard' &&
				selectedPath === '.github/workflows/cupboard-publish.yml'
					? Promise.resolve(publishingWorkflow)
					: callerSource.read(selectedRepository, selectedPath, reference)
		}
	};
}

function expectedRuleLines(audience: string): ResultRow[] {
	return [
		{ label: 'Issuer', value: 'https://token.actions.githubusercontent.com' },
		{ label: 'Audience', value: audience },
		{ label: 'Claims', value: 'repository_id=1234' },
		{ label: '', value: 'repository_owner_id=5678' },
		{ label: '', value: 'ref=refs/heads/main' },
		{
			label: '',
			value: String.raw`job_workflow_ref matches ^underwhelmingperformance/cupboard/\.github/workflows/cupboard-flake-publish\.yml@refs/tags/v[^/]*$`
		},
		{ label: 'Access', value: 'Every operation on every resource' },
		{ label: 'State', value: 'enabled' }
	];
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
					raw: true,
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
		details: [
			new PullRequestCacheAccessMismatchFinding(
				['gh-1234-pr-42'],
				'public'
			).detail()
		],
		status: 'failed',
		mismatches: [
			new PullRequestCacheAccessMismatchFinding(['gh-1234-pr-42'], 'public')
		]
	},
	{
		selected: 'explicit public' as const,
		input: '      cache-access-mode: public\n',
		details: [
			new PullRequestCacheAccessMismatchFinding(
				['gh-1234-pr-42'],
				'public'
			).detail()
		],
		status: 'failed',
		mismatches: [
			new PullRequestCacheAccessMismatchFinding(['gh-1234-pr-42'], 'public')
		]
	},
	{
		selected: 'private' as const,
		input: '      cache-access-mode: private\n',
		details: [],
		status: 'ready',
		mismatches: []
	}
])(
	'compares the PR caches with the $selected cache policy',
	async (scenario) => {
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
on:
  pull_request:
    types: [opened, synchronize, reopened, closed]
jobs:
  build:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      preset: pull-request-and-branch
${scenario.input}`;
		const { client, dependencies } = fixture({
			rules: [
				rule,
				oidcTrustSummarySchema.parse({
					...githubPrCloseAddBody(
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
								'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v0.0.35'
						}
					),
					id: 'pr-close',
					disabled: false
				})
			],
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
						(finding) =>
							finding instanceof PullRequestCacheAccessMismatchFinding
					)
			),
			details: result.jobs.flatMap((job) =>
				job.findings
					.filter(
						({ finding }) =>
							finding instanceof PullRequestCacheAccessMismatchFinding
					)
					.map(({ finding }) => finding.detail())
			),
			repairOffered: isRepairOffered(result)
		}).toStrictEqual({
			status: [scenario.status],
			mismatches: scenario.mismatches,
			details: scenario.details,
			repairOffered: false
		});
	}
);

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
			title: 'GitHub trust rules',
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

it.each([true, false])(
	'checks prefix coverage across the preferred identity tier (same tier: %s)',
	async (isSameTier) => {
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
			id: 'a-exact',
			disabled: false
		});
		const prefixRule = oidcTrustSummarySchema.parse({
			...body,
			id: 'z-prefix',
			disabled: false,
			claims: isSameTier ? body.claims : { repository_id: '1234' },
			permittedGrants: [
				buildCacheGrant({
					cache: 'packages',
					root: 'github:iainlane/dotfiles/main/',
					allow: ['push', 'attest', 'root']
				})
			]
		});
		const result = await inspectDiscoveredGithubCheck(
			tenant,
			{ repo: repository, branch: 'main' },
			capturingReporter([]),
			fixture({ rules: [rule, prefixRule] }).client,
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
				status: isSameTier ? 'ready' : 'unverified',
				findings: [
					{ trigger: 'push', finding: new PassedCheckFinding('trust rule') },
					{
						trigger: 'push',
						finding: isSameTier
							? new PassedCheckFinding('root grant')
							: new RootGrantPrefixUnverifiedFinding(
									'root grant',
									'github:iainlane/dotfiles/main/x86_64-linux'
								)
					}
				]
			}
		]);
	}
);

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

it.each([
	{
		name: 'an unfiltered preset push',
		filter: '',
		finding: new PresetPushFilterFinding('main')
	},
	{
		name: 'a preset tag push',
		filter: "    tags: ['v*']",
		finding: new PresetTagPushFinding()
	}
])('reports $name as failed', async ({ filter, finding }) => {
	const reference =
		'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v0.0.35';
	const rule = oidcTrustSummarySchema.parse({
		...githubBranchAddBody(
			tenant,
			{
				repositoryId: 1234,
				repositoryOwnerId: 5678,
				fullName: repository,
				defaultBranch: 'main'
			},
			{ repo: repository, branch: 'main', jobWorkflowRef: reference }
		),
		id: 'all-runs',
		disabled: false
	});
	const view = reuseViewSummarySchema.parse({
		name: 'pull-requests-1234',
		access: 'public',
		selectors: [{ kind: 'prefix', prefix: 'gh-1234-pr-' }],
		priority: 50,
		revision: 1,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z'
	});
	const result = await inspectDiscoveredGithubCheck(
		tenant,
		{ repo: repository, branch: 'main' },
		capturingReporter([]),
		fixture({ rules: [rule], views: [view] }).client,
		defaultDependencies({
			fetchCacheInfo: (url) => {
				const priority = cachePrioritySchema.parse(
					url.pathname.includes('/reuse/') ? 50 : 40
				);

				return Promise.resolve(
					new CacheInfo(servedStoreDirectory, true, priority)
				);
			},
			source: {
				...source,
				read: () =>
					Promise.resolve(`
on:
  push:
${filter}
jobs:
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      preset: pull-request-and-branch
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
				workflowRef: reference,
				status: 'failed',
				findings:
					filter === ''
						? [
								{ trigger: 'push', finding },
								{
									trigger: 'push',
									finding: new PassedCheckFinding('trust rule')
								},
								{
									trigger: 'push',
									finding: new PassedCheckFinding('root grant')
								}
							]
						: [{ trigger: 'push', finding }]
			}
		],
		isRepairOffered: false
	});
});

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
				raw: true,
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
		{ job: 'publish-main', triggers: ['push'] }
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
			...githubPrCloseAddBody(quickstartTenant, identity, {
				repo: identity.fullName,
				jobWorkflowRef: workflowPattern
			}),
			id: 'pr-close',
			disabled: false
		},
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

it.each(
	['cupboard-publish', 'cupboard-flake-publish'].flatMap((workflow) =>
		[
			{
				label: 'omitted',
				input: undefined,
				presented: tenant.href,
				audience: tenant.href
			},
			{
				label: 'empty',
				input: "''",
				presented: tenant.href,
				audience: tenant.href
			},
			{
				label: 'padded custom',
				input: JSON.stringify('  custom-audience  '),
				presented: 'custom-audience',
				audience: 'custom-audience'
			},
			{
				label: 'padded Unicode',
				input: JSON.stringify('\u{A0}custom-audience\u{A0}'),
				presented: 'custom-audience',
				audience: 'custom-audience'
			},
			{
				label: 'blank',
				input: JSON.stringify(' '.repeat(3)),
				presented: tenant.href,
				audience: tenant.href
			},
			{
				label: 'custom matching',
				input: 'custom-audience',
				presented: 'custom-audience',
				audience: 'custom-audience'
			},
			{
				label: 'custom mismatched',
				input: 'custom-audience',
				presented: 'custom-audience',
				audience: tenant.href
			},
			{
				label: 'literal URL',
				input: 'https://audience.example.test/',
				presented: 'https://audience.example.test/',
				audience: 'https://audience.example.test/'
			},
			{
				label: 'expression',
				input: "'${{ inputs.audience }}'",
				presented: undefined,
				audience: tenant.href
			},
			{
				label: 'number',
				input: '42',
				presented: undefined,
				audience: tenant.href
			},
			{
				label: 'boolean',
				input: 'false',
				presented: undefined,
				audience: tenant.href
			}
		].map((scenario) => ({ ...scenario, workflow }))
	)
)(
	'checks the $label audience through $workflow discovery',
	async ({ workflow, input, presented, audience }) => {
		const reference = `underwhelmingperformance/cupboard/.github/workflows/${workflow}.yml@refs/tags/v0.0.35`;
		const rule = oidcTrustSummarySchema.parse({
			id: 'configured-audience',
			issuer: 'https://token.actions.githubusercontent.com',
			audience,
			claims: {
				repository_id: '1234',
				ref: 'refs/heads/main',
				job_workflow_ref: reference
			},
			permittedGrants: [
				buildCacheGrant({
					root: 'ci/',
					allow: ['push', 'attest', 'root', 'attach']
				})
			],
			disabled: false
		});
		const { client, dependencies } = fixture({
			rules: [rule],
			dependencies: {
				source: {
					...source,
					read: () =>
						Promise.resolve(`
on:
  push:
    branches: [main]
jobs:
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/${workflow}.yml@v0.0.35
    with:
      url: ${tenant.href}
      ${workflow === 'cupboard-flake-publish' ? 'root-prefix: ci/' : 'root: ci/'}
${input === undefined ? '' : `      audience: ${input}`}
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
		let completion: unknown;
		try {
			finishDiscoveredGithubCheck(result);
		} catch (error) {
			completion =
				error instanceof GithubCheckFailedError ||
				error instanceof GithubCheckIncompleteError
					? { exitCode: error.exitCode, checks: error.checks }
					: error;
		}
		const isUnverified = presented === undefined;
		const isMatched = presented === audience;
		expect({
			jobs: result.jobs.map((job) => ({
				...job,
				findings: job.findings.map((entry) => ({
					...entry,
					finding: entry.finding.toJSON()
				}))
			})),
			completion
		}).toStrictEqual({
			jobs: [
				{
					caller: path,
					job: 'publish',
					workflowRef: reference,
					status: isUnverified ? 'unverified' : isMatched ? 'ready' : 'failed',
					findings: isUnverified
						? [
								{
									finding: {
										check: 'publication model',
										status: 'unverified',
										detail: 'audience must be a literal string'
									}
								}
							]
						: isMatched
							? [
									{
										trigger: 'push',
										finding: { check: 'trust rule', status: 'ok' }
									},
									{
										trigger: 'push',
										finding: { check: 'root grant', status: 'ok' }
									}
								]
							: [
									{
										trigger: 'push',
										finding: {
											check: 'trust rule',
											status: 'failed',
											detail: `rule configured-audience expects audience ${audience}; the modelled run uses ${presented}`
										}
									}
								]
				}
			],
			completion:
				isMatched && !isUnverified
					? undefined
					: { exitCode: isUnverified ? 69 : 1, checks: [`${path}, publish`] }
		});
	}
);

it('suggests another branch when discovery finds no publishing job', async () => {
	const { client, dependencies } = fixture({
		dependencies: { source: { ...source, list: () => Promise.resolve([]) } }
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
			caller: job.caller,
			job: job.job,
			status: job.status,
			findings: job.findings.map(({ finding }) => finding.toJSON())
		}))
	).toStrictEqual([
		{
			caller: repository,
			job: 'publication',
			status: 'unverified',
			findings: [
				{
					check: 'workflow discovery',
					status: 'unverified',
					detail: `no Cupboard publishing job targeting ${tenant.href} was found on main. If the workflow exists on another branch, pass --branch <branch>.`
				}
			]
		}
	]);
});

const additionalReadWorkflow = (input: string, secrets = '') => `
on: pull_request
jobs:
  build:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@v0.0.35
    with:
      url: ${tenant.href}
      preset: pull-request-and-branch
      publish: none
      read-caches: ${input}
${secrets}
`;

it.each(['public', 'private'] as const)(
	'checks the current %s access of additional read caches through discovery',
	async (access) => {
		const probed: string[] = [];
		const { client, dependencies } = fixture({
			dependencies: {
				source: {
					...source,
					read: () =>
						Promise.resolve(
							additionalReadWorkflow(
								`|\n        ${tenant.href}/cache/falcon\n        ${tenant.href}/cache/falcon/\n        ${tenant.href}`
							)
						)
				},
				fetchCacheAccess: (target) => {
					probed.push(target.href);
					return Promise.resolve(
						target.pathname.endsWith('/falcon') ? access : 'public'
					);
				}
			}
		});
		const check = await inspectDiscoveredGithubCheck(
			tenant,
			{ repo: repository, branch: 'main' },
			capturingReporter([]),
			client,
			dependencies
		);
		expect({ jobs: check.jobs, probed }).toStrictEqual({
			jobs: [
				{
					caller: path,
					job: 'build',
					workflowRef:
						'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v0.0.35',
					status: access === 'private' ? 'failed' : 'ready',
					findings:
						access === 'private'
							? [
									{
										trigger: 'pull_request',
										finding: new RepositoryTrustRuleMissingFinding('trust rule')
									}
								]
							: []
				}
			],
			probed: [tenant.href, `${tenant.href}/cache/falcon`]
		});
	}
);

const invalidAdditionalReads = [
	{
		input: "'${{ inputs.read_caches }}'",
		reason:
			'read-caches must be a literal newline-separated list of cache URLs; resolve expressions before checking or repairing.'
	},
	{
		input: 'true',
		reason:
			'read-caches must be a literal newline-separated list of cache URLs; resolve expressions before checking or repairing.'
	},
	{
		input: `${tenant.href}/reuse/prs`,
		reason:
			'read-caches must use canonical HTTP(S) cache URLs without credentials, a query or a fragment.'
	},
	{
		input: `${tenant.href}/cache/falcon?token=hidden`,
		reason:
			'read-caches must use canonical HTTP(S) cache URLs without credentials, a query or a fragment.'
	},
	{
		input: 'https://user:password@cupboard.supply/t/laney/cache/falcon',
		reason:
			'read-caches must use canonical HTTP(S) cache URLs without credentials, a query or a fragment.'
	},
	{
		input: 'https://cupboard.supply/t/other/cache/falcon',
		reason: 'Every read-caches URL must belong to the selected tenant.'
	},
	{
		input: `${tenant.href}/cache/falcon`,
		secrets:
			"    secrets:\n      read_user: '${{ secrets.USER }}'\n      read_password: '${{ secrets.PASSWORD }}'",
		reason:
			'read-caches requires OIDC reads; omit the default static read credential and provide complete destination credentials separately.'
	},
	{
		input: tenant.href,
		secrets:
			"    secrets:\n      destination_read_user: '${{ secrets.USER }}'\n      destination_read_password: '${{ secrets.PASSWORD }}'",
		reason:
			'Do not request OIDC reads for a destination with an explicit static credential.'
	},
	{
		input: `${tenant.href}/cache/falcon`,
		secrets:
			"    secrets:\n      private_substituters: '${{ secrets.SUBSTITUTERS }}'",
		reason:
			'The check cannot compare read-caches with secret private_substituters; verify that the same cache does not also use a static credential before repairing.'
	},
	{
		input: `|\n${Array.from({ length: 16 }, (_, index) => `        ${tenant.href}/cache/extra-${String(index)}`).join('\n')}`,
		reason:
			'read-caches and the destination and reuse view must select at most sixteen distinct resources.'
	}
];
it.each(invalidAdditionalReads)(
	'does not report readiness for unmodelled additional reads: $input',
	async ({ input, secrets, reason }) => {
		const probed: string[] = [];
		const { client, dependencies } = fixture({
			dependencies: {
				source: {
					...source,
					read: () => Promise.resolve(additionalReadWorkflow(input, secrets))
				},
				fetchCacheAccess: (target) => {
					probed.push(target.href);
					return Promise.resolve('public');
				}
			}
		});
		const check = await inspectDiscoveredGithubCheck(
			tenant,
			{ repo: repository, branch: 'main' },
			capturingReporter([]),
			client,
			dependencies
		);
		expect({
			jobs: check.jobs,
			repairable: check.repairableJobs,
			probed
		}).toStrictEqual({
			jobs: [
				{
					caller: path,
					job: 'build',
					workflowRef:
						'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v0.0.35',
					status: 'unverified',
					findings: [{ finding: new PublicationUnmodelledFinding(reason) }]
				}
			],
			repairable: [],
			probed: []
		});
	}
);

it.each([
	{
		label: 'rootless Falcon grant',
		grants: [buildCacheContentReadGrant({ cache: 'falcon' })],
		status: 'ready',
		detail: new PassedCheckFinding('trust rule').toJSON()
	},
	{
		label: 'different cache grant',
		grants: [buildCacheContentReadGrant({ cache: 'other' })],
		status: 'failed',
		detail: {
			check: 'trust rule',
			status: 'failed',
			detail:
				'rule read matches the modelled claims but does not permit cache:content-read on cache falcon; add a rule with the required grant, or add a corrected rule and remove this one'
		}
	},
	{
		label: 'publication grant',
		grants: [
			buildCacheGrant({ cache: 'falcon', root: 'ci/', allow: ['push', 'root'] })
		],
		status: 'failed',
		detail: {
			check: 'trust rule',
			status: 'failed',
			detail:
				'rule read matches the modelled claims but does not permit cache:content-read on cache falcon; add a rule with the required grant, or add a corrected rule and remove this one'
		}
	}
])(
	'checks additional read authority with $label',
	async ({ grants, status, detail }) => {
		const { client, dependencies } = fixture({
			rules: [
				oidcTrustSummarySchema.parse({
					id: 'read',
					issuer: 'https://token.actions.githubusercontent.com',
					audience: tenant.href,
					claims: { repository_id: '1234', event_name: 'pull_request' },
					permittedGrants: grants,
					disabled: false
				})
			],
			dependencies: {
				source: {
					...source,
					read: () =>
						Promise.resolve(
							additionalReadWorkflow(`${tenant.href}/cache/falcon`)
						)
				},
				fetchCacheAccess: (target) =>
					Promise.resolve(
						target.pathname.endsWith('/falcon') ? 'private' : 'public'
					)
			}
		});
		const check = await inspectDiscoveredGithubCheck(
			tenant,
			{ repo: repository, branch: 'main' },
			capturingReporter([]),
			client,
			dependencies
		);
		expect(
			check.jobs.map((job) => ({
				...job,
				findings: job.findings.map(({ trigger, finding }) => ({
					trigger,
					finding: finding.toJSON()
				}))
			}))
		).toStrictEqual([
			{
				caller: path,
				job: 'build',
				workflowRef:
					'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v0.0.35',
				status,
				findings: [{ trigger: 'pull_request', finding: detail }]
			}
		]);
	}
);

it('composes read grants across matching rules for the exact additional cache union', async () => {
	const probed: string[] = [];
	const names = ['falcon', 'runner'];
	const { client, dependencies } = fixture({
		rules: names.map((cache) =>
			oidcTrustSummarySchema.parse({
				id: cache,
				issuer: 'https://token.actions.githubusercontent.com',
				audience: tenant.href,
				claims: { repository_id: '1234', event_name: 'pull_request' },
				permittedGrants: [buildCacheContentReadGrant({ cache })],
				disabled: false
			})
		),
		dependencies: {
			source: {
				...source,
				read: () =>
					Promise.resolve(
						additionalReadWorkflow(
							`|\n        ${tenant.href}/cache/falcon\n        ${tenant.href}/cache/runner\n        ${tenant.href}/cache/public\n        ${tenant.href}/cache/falcon/`
						)
					)
			},
			fetchCacheAccess: (target) => {
				probed.push(target.href);
				return Promise.resolve(
					target.pathname.endsWith('/public') || target.href === tenant.href
						? 'public'
						: 'private'
				);
			}
		}
	});
	const check = await inspectDiscoveredGithubCheck(
		tenant,
		{ repo: repository, branch: 'main' },
		capturingReporter([]),
		client,
		dependencies
	);
	expect({ jobs: check.jobs, probed }).toStrictEqual({
		jobs: [
			{
				caller: path,
				job: 'build',
				workflowRef:
					'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v0.0.35',
				status: 'ready',
				findings: [
					{
						trigger: 'pull_request',
						finding: new PassedCheckFinding('trust rule')
					}
				]
			}
		],
		probed: [
			tenant.href,
			...['falcon', 'runner', 'public'].map(
				(cache) => `${tenant.href}/cache/${cache}`
			)
		]
	});
});

it.each([undefined, "''", "'   '"])(
	'keeps the existing empty additional-read behaviour: %s',
	async (input) => {
		const probed: string[] = [];
		const { client, dependencies } = fixture({
			dependencies: {
				source: {
					...source,
					read: () =>
						Promise.resolve(
							additionalReadWorkflow(input ?? "''").replace(
								input === undefined ? "      read-caches: ''" : 'no match',
								''
							)
						)
				},
				fetchCacheAccess: (target) => {
					probed.push(target.href);
					return Promise.resolve('public');
				}
			}
		});
		const check = await inspectDiscoveredGithubCheck(
			tenant,
			{ repo: repository, branch: 'main' },
			capturingReporter([]),
			client,
			dependencies
		);
		expect({ jobs: check.jobs, probed }).toStrictEqual({
			jobs: [
				{
					caller: path,
					job: 'build',
					workflowRef:
						'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v0.0.35',
					status: 'ready',
					findings: []
				}
			],
			probed: [tenant.href]
		});
	}
);

it.each([false, true])(
	'models one exact additional-cache read union with static destination: %s',
	async (isStatic) => {
		const input = `|\n        ${tenant.href}/cache/falcon\n        ${tenant.href}/cache/public\n        ${tenant.href}/cache/falcon/`;
		const secrets = isStatic
			? "    secrets:\n      destination_read_user: '${{ secrets.USER }}'\n      destination_read_password: '${{ secrets.PASSWORD }}'"
			: '';
		const { client, dependencies } = fixture({
			dependencies: {
				source: {
					...source,
					read: () => Promise.resolve(additionalReadWorkflow(input, secrets))
				},
				fetchCacheAccess: (target) =>
					Promise.resolve(
						target.pathname.endsWith('/falcon') ? 'private' : 'public'
					)
			}
		});
		const check = await inspectDiscoveredGithubCheck(
			tenant,
			{ repo: repository, branch: 'main' },
			capturingReporter([]),
			client,
			dependencies
		);
		const job = check.repairableJobs[0];
		if (job === undefined) {
			throw new Error('Expected a job requiring Falcon read authority');
		}
		const publication = modelPublishingJob(job, check.identity, tenant, 'main')
			.cases[0];
		if (publication === undefined) {
			throw new Error('Expected one modelled pull-request case');
		}
		const read = await publicationReadAuthority(
			job,
			publication,
			tenant,
			check.identity.repositoryId,
			client,
			dependencies.fetchCacheAccess
		);
		const cacheState = (
			cache: string | undefined,
			access: 'public' | 'private'
		) => ({
			type: 'cupboard_cache',
			cache:
				cache === undefined
					? { kind: 'default' }
					: { kind: 'named', name: cache },
			mode: 'content',
			state: { kind: 'existing', access, priority: 40 }
		});
		expect(read).toStrictEqual({
			cache: { kind: 'default' },
			additionalCaches: [
				{ cache: { kind: 'named', name: 'falcon' }, access: 'private' },
				{ cache: { kind: 'named', name: 'public' }, access: 'public' }
			],
			cacheAccess: 'public',
			selectedViewAccess: 'public',
			cacheWiring: isStatic ? 'configured' : 'none',
			viewWiring: 'none',
			resources: [
				...(isStatic ? [] : [cacheState(undefined, 'public')]),
				cacheState('falcon', 'private'),
				cacheState('public', 'public')
			],
			requests: [
				[
					{
						type: 'cupboard_cache',
						actions: ['cache:content-read'],
						cache: { kind: 'named', name: 'falcon' }
					}
				]
			]
		});
	}
);

it.each([true, false])(
	'checks the simple workflow merged-close rule independently (configured: %s)',
	async (configured) => {
		const workflowReference =
			'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.35';
		const closeRule = oidcTrustSummarySchema.parse({
			...githubPrCloseAddBody(
				tenant,
				{
					repositoryId: 1234,
					repositoryOwnerId: 5678,
					fullName: repository,
					defaultBranch: 'main'
				},
				{
					repo: repository,
					jobWorkflowRef: workflowReference,
					cacheTemplate: 'pr-cache'
				}
			),
			id: 'simple-close',
			disabled: false
		});
		const { client, dependencies } = fixture({
			rules: configured ? [closeRule] : [],
			dependencies: {
				source: {
					...source,
					read: () =>
						Promise.resolve(`
on:
  pull_request:
    types: [opened, synchronize, reopened, closed]
jobs:
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      cache: pr-cache
      manage-pr-cache: true
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
			result.jobs.flatMap((job) =>
				job.findings.filter(({ trigger }) => trigger === 'merged-close')
			)
		).toStrictEqual([
			{
				trigger: 'merged-close',
				finding: configured
					? new PassedCheckFinding('trust rule')
					: new RepositoryTrustRuleMissingFinding('trust rule')
			}
		]);
	}
);

it.each([
	{ runRoot: false, attach: false, status: 'ready' },
	{ runRoot: true, attach: false, status: 'failed' },
	{ runRoot: true, attach: true, status: 'ready' }
])(
	'checks referenced simple workflow run-root=$runRoot with attachment grant=$attach',
	async ({ runRoot, attach, status }) => {
		const reference = `underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@${'b'.repeat(40)}`;
		const identity = {
			repositoryId: 1234,
			repositoryOwnerId: 5678,
			fullName: repository,
			defaultBranch: 'main'
		};
		const rule = oidcTrustSummarySchema.parse({
			id: 'branch',
			disabled: false,
			...githubBranchAddBody(tenant, identity, {
				repo: repository,
				branch: 'main',
				jobWorkflowRef: reference
			})
		});
		const selectedRule = {
			...rule,
			permittedGrants: rule.permittedGrants.map((grant) =>
				!attach && grant.type === 'cupboard_cache'
					? {
							...grant,
							actions: grant.actions.filter(
								(action) => action !== 'root:attach'
							)
						}
					: grant
			)
		};
		const caller = `on:\n  push:\n    branches: [main]\njobs:\n  publish:\n    uses: ${reference}\n    with:\n      url: ${tenant.href}\n      root: github:iainlane/dotfiles/main\n`;
		const dependencies = defaultDependencies(
			{ source: { ...source, read: () => Promise.resolve(caller) } },
			`${legacyPublishingWorkflow}${runRoot ? '        with:\n          run-root: "${{ inputs.root }}/_cupboard-run/${{ github.run_id }}"\n' : ''}`
		);
		const result = await inspectDiscoveredGithubCheck(
			tenant,
			{ repo: repository, branch: 'main' },
			capturingReporter([]),
			fixture({ rules: [selectedRule] }).client,
			dependencies
		);
		expect(
			result.jobs.map((job) => ({
				status: job.status,
				findings: job.findings.map(({ finding }) => ({
					status: finding.status,
					detail: finding.detail()
				}))
			}))
		).toStrictEqual([
			{
				status,
				findings:
					status === 'failed'
						? [
								{
									status: 'failed',
									detail:
										'rule branch matches the modelled claims but does not permit root:attach on cache (default) with root github:iainlane/dotfiles/main/x86_64-linux/_cupboard-run/1; add a rule with the required grant, or add a corrected rule and remove this one'
								}
							]
						: [
								{ status: 'ok', detail: undefined },
								{ status: 'ok', detail: undefined }
							]
			}
		]);
	}
);

it('warns about a repository rule whose audience is not the tenant URL', async () => {
	const rule = oidcTrustSummarySchema.parse({
		id: 'custom',
		issuer: 'https://token.actions.githubusercontent.com',
		audience: 'https://custom.example',
		claims: { repository_id: '1234', ref: 'refs/heads/main' },
		permittedGrants: [{ type: 'cupboard_wildcard' }],
		disabled: false
	});
	const otherRepository = oidcTrustSummarySchema.parse({
		...rule,
		id: 'other-repository',
		claims: { repository_id: '9999' }
	});
	const warnings: string[] = [];

	await inspectDiscoveredGithubCheck(
		tenant,
		{ repo: repository },
		capturingReporter([], [], warnings),
		fixture({ rules: [rule, otherRepository] }).client,
		defaultDependencies()
	);

	expect(warnings).toStrictEqual([
		"Trust rule custom expects the audience https://custom.example, which is not the tenant URL. The tenant refuses the tokens of jobs that request this audience, because a job token cannot have a target-bound nonce. To keep these jobs working, set the rule's audience and the audience input or --audience option of each job that uses the rule to https://cupboard.supply/t/laney."
	]);
});

it.each([
	{ label: 'without a view read grant', hasViewGrant: false },
	{ label: 'with a view read grant', hasViewGrant: true }
])(
	'checks the view read grant for publication from a private view read with a static credential, $label',
	async ({ hasViewGrant }) => {
		const view = reuseViewSummarySchema.parse({
			name: 'pull-requests-1234',
			access: 'private',
			selectors: [{ kind: 'prefix', prefix: 'gh-1234-pr-' }],
			priority: 70,
			revision: 1,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z'
		});
		const rule = oidcTrustSummarySchema.parse({
			id: 'branch',
			issuer: 'https://token.actions.githubusercontent.com',
			audience: tenant.href,
			claims: { repository_id: '1234', ref: 'refs/heads/main' },
			permittedGrants: [
				buildCacheGrant({
					cache: 'packages',
					root: 'builds/',
					allow: ['push', 'attest', 'root', 'attach']
				}),
				...(hasViewGrant
					? [buildViewContentReadGrant('pull-requests-1234')]
					: [])
			],
			disabled: false
		});
		const { client, dependencies } = fixture({
			rules: [rule],
			views: [view],
			dependencies: {
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
    secrets:
      read_user: \${{ secrets.READ_USER }}
      read_password: \${{ secrets.READ_PASSWORD }}
`)
				},
				fetchCacheAccess: () => Promise.resolve('public'),
				fetchCacheInfo: (url) => {
					const priority = cachePrioritySchema.parse(
						url.pathname.includes('/reuse/') ? 70 : 40
					);

					return Promise.resolve(
						new CacheInfo(servedStoreDirectory, true, priority)
					);
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
				findings: job.findings.map(({ trigger, finding }) => ({
					...(trigger !== undefined && { trigger }),
					finding: finding.toJSON()
				}))
			}))
		).toStrictEqual([
			{
				status: hasViewGrant ? 'ready' : 'failed',
				findings: [
					{
						finding: {
							check: 'reuse view',
							status: 'ok',
							detail:
								'the check verifies the priority and store directory of reuse view pull-requests-1234, not the caches that its selectors include'
						}
					},
					...(hasViewGrant
						? [
								{
									trigger: 'push',
									finding: { check: 'trust rule', status: 'ok' }
								},
								{
									trigger: 'push',
									finding: { check: 'root grant', status: 'ok' }
								}
							]
						: [
								{
									trigger: 'push',
									finding: {
										check: 'trust rule',
										status: 'failed',
										detail:
											'rule branch matches the modelled claims but does not permit view:content-read on view pull-requests-1234; add a rule with the required grant, or add a corrected rule and remove this one'
									}
								}
							]),
					{
						trigger: 'push',
						finding: {
							check: 'read authentication',
							status: 'ok',
							detail:
								'the workflow declares a complete view read-secret pair; secret values are not inspected'
						}
					},
					{ trigger: 'push', finding: { check: 'reuse view', status: 'ok' } }
				]
			}
		]);
	}
);
