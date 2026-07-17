import { capturingReporter as reporter } from '@cupboard/cli-ui/testing';
import { CacheInfo } from '@cupboard/nix-store/cache-info';
import type {
	OidcTrustAddBody,
	OidcTrustSummary
} from '@cupboard/protocol/oidc';
import type { GracePolicyAddBody } from '@cupboard/protocol/retention';
import type { ReuseViewSelector } from '@cupboard/protocol/reuse-views';
import type { ResultRow } from '@cupboard/reporter';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { GithubSetupDriftError } from '../errors.ts';

import {
	type GithubSetupClient,
	type GithubSetupOptions,
	registerGithubCommands,
	runGithubSetup
} from './github.ts';
import { githubBranchAddBody, githubPrAddBody } from './oidc-trust.ts';
import { type RepositoryIdentity } from './oidc-trust/github.ts';

const url = 'https://cupboard.example.workers.dev/t/acme';
const identity: RepositoryIdentity = {
	repositoryId: 1234,
	repositoryOwnerId: 5678,
	fullName: 'acme/app'
};

const pinnedWorkflowReference =
	'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v1.2.3';

const options: GithubSetupOptions = {
	repo: 'acme/app',
	branch: 'main',
	grace: '24h',
	cupboardVersion: 'v1.2.3',
	runners: 'ubuntu-latest',
	planRunner: '"ubuntu-latest"',
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

function storedRule(id: string, body: OidcTrustAddBody): OidcTrustSummary {
	return { id, ...body, disabled: false };
}

interface Recorded {
	readonly graceAdds: GracePolicyAddBody[];
	readonly viewSets: {
		name: string;
		selectors: readonly ReuseViewSelector[];
		priority?: number;
	}[];
	readonly ruleAdds: OidcTrustAddBody[];
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
	const recorded: Recorded = { graceAdds: [], viewSets: [], ruleAdds: [] };
	const client: GithubSetupClient = {
		policies: {
			graceList: () =>
				Promise.resolve({
					policies: (stored.gracePolicies ?? []).map((policy, index) => ({
						id: `grace-${String(index)}`,
						createdAt: '2026-01-01T00:00:00.000Z',
						...policy
					}))
				}),
			graceAdd(input) {
				recorded.graceAdds.push(input);

				return Promise.resolve({
					id: 'grace-new',
					createdAt: '2026-01-01T00:00:00.000Z',
					cachePrefix: input.cachePrefix,
					graceSeconds: input.graceSeconds
				});
			}
		},
		reuseViews: {
			list: () =>
				Promise.resolve({
					views: (stored.views ?? []).map((view, index) => ({
						revision: index + 1,
						createdAt: '2026-01-01T00:00:00.000Z',
						updatedAt: '2026-01-01T00:00:00.000Z',
						...view,
						selectors: [...view.selectors]
					}))
				}),
			set(input) {
				recorded.viewSets.push(input);

				return Promise.resolve({
					name: input.name,
					revision: 1,
					priority: input.priority ?? 50,
					selectors: [...input.selectors],
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z'
				});
			}
		},
		oidcTrust: {
			list: () => Promise.resolve({ rules: stored.rules ?? [] }),
			add(input) {
				recorded.ruleAdds.push(input);

				return Promise.resolve(storedRule('rule-new', input));
			}
		}
	};

	return { client, recorded };
}

const dependencies = {
	lookupRepository: () => Promise.resolve(identity),
	fetchCacheInfo: () => Promise.resolve(new CacheInfo('/nix/store', true, 40))
};

function expectDriftError(
	error: unknown
): asserts error is GithubSetupDriftError {
	expect(error).toBeInstanceOf(GithubSetupDriftError);
}

describe('runGithubSetup', () => {
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
				ruleAdds: [prBody, branchBody]
			},
			results: [
				[
					{ label: 'grace policy', value: 'created' },
					{ label: 'reuse view', value: 'created' },
					{ label: 'pull-request trust rule', value: 'created' },
					{ label: 'main trust rule', value: 'created' },
					{ label: 'CUPBOARD_URL', value: url },
					{ label: 'CUPBOARD_VERSION', value: 'v1.2.3' },
					{ label: 'CUPBOARD_PLAN_RUNNER', value: '"ubuntu-latest"' },
					{ label: 'CUPBOARD_RUNNERS', value: 'ubuntu-latest' }
				]
			]
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
			recorded: { graceAdds: [], viewSets: [], ruleAdds: [] },
			outcomes: [
				{ label: 'grace policy', value: 'unchanged' },
				{ label: 'reuse view', value: 'unchanged' },
				{ label: 'pull-request trust rule', value: 'unchanged' },
				{ label: 'main trust rule', value: 'unchanged' }
			]
		});
	});

	it('reports drift without replacing the stored state', async () => {
		const results: ResultRow[][] = [];
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
				storedRule('pr', {
					...prBody,
					claims: {
						...prBody.claims,
						job_workflow_ref: 'other@refs/heads/main'
					}
				}),
				storedRule('branch', branchBody)
			]
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
			trustRuleRow: results[0]?.[2]
		}).toStrictEqual({
			recorded: { graceAdds: [], viewSets: [], ruleAdds: [] },
			steps: ['grace policy', 'reuse view', 'pull-request trust rule'],
			// The drift detail names the diverging fields and the remediation.
			trustRuleRow: {
				label: 'pull-request trust rule',
				value:
					'drift: rule pr covers the same trigger but differs on claims; remove it and re-run setup'
			}
		});
	});

	it('applies the repository variables through the injected variables client', async () => {
		const results: ResultRow[][] = [];
		const variableCalls: { repository: string; name: string; value: string }[] =
			[];
		const { client } = setupClient({});

		await runGithubSetup(
			url,
			{ ...options, applyVariables: true },
			reporter(results),
			client,
			{
				...dependencies,
				setVariable(repository, name, value) {
					variableCalls.push({ repository, name, value });

					return Promise.resolve();
				}
			}
		);

		expect(variableCalls).toStrictEqual([
			{ repository: 'acme/app', name: 'CUPBOARD_URL', value: url },
			{ repository: 'acme/app', name: 'CUPBOARD_VERSION', value: 'v1.2.3' },
			{
				repository: 'acme/app',
				name: 'CUPBOARD_PLAN_RUNNER',
				value: '"ubuntu-latest"'
			},
			{
				repository: 'acme/app',
				name: 'CUPBOARD_RUNNERS',
				value: 'ubuntu-latest'
			}
		]);
	});
});

describe('registerGithubCommands', () => {
	it.each([['setup']])(
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
				program.parseAsync(['github', subcommand, url, '--repo', 'acme/app'], {
					from: 'user'
				})
			).rejects.toMatchObject({
				code: 'commander.missingMandatoryOptionValue'
			});
			expect(stderr).toHaveLength(1);
		}
	);
});
