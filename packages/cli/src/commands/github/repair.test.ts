import { readFile } from 'node:fs/promises';
import { Writable } from 'node:stream';

import { createCliUi } from '@cupboard/cli-ui';
import { type CliUiScript, fakeCliUi } from '@cupboard/cli-ui/testing';
import {
	CacheInfo,
	servedStoreDirectory
} from '@cupboard/nix-store/cache-info';
import {
	type CacheAccessMode,
	cacheNameSchema,
	cachePrioritySchema,
	rootNameSchema
} from '@cupboard/nix-store/scalars';
import { cacheListResponseSchema } from '@cupboard/protocol/caches';
import {
	type OidcTrustAddBodyInput,
	oidcTrustListResponseSchema,
	type OidcTrustSummary,
	oidcTrustSummarySchema
} from '@cupboard/protocol/oidc';
import {
	reuseViewListResponseSchema,
	type ReuseViewSummary,
	reuseViewSummarySchema
} from '@cupboard/protocol/reuse-views';
import { ORPCError } from '@orpc/client';
import { expect, it } from 'vitest';

import { audienceSchema } from '../../audience.ts';
import {
	attestAttachAuthorizationDetails,
	cacheCreateAuthorizationDetails,
	cacheLifecycleAuthorizationDetails,
	pushAuthorizationDetails
} from '../../auth/attenuate.ts';
import {
	CliAbortError,
	GithubCheckFailedError,
	GithubCheckIncompleteError,
	GithubCheckOptionError
} from '../../errors.ts';
import {
	githubBranchAddBody,
	githubPrAddBody,
	githubPrCloseAddBody,
	type OidcTrustClient
} from '../oidc-trust.ts';
import {
	buildAddBody,
	buildCacheContentReadGrant,
	buildCacheGrant,
	collectSubstitutions,
	jobWorkflowReferenceClaim
} from '../oidc-trust/rule-builder.ts';
import { type ReuseViewClient } from '../reuse-view.ts';

import { activeMatcherRules, checkTrustRule } from './check.ts';
import {
	githubBranchClaims,
	githubMergedPullRequestClaims,
	githubPullRequestClaims
} from './claims.ts';
import {
	DiscoveryUnverifiedFinding,
	inspectDiscoveredGithubCheck
} from './discovered-check.ts';
import {
	GithubRepairPartialError,
	GithubRepairShadowsRuleError,
	GithubRepairStateChangedError,
	GithubRepairUnavailableError,
	offerDiscoveredGithubRepair,
	runDiscoveredGithubRepair
} from './repair.ts';

const url = new URL('https://cupboard.supply/t/laney');
const repository = 'iainlane/dotfiles';
const path = '.github/workflows/publish.yml';
const content = `
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
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      cache: systems
`;
const legacyPublishingWorkflow =
	'on: workflow_call\njobs:\n  publish:\n    steps:\n      - uses: $/actions/push\n';
const unmergedBranchContent = content.replace(
	'branches: [main]',
	'branches: [feature/publish]'
);

function mainBranchRule(cache?: string): OidcTrustAddBodyInput {
	return buildAddBody({
		issuer: 'https://token.actions.githubusercontent.com',
		audience: url.href,
		claims: {
			repository_id: '1234',
			repository_owner_id: '5678',
			ref: 'refs/heads/main',
			job_workflow_ref:
				'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.35'
		},
		permittedGrants: [
			buildCacheGrant({
				...(cache !== undefined && { cache }),
				allow: ['push', 'attest']
			})
		],
		display: { provider: 'github', repository }
	});
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}

	return;
}

async function fixture(
	script?: CliUiScript,
	workflowContent = content,
	options: {
		branch?: string;
		defaultBranch?: string;
		rules?: readonly OidcTrustSummary[];
		views?: readonly ReuseViewSummary[];
		cacheAccess?: CacheAccessMode;
		publishingWorkflow?: string;
		fetchCacheAccess?: (target: URL) => Promise<CacheAccessMode>;
	} = {}
) {
	const { ui, captured } = fakeCliUi(
		script ?? { interactive: true, confirm: 'yes' }
	);
	const added: OidcTrustAddBodyInput[] = [];
	const extended: {
		expected: OidcTrustSummary;
		permittedGrants: OidcTrustAddBodyInput['permittedGrants'];
	}[] = [];
	const verified: string[] = [];
	const rules: unknown[] = [...(options.rules ?? [])];
	let revision = 'a'.repeat(40);
	const source = {
		resolveBranch: () => Promise.resolve(revision),
		resolveWorkflowReference: (_repository: string, reference: string) =>
			Promise.resolve(
				reference === 'main' ? 'refs/heads/main' : `refs/tags/${reference}`
			),
		list: () => Promise.resolve([path]),
		read: (selectedRepository: string) =>
			Promise.resolve(
				selectedRepository === 'underwhelmingperformance/cupboard'
					? (options.publishingWorkflow ?? legacyPublishingWorkflow)
					: workflowContent
			)
	};
	const client = {
		caches: {
			list: () => Promise.resolve(cacheListResponseSchema.parse({ caches: [] }))
		},
		reuseViews: {
			list: () =>
				Promise.resolve(
					reuseViewListResponseSchema.parse({ views: options.views ?? [] })
				),
			set: () => Promise.reject(new Error('unexpected view write'))
		},
		oidcTrust: {
			list: () => Promise.resolve(oidcTrustListResponseSchema.parse({ rules })),
			add: (body: Parameters<OidcTrustClient['add']>[0]) => {
				added.push(body);
				const parsed = oidcTrustListResponseSchema.parse({
					rules: [{ ...body, id: 'new-rule', disabled: false }]
				});
				const [rule] = parsed.rules;

				if (rule === undefined) {
					throw new Error('expected a parsed trust rule');
				}

				rules.push(rule);
				return Promise.resolve(rule);
			},
			extend: (input: {
				id: string;
				expected: OidcTrustSummary;
				permittedGrants: OidcTrustAddBodyInput['permittedGrants'];
			}) => {
				extended.push({
					expected: input.expected,
					permittedGrants: input.permittedGrants
				});
				const index = rules.findIndex(
					(rule) => oidcTrustSummarySchema.parse(rule).id === input.id
				);
				const summary = oidcTrustSummarySchema.parse({
					...input.expected,
					permittedGrants: [
						...input.expected.permittedGrants,
						...input.permittedGrants
					]
				});
				rules[index] = summary;
				return Promise.resolve(summary);
			},
			remove: () => Promise.reject(new Error('unexpected rule removal'))
		}
	};
	const dependencies = {
		source,
		lookupRepository: () =>
			Promise.resolve({
				repositoryId: 1234,
				repositoryOwnerId: 5678,
				fullName: repository,
				defaultBranch: options.defaultBranch ?? 'main'
			}),
		verifyWorkflowReference: (reference: { reference: string }) => {
			verified.push(reference.reference);
			return Promise.resolve();
		},
		fetchCacheInfo: (target: URL) => {
			const priority = cachePrioritySchema.parse(
				target.pathname.includes('/reuse/') ? 50 : 40
			);

			return Promise.resolve(
				new CacheInfo(servedStoreDirectory, true, priority)
			);
		},
		fetchCacheAccess:
			options.fetchCacheAccess ??
			(() => Promise.resolve(options.cacheAccess ?? 'public'))
	};
	const check = await inspectDiscoveredGithubCheck(
		url,
		{ repo: repository, branch: options.branch ?? 'main' },
		ui.reporter(),
		client,
		dependencies
	);

	return {
		ui,
		captured,
		added,
		extended,
		verified,
		client,
		dependencies,
		check,
		changeRevision: (value: string) => {
			revision = value;
		}
	};
}

it('plans one rule for both publishing jobs and applies it after review', async () => {
	const { ui, captured, added, verified, client, dependencies, check } =
		await fixture();

	await runDiscoveredGithubRepair(
		url,
		{ trustScope: 'exact' },
		ui,
		client,
		dependencies,
		check
	);

	expect(verified).toStrictEqual([
		'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.35',
		'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.35'
	]);

	const summary = {
		added: added.map((body) => ({
			workflow: body.claims.job_workflow_ref,
			caches: body.permittedGrants.map((grant) =>
				grant.type === 'cupboard_cache' ? grant.resources.cache : grant.type
			)
		})),
		confirms: captured.confirms.map((entry) => entry.message),
		notes: captured.notes.map((entry) => entry.title)
	};

	expect(summary).toStrictEqual({
		added: [
			{
				workflow:
					'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.35',
				caches: [
					{ kind: 'named', exact: 'packages', validate: 'cacheName' },
					{ kind: 'named', exact: 'systems', validate: 'cacheName' }
				]
			}
		],
		confirms: ['Apply this tenant configuration?'],
		notes: ['Planned GitHub repair']
	});
});

it('repairs a private read-only pull request with a content-read grant only', async () => {
	const readOnlyWorkflow = `
on: pull_request
jobs:
  build:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      preset: pull-request-and-branch
      push: false
`;
	const { ui, added, client, dependencies, check } = await fixture(
		{ interactive: true, confirm: 'yes' },
		readOnlyWorkflow,
		{ cacheAccess: 'private' }
	);

	await runDiscoveredGithubRepair(
		url,
		{ trustScope: 'exact' },
		ui,
		client,
		dependencies,
		check
	);

	expect(
		added.map((body) => ({
			claims: body.claims,
			permittedGrants: body.permittedGrants
		}))
	).toStrictEqual([
		{
			claims: {
				repository_id: '1234',
				repository_owner_id: '5678',
				event_name: 'pull_request',
				job_workflow_ref:
					'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v0.0.35'
			},
			permittedGrants: [buildCacheContentReadGrant({})]
		}
	]);
});

it('repairs publication grants without adding read authority for a declared static pair', async () => {
	const staticWorkflow = `
on:
  push:
    branches: [main]
jobs:
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      cache: packages
    secrets:
      destination_read_user: \${{ secrets.CACHE_USER }}
      destination_read_password: \${{ secrets.CACHE_PASSWORD }}
`;
	const { ui, added, client, dependencies, check } = await fixture(
		{ interactive: true, confirm: 'yes' },
		staticWorkflow,
		{ cacheAccess: 'private' }
	);

	expect(check.repairableJobs.map(({ job }) => job)).toStrictEqual(['publish']);
	await runDiscoveredGithubRepair(
		url,
		{ trustScope: 'exact' },
		ui,
		client,
		dependencies,
		check
	);
	expect(added.map(({ permittedGrants }) => permittedGrants)).toStrictEqual([
		[buildCacheGrant({ cache: 'packages', allow: ['push', 'attest'] })]
	]);
});

it('shows that a repair retains a matching rule with insufficient grants', async () => {
	const stale = oidcTrustSummarySchema.parse({
		id: 'stale',
		issuer: 'https://token.actions.githubusercontent.com',
		audience: url.href,
		claims: { repository_id: '1234', ref: 'refs/heads/main' },
		permittedGrants: [buildCacheGrant({ cache: 'other', allow: ['push'] })],
		disabled: false
	});
	const { ui, captured, added, client, dependencies, check } = await fixture(
		{ interactive: true, confirm: 'yes' },
		content,
		{ rules: [stale] }
	);

	await runDiscoveredGithubRepair(
		url,
		{ trustScope: 'exact' },
		ui,
		client,
		dependencies,
		check
	);
	const listed = await client.oidcTrust.list();

	expect({
		ruleIds: listed.rules.map((rule) => rule.id),
		added: added.length,
		preview: captured.notes[0]?.body.split('\n', 1)[0]
	}).toStrictEqual({
		ruleIds: ['stale', 'new-rule'],
		added: 1,
		preview:
			'Keep existing rule\tstale does not grant every operation that the discovered jobs request. The repair adds a planned rule that grants them and has more claims than stale. stale stays active, but the server selects the planned rule for the runs that both rules match.'
	});
});

it('repairs a schedule for the repository default branch', async () => {
	const workflowContent = `
on: schedule
jobs:
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
`;
	const { ui, captured, added, client, dependencies, check } = await fixture(
		undefined,
		workflowContent,
		{ branch: 'feature/add-schedule', defaultBranch: 'main' }
	);

	await runDiscoveredGithubRepair(
		url,
		{ trustScope: 'exact' },
		ui,
		client,
		dependencies,
		check
	);

	expect({
		added,
		confirms: captured.confirms.map((entry) => entry.message)
	}).toStrictEqual({
		added: [
			buildAddBody({
				issuer: 'https://token.actions.githubusercontent.com',
				audience: url.href,
				claims: {
					repository_id: '1234',
					repository_owner_id: '5678',
					ref: 'refs/heads/main',
					job_workflow_ref:
						'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.35'
				},
				permittedGrants: [buildCacheGrant({ allow: ['push', 'attest'] })],
				display: { provider: 'github', repository }
			})
		],
		confirms: ['Apply this tenant configuration?']
	});
});

it('shows the claims, cache, root and actions before confirmation', async () => {
	const workflowContent = `
on:
  push:
    branches: [main]
    tags: ['v1.2.3']
jobs:
  packages:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      cache: packages
      root: builds
`;
	const { ui, captured, client, dependencies, check } = await fixture(
		undefined,
		workflowContent
	);

	await runDiscoveredGithubRepair(
		url,
		{ trustScope: 'exact' },
		ui,
		client,
		dependencies,
		check
	);
	const grantFields = `actions:
  - upload:negotiate
  - upload:status
  - upload:commit
  - upload:confirm
  - attestation:negotiate
  - attestation:attach
  - root:set
  - root:list
resources:
  cache:
    kind: named
    exact: packages
    validate: cacheName
  root:
    exact: builds/
    validate: rootName`
		.split('\n')
		.map((line) => `\t${line}`);
	const grantLines = (number: number): string[] => [
		`Grant ${String(number)}.1\tcupboard_cache`,
		...grantFields
	];

	expect(captured.notes).toStrictEqual([
		{
			title: 'Planned GitHub repair',
			body: [
				'Add planned rule 1\trepository ID 1234, ref refs/heads/main; workflow underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.35',
				...grantLines(1),
				'Add planned rule 2\trepository ID 1234, ref refs/tags/v1.2.3; workflow underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.35',
				...grantLines(2),
				'Checked jobs\tThe repair checked the planned rules against the discovered jobs on main. It does not read workflow files at tags or on other branches.'
			].join('\n')
		}
	]);
});

it('reports applied rules when a later tenant write fails', async () => {
	const workflowContent = `
on:
  push:
    branches: [main]
    tags: ['v1.2.3']
jobs:
  packages:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      cache: packages
`;
	const { ui, added, client, dependencies, check } = await fixture(
		undefined,
		workflowContent
	);
	let attempts = 0;
	const failingClient = {
		...client,
		oidcTrust: {
			...client.oidcTrust,
			add: (body: OidcTrustAddBodyInput) => {
				attempts += 1;

				return attempts === 2
					? Promise.reject(new Error('write failed'))
					: client.oidcTrust.add(body);
			}
		}
	};

	const error = await rejection(
		runDiscoveredGithubRepair(
			url,
			{ trustScope: 'exact' },
			ui,
			failingClient,
			dependencies,
			check
		)
	);

	expect({
		partial:
			error instanceof GithubRepairPartialError
				? { step: error.step, applied: error.applied }
				: error,
		added
	}).toStrictEqual({
		partial: { step: 'add trust rule 2', applied: ['trust rule new-rule'] },
		added: [mainBranchRule('packages')]
	});
});

it('reports prior writes after cancellation with exit status 130', async () => {
	const workflowContent = `
on:
  push:
    branches: [main]
    tags: ['v1.2.3']
jobs:
  packages:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      cache: packages
`;
	const { ui, added, client, dependencies, check } = await fixture(
		undefined,
		workflowContent
	);
	const aborted = new CliAbortError();
	let attempts = 0;
	const abortingClient = {
		...client,
		oidcTrust: {
			...client.oidcTrust,
			add: (body: OidcTrustAddBodyInput) => {
				attempts += 1;

				return attempts === 2
					? Promise.reject(aborted)
					: client.oidcTrust.add(body);
			}
		}
	};

	const error = await rejection(
		runDiscoveredGithubRepair(
			url,
			{ trustScope: 'exact' },
			ui,
			abortingClient,
			dependencies,
			check
		)
	);
	expect(
		error instanceof GithubRepairPartialError
			? {
					applied: error.applied,
					cause: error.cause,
					isUnconfirmed: error.isUnconfirmed,
					exitCode: error.exitCode
				}
			: error
	).toStrictEqual({
		applied: ['trust rule new-rule'],
		cause: aborted,
		isUnconfirmed: true,
		exitCode: 130
	});
	expect(added).toStrictEqual([mainBranchRule('packages')]);
});

it('reports a failed post-write check as a verification failure', async () => {
	const { ui, client, dependencies, check } = await fixture();
	const staleClient = {
		...client,
		oidcTrust: {
			...client.oidcTrust,
			add: (body: OidcTrustAddBodyInput) =>
				Promise.resolve(
					oidcTrustSummarySchema.parse({
						...body,
						id: 'unavailable',
						disabled: false
					})
				)
		}
	};

	const error = await rejection(
		runDiscoveredGithubRepair(
			url,
			{ trustScope: 'exact' },
			ui,
			staleClient,
			dependencies,
			check
		)
	);

	expect(
		error instanceof GithubRepairPartialError
			? {
					step: error.step,
					applied: error.applied,
					isCheckFailure: error.cause instanceof GithubCheckFailedError
				}
			: error
	).toStrictEqual({
		step: 'verify the tenant after writing',
		applied: ['trust rule unavailable'],
		isCheckFailure: true
	});
});

it('rejects a tag pattern that excludes the current release', async () => {
	const { ui, added, client, dependencies, check } = await fixture();

	await expect(
		runDiscoveredGithubRepair(
			url,
			{
				trustScope: 'tag-pattern',
				tagPattern: 'v1*'
			},
			ui,
			client,
			dependencies,
			check
		)
	).rejects.toBeInstanceOf(GithubCheckOptionError);

	expect(added).toStrictEqual([]);
});

it('applies a selected release tag pattern to all matching jobs', async () => {
	const { ui, added, client, dependencies, check } = await fixture();

	await runDiscoveredGithubRepair(
		url,
		{
			trustScope: 'tag-pattern',
			tagPattern: 'v*'
		},
		ui,
		client,
		dependencies,
		check
	);

	expect(
		added.map((body) => ({
			workflow: body.claims.job_workflow_ref,
			grants: body.permittedGrants.length
		}))
	).toStrictEqual([
		{
			workflow: jobWorkflowReferenceClaim(
				'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v*'
			),
			grants: 2
		}
	]);
});

it('rejects a release tag pattern for a commit-pinned workflow', async () => {
	const pinned = content.replaceAll('@v0.0.35', () => `@${'a'.repeat(40)}`);
	const { ui, client, dependencies, check } = await fixture(undefined, pinned);

	await expect(
		runDiscoveredGithubRepair(
			url,
			{
				trustScope: 'tag-pattern',
				tagPattern: 'v*'
			},
			ui,
			client,
			dependencies,
			check
		)
	).rejects.toBeInstanceOf(GithubCheckOptionError);
});

it('does not offer a tag pattern for a commit-pinned workflow', async () => {
	const pinned = content.replaceAll('@v0.0.35', () => `@${'a'.repeat(40)}`);
	const { ui, captured, client, dependencies, check } = await fixture(
		{ interactive: true, menu: 'tag-pattern' },
		pinned
	);

	await expect(
		runDiscoveredGithubRepair(url, {}, ui, client, dependencies, check)
	).rejects.toBeInstanceOf(GithubCheckFailedError);

	expect(captured.cancellations).toStrictEqual([
		'Repair cancelled. The tenant is unchanged.'
	]);
});

it('reports a cancelled tag-pattern prompt without a usage error', async () => {
	const { ui, captured, client, dependencies, check } = await fixture({
		interactive: true,
		menu: 'tag-pattern'
	});

	await expect(
		runDiscoveredGithubRepair(url, {}, ui, client, dependencies, check)
	).rejects.toBeInstanceOf(GithubCheckFailedError);

	expect(captured.cancellations).toStrictEqual([
		'Repair cancelled. The tenant is unchanged.'
	]);
});

it('asks for a tag pattern after an interactive scope choice', async () => {
	const { ui, added, client, dependencies, check } = await fixture({
		interactive: true,
		menu: 'tag-pattern',
		prefixedText: 'v*',
		confirm: 'yes'
	});

	await runDiscoveredGithubRepair(url, {}, ui, client, dependencies, check);

	expect(added.map((body) => body.claims.job_workflow_ref)).toStrictEqual([
		jobWorkflowReferenceClaim(
			'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v*'
		)
	]);
});

it('rejects a tag pattern when the existing trust rules already authorise every job', async () => {
	const { ui, client, dependencies, check } = await fixture();

	await runDiscoveredGithubRepair(
		url,
		{ trustScope: 'exact' },
		ui,
		client,
		dependencies,
		check
	);

	await expect(
		runDiscoveredGithubRepair(
			url,
			{
				trustScope: 'tag-pattern',
				tagPattern: 'v*'
			},
			ui,
			client,
			dependencies,
			check
		)
	).rejects.toBeInstanceOf(GithubCheckOptionError);
});

it('stops without writing when the selected branch changes during review', async () => {
	const { ui, added, client, dependencies, check, changeRevision } =
		await fixture();
	changeRevision('b'.repeat(40));

	await expect(
		runDiscoveredGithubRepair(
			url,
			{ trustScope: 'exact' },
			ui,
			client,
			dependencies,
			check
		)
	).rejects.toBeInstanceOf(GithubRepairStateChangedError);

	expect(added).toStrictEqual([]);
});

it('returns an error for --fix when every discovered failure needs manual review', async () => {
	const { ui, added, client, dependencies, check } = await fixture();
	const jobs = check.jobs.map((job) => ({
		...job,
		status: 'unverified' as const,
		findings: [{ finding: new DiscoveryUnverifiedFinding('manual review') }]
	}));
	const error = await rejection(
		runDiscoveredGithubRepair(
			url,
			{ trustScope: 'exact' },
			ui,
			client,
			dependencies,
			{ ...check, jobs, repairableJobs: [] }
		)
	);

	expect({
		error:
			error instanceof GithubCheckIncompleteError
				? { checks: error.checks, exitCode: error.exitCode }
				: error,
		added
	}).toStrictEqual({
		error: {
			checks: jobs.map((job) => `${job.caller}, ${job.job}`),
			exitCode: 69
		},
		added: []
	});
});

it('keeps a failed check unsuccessful when the repair is declined', async () => {
	const { ui, added, client, dependencies, check } = await fixture({
		confirm: 'no'
	});

	await expect(
		runDiscoveredGithubRepair(
			url,
			{ trustScope: 'exact' },
			ui,
			client,
			dependencies,
			check
		)
	).rejects.toBeInstanceOf(GithubCheckFailedError);

	expect(added).toStrictEqual([]);
});

it('repairs a missing preset view without asking for a trust scope or adding rules', async () => {
	const { ui, captured } = fakeCliUi({ confirm: 'yes' });
	const identity = {
		repositoryId: 1234,
		repositoryOwnerId: 5678,
		fullName: repository,
		defaultBranch: 'main'
	};
	const workflowReference =
		'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v0.0.35';
	const prBody = githubPrAddBody(url, identity, {
		repo: repository,
		jobWorkflowRef: workflowReference
	});
	const branchBody = githubBranchAddBody(url, identity, {
		repo: repository,
		branch: 'main',
		jobWorkflowRef: workflowReference
	});
	const rules = oidcTrustListResponseSchema.parse({
		rules: [
			{ ...prBody, id: 'pr', disabled: false },
			{
				...githubPrCloseAddBody(url, identity, {
					repo: repository,
					jobWorkflowRef: workflowReference
				}),
				id: 'pr-close',
				disabled: false
			},
			{ ...branchBody, id: 'branch', disabled: false }
		]
	}).rules;
	const views: unknown[] = [];
	const added: OidcTrustAddBodyInput[] = [];
	const source = {
		resolveBranch: () => Promise.resolve('a'.repeat(40)),
		list: () => Promise.resolve([path]),
		read: () =>
			Promise.resolve(`
on:
  push:
    branches: [main]
  pull_request:
    types: [opened, synchronize, reopened, closed]
jobs:
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      preset: pull-request-and-branch
`)
	};
	const client = {
		caches: {
			list: () => Promise.resolve(cacheListResponseSchema.parse({ caches: [] }))
		},
		reuseViews: {
			list: () => Promise.resolve(reuseViewListResponseSchema.parse({ views })),
			set: (input: Parameters<ReuseViewClient['set']>[0]) => {
				const view = reuseViewSummarySchema.parse({
					...input,
					revision: 1,
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z'
				});
				views.push(view);
				return Promise.resolve(view);
			}
		},
		oidcTrust: {
			list: () => Promise.resolve({ rules }),
			extend: () => Promise.reject(new Error('unexpected trust extension')),
			add: (body: OidcTrustAddBodyInput) => {
				added.push(body);
				return Promise.reject(new Error('unexpected trust write'));
			}
		}
	};
	const dependencies = {
		source,
		lookupRepository: () => Promise.resolve(identity),
		verifyWorkflowReference: () => Promise.resolve(),
		fetchCacheInfo: (target: URL) => {
			const priority = target.pathname.includes('/reuse/') ? 50 : 40;

			return Promise.resolve(
				new CacheInfo(
					servedStoreDirectory,
					true,
					cachePrioritySchema.parse(priority)
				)
			);
		},
		fetchCacheAccess: () => Promise.resolve('public' as const)
	};
	const check = await inspectDiscoveredGithubCheck(
		url,
		{ repo: repository, branch: 'main' },
		ui.reporter(),
		client,
		dependencies
	);

	await runDiscoveredGithubRepair(url, {}, ui, client, dependencies, check);

	expect({
		added,
		views,
		confirms: captured.confirms.map((entry) => entry.message)
	}).toStrictEqual({
		added: [],
		views: [
			{
				name: 'pull-requests-1234',
				access: 'public',
				selectors: [{ kind: 'prefix', prefix: 'gh-1234-pr-' }],
				priority: 50,
				revision: 1,
				createdAt: '2026-01-01T00:00:00.000Z',
				updatedAt: '2026-01-01T00:00:00.000Z'
			}
		],
		confirms: ['Apply this tenant configuration?']
	});
});

it.each([
	{
		name: 'an installable job that skips signing',
		trigger: `on:
  push:
    branches: [main]`,
		inputs: `      cache: packages
      attest: false`,
		ref: 'refs/heads/main',
		grant: buildCacheGrant({ cache: 'packages', allow: ['push', 'attest'] })
	},
	{
		name: 'a tag-only publishing workflow',
		trigger: `on:
  push:
    tags: ['v1.2.3']`,
		inputs: '',
		ref: 'refs/tags/v1.2.3',
		grant: buildCacheGrant({ allow: ['push', 'attest'] })
	}
])('adds the rule for $name', async ({ trigger, inputs, ref, grant }) => {
	const { ui, added, client, dependencies, check } = await fixture(
		undefined,
		`
${trigger}
jobs:
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
${inputs}
`
	);

	await runDiscoveredGithubRepair(
		url,
		{ trustScope: 'exact' },
		ui,
		client,
		dependencies,
		check
	);

	expect(added).toStrictEqual([
		buildAddBody({
			issuer: 'https://token.actions.githubusercontent.com',
			audience: url.href,
			claims: {
				repository_id: '1234',
				repository_owner_id: '5678',
				ref,
				job_workflow_ref:
					'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.35'
			},
			permittedGrants: [grant],
			display: { provider: 'github', repository }
		})
	]);
});

it.each([
	{ name: 'unfiltered pushes', trigger: 'on: push', status: 'failed' },
	{
		name: 'wildcard tags',
		trigger: `on:
  push:
    tags: ['v*']`,
		status: 'unverified'
	}
])(
	'does not offer a partial trust repair for $name',
	async ({ trigger, status }) => {
		const { ui, added, client, dependencies, check } = await fixture(
			undefined,
			`
${trigger}
jobs:
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
`
		);
		const error = await rejection(
			runDiscoveredGithubRepair(
				url,
				{ trustScope: 'exact' },
				ui,
				client,
				dependencies,
				check
			)
		);

		expect({
			status: check.jobs.map((job) => job.status),
			error:
				error instanceof GithubRepairUnavailableError
					? { problem: error.problem, exitCode: error.exitCode }
					: error instanceof GithubCheckIncompleteError
						? { checks: error.checks, exitCode: error.exitCode }
						: error,
			added
		}).toStrictEqual({
			status: [status],
			error:
				status === 'failed'
					? { problem: 'no-repairable-job', exitCode: 1 }
					: { checks: [`${path}, publish`], exitCode: 69 },
			added: []
		});
	}
);

const customViewWorkflow = `
on:
  push:
    branches: [main]
jobs:
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      preset: pull-request-and-branch
      reuse-view: shared
`;

it('keeps an existing custom reuse view while repairing trust', async () => {
	const view = reuseViewSummarySchema.parse({
		name: 'shared',
		access: 'public',
		selectors: [{ kind: 'prefix', prefix: 'gh-' }],
		priority: 50,
		revision: 1,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z'
	});
	const { ui, added, client, dependencies, check } = await fixture(
		undefined,
		customViewWorkflow,
		{ views: [view] }
	);

	await runDiscoveredGithubRepair(
		url,
		{ trustScope: 'exact' },
		ui,
		client,
		dependencies,
		check
	);

	expect(added).toStrictEqual([
		githubBranchAddBody(url, check.identity, {
			repo: repository,
			branch: 'main',
			jobWorkflowRef:
				'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v0.0.35'
		})
	]);
});

it.each([
	{
		name: 'a custom reuse view that the tenant does not define',
		workflow: customViewWorkflow
	},
	{
		name: 'a pull-request rule for a job without the preset',
		workflow: `
on: [push, pull_request]
jobs:
  packages:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
`
	}
])('returns an error without writing for $name', async ({ workflow }) => {
	const { ui, added, client, dependencies, check } = await fixture(
		undefined,
		workflow
	);
	const error = await rejection(
		runDiscoveredGithubRepair(
			url,
			{ trustScope: 'exact' },
			ui,
			client,
			dependencies,
			check
		)
	);

	expect({
		problem:
			error instanceof GithubRepairUnavailableError ? error.problem : error,
		added
	}).toStrictEqual({ problem: 'no-repairable-job', added: [] });
});

it('repairs the jobs that it can and still reports an unverified job', async () => {
	const { ui, added, client, dependencies, check } = await fixture(
		undefined,
		`
on:
  push:
    branches: [main]
jobs:
  packages:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      cache: packages
  dynamic:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: \${{ vars.CUPBOARD_URL }}
`
	);
	const error = await rejection(
		runDiscoveredGithubRepair(
			url,
			{ trustScope: 'exact' },
			ui,
			client,
			dependencies,
			check
		)
	);

	expect({
		incomplete:
			error instanceof GithubCheckIncompleteError ? error.checks : error,
		added
	}).toStrictEqual({
		incomplete: [`${path}, dynamic`],
		added: [mainBranchRule('packages')]
	});
});

it.each([
	{
		name: 'runs the requested repair without a prompt',
		script: { interactive: false },
		isFixRequested: true,
		expected: { repairs: 1, confirms: [], failure: undefined }
	},
	{
		name: 'runs the repair that an operator accepts',
		script: { interactive: true, confirm: 'yes' as const },
		isFixRequested: false,
		expected: {
			repairs: 1,
			confirms: ['Review a repair for the reported failures?'],
			failure: undefined
		}
	},
	{
		name: 'keeps the check failed when an operator declines',
		script: { interactive: true, confirm: 'no' as const },
		isFixRequested: false,
		expected: {
			repairs: 0,
			confirms: ['Review a repair for the reported failures?'],
			failure: GithubCheckFailedError
		}
	},
	{
		name: 'keeps the check failed when an operator cancels',
		script: { interactive: true, confirm: 'cancelled' as const },
		isFixRequested: false,
		expected: {
			repairs: 0,
			confirms: ['Review a repair for the reported failures?'],
			failure: GithubCheckFailedError
		}
	},
	{
		name: 'does not offer a repair without a terminal',
		script: { interactive: false },
		isFixRequested: false,
		expected: { repairs: 0, confirms: [], failure: GithubCheckFailedError }
	}
])('$name', async ({ script, isFixRequested, expected }) => {
	const { check } = await fixture();
	const { ui, captured } = fakeCliUi(script);
	let repairs = 0;
	const failure = await rejection(
		offerDiscoveredGithubRepair(check, ui, isFixRequested, () => {
			repairs += 1;
			return Promise.resolve();
		})
	);

	expect({
		repairs,
		confirms: captured.confirms.map((entry) => entry.message),
		failure: failure instanceof Error ? failure.constructor : failure
	}).toStrictEqual(expected);
});

const presetPushWorkflow = `
on:
  push:
    branches: [main]
jobs:
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      preset: pull-request-and-branch
`;

it.each([
	{ name: 'a trust rule is added', change: 'rules', workflow: content },
	{ name: 'a reuse view is added', change: 'views', workflow: content },
	{
		name: 'the destination priority changes',
		change: 'destination',
		workflow: presetPushWorkflow
	}
])(
	'stops without writing when $name during review',
	async ({ change, workflow }) => {
		const { ui, added, client, dependencies, check } = await fixture(
			undefined,
			workflow
		);
		let isReviewed = false;
		const extraView = reuseViewSummarySchema.parse({
			name: 'shared',
			access: 'public',
			selectors: [{ kind: 'prefix', prefix: 'gh-' }],
			priority: 60,
			revision: 1,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z'
		});
		const extraRule = oidcTrustSummarySchema.parse({
			id: 'concurrent',
			issuer: 'https://token.actions.githubusercontent.com',
			audience: url.href,
			claims: { repository_id: '9999' },
			permittedGrants: [{ type: 'cupboard_wildcard' }],
			disabled: false
		});
		const viewWrites: unknown[] = [];
		const reviewingUi = {
			...ui,
			confirm: async (options: Parameters<typeof ui.confirm>[0]) => {
				isReviewed = true;
				return ui.confirm(options);
			}
		};
		const changingClient = {
			...client,
			reuseViews: {
				list: async () => {
					const listed = await client.reuseViews.list();

					return isReviewed && change === 'views'
						? { views: [...listed.views, extraView] }
						: listed;
				},
				set: (input: Parameters<ReuseViewClient['set']>[0]) => {
					viewWrites.push(input);
					return client.reuseViews.set();
				}
			},
			oidcTrust: {
				...client.oidcTrust,
				list: async () => {
					const listed = await client.oidcTrust.list();

					return isReviewed && change === 'rules'
						? { rules: [...listed.rules, extraRule] }
						: listed;
				}
			}
		};
		const changingDependencies = {
			...dependencies,
			fetchCacheInfo: (target: URL) =>
				isReviewed && change === 'destination'
					? Promise.resolve(
							new CacheInfo(
								servedStoreDirectory,
								true,
								cachePrioritySchema.parse(45)
							)
						)
					: dependencies.fetchCacheInfo(target)
		};

		const error = await rejection(
			runDiscoveredGithubRepair(
				url,
				{ trustScope: 'exact' },
				reviewingUi,
				changingClient,
				changingDependencies,
				check
			)
		);

		expect({
			isStateChanged: error instanceof GithubRepairStateChangedError,
			added,
			viewWrites
		}).toStrictEqual({ isStateChanged: true, added: [], viewWrites: [] });
	}
);

it.each([
	{ name: 'with --yes', script: { interactive: true }, yes: true },
	{ name: 'without a terminal', script: { interactive: false }, yes: false }
])(
	'returns an error for rules from an unmerged branch $name',
	async ({ script, yes }) => {
		const { ui, added, client, dependencies, check } = await fixture(
			{ ...script, confirm: 'yes' },
			unmergedBranchContent,
			{ branch: 'feature/publish', defaultBranch: 'main' }
		);
		const error = await rejection(
			runDiscoveredGithubRepair(
				url,
				{ trustScope: 'exact', yes },
				ui,
				client,
				dependencies,
				check
			)
		);

		expect({
			problem:
				error instanceof GithubRepairUnavailableError ? error.problem : error,
			added
		}).toStrictEqual({ problem: 'unmerged-branch', added: [] });
	}
);

it('shows an unmerged branch in the preview at a terminal', async () => {
	const { ui, captured, client, dependencies, check } = await fixture(
		{ interactive: true, confirm: 'no' },
		unmergedBranchContent,
		{ branch: 'feature/publish', defaultBranch: 'main' }
	);

	await rejection(
		runDiscoveredGithubRepair(
			url,
			{ trustScope: 'exact' },
			ui,
			client,
			dependencies,
			check
		)
	);

	expect(captured.notes[0]?.body.split('\n', 1)).toStrictEqual([
		'Unmerged workflows\tThe planned rules come from workflow files on feature/publish, which is not the default branch main. Anyone who can push to the repository can change those files.'
	]);
});

it('applies a repair under --yes at an interactive terminal without a prompt', async () => {
	const { added, client, dependencies, check } = await fixture();
	const stream = new Writable({
		write(_chunk, _encoding, callback) {
			callback();
		}
	});
	const ui = createCliUi({
		mode: 'terminal',
		interactive: true,
		assumeYes: true,
		colour: false,
		stream,
		out: stream
	});

	await runDiscoveredGithubRepair(
		url,
		{ trustScope: 'exact', yes: true },
		ui,
		client,
		dependencies,
		check
	);

	expect(added).toStrictEqual([
		{
			...mainBranchRule('packages'),
			permittedGrants: [
				buildCacheGrant({ cache: 'packages', allow: ['push', 'attest'] }),
				buildCacheGrant({ cache: 'systems', allow: ['push', 'attest'] })
			]
		}
	]);
});

it('reports the check after the writes under its own result kind', async () => {
	const { ui, captured, client, dependencies, check } = await fixture({
		interactive: false,
		confirm: 'yes'
	});

	await runDiscoveredGithubRepair(
		url,
		{ trustScope: 'exact', yes: true },
		ui,
		client,
		dependencies,
		check
	);

	expect(captured.results.map((result) => result.kind)).toStrictEqual([
		'github-check-discovered',
		'github-repair-plan',
		'github-check-verified'
	]);
});

it('stops without writing when a planned rule would replace the rule that another job uses', async () => {
	const workflowReference =
		'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.35';
	const shared = oidcTrustSummarySchema.parse({
		...buildAddBody({
			issuer: 'https://token.actions.githubusercontent.com',
			audience: url.href,
			claims: {
				repository_id: '1234',
				repository_owner_id: '5678',
				job_workflow_ref: workflowReference
			},
			permittedGrants: [
				buildCacheGrant({
					cache: 'packages',
					root: 'pkgs/',
					allow: ['push', 'attest', 'root']
				})
			]
		}),
		id: 'shared',
		disabled: false
	});
	const { ui, added, client, dependencies, check } = await fixture(
		undefined,
		`
on:
  push:
    branches: [main]
jobs:
  packages:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      cache: packages
      root: pkgs
  systems:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      cache: packages
      root: sys
`,
		{ rules: [shared] }
	);
	const error = await rejection(
		runDiscoveredGithubRepair(
			url,
			{ trustScope: 'exact' },
			ui,
			client,
			dependencies,
			check
		)
	);

	expect({
		statuses: check.jobs.map((job) => [job.job, job.status]),
		shadowed:
			error instanceof GithubRepairShadowsRuleError
				? {
						shadow: error.shadow,
						job: error.job,
						trigger: error.trigger,
						rules: error.rules
					}
				: error,
		added
	}).toStrictEqual({
		statuses: [
			['packages', 'ready'],
			['systems', 'failed']
		],
		shadowed: {
			shadow: 'ungranted',
			job: `${path}, packages`,
			trigger: 'push',
			rules: ['shared']
		},
		added: []
	});
});

it.each([
	{
		name: 'a dynamic tenant URL',
		job: `
  other:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: \${{ vars.CUPBOARD_URL }}
      cache: other
`
	},
	{
		name: 'a condition that the check cannot evaluate',
		job: `
  other:
    if: inputs.publish == 'outputs'
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      cache: other
`
	}
])(
	'stops without writing when a planned rule could replace the rule of a job with $name',
	async ({ job }) => {
		const broad = oidcTrustSummarySchema.parse({
			...buildAddBody({
				issuer: 'https://token.actions.githubusercontent.com',
				audience: url.href,
				claims: {
					repository_id: '1234',
					job_workflow_ref:
						'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.35'
				},
				permittedGrants: [
					buildCacheGrant({ cache: 'other', allow: ['push', 'attest'] })
				]
			}),
			id: 'broad',
			disabled: false
		});
		const { ui, added, client, dependencies, check } = await fixture(
			undefined,
			`
on:
  push:
    branches: [main]
jobs:
  packages:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      cache: packages
${job}`,
			{ rules: [broad] }
		);
		const error = await rejection(
			runDiscoveredGithubRepair(
				url,
				{ trustScope: 'exact' },
				ui,
				client,
				dependencies,
				check
			)
		);

		expect({
			statuses: Object.fromEntries(
				check.jobs.map((result) => [result.job, result.status])
			),
			shadowed:
				error instanceof GithubRepairShadowsRuleError
					? {
							shadow: error.shadow,
							job: error.job,
							trigger: error.trigger,
							rules: error.rules
						}
					: error,
			added
		}).toStrictEqual({
			statuses: { other: 'unverified', packages: 'failed' },
			shadowed: {
				shadow: 'unmodelled',
				job: `${path}, other`,
				trigger: undefined,
				rules: ['broad']
			},
			added: []
		});
	}
);

it.each([
	{ name: 'the same cache', cache: 'packages' },
	{ name: 'another cache', cache: 'systems' }
])(
	'extends a rule with the same claims while preserving its grants for $name',
	async ({ cache }) => {
		const existing = oidcTrustSummarySchema.parse({
			...mainBranchRule(cache),
			id: 'setup-rule',
			disabled: false
		});
		const { ui, added, extended, client, dependencies, check } = await fixture(
			{ interactive: true, confirm: 'yes' },
			`
on:
  push:
    branches: [main]
jobs:
  packages:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      cache: packages
      root: pkgs
`,
			{ rules: [existing] }
		);
		const error = await rejection(
			runDiscoveredGithubRepair(
				url,
				{ trustScope: 'exact' },
				ui,
				client,
				dependencies,
				check
			)
		);

		expect({
			error,
			added,
			extended
		}).toStrictEqual({
			error: undefined,
			added: [],
			extended: [
				{
					expected: existing,
					permittedGrants: [
						buildCacheGrant({
							cache: 'packages',
							root: 'pkgs/',
							allow: ['push', 'attest', 'root']
						})
					]
				}
			]
		});
	}
);

const upgradeWorkflow = `
on:
  push:
    branches: [main]
jobs:
  packages:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      cache: packages
      root: pkgs
`;

it('previews preserved claims and grants before extending an existing rule', async () => {
	const expected = oidcTrustSummarySchema.parse({
		...mainBranchRule('systems'),
		id: 'existing',
		disabled: false
	});
	const { ui, captured, client, dependencies, check } = await fixture(
		undefined,
		upgradeWorkflow,
		{ rules: [expected] }
	);

	await runDiscoveredGithubRepair(
		url,
		{ trustScope: 'exact' },
		ui,
		client,
		dependencies,
		check
	);

	expect(captured.notes[0]?.body).toContain(
		'Extend existing rule\texisting: keep its claims, resources and existing grants; add the following grants atomically'
	);
	expect(captured.notes[0]?.body).toContain('Claim repository_owner_id\t5678');
	expect(captured.notes[0]?.body).toContain('systems');
	expect(await client.oidcTrust.list()).toStrictEqual({
		rules: [
			{
				...expected,
				permittedGrants: [
					...expected.permittedGrants,
					buildCacheGrant({
						cache: 'packages',
						root: 'pkgs/',
						allow: ['push', 'attest', 'root']
					})
				]
			}
		]
	});
});

it('stops before extending a rule that changed during review', async () => {
	const expected = oidcTrustSummarySchema.parse({
		...mainBranchRule('systems'),
		id: 'existing',
		disabled: false
	});
	const { ui, added, extended, client, dependencies, check } = await fixture(
		undefined,
		upgradeWorkflow,
		{ rules: [expected] }
	);
	let lists = 0;
	const changing = {
		...client,
		oidcTrust: {
			...client.oidcTrust,
			list: () => {
				lists += 1;
				return Promise.resolve(
					oidcTrustListResponseSchema.parse({
						rules: [{ ...expected, disabled: lists > 1 }]
					})
				);
			}
		}
	};
	const error = await rejection(
		runDiscoveredGithubRepair(
			url,
			{ trustScope: 'exact' },
			ui,
			changing,
			dependencies,
			check
		)
	);

	expect({
		changed: error instanceof GithubRepairStateChangedError,
		added,
		extended
	}).toStrictEqual({ changed: true, added: [], extended: [] });
});

it('explains that an older server must be upgraded before a rule extension', async () => {
	const expected = oidcTrustSummarySchema.parse({
		...mainBranchRule('systems'),
		id: 'existing',
		disabled: false
	});
	const { ui, added, extended, client, dependencies, check } = await fixture(
		undefined,
		upgradeWorkflow,
		{ rules: [expected] }
	);
	const older = {
		...client,
		oidcTrust: {
			...client.oidcTrust,
			extend: () => Promise.reject(new ORPCError('NOT_FOUND', { status: 404 }))
		}
	};
	const error = await rejection(
		runDiscoveredGithubRepair(
			url,
			{ trustScope: 'exact' },
			ui,
			older,
			dependencies,
			check
		)
	);

	expect({
		reason:
			error instanceof GithubRepairUnavailableError ? error.reason : error,
		added,
		extended
	}).toStrictEqual({
		reason:
			'the server does not support atomic trust-rule grant extensions. Upgrade the server before retrying this repair.',
		added: [],
		extended: []
	});
});

it('reports an applied extension when a later addition fails and retries only the remaining change', async () => {
	const expected = oidcTrustSummarySchema.parse({
		...mainBranchRule('systems'),
		id: 'existing',
		disabled: false
	});
	const workflow =
		upgradeWorkflow +
		`
  systems:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.36
    with:
      url: https://cupboard.supply/t/laney
      cache: systems
`;
	const { ui, added, extended, client, dependencies, check } = await fixture(
		undefined,
		workflow,
		{ rules: [expected] }
	);
	const failing = {
		...client,
		oidcTrust: {
			...client.oidcTrust,
			add: () => Promise.reject(new Error('addition failed'))
		}
	};
	const error = await rejection(
		runDiscoveredGithubRepair(
			url,
			{ trustScope: 'exact' },
			ui,
			failing,
			dependencies,
			check
		)
	);
	const current = await inspectDiscoveredGithubCheck(
		url,
		{ repo: repository, branch: 'main' },
		ui.reporter(),
		client,
		dependencies
	);
	await runDiscoveredGithubRepair(
		url,
		{ trustScope: 'exact' },
		ui,
		client,
		dependencies,
		current
	);

	expect({
		partial:
			error instanceof GithubRepairPartialError
				? { step: error.step, applied: error.applied }
				: error,
		extensions: extended.map(({ expected }) => expected.id),
		additions: added.map((body) => body.claims.job_workflow_ref)
	}).toStrictEqual({
		partial: {
			step: 'add trust rule 1',
			applied: ['extended trust rule existing']
		},
		extensions: ['existing'],
		additions: [
			'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.36'
		]
	});
});

it.each([
	{
		name: 'a workflow pattern',
		id: 'existing',
		claims: {
			...mainBranchRule().claims,
			job_workflow_ref: { pattern: '^underwhelmingperformance/cupboard/.*$' }
		}
	},
	{ name: 'the owner rule', id: 'owner', claims: mainBranchRule().claims },
	{
		name: 'an extra selector',
		id: 'existing',
		claims: { ...mainBranchRule().claims, event_name: 'push' }
	}
])('refuses to extend $name automatically', async ({ id, claims }) => {
	const expected = oidcTrustSummarySchema.parse({
		...mainBranchRule('systems'),
		id,
		claims,
		disabled: false
	});
	const { ui, added, extended, client, dependencies, check } = await fixture(
		undefined,
		upgradeWorkflow,
		{ rules: [expected] }
	);
	const error = await rejection(
		runDiscoveredGithubRepair(
			url,
			{ trustScope: 'exact' },
			ui,
			client,
			dependencies,
			check
		)
	);

	expect({
		problem:
			error instanceof GithubRepairUnavailableError ? error.problem : error,
		added,
		extended
	}).toStrictEqual({ problem: 'existing-rule', added: [], extended: [] });
});

it('reports a successful extension that cannot be read back as a partial repair', async () => {
	const expected = oidcTrustSummarySchema.parse({
		...mainBranchRule('systems'),
		id: 'existing',
		disabled: false
	});
	const { ui, client, dependencies, check } = await fixture(
		undefined,
		upgradeWorkflow,
		{ rules: [expected] }
	);
	const stale = {
		...client,
		oidcTrust: {
			...client.oidcTrust,
			extend: (input: Parameters<typeof client.oidcTrust.extend>[0]) =>
				Promise.resolve(
					oidcTrustSummarySchema.parse({
						...input.expected,
						permittedGrants: [
							...input.expected.permittedGrants,
							...input.permittedGrants
						]
					})
				)
		}
	};
	const error = await rejection(
		runDiscoveredGithubRepair(
			url,
			{ trustScope: 'exact' },
			ui,
			stale,
			dependencies,
			check
		)
	);

	expect(
		error instanceof GithubRepairPartialError
			? {
					step: error.step,
					applied: error.applied,
					failed: error.cause instanceof GithubCheckFailedError
				}
			: error
	).toStrictEqual({
		step: 'verify the tenant after writing',
		applied: ['extended trust rule existing'],
		failed: true
	});
});

it.each([false, true])(
	'requires explicit branch workflow trust before extending a rule: %s',
	async (allowBranchWorkflow) => {
		const reference =
			'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/heads/main';
		const expected = oidcTrustSummarySchema.parse({
			...mainBranchRule('systems'),
			claims: { ...mainBranchRule().claims, job_workflow_ref: reference },
			id: 'existing',
			disabled: false
		});
		const workflow = upgradeWorkflow.replace('@v0.0.35', '@refs/heads/main');
		const {
			ui,
			captured,
			added,
			extended,
			verified,
			client,
			dependencies,
			check
		} = await fixture(undefined, workflow, { rules: [expected] });
		const error = await rejection(
			runDiscoveredGithubRepair(
				url,
				{ trustScope: 'exact', allowBranchWorkflow },
				ui,
				client,
				dependencies,
				check
			)
		);

		expect({
			optionError: error instanceof GithubCheckOptionError,
			added,
			extended: extended.map(({ expected }) => expected.id),
			futureEdits: captured.notes[0]?.body.includes('accept future edits'),
			verifications: verified
		}).toStrictEqual({
			optionError: !allowBranchWorkflow,
			added: [],
			extended: allowBranchWorkflow ? ['existing'] : [],
			futureEdits: allowBranchWorkflow || undefined,
			verifications: allowBranchWorkflow
				? [reference, reference, reference]
				: [reference]
		});
	}
);

it('rechecks the branch workflow before any write', async () => {
	const workflow = upgradeWorkflow.replace('@v0.0.35', '@refs/heads/main');
	const { ui, added, extended, client, dependencies, check } = await fixture(
		undefined,
		workflow
	);
	const missing = new Error('branch workflow was removed');
	const error = await rejection(
		runDiscoveredGithubRepair(
			url,
			{ trustScope: 'exact', allowBranchWorkflow: true },
			ui,
			client,
			{
				...dependencies,
				verifyWorkflowReference: () => Promise.reject(missing)
			},
			check
		)
	);

	expect({ error, added, extended }).toStrictEqual({
		error: missing,
		added: [],
		extended: []
	});
});

it('reports an unconfirmed first extension and checks current policy before retrying', async () => {
	const expected = oidcTrustSummarySchema.parse({
		...mainBranchRule('systems'),
		id: 'existing',
		disabled: false
	});
	const { ui, extended, client, dependencies, check } = await fixture(
		undefined,
		upgradeWorkflow,
		{ rules: [expected] }
	);
	const lost = new Error('response lost');
	const uncertain = {
		...client,
		oidcTrust: {
			...client.oidcTrust,
			extend: async (input: Parameters<typeof client.oidcTrust.extend>[0]) => {
				await client.oidcTrust.extend(input);
				throw lost;
			}
		}
	};
	const error = await rejection(
		runDiscoveredGithubRepair(
			url,
			{ trustScope: 'exact' },
			ui,
			uncertain,
			dependencies,
			check
		)
	);
	const current = await inspectDiscoveredGithubCheck(
		url,
		{ repo: repository, branch: 'main' },
		ui.reporter(),
		client,
		dependencies
	);
	await runDiscoveredGithubRepair(
		url,
		{ trustScope: 'exact' },
		ui,
		client,
		dependencies,
		current
	);

	expect(
		error instanceof GithubRepairPartialError
			? {
					step: error.step,
					applied: error.applied,
					cause: error.cause,
					message: error.message
				}
			: error
	).toStrictEqual({
		step: 'extend trust rule existing',
		applied: [],
		cause: lost,
		message:
			'Could not confirm the attempt to extend trust rule existing. The attempted write may have completed. No writes were confirmed. Run cupboard github check again before you retry the repair.'
	});
	expect(extended.map(({ expected }) => expected.id)).toStrictEqual([
		'existing'
	]);
});

it('repairs claim-bound PR publication and merged-close rules for the simple workflow', async () => {
	const workflow = `
on:
  pull_request:
    types: [opened, synchronize, reopened, closed]
jobs:
  packages:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@main
    with:
      url: https://cupboard.supply/t/laney
      cache: pr-\${{ github.event.pull_request.number }}
      root: github:\${{ github.repository }}/pr-\${{ github.event.pull_request.number }}
      manage-pr-cache: true
`;
	const publishingWorkflow = await readFile(
		new URL(
			'../../../../../.github/workflows/cupboard-publish.yml',
			import.meta.url
		),
		'utf8'
	);
	const { ui, added, client, dependencies, check } = await fixture(
		undefined,
		workflow,
		{ publishingWorkflow }
	);
	await runDiscoveredGithubRepair(
		url,
		{ trustScope: 'exact', allowBranchWorkflow: true },
		ui,
		client,
		dependencies,
		check
	);
	const reference =
		'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/heads/main';
	const identity = {
		repositoryId: 1234,
		repositoryOwnerId: 5678,
		fullName: repository,
		defaultBranch: 'main'
	};
	const pr = githubPrAddBody(url, identity, {
		repo: repository,
		jobWorkflowRef: reference,
		allowBranchWorkflow: true,
		cacheTemplate: 'pr-{pr}',
		rootTemplate: 'github:iainlane/dotfiles/pr-{pr}/'
	});
	const body = {
		...pr,
		permittedGrants: pr.permittedGrants.map((grant) =>
			grant.type === 'cupboard_cache'
				? {
						...grant,
						actions: grant.actions.filter(
							(action) => action !== 'upload:confirm' && action !== 'root:list'
						)
					}
				: grant
		)
	};

	expect(added).toStrictEqual([
		body,
		githubPrCloseAddBody(url, identity, {
			repo: repository,
			jobWorkflowRef: reference,
			cacheTemplate: 'pr-{pr}',
			allowBranchWorkflow: true
		})
	]);
	const cache = { kind: 'named' as const, name: cacheNameSchema.parse('pr-2') };
	const listed = await client.oidcTrust.list();
	const rules = activeMatcherRules(listed.rules);
	const claims = githubPullRequestClaims(url, identity, {
		pullRequestNumber: 2,
		workflowReference: reference
	});
	const requests = [
		cacheCreateAuthorizationDetails({ cache }),
		cacheLifecycleAuthorizationDetails({ cache, action: 'close' }),
		cacheLifecycleAuthorizationDetails({ cache, action: 'reopen' }),
		pushAuthorizationDetails({
			cache,
			attest: true,
			root: rootNameSchema.parse('github:iainlane/dotfiles/pr-2/x86_64-linux'),
			runRoot: rootNameSchema.parse(
				'github:iainlane/dotfiles/pr-2/x86_64-linux/_cupboard-run/1'
			)
		}),
		attestAttachAuthorizationDetails({ cache })
	];
	const publication = checkTrustRule(
		'PR 2 publication',
		rules,
		claims,
		requests
	);
	const close = checkTrustRule(
		'PR 2 merged-close',
		rules,
		githubMergedPullRequestClaims(url, identity, {
			baseBranch: 'main',
			workflowReference: reference
		}),
		[cacheLifecycleAuthorizationDetails({ cache, action: 'close' })]
	);
	const wrongPr = checkTrustRule(
		'PR 1 cannot publish to PR 2',
		rules,
		githubPullRequestClaims(url, identity, {
			pullRequestNumber: 1,
			workflowReference: reference
		}),
		requests
	);

	expect({
		publication: publication.status,
		close: close.status,
		wrongPr: wrongPr.status
	}).toStrictEqual({ publication: 'ok', close: 'ok', wrongPr: 'failed' });
});

it('upgrades the current main and PR publication jobs without removing existing authority', async () => {
	const reference =
		'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/heads/main';
	const identity = {
		repositoryId: 1234,
		repositoryOwnerId: 5678,
		fullName: repository,
		defaultBranch: 'main'
	};
	const main = oidcTrustSummarySchema.parse({
		...mainBranchRule(),
		claims: { ...mainBranchRule().claims, job_workflow_ref: reference },
		id: 'existing-main',
		disabled: false
	});
	const prBody = githubPrAddBody(url, identity, {
		repo: repository,
		jobWorkflowRef: reference,
		allowBranchWorkflow: true,
		cacheTemplate: 'pr-{pr}',
		rootTemplate: 'github:iainlane/dotfiles/pr-{pr}/'
	});
	const pr = oidcTrustSummarySchema.parse({
		...prBody,
		id: 'existing-pr',
		disabled: false,
		permittedGrants: [
			buildCacheGrant({ cache: 'unrelated', allow: ['push'] }),
			...prBody.permittedGrants.map((grant) =>
				grant.type === 'cupboard_cache'
					? {
							...grant,
							actions: grant.actions.filter(
								(action) =>
									![
										'root:attach',
										'cache:create',
										'cache:close',
										'cache:reopen'
									].includes(action)
							)
						}
					: grant
			)
		]
	});
	const workflowSource = await readFile(
		new URL(
			'../../../../../.github/workflows/cache-publish.yml',
			import.meta.url
		),
		'utf8'
	);
	const workflow = workflowSource.replaceAll(
		'https://cupboard.supply/t/cupboard',
		() => url.href
	);
	const publishingWorkflow = await readFile(
		new URL(
			'../../../../../.github/workflows/cupboard-publish.yml',
			import.meta.url
		),
		'utf8'
	);
	const { ui, extended, added, client, dependencies, check } = await fixture(
		undefined,
		workflow,
		{ rules: [main, pr], publishingWorkflow }
	);

	expect({
		jobs: check.jobs.map(({ job, status }) => ({ job, status })),
		repairable: check.repairableJobs.map(({ job }) => job)
	}).toStrictEqual({
		jobs: [
			{ job: 'publish-pr', status: 'failed' },
			{ job: 'publish-main', status: 'failed' }
		],
		repairable: ['publish-pr', 'publish-main']
	});
	await runDiscoveredGithubRepair(
		url,
		{ trustScope: 'exact', allowBranchWorkflow: true },
		ui,
		client,
		dependencies,
		check
	);
	const verified = await inspectDiscoveredGithubCheck(
		url,
		{ repo: repository, branch: 'main' },
		ui.reporter(),
		client,
		dependencies
	);
	const listed = await client.oidcTrust.list();
	const rules = activeMatcherRules(listed.rules);
	const claims = githubBranchClaims(url, identity, {
		branch: 'main',
		workflowReference: reference
	});
	const mainRequests = pushAuthorizationDetails({
		cache: { kind: 'default' },
		attest: true,
		root: rootNameSchema.parse('github:iainlane/dotfiles/main/x86_64-linux'),
		runRoot: rootNameSchema.parse(
			'github:iainlane/dotfiles/main/x86_64-linux/_cupboard-run/2'
		)
	});
	const foreignRoot = pushAuthorizationDetails({
		cache: { kind: 'default' },
		attest: true,
		root: rootNameSchema.parse('github:another/repository/main/x86_64-linux'),
		runRoot: rootNameSchema.parse(
			'github:another/repository/main/x86_64-linux/_cupboard-run/2'
		)
	});
	const outsideCache = pushAuthorizationDetails({
		cache: { kind: 'named', name: cacheNameSchema.parse('other') },
		attest: true,
		root: rootNameSchema.parse('github:iainlane/dotfiles/main/x86_64-linux')
	});
	const mergedClaims = githubMergedPullRequestClaims(url, identity, {
		baseBranch: 'main',
		workflowReference: reference
	});
	const close = (cache: string) =>
		checkTrustRule('merged-close', rules, mergedClaims, [
			cacheLifecycleAuthorizationDetails({
				cache: { kind: 'named', name: cacheNameSchema.parse(cache) },
				action: 'close'
			})
		]).status;

	expect({
		jobs: verified.jobs.map(({ job, status }) => ({ job, status })),
		extended: extended.map(({ expected }) => expected),
		added,
		main: checkTrustRule('main publication', rules, claims, [mainRequests])
			.status,
		foreignRoot: checkTrustRule('outside root', rules, claims, [foreignRoot])
			.status,
		outsideCache: checkTrustRule('outside cache', rules, claims, [outsideCache])
			.status,
		closePr2: close('pr-2'),
		closeOther: close('other'),
		retained: listed.rules
			.filter((rule) => rule.id !== 'new-rule')
			.map((rule) => ({
				...rule,
				permittedGrants: rule.permittedGrants.slice(
					0,
					rule.id === main.id
						? main.permittedGrants.length
						: pr.permittedGrants.length
				)
			}))
	}).toStrictEqual({
		jobs: [
			{ job: 'publish-pr', status: 'ready' },
			{ job: 'publish-main', status: 'ready' }
		],
		extended: [pr, main],
		added: [
			githubPrCloseAddBody(url, identity, {
				repo: repository,
				jobWorkflowRef: reference,
				allowBranchWorkflow: true,
				cacheTemplate: 'pr-{pr}'
			})
		],
		main: 'ok',
		foreignRoot: 'failed',
		outsideCache: 'failed',
		closePr2: 'ok',
		closeOther: 'failed',
		retained: [main, pr]
	});
});

it('stops before writing when a new tag changes the meaning of a bare branch workflow reference', async () => {
	const publishingWorkflow = await readFile(
		new URL(
			'../../../../../.github/workflows/cupboard-publish.yml',
			import.meta.url
		),
		'utf8'
	);
	const workflow = upgradeWorkflow.replace('@v0.0.35', '@main');
	const { ui, added, extended, client, dependencies, check } = await fixture(
		undefined,
		workflow,
		{ publishingWorkflow }
	);
	const error = await rejection(
		runDiscoveredGithubRepair(
			url,
			{ trustScope: 'exact', allowBranchWorkflow: true },
			ui,
			client,
			{
				...dependencies,
				source: {
					...dependencies.source,
					resolveWorkflowReference: () => Promise.resolve('refs/tags/main')
				}
			},
			check
		)
	);

	expect({
		changed: error instanceof GithubRepairStateChangedError,
		added,
		extended
	}).toStrictEqual({ changed: true, added: [], extended: [] });
});

it('reports confirmed extensions when the post-write check is cancelled', async () => {
	const expected = oidcTrustSummarySchema.parse({
		...mainBranchRule('systems'),
		id: 'existing',
		disabled: false
	});
	const { ui, client, dependencies, check } = await fixture(
		undefined,
		upgradeWorkflow,
		{ rules: [expected] }
	);
	const aborted = new CliAbortError();
	let reads = 0;
	const cancelling = {
		...client,
		oidcTrust: {
			...client.oidcTrust,
			list: () => {
				reads += 1;
				return reads === 3 ? Promise.reject(aborted) : client.oidcTrust.list();
			}
		}
	};
	const error = await rejection(
		runDiscoveredGithubRepair(
			url,
			{ trustScope: 'exact' },
			ui,
			cancelling,
			dependencies,
			check
		)
	);

	expect(
		error instanceof GithubRepairPartialError
			? {
					step: error.step,
					applied: error.applied,
					isUnconfirmed: error.isUnconfirmed,
					cause: error.cause,
					exitCode: error.exitCode
				}
			: error
	).toStrictEqual({
		step: 'verify the tenant after writing',
		applied: ['extended trust rule existing'],
		isUnconfirmed: false,
		cause: aborted,
		exitCode: 130
	});
});

it('reports an unconfirmed first addition and avoids adding a second rule on retry', async () => {
	const { ui, added, client, dependencies, check } = await fixture(
		undefined,
		upgradeWorkflow
	);
	const lost = new Error('response lost');
	const uncertain = {
		...client,
		oidcTrust: {
			...client.oidcTrust,
			add: async (body: OidcTrustAddBodyInput) => {
				await client.oidcTrust.add(body);
				throw lost;
			}
		}
	};
	const error = await rejection(
		runDiscoveredGithubRepair(
			url,
			{ trustScope: 'exact' },
			ui,
			uncertain,
			dependencies,
			check
		)
	);
	const current = await inspectDiscoveredGithubCheck(
		url,
		{ repo: repository, branch: 'main' },
		ui.reporter(),
		client,
		dependencies
	);
	await runDiscoveredGithubRepair(
		url,
		{ trustScope: 'exact' },
		ui,
		client,
		dependencies,
		current
	);

	expect({
		partial:
			error instanceof GithubRepairPartialError
				? {
						step: error.step,
						applied: error.applied,
						isUnconfirmed: error.isUnconfirmed,
						cause: error.cause
					}
				: error,
		additions: added.length
	}).toStrictEqual({
		partial: {
			step: 'add trust rule 1',
			applied: [],
			isUnconfirmed: true,
			cause: lost
		},
		additions: 1
	});
});

it('reports an unconfirmed reuse-view write after a confirmed extension', async () => {
	const reference =
		'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v0.0.35';
	const identity = {
		repositoryId: 1234,
		repositoryOwnerId: 5678,
		fullName: repository,
		defaultBranch: 'main'
	};
	const expected = oidcTrustSummarySchema.parse({
		...githubBranchAddBody(url, identity, {
			repo: repository,
			branch: 'main',
			jobWorkflowRef: reference
		}),
		id: 'existing',
		disabled: false,
		permittedGrants: [buildCacheGrant({ cache: 'unrelated', allow: ['push'] })]
	});
	const { ui, client, dependencies, check } = await fixture(
		undefined,
		presetPushWorkflow,
		{ rules: [expected] }
	);
	const lost = new Error('view response lost');
	const uncertain = {
		...client,
		reuseViews: { ...client.reuseViews, set: () => Promise.reject(lost) }
	};
	const error = await rejection(
		runDiscoveredGithubRepair(
			url,
			{ trustScope: 'exact' },
			ui,
			uncertain,
			dependencies,
			check
		)
	);

	expect(
		error instanceof GithubRepairPartialError
			? {
					step: error.step,
					applied: error.applied,
					isUnconfirmed: error.isUnconfirmed,
					cause: error.cause
				}
			: error
	).toStrictEqual({
		step: 'create reuse view pull-requests-1234',
		applied: ['extended trust rule existing'],
		isUnconfirmed: true,
		cause: lost
	});
});

it('includes the expected rule and additive grants in a JSON repair preview', async () => {
	const expected = oidcTrustSummarySchema.parse({
		...mainBranchRule('systems'),
		id: 'existing',
		disabled: false
	});
	const { ui, captured, client, dependencies, check } = await fixture(
		{ interactive: false, confirm: 'yes' },
		upgradeWorkflow,
		{ rules: [expected] }
	);
	await runDiscoveredGithubRepair(
		url,
		{ trustScope: 'exact', yes: true },
		ui,
		client,
		dependencies,
		check
	);

	expect(
		captured.results.find((result) => result.kind === 'github-repair-plan')
			?.data
	).toStrictEqual({
		rules: [],
		extensions: [
			{
				id: 'existing',
				expected,
				permittedGrants: [
					buildCacheGrant({
						cache: 'packages',
						root: 'pkgs/',
						allow: ['push', 'attest', 'root']
					})
				]
			}
		],
		retainedRuleIds: [],
		reuseViews: []
	});
});

it('stops before writing when repository ownership changes during review', async () => {
	const expected = oidcTrustSummarySchema.parse({
		...mainBranchRule('systems'),
		id: 'existing',
		disabled: false
	});
	const { ui, added, extended, client, dependencies, check } = await fixture(
		undefined,
		upgradeWorkflow,
		{ rules: [expected] }
	);
	const error = await rejection(
		runDiscoveredGithubRepair(
			url,
			{ trustScope: 'exact' },
			ui,
			client,
			{
				...dependencies,
				lookupRepository: () =>
					Promise.resolve({ ...check.identity, repositoryOwnerId: 9999 })
			},
			check
		)
	);

	expect({
		changed: error instanceof GithubRepairStateChangedError,
		added,
		extended
	}).toStrictEqual({ changed: true, added: [], extended: [] });
});

it('refuses an extension when another matching job cannot be modelled', async () => {
	const expected = oidcTrustSummarySchema.parse({
		...mainBranchRule('systems'),
		id: 'existing',
		disabled: false
	});
	const workflow =
		upgradeWorkflow +
		`
  other:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      cache: systems
      root: \${{ vars.ROOT }}
`;
	const { ui, added, extended, client, dependencies, check } = await fixture(
		undefined,
		workflow,
		{ rules: [expected] }
	);
	const error = await rejection(
		runDiscoveredGithubRepair(
			url,
			{ trustScope: 'exact' },
			ui,
			client,
			dependencies,
			check
		)
	);

	expect({
		shadow:
			error instanceof GithubRepairShadowsRuleError
				? { kind: error.shadow, job: error.job, rules: error.rules }
				: error,
		added,
		extended
	}).toStrictEqual({
		shadow: { kind: 'unmodelled', job: `${path}, other`, rules: ['existing'] },
		added: [],
		extended: []
	});
});

it('reports an unconfirmed extension after cancellation and preserves exit status 130', async () => {
	const expected = oidcTrustSummarySchema.parse({
		...mainBranchRule('systems'),
		id: 'existing',
		disabled: false
	});
	const { ui, extended, client, dependencies, check } = await fixture(
		undefined,
		upgradeWorkflow,
		{ rules: [expected] }
	);
	const aborted = new CliAbortError();
	const uncertain = {
		...client,
		oidcTrust: {
			...client.oidcTrust,
			extend: async (input: Parameters<typeof client.oidcTrust.extend>[0]) => {
				await client.oidcTrust.extend(input);
				throw aborted;
			}
		}
	};
	const error = await rejection(
		runDiscoveredGithubRepair(
			url,
			{ trustScope: 'exact' },
			ui,
			uncertain,
			dependencies,
			check
		)
	);

	expect({
		partial:
			error instanceof GithubRepairPartialError
				? {
						step: error.step,
						applied: error.applied,
						isUnconfirmed: error.isUnconfirmed,
						cause: error.cause,
						exitCode: error.exitCode
					}
				: error,
		extensions: extended.map(({ expected }) => expected.id)
	}).toStrictEqual({
		partial: {
			step: 'extend trust rule existing',
			applied: [],
			isUnconfirmed: true,
			cause: aborted,
			exitCode: 130
		},
		extensions: ['existing']
	});
});

it('reports unverified jobs after the writes as an incomplete check', async () => {
	const { ui, client, dependencies, check } = await fixture();
	const guarded = content.replaceAll(
		'    uses:',
		"    if: inputs.publish == 'outputs'\n    uses:"
	);
	const error = await rejection(
		runDiscoveredGithubRepair(
			url,
			{ trustScope: 'exact' },
			ui,
			client,
			{
				...dependencies,
				source: {
					...dependencies.source,
					read: (selectedRepository) =>
						Promise.resolve(
							selectedRepository === 'underwhelmingperformance/cupboard'
								? legacyPublishingWorkflow
								: guarded
						)
				}
			},
			check
		)
	);

	expect(
		error instanceof GithubRepairPartialError
			? {
					step: error.step,
					applied: error.applied,
					isIncomplete: error.cause instanceof GithubCheckIncompleteError
				}
			: error
	).toStrictEqual({
		step: 'verify the tenant after writing',
		applied: ['trust rule new-rule'],
		isIncomplete: true
	});
});

it('stops without writing a public preset view over private pull-request caches', async () => {
	const { ui, added, client, dependencies, check } = await fixture(
		undefined,
		presetPushWorkflow
	);
	const privateCaches = {
		...client,
		caches: {
			list: () =>
				Promise.resolve(
					cacheListResponseSchema.parse({
						caches: [
							{
								scope: { kind: 'named', name: 'gh-1234-pr-7' },
								access: 'private',
								priority: 40,
								storePaths: 0,
								defaultRootRetention: { kind: 'permanent' },
								grace: { kind: 'none' }
							}
						]
					})
				)
		}
	};
	const error = await rejection(
		runDiscoveredGithubRepair(
			url,
			{ trustScope: 'exact' },
			ui,
			privateCaches,
			dependencies,
			check
		)
	);

	expect({
		problem:
			error instanceof GithubRepairUnavailableError ? error.problem : error,
		added
	}).toStrictEqual({ problem: 'view-access', added: [] });
});

it('validates a release tag pattern at the prompt', async () => {
	const { ui, client, dependencies, check } = await fixture({
		interactive: true,
		menu: 'tag-pattern'
	});
	let problems: (string | undefined)[] = [];
	const promptingUi = {
		...ui,
		prefixedText: (options: Parameters<typeof ui.prefixedText>[0]) => {
			problems = ['', 'v**', 'v*'].map((value) => options.problem(value));
			return Promise.resolve(undefined);
		}
	};

	await rejection(
		runDiscoveredGithubRepair(url, {}, promptingUi, client, dependencies, check)
	);

	expect(problems).toStrictEqual([
		'Enter a release tag pattern.',
		'Use letters, digits, ., _, -, / and single * wildcards.',
		undefined
	]);
});

it('checks the default branch jobs when a planned rule is for the default branch', async () => {
	const flakeReference =
		'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v0.0.35';
	const broad = oidcTrustSummarySchema.parse({
		...buildAddBody({
			issuer: 'https://token.actions.githubusercontent.com',
			audience: url.href,
			claims: { repository_id: '1234', job_workflow_ref: flakeReference },
			permittedGrants: [
				buildCacheGrant({
					cache: 'other',
					root: 'legacy/',
					allow: ['push', 'attest', 'root', 'attach']
				})
			]
		}),
		id: 'broad',
		disabled: false
	});
	const workflows: Readonly<Record<string, string>> = {
		feature: `
on:
  push:
    branches: [main]
jobs:
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      preset: pull-request-and-branch
`,
		main: `
on:
  push:
    branches: [main]
jobs:
  legacy:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      cache: other
      root-prefix: legacy
`
	};
	const { ui, added, client, dependencies, check } = await fixture(
		undefined,
		workflows.feature,
		{ branch: 'feature', rules: [broad] }
	);
	const error = await rejection(
		runDiscoveredGithubRepair(
			url,
			{ trustScope: 'exact' },
			ui,
			client,
			{
				...dependencies,
				source: {
					resolveBranch: (_repository, branch) =>
						Promise.resolve(
							branch === 'main' ? 'b'.repeat(40) : 'a'.repeat(40)
						),
					list: () => Promise.resolve([path]),
					read: (selectedRepository, _path, reference) =>
						Promise.resolve(
							selectedRepository === 'underwhelmingperformance/cupboard'
								? legacyPublishingWorkflow
								: ((reference === 'b'.repeat(40)
										? workflows.main
										: workflows.feature) ?? '')
						)
				}
			},
			check
		)
	);

	expect({
		shadowed:
			error instanceof GithubRepairShadowsRuleError
				? {
						shadow: error.shadow,
						job: error.job,
						trigger: error.trigger,
						rules: error.rules
					}
				: error,
		added
	}).toStrictEqual({
		shadowed: {
			shadow: 'ungranted',
			job: `${path}, legacy`,
			trigger: 'push',
			rules: ['broad']
		},
		added: []
	});
});

const customAudience = 'cupboard-ci-client';
const customAudienceIdentity = {
	repositoryId: 1234,
	repositoryOwnerId: 5678,
	fullName: repository,
	defaultBranch: 'main'
};
const flakeAudienceReference =
	'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v0.0.35';
const audienceView = reuseViewSummarySchema.parse({
	name: 'pull-requests-1234',
	access: 'public',
	selectors: [{ kind: 'prefix', prefix: 'gh-1234-pr-' }],
	priority: 50,
	revision: 1,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z'
});

it.each([
	{ label: 'close', separatesReopen: false },
	{ label: 'close and reopen', separatesReopen: true }
])(
	'limits split PR rules to their modelled $label authority',
	async ({ separatesReopen }) => {
		const workflowContent = `
on:
  pull_request:
    types: [opened, synchronize, reopened, closed]
jobs:
  publish:
    if: github.event.action != 'closed'${separatesReopen ? " && github.event.action != 'reopened'" : ''}
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@v0.0.35
    with:
      url: ${url.href}
      preset: pull-request-and-branch
  close:
    if: github.event.action == 'closed'
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@v0.0.36
    with:
      url: ${url.href}
      preset: pull-request-and-branch
${
	separatesReopen
		? `  reopen:
    if: github.event.action == 'reopened'
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@v0.0.37
    with:
      url: ${url.href}
      preset: pull-request-and-branch
`
		: ''
}`;
		const { ui, added, client, dependencies, check } = await fixture(
			undefined,
			workflowContent,
			{ views: [audienceView] }
		);
		await runDiscoveredGithubRepair(
			url,
			{ trustScope: 'exact' },
			ui,
			client,
			dependencies,
			check
		);
		const publicationBody = githubPrAddBody(url, customAudienceIdentity, {
			repo: repository,
			jobWorkflowRef: flakeAudienceReference
		});
		const closeReference = flakeAudienceReference.replace('v0.0.35', 'v0.0.36');
		const substitutions = collectSubstitutions({
			templateSource: 'github-pr',
			captures: []
		});
		const publisherGrant = buildCacheGrant({
			cacheTemplate: 'gh-{repository_id}-pr-{pr}',
			rootTemplate: 'github:iainlane/dotfiles/pr-{pr}/',
			allow: [
				'push',
				'root',
				'attach',
				'create',
				...(separatesReopen ? [] : ['reopen']),
				'attest'
			],
			substitutions
		});
		expect(added).toStrictEqual([
			{ ...publicationBody, permittedGrants: [publisherGrant] },
			{
				...publicationBody,
				claims: { ...publicationBody.claims, job_workflow_ref: closeReference },
				permittedGrants: [
					buildCacheGrant({
						cacheTemplate: 'gh-{repository_id}-pr-{pr}',
						allow: ['close'],
						substitutions
					})
				]
			},
			githubPrCloseAddBody(url, customAudienceIdentity, {
				repo: repository,
				jobWorkflowRef: closeReference
			}),
			...(separatesReopen
				? [
						{
							...publicationBody,
							claims: {
								...publicationBody.claims,
								job_workflow_ref: flakeAudienceReference.replace(
									'v0.0.35',
									'v0.0.37'
								)
							},
							permittedGrants: [
								buildCacheGrant({
									cacheTemplate: 'gh-{repository_id}-pr-{pr}',
									rootTemplate: 'github:iainlane/dotfiles/pr-{pr}/',
									allow: [
										'push',
										'root',
										'attach',
										'create',
										'reopen',
										'attest'
									],
									substitutions
								})
							]
						}
					]
				: [])
		]);
	}
);

it('repairs only closure for a split installable PR handler', async () => {
	const { ui, added, client, dependencies, check } = await fixture(
		undefined,
		`
on:
  pull_request:
    types: [opened, synchronize, reopened, closed]
jobs:
  publish:
    if: github.event.action != 'closed'
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: ${url.href}
      cache: pr-cache
      manage-pr-cache: true
  close:
    if: github.event.action == 'closed'
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.36
    with:
      url: ${url.href}
      cache: pr-cache
      manage-pr-cache: true
`
	);
	const error = await rejection(
		runDiscoveredGithubRepair(
			url,
			{ trustScope: 'exact' },
			ui,
			client,
			dependencies,
			check
		)
	);
	const closeReference =
		'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.36';
	expect({
		repairable: check.repairableJobs.map(({ job }) => job),
		incomplete:
			error instanceof GithubCheckIncompleteError ? error.checks : error,
		added
	}).toStrictEqual({
		repairable: ['close'],
		incomplete: [`${path}, publish`],
		added: [
			buildAddBody({
				issuer: 'https://token.actions.githubusercontent.com',
				audience: url.href,
				claims: {
					repository_id: '1234',
					repository_owner_id: '5678',
					event_name: 'pull_request',
					job_workflow_ref: closeReference
				},
				permittedGrants: [
					buildCacheGrant({ cache: 'pr-cache', allow: ['close'] })
				],
				display: { provider: 'github', repository }
			}),
			githubPrCloseAddBody(url, customAudienceIdentity, {
				repo: repository,
				jobWorkflowRef: closeReference,
				cacheTemplate: 'pr-cache'
			})
		]
	});
});

const audienceRepairCases = [
	{
		label: 'installable branch',
		workflow: 'cupboard-publish',
		trigger: 'on:\n  push:\n    branches: [main]',
		inputs: '      cache: packages',
		access: 'public' as const,
		body: { ...mainBranchRule('packages'), audience: customAudience }
	},
	{
		label: 'installable tag',
		workflow: 'cupboard-publish',
		trigger: "on:\n  push:\n    tags: ['v1.2.3']",
		inputs: '      cache: packages',
		access: 'public' as const,
		body: {
			...mainBranchRule('packages'),
			audience: customAudience,
			claims: { ...mainBranchRule('packages').claims, ref: 'refs/tags/v1.2.3' }
		}
	},
	{
		label: 'flake custom branch',
		workflow: 'cupboard-flake-publish',
		trigger: 'on:\n  push:\n    branches: [main]',
		inputs: '      cache: packages\n      root-prefix: ci/',
		access: 'public' as const,
		body: {
			...mainBranchRule('packages'),
			audience: customAudience,
			claims: {
				...mainBranchRule('packages').claims,
				job_workflow_ref: flakeAudienceReference
			},
			permittedGrants: [
				buildCacheGrant({
					cache: 'packages',
					root: 'ci/',
					allow: ['push', 'attest', 'root', 'attach']
				})
			]
		}
	},
	{
		label: 'flake preset branch',
		workflow: 'cupboard-flake-publish',
		trigger: 'on:\n  push:\n    branches: [main]',
		inputs: '      preset: pull-request-and-branch',
		access: 'public' as const,
		body: githubBranchAddBody(url, customAudienceIdentity, {
			repo: repository,
			branch: 'main',
			jobWorkflowRef: flakeAudienceReference,
			audience: audienceSchema.parse(customAudience)
		})
	},
	{
		label: 'flake preset pull request',
		workflow: 'cupboard-flake-publish',
		trigger:
			'on:\n  pull_request:\n    types: [opened, synchronize, reopened, closed]',
		inputs: '      preset: pull-request-and-branch',
		access: 'public' as const,
		body: githubPrAddBody(url, customAudienceIdentity, {
			repo: repository,
			jobWorkflowRef: flakeAudienceReference,
			audience: audienceSchema.parse(customAudience)
		})
	},
	{
		label: 'installable private read',
		workflow: 'cupboard-publish',
		trigger: 'on:\n  push:\n    branches: [main]',
		inputs: '      cache: packages\n      publish: none',
		access: 'private' as const,
		body: {
			...mainBranchRule('packages'),
			audience: customAudience,
			permittedGrants: [buildCacheContentReadGrant({ cache: 'packages' })]
		}
	},
	{
		label: 'flake private read',
		workflow: 'cupboard-flake-publish',
		trigger: 'on: pull_request',
		inputs: '      preset: pull-request-and-branch\n      publish: none',
		access: 'private' as const,
		body: {
			...mainBranchRule(),
			audience: customAudience,
			claims: {
				repository_id: '1234',
				repository_owner_id: '5678',
				event_name: 'pull_request',
				job_workflow_ref: flakeAudienceReference
			},
			permittedGrants: [buildCacheContentReadGrant({})]
		}
	}
];

it.each(audienceRepairCases)(
	'repairs and verifies the configured audience for $label',
	async ({ workflow, trigger, inputs, access, body }) => {
		const { ui, added, client, dependencies, check, captured } = await fixture(
			undefined,
			`${trigger}
jobs:
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/${workflow}.yml@v0.0.35
    with:
      url: ${url.href}
      audience: ${customAudience}
${inputs}
`,
			{ cacheAccess: access, views: [audienceView] }
		);
		await runDiscoveredGithubRepair(
			url,
			{ trustScope: 'exact' },
			ui,
			client,
			dependencies,
			check
		);
		expect({
			initial: check.jobs.map((job) => job.status),
			added,
			results: captured.results.map((result) => result.kind)
		}).toStrictEqual({
			initial: ['failed'],
			added: [
				body,
				...(body.claims.event_name === 'pull_request' &&
				body.permittedGrants.some(
					(grant) =>
						grant.type === 'cupboard_cache' &&
						grant.actions.includes('cache:close')
				)
					? [
							githubPrCloseAddBody(url, customAudienceIdentity, {
								repo: repository,
								jobWorkflowRef: flakeAudienceReference,
								audience: audienceSchema.parse(customAudience)
							})
						]
					: [])
			],
			results: ['github-check-discovered', 'github-check-verified']
		});
	}
);

it.each(['cupboard-publish', 'cupboard-flake-publish'])(
	'refuses repair for an unresolved audience in %s',
	async (workflow) => {
		const { ui, added, client, dependencies, check } = await fixture(
			undefined,
			`
on:
  push:
    branches: [main]
jobs:
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/${workflow}.yml@v0.0.35
    with:
      url: ${url.href}
      audience: \${{ inputs.audience }}
      ${workflow === 'cupboard-flake-publish' ? 'root-prefix: ci/' : 'root: ci/'}
`
		);
		const error = await rejection(
			runDiscoveredGithubRepair(
				url,
				{ trustScope: 'exact' },
				ui,
				client,
				dependencies,
				check
			)
		);
		expect({
			initial: check.jobs.map((job) => job.status),
			error:
				error instanceof GithubCheckIncompleteError
					? { exitCode: error.exitCode, checks: error.checks }
					: error,
			added
		}).toStrictEqual({
			initial: ['unverified'],
			error: { exitCode: 69, checks: [`${path}, publish`] },
			added: []
		});
	}
);

it.each(
	audienceRepairCases.filter(
		(scenario) =>
			scenario.label === 'installable branch' ||
			scenario.label === 'flake custom branch'
	)
)(
	'detects a wrong stored audience during $label repair verification',
	async ({ workflow, trigger, inputs, body }) => {
		const { ui, added, client, dependencies, check } = await fixture(
			undefined,
			`${trigger}
jobs:
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/${workflow}.yml@v0.0.35
    with:
      url: ${url.href}
      audience: ${customAudience}
${inputs}
`
		);
		const attempted: OidcTrustAddBodyInput[] = [];
		const incorrectClient = {
			...client,
			oidcTrust: {
				...client.oidcTrust,
				add: (input: OidcTrustAddBodyInput) => {
					attempted.push(input);
					return client.oidcTrust.add({ ...input, audience: url.href });
				}
			}
		};
		const error = await rejection(
			runDiscoveredGithubRepair(
				url,
				{ trustScope: 'exact' },
				ui,
				incorrectClient,
				dependencies,
				check
			)
		);
		expect({
			attempted,
			added,
			error:
				error instanceof GithubRepairPartialError
					? {
							step: error.step,
							applied: error.applied,
							failed: error.cause instanceof GithubCheckFailedError
						}
					: error
		}).toStrictEqual({
			attempted: [body],
			added: [{ ...body, audience: url.href }],
			error: {
				step: 'verify the tenant after writing',
				applied: ['trust rule new-rule'],
				failed: true
			}
		});
	}
);

it('keeps different caller audiences separate when repairing identical claims', async () => {
	const { ui, added, client, dependencies, check } = await fixture(
		undefined,
		content.replace(
			'cache: packages',
			() => `cache: packages\n      audience: ${customAudience}`
		)
	);
	await runDiscoveredGithubRepair(
		url,
		{ trustScope: 'exact' },
		ui,
		client,
		dependencies,
		check
	);
	expect(added).toStrictEqual([
		{ ...mainBranchRule('packages'), audience: customAudience },
		mainBranchRule('systems')
	]);
});

const extraReadRepairCases = [
	{
		label: 'read-only PR',
		trigger: 'on: pull_request',
		inputs: '      preset: pull-request-and-branch\n      publish: none',
		body: {
			...mainBranchRule(),
			issuer: 'https://token.actions.githubusercontent.com',
			audience: url.href,
			claims: {
				repository_id: '1234',
				repository_owner_id: '5678',
				event_name: 'pull_request',
				job_workflow_ref: flakeAudienceReference
			},
			permittedGrants: [],
			display: { provider: 'github', repository }
		}
	},
	{
		label: 'preset PR',
		trigger:
			'on:\n  pull_request:\n    types: [opened, synchronize, reopened, closed]',
		inputs: '      preset: pull-request-and-branch',
		body: githubPrAddBody(url, customAudienceIdentity, {
			repo: repository,
			jobWorkflowRef: flakeAudienceReference
		})
	},
	{
		label: 'preset branch',
		trigger: 'on:\n  push:\n    branches: [main]',
		inputs: '      preset: pull-request-and-branch',
		body: githubBranchAddBody(url, customAudienceIdentity, {
			repo: repository,
			branch: 'main',
			jobWorkflowRef: flakeAudienceReference
		})
	},
	{
		label: 'custom branch',
		trigger: 'on:\n  push:\n    branches: [main]',
		inputs: '      cache: packages\n      root-prefix: ci/',
		body: buildAddBody({
			issuer: 'https://token.actions.githubusercontent.com',
			audience: url.href,
			claims: {
				repository_id: '1234',
				repository_owner_id: '5678',
				ref: 'refs/heads/main',
				job_workflow_ref: flakeAudienceReference
			},
			permittedGrants: [
				buildCacheGrant({
					cache: 'packages',
					root: 'ci/',
					allow: ['push', 'attest', 'root', 'attach']
				})
			],
			display: { provider: 'github', repository }
		})
	}
];
it.each(extraReadRepairCases)(
	'repairs and verifies a rootless additional private cache read for $label',
	async ({ trigger, inputs, body }) => {
		const { ui, captured, added, client, dependencies, check } = await fixture(
			undefined,
			`
${trigger}
jobs:
  build:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@v0.0.35
    with:
      url: ${url.href}
${inputs}
      read-caches: ${url.href}/cache/falcon
`,
			{
				views: [audienceView],
				fetchCacheAccess: (target) =>
					Promise.resolve(
						target.pathname.endsWith('/falcon') ? 'private' : 'public'
					)
			}
		);
		await runDiscoveredGithubRepair(
			url,
			{ trustScope: 'exact' },
			ui,
			client,
			dependencies,
			check
		);
		expect({
			added,
			results: captured.results.map((result) => result.kind)
		}).toStrictEqual({
			added: [
				{
					...body,
					permittedGrants: [
						...body.permittedGrants,
						buildCacheContentReadGrant({ cache: 'falcon' })
					]
				},
				...(body.claims.event_name === 'pull_request' &&
				body.permittedGrants.some(
					(grant) =>
						grant.type === 'cupboard_cache' &&
						grant.actions.includes('cache:close')
				)
					? [
							githubPrCloseAddBody(url, customAudienceIdentity, {
								repo: repository,
								jobWorkflowRef: flakeAudienceReference
							})
						]
					: [])
			],
			results: ['github-check-discovered', 'github-check-verified']
		});
	}
);

it.each([
	"'${{ inputs.read_caches }}'",
	`${url.href}/reuse/prs`,
	'https://cupboard.supply/t/other/cache/falcon'
])(
	'refuses repair when additional reads cannot be modelled: %s',
	async (input) => {
		const { ui, added, client, dependencies, check } = await fixture(
			undefined,
			`
on: pull_request
jobs:
  build:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@v0.0.35
    with:
      url: ${url.href}
      preset: pull-request-and-branch
      publish: none
      read-caches: ${input}
`
		);
		const error = await rejection(
			runDiscoveredGithubRepair(
				url,
				{ trustScope: 'exact' },
				ui,
				client,
				dependencies,
				check
			)
		);
		expect({
			error:
				error instanceof GithubCheckIncompleteError
					? { exitCode: error.exitCode, checks: error.checks }
					: error,
			added
		}).toStrictEqual({
			error: { exitCode: 69, checks: [`${path}, build`] },
			added: []
		});
	}
);

it('rejects a post-repair rule that omits the additional cache authority', async () => {
	const { ui, added, client, dependencies, check } = await fixture(
		undefined,
		`
on: pull_request
jobs:
  build:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@v0.0.35
    with:
      url: ${url.href}
      preset: pull-request-and-branch
      publish: none
      read-caches: ${url.href}/cache/falcon
`,
		{
			fetchCacheAccess: (target) =>
				Promise.resolve(
					target.pathname.endsWith('/falcon') ? 'private' : 'public'
				)
		}
	);
	const attempted: OidcTrustAddBodyInput[] = [];
	const incorrectClient = {
		...client,
		oidcTrust: {
			...client.oidcTrust,
			add: (body: OidcTrustAddBodyInput) => {
				attempted.push(body);
				return client.oidcTrust.add({
					...body,
					permittedGrants: [buildCacheContentReadGrant({ cache: 'other' })]
				});
			}
		}
	};
	const error = await rejection(
		runDiscoveredGithubRepair(
			url,
			{ trustScope: 'exact' },
			ui,
			incorrectClient,
			dependencies,
			check
		)
	);
	const expected = buildAddBody({
		issuer: 'https://token.actions.githubusercontent.com',
		audience: url.href,
		claims: {
			repository_id: '1234',
			repository_owner_id: '5678',
			event_name: 'pull_request',
			job_workflow_ref: flakeAudienceReference
		},
		permittedGrants: [buildCacheContentReadGrant({ cache: 'falcon' })],
		display: { provider: 'github', repository }
	});
	expect({
		attempted,
		added,
		error:
			error instanceof GithubRepairPartialError
				? {
						step: error.step,
						applied: error.applied,
						failed: error.cause instanceof GithubCheckFailedError
					}
				: error
	}).toStrictEqual({
		attempted: [expected],
		added: [
			{
				...expected,
				permittedGrants: [buildCacheContentReadGrant({ cache: 'other' })]
			}
		],
		error: {
			step: 'verify the tenant after writing',
			applied: ['trust rule new-rule'],
			failed: true
		}
	});
});
