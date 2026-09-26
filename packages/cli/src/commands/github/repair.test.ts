import { Writable } from 'node:stream';

import { createCliUi } from '@cupboard/cli-ui';
import { type CliUiScript, fakeCliUi } from '@cupboard/cli-ui/testing';
import {
	CacheInfo,
	servedStoreDirectory
} from '@cupboard/nix-store/cache-info';
import { cachePrioritySchema } from '@cupboard/nix-store/scalars';
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
import { expect, it } from 'vitest';

import {
	CliAbortError,
	GithubCheckFailedError,
	GithubCheckIncompleteError,
	GithubCheckOptionError
} from '../../errors.ts';
import {
	githubBranchAddBody,
	githubPrAddBody,
	type OidcTrustClient
} from '../oidc-trust.ts';
import {
	buildAddBody,
	buildCacheGrant,
	jobWorkflowReferenceClaim
} from '../oidc-trust/rule-builder.ts';
import { type ReuseViewClient } from '../reuse-view.ts';

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
on: push
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
	} = {}
) {
	const { ui, captured } = fakeCliUi(
		script ?? { interactive: true, confirm: 'yes' }
	);
	const added: OidcTrustAddBodyInput[] = [];
	const verified: string[] = [];
	const rules: unknown[] = [...(options.rules ?? [])];
	let revision = 'a'.repeat(40);
	const source = {
		resolveBranch: () => Promise.resolve(revision),
		list: () => Promise.resolve([path]),
		read: () => Promise.resolve(workflowContent)
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
		}
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
    tags: ['v*']
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
				'Add planned rule 2\trepository ID 1234, ref pattern ^refs/tags/v[^/]*$; workflow underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.35',
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
    tags: ['v*']
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

it('rethrows the abort reason after an earlier tenant write', async () => {
	const workflowContent = `
on:
  push:
    branches: [main]
    tags: ['v*']
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

	await expect(
		runDiscoveredGithubRepair(
			url,
			{ trustScope: 'exact' },
			ui,
			abortingClient,
			dependencies,
			check
		)
	).rejects.toBe(aborted);
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
		problem:
			error instanceof GithubRepairUnavailableError ? error.problem : error,
		added
	}).toStrictEqual({ problem: 'no-repairable-job', added: [] });
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
on: [push, pull_request]
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
		}
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
		trigger: `on: push`,
		inputs: `      cache: packages
      attest: false`,
		ref: 'refs/heads/main',
		grant: buildCacheGrant({ cache: 'packages', allow: ['push', 'attest'] })
	},
	{
		name: 'a tag-only publishing workflow',
		trigger: `on:
  push:
    tags: ['v*']`,
		inputs: '',
		ref: { pattern: '^refs/tags/v[^/]*$' },
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

const customViewWorkflow = `
on: push
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
on: push
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
			content,
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
		content,
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
    if: github.ref == 'refs/heads/main'
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
	'stops before the scope prompt when a rule with the same claims grants $name',
	async ({ cache }) => {
		const existing = oidcTrustSummarySchema.parse({
			...mainBranchRule(cache),
			id: 'setup-rule',
			disabled: false
		});
		const { ui, added, client, dependencies, check } = await fixture(
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
			runDiscoveredGithubRepair(url, {}, ui, client, dependencies, check)
		);

		expect({
			problem:
				error instanceof GithubRepairUnavailableError ? error.problem : error,
			added
		}).toStrictEqual({ problem: 'existing-rule', added: [] });
	}
);

it('reports unverified jobs after the writes as an incomplete check', async () => {
	const { ui, client, dependencies, check } = await fixture();
	const guarded = content.replaceAll(
		'    uses:',
		"    if: github.ref == 'refs/heads/main'\n    uses:"
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
					read: () => Promise.resolve(guarded)
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
					read: (_repository, _path, reference) =>
						Promise.resolve(
							(reference === 'b'.repeat(40)
								? workflows.main
								: workflows.feature) ?? ''
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
