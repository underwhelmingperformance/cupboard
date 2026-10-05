import { type CliUi, type MenuEntry } from '@cupboard/cli-ui';
import { type CacheInfo } from '@cupboard/nix-store/cache-info';
import { type CacheListEntry } from '@cupboard/protocol/caches';
import {
	type AuthorizationDetails,
	type CacheOperation,
	isRootOperation
} from '@cupboard/protocol/grants';
import {
	type ClaimMatch,
	type OidcTrustAddBodyInput,
	type OidcTrustExtendBodyInput,
	type OidcTrustSummary,
	oidcTrustSummarySchema
} from '@cupboard/protocol/oidc';
import { selectModelledOidcTrust } from '@cupboard/protocol/oidc-trust-diagnostics';
import {
	isClaimSatisfied,
	type OidcTrustRule
} from '@cupboard/protocol/oidc-trust-match';
import {
	reuseViewNameSchema,
	reuseViewPrioritySchema,
	viewPriorityMargin
} from '@cupboard/protocol/reuse-views';
import { genericExitCode } from '@cupboard/shared/errors';
import { ORPCError } from '@orpc/client';

import { isAbortError } from '../../abort.ts';
import { audienceSchema } from '../../audience.ts';
import { cacheLabel } from '../../client/client.ts';
import {
	CliError,
	CupboardHttpError,
	GithubCheckFailedError,
	GithubCheckIncompleteError,
	GithubCheckOptionError,
	WorkflowReferenceTagPatternError
} from '../../errors.ts';
import { classifyFailures } from '../../exit-code.ts';
import {
	githubBranchAddBody,
	githubPrAddBody,
	githubPrCloseAddBody
} from '../oidc-trust.ts';
import { trustGrantRows } from '../oidc-trust/format.ts';
import { lookupRepository } from '../oidc-trust/github.ts';
import {
	buildAddBody,
	buildCacheContentReadGrant,
	buildCacheGrant,
	buildViewContentReadGrant,
	collectSubstitutions,
	jobWorkflowReferenceClaim
} from '../oidc-trust/rule-builder.ts';
import { type ReuseViewClient } from '../reuse-view.ts';

import { activeMatcherRules, type GithubCheckClient } from './check.ts';
import { githubActionsIssuer } from './claims.ts';
import {
	parseExactWorkflowReference,
	parseWorkflowReference,
	pullRequestCachePrefix,
	pullRequestViewName,
	workflowReferenceClaimsOverlap
} from './convention.ts';
import { isDeepEqual } from './deep-equal.ts';
import {
	canMatchRepositoryRun,
	checkView,
	type DiscoveredGithubCheckDependencies,
	type DiscoveredGithubCheckResult,
	finishDiscoveredGithubCheck,
	inspectDiscoveredGithubCheck,
	isRepairOffered
} from './discovered-check.ts';
import {
	cupboardRepository,
	type DiscoveredPublishingJob,
	discoverPublishingJobs,
	githubWorkflowSource,
	type UnverifiedJobWorkflow,
	type WorkflowDiscovery
} from './discovery.ts';
import {
	type CheckStatus,
	ReadAuthenticationUnverifiedFinding,
	ReuseViewMissingFinding
} from './finding.ts';
import {
	isPresetJob,
	jobCache,
	modelPublishingJob,
	type PublicationCase,
	type ReuseViewRequirement,
	withMergedCloseCases
} from './publication.ts';
import {
	type PublicationReadAuthority,
	publicationReadAuthority
} from './read-authority.ts';
import { checkPublicationTrust } from './release-authority.ts';
import {
	AmbiguousTrustRulesFinding,
	describeAuthorizationDetail,
	TrustRuleGrantMissingFinding
} from './trust-selection.ts';
import { verifyWorkflowReference } from './workflow-reference.ts';

export type GithubRepairProblem =
	| 'no-repairable-job'
	| 'unverified-reference'
	| 'unmodelled-job'
	| 'unresolved-input'
	| 'unsupported-rule'
	| 'unauthorised-plan'
	| 'custom-view'
	| 'drifted-view'
	| 'no-change'
	| 'unmerged-branch'
	| 'view-access'
	| 'existing-rule';

export class GithubRepairUnavailableError extends CliError {
	override readonly humanMessage: string;

	constructor(
		public readonly problem: GithubRepairProblem,
		public readonly reason: string
	) {
		super(`Cannot repair this configuration automatically: ${reason}`);
		this.name = 'GithubRepairUnavailableError';
		this.humanMessage = this.message;
	}
}

/**
 * How a planned rule could stop an existing rule from authorising another
 * job's runs. `ungranted`: the server would select the planned rule, which
 * does not grant the job's requests. `ambiguous`: the planned rule and an
 * existing rule would both match with as many claims and permit the same
 * request. `unmodelled`: the check cannot model the job, and a planned rule
 * could match its runs with at least as many claims as an existing rule.
 */
export type GithubRepairShadow = 'ungranted' | 'ambiguous' | 'unmodelled';

function shadowReason(
	shadow: GithubRepairShadow,
	job: string,
	trigger: string | undefined,
	rules: readonly string[]
): string {
	const existing = rules.join(', ');

	switch (shadow) {
		case 'ungranted': {
			return `a planned rule would be selected in place of ${existing} for ${trigger ?? 'the'} runs of ${job}, and the planned rule does not grant what that job requests.`;
		}
		case 'ambiguous': {
			return `a planned rule and ${existing} would both match ${trigger ?? 'the'} runs of ${job} with as many claims, so an exchange without explicit grants would be ambiguous.`;
		}
		case 'unmodelled': {
			return `the check cannot model ${job}, and a planned rule could match its runs with at least as many claims as ${existing}, which may authorise those runs now.`;
		}
	}
}

/**
 * The server selects the matching rule with the most claims. A planned rule
 * can therefore replace the rule that another job currently uses.
 */
function humanShadowReason(
	shadow: GithubRepairShadow,
	job: string,
	trigger: string | undefined,
	rules: readonly string[]
): string {
	const existing = rules.join(', ');
	if (shadow === 'ungranted') {
		return `The proposed permissions would prevent ${job} from accessing Cupboard for ${trigger ?? 'its'} runs. Existing rules: ${existing}. Review the job permissions and change the configuration by hand.`;
	}
	if (shadow === 'ambiguous') {
		return `The proposed rule would conflict with existing rules ${existing} for ${job}. Review their identity restrictions and permissions, then change the configuration by hand.`;
	}
	return `The check could not verify ${job}. The proposed rule might replace access from existing rules ${existing}. Inspect the job and change the configuration by hand.`;
}

export class GithubRepairShadowsRuleError extends CliError {
	override readonly humanMessage: string;

	constructor(
		public readonly shadow: GithubRepairShadow,
		public readonly job: string,
		public readonly trigger: string | undefined,
		public readonly rules: readonly string[]
	) {
		super(
			`Cannot repair this configuration automatically: ${shadowReason(shadow, job, trigger, rules)} Change the configuration by hand.`
		);
		this.name = 'GithubRepairShadowsRuleError';
		this.humanMessage = humanShadowReason(shadow, job, trigger, rules);
	}
}

export class GithubRepairStateChangedError extends CliError {
	override readonly humanMessage: string;

	constructor() {
		super(
			'The repository or tenant configuration changed during review. Run cupboard github check again to review a new repair.'
		);
		this.name = 'GithubRepairStateChangedError';
		this.humanMessage = this.message;
	}
}

export class GithubRepairPartialError extends CliError {
	override readonly humanMessage: string;

	constructor(
		public readonly step: string,
		public readonly applied: readonly string[],
		cause: unknown,
		public readonly isUnconfirmed = false
	) {
		const reason =
			cause instanceof GithubCheckFailedError
				? 'After the writes, the check still reports failed publishing jobs.'
				: cause instanceof GithubCheckIncompleteError
					? 'After the writes, the check still reports unverified publishing jobs.'
					: `Could not ${step}.`;

		super(
			`${isUnconfirmed ? `Could not confirm the attempt to ${step}. The attempted write may have completed.` : reason} ${applied.length === 0 ? 'No writes were confirmed.' : `Applied: ${applied.join(', ')}.`} Run cupboard github check again before you retry the repair.`,
			{ cause }
		);
		this.name = 'GithubRepairPartialError';
		this.humanMessage = this.message;
	}

	override get exitCode(): number {
		if (isAbortError(this.cause)) {
			return 130;
		}

		if (!this.isUnconfirmed) {
			return genericExitCode;
		}

		return classifyFailures([this.cause], genericExitCode).exitCode;
	}
}

function isValidatedWriteRefusal(error: unknown): boolean {
	return (
		(error instanceof ORPCError || error instanceof CupboardHttpError) &&
		[400, 401, 403, 404, 409, 422].includes(error.status)
	);
}

export const githubTrustScopes = ['exact', 'tag-pattern'] as const;
export type GithubTrustScope = (typeof githubTrustScopes)[number];

export interface GithubRepairOptions {
	/**
	 * With `--yes`, the repair writes without a prompt. Anyone who can push to
	 * the repository can change the workflow files on a branch other than the
	 * default branch, so the repair returns an error for rules taken from such
	 * a branch.
	 */
	readonly yes?: boolean;
	readonly allowBranchWorkflow?: boolean;
	readonly trustScope?: GithubTrustScope;
	readonly tagPattern?: string;
	readonly readUser?: string;
}

type ReuseViewSetInput = Parameters<ReuseViewClient['set']>[0];

export interface GithubRepairClient extends GithubCheckClient {
	readonly reuseViews: GithubCheckClient['reuseViews'] & {
		set(input: ReuseViewSetInput): ReturnType<ReuseViewClient['set']>;
	};
	readonly oidcTrust: GithubCheckClient['oidcTrust'] & {
		add(input: OidcTrustAddBodyInput): Promise<OidcTrustSummary>;
		extend(
			input: OidcTrustExtendBodyInput & { readonly id: string }
		): Promise<OidcTrustSummary>;
	};
}

interface PlannedExtension {
	readonly expected: OidcTrustSummary;
	readonly permittedGrants: OidcTrustAddBodyInput['permittedGrants'];
	readonly rule: OidcTrustSummary;
}

interface PlannedView {
	readonly input: ReuseViewSetInput;
	readonly destinationUrl: URL;
	readonly destination: CacheInfo;
}

interface ModelledCase {
	readonly job: DiscoveredPublishingJob;
	readonly publication: PublicationCase;
	readonly read: PublicationReadAuthority;
	readonly needsTrustRule: boolean;
}

const cancelledMessage = 'Repair cancelled. The tenant is unchanged.';

function jobLabel(job: {
	readonly caller: string;
	readonly job: string;
}): string {
	return `${job.caller}, ${job.job}`;
}

function repairReference(
	job: DiscoveredPublishingJob,
	scope: GithubTrustScope,
	pattern: string
): string {
	const parsed = parseWorkflowReference(job.workflowRef);

	if (scope === 'exact') {
		return job.workflowRef;
	}

	if (parsed.pin.kind === 'commit' || parsed.pin.kind === 'branch') {
		throw new GithubCheckOptionError(
			'A rule for a commit or branch workflow cannot use a release tag pattern. Choose --trust-scope exact.'
		);
	}

	return `${parsed.owner}/${parsed.repo}/${parsed.path}@refs/tags/${pattern}`;
}

function additionalReadGrants(
	read: PublicationReadAuthority
): OidcTrustAddBodyInput['permittedGrants'] {
	return read.additionalCaches
		.filter(({ access }) => access === 'private')
		.map(({ cache }) =>
			buildCacheContentReadGrant({
				...(cache.kind === 'named' && { cache: cache.name })
			})
		);
}

function withAdditionalReadGrants(
	body: OidcTrustAddBodyInput,
	read: PublicationReadAuthority
): OidcTrustAddBodyInput {
	return {
		...body,
		permittedGrants: [...body.permittedGrants, ...additionalReadGrants(read)]
	};
}

function withModelledPrPublicationGrants(
	body: OidcTrustAddBodyInput,
	publication: PublicationCase
): OidcTrustAddBodyInput {
	const requested = new Set<CacheOperation>(
		publication.requests.flatMap((request) =>
			request.flatMap((detail) =>
				detail.type === 'cupboard_cache' ? detail.actions : []
			)
		)
	);

	return {
		...body,
		permittedGrants: body.permittedGrants.flatMap((grant) => {
			if (
				grant.type !== 'cupboard_cache' ||
				grant.actions.includes('cache:content-read')
			) {
				return [grant];
			}

			const actions = grant.actions.filter((action) => requested.has(action));

			if (actions.length === 0) {
				return [];
			}

			return [
				{
					...grant,
					actions,
					resources: {
						cache: grant.resources.cache,
						...(actions.some((action) => isRootOperation(action)) && {
							root: grant.resources.root
						})
					}
				}
			];
		})
	};
}

// See installableRequests for why every push requests the attestation
// operations, including a push from a job that skips signing.
function grantsForJob(
	job: DiscoveredPublishingJob,
	publication: PublicationCase,
	read: PublicationReadAuthority
): OidcTrustAddBodyInput['permittedGrants'] {
	const cache =
		publication.cache === undefined
			? jobCache(job)
			: { outcome: 'resolved' as const, scope: publication.cache };

	if (cache.outcome === 'unresolved') {
		throw new GithubRepairUnavailableError(
			'unresolved-input',
			`${jobLabel(job)}: ${cache.reason}`
		);
	}

	if (publication.lifecycle === 'closed') {
		return [
			buildCacheGrant({
				...(cache.scope.kind === 'named' && { cache: cache.scope.name }),
				allow: ['close']
			})
		];
	}

	const root =
		publication.rootPrefix ??
		job.inputs[job.kind === 'flake' ? 'root-prefix' : 'root'];

	if (typeof root !== 'string' && root !== undefined) {
		throw new GithubRepairUnavailableError(
			'unresolved-input',
			`${jobLabel(job)} has a dynamic root input`
		);
	}

	const hasRoot = root !== undefined && root !== '';
	const requiresAttach = publication.requests.some((request) =>
		request.some(
			(detail) =>
				detail.type === 'cupboard_cache' &&
				detail.actions.includes('root:attach')
		)
	);

	return [
		...(publication.requests.length > 0
			? [
					buildCacheGrant({
						...(cache.scope.kind === 'named' && { cache: cache.scope.name }),
						...(publication.releaseRootTemplate === undefined
							? hasRoot && { root: `${root.replace(/\/$/u, '')}/` }
							: {
									rootTemplate: publication.releaseRootTemplate,
									substitutions: collectSubstitutions({
										templateSource: 'github-tag',
										captures: []
									})
								}),
						allow: [
							'push',
							'attest',
							...(hasRoot || job.kind === 'flake' ? ['root'] : []),
							...(requiresAttach || job.kind === 'flake' ? ['attach'] : [])
						]
					})
				]
			: []),
		...(read.cacheAccess === 'private' && read.cacheWiring === 'none'
			? [
					buildCacheContentReadGrant({
						...(read.cache.kind === 'named' && { cache: read.cache.name })
					})
				]
			: []),
		...(publication.reuseView !== undefined &&
		read.viewAccess === 'private' &&
		read.viewWiring === 'none'
			? [buildViewContentReadGrant(publication.reuseView.name)]
			: []),
		...additionalReadGrants(read)
	];
}

function triggerClaim(
	job: DiscoveredPublishingJob,
	publication: PublicationCase
): OidcTrustAddBodyInput['claims'] {
	if (publication.trigger === 'release') {
		return { event_name: 'release', ref_type: 'tag' };
	}
	if (publication.trigger === 'pull_request') {
		if (
			publication.requests.length === 0 ||
			publication.lifecycle === 'closed' ||
			publication.pullRequestTemplates !== undefined
		) {
			return { event_name: 'pull_request' };
		}

		throw new GithubRepairUnavailableError(
			'unsupported-rule',
			`pull-request runs of ${jobLabel(job)} publish to the cache and root of its branch runs`
		);
	}

	if (publication.ref.kind === 'tag') {
		return { ref: publication.ref.pattern.claim('refs/tags/') };
	}

	return { ref: `refs/heads/${publication.ref.name}` };
}

function bodyForCase(
	url: URL,
	result: DiscoveredGithubCheckResult,
	job: DiscoveredPublishingJob,
	publication: PublicationCase,
	read: PublicationReadAuthority,
	reference: string
): OidcTrustAddBodyInput {
	const isPreset = isPresetJob(job);
	const audience = audienceSchema.parse(publication.claims.aud);

	if (publication.lifecycle === 'merged-close') {
		return githubPrCloseAddBody(url, result.identity, {
			repo: result.identity.fullName,
			audience,
			jobWorkflowRef: reference,
			allowBranchWorkflow: true,
			...(publication.pullRequestTemplates === undefined
				? !isPreset &&
					read.cache.kind === 'named' && { cacheTemplate: read.cache.name }
				: { cacheTemplate: publication.pullRequestTemplates.cache })
		});
	}

	if (publication.requests.length === 0) {
		return buildAddBody({
			issuer: githubActionsIssuer,
			audience,
			claims: {
				repository_id: String(result.identity.repositoryId),
				repository_owner_id: String(result.identity.repositoryOwnerId),
				...triggerClaim(job, publication),
				job_workflow_ref: jobWorkflowReferenceClaim(reference)
			},
			permittedGrants: grantsForJob(job, publication, read),
			display: { provider: 'github', repository: result.identity.fullName }
		});
	}

	if (
		publication.trigger === 'pull_request' &&
		(isPreset || publication.pullRequestTemplates !== undefined)
	) {
		return withAdditionalReadGrants(
			withModelledPrPublicationGrants(
				githubPrAddBody(url, result.identity, {
					repo: result.identity.fullName,
					audience,
					jobWorkflowRef: reference,
					allowBranchWorkflow: true,
					...(publication.pullRequestTemplates !== undefined && {
						cacheTemplate: publication.pullRequestTemplates.cache,
						rootTemplate: publication.pullRequestTemplates.root
					}),
					readCache:
						read.cacheAccess === 'private' && read.cacheWiring === 'none'
				}),
				publication
			),
			read
		);
	}

	if (isPreset) {
		if (publication.ref.kind !== 'branch') {
			throw new GithubRepairUnavailableError(
				'unsupported-rule',
				`${publication.trigger} has no modelled branch ref`
			);
		}

		return withAdditionalReadGrants(
			githubBranchAddBody(url, result.identity, {
				repo: result.identity.fullName,
				audience,
				branch: publication.ref.name,
				jobWorkflowRef: reference,
				allowBranchWorkflow: true,
				readCache:
					read.cacheAccess === 'private' && read.cacheWiring === 'none',
				...(publication.reuseView !== undefined &&
					read.viewAccess === 'private' &&
					read.viewWiring === 'none' && {
						readView: publication.reuseView.name
					})
			}),
			read
		);
	}

	return buildAddBody({
		issuer: githubActionsIssuer,
		audience,
		claims: {
			repository_id: String(result.identity.repositoryId),
			repository_owner_id: String(result.identity.repositoryOwnerId),
			...triggerClaim(job, publication),
			job_workflow_ref: jobWorkflowReferenceClaim(reference)
		},
		permittedGrants: grantsForJob(job, publication, read),
		display: { provider: 'github', repository: result.identity.fullName }
	});
}

function isSameBody(
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

function mergeBodies(
	bodies: readonly OidcTrustAddBodyInput[]
): OidcTrustAddBodyInput[] {
	const merged = new Map<string, OidcTrustAddBodyInput>();

	for (const body of bodies) {
		const key = JSON.stringify({
			issuer: body.issuer,
			audience: body.audience,
			claims: body.claims
		});
		const previous = merged.get(key);

		if (previous === undefined) {
			merged.set(key, body);
			continue;
		}

		const grants = [...previous.permittedGrants];

		for (const grant of body.permittedGrants) {
			if (
				grants.every(
					(candidate) => JSON.stringify(candidate) !== JSON.stringify(grant)
				)
			) {
				grants.push(grant);
			}
		}

		merged.set(key, { ...previous, permittedGrants: grants });
	}

	return merged.values().toArray();
}

function claimSummary(
	value: OidcTrustAddBodyInput['claims'][string] | undefined
): string {
	if (value === undefined) {
		return '(any)';
	}

	return typeof value === 'string' ? value : `pattern ${value.pattern}`;
}

function uniqueViews(
	modelled: readonly ModelledCase[]
): ReuseViewRequirement[] {
	const views = new Map<string, ReuseViewRequirement>();

	for (const { publication } of modelled) {
		const view = publication.reuseView;

		if (view !== undefined) {
			views.set(`${view.name} ${view.destination.href}`, view);
		}
	}

	return views.values().toArray();
}

/**
 * Finishes a check in discovery mode. With `--fix`, or when an interactive operator
 * accepts the offer, the repair runs and its result determines the exit
 * status. Otherwise the command exits unsuccessfully if the check reported a
 * failed or unverified job.
 */
export async function offerDiscoveredGithubRepair(
	result: DiscoveredGithubCheckResult,
	ui: CliUi,
	isFixRequested: boolean,
	repair: () => Promise<void>
): Promise<void> {
	if (
		isFixRequested ||
		(ui.interactive &&
			isRepairOffered(result) &&
			(await ui.confirm({
				message: 'Review a repair for the reported failures?'
			})) === 'yes')
	) {
		await repair();
		return;
	}

	finishDiscoveredGithubCheck(result);
}

function tagPatternProblem(value: string): string | undefined {
	if (value === '') {
		return 'Enter a release tag pattern.';
	}

	try {
		parseWorkflowReference(
			`underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/${value}`
		);
	} catch (error) {
		if (error instanceof WorkflowReferenceTagPatternError) {
			return 'Use letters, digits, ., _, -, / and single * wildcards.';
		}

		throw error;
	}

	return undefined;
}

async function pullRequestCaches(
	client: GithubCheckClient,
	repositoryId: number
): Promise<CacheListEntry[]> {
	const prefix = pullRequestCachePrefix(repositoryId);
	const caches: CacheListEntry[] = [];
	let cursor: string | undefined;

	do {
		const page = await client.caches.list({ namePrefix: prefix, cursor });

		caches.push(...page.caches);
		cursor = page.cursor;
	} while (cursor !== undefined);

	return caches.filter(
		(cache) =>
			cache.scope.kind === 'named' && cache.scope.name.startsWith(prefix)
	);
}

interface CheckedBranch {
	readonly branch: string;
	readonly discovery: WorkflowDiscovery;
}

function claimCount(rule: Pick<OidcTrustRule, 'claims'>): number {
	return Object.keys(rule.claims).length;
}

function canClaimsOverlap(left: ClaimMatch, right: ClaimMatch): boolean {
	if (typeof left === 'string') {
		return isClaimSatisfied(right, left);
	}

	if (typeof right === 'string') {
		return isClaimSatisfied(left, right);
	}

	return true;
}

// Two patterns for the same claim are assumed to overlap.
function canMatchOneRun(left: OidcTrustRule, right: OidcTrustRule): boolean {
	return (
		left.issuer === right.issuer &&
		left.audience === right.audience &&
		Object.entries(left.claims).every(([claim, value]) => {
			const other = right.claims[claim];

			return other === undefined || canClaimsOverlap(value, other);
		})
	);
}

/**
 * Whether a planned rule could match a run of an unverified job. Planned rules
 * always specify a Cupboard publishing workflow in `job_workflow_ref`.
 */
function canPlannedRuleMatch(
	rule: OidcTrustRule,
	identity: DiscoveredGithubCheckResult['identity'],
	workflow: UnverifiedJobWorkflow,
	workflowReference: string | undefined
): boolean {
	const claim = rule.claims.job_workflow_ref;

	if (claim === undefined) {
		return true;
	}

	switch (workflow) {
		case 'cupboard': {
			return (
				workflowReference === undefined ||
				isClaimSatisfied(claim, workflowReference)
			);
		}
		case 'repository': {
			return identity.fullName.toLowerCase() === cupboardRepository;
		}
		case 'external': {
			return false;
		}
		case 'unknown': {
			return true;
		}
	}
}

function checkUnmodelledJob(
	job: string,
	identity: DiscoveredGithubCheckResult['identity'],
	existing: readonly OidcTrustRule[],
	planned: readonly OidcTrustRule[],
	workflow: UnverifiedJobWorkflow,
	workflowReference: string | undefined
): void {
	const matching = planned.filter((rule) =>
		canPlannedRuleMatch(rule, identity, workflow, workflowReference)
	);
	const shadowed = existing.filter(
		(rule) =>
			canMatchRepositoryRun(
				rule,
				identity,
				workflow === 'cupboard' ? workflowReference : undefined
			) &&
			matching.some(
				(plannedRule) =>
					claimCount(rule) <= claimCount(plannedRule) &&
					canMatchOneRun(rule, plannedRule)
			)
	);

	if (shadowed.length > 0) {
		throw new GithubRepairShadowsRuleError(
			'unmodelled',
			job,
			undefined,
			shadowed.map((rule) => rule.id)
		);
	}
}

function checkModelledCase(
	job: string,
	publication: PublicationCase,
	read: PublicationReadAuthority,
	existing: readonly OidcTrustRule[],
	candidates: readonly OidcTrustRule[]
): CheckStatus {
	const { claims } = publication;
	const requests: readonly AuthorizationDetails[] = [
		...publication.requests,
		...read.requests
	];

	const current = checkPublicationTrust({
		check: 'current trust rules',
		publication,
		rules: existing,
		requests,
		resources: read.resources
	});

	if (current.status !== 'ok') {
		return current.status;
	}

	const finding = checkPublicationTrust({
		check: 'planned trust rules',
		publication,
		rules: candidates,
		requests,
		resources: read.resources
	});

	if (finding.status === 'ok') {
		return 'ok';
	}

	const selected = requests.flatMap((request) => {
		const selection = selectModelledOidcTrust(existing, claims, request);

		return selection.outcome === 'selected' && selection.rule !== undefined
			? [selection.rule.id]
			: [];
	});

	throw new GithubRepairShadowsRuleError(
		finding instanceof AmbiguousTrustRulesFinding ? 'ambiguous' : 'ungranted',
		job,
		publication.trigger,
		[...new Set(selected)]
	);
}

/**
 * The server selects the matching rule with the most claims, so a planned rule
 * can replace the rule that another job currently uses. Check the planned
 * rules against every discovered job outside the repair. A job that the check
 * models exactly must keep passing. For any other job, the repair stops when a
 * planned rule could match its runs with at least as many claims as an
 * existing rule that could also match them.
 */
async function checkPlannedRulesKeepOtherJobs(
	url: URL,
	result: DiscoveredGithubCheckResult,
	branches: readonly CheckedBranch[],
	existing: readonly OidcTrustRule[],
	planned: readonly OidcTrustRule[],
	client: GithubCheckClient,
	dependencies: DiscoveredGithubCheckDependencies
): Promise<void> {
	const repaired = new Set(result.repairableJobs);
	const candidates = [
		...existing.filter((rule) =>
			planned.every((candidate) => candidate.id !== rule.id)
		),
		...planned
	];

	for (const { branch, discovery } of branches) {
		for (const job of discovery.jobs) {
			if (repaired.has(job)) {
				continue;
			}

			const model = modelPublishingJob(job, result.identity, url, branch);
			const isExact =
				model.cases.length > 0 &&
				model.findings.every(({ finding }) => finding.status === 'ok');

			if (!isExact) {
				checkUnmodelledJob(
					jobLabel(job),
					result.identity,
					existing,
					planned,
					'cupboard',
					job.workflowRef
				);
				continue;
			}

			for (const publication of withMergedCloseCases(
				model.cases,
				result.identity
			)) {
				const read = await publicationReadAuthority(
					job,
					publication,
					url,
					result.identity.repositoryId,
					client,
					dependencies.fetchCacheAccess
				);
				const status = checkModelledCase(
					jobLabel(job),
					publication,
					read,
					existing,
					candidates
				);

				if (status === 'unverified') {
					checkUnmodelledJob(
						jobLabel(job),
						result.identity,
						existing,
						planned,
						'cupboard',
						job.workflowRef
					);
				}
			}
		}

		for (const entry of discovery.unverified) {
			checkUnmodelledJob(
				jobLabel(entry),
				result.identity,
				existing,
				planned,
				entry.workflow,
				entry.workflowRef
			);
		}
	}
}

/**
 * The server prefers a planned rule to an existing rule only when the planned
 * rule has more claims. When a matching rule without a required grant has at
 * least as many claims as the planned rule, the repair cannot fix the job by
 * adding a rule.
 */
function checkRetainedRules(
	url: URL,
	result: DiscoveredGithubCheckResult,
	job: DiscoveredPublishingJob,
	publication: PublicationCase,
	read: PublicationReadAuthority,
	finding: TrustRuleGrantMissingFinding
): void {
	const planned = bodyForCase(
		url,
		result,
		job,
		publication,
		read,
		job.workflowRef
	);
	const blocking = finding.rules.find(
		(rule) => claimCount(rule) >= claimCount(planned)
	);

	if (
		blocking === undefined ||
		(blocking.id !== 'owner' &&
			blocking.issuer === planned.issuer &&
			blocking.audience === planned.audience &&
			typeof blocking.claims.job_workflow_ref === 'string' &&
			isDeepEqual(blocking.claims, planned.claims))
	) {
		return;
	}

	const grant = describeAuthorizationDetail(finding.refused);

	throw new GithubRepairUnavailableError(
		'existing-rule',
		`trust rule ${blocking.id} matches ${publication.trigger} runs of ${jobLabel(job)} with at least as many claims as the planned rule, so the server would not prefer the planned rule to ${blocking.id}. ${blocking.id} does not permit ${grant}. Remove ${blocking.id}, or replace it with a rule that also grants ${grant}.`
	);
}

async function modelRepairableJobs(
	url: URL,
	result: DiscoveredGithubCheckResult,
	existing: ReturnType<typeof activeMatcherRules>,
	retainedGrantMissingRules: Set<string>,
	client: GithubCheckClient,
	dependencies: DiscoveredGithubCheckDependencies
): Promise<ModelledCase[]> {
	const modelled: ModelledCase[] = [];

	for (const job of result.repairableJobs) {
		const model = modelPublishingJob(job, result.identity, url, result.branch);

		if (
			model.cases.length === 0 ||
			model.findings.some(({ finding }) => finding.status !== 'ok')
		) {
			throw new GithubRepairUnavailableError(
				'unmodelled-job',
				`${jobLabel(job)} has inputs or events that cannot be modelled`
			);
		}

		for (const publication of withMergedCloseCases(
			model.cases,
			result.identity
		)) {
			const read = await publicationReadAuthority(
				job,
				publication,
				url,
				result.identity.repositoryId,
				client,
				dependencies.fetchCacheAccess
			);
			const finding = checkPublicationTrust({
				check: 'current trust rules',
				publication,
				rules: existing,
				requests: [...publication.requests, ...read.requests],
				resources: read.resources
			});

			if (finding instanceof TrustRuleGrantMissingFinding) {
				checkRetainedRules(url, result, job, publication, read, finding);

				for (const rule of finding.rules) {
					retainedGrantMissingRules.add(rule.id);
				}
			}

			modelled.push({
				job,
				publication,
				read,
				needsTrustRule: finding.status !== 'ok'
			});
		}
	}

	return modelled;
}

export async function runDiscoveredGithubRepair(
	url: URL,
	options: GithubRepairOptions,
	ui: CliUi,
	client: GithubRepairClient,
	dependencies: DiscoveredGithubCheckDependencies,
	result: DiscoveredGithubCheckResult
): Promise<void> {
	if (result.jobs.every((job) => job.status === 'ready')) {
		ui.info('The discovered publishing jobs already pass.');
		return;
	}

	if (!isRepairOffered(result)) {
		if (result.jobs.every((job) => job.status !== 'failed')) {
			throw new GithubCheckIncompleteError(
				result.jobs
					.filter((job) => job.status === 'unverified')
					.map((job) => jobLabel(job))
			);
		}

		throw new GithubRepairUnavailableError(
			'no-repairable-job',
			'every failed or unverified publishing job needs manual review'
		);
	}

	for (const job of result.repairableJobs) {
		if (
			parseExactWorkflowReference(job.workflowRef).pin.kind === 'branch' &&
			options.allowBranchWorkflow !== true
		) {
			throw new GithubCheckOptionError(
				'A branch workflow can change after review. Pass --allow-branch-workflow to accept future edits to that workflow.'
			);
		}

		if (!result.verifiedWorkflowReferences.has(job.workflowRef)) {
			throw new GithubRepairUnavailableError(
				'unverified-reference',
				`${job.workflowRef} was not verified by the check`
			);
		}
	}

	const lookupOptions =
		dependencies.signal === undefined ? {} : { signal: dependencies.signal };

	const [listed, views] = await Promise.all([
		client.oidcTrust.list(),
		client.reuseViews.list()
	]);
	const existing = activeMatcherRules(listed.rules);
	const retainedGrantMissingRules = new Set<string>();
	const modelled = await modelRepairableJobs(
		url,
		result,
		existing,
		retainedGrantMissingRules,
		client,
		dependencies
	);
	const requiresNewTrustRule = modelled.some((item) => item.needsTrustRule);

	if (!requiresNewTrustRule && options.trustScope === 'tag-pattern') {
		throw new GithubCheckOptionError(
			'The repair adds no trust rule. Omit --trust-scope tag-pattern.'
		);
	}

	const hasNonTagPin = modelled.some(
		(item) =>
			item.needsTrustRule &&
			parseExactWorkflowReference(item.job.workflowRef).pin.kind !== 'tag'
	);

	let scope = requiresNewTrustRule ? options.trustScope : 'exact';

	if (requiresNewTrustRule && scope === undefined && ui.interactive) {
		const choices: MenuEntry<GithubTrustScope>[] = [
			{ value: 'exact', label: 'Only the current Cupboard workflow pins' }
		];

		if (!hasNonTagPin) {
			choices.push({
				value: 'tag-pattern',
				label: 'Future Cupboard workflow release tags matching a pattern'
			});
		}

		scope = await ui.menu<GithubTrustScope>(
			'Which Cupboard workflow references should the new trust rules accept?',
			choices
		);
	}

	if (scope === undefined) {
		if (ui.interactive) {
			ui.cancelled(cancelledMessage);
			finishDiscoveredGithubCheck(result);
			return;
		}

		throw new GithubCheckOptionError(
			'Choose --trust-scope exact or --trust-scope tag-pattern.'
		);
	}

	if (scope === 'tag-pattern' && hasNonTagPin) {
		throw new GithubCheckOptionError(
			'A commit or branch workflow cannot use a release tag pattern. Choose --trust-scope exact.'
		);
	}

	let pattern = options.tagPattern;

	if (scope === 'tag-pattern' && pattern === undefined && ui.interactive) {
		pattern = await ui.prefixedText({
			message: 'Cupboard workflow release tag pattern for the new trust rules',
			prefix: 'refs/tags/',
			problem: (value) => tagPatternProblem(value)
		});
	}

	if (scope === 'tag-pattern' && pattern === undefined) {
		if (ui.interactive) {
			ui.cancelled(cancelledMessage);
			finishDiscoveredGithubCheck(result);
			return;
		}

		throw new GithubCheckOptionError(
			'Specify --tag-pattern <glob> with --trust-scope tag-pattern.'
		);
	}

	if (scope === 'exact' && pattern !== undefined) {
		throw new GithubCheckOptionError(
			'--tag-pattern requires --trust-scope tag-pattern.'
		);
	}

	pattern ??= '';
	const desired: OidcTrustAddBodyInput[] = [];

	for (const { job, publication, read, needsTrustRule } of modelled) {
		if (!needsTrustRule) {
			continue;
		}

		const reference = repairReference(job, scope, pattern);
		const parsed = parseWorkflowReference(reference);

		if (
			parsed.pin.kind === 'tag-pattern' &&
			!workflowReferenceClaimsOverlap(
				job.workflowRef,
				jobWorkflowReferenceClaim(reference)
			)
		) {
			throw new GithubCheckOptionError(
				`--tag-pattern ${pattern} does not match ${job.workflowRef}.`
			);
		}

		desired.push(bodyForCase(url, result, job, publication, read, reference));
	}

	const additions: OidcTrustAddBodyInput[] = [];
	const extensions: PlannedExtension[] = [];

	for (const body of mergeBodies(desired)) {
		if (listed.rules.some((rule) => !rule.disabled && isSameBody(rule, body))) {
			continue;
		}

		const matching = listed.rules.filter(
			(rule) =>
				!rule.disabled &&
				rule.issuer === body.issuer &&
				rule.audience === body.audience &&
				isDeepEqual(rule.claims, body.claims)
		);

		if (matching.length === 0) {
			additions.push(body);
			continue;
		}

		const expected = matching[0];

		if (
			expected === undefined ||
			matching.length !== 1 ||
			expected.id === 'owner' ||
			typeof expected.claims.job_workflow_ref !== 'string'
		) {
			throw new GithubRepairUnavailableError(
				'existing-rule',
				'the matching rules do not identify one exact workflow rule that can be extended safely'
			);
		}

		const permittedGrants = body.permittedGrants.filter((grant) =>
			expected.permittedGrants.every(
				(candidate) => !isDeepEqual(candidate, grant)
			)
		);
		if (permittedGrants.length === 0) {
			continue;
		}

		extensions.push({
			expected,
			permittedGrants,
			rule: {
				...expected,
				permittedGrants: [...expected.permittedGrants, ...permittedGrants]
			}
		});
		retainedGrantMissingRules.delete(expected.id);
	}

	const planned = activeMatcherRules([
		...extensions.map((extension) => extension.rule),
		...additions.map((body, index) =>
			oidcTrustSummarySchema.parse({
				...body,
				id: `planned rule ${String(index + 1)}`,
				disabled: false
			})
		)
	]);

	const candidates = [
		...existing.filter((rule) =>
			planned.every((candidate) => candidate.id !== rule.id)
		),
		...planned
	];

	for (const item of modelled) {
		const finding = checkPublicationTrust({
			check: 'planned trust rules',
			publication: item.publication,
			rules: candidates,
			requests: [...item.publication.requests, ...item.read.requests],
			resources: item.read.resources
		});

		if (finding.status !== 'ok') {
			throw new GithubRepairUnavailableError(
				'unauthorised-plan',
				finding.detail() ??
					'the planned rules do not authorise a publishing job'
			);
		}
	}

	const source = dependencies.source ?? githubWorkflowSource(lookupOptions);
	const branches: CheckedBranch[] = [
		{ branch: result.branch, discovery: result.discovery }
	];

	if (
		result.branch !== result.identity.defaultBranch &&
		planned.some(
			(rule) =>
				rule.claims.ref === `refs/heads/${result.identity.defaultBranch}`
		)
	) {
		branches.push({
			branch: result.identity.defaultBranch,
			discovery: await discoverPublishingJobs(
				result.identity.fullName,
				result.identity.defaultBranch,
				url,
				source
			)
		});
	}

	await checkPlannedRulesKeepOtherJobs(
		url,
		result,
		branches,
		existing,
		planned,
		client,
		dependencies
	);

	const presetViewName = pullRequestViewName(result.identity.repositoryId);
	const missingViews: PlannedView[] = [];

	for (const view of uniqueViews(modelled)) {
		const finding = await checkView(
			url,
			view,
			result.identity,
			client,
			dependencies.fetchCacheInfo
		);

		if (view.name !== presetViewName) {
			if (finding.status === 'ok') {
				continue;
			}

			throw new GithubRepairUnavailableError(
				'custom-view',
				`reuse view ${view.name} needs an operator to choose its selectors: ${finding.detail() ?? finding.status}`
			);
		}

		const selectedAccess = [
			...new Set(
				modelled.flatMap(({ publication, read }) =>
					publication.reuseView?.name === view.name &&
					read.selectedViewAccess !== undefined
						? [read.selectedViewAccess]
						: []
				)
			)
		];

		if (selectedAccess.length !== 1) {
			throw new GithubRepairUnavailableError(
				'view-access',
				`the jobs do not select one access mode for reuse view ${view.name}`
			);
		}

		const access = selectedAccess[0];

		if (access === undefined) {
			throw new GithubRepairUnavailableError(
				'view-access',
				`the access mode of reuse view ${view.name} is unknown`
			);
		}

		const existingView = views.views.find((entry) => entry.name === view.name);

		if (existingView !== undefined && existingView.access !== access) {
			throw new GithubRepairUnavailableError(
				'view-access',
				`reuse view ${view.name} is ${existingView.access}, but the jobs select ${access}`
			);
		}

		if (finding.status === 'ok') {
			continue;
		}

		if (!(finding instanceof ReuseViewMissingFinding)) {
			throw new GithubRepairUnavailableError(
				'drifted-view',
				finding.detail() ??
					`reuse view ${view.name} differs from the expected configuration`
			);
		}

		const destination = await dependencies.fetchCacheInfo(view.destination);
		const caches = await pullRequestCaches(
			client,
			result.identity.repositoryId
		);
		const mismatched = caches.filter((cache) => cache.access !== access);

		if (mismatched.length > 0) {
			throw new GithubRepairUnavailableError(
				'view-access',
				`the pull-request caches ${mismatched.map((cache) => cacheLabel(cache.scope)).join(', ')} are not ${access}, and a ${access} view includes only ${access} caches; choose a matching cache-access-mode`
			);
		}

		missingViews.push({
			input: {
				name: reuseViewNameSchema.parse(view.name),
				access,
				selectors: [
					{
						kind: 'prefix',
						prefix: pullRequestCachePrefix(result.identity.repositoryId)
					}
				],
				priority: reuseViewPrioritySchema.parse(
					destination.priority + viewPriorityMargin
				)
			},
			destinationUrl: view.destination,
			destination
		});
	}

	const rows = [
		...[...retainedGrantMissingRules].map((id) => ({
			label: 'Keep existing rule',
			value: `${id} does not allow all actions needed by the discovered jobs. The repair adds a more specific rule for those jobs. ${id} remains active for other matching runs. Review the new permissions below.`
		})),
		...extensions.flatMap(({ expected, permittedGrants }) => [
			{
				label: 'Extend existing rule',
				value: `${expected.id}: keep its identity restrictions and existing permissions; add the permissions below`
			},
			...Object.entries(expected.claims).map(([claim, value]) => ({
				label: `Claim ${claim}`,
				value: claimSummary(value)
			})),
			...expected.permittedGrants.flatMap((grant, index) =>
				trustGrantRows(grant, `Keep grant ${String(index + 1)}`)
			),
			...permittedGrants.flatMap((grant, index) =>
				trustGrantRows(grant, `Add grant ${String(index + 1)}`)
			)
		]),
		...additions.flatMap((body, index) => {
			const number = index + 1;
			const trigger =
				body.claims.event_name === 'pull_request'
					? body.claims.ref === undefined
						? 'any pull request'
						: `pull request with ref ${claimSummary(body.claims.ref)}`
					: `ref ${claimSummary(body.claims.ref)}`;
			const workflow =
				typeof body.claims.job_workflow_ref === 'string'
					? body.claims.job_workflow_ref
					: `Cupboard workflow release tags ${pattern}`;

			return [
				{
					label: `Add planned rule ${String(number)}`,
					value: `repository ID ${claimSummary(body.claims.repository_id)}, ${trigger}; workflow ${workflow}`
				},
				...body.permittedGrants.flatMap((grant, grantIndex) =>
					trustGrantRows(
						grant,
						`Grant ${String(number)}.${String(grantIndex + 1)}`
					)
				)
			];
		}),
		...missingViews.map(({ input }) => ({
			label: 'Create reuse view',
			value: `${input.name}: ${input.access} view over caches with prefix ${pullRequestCachePrefix(result.identity.repositoryId)}, priority ${String(input.priority)}`
		}))
	];

	if (rows.length === 0) {
		throw new GithubRepairUnavailableError(
			'no-change',
			'the failures need manual review; the repair has no tenant change to make'
		);
	}

	rows.push({
		label: 'Checked jobs',
		value: `The repair checked the planned rules against the discovered jobs on ${branches.map(({ branch }) => branch).join(' and ')}. It does not read workflow files at tags or on other branches.`
	});

	const isUnmergedBranch = result.branch !== result.identity.defaultBranch;

	if (isUnmergedBranch && (options.yes === true || !ui.interactive)) {
		throw new GithubRepairUnavailableError(
			'unmerged-branch',
			`the planned rules come from workflow files on ${result.branch}, which is not the default branch ${result.identity.defaultBranch}; review the repair at a terminal without --yes`
		);
	}

	if (isUnmergedBranch) {
		rows.unshift({
			label: 'Unmerged workflows',
			value: `The planned rules come from workflow files on ${result.branch}, which is not the default branch ${result.identity.defaultBranch}. Anyone who can push to the repository can change those files.`
		});
	}

	if (
		modelled.some(
			({ job }) =>
				parseExactWorkflowReference(job.workflowRef).pin.kind === 'branch'
		)
	) {
		rows.push({
			label: 'Future workflow edits',
			value:
				'These rules accept future edits to the selected Cupboard workflow branches. The repair checks that each branch workflow exists again before writing.'
		});
	}

	if (ui.interactive) {
		ui.note('Planned GitHub repair', rows);
	} else {
		ui.reporter().result({
			kind: 'github-repair-plan',
			title: 'Planned GitHub repair',
			data: {
				rules: additions,
				extensions: extensions.map(({ expected, permittedGrants }) => ({
					id: expected.id,
					expected,
					permittedGrants
				})),
				retainedRuleIds: [...retainedGrantMissingRules],
				reuseViews: missingViews.map((view) => view.input)
			},
			rows
		});
	}

	if (
		(await ui.confirm({ message: 'Apply this tenant configuration?' })) !==
		'yes'
	) {
		ui.cancelled(cancelledMessage);
		finishDiscoveredGithubCheck(result);
		return;
	}

	const revisions = await Promise.all(
		branches.map(({ branch }) =>
			source.resolveBranch(result.identity.fullName, branch)
		)
	);
	const [currentRules, currentViews, currentIdentity] = await Promise.all([
		client.oidcTrust.list(),
		client.reuseViews.list(),
		(dependencies.lookupRepository ?? lookupRepository)(
			result.identity.fullName,
			{ ...lookupOptions, shouldRevalidate: true }
		)
	]);

	if (
		revisions.some(
			(revision, index) => revision !== branches[index]?.discovery.revision
		) ||
		!isDeepEqual(currentIdentity, result.identity) ||
		JSON.stringify(currentRules) !== JSON.stringify(listed) ||
		JSON.stringify(currentViews) !== JSON.stringify(views)
	) {
		throw new GithubRepairStateChangedError();
	}

	const freshSource =
		dependencies.source ??
		githubWorkflowSource({ ...lookupOptions, shouldRevalidate: true });

	for (const job of result.repairableJobs) {
		if (job.workflowRefInput === undefined) {
			continue;
		}

		if (freshSource.resolveWorkflowReference === undefined) {
			throw new GithubRepairStateChangedError();
		}

		const parsed = parseExactWorkflowReference(job.workflowRef);
		const bare = job.workflowRefInput.slice(
			job.workflowRefInput.lastIndexOf('@') + 1
		);
		const current = await freshSource.resolveWorkflowReference(
			`${parsed.owner}/${parsed.repo}`,
			bare
		);

		if (current !== parsed.pin.value) {
			throw new GithubRepairStateChangedError();
		}
	}

	const repairReferences = new Set(
		result.repairableJobs.map((job) => job.workflowRef)
	);

	for (const reference of repairReferences) {
		const parsed = parseExactWorkflowReference(reference);

		if (parsed.pin.kind === 'branch') {
			await (dependencies.verifyWorkflowReference ?? verifyWorkflowReference)(
				parsed,
				{ ...lookupOptions, allowBranchWorkflow: true, shouldRevalidate: true }
			);
		}
	}

	const applied: string[] = [];

	for (const { expected, permittedGrants } of extensions) {
		try {
			await client.oidcTrust.extend({
				id: expected.id,
				expected,
				permittedGrants
			});
		} catch (error) {
			const cause =
				(error instanceof ORPCError || error instanceof CupboardHttpError) &&
				error.status === 404
					? new GithubRepairUnavailableError(
							'existing-rule',
							'the server does not support atomic trust-rule grant extensions. Upgrade the server before retrying this repair.'
						)
					: error;

			const isRefused = isValidatedWriteRefusal(error);

			if (isRefused && applied.length === 0) {
				throw cause;
			}

			throw new GithubRepairPartialError(
				`extend trust rule ${expected.id}`,
				applied,
				cause,
				!isRefused
			);
		}

		applied.push(`extended trust rule ${expected.id}`);
	}

	for (const view of missingViews) {
		let isWriteAttempted = false;

		try {
			const destination = await dependencies.fetchCacheInfo(
				view.destinationUrl
			);

			if (destination.render() !== view.destination.render()) {
				throw new GithubRepairStateChangedError();
			}

			isWriteAttempted = true;
			await client.reuseViews.set(view.input);
		} catch (error) {
			const isUnconfirmed = isWriteAttempted && !isValidatedWriteRefusal(error);

			if (!isUnconfirmed && applied.length === 0) {
				throw error;
			}

			throw new GithubRepairPartialError(
				`create reuse view ${view.input.name}`,
				applied,
				error,
				isUnconfirmed
			);
		}

		applied.push(`reuse view ${view.input.name}`);
	}

	for (const [index, body] of additions.entries()) {
		let added: OidcTrustSummary;

		try {
			added = await client.oidcTrust.add(body);
		} catch (error) {
			const isUnconfirmed = !isValidatedWriteRefusal(error);

			if (!isUnconfirmed && applied.length === 0) {
				throw error;
			}

			throw new GithubRepairPartialError(
				`add trust rule ${String(index + 1)}`,
				applied,
				error,
				isUnconfirmed
			);
		}

		applied.push(`trust rule ${added.id}`);
	}

	let verified: DiscoveredGithubCheckResult;

	try {
		verified = await inspectDiscoveredGithubCheck(
			url,
			{
				repo: result.identity.fullName,
				branch: result.branch,
				...(options.readUser !== undefined && { readUser: options.readUser }),
				isVerification: true
			},
			ui.reporter(),
			client,
			dependencies
		);
	} catch (error) {
		if (isAbortError(error) && applied.length === 0) {
			throw error;
		}

		throw new GithubRepairPartialError(
			'verify the tenant after writing',
			applied,
			error
		);
	}

	const repaired = new Set(result.repairableJobs.map((job) => jobLabel(job)));
	const stillFailing = verified.jobs.filter(
		(job) =>
			repaired.has(jobLabel(job)) &&
			job.findings.some(
				({ finding }) =>
					finding.status !== 'ok' &&
					!(finding instanceof ReadAuthenticationUnverifiedFinding)
			)
	);
	const failed = stillFailing.filter((job) => job.status === 'failed');

	if (stillFailing.length > 0) {
		throw new GithubRepairPartialError(
			'verify the tenant after writing',
			applied,
			failed.length > 0
				? new GithubCheckFailedError(failed.map((job) => jobLabel(job)))
				: new GithubCheckIncompleteError(
						stillFailing.map((job) => jobLabel(job))
					)
		);
	}

	const isStaticReadUnverified = verified.jobs.some(
		(job) =>
			repaired.has(jobLabel(job)) &&
			job.findings.some(
				({ finding }) => finding instanceof ReadAuthenticationUnverifiedFinding
			)
	);
	ui.success(
		`Applied ${String(additions.length + extensions.length + missingViews.length)} tenant configuration change(s). ${isStaticReadUnverified ? 'The publication grants now pass, but the workflow read secrets remain unverified.' : 'The repaired publishing jobs now pass.'}`
	);
	finishDiscoveredGithubCheck(verified);
}
