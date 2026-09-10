import { capturingReporter as reporter } from '@cupboard/cli-ui/testing';
import {
	CacheInfo,
	servedStoreDirectory
} from '@cupboard/nix-store/cache-info';
import { cachePrioritySchema } from '@cupboard/nix-store/scalars';
import { type Operation, type PermittedGrant } from '@cupboard/protocol/grants';
import {
	oidcTrustListResponseSchema,
	type OidcTrustSummary,
	type OidcTrustSummaryInput,
	oidcTrustSummarySchema
} from '@cupboard/protocol/oidc';
import {
	reuseViewListResponseSchema,
	type ReuseViewSelectorInput,
	type ReuseViewSummaryInput
} from '@cupboard/protocol/reuse-views';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import type { ResultRow } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import { parseWorkerUrl } from '../../client/transport.ts';
import {
	CliAbortError,
	GithubCheckFailedError,
	GithubCheckIncompleteError,
	unavailableExitCode,
	WorkflowReferenceExactRequiredError,
	WorkflowReferenceNotFoundError,
	WorkflowReferenceUnpinnedError
} from '../../errors.ts';
import { githubBranchAddBody, githubPrAddBody } from '../oidc-trust.ts';
import { type RepositoryIdentity } from '../oidc-trust/github.ts';

import {
	type GithubCheckClient,
	type GithubCheckOptions,
	runGithubCheck
} from './check.ts';

const url = parseWorkerUrl('https://cupboard.example.workers.dev/t/acme');
const pinnedWorkflowReference =
	'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v1.2.3';
const previousWorkflowReference =
	'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v1.2.2';
const identity: RepositoryIdentity = {
	repositoryId: 1234,
	repositoryOwnerId: 5678,
	fullName: 'acme/app'
};

const options: GithubCheckOptions = {
	repo: 'acme/app',
	branch: 'main',
	workflowRef: pinnedWorkflowReference,
	rootPrefix: 'github:acme/app/main'
};

function storedRule(
	id: string,
	body: ReturnType<typeof githubPrAddBody>
): OidcTrustSummary {
	return oidcTrustSummarySchema.parse({ id, ...body, disabled: false });
}

function withoutOperation(
	rule: OidcTrustSummary,
	operation: Operation
): OidcTrustSummary {
	return {
		...rule,
		permittedGrants: rule.permittedGrants.map((grant): PermittedGrant =>
			grant.type === 'cupboard_cache'
				? {
						...grant,
						actions: grant.actions.filter((action) => action !== operation)
					}
				: grant
		)
	};
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
	selectors: readonly ReuseViewSelectorInput[] = [
		{ kind: 'prefix', prefix: 'pr-' }
	]
): ReuseViewSummaryInput {
	return {
		name: 'pull-requests',
		access: 'public',
		revision: 1,
		priority: 50,
		selectors: [...selectors],
		createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
		updatedAt: '2026-01-01T00:00:00.000Z'
	};
}

function checkClient(overrides: {
	graceSeconds?: number | undefined;
	extraPolicies?: { cachePrefix: string; graceSeconds: number }[];
	rules?: OidcTrustSummaryInput[];
	views?: ReuseViewSummaryInput[];
}): GithubCheckClient {
	return {
		reuseViews: {
			list: () =>
				Promise.resolve(
					reuseViewListResponseSchema.parse({
						views: overrides.views ?? [pullRequestView()]
					})
				)
		},
		oidcTrust: {
			list: () =>
				Promise.resolve(
					oidcTrustListResponseSchema.parse({ rules: overrides.rules ?? [] })
				)
		}
	};
}

function checkDependencies(overrides: {
	viewPriority?: number;
}): Parameters<typeof runGithubCheck>[4] {
	return {
		lookupRepository: () => Promise.resolve(identity),
		verifyWorkflowReference: () => Promise.resolve(),
		fetchCacheInfo: (target: URL) =>
			Promise.resolve(
				target.pathname.includes('/reuse/')
					? new CacheInfo(
							servedStoreDirectory,
							true,
							cachePrioritySchema.parse(overrides.viewPriority ?? 50)
						)
					: new CacheInfo(
							servedStoreDirectory,
							true,
							cachePrioritySchema.parse(40)
						)
			)
	};
}

function findings(results: ResultRow[][]): ResultRow[] {
	return results[0] ?? [];
}

describe('runGithubCheck', () => {
	it('cancels a stalled repository lookup with the command signal', async () => {
		const controller = new AbortController();
		const reason = new CliAbortError();
		const { promise: started, resolve: markStarted } =
			Promise.withResolvers<true>();
		const pending = runGithubCheck(
			url,
			options,
			reporter([]),
			checkClient({ graceSeconds: 86_400, rules: [prRule, branchRule] }),
			{
				...checkDependencies({}),
				signal: controller.signal,
				lookupRepository: (_repository, lookupOptions) => {
					const signal = lookupOptions?.signal;

					if (signal === undefined) {
						return Promise.reject(new Error('missing command signal'));
					}

					markStarted(true);

					return new Promise<RepositoryIdentity>((_resolve, reject) => {
						signal.addEventListener(
							'abort',
							() => {
								reject(reason);
							},
							{ once: true }
						);
					});
				}
			}
		);

		await started;
		controller.abort(reason);

		await expect(pending).rejects.toBe(reason);
	});

	it('checks the supplied workflow reference while previous rules overlap', async () => {
		const previousPrRule = storedRule(
			'previous-pr',
			githubPrAddBody(url, identity, {
				repo: options.repo,
				jobWorkflowRef: previousWorkflowReference
			})
		);
		const previousBranchRule = storedRule(
			'previous-branch',
			githubBranchAddBody(url, identity, {
				repo: options.repo,
				branch: options.branch,
				jobWorkflowRef: previousWorkflowReference
			})
		);

		await expect(
			runGithubCheck(
				url,
				options,
				reporter([]),
				checkClient({
					graceSeconds: 86_400,
					rules: [previousPrRule, previousBranchRule, prRule, branchRule]
				}),
				checkDependencies({})
			)
		).resolves.toBeUndefined();
	});

	it('refuses a bare workflow path before consulting the tenant', async () => {
		const results: ResultRow[][] = [];

		await expect(
			runGithubCheck(
				url,
				{ ...options, workflowRef: 'acme/app/.github/workflows/publish.yml' },
				reporter(results),
				checkClient({ graceSeconds: 86_400, rules: [prRule, branchRule] }),
				checkDependencies({})
			)
		).rejects.toBeInstanceOf(WorkflowReferenceUnpinnedError);
		expect(results).toStrictEqual([]);
	});

	it('refuses an unresolved workflow before consulting the tenant', async () => {
		const results: ResultRow[][] = [];
		let hasListed = false;
		const client = checkClient({
			graceSeconds: 86_400,
			rules: [prRule, branchRule]
		});
		client.oidcTrust.list = () => {
			hasListed = true;

			return Promise.resolve({ rules: [] });
		};

		await expect(
			runGithubCheck(url, options, reporter(results), client, {
				...checkDependencies({}),
				verifyWorkflowReference: () =>
					Promise.reject(
						new WorkflowReferenceNotFoundError(options.workflowRef)
					)
			})
		).rejects.toBeInstanceOf(WorkflowReferenceNotFoundError);
		expect({ hasListed, results }).toStrictEqual({
			hasListed: false,
			results: []
		});
	});

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
			{ label: 'reuse view', value: 'ok' },
			{ label: 'root prefix', value: 'ok' }
		]);
	});

	it('propagates an abort while reading the reuse view', async () => {
		const reason = new CliAbortError();

		await expect(
			runGithubCheck(
				url,
				options,
				reporter([]),
				checkClient({ graceSeconds: 86_400, rules: [prRule, branchRule] }),
				{
					...checkDependencies({}),
					fetchCacheInfo: (target) =>
						target.pathname.includes('/reuse/')
							? Promise.reject(reason)
							: Promise.resolve(
									new CacheInfo(
										servedStoreDirectory,
										true,
										cachePrioritySchema.parse(40)
									)
								)
				}
			)
		).rejects.toBe(reason);
	});

	it.each([
		{
			name: 'missing',
			views: [],
			detail: 'the pull-requests view is not defined'
		},
		{
			name: 'wrong selector',
			views: [pullRequestView([{ kind: 'prefix', prefix: 'pull-' }])],
			detail:
				'stored selectors differ from the single pr- prefix setup would write'
		},
		{
			name: 'extra selector',
			views: [
				pullRequestView([
					{ kind: 'prefix', prefix: 'pr-' },
					{ kind: 'named', name: 'release' }
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
						{ label: 'reuse view', value: `failed: ${detail}` },
						{ label: 'root prefix', value: 'ok' }
					]
				}
			);
		}
	);

	it('reports every configuration failure before throwing', async () => {
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
				'reuse view',
				'root prefix'
			],
			rows: [
				{
					label: 'pull-request trust rule',
					value:
						'failed: rule pr expects job_workflow_ref to match acme/app/.github/workflows/publish.yml@refs/heads/main; the modelled run uses ' +
						pinnedWorkflowReference
				},
				{
					label: 'main trust rule',
					value:
						'failed: rule pr expects event_name to match pull_request; the modelled run uses push'
				},
				{
					label: 'reuse view',
					value: "failed: view priority 40 does not exceed the destination's 40"
				},
				{
					label: 'root prefix',
					value:
						'failed: github:other/repo/main does not nest under the granted github:acme/app/main/'
				}
			]
		});
	});

	it('reports the workflow-reference mismatch from the pull-request rule', async () => {
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
						'failed: rule pr expects job_workflow_ref to match acme/app/.github/workflows/publish.yml@refs/heads/main; the modelled run uses ' +
						pinnedWorkflowReference
				},
				{ label: 'main trust rule', value: 'ok' }
			]
		});
	});

	it('reports the claim mismatch from a pattern-pinned repository rule', async () => {
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
				'failed: rule pattern expects job_workflow_ref to match acme/app/.github/workflows/publish.yml@refs/heads/main; the modelled run uses ' +
				pinnedWorkflowReference
		});
	});

	it('reports a missing root-prefix input and exits unavailable', async () => {
		const results: ResultRow[][] = [];

		let failure: unknown;
		try {
			await runGithubCheck(
				url,
				{ ...options, rootPrefix: undefined },
				reporter(results),
				checkClient({ graceSeconds: 86_400, rules: [prRule, branchRule] }),
				checkDependencies({})
			);
		} catch (error) {
			failure = error;
		}

		expectIncomplete(failure);
		expect({
			checks: failure.checks,
			exitCode: failure.exitCode
		}).toStrictEqual({
			checks: ['root prefix'],
			exitCode: unavailableExitCode
		});
	});

	it('refuses an interactive owner rule that matches the modelled claims', async () => {
		const results: ResultRow[][] = [];
		const ownerRule = storedRule('owner', {
			...githubPrAddBody(url, identity, {
				repo: options.repo,
				jobWorkflowRef: options.workflowRef
			}),
			claims: { sub: 'repo:acme/app:pull_request' },
			permittedGrants: [{ type: 'cupboard_wildcard' }]
		});

		let failure: unknown;
		try {
			await runGithubCheck(
				url,
				options,
				reporter(results),
				checkClient({
					graceSeconds: 86_400,
					rules: [ownerRule, prRule, branchRule]
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
						'failed: interactive rule owner matches the modelled claims; ' +
						'workflows must use a scoped CI rule'
				},
				{ label: 'main trust rule', value: 'ok' }
			]
		});
	});

	it('reports missing authority after the modelled claims match', async () => {
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
					'failed: rule branch matches the modelled claims but does not permit ' +
					'upload:negotiate, upload:status, upload:commit, ' +
					'attestation:negotiate, attestation:attach, root:set on cache ' +
					'(default) with root github:acme/app/main/target; remove it and ' +
					're-run setup'
			}
		});
	});

	it.each([
		{
			name: 'pull-request root listing',
			operation: 'root:list',
			rules: [withoutOperation(prRule, 'root:list'), branchRule],
			check: 'pull-request trust rule',
			row: 0,
			detail: 'root:list on cache pr-1 with root github:acme/app/pr-1/target'
		},
		{
			name: 'pull-request run-root attachment',
			operation: 'root:attach',
			rules: [withoutOperation(prRule, 'root:attach'), branchRule],
			check: 'pull-request trust rule',
			row: 0,
			detail:
				'root:attach on cache pr-1 with root ' +
				'github:acme/app/pr-1/_cupboard-run/1'
		},
		{
			name: 'branch root listing',
			operation: 'root:list',
			rules: [prRule, withoutOperation(branchRule, 'root:list')],
			check: 'main trust rule',
			row: 1,
			detail:
				'root:list on cache (default) with root github:acme/app/main/target'
		},
		{
			name: 'branch run-root attachment',
			operation: 'root:attach',
			rules: [prRule, withoutOperation(branchRule, 'root:attach')],
			check: 'main trust rule',
			row: 1,
			detail:
				'root:attach on cache (default) with root ' +
				'github:acme/app/main/_cupboard-run/1'
		}
	] as const)(
		'fails a rule missing the $name grant',
		async ({ operation, rules, check, row, detail }) => {
			const results: ResultRow[][] = [];
			let failure: unknown;

			try {
				await runGithubCheck(
					url,
					options,
					reporter(results),
					checkClient({ graceSeconds: 86_400, rules: [...rules] }),
					checkDependencies({})
				);
			} catch (error) {
				failure = error;
			}

			expectFailed(failure);
			expect({
				operation,
				checks: failure.checks,
				row: findings(results)[row]
			}).toStrictEqual({
				operation,
				checks: [check],
				row: {
					label: check,
					value:
						`failed: rule ${check.startsWith('pull-request') ? 'pr' : 'branch'} ` +
						`matches the modelled claims but does not permit ${detail}; remove it and ` +
						're-run setup'
				}
			});
		}
	);

	it('rejects a tag pattern because check requires an exact reference', async () => {
		const patternReference =
			'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v*';

		await expect(
			runGithubCheck(
				url,
				{ ...options, workflowRef: patternReference },
				reporter([]),
				checkClient({ graceSeconds: 86_400 }),
				checkDependencies({})
			)
		).rejects.toStrictEqual(
			new WorkflowReferenceExactRequiredError(patternReference)
		);
	});

	it('accepts stored tag patterns that match the supplied exact reference', async () => {
		const patternReference =
			'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v*';
		const patternRules = [
			storedRule(
				'pattern-pr',
				githubPrAddBody(url, identity, {
					repo: options.repo,
					jobWorkflowRef: patternReference
				})
			),
			storedRule(
				'pattern-branch',
				githubBranchAddBody(url, identity, {
					repo: options.repo,
					branch: options.branch,
					jobWorkflowRef: patternReference
				})
			)
		];
		const results: ResultRow[][] = [];

		await runGithubCheck(
			url,
			options,
			reporter(results),
			checkClient({ graceSeconds: 86_400, rules: patternRules }),
			checkDependencies({})
		);

		expect(findings(results)).toStrictEqual([
			{ label: 'pull-request trust rule', value: 'ok' },
			{ label: 'main trust rule', value: 'ok' },
			{ label: 'reuse view', value: 'ok' },
			{ label: 'root prefix', value: 'ok' }
		]);
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
