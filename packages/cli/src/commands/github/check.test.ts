import { capturingReporter as reporter } from '@cupboard/cli-ui/testing';
import { CacheInfo } from '@cupboard/nix-store/cache-info';
import type { OidcTrustSummary } from '@cupboard/protocol/oidc';
import type {
	ReuseViewSelector,
	ReuseViewSummary
} from '@cupboard/protocol/reuse-views';
import type { ResultRow } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import {
	GithubCheckFailedError,
	GithubCheckIncompleteError,
	GithubTokenMissingError,
	unavailableExitCode
} from '../../errors.ts';
import { githubBranchAddBody, githubPrAddBody } from '../oidc-trust.ts';
import { type RepositoryIdentity } from '../oidc-trust/github.ts';

import {
	type GithubCheckClient,
	type GithubCheckOptions,
	runGithubCheck
} from './check.ts';

const url = 'https://cupboard.example.workers.dev/t/acme';
const pinnedWorkflowReference =
	'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v1.2.3';
const identity: RepositoryIdentity = {
	repositoryId: 1234,
	repositoryOwnerId: 5678,
	fullName: 'acme/app'
};

const options: GithubCheckOptions = {
	repo: 'acme/app',
	branch: 'main',
	workflowRef: pinnedWorkflowReference,
	manifest: 'manifest.json',
	rootPrefix: 'github:acme/app/main'
};

function storedRule(
	id: string,
	body: ReturnType<typeof githubPrAddBody>
): OidcTrustSummary {
	return { id, ...body, disabled: false };
}

const prRule = storedRule(
	'pr',
	githubPrAddBody(url, identity, {
		repo: options.repo,
		jobWorkflowRef: options.workflowRef
	})
);
const branchRule = storedRule(
	'branch',
	githubBranchAddBody(url, identity, {
		repo: options.repo,
		branch: options.branch,
		jobWorkflowRef: options.workflowRef
	})
);

function pullRequestView(
	selectors: readonly ReuseViewSelector[] = [{ kind: 'prefix', pattern: 'pr-' }]
): ReuseViewSummary {
	return {
		name: 'pull-requests',
		revision: 1,
		priority: 50,
		selectors: [...selectors],
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z'
	};
}

function checkClient(overrides: {
	graceSeconds?: number | undefined;
	extraPolicies?: { cachePrefix: string; graceSeconds: number }[];
	rules?: OidcTrustSummary[];
	views?: ReuseViewSummary[];
}): GithubCheckClient {
	return {
		policies: {
			graceList: () =>
				Promise.resolve({
					policies: [
						...(overrides.graceSeconds === undefined
							? []
							: [
									{
										id: 'grace-0',
										cachePrefix: '',
										graceSeconds: overrides.graceSeconds,
										createdAt: '2026-01-01T00:00:00.000Z'
									}
								]),
						...(overrides.extraPolicies ?? []).map((policy, index) => ({
							id: `grace-extra-${String(index)}`,
							createdAt: '2026-01-01T00:00:00.000Z',
							...policy
						}))
					]
				})
		},
		reuseViews: {
			list: () =>
				Promise.resolve({ views: overrides.views ?? [pullRequestView()] })
		},
		oidcTrust: {
			list: () => Promise.resolve({ rules: overrides.rules ?? [] })
		}
	};
}

const manifestJson = JSON.stringify([
	{ attr: '.#a', system: 'x86_64-linux', os: 'ubuntu-latest' },
	{ attr: '.#b', system: 'aarch64-darwin', os: 'macos-latest' }
]);

function checkDependencies(overrides: {
	viewPriority?: number;
	variables?: Record<string, string>;
	variablesUnreadable?: boolean;
	manifest?: string;
}): Parameters<typeof runGithubCheck>[4] {
	return {
		lookupRepository: () => Promise.resolve(identity),
		fetchCacheInfo: (target: string) =>
			Promise.resolve(
				target.includes('/reuse/')
					? new CacheInfo('/nix/store', true, overrides.viewPriority ?? 50)
					: new CacheInfo('/nix/store', true, 40)
			),
		readVariable(name) {
			if (overrides.variablesUnreadable === true) {
				return Promise.reject(new GithubTokenMissingError());
			}

			return Promise.resolve(
				(overrides.variables ?? {
					CUPBOARD_PLAN_RUNNER: '"ubuntu-latest"',
					CUPBOARD_RUNNERS: 'ubuntu-latest, macos-latest'
				})[name]
			);
		},
		readManifestFile: () => Promise.resolve(overrides.manifest ?? manifestJson)
	};
}

function findings(results: ResultRow[][]): ResultRow[] {
	return results[0] ?? [];
}

describe('runGithubCheck', () => {
	it('passes every check for a converged setup', async () => {
		const results: ResultRow[][] = [];

		await runGithubCheck(
			url,
			options,
			reporter(results),
			checkClient({ graceSeconds: 86_400, rules: [prRule, branchRule] }),
			checkDependencies({})
		);

		expect(findings(results)).toStrictEqual([
			{ label: 'pull-request trust rule', value: 'ok' },
			{ label: 'main trust rule', value: 'ok' },
			{ label: 'grace policy', value: 'ok' },
			{ label: 'reuse view', value: 'ok' },
			{ label: 'plan runner variable', value: 'ok' },
			{ label: 'runner labels', value: 'ok' },
			{ label: 'root prefix', value: 'ok' }
		]);
	});

	it.each([
		{
			name: 'missing',
			views: [],
			detail: 'the pull-requests view is not defined'
		},
		{
			name: 'wrong selector',
			views: [pullRequestView([{ kind: 'prefix', pattern: 'pull-' }])],
			detail:
				'stored selectors differ from the single pr- prefix setup would write'
		},
		{
			name: 'extra selector',
			views: [
				pullRequestView([
					{ kind: 'prefix', pattern: 'pr-' },
					{ kind: 'exact', pattern: 'release' }
				])
			],
			detail:
				'stored selectors differ from the single pr- prefix setup would write'
		}
	])(
		'fails when the reuse-view definition is $name',
		async ({ views, detail }) => {
			const results: ResultRow[][] = [];

			let failure: unknown;
			try {
				await runGithubCheck(
					url,
					options,
					reporter(results),
					checkClient({
						graceSeconds: 86_400,
						rules: [prRule, branchRule],
						views
					}),
					checkDependencies({})
				);
			} catch (error) {
				failure = error;
			}

			expectFailed(failure);
			expect({ checks: failure.checks, rows: findings(results) }).toStrictEqual(
				{
					checks: ['reuse view'],
					rows: [
						{ label: 'pull-request trust rule', value: 'ok' },
						{ label: 'main trust rule', value: 'ok' },
						{ label: 'grace policy', value: 'ok' },
						{ label: 'reuse view', value: `failed: ${detail}` },
						{ label: 'plan runner variable', value: 'ok' },
						{ label: 'runner labels', value: 'ok' },
						{ label: 'root prefix', value: 'ok' }
					]
				}
			);
		}
	);

	// A covering tenant-wide policy can still be shadowed for the PR caches
	// by a longer prefix: the server resolves the longest match, so the check
	// must resolve the policy each destination shape actually receives.
	it('fails when a shorter pr- policy shadows the tenant-wide grace', async () => {
		const results: ResultRow[][] = [];

		let failure: unknown;
		try {
			await runGithubCheck(
				url,
				options,
				reporter(results),
				checkClient({
					graceSeconds: 86_400,
					extraPolicies: [{ cachePrefix: 'pr-', graceSeconds: 300 }],
					rules: [prRule, branchRule]
				}),
				checkDependencies({})
			);
		} catch (error) {
			failure = error;
		}

		expectFailed(failure);
		expect(
			findings(results).find((row) => row.label === 'grace policy')
		).toStrictEqual({
			label: 'grace policy',
			value:
				'failed: the 300s grace in force for the pr-1 cache is under 3600s and risks expiring mid-run'
		});
	});

	it('fails when a policy shadows the grace for one pull request cache', async () => {
		const results: ResultRow[][] = [];

		let failure: unknown;
		try {
			await runGithubCheck(
				url,
				options,
				reporter(results),
				checkClient({
					graceSeconds: 86_400,
					extraPolicies: [{ cachePrefix: 'pr-42', graceSeconds: 300 }],
					rules: [prRule, branchRule]
				}),
				checkDependencies({})
			);
		} catch (error) {
			failure = error;
		}

		expectFailed(failure);
		expect(
			findings(results).find((row) => row.label === 'grace policy')
		).toStrictEqual({
			label: 'grace policy',
			value:
				'failed: the 300s grace in force for the pr-42 cache is under 3600s and risks expiring mid-run'
		});
	});

	it('names each broken invariant and fails', async () => {
		const results: ResultRow[][] = [];
		const misSpelled = storedRule(
			'pr',
			githubPrAddBody(url, identity, {
				repo: options.repo,
				jobWorkflowRef: 'acme/app/.github/workflows/publish.yml@refs/heads/main'
			})
		);

		let failure: unknown;
		try {
			await runGithubCheck(
				url,
				{ ...options, rootPrefix: 'github:other/repo/main' },
				reporter(results),
				checkClient({ rules: [misSpelled] }),
				checkDependencies({ viewPriority: 40 })
			);
		} catch (error) {
			failure = error;
		}

		expectFailed(failure);
		expect({ checks: failure.checks, rows: findings(results) }).toStrictEqual({
			checks: [
				'pull-request trust rule',
				'main trust rule',
				'grace policy',
				'reuse view',
				'root prefix'
			],
			rows: [
				{
					label: 'pull-request trust rule',
					value:
						'failed: rule pr expects job_workflow_ref to match acme/app/.github/workflows/publish.yml@refs/heads/main; a run presents ' +
						pinnedWorkflowReference
				},
				{
					label: 'main trust rule',
					value:
						'failed: rule pr expects event_name to match pull_request; a run presents push'
				},
				{
					label: 'grace policy',
					value:
						'failed: no grace policy covers the default cache: intermediate-retention grace publishes intermediates nothing retains'
				},
				{
					label: 'reuse view',
					value: "failed: view priority 40 does not exceed the destination's 40"
				},
				{ label: 'plan runner variable', value: 'ok' },
				{ label: 'runner labels', value: 'ok' },
				{
					label: 'root prefix',
					value:
						'failed: github:other/repo/main does not nest under the granted github:acme/app/main/'
				}
			]
		});
	});

	// With both rules stored, a broken PR rule must be diagnosed against the
	// PR rule, not explained as the branch rule's event mismatch: the
	// candidate with the fewest mismatches for the presented shape wins.
	it('diagnoses the broken rule for the shape, not its sibling', async () => {
		const results: ResultRow[][] = [];
		const misSpelledPr = storedRule(
			'pr',
			githubPrAddBody(url, identity, {
				repo: options.repo,
				jobWorkflowRef: 'acme/app/.github/workflows/publish.yml@refs/heads/main'
			})
		);

		let failure: unknown;
		try {
			await runGithubCheck(
				url,
				options,
				reporter(results),
				checkClient({
					graceSeconds: 86_400,
					rules: [misSpelledPr, branchRule]
				}),
				checkDependencies({})
			);
		} catch (error) {
			failure = error;
		}

		expectFailed(failure);
		expect({
			checks: failure.checks,
			rows: findings(results).slice(0, 2)
		}).toStrictEqual({
			checks: ['pull-request trust rule'],
			rows: [
				{
					label: 'pull-request trust rule',
					value:
						'failed: rule pr expects job_workflow_ref to match acme/app/.github/workflows/publish.yml@refs/heads/main; a run presents ' +
						pinnedWorkflowReference
				},
				{ label: 'main trust rule', value: 'ok' }
			]
		});
	});

	// A rule can pin the repository by a pattern rather than an exact id; the
	// diagnostic must still treat it as this repository's candidate instead of
	// claiming no rule pins the repository.
	it('diagnoses a pattern-pinned rule as this repository\u{2019}s candidate', async () => {
		const results: ResultRow[][] = [];
		const patternPinned = storedRule('pattern', {
			...githubPrAddBody(url, identity, {
				repo: options.repo,
				jobWorkflowRef: 'acme/app/.github/workflows/publish.yml@refs/heads/main'
			}),
			claims: {
				...githubPrAddBody(url, identity, {
					repo: options.repo,
					jobWorkflowRef:
						'acme/app/.github/workflows/publish.yml@refs/heads/main'
				}).claims,
				repository_id: { pattern: '^12[0-9]{2}$' }
			}
		});

		let failure: unknown;
		try {
			await runGithubCheck(
				url,
				options,
				reporter(results),
				checkClient({ graceSeconds: 86_400, rules: [patternPinned] }),
				checkDependencies({})
			);
		} catch (error) {
			failure = error;
		}

		expectFailed(failure);
		expect(
			findings(results).find((row) => row.label === 'pull-request trust rule')
		).toStrictEqual({
			label: 'pull-request trust rule',
			value:
				'failed: rule pattern expects job_workflow_ref to match acme/app/.github/workflows/publish.yml@refs/heads/main; a run presents ' +
				pinnedWorkflowReference
		});
	});

	it('reports what it could not verify and exits unavailable', async () => {
		const results: ResultRow[][] = [];

		let failure: unknown;
		try {
			await runGithubCheck(
				url,
				{ ...options, manifest: undefined, rootPrefix: undefined },
				reporter(results),
				checkClient({ graceSeconds: 86_400, rules: [prRule, branchRule] }),
				checkDependencies({ variablesUnreadable: true })
			);
		} catch (error) {
			failure = error;
		}

		expectIncomplete(failure);
		expect({
			checks: failure.checks,
			exitCode: failure.exitCode
		}).toStrictEqual({
			checks: ['plan runner variable', 'runner labels', 'root prefix'],
			exitCode: unavailableExitCode
		});
	});

	// A rule whose claims match but whose stored grants drifted would pass a
	// claims-only check and still refuse the run's exchange; the grant check
	// must catch it.
	it('fails a claims-matching rule whose grants drifted', async () => {
		const results: ResultRow[][] = [];
		const grantDrifted = storedRule('branch', {
			...githubBranchAddBody(url, identity, {
				repo: options.repo,
				branch: options.branch,
				jobWorkflowRef: options.workflowRef
			}),
			permittedGrants: githubBranchAddBody(url, identity, {
				repo: options.repo,
				branch: 'release',
				jobWorkflowRef: options.workflowRef
			}).permittedGrants
		});

		let failure: unknown;
		try {
			await runGithubCheck(
				url,
				options,
				reporter(results),
				checkClient({
					graceSeconds: 86_400,
					rules: [prRule, grantDrifted]
				}),
				checkDependencies({})
			);
		} catch (error) {
			failure = error;
		}

		expectFailed(failure);
		expect({
			checks: failure.checks,
			row: findings(results)[1]
		}).toStrictEqual({
			checks: ['main trust rule'],
			row: {
				label: 'main trust rule',
				value:
					'failed: rule branch matches but its grants do not permit ' +
					'upload:negotiate, upload:status, upload:commit, ' +
					'attestation:negotiate, attestation:attach, root:set on cache ' +
					'_default with root github:acme/app/main/target; remove it and ' +
					're-run setup'
			}
		});
	});

	it('fails a manifest label the runners variable does not permit', async () => {
		const results: ResultRow[][] = [];

		let failure: unknown;
		try {
			await runGithubCheck(
				url,
				options,
				reporter(results),
				checkClient({ graceSeconds: 86_400, rules: [prRule, branchRule] }),
				checkDependencies({
					variables: {
						CUPBOARD_PLAN_RUNNER: 'ubuntu-latest',
						CUPBOARD_RUNNERS: 'ubuntu-latest'
					}
				})
			);
		} catch (error) {
			failure = error;
		}

		expectFailed(failure);
		expect({
			checks: failure.checks,
			planRunner: findings(results)[4],
			runnerLabels: findings(results)[5]
		}).toStrictEqual({
			checks: ['plan runner variable', 'runner labels'],
			planRunner: {
				label: 'plan runner variable',
				value:
					'failed: CUPBOARD_PLAN_RUNNER is not JSON; a plain label needs its quotes'
			},
			runnerLabels: {
				label: 'runner labels',
				value: 'failed: CUPBOARD_RUNNERS does not name macos-latest'
			}
		});
	});
});

function expectFailed(error: unknown): asserts error is GithubCheckFailedError {
	expect(error).toBeInstanceOf(GithubCheckFailedError);
}

function expectIncomplete(
	error: unknown
): asserts error is GithubCheckIncompleteError {
	expect(error).toBeInstanceOf(GithubCheckIncompleteError);
}
