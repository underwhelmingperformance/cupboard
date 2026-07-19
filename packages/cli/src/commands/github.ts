import { CacheInfo } from '@cupboard/nix-store/cache-info';
import {
	type OidcTrustAddBody,
	type OidcTrustListResponse,
	type OidcTrustRemoveResponse,
	type OidcTrustSummary
} from '@cupboard/protocol/oidc';
import { type Reporter, type ResultRow } from '@cupboard/reporter';
import { basicAuthHeader } from '@cupboard/shared/http';
import type { Command } from 'commander';
import { StatusCodes } from 'http-status-codes';

import { abortReason } from '../abort.ts';
import { cachedOwnerProvider } from '../auth/auth.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { tenantRpc } from '../client/orpc.ts';
import { resilientFetcher } from '../client/transport.ts';
import { parseGrace } from '../duration.ts';
import {
	CacheInfoRateLimitedError,
	CacheInfoServerError,
	CacheInfoTimeoutError,
	CacheInfoUnavailableError,
	CacheInfoUnparsableError,
	GithubSetupDriftError,
	GraceTooShortError,
	ReadCredentialPairError,
	WorkflowReferenceRetirementConflictError
} from '../errors.ts';
import { tenantUrlArgument } from '../url-argument.ts';

import { type GithubCheckOptions, runGithubCheck } from './github/check.ts';
import {
	minimumGraceSeconds,
	pullRequestPrefix,
	pullRequestViewName,
	requirePinnedWorkflowReference
} from './github/convention.ts';
import { verifyPinnedWorkflowReference } from './github/workflow-reference.ts';
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
	readonly retireWorkflowRef?: string;
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
		remove(input: { id: string }): Promise<OidcTrustRemoveResponse>;
	};
}

export interface GithubSetupDependencies {
	readonly lookupRepository?: typeof lookupRepository;
	readonly fetchCacheInfo?: (url: string) => Promise<CacheInfo>;
	readonly verifyWorkflowReference?: typeof verifyPinnedWorkflowReference;
	readonly signal?: AbortSignal;
}

// One converging step's outcome. `drift` means the stored state neither
// matches what setup would write nor was written: it is reported and left in
// place for the operator to resolve.
export interface SetupStep {
	readonly step: string;
	readonly outcome: 'created' | 'removed' | 'unchanged' | 'drift';
	readonly detail?: string;
}

export interface ReadCredentialOptions {
	readonly readUser?: string;
	readonly readPassword?: string;
	readonly signal?: AbortSignal;
}

interface CacheInfoFetcherDependencies {
	readonly fetch?: typeof fetch;
	readonly timeoutMs?: number;
}

const cacheInfoTimeoutMs = 30_000;

/**
 * A `nix-cache-info` fetcher for the given read credential: a private
 * tenant's read routes answer 401 without one, so setup and check thread the
 * same Basic credential a reader would use. Supplying only half the pair is
 * refused before any request.
 */
export function cacheInfoFetcher(
	options: ReadCredentialOptions,
	dependencies: CacheInfoFetcherDependencies = {}
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
	const fetcher = resilientFetcher(dependencies.fetch);
	const timeoutMs = dependencies.timeoutMs ?? cacheInfoTimeoutMs;

	return async (url: string) => {
		const target = `${url.replace(/\/+$/, '')}/nix-cache-info`;
		const timeoutSignal = AbortSignal.timeout(timeoutMs);
		const signal =
			options.signal === undefined
				? timeoutSignal
				: AbortSignal.any([options.signal, timeoutSignal]);
		let response: Response;
		let body: string;

		try {
			response = await fetcher(target, {
				...(headers !== undefined && { headers }),
				signal
			});
			body = await response.text();
		} catch (error) {
			if (options.signal?.aborted === true) {
				throw abortReason(options.signal);
			}

			if (timeoutSignal.aborted) {
				throw new CacheInfoTimeoutError(target, timeoutMs, { cause: error });
			}

			throw error;
		}

		if (!response.ok) {
			if (response.status === tooManyRequestsStatus) {
				throw new CacheInfoRateLimitedError(target);
			}

			if (response.status >= serverErrorStatus) {
				throw new CacheInfoServerError(target, response.status);
			}

			throw new CacheInfoUnavailableError(target, response.status);
		}

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

// The enabled rules holding the same repository and event pin as `body`.
function rulesForSameTrigger(
	rules: readonly OidcTrustSummary[],
	body: OidcTrustAddBody,
	trigger: readonly string[]
): OidcTrustSummary[] {
	return rules.filter(
		(rule) =>
			!rule.disabled &&
			rule.issuer === body.issuer &&
			trigger.every((claim) =>
				isDeepEqual(rule.claims[claim], body.claims[claim])
			)
	);
}

function claimsWithoutWorkflowReference(
	claims: Record<string, unknown>
): Record<string, unknown> {
	const { job_workflow_ref: _workflowReference, ...remaining } = claims;

	return remaining;
}

// A previous setup-managed rule has the same matching and issuance shape, but
// pins a different immutable workflow release. It may coexist while the caller
// moves between those releases; an absent or pattern-based pin is never treated
// as a safe overlap.
function isManagedWorkflowSibling(
	rule: OidcTrustSummary,
	body: OidcTrustAddBody
): boolean {
	const workflowReference = rule.claims.job_workflow_ref;

	if (typeof workflowReference !== 'string') {
		return false;
	}

	try {
		requirePinnedWorkflowReference(workflowReference);
	} catch {
		return false;
	}

	return (
		rule.issuer === body.issuer &&
		rule.audience === body.audience &&
		isDeepEqual(
			claimsWithoutWorkflowReference(rule.claims),
			claimsWithoutWorkflowReference(body.claims)
		) &&
		isDeepEqual(rule.permittedGrants, body.permittedGrants)
	);
}

function managedWorkflowSiblingReferences(
	rules: readonly OidcTrustSummary[],
	body: OidcTrustAddBody,
	trigger: readonly string[]
): string[] {
	return rulesForSameTrigger(rules, body, trigger)
		.filter((rule) => isManagedWorkflowSibling(rule, body))
		.map((rule) => rule.claims.job_workflow_ref)
		.filter(
			(reference): reference is string =>
				typeof reference === 'string' &&
				reference !== body.claims.job_workflow_ref
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
	const sameTrigger = rulesForSameTrigger(rules, body, trigger);
	const drifted = sameTrigger.find(
		(rule) =>
			!isRuleMatchingBody(rule, body) && !isManagedWorkflowSibling(rule, body)
	);

	if (drifted !== undefined) {
		return {
			step,
			outcome: 'drift',
			detail: `rule ${drifted.id} covers the same trigger but differs on ${ruleDifferences(drifted, body).join(', ')}; remove it and re-run setup`
		};
	}

	const matching = sameTrigger.find((rule) => isRuleMatchingBody(rule, body));

	if (matching !== undefined) {
		return { step, outcome: 'unchanged' };
	}

	await client.oidcTrust.add(body);

	return { step, outcome: 'created' };
}

interface TrustRuleRetirement {
	readonly step: SetupStep;
	readonly ruleIds: readonly string[];
}

function planTrustRuleRetirement(
	rules: readonly OidcTrustSummary[],
	step: string,
	body: OidcTrustAddBody,
	trigger: readonly string[]
): TrustRuleRetirement {
	const workflowReference = body.claims.job_workflow_ref;
	const candidates = rulesForSameTrigger(rules, body, trigger).filter((rule) =>
		isDeepEqual(rule.claims.job_workflow_ref, workflowReference)
	);
	const drifted = candidates.find((rule) => !isRuleMatchingBody(rule, body));

	if (drifted !== undefined) {
		return {
			step: {
				step,
				outcome: 'drift',
				detail: `rule ${drifted.id} pins the retired workflow reference but differs on ${ruleDifferences(drifted, body).join(', ')}; inspect it before removing it explicitly`
			},
			ruleIds: []
		};
	}

	if (candidates.length === 0) {
		return {
			step: {
				step,
				outcome: 'unchanged',
				detail: 'the retired workflow reference is not trusted'
			},
			ruleIds: []
		};
	}

	return {
		step: {
			step,
			outcome: 'removed',
			detail: `${String(candidates.length)} rule${candidates.length === 1 ? '' : 's'}`
		},
		ruleIds: candidates.map((rule) => rule.id)
	};
}

async function applyTrustRuleRetirement(
	client: GithubSetupClient,
	retirement: TrustRuleRetirement
): Promise<SetupStep> {
	for (const id of retirement.ruleIds) {
		await client.oidcTrust.remove({ id });
	}

	return retirement.step;
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
	const verifyWorkflowReference =
		dependencies.verifyWorkflowReference ?? verifyPinnedWorkflowReference;
	const lookupOptions =
		dependencies.signal === undefined ? {} : { signal: dependencies.signal };
	const graceSeconds = parseGrace(options.grace);

	requirePinnedWorkflowReference(options.workflowRef);
	if (options.retireWorkflowRef !== undefined) {
		requirePinnedWorkflowReference(options.retireWorkflowRef);

		if (options.retireWorkflowRef === options.workflowRef) {
			throw new WorkflowReferenceRetirementConflictError(options.workflowRef);
		}
	}

	if (graceSeconds < minimumGraceSeconds) {
		throw new GraceTooShortError(graceSeconds, minimumGraceSeconds);
	}

	await reporter.phase('Verifying workflow reference', () =>
		verifyWorkflowReference(options.workflowRef, lookupOptions)
	);

	const identity = await reporter.phase('Resolving repository', () =>
		resolveRepository(options.repo, lookupOptions)
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
	const retiredBodies =
		options.retireWorkflowRef === undefined
			? undefined
			: {
					pr: githubPrAddBody(url, identity, {
						repo: options.repo,
						jobWorkflowRef: options.retireWorkflowRef
					}),
					branch: githubBranchAddBody(url, identity, {
						repo: options.repo,
						branch: options.branch,
						jobWorkflowRef: options.retireWorkflowRef
					})
				};
	const { rules } = await reporter.phase('Reading trust rules', () =>
		client.oidcTrust.list()
	);
	const previousWorkflowReferences = new Set([
		...managedWorkflowSiblingReferences(rules, prBody, [
			'repository_id',
			'event_name'
		]),
		...managedWorkflowSiblingReferences(rules, branchBody, [
			'repository_id',
			'ref'
		])
	]);

	if (options.retireWorkflowRef !== undefined) {
		previousWorkflowReferences.delete(options.retireWorkflowRef);
	}

	if (previousWorkflowReferences.size > 0) {
		await reporter.phase('Verifying previous workflow references', () =>
			Promise.all(
				[...previousWorkflowReferences].map((reference) =>
					verifyWorkflowReference(reference, lookupOptions)
				)
			)
		);
	}

	const destination = await reporter.phase('Reading destination priority', () =>
		fetchCacheInfo(url)
	);

	const steps = await reporter.phase(
		'Converging tenant configuration',
		async () => {
			const grace = await convergeGracePolicy(client, graceSeconds);
			const reuseView = await convergeReuseView(client, destination.priority);
			const pullRequestTrust = await convergeTrustRule(
				client,
				rules,
				'pull-request trust rule',
				prBody,
				['repository_id', 'event_name']
			);
			const branchTrust = await convergeTrustRule(
				client,
				rules,
				`${options.branch} trust rule`,
				branchBody,
				['repository_id', 'ref']
			);
			const steps = [grace, reuseView, pullRequestTrust, branchTrust];

			if (
				retiredBodies === undefined ||
				pullRequestTrust.outcome === 'drift' ||
				branchTrust.outcome === 'drift'
			) {
				return steps;
			}

			const retirePullRequest = planTrustRuleRetirement(
				rules,
				'previous pull-request trust rule',
				retiredBodies.pr,
				['repository_id', 'event_name']
			);
			const retireBranch = planTrustRuleRetirement(
				rules,
				`previous ${options.branch} trust rule`,
				retiredBodies.branch,
				['repository_id', 'ref']
			);

			if (
				retirePullRequest.step.outcome === 'drift' ||
				retireBranch.step.outcome === 'drift'
			) {
				return [...steps, retirePullRequest.step, retireBranch.step];
			}

			return [
				...steps,
				await applyTrustRuleRetirement(client, retirePullRequest),
				await applyTrustRuleRetirement(client, retireBranch)
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
			'The exact job_workflow_ref claim to pin, at an immutable release tag or full commit id.'
		)
		.option(
			'--retire-workflow-ref <owner/repo/path@ref>',
			'Remove setup-managed rules for this previous immutable workflow reference after the new rules are established.'
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

			await runGithubSetup(
				url,
				options,
				reporter,
				{
					policies: rpc.policies,
					reuseViews: rpc.reuseViews,
					oidcTrust: rpc.oidcTrust
				},
				{
					...(programOptions.signal !== undefined && {
						signal: programOptions.signal
					}),
					fetchCacheInfo: cacheInfoFetcher({
						...options,
						signal: programOptions.signal
					})
				}
			);
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
			'The exact job_workflow_ref claim to check, at an immutable release tag or full commit id.'
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
				{
					...(programOptions.signal !== undefined && {
						signal: programOptions.signal
					}),
					fetchCacheInfo: cacheInfoFetcher({
						...options,
						signal: programOptions.signal
					})
				}
			);
		});
}
