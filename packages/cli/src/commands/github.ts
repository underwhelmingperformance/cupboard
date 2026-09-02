import { type CliUi, type MenuEntry } from '@cupboard/cli-ui';
import { CacheInfo } from '@cupboard/nix-store/cache-info';
import {
	type CacheAccessMode,
	cacheAccessModeSchema,
	type CachePriority,
	cachePrioritySchema
} from '@cupboard/nix-store/scalars';
import {
	managedCacheGroupIdSchema,
	managedPolicyIdSchema,
	type ManagedPolicyPutBodyInput,
	managedPolicyPutBodySchema,
	type ManagedPolicySummary,
	managedPolicySummarySchema
} from '@cupboard/protocol/managed-caches';
import {
	type OidcTrustAddBodyInput,
	type OidcTrustListResponse,
	type OidcTrustRemoveResponse,
	type OidcTrustSummary
} from '@cupboard/protocol/oidc';
import { isClaimSatisfied } from '@cupboard/protocol/oidc-trust-match';
import {
	reuseViewPrioritySchema,
	type ReuseViewSelector,
	viewPriorityMargin
} from '@cupboard/protocol/reuse-views';
import { type Reporter, type ResultRow } from '@cupboard/reporter';
import { basicAuthHeader, type ReadUser } from '@cupboard/shared/http';
import { readResponseText } from '@cupboard/shared/response-body';
import type { Command } from 'commander';
import { StatusCodes } from 'http-status-codes';

import { abortReason } from '../abort.ts';
import { cachedOwnerProvider } from '../auth/auth.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { tenantRpc } from '../client/orpc.ts';
import { resilientFetcher } from '../client/transport.ts';

const maximumCacheInfoBytes = 1024 * 1024;
import { parseWorkerUrl } from '../client/transport.ts';
import {
	CacheInfoRateLimitedError,
	CacheInfoServerError,
	CacheInfoTimeoutError,
	CacheInfoUnavailableError,
	CacheInfoUnparsableError,
	GithubSetupDriftError,
	GithubSetupOwnerRuleConflictError,
	GithubSetupRemovalError,
	ReadCredentialPairError
} from '../errors.ts';
import { parseReadUser } from '../read-user.ts';
import { tenantUrlArgument } from '../url-argument.ts';

import { type GithubCheckOptions, runGithubCheck } from './github/check.ts';
import {
	githubBranchClaims,
	githubPullRequestClaims
} from './github/claims.ts';
import {
	parseExactWorkflowReference,
	parseWorkflowReference,
	pullRequestViewName,
	workflowReferenceClaimsOverlap
} from './github/convention.ts';
import { verifyWorkflowReference } from './github/workflow-reference.ts';
import { githubBranchAddBody, githubPrAddBody } from './oidc-trust.ts';
import { lookupRepository } from './oidc-trust/github.ts';
import { type ReuseViewClient } from './reuse-view.ts';

const tooManyRequestsStatus: number = StatusCodes.TOO_MANY_REQUESTS;
const serverErrorStatus: number = StatusCodes.INTERNAL_SERVER_ERROR;

export interface GithubSetupOptions {
	readonly repo: string;
	readonly branch: string;
	readonly workflowRef: string;
	readonly yes?: boolean;
	readonly prCacheAccess: CacheAccessMode;
	readonly destinationReadUser?: ReadUser;
	readonly destinationReadPassword?: string;
}

export interface GithubSetupClient {
	readonly reuseViews: Pick<ReuseViewClient, 'list' | 'set'>;
	readonly oidcTrust: {
		list(): Promise<OidcTrustListResponse>;
		add(input: OidcTrustAddBodyInput): Promise<OidcTrustSummary>;
		remove(input: { id: string }): Promise<OidcTrustRemoveResponse>;
	};
	readonly managedCaches: {
		readonly policies: {
			list(): Promise<{ policies: ManagedPolicySummary[] }>;
			put(input: ManagedPolicyPutBodyInput): Promise<ManagedPolicySummary>;
		};
	};
}

export interface GithubSetupDependencies {
	readonly lookupRepository?: typeof lookupRepository;
	readonly fetchCacheInfo?: (url: URL) => Promise<CacheInfo>;
	readonly verifyWorkflowReference?: typeof verifyWorkflowReference;
	readonly signal?: AbortSignal;
}

// For `drift`, setup leaves the stored state unchanged for the operator to
// resolve. `missing` means setup deferred a creation because another step had
// drifted.
export interface SetupStep {
	readonly step: string;
	readonly outcome:
		'created' | 'removed' | 'retained' | 'unchanged' | 'drift' | 'missing';
	readonly detail?: string;
}

export interface ReadCredentialOptions {
	readonly readUser?: ReadUser;
	readonly readPassword?: string;
	readonly signal?: AbortSignal;
}

interface CacheInfoFetcherDependencies {
	readonly fetch?: typeof fetch;
	readonly timeoutMs?: number;
}

const cacheInfoTimeoutMs = 30_000;

/**
 * Reads `nix-cache-info` with the supplied Basic credential. A private cache
 * returns 401 without an accepted credential. Supplying only one part of the
 * credential pair fails before the request starts.
 */
export function cacheInfoFetcher(
	options: ReadCredentialOptions,
	dependencies: CacheInfoFetcherDependencies = {}
): (url: URL) => Promise<CacheInfo> {
	if (
		(options.readUser === undefined) !==
		(options.readPassword === undefined)
	) {
		throw new ReadCredentialPairError();
	}

	const headers =
		options.readUser === undefined || options.readPassword === undefined
			? undefined
			: basicAuthHeader({
					user: options.readUser,
					password: options.readPassword
				});
	const fetcher = resilientFetcher('replay-safe', dependencies.fetch);
	const timeoutMs = dependencies.timeoutMs ?? cacheInfoTimeoutMs;

	return async (url: URL) => {
		const target = new URL(url);
		target.pathname = `${target.pathname.replace(/\/+$/u, '')}/nix-cache-info`;
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
			body = await readResponseText(response, {
				description: `Cache information from ${target.href}`,
				maximumBytes: maximumCacheInfoBytes,
				signal
			});
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

// Rule ids and disabled state do not form part of a rule body. Compare every
// field that affects matching or the authority issued by an exchange.
function isRuleMatchingBody(
	rule: OidcTrustSummary,
	body: OidcTrustAddBodyInput
): boolean {
	return (
		rule.issuer === body.issuer &&
		rule.audience === body.audience &&
		isDeepEqual(rule.claims, body.claims) &&
		isDeepEqual(rule.permittedGrants, body.permittedGrants)
	);
}

interface DesiredTrustRule {
	readonly step: string;
	readonly kind: 'pull-request' | 'branch';
	readonly trigger: string;
	readonly body: OidcTrustAddBodyInput;
	readonly tokenClaims: Readonly<Record<string, string>>;
}

type ClaimEvaluation = 'match' | 'mismatch' | 'unknown';

function evaluateClaim(
	desired: DesiredTrustRule,
	claim: string,
	expected: OidcTrustSummary['claims'][string]
): ClaimEvaluation {
	const actual = desired.tokenClaims[claim];

	if (actual !== undefined) {
		return isClaimSatisfied(expected, actual) ? 'match' : 'mismatch';
	}

	if (claim === 'job_workflow_ref') {
		const desiredReference = desired.body.claims.job_workflow_ref;

		if (desiredReference !== undefined) {
			const overlaps = workflowReferenceClaimsOverlap(
				desiredReference,
				expected
			);

			if (overlaps !== undefined) {
				return overlaps ? 'match' : 'mismatch';
			}
		}
	}

	if (
		claim === 'ref' &&
		typeof expected === 'string' &&
		desired.kind === 'pull-request'
	) {
		// GitHub gives pull-request runs refs of this form.
		return /^refs\/pull\/[1-9]\d*\/merge$/.test(expected)
			? 'match'
			: 'mismatch';
	}

	return 'unknown';
}

interface RuleMatchEvaluation {
	readonly outcome: 'match' | 'possible' | 'no';
	readonly unknownClaims: readonly string[];
}

const noMatch: RuleMatchEvaluation = { outcome: 'no', unknownClaims: [] };

function evaluateRuleMatch(
	rule: OidcTrustSummary,
	desired: DesiredTrustRule,
	shouldIncludeWorkflowReference: boolean
): RuleMatchEvaluation {
	if (
		rule.disabled ||
		rule.issuer !== desired.body.issuer ||
		rule.audience !== desired.body.audience
	) {
		return noMatch;
	}

	const unknownClaims: string[] = [];

	for (const [claim, expected] of Object.entries(rule.claims)) {
		if (!shouldIncludeWorkflowReference && claim === 'job_workflow_ref') {
			continue;
		}

		const evaluation = evaluateClaim(desired, claim, expected);

		if (evaluation === 'mismatch') {
			return noMatch;
		}

		if (evaluation === 'unknown') {
			unknownClaims.push(claim);
		}
	}

	return {
		outcome: unknownClaims.length > 0 ? 'possible' : 'match',
		unknownClaims: unknownClaims.toSorted((left, right) =>
			left.localeCompare(right)
		)
	};
}

interface ClassifiedTrustRule {
	readonly rule: OidcTrustSummary;
	readonly triggers: readonly string[];
	readonly unknownClaims: readonly string[];
}

// Remove `conflicts` before setup completes because the modelled claims match
// them. Never remove `uncertain` automatically: they contain claims outside the
// model and require an explicit interactive selection. `superseded` rules use a
// different workflow reference and can coexist with the new rules.
interface TrustRuleClassification {
	readonly conflicts: readonly ClassifiedTrustRule[];
	readonly uncertain: readonly ClassifiedTrustRule[];
	readonly superseded: readonly ClassifiedTrustRule[];
}

type TrustRuleBucket = 'conflict' | 'uncertain' | 'superseded';

const bucketPrecedence: Record<TrustRuleBucket, number> = {
	conflict: 2,
	uncertain: 1,
	superseded: 0
};

interface TrustRuleEntry {
	readonly rule: OidcTrustSummary;
	readonly triggers: string[];
	readonly unknownClaims: Set<string>;
	bucket: TrustRuleBucket;
}

function classifyTrustRule(
	rule: OidcTrustSummary,
	desired: DesiredTrustRule,
	currentRuleIds: ReadonlySet<string>,
	entries: Map<string, TrustRuleEntry>
): void {
	if (
		currentRuleIds.has(rule.id) ||
		evaluateRuleMatch(rule, desired, false).outcome === 'no'
	) {
		return;
	}

	const full = evaluateRuleMatch(rule, desired, true);
	let bucket: TrustRuleBucket;

	if (full.outcome === 'match') {
		bucket = 'conflict';
	} else if (full.outcome === 'possible') {
		bucket = 'uncertain';
	} else {
		const workflowReference = rule.claims.job_workflow_ref;

		if (
			workflowReference === undefined ||
			rule.id === 'owner' ||
			isDeepEqual(workflowReference, desired.body.claims.job_workflow_ref)
		) {
			return;
		}

		bucket = 'superseded';
	}

	const entry = entries.get(rule.id) ?? {
		rule,
		triggers: [],
		unknownClaims: new Set<string>(),
		bucket
	};

	if (!entry.triggers.includes(desired.trigger)) {
		entry.triggers.push(desired.trigger);
	}

	for (const claim of full.unknownClaims) {
		entry.unknownClaims.add(claim);
	}

	if (bucketPrecedence[bucket] > bucketPrecedence[entry.bucket]) {
		entry.bucket = bucket;
	}

	entries.set(rule.id, entry);
}

function classifyTrustRules(
	rules: readonly OidcTrustSummary[],
	desiredRules: readonly DesiredTrustRule[]
): TrustRuleClassification {
	const entries = new Map<string, TrustRuleEntry>();
	const currentRuleIds = new Set(
		rules
			.filter(
				(rule) =>
					!rule.disabled &&
					desiredRules.some((desired) => isRuleMatchingBody(rule, desired.body))
			)
			.map((rule) => rule.id)
	);

	for (const desired of desiredRules) {
		for (const rule of rules) {
			classifyTrustRule(rule, desired, currentRuleIds, entries);
		}
	}

	const inBucket = (bucket: TrustRuleBucket): ClassifiedTrustRule[] =>
		entries
			.values()
			.filter((entry) => entry.bucket === bucket)
			.map((entry) => ({
				rule: entry.rule,
				triggers: [...entry.triggers],
				unknownClaims:
					bucket === 'uncertain'
						? [...entry.unknownClaims].toSorted((left, right) =>
								left.localeCompare(right)
							)
						: []
			}))
			.toArray()
			.toSorted((left, right) => left.rule.id.localeCompare(right.rule.id));

	return {
		conflicts: inBucket('conflict'),
		uncertain: inBucket('uncertain'),
		superseded: inBucket('superseded')
	};
}

function pinnedReference(
	reference: string
): ReturnType<typeof parseExactWorkflowReference> | undefined {
	try {
		return parseExactWorkflowReference(reference);
	} catch {
		return undefined;
	}
}

function workflowReferenceDescription(
	claim: OidcTrustSummary['claims'][string] | undefined
): string {
	if (typeof claim === 'string') {
		return claim;
	}

	if (claim !== undefined) {
		return `workflow references matching ${claim.pattern}`;
	}

	return 'any workflow reference';
}

function ruleCaveat(classified: ClassifiedTrustRule): string | undefined {
	if (classified.unknownClaims.length > 0) {
		return `setup cannot check ${classified.unknownClaims.join(', ')}`;
	}

	const workflowReference = classified.rule.claims.job_workflow_ref;

	if (
		typeof workflowReference === 'string' &&
		pinnedReference(workflowReference) === undefined
	) {
		return 'trusts future edits to the workflow';
	}

	return undefined;
}

function ruleLabel(classified: ClassifiedTrustRule): string {
	return `${classified.triggers.join(' and ')} (${classified.rule.id})`;
}

function ruleMenuEntry(classified: ClassifiedTrustRule): MenuEntry<string> {
	const description = workflowReferenceDescription(
		classified.rule.claims.job_workflow_ref
	);
	const caveat = ruleCaveat(classified);

	return {
		value: classified.rule.id,
		label: ruleLabel(classified),
		hint: caveat === undefined ? description : `${description} (${caveat})`
	};
}

function ruleResultStep(
	classification: 'conflicting' | 'possibly conflicting' | 'superseded',
	classified: ClassifiedTrustRule,
	outcome: 'removed' | 'retained',
	problem?: string
): SetupStep {
	const detail = [
		classified.triggers.join(' and '),
		workflowReferenceDescription(classified.rule.claims.job_workflow_ref),
		ruleCaveat(classified),
		problem
	]
		.filter((part) => part !== undefined)
		.join('; ');

	return {
		step: `${classification} trust rule ${classified.rule.id}`,
		outcome,
		detail
	};
}

interface PlannedSetupStep {
	readonly step: SetupStep;
	readonly apply?: () => Promise<void>;
}

interface PlannedManagedPolicy {
	readonly request: ManagedPolicyPutBodyInput;
	readonly policy: ManagedPolicySummary;
	readonly createsPolicy: boolean;
	readonly drift: SetupStep | undefined;
}

async function planManagedPolicy(
	client: GithubSetupClient,
	identity: Awaited<ReturnType<typeof lookupRepository>>,
	access: CacheAccessMode,
	destinationPriority: CachePriority
): Promise<PlannedManagedPolicy> {
	const { policies } = await client.managedCaches.policies.list();
	const repositoryId = String(identity.repositoryId);
	const ownerId = String(identity.repositoryOwnerId);
	const existing = policies.find(
		(policy) => policy.repositoryId === repositoryId
	);
	const sharedGroup = policies.find(
		(policy) =>
			policy.reuseViewName === pullRequestViewName &&
			policy.configuration.access === access
	);
	const policyPriority =
		existing?.configuration.priority ?? cachePrioritySchema.parse(40);
	const newPolicyRequest = managedPolicyPutBodySchema.parse({
		id: existing?.id ?? managedPolicyIdSchema.parse(crypto.randomUUID()),
		ownerId,
		repositoryId,
		groupId:
			existing?.configuration.groupId ??
			sharedGroup?.configuration.groupId ??
			managedCacheGroupIdSchema.parse(crypto.randomUUID()),
		reuseViewName: pullRequestViewName,
		access,
		reuseViewPriority: reuseViewPrioritySchema.parse(
			Math.max(destinationPriority, policyPriority) + viewPriorityMargin
		)
	});

	if (existing !== undefined) {
		const request = managedPolicyPutBodySchema.parse({
			id: existing.id,
			ownerId: existing.ownerId,
			repositoryId: existing.repositoryId,
			cacheNamespace: existing.cacheNamespace,
			reuseViewName: existing.reuseViewName,
			reuseViewPriority: existing.reuseViewPriority,
			...existing.configuration
		});
		let detail: string | undefined;

		if (existing.ownerId !== ownerId) {
			detail = `stored owner ID is ${existing.ownerId}; repository owner ID is ${ownerId}`;
		} else if (existing.reuseViewName !== pullRequestViewName) {
			detail = `stored reuse view is ${existing.reuseViewName}; expected ${pullRequestViewName}`;
		} else if (existing.configuration.access !== access) {
			detail = `stored access is ${existing.configuration.access}; requested ${access}`;
		} else if (
			existing.reuseViewPriority !== newPolicyRequest.reuseViewPriority
		) {
			detail = `stored reuse-view priority is ${String(existing.reuseViewPriority)}; expected ${String(newPolicyRequest.reuseViewPriority)}`;
		}

		return {
			request,
			policy: existing,
			createsPolicy: false,
			drift:
				detail === undefined
					? undefined
					: {
							step: 'managed cache policy',
							outcome: 'drift',
							detail
						}
		};
	}

	const policy = managedPolicySummarySchema.parse({
		id: newPolicyRequest.id,
		ownerId: newPolicyRequest.ownerId,
		repositoryId: newPolicyRequest.repositoryId,
		cacheNamespace: `gh-${repositoryId}-pr-`,
		status: 'active',
		currentRevision: 1,
		reuseViewName: newPolicyRequest.reuseViewName,
		reuseViewPriority: newPolicyRequest.reuseViewPriority,
		configuration: {
			groupId: newPolicyRequest.groupId,
			access: newPolicyRequest.access,
			priority: newPolicyRequest.priority,
			defaultRootRetention: newPolicyRequest.defaultRootRetention,
			maximumRootDurationSeconds: newPolicyRequest.maximumRootDurationSeconds,
			allowPermanentRoots: newPolicyRequest.allowPermanentRoots,
			graceSeconds: newPolicyRequest.graceSeconds,
			creationLeaseSeconds: newPolicyRequest.creationLeaseSeconds,
			provisionalLeaseSeconds: newPolicyRequest.provisionalLeaseSeconds,
			activityLeaseSeconds: newPolicyRequest.activityLeaseSeconds,
			maximumLiveCaches: newPolicyRequest.maximumLiveCaches
		}
	});

	return {
		request: newPolicyRequest,
		policy,
		createsPolicy: true,
		drift: undefined
	};
}

async function planReuseView(
	client: GithubSetupClient,
	destinationPriority: CachePriority,
	policyPlan: PlannedManagedPolicy
): Promise<PlannedSetupStep> {
	const { policy } = policyPlan;
	const selectors: ReuseViewSelector[] = [
		{ kind: 'managed-group', groupId: policy.configuration.groupId }
	];
	const priority = reuseViewPrioritySchema.parse(
		Math.max(destinationPriority, policy.configuration.priority) +
			viewPriorityMargin
	);
	const { views } = await client.reuseViews.list();
	const existing = views.find((view) => view.name === pullRequestViewName);

	if (existing === undefined) {
		return {
			step: {
				step: 'reuse view',
				outcome: 'created',
				detail: policyPlan.createsPolicy
					? 'created with the managed cache policy'
					: 'restored by reconciling the managed cache policy'
			}
		};
	}

	if (
		existing.access === policy.configuration.access &&
		isDeepEqual([...existing.selectors], selectors) &&
		existing.priority === priority
	) {
		return { step: { step: 'reuse view', outcome: 'unchanged' } };
	}

	let detail: string;

	if (existing.access !== policy.configuration.access) {
		detail = `stored access is ${existing.access}; policy access is ${policy.configuration.access}`;
	} else if (isDeepEqual([...existing.selectors], selectors)) {
		detail = `stored priority is ${String(existing.priority)}; expected ${String(priority)}`;
	} else {
		detail = 'stored selectors do not select the managed policy group';
	}

	return {
		step: {
			step: 'reuse view',
			outcome: 'drift',
			detail
		}
	};
}

function planTrustRule(
	client: GithubSetupClient,
	rules: OidcTrustListResponse['rules'],
	step: string,
	body: OidcTrustAddBodyInput
): PlannedSetupStep {
	const matching = rules.find(
		(rule) => !rule.disabled && isRuleMatchingBody(rule, body)
	);

	if (matching !== undefined) {
		return { step: { step, outcome: 'unchanged' } };
	}

	return {
		step: {
			step,
			outcome: 'created',
			detail: workflowReferenceDescription(body.claims.job_workflow_ref)
		},
		apply: async () => {
			await client.oidcTrust.add(body);
		}
	};
}

function reportSetupResult(
	reporter: Reporter,
	steps: readonly SetupStep[]
): void {
	const rows: ResultRow[] = steps.map((step) => ({
		label: step.step,
		value:
			step.detail === undefined
				? step.outcome
				: `${step.outcome}: ${step.detail}`
	}));

	reporter.result({ kind: 'github-setup', data: { steps }, rows });
}

export async function runGithubSetup(
	url: URL,
	options: GithubSetupOptions,
	ui: CliUi,
	client: GithubSetupClient,
	dependencies: GithubSetupDependencies = {}
): Promise<void> {
	const reporter = ui.reporter();
	const resolveRepository = dependencies.lookupRepository ?? lookupRepository;
	const fetchCacheInfo =
		dependencies.fetchCacheInfo ??
		cacheInfoFetcher({
			readUser: options.destinationReadUser,
			readPassword: options.destinationReadPassword,
			signal: dependencies.signal
		});
	const verifyReference =
		dependencies.verifyWorkflowReference ?? verifyWorkflowReference;
	const lookupOptions =
		dependencies.signal === undefined ? {} : { signal: dependencies.signal };
	const workflowReference = parseWorkflowReference(options.workflowRef);

	if (workflowReference.pin.kind !== 'tag-pattern') {
		const exactWorkflowReference = parseExactWorkflowReference(
			workflowReference.reference
		);

		await reporter.phase('Checking workflow reference on GitHub', () =>
			verifyReference(exactWorkflowReference, lookupOptions)
		);
	}

	const identity = await reporter.phase(
		'Reading repository identity from GitHub',
		() => resolveRepository(options.repo, lookupOptions)
	);
	const destination = await reporter.phase('Reading destination priority', () =>
		fetchCacheInfo(url)
	);
	const policyPlan = await reporter.phase(
		'Reading managed cache policies',
		() =>
			planManagedPolicy(
				client,
				identity,
				options.prCacheAccess,
				destination.priority
			)
	);
	const { policy } = policyPlan;

	if (policy.status !== 'active') {
		const step: SetupStep = {
			step: 'managed cache policy',
			outcome: 'drift',
			detail: `stored policy status is ${policy.status}; provisioning requires active`
		};
		reportSetupResult(reporter, [step]);
		throw new GithubSetupDriftError([step.step]);
	}
	const managedCacheTemplate = policy.cacheNamespace + '{pr}';
	const prBody = githubPrAddBody(url, identity, {
		repo: options.repo,
		jobWorkflowRef: options.workflowRef,
		cacheTemplate: managedCacheTemplate,
		rootTemplate: `github:${identity.fullName}/${managedCacheTemplate}/`,
		managedPolicy: policy.id
	});
	const branchBody = githubBranchAddBody(url, identity, {
		repo: options.repo,
		branch: options.branch,
		jobWorkflowRef: options.workflowRef
	});
	// These are the default claims that setup can determine without seeing a
	// token. GitHub environments and custom subject templates can change `sub`,
	// so this classification is a preflight model rather than evidence from a
	// workflow run.
	const desiredRules: readonly DesiredTrustRule[] = [
		{
			step: 'pull-request trust rule',
			kind: 'pull-request',
			trigger: 'pull requests',
			body: prBody,
			tokenClaims: githubPullRequestClaims(url, identity, {
				...(workflowReference.pin.kind !== 'tag-pattern' && {
					workflowReference: workflowReference.reference
				})
			})
		},
		{
			step: `${options.branch} trust rule`,
			kind: 'branch',
			trigger: `${options.branch} pushes`,
			body: branchBody,
			tokenClaims: githubBranchClaims(url, identity, {
				branch: options.branch,
				...(workflowReference.pin.kind !== 'tag-pattern' && {
					workflowReference: workflowReference.reference
				})
			})
		}
	];
	const { rules } = await reporter.phase('Reading trust rules', () =>
		client.oidcTrust.list()
	);
	const classification = classifyTrustRules(rules, desiredRules);

	if (
		[...classification.conflicts, ...classification.uncertain].some(
			({ rule }) => rule.id === 'owner'
		)
	) {
		throw new GithubSetupOwnerRuleConflictError();
	}

	const previousWorkflowReferences = [
		...new Set(
			classification.superseded
				.map(({ rule }) => rule.claims.job_workflow_ref)
				.filter((reference) => typeof reference === 'string')
		)
	]
		.map((reference) => pinnedReference(reference))
		.filter((parsed) => parsed !== undefined)
		.toSorted((left, right) => left.reference.localeCompare(right.reference));

	if (previousWorkflowReferences.length > 0) {
		await reporter.phase(
			'Checking previous workflow references on GitHub',
			() =>
				Promise.all(
					previousWorkflowReferences.map((reference) =>
						verifyReference(reference, lookupOptions)
					)
				)
		);
	}

	const configurationPlans = await reporter.phase(
		'Reading tenant configuration',
		async () => [
			...(policyPlan.drift === undefined ? [] : [{ step: policyPlan.drift }]),
			await planReuseView(client, destination.priority, policyPlan)
		]
	);
	const drifted = configurationPlans.filter(
		({ step }) => step.outcome === 'drift'
	);

	if (drifted.length > 0) {
		const steps = [
			...configurationPlans.map(({ step }) =>
				step.outcome === 'created'
					? {
							...step,
							outcome: 'missing' as const,
							detail: 'setup would create it after the drift is resolved'
						}
					: step
			),
			...classification.uncertain.map((classified) =>
				ruleResultStep('possibly conflicting', classified, 'retained')
			),
			...classification.superseded.map((classified) =>
				ruleResultStep('superseded', classified, 'retained')
			)
		];

		reportSetupResult(reporter, steps);

		throw new GithubSetupDriftError(drifted.map(({ step }) => step.step));
	}

	if (classification.conflicts.length > 0) {
		const outcome = await ui.confirm({
			message: 'Remove all conflicting trust rules to continue?',
			detail: classification.conflicts
				.map(
					(classified) =>
						`${ruleLabel(classified)}: ${workflowReferenceDescription(
							classified.rule.claims.job_workflow_ref
						)}`
				)
				.join('\n')
		});

		if (outcome !== 'yes') {
			ui.cancelled('GitHub setup was left unchanged.');

			return;
		}
	}

	let uncertainRuleIds = new Set<string>();

	if (
		classification.uncertain.length > 0 &&
		options.yes !== true &&
		ui.interactive
	) {
		const selected = await ui.multiSelect({
			message: 'Remove trust rules that may also match the new workflow?',
			entries: classification.uncertain.map((classified) =>
				ruleMenuEntry(classified)
			),
			initialValues: []
		});

		uncertainRuleIds = new Set(selected);
	}

	const removedRuleIds = new Set([
		...classification.conflicts.map(({ rule }) => rule.id),
		...uncertainRuleIds
	]);

	const steps = await reporter.phase(
		'Converging tenant configuration',
		async () => {
			await client.managedCaches.policies.put(policyPlan.request);

			for (const plan of configurationPlans) {
				await plan.apply?.();
			}

			// Add the new rules before removing old ones. A partial failure must not
			// leave the repository without a matching trust rule.
			const remainingRules = rules.filter(
				(rule) => !removedRuleIds.has(rule.id)
			);
			const trustPlans = desiredRules.map((desired) =>
				planTrustRule(client, remainingRules, desired.step, desired.body)
			);

			await Promise.all(
				trustPlans
					.map((plan) => plan.apply)
					.filter((apply) => apply !== undefined)
					.map((apply) => apply())
			);

			const conflictSteps: SetupStep[] = [];

			for (const classified of classification.conflicts) {
				await client.oidcTrust.remove({ id: classified.rule.id });
				conflictSteps.push(
					ruleResultStep('conflicting', classified, 'removed')
				);
			}

			for (const classified of classification.uncertain) {
				if (!uncertainRuleIds.has(classified.rule.id)) {
					conflictSteps.push(
						ruleResultStep('possibly conflicting', classified, 'retained')
					);
					continue;
				}

				await client.oidcTrust.remove({ id: classified.rule.id });
				conflictSteps.push(
					ruleResultStep('possibly conflicting', classified, 'removed')
				);
			}

			return [
				...configurationPlans.map(({ step }) => step),
				...conflictSteps,
				...trustPlans.map(({ step }) => step)
			];
		}
	);
	let supersededRuleIds = new Set<string>();

	if (
		classification.superseded.length > 0 &&
		options.yes !== true &&
		ui.interactive
	) {
		const selected = await ui.multiSelect({
			message: 'Remove superseded trust rules?',
			entries: classification.superseded.map((classified) =>
				ruleMenuEntry(classified)
			),
			initialValues: []
		});

		supersededRuleIds = new Set(selected);
	}

	const removalFailures = new Map<string, unknown>();

	if (supersededRuleIds.size > 0) {
		await reporter.phase('Removing superseded trust rules', async () => {
			const ids = [...supersededRuleIds];
			const outcomes = await Promise.allSettled(
				ids.map((id) => client.oidcTrust.remove({ id }))
			);

			for (const [index, outcome] of outcomes.entries()) {
				const id = ids[index];

				if (id !== undefined && outcome.status === 'rejected') {
					removalFailures.set(id, outcome.reason);
				}
			}
		});
	}

	for (const classified of classification.superseded) {
		const { id } = classified.rule;

		if (supersededRuleIds.has(id) && !removalFailures.has(id)) {
			steps.push(ruleResultStep('superseded', classified, 'removed'));
			continue;
		}

		steps.push(
			ruleResultStep(
				'superseded',
				classified,
				'retained',
				removalFailures.has(id) ? 'the removal failed' : undefined
			)
		);
	}

	reportSetupResult(reporter, steps);

	if (removalFailures.size > 0) {
		const failedIds = removalFailures
			.keys()
			.toArray()
			.toSorted((left, right) => left.localeCompare(right));

		throw new GithubSetupRemovalError(failedIds, {
			cause: removalFailures.values().next().value
		});
	}
}

export function registerGithubCommands(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	const github = program
		.command('github')
		.description(
			'Configure and check tenant state for publication from GitHub.'
		);

	github
		.command('setup')
		.description(
			'Configure the pull-request reuse view and trust rules for cache-aware flake publication.'
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.requiredOption(
			'--repo <owner/name>',
			'GitHub repository that will publish.'
		)
		.option('--branch <name>', 'Branch whose pushes publish.', 'main')
		.requiredOption(
			'--workflow-ref <owner/repo/path@ref>',
			'Match job_workflow_ref to a full commit id, a tag ref for a release GitHub reports as immutable, or a tag pattern such as @refs/tags/v*. A pattern also trusts matching tags created later.'
		)
		.requiredOption(
			'--pr-cache-access <access>',
			'Access for managed pull-request caches and their reuse view.',
			(value: string) => cacheAccessModeSchema.parse(value)
		)
		.option(
			'-y, --yes',
			'Remove conflicting trust rules without prompting; retain uncertain and superseded rules.'
		)
		.option(
			'--destination-read-user <user>',
			'Basic read username accepted by the default destination cache.',
			parseReadUser
		)
		.option(
			'--destination-read-password <password>',
			'Basic read password accepted by the default destination cache.'
		)
		.action(async (url: URL, options: GithubSetupOptions) => {
			const ui = commandUi(program, programOptions, { assumeYes: options.yes });
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runGithubSetup(
				url,
				options,
				ui,
				{
					reuseViews: rpc.reuseViews,
					oidcTrust: rpc.oidcTrust,
					managedCaches: rpc.managedCaches
				},
				{
					...(programOptions.signal !== undefined && {
						signal: programOptions.signal
					}),
					fetchCacheInfo: cacheInfoFetcher({
						readUser: options.destinationReadUser,
						readPassword: options.destinationReadPassword,
						signal: programOptions.signal
					})
				}
			);
		});

	github
		.command('check')
		.description(
			"Check tenant state against the quickstart's modelled pull-request and branch publications: trust rules and grants, reuse-view configuration and root-prefix nesting."
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.requiredOption(
			'--repo <owner/name>',
			'GitHub repository whose tenant configuration to check.'
		)
		.option('--branch <name>', 'Branch whose pushes publish.', 'main')
		.requiredOption(
			'--workflow-ref <owner/repo/path@ref>',
			"Exact full commit id or tag ref for a release GitHub reports as immutable, as used by the caller's workflow."
		)
		.option(
			'--root-prefix <value>',
			"root-prefix value passed by the caller's workflow."
		)
		.option(
			'--destination-read-user <user>',
			'Basic read username accepted by the default destination cache.',
			parseReadUser
		)
		.option(
			'--destination-read-password <password>',
			'Basic read password accepted by the default destination cache.'
		)
		.option(
			'--fallback-read-user <user>',
			'Tenant-fallback Basic read username accepted by the pull-request reuse view.',
			parseReadUser
		)
		.option(
			'--fallback-read-password <password>',
			'Tenant-fallback Basic read password accepted by the pull-request reuse view.'
		)
		.action(async (url: URL, options: GithubCheckOptions) => {
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
					reuseViews: rpc.reuseViews,
					oidcTrust: rpc.oidcTrust,
					managedCaches: rpc.managedCaches
				},
				{
					...(programOptions.signal !== undefined && {
						signal: programOptions.signal
					}),
					fetchDestinationCacheInfo: cacheInfoFetcher({
						readUser: options.destinationReadUser,
						readPassword: options.destinationReadPassword,
						signal: programOptions.signal
					}),
					fetchReuseViewCacheInfo: cacheInfoFetcher({
						readUser: options.fallbackReadUser,
						readPassword: options.fallbackReadPassword,
						signal: programOptions.signal
					})
				}
			);
		});
}
