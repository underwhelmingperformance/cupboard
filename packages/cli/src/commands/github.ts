import { type CliUi, type MenuEntry } from '@cupboard/cli-ui';
import { CacheInfo } from '@cupboard/nix-store/cache-info';
import {
	type CachePriority,
	type GraceSeconds
} from '@cupboard/nix-store/scalars';
import {
	type OidcTrustAddBody,
	type OidcTrustListResponse,
	type OidcTrustSummary,
	type ParsedOidcTrustListResponse,
	type ParsedOidcTrustRemoveResponse,
	type ParsedOidcTrustSummary
} from '@cupboard/protocol/oidc';
import { isClaimSatisfied } from '@cupboard/protocol/oidc-trust-match';
import {
	isDestinationPreferred,
	reuseViewPrioritySchema,
	viewPriorityMargin
} from '@cupboard/protocol/reuse-views';
import { type Reporter, type ResultRow } from '@cupboard/reporter';
import { basicAuthHeader, type ReadUser } from '@cupboard/shared/http';
import type { Command } from 'commander';
import { StatusCodes } from 'http-status-codes';

import { abortReason } from '../abort.ts';
import { cachedOwnerProvider } from '../auth/auth.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { tenantRpc } from '../client/orpc.ts';
import { resilientFetcher } from '../client/transport.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { parseGrace } from '../duration.ts';
import {
	CacheInfoRateLimitedError,
	CacheInfoServerError,
	CacheInfoTimeoutError,
	CacheInfoUnavailableError,
	CacheInfoUnparsableError,
	GithubSetupDriftError,
	GithubSetupOwnerRuleConflictError,
	GithubSetupRemovalError,
	GraceTooShortError,
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
	minimumGraceSeconds,
	parseExactWorkflowReference,
	parseWorkflowReference,
	pullRequestPrefix,
	pullRequestViewName,
	workflowReferenceClaimsOverlap
} from './github/convention.ts';
import { verifyWorkflowReference } from './github/workflow-reference.ts';
import { githubBranchAddBody, githubPrAddBody } from './oidc-trust.ts';
import { lookupRepository } from './oidc-trust/github.ts';
import { type PolicyClient } from './policy.ts';
import { type ReuseViewClient } from './reuse-view.ts';

const tooManyRequestsStatus: number = StatusCodes.TOO_MANY_REQUESTS;
const serverErrorStatus: number = StatusCodes.INTERNAL_SERVER_ERROR;

export interface GithubSetupOptions {
	readonly repo: string;
	readonly branch: string;
	readonly grace: string;
	readonly workflowRef: string;
	readonly yes?: boolean;
	readonly readUser?: ReadUser;
	readonly readPassword?: string;
}

export interface GithubSetupClient {
	readonly policies: Pick<PolicyClient, 'graceList' | 'graceAdd'>;
	readonly reuseViews: Pick<ReuseViewClient, 'list' | 'set'>;
	readonly oidcTrust: {
		list(): Promise<ParsedOidcTrustListResponse>;
		add(input: OidcTrustAddBody): Promise<ParsedOidcTrustSummary>;
		remove(input: { id: string }): Promise<ParsedOidcTrustRemoveResponse>;
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
 * Reads `nix-cache-info` with the supplied Basic credential. Private tenant
 * routes return 401 without one. Supplying only one part of the credential pair
 * fails before the request starts.
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

// Rule ids and disabled state do not form part of a rule body. Compare every
// field that affects matching or the authority issued by an exchange.
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

interface DesiredTrustRule {
	readonly step: string;
	readonly kind: 'pull-request' | 'branch';
	readonly trigger: string;
	readonly body: OidcTrustAddBody;
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

async function planGracePolicy(
	client: GithubSetupClient,
	graceSeconds: GraceSeconds
): Promise<PlannedSetupStep> {
	const { policies } = await client.policies.graceList();
	const existing = policies.find((policy) => policy.cachePrefix === '');

	if (existing === undefined) {
		return {
			step: {
				step: 'grace policy',
				outcome: 'created',
				detail: `tenant-wide grace ${String(graceSeconds)}s`
			},
			apply: async () => {
				await client.policies.graceAdd({ cachePrefix: '', graceSeconds });
			}
		};
	}

	if (existing.graceSeconds === graceSeconds) {
		return { step: { step: 'grace policy', outcome: 'unchanged' } };
	}

	return {
		step: {
			step: 'grace policy',
			outcome: 'drift',
			detail: `stored tenant-wide grace is ${String(existing.graceSeconds)}s, setup would write ${String(graceSeconds)}s`
		}
	};
}

async function planReuseView(
	client: GithubSetupClient,
	destinationPriority: CachePriority
): Promise<PlannedSetupStep> {
	const selectors = [{ kind: 'prefix' as const, pattern: pullRequestPrefix }];
	const { views } = await client.reuseViews.list();
	const existing = views.find((view) => view.name === pullRequestViewName);

	if (existing === undefined) {
		return {
			step: {
				step: 'reuse view',
				outcome: 'created',
				detail: `${pullRequestPrefix} caches at priority ${String(destinationPriority + viewPriorityMargin)}`
			},
			apply: async () => {
				await client.reuseViews.set({
					name: pullRequestViewName,
					selectors,
					priority: reuseViewPrioritySchema.parse(
						destinationPriority + viewPriorityMargin
					)
				});
			}
		};
	}

	if (
		isDeepEqual([...existing.selectors], selectors) &&
		isDestinationPreferred(destinationPriority, existing.priority)
	) {
		return { step: { step: 'reuse view', outcome: 'unchanged' } };
	}

	return {
		step: {
			step: 'reuse view',
			outcome: 'drift',
			detail: isDestinationPreferred(destinationPriority, existing.priority)
				? 'stored selectors differ from the pr- prefix setup would write'
				: `stored priority ${String(existing.priority)} does not exceed the destination's ${String(destinationPriority)}`
		}
	};
}

function planTrustRule(
	client: GithubSetupClient,
	rules: OidcTrustListResponse['rules'],
	step: string,
	body: OidcTrustAddBody
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
		dependencies.fetchCacheInfo ?? cacheInfoFetcher(options);
	const verifyReference =
		dependencies.verifyWorkflowReference ?? verifyWorkflowReference;
	const lookupOptions =
		dependencies.signal === undefined ? {} : { signal: dependencies.signal };
	const graceSeconds = parseGrace(options.grace);

	if (graceSeconds < minimumGraceSeconds) {
		throw new GraceTooShortError(graceSeconds, minimumGraceSeconds);
	}

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
	const prBody = githubPrAddBody(url, identity, {
		repo: options.repo,
		jobWorkflowRef: options.workflowRef
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

	const destination = await reporter.phase('Reading destination priority', () =>
		fetchCacheInfo(url)
	);
	const configurationPlans = await reporter.phase(
		'Reading tenant configuration',
		() =>
			Promise.all([
				planGracePolicy(client, graceSeconds),
				planReuseView(client, destination.priority)
			])
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
			'Configure the grace policy, pull-request reuse view and trust rules for cache-aware flake publication.'
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.requiredOption(
			'--repo <owner/name>',
			'GitHub repository that will publish.'
		)
		.option('--branch <name>', 'Branch whose pushes publish.', 'main')
		.option('--grace <duration>', 'Tenant-wide retention grace period.', '24h')
		.requiredOption(
			'--workflow-ref <owner/repo/path@ref>',
			'Match job_workflow_ref to a full commit id, a tag ref for a release GitHub reports as immutable, or a tag pattern such as @refs/tags/v*. A pattern also trusts matching tags created later.'
		)
		.option(
			'-y, --yes',
			'Remove conflicting trust rules without prompting; retain uncertain and superseded rules.'
		)
		.option(
			'--read-user <user>',
			'Basic read credential for tenants whose reads are private.',
			parseReadUser
		)
		.option(
			'--read-password <password>',
			'Basic read credential for tenants whose reads are private.'
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
			"Check tenant state against the quickstart's modelled pull-request and branch publications: trust rules and grants, grace coverage, reuse-view configuration and root-prefix nesting."
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
			'--read-user <user>',
			'Basic read credential for tenants whose reads are private.',
			parseReadUser
		)
		.option(
			'--read-password <password>',
			'Basic read credential for tenants whose reads are private.'
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
