import { CacheInfo } from '@cupboard/nix-store/cache-info';
import {
	type OidcTrustAddBody,
	type OidcTrustListResponse,
	type OidcTrustSummary
} from '@cupboard/protocol/oidc';
import { type Reporter, type ResultRow } from '@cupboard/reporter';
import { basicAuthHeader } from '@cupboard/shared/http';
import type { Command } from 'commander';
import { StatusCodes } from 'http-status-codes';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { tenantRpc } from '../client/orpc.ts';
import { parseGrace } from '../duration.ts';
import {
	CacheInfoRateLimitedError,
	CacheInfoServerError,
	CacheInfoUnavailableError,
	CacheInfoUnparsableError,
	GithubSetupDriftError,
	GraceTooShortError,
	ReadCredentialPairError
} from '../errors.ts';
import { tenantUrlArgument } from '../url-argument.ts';

import { type GithubCheckOptions, runGithubCheck } from './github/check.ts';
import {
	minimumGraceSeconds,
	pullRequestPrefix,
	pullRequestViewName
} from './github/convention.ts';
import { githubBranchAddBody, githubPrAddBody } from './oidc-trust.ts';
import { lookupRepository } from './oidc-trust/github.ts';
import { type PolicyClient } from './policy.ts';
import { type ReuseViewClient } from './reuse-view.ts';

const tooManyRequestsStatus: number = StatusCodes.TOO_MANY_REQUESTS;
const serverErrorStatus: number = StatusCodes.INTERNAL_SERVER_ERROR;

// The margin the view's priority sits above the destination's advertised
// priority. Any strictly greater value keeps the destination preferred; the
// margin only leaves room for a cache between them later.
const viewPriorityMargin = 10;

export interface GithubSetupOptions {
	readonly repo: string;
	readonly branch: string;
	readonly grace: string;
	readonly workflowRef: string;
	readonly readUser?: string;
	readonly readPassword?: string;
}

/**
 * The slice of the derived client github setup consumes, in the contract's
 * input and output shapes; the real `tenantRpc(...)` sub-clients satisfy it
 * by construction.
 */
export interface GithubSetupClient {
	readonly policies: Pick<PolicyClient, 'graceList' | 'graceAdd'>;
	readonly reuseViews: Pick<ReuseViewClient, 'list' | 'set'>;
	readonly oidcTrust: {
		list(): Promise<OidcTrustListResponse>;
		add(input: OidcTrustAddBody): Promise<OidcTrustSummary>;
	};
}

export interface GithubSetupDependencies {
	readonly lookupRepository?: typeof lookupRepository;
	readonly fetchCacheInfo?: (url: string) => Promise<CacheInfo>;
}

// One converging step's outcome. `drift` means the stored state neither
// matches what setup would write nor was written: it is reported and left in
// place for the operator to resolve.
export interface SetupStep {
	readonly step: string;
	readonly outcome: 'created' | 'unchanged' | 'drift';
	readonly detail?: string;
}

export interface ReadCredentialOptions {
	readonly readUser?: string;
	readonly readPassword?: string;
}

/**
 * A `nix-cache-info` fetcher for the given read credential: a private
 * tenant's read routes answer 401 without one, so setup and check thread the
 * same Basic credential a reader would use. Supplying only half the pair is
 * refused before any request.
 */
export function cacheInfoFetcher(
	options: ReadCredentialOptions,
	fetcher: typeof fetch = fetch
): (url: string) => Promise<CacheInfo> {
	if (
		(options.readUser === undefined) !==
		(options.readPassword === undefined)
	) {
		throw new ReadCredentialPairError();
	}

	const headers =
		options.readUser === undefined || options.readPassword === undefined
			? undefined
			: basicAuthHeader(options.readUser, options.readPassword);

	return async (url: string) => {
		const target = `${url.replace(/\/$/, '')}/nix-cache-info`;
		const response = await fetcher(
			target,
			headers === undefined ? {} : { headers }
		);

		if (!response.ok) {
			await response.text();

			if (response.status === tooManyRequestsStatus) {
				throw new CacheInfoRateLimitedError(target);
			}

			if (response.status >= serverErrorStatus) {
				throw new CacheInfoServerError(target, response.status);
			}

			throw new CacheInfoUnavailableError(target, response.status);
		}

		const body = await response.text();

		try {
			return CacheInfo.parse(body);
		} catch (error) {
			throw new CacheInfoUnparsableError(target, { cause: error });
		}
	};
}

function isDeepEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) {
		return true;
	}

	if (Array.isArray(left) || Array.isArray(right)) {
		return (
			Array.isArray(left) &&
			Array.isArray(right) &&
			left.length === right.length &&
			left.every((value, index) => isDeepEqual(value, right[index]))
		);
	}

	if (
		typeof left !== 'object' ||
		typeof right !== 'object' ||
		left === null ||
		right === null
	) {
		return false;
	}

	const leftEntries = Object.entries(left);
	const rightEntries = new Map<string, unknown>(Object.entries(right));

	return (
		leftEntries.length === rightEntries.size &&
		leftEntries.every(
			([key, value]) =>
				rightEntries.has(key) && isDeepEqual(value, rightEntries.get(key))
		)
	);
}

// A stored rule and a desired body agree when everything that affects
// matching and issuance is identical; the summary's own id and disabled flag
// are not part of the comparison.
function isRuleMatchingBody(
	rule: OidcTrustSummary,
	body: OidcTrustAddBody
): boolean {
	return (
		rule.issuer === body.issuer &&
		rule.audience === body.audience &&
		isDeepEqual(rule.claims, body.claims) &&
		isDeepEqual(rule.permittedGrants, body.permittedGrants)
	);
}

// The enabled rule holding the same repository and event pin as `body`, so a
// differing rule for the same trigger reads as drift, not as missing.
function ruleForSameTrigger(
	rules: readonly OidcTrustSummary[],
	body: OidcTrustAddBody,
	trigger: readonly string[]
): OidcTrustSummary | undefined {
	return rules.find(
		(rule) =>
			!rule.disabled &&
			rule.issuer === body.issuer &&
			trigger.every((claim) =>
				isDeepEqual(rule.claims[claim], body.claims[claim])
			)
	);
}

async function convergeGracePolicy(
	client: GithubSetupClient,
	graceSeconds: number
): Promise<SetupStep> {
	const { policies } = await client.policies.graceList();
	const existing = policies.find((policy) => policy.cachePrefix === '');

	if (existing === undefined) {
		await client.policies.graceAdd({ cachePrefix: '', graceSeconds });

		return { step: 'grace policy', outcome: 'created' };
	}

	if (existing.graceSeconds === graceSeconds) {
		return { step: 'grace policy', outcome: 'unchanged' };
	}

	return {
		step: 'grace policy',
		outcome: 'drift',
		detail: `stored tenant-wide grace is ${String(existing.graceSeconds)}s, setup would write ${String(graceSeconds)}s`
	};
}

async function convergeReuseView(
	client: GithubSetupClient,
	destinationPriority: number
): Promise<SetupStep> {
	const selectors = [{ kind: 'prefix' as const, pattern: pullRequestPrefix }];
	const { views } = await client.reuseViews.list();
	const existing = views.find((view) => view.name === pullRequestViewName);

	if (existing === undefined) {
		await client.reuseViews.set({
			name: pullRequestViewName,
			selectors,
			priority: destinationPriority + viewPriorityMargin
		});

		return { step: 'reuse view', outcome: 'created' };
	}

	if (
		isDeepEqual([...existing.selectors], selectors) &&
		existing.priority > destinationPriority
	) {
		return { step: 'reuse view', outcome: 'unchanged' };
	}

	return {
		step: 'reuse view',
		outcome: 'drift',
		detail:
			existing.priority <= destinationPriority
				? `stored priority ${String(existing.priority)} does not exceed the destination's ${String(destinationPriority)}`
				: 'stored selectors differ from the pr- prefix setup would write'
	};
}

async function convergeTrustRule(
	client: GithubSetupClient,
	rules: OidcTrustListResponse['rules'],
	step: string,
	body: OidcTrustAddBody,
	trigger: readonly string[]
): Promise<SetupStep> {
	const matching = rules.find(
		(rule) => !rule.disabled && isRuleMatchingBody(rule, body)
	);

	if (matching !== undefined) {
		return { step, outcome: 'unchanged' };
	}

	const sameTrigger = ruleForSameTrigger(rules, body, trigger);

	if (sameTrigger !== undefined) {
		return {
			step,
			outcome: 'drift',
			detail: `rule ${sameTrigger.id} covers the same trigger but differs on ${ruleDifferences(sameTrigger, body).join(', ')}; remove it and re-run setup`
		};
	}

	await client.oidcTrust.add(body);

	return { step, outcome: 'created' };
}

// The fields of a same-trigger rule that diverge from what setup would write,
// so a drift report names what to look at rather than only that something
// differs.
function ruleDifferences(
	rule: OidcTrustSummary,
	body: OidcTrustAddBody
): string[] {
	const differences: string[] = [];

	if (rule.issuer !== body.issuer) {
		differences.push('issuer');
	}

	if (rule.audience !== body.audience) {
		differences.push('audience');
	}

	if (!isDeepEqual(rule.claims, body.claims)) {
		differences.push('claims');
	}

	if (!isDeepEqual(rule.permittedGrants, body.permittedGrants)) {
		differences.push('grants');
	}

	return differences;
}

export async function runGithubSetup(
	url: string,
	options: GithubSetupOptions,
	reporter: Reporter,
	client: GithubSetupClient,
	dependencies: GithubSetupDependencies = {}
): Promise<void> {
	const resolveRepository = dependencies.lookupRepository ?? lookupRepository;
	const fetchCacheInfo =
		dependencies.fetchCacheInfo ?? cacheInfoFetcher(options);
	const graceSeconds = parseGrace(options.grace);

	if (graceSeconds < minimumGraceSeconds) {
		throw new GraceTooShortError(graceSeconds, minimumGraceSeconds);
	}

	const identity = await reporter.phase('Resolving repository', () =>
		resolveRepository(options.repo)
	);
	const destination = await reporter.phase('Reading destination priority', () =>
		fetchCacheInfo(url)
	);

	const prBody = githubPrAddBody(url, identity, {
		repo: options.repo,
		jobWorkflowRef: options.workflowRef
	});
	const branchBody = githubBranchAddBody(url, identity, {
		repo: options.repo,
		branch: options.branch,
		jobWorkflowRef: options.workflowRef
	});

	const steps = await reporter.phase(
		'Converging tenant configuration',
		async () => {
			// One list serves both converges: the two bodies never match each
			// other, so neither converge needs to observe the other's write.
			const { rules } = await client.oidcTrust.list();

			return [
				await convergeGracePolicy(client, graceSeconds),
				await convergeReuseView(client, destination.priority),
				await convergeTrustRule(
					client,
					rules,
					'pull-request trust rule',
					prBody,
					['repository_id', 'event_name']
				),
				await convergeTrustRule(
					client,
					rules,
					`${options.branch} trust rule`,
					branchBody,
					['repository_id', 'ref']
				)
			];
		}
	);

	const stepRows: ResultRow[] = steps.map((step) => ({
		label: step.step,
		value:
			step.detail === undefined
				? step.outcome
				: `${step.outcome}: ${step.detail}`
	}));

	reporter.result({
		kind: 'github-setup',
		data: { steps },
		rows: stepRows
	});

	const drifted = steps.filter((step) => step.outcome === 'drift');

	if (drifted.length > 0) {
		throw new GithubSetupDriftError(drifted.map((step) => step.step));
	}
}

export function registerGithubCommands(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	const github = program
		.command('github')
		.description(
			'Set up and verify GitHub repositories that publish to this tenant.'
		);

	github
		.command('setup')
		.description(
			'Write the tenant-side configuration for cache-aware flake publishing: the grace policy, the pull-request reuse view and both trust rules, idempotently.'
		)
		.argument('<url>', tenantUrlArgument)
		.requiredOption('--repo <owner/name>', 'GitHub repository to trust.')
		.option('--branch <name>', 'Branch whose pushes publish.', 'main')
		.option('--grace <duration>', 'Tenant-wide retention grace period.', '24h')
		.requiredOption(
			'--workflow-ref <owner/repo/path@ref>',
			'The job_workflow_ref claim the trust rules pin, in the exact claim spelling and at the release tag the caller workflow uses.'
		)
		.option(
			'--read-user <user>',
			'Basic read credential for tenants whose reads are private.'
		)
		.option(
			'--read-password <password>',
			'Basic read credential for tenants whose reads are private.'
		)
		.action(async (url: string, options: GithubSetupOptions) => {
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runGithubSetup(url, options, reporter, {
				policies: rpc.policies,
				reuseViews: rpc.reuseViews,
				oidcTrust: rpc.oidcTrust
			});
		});

	github
		.command('check')
		.description(
			'Verify the invariants a publishing run depends on before its first CI run: trust-rule matching and grant coverage, grace coverage, reuse-view definition and priority, and root-prefix nesting.'
		)
		.argument('<url>', tenantUrlArgument)
		.requiredOption('--repo <owner/name>', 'GitHub repository to verify.')
		.option('--branch <name>', 'Branch whose pushes publish.', 'main')
		.requiredOption(
			'--workflow-ref <owner/repo/path@ref>',
			'The job_workflow_ref claim a run presents, at the release tag the caller workflow uses.'
		)
		.option(
			'--root-prefix <value>',
			"The caller workflow's root-prefix input, for the nesting check."
		)
		.option(
			'--read-user <user>',
			'Basic read credential for tenants whose reads are private.'
		)
		.option(
			'--read-password <password>',
			'Basic read credential for tenants whose reads are private.'
		)
		.action(async (url: string, options: GithubCheckOptions) => {
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runGithubCheck(
				url,
				options,
				reporter,
				{
					policies: rpc.policies,
					reuseViews: rpc.reuseViews,
					oidcTrust: rpc.oidcTrust
				},
				{ fetchCacheInfo: cacheInfoFetcher(options) }
			);
		});
}
