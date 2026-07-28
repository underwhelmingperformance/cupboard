import { type CliUi } from '@cupboard/cli-ui';
import {
	capturingReporter,
	type CliUiScript,
	fakeCliUi
} from '@cupboard/cli-ui/testing';
import {
	CacheInfo,
	servedStoreDirectory
} from '@cupboard/nix-store/cache-info';
import {
	cachePrioritySchema,
	graceSecondsSchema
} from '@cupboard/nix-store/scalars';
import {
	type OidcTrustAddBody,
	oidcTrustListResponseSchema,
	type OidcTrustSummary,
	oidcTrustSummarySchema,
	trustRuleIdSchema
} from '@cupboard/protocol/oidc';
import type { GracePolicyAddBody } from '@cupboard/protocol/retention';
import {
	reuseViewListResponseSchema,
	type ReuseViewSelector,
	reuseViewSummarySchema
} from '@cupboard/protocol/reuse-views';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import type { ResultRow } from '@cupboard/reporter';
import { readUserInputSchema } from '@cupboard/shared/http';
import { Command } from 'commander';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

import { parseWorkerUrl } from '../client/transport.ts';
import {
	CacheInfoRateLimitedError,
	CacheInfoServerError,
	CacheInfoTimeoutError,
	CacheInfoUnavailableError,
	CliAbortError,
	GithubSetupDriftError,
	GithubSetupOwnerRuleConflictError,
	GithubSetupRemovalError,
	GraceTooShortError,
	ReadCredentialPairError,
	WorkflowReferenceMutableError
} from '../errors.ts';

import {
	cacheInfoFetcher,
	type GithubSetupClient,
	type GithubSetupOptions,
	registerGithubCommands,
	runGithubSetup
} from './github.ts';
import { githubBranchAddBody, githubPrAddBody } from './oidc-trust.ts';
import { type RepositoryIdentity } from './oidc-trust/github.ts';

const url = parseWorkerUrl('https://cupboard.example.workers.dev/t/acme');
const alice = readUserInputSchema.parse('alice');
const identity: RepositoryIdentity = {
	repositoryId: 1234,
	repositoryOwnerId: 5678,
	fullName: 'acme/app'
};

const pinnedWorkflowReference =
	'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v1.2.3';
const previousWorkflowReference =
	'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v1.2.2';
const movableWorkflowReference =
	'acme/app/.github/workflows/publish.yml@refs/heads/main';
const ruleCreated = `created: ${pinnedWorkflowReference}`;
const options: GithubSetupOptions = {
	repo: 'acme/app',
	branch: 'main',
	grace: '24h',
	workflowRef: pinnedWorkflowReference
};

const prBody = githubPrAddBody(url, identity, {
	repo: options.repo,
	jobWorkflowRef: options.workflowRef
});
const branchBody = githubBranchAddBody(url, identity, {
	repo: options.repo,
	branch: options.branch,
	jobWorkflowRef: options.workflowRef
});
const previousPrBody = githubPrAddBody(url, identity, {
	repo: options.repo,
	jobWorkflowRef: previousWorkflowReference
});
const previousBranchBody = githubBranchAddBody(url, identity, {
	repo: options.repo,
	branch: options.branch,
	jobWorkflowRef: previousWorkflowReference
});

function storedRule(id: string, body: OidcTrustAddBody) {
	return oidcTrustSummarySchema.parse({ id, ...body, disabled: false });
}

interface Recorded {
	readonly graceAdds: GracePolicyAddBody[];
	readonly viewSets: {
		name: string;
		selectors: readonly ReuseViewSelector[];
		priority?: number;
	}[];
	readonly ruleAdds: OidcTrustAddBody[];
	readonly ruleRemoves: string[];
}

interface Stored {
	readonly gracePolicies?: { cachePrefix: string; graceSeconds: number }[];
	readonly views?: {
		name: string;
		priority: number;
		selectors: readonly ReuseViewSelector[];
	}[];
	readonly rules?: OidcTrustSummary[];
}

function setupClient(stored: Stored): {
	client: GithubSetupClient;
	recorded: Recorded;
} {
	const recorded: Recorded = {
		graceAdds: [],
		viewSets: [],
		ruleAdds: [],
		ruleRemoves: []
	};
	const client: GithubSetupClient = {
		policies: {
			graceList: () =>
				Promise.resolve({
					policies: (stored.gracePolicies ?? []).map((policy, index) => ({
						id: `grace-${String(index)}`,
						createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
						...policy,
						graceSeconds: graceSecondsSchema.parse(policy.graceSeconds)
					}))
				}),
			graceAdd(input) {
				recorded.graceAdds.push(input);

				return Promise.resolve({
					id: 'grace-new',
					createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
					cachePrefix: input.cachePrefix,
					graceSeconds: graceSecondsSchema.parse(input.graceSeconds)
				});
			}
		},
		reuseViews: {
			list: () =>
				Promise.resolve(
					reuseViewListResponseSchema.parse({
						views: (stored.views ?? []).map((view, index) => ({
							revision: index + 1,
							createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
							updatedAt: '2026-01-01T00:00:00.000Z',
							...view,
							selectors: [...view.selectors]
						}))
					})
				),
			set(input) {
				recorded.viewSets.push(input);

				return Promise.resolve(
					reuseViewSummarySchema.parse({
						name: input.name,
						revision: 1,
						priority: input.priority ?? 50,
						selectors: [...input.selectors],
						createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
						updatedAt: '2026-01-01T00:00:00.000Z'
					})
				);
			}
		},
		oidcTrust: {
			list: () =>
				Promise.resolve(
					oidcTrustListResponseSchema.parse({ rules: stored.rules ?? [] })
				),
			add(input) {
				recorded.ruleAdds.push(input);

				return Promise.resolve(storedRule('rule-new', input));
			},
			remove({ id }) {
				recorded.ruleRemoves.push(id);

				return Promise.resolve({
					id: trustRuleIdSchema.parse(id),
					removed: true
				});
			}
		}
	};

	return { client, recorded };
}

const dependencies = {
	lookupRepository: () => Promise.resolve(identity),
	fetchCacheInfo: () =>
		Promise.resolve(
			new CacheInfo(servedStoreDirectory, true, cachePrioritySchema.parse(40))
		),
	verifyWorkflowReference: () => Promise.resolve()
};

function reporter(results: ResultRow[][], script: CliUiScript = {}): CliUi {
	const { ui } = fakeCliUi(script);

	return { ...ui, reporter: () => capturingReporter(results) };
}

function expectDriftError(
	error: unknown
): asserts error is GithubSetupDriftError {
	expect(error).toBeInstanceOf(GithubSetupDriftError);
}

function expectRemovalError(
	error: unknown
): asserts error is GithubSetupRemovalError {
	expect(error).toBeInstanceOf(GithubSetupRemovalError);
}

describe('runGithubSetup', () => {
	it('cancels stalled workflow verification with the command signal', async () => {
		const controller = new AbortController();
		const reason = new CliAbortError();
		const { promise: started, resolve: markStarted } =
			Promise.withResolvers<true>();
		const { client, recorded } = setupClient({});
		const pending = runGithubSetup(url, options, reporter([]), client, {
			...dependencies,
			signal: controller.signal,
			verifyWorkflowReference: (_reference, lookupOptions) => {
				const signal = lookupOptions?.signal;

				if (signal === undefined) {
					return Promise.reject(new Error('missing command signal'));
				}

				markStarted(true);

				return new Promise<void>((_resolve, reject) => {
					signal.addEventListener(
						'abort',
						() => {
							reject(reason);
						},
						{ once: true }
					);
				});
			}
		});

		await started;
		controller.abort(reason);

		await expect(pending).rejects.toBe(reason);
		expect(recorded).toStrictEqual({
			graceAdds: [],
			viewSets: [],
			ruleAdds: [],
			ruleRemoves: []
		});
	});

	it('creates the whole configuration on a fresh tenant', async () => {
		const results: ResultRow[][] = [];
		const { client, recorded } = setupClient({});

		await runGithubSetup(url, options, reporter(results), client, dependencies);

		expect({ recorded, results }).toStrictEqual({
			recorded: {
				graceAdds: [{ cachePrefix: '', graceSeconds: 86_400 }],
				viewSets: [
					{
						name: 'pull-requests',
						selectors: [{ kind: 'prefix', pattern: 'pr-' }],
						priority: 50
					}
				],
				ruleAdds: [prBody, branchBody],
				ruleRemoves: []
			},
			results: [
				[
					{ label: 'grace policy', value: 'created: tenant-wide grace 86400s' },
					{ label: 'reuse view', value: 'created: pr- caches at priority 50' },
					{ label: 'pull-request trust rule', value: ruleCreated },
					{ label: 'main trust rule', value: ruleCreated }
				]
			]
		});
	});

	it('derives the audience from the tenant URL without its trailing slash', async () => {
		const results: ResultRow[][] = [];
		const { client, recorded } = setupClient({
			gracePolicies: [{ cachePrefix: '', graceSeconds: 86_400 }],
			views: [
				{
					name: 'pull-requests',
					priority: 50,
					selectors: [{ kind: 'prefix', pattern: 'pr-' }]
				}
			],
			rules: [
				storedRule('previous-pr', previousPrBody),
				storedRule('previous-branch', previousBranchBody)
			]
		});

		await runGithubSetup(
			parseWorkerUrl(`${url}/`),
			options,
			reporter(results),
			client,
			dependencies
		);

		expect({ recorded, outcomes: results[0] }).toStrictEqual({
			recorded: {
				graceAdds: [],
				viewSets: [],
				ruleAdds: [prBody, branchBody],
				ruleRemoves: []
			},
			outcomes: [
				{ label: 'grace policy', value: 'unchanged' },
				{ label: 'reuse view', value: 'unchanged' },
				{ label: 'pull-request trust rule', value: ruleCreated },
				{ label: 'main trust rule', value: ruleCreated },
				{
					label: 'superseded trust rule previous-branch',
					value: `retained: main pushes; ${previousWorkflowReference}`
				},
				{
					label: 'superseded trust rule previous-pr',
					value: `retained: pull requests and main pushes; ${previousWorkflowReference}`
				}
			]
		});
	});

	// The check command treats a sub-hour grace as failed, so setup must not
	// store one; the refusal lands before any tenant write.
	it('refuses a sub-hour grace before writing anything', async () => {
		const { client, recorded } = setupClient({});

		let failure: unknown;
		try {
			await runGithubSetup(
				url,
				{ ...options, grace: '30m' },
				reporter([]),
				client,
				dependencies
			);
		} catch (error) {
			failure = error;
		}

		expect({ failure, recorded }).toStrictEqual({
			failure: new GraceTooShortError(1800, 3600),
			recorded: {
				graceAdds: [],
				viewSets: [],
				ruleAdds: [],
				ruleRemoves: []
			}
		});
		expect(failure).toBeInstanceOf(GraceTooShortError);
	});

	it('refuses a mutable workflow ref before writing anything', async () => {
		const { client, recorded } = setupClient({});

		let failure: unknown;
		try {
			await runGithubSetup(
				url,
				{
					...options,
					workflowRef: 'acme/app/.github/workflows/publish.yml@refs/heads/main'
				},
				reporter([]),
				client,
				dependencies
			);
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(WorkflowReferenceMutableError);
		expect(recorded).toStrictEqual({
			graceAdds: [],
			viewSets: [],
			ruleAdds: [],
			ruleRemoves: []
		});
	});

	it('performs no writes against converged state', async () => {
		const results: ResultRow[][] = [];
		const { client, recorded } = setupClient({
			gracePolicies: [{ cachePrefix: '', graceSeconds: 86_400 }],
			views: [
				{
					name: 'pull-requests',
					priority: 50,
					selectors: [{ kind: 'prefix', pattern: 'pr-' }]
				}
			],
			rules: [storedRule('pr', prBody), storedRule('branch', branchBody)]
		});

		await runGithubSetup(url, options, reporter(results), client, dependencies);

		expect({ recorded, outcomes: results[0]?.slice(0, 4) }).toStrictEqual({
			recorded: {
				graceAdds: [],
				viewSets: [],
				ruleAdds: [],
				ruleRemoves: []
			},
			outcomes: [
				{ label: 'grace policy', value: 'unchanged' },
				{ label: 'reuse view', value: 'unchanged' },
				{ label: 'pull-request trust rule', value: 'unchanged' },
				{ label: 'main trust rule', value: 'unchanged' }
			]
		});
	});

	it('retains safe rules for a previous workflow while adding the new rules', async () => {
		const results: ResultRow[][] = [];
		const verifiedReferences: string[] = [];
		const legacyPrBody: OidcTrustAddBody = {
			...previousPrBody,
			claims: {
				repository_id: String(identity.repositoryId),
				repository_owner_id: String(identity.repositoryOwnerId),
				job_workflow_ref: previousWorkflowReference
			},
			permittedGrants: previousBranchBody.permittedGrants
		};
		const { client, recorded } = setupClient({
			gracePolicies: [{ cachePrefix: '', graceSeconds: 86_400 }],
			views: [
				{
					name: 'pull-requests',
					priority: 50,
					selectors: [{ kind: 'prefix', pattern: 'pr-' }]
				}
			],
			rules: [
				storedRule('previous-pr', legacyPrBody),
				storedRule('previous-branch', previousBranchBody)
			]
		});

		await runGithubSetup(url, options, reporter(results), client, {
			...dependencies,
			verifyWorkflowReference({ reference }) {
				verifiedReferences.push(reference);

				return Promise.resolve();
			}
		});

		expect({
			recorded,
			outcomes: results[0],
			verifiedReferences
		}).toStrictEqual({
			recorded: {
				graceAdds: [],
				viewSets: [],
				ruleAdds: [prBody, branchBody],
				ruleRemoves: []
			},
			outcomes: [
				{ label: 'grace policy', value: 'unchanged' },
				{ label: 'reuse view', value: 'unchanged' },
				{ label: 'pull-request trust rule', value: ruleCreated },
				{ label: 'main trust rule', value: ruleCreated },
				{
					label: 'superseded trust rule previous-branch',
					value: `retained: main pushes; ${previousWorkflowReference}`
				},
				{
					label: 'superseded trust rule previous-pr',
					value: `retained: pull requests and main pushes; ${previousWorkflowReference}`
				}
			],
			verifiedReferences: [pinnedWorkflowReference, previousWorkflowReference]
		});
	});

	it('verifies a previous release before accepting it as an overlap', async () => {
		const { client, recorded } = setupClient({
			rules: [
				storedRule('previous-pr', previousPrBody),
				storedRule('previous-branch', previousBranchBody)
			]
		});

		await expect(
			runGithubSetup(url, options, reporter([]), client, {
				...dependencies,
				verifyWorkflowReference({ reference }) {
					return reference === previousWorkflowReference
						? Promise.reject(
								new WorkflowReferenceMutableError(reference, 'refs/tags/v1.2.2')
							)
						: Promise.resolve();
				}
			})
		).rejects.toBeInstanceOf(WorkflowReferenceMutableError);
		expect(recorded).toStrictEqual({
			graceAdds: [],
			viewSets: [],
			ruleAdds: [],
			ruleRemoves: []
		});
	});

	it('offers safe previous-workflow rules for optional removal after applying', async () => {
		const results: ResultRow[][] = [];
		const { ui, captured } = fakeCliUi({
			interactive: true,
			multiSelects: [['previous-pr', 'previous-branch']]
		});
		const { client, recorded } = setupClient({
			gracePolicies: [{ cachePrefix: '', graceSeconds: 86_400 }],
			views: [
				{
					name: 'pull-requests',
					priority: 50,
					selectors: [{ kind: 'prefix', pattern: 'pr-' }]
				}
			],
			rules: [
				storedRule('previous-pr', previousPrBody),
				storedRule('previous-branch', previousBranchBody)
			]
		});

		await runGithubSetup(
			url,
			options,
			{ ...ui, reporter: () => capturingReporter(results) },
			client,
			dependencies
		);

		expect({
			recorded,
			prompts: captured.multiSelects,
			outcomes: results[0]
		}).toStrictEqual({
			recorded: {
				graceAdds: [],
				viewSets: [],
				ruleAdds: [prBody, branchBody],
				ruleRemoves: ['previous-branch', 'previous-pr']
			},
			prompts: [
				{
					message: 'Remove superseded trust rules?',
					entries: [
						{
							value: 'previous-branch',
							label: 'main pushes (previous-branch)',
							hint: previousWorkflowReference
						},
						{
							value: 'previous-pr',
							label: 'pull requests and main pushes (previous-pr)',
							hint: previousWorkflowReference
						}
					],
					initialValues: []
				}
			],
			outcomes: [
				{ label: 'grace policy', value: 'unchanged' },
				{ label: 'reuse view', value: 'unchanged' },
				{ label: 'pull-request trust rule', value: ruleCreated },
				{ label: 'main trust rule', value: ruleCreated },
				{
					label: 'superseded trust rule previous-branch',
					value: `removed: main pushes; ${previousWorkflowReference}`
				},
				{
					label: 'superseded trust rule previous-pr',
					value: `removed: pull requests and main pushes; ${previousWorkflowReference}`
				}
			]
		});
	});

	it('cancels before any write when the conflict confirmation is declined', async () => {
		const conflict = storedRule('conflict', {
			...prBody,
			claims: {
				repository_id: String(identity.repositoryId),
				repository_owner_id: String(identity.repositoryOwnerId),
				ref: 'refs/pull/42/merge',
				job_workflow_ref: pinnedWorkflowReference
			},
			permittedGrants: previousPrBody.permittedGrants
		});
		const { ui, captured } = fakeCliUi({
			interactive: true,
			confirm: 'no'
		});
		const { client, recorded } = setupClient({
			rules: [conflict]
		});

		await runGithubSetup(url, options, ui, client, dependencies);
		expect({
			recorded,
			confirms: captured.confirms,
			multiSelects: captured.multiSelects,
			cancellations: captured.cancellations
		}).toStrictEqual({
			recorded: {
				graceAdds: [],
				viewSets: [],
				ruleAdds: [],
				ruleRemoves: []
			},
			confirms: [
				{
					message: 'Remove all conflicting trust rules to continue?',
					detail: `pull requests (conflict): ${pinnedWorkflowReference}`
				}
			],
			multiSelects: [],
			cancellations: ['GitHub setup was left unchanged.']
		});
	});

	it('cancels conflicting-rule removal in a non-interactive run without --yes', async () => {
		const conflict = storedRule('conflict', {
			...branchBody,
			permittedGrants: prBody.permittedGrants
		});
		const { ui, captured } = fakeCliUi({});
		const { client, recorded } = setupClient({ rules: [conflict] });

		await runGithubSetup(url, options, ui, client, dependencies);
		expect({
			recorded,
			confirms: captured.confirms,
			cancellations: captured.cancellations
		}).toStrictEqual({
			recorded: {
				graceAdds: [],
				viewSets: [],
				ruleAdds: [],
				ruleRemoves: []
			},
			confirms: [
				{
					message: 'Remove all conflicting trust rules to continue?',
					detail: `main pushes (conflict): ${pinnedWorkflowReference}`
				}
			],
			cancellations: ['GitHub setup was left unchanged.']
		});
	});

	it('retains a rule pinning claims setup cannot check in an unattended run', async () => {
		const results: ResultRow[][] = [];
		const dispatch = storedRule('dispatch', {
			...branchBody,
			claims: {
				...branchBody.claims,
				event_name: 'workflow_dispatch'
			},
			permittedGrants: prBody.permittedGrants
		});
		const { client, recorded } = setupClient({
			gracePolicies: [{ cachePrefix: '', graceSeconds: 86_400 }],
			views: [
				{
					name: 'pull-requests',
					priority: 50,
					selectors: [{ kind: 'prefix', pattern: 'pr-' }]
				}
			],
			rules: [dispatch]
		});

		await runGithubSetup(
			url,
			{ ...options, yes: true },
			reporter(results),
			client,
			dependencies
		);

		expect({ recorded, outcomes: results[0] }).toStrictEqual({
			recorded: {
				graceAdds: [],
				viewSets: [],
				ruleAdds: [prBody, branchBody],
				ruleRemoves: []
			},
			outcomes: [
				{ label: 'grace policy', value: 'unchanged' },
				{ label: 'reuse view', value: 'unchanged' },
				{
					label: 'possibly conflicting trust rule dispatch',
					value: `retained: main pushes; ${pinnedWorkflowReference}; setup cannot check event_name`
				},
				{ label: 'pull-request trust rule', value: ruleCreated },
				{ label: 'main trust rule', value: ruleCreated }
			]
		});
	});

	it('offers rules setup cannot check for optional removal interactively', async () => {
		const results: ResultRow[][] = [];
		const dispatch = storedRule('dispatch', {
			...branchBody,
			claims: {
				...branchBody.claims,
				event_name: 'workflow_dispatch'
			},
			permittedGrants: prBody.permittedGrants
		});
		const { ui, captured } = fakeCliUi({
			interactive: true,
			multiSelects: [['dispatch']]
		});
		const { client, recorded } = setupClient({
			gracePolicies: [{ cachePrefix: '', graceSeconds: 86_400 }],
			views: [
				{
					name: 'pull-requests',
					priority: 50,
					selectors: [{ kind: 'prefix', pattern: 'pr-' }]
				}
			],
			rules: [dispatch]
		});

		await runGithubSetup(
			url,
			options,
			{ ...ui, reporter: () => capturingReporter(results) },
			client,
			dependencies
		);

		expect({
			recorded,
			prompts: captured.multiSelects,
			outcomes: results[0]
		}).toStrictEqual({
			recorded: {
				graceAdds: [],
				viewSets: [],
				ruleAdds: [prBody, branchBody],
				ruleRemoves: ['dispatch']
			},
			prompts: [
				{
					message: 'Remove trust rules that may also match the new workflow?',
					entries: [
						{
							value: 'dispatch',
							label: 'main pushes (dispatch)',
							hint: `${pinnedWorkflowReference} (setup cannot check event_name)`
						}
					],
					initialValues: []
				}
			],
			outcomes: [
				{ label: 'grace policy', value: 'unchanged' },
				{ label: 'reuse view', value: 'unchanged' },
				{
					label: 'possibly conflicting trust rule dispatch',
					value: `removed: main pushes; ${pinnedWorkflowReference}; setup cannot check event_name`
				},
				{ label: 'pull-request trust rule', value: ruleCreated },
				{ label: 'main trust rule', value: ruleCreated }
			]
		});
	});

	it('refuses an immutable owner-rule conflict before writing', async () => {
		const owner = storedRule('owner', {
			...prBody,
			claims: { sub: 'repo:acme/app:pull_request' },
			permittedGrants: [{ type: 'cupboard_wildcard' }]
		});
		const { client, recorded } = setupClient({ rules: [owner] });

		await expect(
			runGithubSetup(url, options, reporter([]), client, dependencies)
		).rejects.toBeInstanceOf(GithubSetupOwnerRuleConflictError);
		expect(recorded).toStrictEqual({
			graceAdds: [],
			viewSets: [],
			ruleAdds: [],
			ruleRemoves: []
		});
	});

	it('ignores an owner rule whose subject names a different repository', async () => {
		const results: ResultRow[][] = [];
		const owner = storedRule('owner', {
			...prBody,
			claims: { sub: 'repo:acme/infra:ref:refs/heads/main' },
			permittedGrants: [{ type: 'cupboard_wildcard' }]
		});
		const { client, recorded } = setupClient({ rules: [owner] });

		await runGithubSetup(url, options, reporter(results), client, dependencies);

		expect({ recorded, outcomes: results[0] }).toStrictEqual({
			recorded: {
				graceAdds: [{ cachePrefix: '', graceSeconds: 86_400 }],
				viewSets: [
					{
						name: 'pull-requests',
						selectors: [{ kind: 'prefix', pattern: 'pr-' }],
						priority: 50
					}
				],
				ruleAdds: [prBody, branchBody],
				ruleRemoves: []
			},
			outcomes: [
				{ label: 'grace policy', value: 'created: tenant-wide grace 86400s' },
				{ label: 'reuse view', value: 'created: pr- caches at priority 50' },
				{ label: 'pull-request trust rule', value: ruleCreated },
				{ label: 'main trust rule', value: ruleCreated }
			]
		});
	});

	it('does not offer a disjoint immutable owner rule for cleanup', async () => {
		const owner = storedRule('owner', {
			...prBody,
			claims: { job_workflow_ref: previousWorkflowReference },
			permittedGrants: [{ type: 'cupboard_wildcard' }]
		});
		const { ui, captured } = fakeCliUi({
			interactive: true,
			multiSelects: [['owner']]
		});
		const { client, recorded } = setupClient({
			gracePolicies: [{ cachePrefix: '', graceSeconds: 86_400 }],
			views: [
				{
					name: 'pull-requests',
					priority: 50,
					selectors: [{ kind: 'prefix', pattern: 'pr-' }]
				}
			],
			rules: [owner, storedRule('pr', prBody), storedRule('branch', branchBody)]
		});

		await runGithubSetup(url, options, ui, client, dependencies);

		expect({ recorded, prompts: captured.multiSelects }).toStrictEqual({
			recorded: {
				graceAdds: [],
				viewSets: [],
				ruleAdds: [],
				ruleRemoves: []
			},
			prompts: []
		});
	});

	it('removes every conflict once the confirmation is accepted', async () => {
		const results: ResultRow[][] = [];
		const conflict = storedRule('conflict', {
			...prBody,
			permittedGrants: branchBody.permittedGrants
		});
		const { ui, captured } = fakeCliUi({
			interactive: true,
			confirm: 'yes'
		});
		const { client, recorded } = setupClient({
			gracePolicies: [{ cachePrefix: '', graceSeconds: 86_400 }],
			views: [
				{
					name: 'pull-requests',
					priority: 50,
					selectors: [{ kind: 'prefix', pattern: 'pr-' }]
				}
			],
			rules: [conflict, storedRule('branch', branchBody)]
		});

		await runGithubSetup(
			url,
			options,
			{ ...ui, reporter: () => capturingReporter(results) },
			client,
			dependencies
		);

		expect({ recorded, confirms: captured.confirms }).toStrictEqual({
			recorded: {
				graceAdds: [],
				viewSets: [],
				ruleAdds: [prBody],
				ruleRemoves: ['conflict']
			},
			confirms: [
				{
					message: 'Remove all conflicting trust rules to continue?',
					detail: `pull requests and main pushes (conflict): ${pinnedWorkflowReference}`
				}
			]
		});
	});

	it('leaves the conflicting rule in place when a rule add fails', async () => {
		const failure = new Error('rule add failed');
		const conflict = storedRule('conflict', {
			...prBody,
			permittedGrants: branchBody.permittedGrants
		});
		const { client, recorded } = setupClient({ rules: [conflict] });
		const failingClient: GithubSetupClient = {
			...client,
			oidcTrust: {
				...client.oidcTrust,
				add: () => Promise.reject(failure)
			}
		};

		await expect(
			runGithubSetup(
				url,
				options,
				reporter([], { confirm: 'yes' }),
				failingClient,
				dependencies
			)
		).rejects.toBe(failure);
		expect(recorded).toStrictEqual({
			graceAdds: [{ cachePrefix: '', graceSeconds: 86_400 }],
			viewSets: [
				{
					name: 'pull-requests',
					selectors: [{ kind: 'prefix', pattern: 'pr-' }],
					priority: 50
				}
			],
			ruleAdds: [],
			ruleRemoves: []
		});
	});

	it('removes conflicts with --yes, applies new rules and retains safe rules', async () => {
		const results: ResultRow[][] = [];
		const conflict = storedRule('conflict', {
			...prBody,
			claims: {
				repository_id: String(identity.repositoryId),
				repository_owner_id: String(identity.repositoryOwnerId),
				job_workflow_ref: pinnedWorkflowReference
			},
			permittedGrants: previousPrBody.permittedGrants
		});
		const { client, recorded } = setupClient({
			gracePolicies: [{ cachePrefix: '', graceSeconds: 86_400 }],
			views: [
				{
					name: 'pull-requests',
					priority: 50,
					selectors: [{ kind: 'prefix', pattern: 'pr-' }]
				}
			],
			rules: [
				conflict,
				storedRule('previous-pr', previousPrBody),
				storedRule('previous-branch', previousBranchBody)
			]
		});

		await runGithubSetup(
			url,
			{ ...options, yes: true },
			reporter(results, { confirm: 'yes' }),
			client,
			dependencies
		);

		expect({
			recorded,
			outcomes: results[0]
		}).toStrictEqual({
			recorded: {
				graceAdds: [],
				viewSets: [],
				ruleAdds: [prBody, branchBody],
				ruleRemoves: ['conflict']
			},
			outcomes: [
				{ label: 'grace policy', value: 'unchanged' },
				{ label: 'reuse view', value: 'unchanged' },
				{
					label: 'conflicting trust rule conflict',
					value: `removed: pull requests and main pushes; ${pinnedWorkflowReference}`
				},
				{ label: 'pull-request trust rule', value: ruleCreated },
				{ label: 'main trust rule', value: ruleCreated },
				{
					label: 'superseded trust rule previous-branch',
					value: `retained: main pushes; ${previousWorkflowReference}`
				},
				{
					label: 'superseded trust rule previous-pr',
					value: `retained: pull requests and main pushes; ${previousWorkflowReference}`
				}
			]
		});
	});

	it('warns that a retained rule follows a movable workflow reference', async () => {
		const results: ResultRow[][] = [];
		const verifiedReferences: string[] = [];
		const legacy = storedRule('legacy', {
			...prBody,
			claims: {
				repository_id: String(identity.repositoryId),
				repository_owner_id: String(identity.repositoryOwnerId),
				job_workflow_ref: movableWorkflowReference
			},
			permittedGrants: prBody.permittedGrants
		});
		const { ui, captured } = fakeCliUi({
			interactive: true,
			multiSelects: [[]]
		});
		const { client, recorded } = setupClient({
			gracePolicies: [{ cachePrefix: '', graceSeconds: 86_400 }],
			views: [
				{
					name: 'pull-requests',
					priority: 50,
					selectors: [{ kind: 'prefix', pattern: 'pr-' }]
				}
			],
			rules: [legacy]
		});

		await runGithubSetup(
			url,
			options,
			{ ...ui, reporter: () => capturingReporter(results) },
			client,
			{
				...dependencies,
				verifyWorkflowReference({ reference }) {
					verifiedReferences.push(reference);

					return Promise.resolve();
				}
			}
		);

		expect({
			recorded,
			prompts: captured.multiSelects,
			outcomes: results[0],
			verifiedReferences
		}).toStrictEqual({
			recorded: {
				graceAdds: [],
				viewSets: [],
				ruleAdds: [prBody, branchBody],
				ruleRemoves: []
			},
			prompts: [
				{
					message: 'Remove superseded trust rules?',
					entries: [
						{
							value: 'legacy',
							label: 'pull requests and main pushes (legacy)',
							hint: `${movableWorkflowReference} (trusts future edits to the workflow)`
						}
					],
					initialValues: []
				}
			],
			outcomes: [
				{ label: 'grace policy', value: 'unchanged' },
				{ label: 'reuse view', value: 'unchanged' },
				{ label: 'pull-request trust rule', value: ruleCreated },
				{ label: 'main trust rule', value: ruleCreated },
				{
					label: 'superseded trust rule legacy',
					value: `retained: pull requests and main pushes; ${movableWorkflowReference}; trusts future edits to the workflow`
				}
			],
			verifiedReferences: [pinnedWorkflowReference]
		});
	});

	it('reports a rule matching other workflow references instead of skipping it', async () => {
		const results: ResultRow[][] = [];
		const verifiedReferences: string[] = [];
		const legacy: OidcTrustSummary = {
			id: 'legacy',
			issuer: prBody.issuer,
			audience: prBody.audience,
			claims: {
				repository_id: String(identity.repositoryId),
				repository_owner_id: String(identity.repositoryOwnerId),
				job_workflow_ref: { pattern: '^other/.*$' }
			},
			permittedGrants: prBody.permittedGrants,
			disabled: false
		};
		const { client, recorded } = setupClient({
			gracePolicies: [{ cachePrefix: '', graceSeconds: 86_400 }],
			views: [
				{
					name: 'pull-requests',
					priority: 50,
					selectors: [{ kind: 'prefix', pattern: 'pr-' }]
				}
			],
			rules: [legacy]
		});

		await runGithubSetup(url, options, reporter(results), client, {
			...dependencies,
			verifyWorkflowReference({ reference }) {
				verifiedReferences.push(reference);

				return Promise.resolve();
			}
		});

		expect({
			recorded,
			outcomes: results[0],
			verifiedReferences
		}).toStrictEqual({
			recorded: {
				graceAdds: [],
				viewSets: [],
				ruleAdds: [prBody, branchBody],
				ruleRemoves: []
			},
			outcomes: [
				{ label: 'grace policy', value: 'unchanged' },
				{ label: 'reuse view', value: 'unchanged' },
				{ label: 'pull-request trust rule', value: ruleCreated },
				{ label: 'main trust rule', value: ruleCreated },
				{
					label: 'superseded trust rule legacy',
					value:
						'retained: pull requests and main pushes; workflow references matching ^other/.*$'
				}
			],
			verifiedReferences: [pinnedWorkflowReference]
		});
	});

	it('reports the applied configuration when a superseded removal fails', async () => {
		const results: ResultRow[][] = [];
		const removalFailure = new Error('remove failed');
		const { ui } = fakeCliUi({
			interactive: true,
			multiSelects: [['previous-branch', 'previous-pr']]
		});
		const { client, recorded } = setupClient({
			gracePolicies: [{ cachePrefix: '', graceSeconds: 86_400 }],
			views: [
				{
					name: 'pull-requests',
					priority: 50,
					selectors: [{ kind: 'prefix', pattern: 'pr-' }]
				}
			],
			rules: [
				storedRule('previous-pr', previousPrBody),
				storedRule('previous-branch', previousBranchBody)
			]
		});
		const failingClient: GithubSetupClient = {
			...client,
			oidcTrust: {
				...client.oidcTrust,
				remove: (input) =>
					input.id === 'previous-pr'
						? Promise.reject(removalFailure)
						: client.oidcTrust.remove(input)
			}
		};

		let failure: unknown;
		try {
			await runGithubSetup(
				url,
				options,
				{ ...ui, reporter: () => capturingReporter(results) },
				failingClient,
				dependencies
			);
		} catch (error) {
			failure = error;
		}

		expectRemovalError(failure);
		expect({
			ruleIds: failure.ruleIds,
			recorded,
			outcomes: results[0]
		}).toStrictEqual({
			ruleIds: ['previous-pr'],
			recorded: {
				graceAdds: [],
				viewSets: [],
				ruleAdds: [prBody, branchBody],
				ruleRemoves: ['previous-branch']
			},
			outcomes: [
				{ label: 'grace policy', value: 'unchanged' },
				{ label: 'reuse view', value: 'unchanged' },
				{ label: 'pull-request trust rule', value: ruleCreated },
				{ label: 'main trust rule', value: ruleCreated },
				{
					label: 'superseded trust rule previous-branch',
					value: `removed: main pushes; ${previousWorkflowReference}`
				},
				{
					label: 'superseded trust rule previous-pr',
					value: `retained: pull requests and main pushes; ${previousWorkflowReference}; the removal failed`
				}
			]
		});
	});

	it('reports configuration setup would create alongside drift', async () => {
		const results: ResultRow[][] = [];
		const { client, recorded } = setupClient({
			views: [
				{
					name: 'pull-requests',
					priority: 40,
					selectors: [{ kind: 'prefix', pattern: 'pr-' }]
				}
			],
			rules: [storedRule('pr', prBody), storedRule('branch', branchBody)]
		});

		let failure: unknown;
		try {
			await runGithubSetup(
				url,
				options,
				reporter(results),
				client,
				dependencies
			);
		} catch (error) {
			failure = error;
		}

		expectDriftError(failure);
		expect({
			recorded,
			steps: failure.steps,
			outcomes: results[0]
		}).toStrictEqual({
			recorded: {
				graceAdds: [],
				viewSets: [],
				ruleAdds: [],
				ruleRemoves: []
			},
			steps: ['reuse view'],
			outcomes: [
				{
					label: 'grace policy',
					value: 'missing: setup would create it after the drift is resolved'
				},
				{
					label: 'reuse view',
					value:
						"drift: stored priority 40 does not exceed the destination's 40"
				}
			]
		});
	});

	it('still reports policy and view drift without changing them', async () => {
		const results: ResultRow[][] = [];
		const { ui, captured } = fakeCliUi({
			interactive: true,
			multiSelects: [['conflict'], ['previous-pr']]
		});
		const conflict = storedRule('conflict', {
			...prBody,
			permittedGrants: branchBody.permittedGrants
		});
		const { client, recorded } = setupClient({
			gracePolicies: [{ cachePrefix: '', graceSeconds: 3600 }],
			views: [
				{
					name: 'pull-requests',
					priority: 40,
					selectors: [{ kind: 'prefix', pattern: 'pr-' }]
				}
			],
			rules: [
				storedRule('pr', prBody),
				storedRule('branch', branchBody),
				conflict,
				storedRule('previous-pr', previousPrBody)
			]
		});

		let failure: unknown;
		try {
			await runGithubSetup(
				url,
				options,
				{ ...ui, reporter: () => capturingReporter(results) },
				client,
				dependencies
			);
		} catch (error) {
			failure = error;
		}

		expectDriftError(failure);
		expect({
			recorded,
			prompts: captured.multiSelects,
			steps: failure.steps,
			outcomes: results[0]
		}).toStrictEqual({
			recorded: {
				graceAdds: [],
				viewSets: [],
				ruleAdds: [],
				ruleRemoves: []
			},
			prompts: [],
			steps: ['grace policy', 'reuse view'],
			outcomes: [
				{
					label: 'grace policy',
					value:
						'drift: stored tenant-wide grace is 3600s, setup would write 86400s'
				},
				{
					label: 'reuse view',
					value:
						"drift: stored priority 40 does not exceed the destination's 40"
				},
				{
					label: 'superseded trust rule previous-pr',
					value: `retained: pull requests and main pushes; ${previousWorkflowReference}`
				}
			]
		});
	});

	it('replaces an exact rule admitted by a new tag pattern', async () => {
		const patternReference =
			'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v*';
		const patternPrBody = githubPrAddBody(url, identity, {
			repo: options.repo,
			jobWorkflowRef: patternReference
		});
		const patternBranchBody = githubBranchAddBody(url, identity, {
			repo: options.repo,
			branch: options.branch,
			jobWorkflowRef: patternReference
		});
		const exactRule = storedRule('exact', {
			...prBody,
			permittedGrants: [{ type: 'cupboard_wildcard' }]
		});
		const patternDetail = String.raw`workflow references matching ^underwhelmingperformance/cupboard/\.github/workflows/cupboard-flake-publish\.yml@refs/tags/v[^/]*$`;
		const results: ResultRow[][] = [];
		const { client, recorded } = setupClient({
			gracePolicies: [{ cachePrefix: '', graceSeconds: 86_400 }],
			views: [
				{
					name: 'pull-requests',
					priority: 50,
					selectors: [{ kind: 'prefix', pattern: 'pr-' }]
				}
			],
			rules: [exactRule]
		});

		await runGithubSetup(
			url,
			{ ...options, workflowRef: patternReference, yes: true },
			reporter(results, { confirm: 'yes' }),
			client,
			{
				...dependencies,
				verifyWorkflowReference: () =>
					Promise.reject(new Error('pattern verification should not run'))
			}
		);

		expect({ recorded, outcomes: results[0] }).toStrictEqual({
			recorded: {
				graceAdds: [],
				viewSets: [],
				ruleAdds: [patternPrBody, patternBranchBody],
				ruleRemoves: ['exact']
			},
			outcomes: [
				{ label: 'grace policy', value: 'unchanged' },
				{ label: 'reuse view', value: 'unchanged' },
				{
					label: 'conflicting trust rule exact',
					value: `removed: pull requests and main pushes; ${pinnedWorkflowReference}`
				},
				{
					label: 'pull-request trust rule',
					value: `created: ${patternDetail}`
				},
				{ label: 'main trust rule', value: `created: ${patternDetail}` }
			]
		});
	});

	it.each([
		['a broader tag pattern', 'v2*', 'v*', ['previous-pattern']],
		['a narrower tag pattern', 'v*', 'v2*', ['previous-pattern']],
		['a disjoint tag pattern', 'v1*', 'v2*', []]
	])(
		'handles %s deterministically',
		async (_name, previousGlob, desiredGlob, expectedRemovals) => {
			const workflow =
				'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml';
			const previousReference = `${workflow}@refs/tags/${previousGlob}`;
			const desiredReference = `${workflow}@refs/tags/${desiredGlob}`;
			const desiredPrBody = githubPrAddBody(url, identity, {
				repo: options.repo,
				jobWorkflowRef: desiredReference
			});
			const desiredBranchBody = githubBranchAddBody(url, identity, {
				repo: options.repo,
				branch: options.branch,
				jobWorkflowRef: desiredReference
			});
			const previousRule = storedRule('previous-pattern', {
				...githubPrAddBody(url, identity, {
					repo: options.repo,
					jobWorkflowRef: previousReference
				}),
				permittedGrants: [{ type: 'cupboard_wildcard' }]
			});
			const { client, recorded } = setupClient({
				gracePolicies: [{ cachePrefix: '', graceSeconds: 86_400 }],
				views: [
					{
						name: 'pull-requests',
						priority: 50,
						selectors: [{ kind: 'prefix', pattern: 'pr-' }]
					}
				],
				rules: [previousRule]
			});

			await runGithubSetup(
				url,
				{ ...options, workflowRef: desiredReference, yes: true },
				reporter([], { confirm: 'yes' }),
				client,
				{
					...dependencies,
					verifyWorkflowReference: () =>
						Promise.reject(new Error('pattern verification should not run'))
				}
			);

			expect(recorded).toStrictEqual({
				graceAdds: [],
				viewSets: [],
				ruleAdds: [desiredPrBody, desiredBranchBody],
				ruleRemoves: expectedRemovals
			});
		}
	);

	it('stores tag-pattern rules without probing GitHub', async () => {
		const patternReference =
			'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v*';
		const patternPrBody = githubPrAddBody(url, identity, {
			repo: options.repo,
			jobWorkflowRef: patternReference
		});
		const patternBranchBody = githubBranchAddBody(url, identity, {
			repo: options.repo,
			branch: options.branch,
			jobWorkflowRef: patternReference
		});
		const patternDetail = String.raw`workflow references matching ^underwhelmingperformance/cupboard/\.github/workflows/cupboard-flake-publish\.yml@refs/tags/v[^/]*$`;
		const results: ResultRow[][] = [];
		const { client, recorded } = setupClient({
			gracePolicies: [{ cachePrefix: '', graceSeconds: 86_400 }],
			views: [
				{
					name: 'pull-requests',
					priority: 50,
					selectors: [{ kind: 'prefix', pattern: 'pr-' }]
				}
			]
		});

		await runGithubSetup(
			url,
			{ ...options, workflowRef: patternReference },
			reporter(results),
			client,
			{
				...dependencies,
				verifyWorkflowReference: () =>
					Promise.reject(new Error('pattern verification should not run'))
			}
		);

		expect({ recorded, outcomes: results[0] }).toStrictEqual({
			recorded: {
				graceAdds: [],
				viewSets: [],
				ruleAdds: [patternPrBody, patternBranchBody],
				ruleRemoves: []
			},
			outcomes: [
				{ label: 'grace policy', value: 'unchanged' },
				{ label: 'reuse view', value: 'unchanged' },
				{
					label: 'pull-request trust rule',
					value: `created: ${patternDetail}`
				},
				{ label: 'main trust rule', value: `created: ${patternDetail}` }
			]
		});
	});

	it('performs no writes when stored tag-pattern rules match the desired ones', async () => {
		const patternReference =
			'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v*';
		const patternPrBody = githubPrAddBody(url, identity, {
			repo: options.repo,
			jobWorkflowRef: patternReference
		});
		const patternBranchBody = githubBranchAddBody(url, identity, {
			repo: options.repo,
			branch: options.branch,
			jobWorkflowRef: patternReference
		});
		const results: ResultRow[][] = [];
		const { client, recorded } = setupClient({
			gracePolicies: [{ cachePrefix: '', graceSeconds: 86_400 }],
			views: [
				{
					name: 'pull-requests',
					priority: 50,
					selectors: [{ kind: 'prefix', pattern: 'pr-' }]
				}
			],
			rules: [
				storedRule('pattern-pr', patternPrBody),
				storedRule('pattern-branch', patternBranchBody)
			]
		});

		await runGithubSetup(
			url,
			{ ...options, workflowRef: patternReference },
			reporter(results),
			client,
			{
				...dependencies,
				verifyWorkflowReference: () =>
					Promise.reject(new Error('pattern verification should not run'))
			}
		);

		expect({ recorded, outcomes: results[0] }).toStrictEqual({
			recorded: {
				graceAdds: [],
				viewSets: [],
				ruleAdds: [],
				ruleRemoves: []
			},
			outcomes: [
				{ label: 'grace policy', value: 'unchanged' },
				{ label: 'reuse view', value: 'unchanged' },
				{ label: 'pull-request trust rule', value: 'unchanged' },
				{ label: 'main trust rule', value: 'unchanged' }
			]
		});
	});
});

describe('registerGithubCommands', () => {
	it('offers generic conflict confirmation without a retirement flag', () => {
		const program = new Command();
		registerGithubCommands(program);
		const github = program.commands.find(
			(command) => command.name() === 'github'
		);
		const setup = github?.commands.find(
			(command) => command.name() === 'setup'
		);

		expect(setup?.options.map((option) => option.flags)).toStrictEqual([
			'--repo <owner/name>',
			'--branch <name>',
			'--grace <duration>',
			'--workflow-ref <owner/repo/path@ref>',
			'-y, --yes',
			'--read-user <user>',
			'--read-password <password>'
		]);
	});

	it.each([['setup'], ['check']])(
		'refuses %s without --workflow-ref',
		async (subcommand) => {
			const stderr: string[] = [];
			const program = new Command();
			program.exitOverride();
			program.configureOutput({
				writeErr: (message) => {
					stderr.push(message);
				}
			});
			registerGithubCommands(program);

			await expect(
				program.parseAsync(
					['github', subcommand, url.href, '--repo', 'acme/app'],
					{
						from: 'user'
					}
				)
			).rejects.toMatchObject({
				code: 'commander.missingMandatoryOptionValue'
			});
			expect(stderr).toHaveLength(1);
		}
	);
});

describe('cacheInfoFetcher', () => {
	const info = new CacheInfo(
		servedStoreDirectory,
		true,
		cachePrioritySchema.parse(40)
	).render();

	it('sends the Basic credential and parses the answer', async () => {
		const requests: { url: string; authorization: string | undefined }[] = [];
		const fetch = cacheInfoFetcher(
			{ readUser: alice, readPassword: 's3cret' },
			{
				fetch: (input, init) => {
					requests.push({
						url:
							typeof input === 'string'
								? input
								: input instanceof URL
									? input.href
									: input.url,
						authorization:
							new Headers(init?.headers).get('authorization') ?? undefined
					});

					return Promise.resolve(new Response(info));
				}
			}
		);

		const fetched = await fetch(new URL('https://cupboard.example/t/acme/'));

		expect({ priority: fetched.priority, requests }).toStrictEqual({
			priority: 40,
			requests: [
				{
					url: 'https://cupboard.example/t/acme/nix-cache-info',
					authorization: `Basic ${Buffer.from('alice:s3cret').toString('base64')}`
				}
			]
		});
	});

	it('sends no credential when none is supplied', async () => {
		const authorizations: (string | undefined)[] = [];
		const fetch = cacheInfoFetcher(
			{},
			{
				fetch: (_input, init) => {
					authorizations.push(
						new Headers(init?.headers).get('authorization') ?? undefined
					);

					return Promise.resolve(new Response(info));
				}
			}
		);

		await fetch(new URL('https://cupboard.example/t/acme'));

		expect(authorizations).toStrictEqual([undefined]);
	});

	it('surfaces a refused read with the response status', async () => {
		const fetch = cacheInfoFetcher(
			{},
			{
				fetch: () =>
					Promise.resolve(
						new Response(undefined, { status: StatusCodes.UNAUTHORIZED })
					)
			}
		);

		let failure: unknown;
		try {
			await fetch(new URL('https://cupboard.example/t/acme'));
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(CacheInfoUnavailableError);
	});

	it.each([
		{
			status: StatusCodes.TOO_MANY_REQUESTS,
			error: CacheInfoRateLimitedError
		},
		{ status: StatusCodes.BAD_GATEWAY, error: CacheInfoServerError }
	])(
		'classifies an HTTP $status cache-info response',
		async ({ status, error }) => {
			const fetch = cacheInfoFetcher(
				{},
				{
					fetch: () =>
						Promise.resolve(
							new Response(undefined, {
								status,
								headers: { 'retry-after': '0.001' }
							})
						)
				}
			);

			await expect(
				fetch(new URL('https://cupboard.example/t/acme'))
			).rejects.toBeInstanceOf(error);
		}
	);

	it('rejects half a credential pair before any request', () => {
		expect(() => cacheInfoFetcher({ readUser: alice })).toThrow(
			ReadCredentialPairError
		);
	});

	it('retries a transient response before parsing the answer', async () => {
		let attempts = 0;
		const fetch = cacheInfoFetcher(
			{},
			{
				fetch: () => {
					attempts += 1;

					return Promise.resolve(
						attempts === 1
							? new Response(undefined, {
									status: StatusCodes.SERVICE_UNAVAILABLE,
									headers: { 'retry-after': '0.001' }
								})
							: new Response(info)
					);
				}
			}
		);

		const fetched = await fetch(new URL('https://cupboard.example/t/acme'));

		expect({ attempts, priority: fetched.priority }).toStrictEqual({
			attempts: 2,
			priority: 40
		});
	});

	it('bounds a cache-info probe with a deadline', async () => {
		const fetch = cacheInfoFetcher(
			{},
			{
				fetch: (_input, init) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener(
							'abort',
							() => {
								reject(new Error('request aborted'));
							},
							{ once: true }
						);
					}),
				timeoutMs: 1
			}
		);

		await expect(
			fetch(new URL('https://cupboard.example/t/acme'))
		).rejects.toBeInstanceOf(CacheInfoTimeoutError);
	});

	it('translates a stalled cache-info body into a timeout', async () => {
		const signals: AbortSignal[] = [];
		const fetch = cacheInfoFetcher(
			{},
			{
				fetch: (_input, init) => {
					const signal = init?.signal;

					if (signal === undefined || signal === null) {
						throw new Error('expected an abort signal');
					}

					signals.push(signal);
					const body = new ReadableStream({
						start(controller) {
							signal.addEventListener(
								'abort',
								() => {
									controller.error(new Error('response body aborted'));
								},
								{ once: true }
							);
						}
					});

					return Promise.resolve(new Response(body));
				},
				timeoutMs: 1
			}
		);

		await expect(
			fetch(new URL('https://cupboard.example/t/acme'))
		).rejects.toBeInstanceOf(CacheInfoTimeoutError);
		expect(signals.map(({ aborted }) => aborted)).toStrictEqual([true]);
	});

	it('propagates the command abort reason to the request', async () => {
		const controller = new AbortController();
		const reason = new CliAbortError();
		const fetch = cacheInfoFetcher(
			{ signal: controller.signal },
			{
				fetch: (_input, init) => {
					controller.abort(reason);
					expect(init?.signal?.reason).toBe(reason);

					return Promise.reject(reason);
				}
			}
		);

		await expect(
			fetch(new URL('https://cupboard.example/t/acme'))
		).rejects.toBe(reason);
	});
});
