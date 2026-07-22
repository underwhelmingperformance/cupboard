import { type CliUi, type MenuEntry } from '@cupboard/cli-ui';
import { CacheInfo } from '@cupboard/nix-store/cache-info';
import {
	type OidcTrustAddBody,
	type OidcTrustListResponse,
	type OidcTrustRemoveResponse,
	type OidcTrustSummary
} from '@cupboard/protocol/oidc';
import { isClaimSatisfied } from '@cupboard/protocol/oidc-trust-match';
import { type Reporter, type ResultRow } from '@cupboard/reporter';
import { basicAuthHeader } from '@cupboard/shared/http';
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
import { tenantUrlArgument } from '../url-argument.ts';

import { type GithubCheckOptions, runGithubCheck } from './github/check.ts';
import {
	minimumGraceSeconds,
	parsePinnedWorkflowReference,
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
	readonly yes?: boolean;
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
	readonly fetchCacheInfo?: (url: URL) => Promise<CacheInfo>;
	readonly verifyWorkflowReference?: typeof verifyPinnedWorkflowReference;
	readonly signal?: AbortSignal;
}

// One converging step's outcome. `drift` means the stored state neither
// matches what setup would write nor was written: it is reported and left in
// place for the operator to resolve. `missing` means setup would create the
// state but wrote nothing because another step drifted.
export interface SetupStep {
	readonly step: string;
	readonly outcome:
		'created' | 'removed' | 'retained' | 'unchanged' | 'drift' | 'missing';
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
			: basicAuthHeader(options.readUser, options.readPassword);
	const fetcher = resilientFetcher(dependencies.fetch);
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

	if (
		desired.kind === 'pull-request' &&
		claim === 'ref' &&
		typeof expected === 'string'
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

// Whether the rule can match a token the desired rule serves: `match` when
// every configured claim is satisfied by the token's known claims, `possible`
// when nothing mismatches but some configured claims are not in the token
// model, `no` on any mismatch.
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

// `conflicts` will match the new workflow's tokens and must go before setup
// proceeds. `uncertain` rules pin claims outside the token model, so setup
// cannot tell whether they would match; they are only ever removed on an
// explicit interactive selection. `superseded` rules pin a different workflow
// reference and may coexist.
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
			rule.id === 'owner' ||
			workflowReference === undefined ||
			workflowReference === desired.body.claims.job_workflow_ref
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

function isPinnedReference(reference: string): boolean {
	try {
		parsePinnedWorkflowReference(reference);

		return true;
	} catch {
		return false;
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

// The caveat a rule's row and menu entry carry: claims setup cannot evaluate,
// or a workflow reference that names whatever lands on a branch or movable
// tag rather than one released version.
function ruleCaveat(classified: ClassifiedTrustRule): string | undefined {
	if (classified.unknownClaims.length > 0) {
		return `setup cannot check ${classified.unknownClaims.join(', ')}`;
	}

	const workflowReference = classified.rule.claims.job_workflow_ref;

	if (
		typeof workflowReference === 'string' &&
		!isPinnedReference(workflowReference)
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
	graceSeconds: number
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
	destinationPriority: number
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
					priority: destinationPriority + viewPriorityMargin
				});
			}
		};
	}

	if (
		isDeepEqual([...existing.selectors], selectors) &&
		existing.priority > destinationPriority
	) {
		return { step: { step: 'reuse view', outcome: 'unchanged' } };
	}

	return {
		step: {
			step: 'reuse view',
			outcome: 'drift',
			detail:
				existing.priority <= destinationPriority
					? `stored priority ${String(existing.priority)} does not exceed the destination's ${String(destinationPriority)}`
					: 'stored selectors differ from the pr- prefix setup would write'
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
	const verifyWorkflowReference =
		dependencies.verifyWorkflowReference ?? verifyPinnedWorkflowReference;
	const lookupOptions =
		dependencies.signal === undefined ? {} : { signal: dependencies.signal };
	const graceSeconds = parseGrace(options.grace);

	requirePinnedWorkflowReference(options.workflowRef);

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
	const repositoryOwner =
		identity.fullName.split('/', 1)[0] ?? identity.fullName;
	// The claims a run of the new workflow presents, as far as they are
	// deterministic. A job that deploys to a GitHub environment presents an
	// environment-form `sub` instead of the defaults below.
	const desiredRules: readonly DesiredTrustRule[] = [
		{
			step: 'pull-request trust rule',
			kind: 'pull-request',
			trigger: 'pull requests',
			body: prBody,
			tokenClaims: {
				repository_id: String(identity.repositoryId),
				repository_owner_id: String(identity.repositoryOwnerId),
				repository: identity.fullName,
				repository_owner: repositoryOwner,
				sub: `repo:${identity.fullName}:pull_request`,
				event_name: 'pull_request',
				ref_type: 'branch',
				job_workflow_ref: options.workflowRef
			}
		},
		{
			step: `${options.branch} trust rule`,
			kind: 'branch',
			trigger: `${options.branch} pushes`,
			body: branchBody,
			tokenClaims: {
				repository_id: String(identity.repositoryId),
				repository_owner_id: String(identity.repositoryOwnerId),
				repository: identity.fullName,
				repository_owner: repositoryOwner,
				sub: `repo:${identity.fullName}:ref:refs/heads/${options.branch}`,
				ref: `refs/heads/${options.branch}`,
				ref_type: 'branch',
				job_workflow_ref: options.workflowRef
			}
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
				.filter((reference) => isPinnedReference(reference))
		)
	].toSorted((left, right) => left.localeCompare(right));

	if (previousWorkflowReferences.length > 0) {
		await reporter.phase('Verifying previous workflow references', () =>
			Promise.all(
				previousWorkflowReferences.map((reference) =>
					verifyWorkflowReference(reference, lookupOptions)
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

			// The new rules go in before the old ones come out, so a failure part
			// way through never leaves the repository without a matching rule.
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

				if (outcome.status === 'rejected' && id !== undefined) {
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
			'Set up and verify GitHub repositories that publish to this tenant.'
		);

	github
		.command('setup')
		.description(
			'Write the tenant-side configuration for cache-aware flake publishing: the grace policy, the pull-request reuse view and both trust rules, idempotently.'
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.requiredOption('--repo <owner/name>', 'GitHub repository to trust.')
		.option('--branch <name>', 'Branch whose pushes publish.', 'main')
		.option('--grace <duration>', 'Tenant-wide retention grace period.', '24h')
		.requiredOption(
			'--workflow-ref <owner/repo/path@ref>',
			'The exact job_workflow_ref claim to pin, at an immutable release tag or full commit id.'
		)
		.option(
			'-y, --yes',
			'Confirm removing conflicting trust rules; retain every other rule.'
		)
		.option(
			'--read-user <user>',
			'Basic read credential for tenants whose reads are private.'
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
			'Verify the invariants a publishing run depends on before its first CI run: trust-rule matching and grant coverage, grace coverage, reuse-view definition and priority, and root-prefix nesting.'
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
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
