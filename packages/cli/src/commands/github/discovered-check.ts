import { type CacheInfo } from '@cupboard/nix-store/cache-info';
import { type CacheAccessMode } from '@cupboard/nix-store/scalars';
import { canonicalHref } from '@cupboard/nix-store/url';
import { isGrantPermittedByRule } from '@cupboard/protocol/grant-match';
import {
	type AuthorizationDetails,
	isRootOperation
} from '@cupboard/protocol/grants';
import { type OidcTrustSummary } from '@cupboard/protocol/oidc';
import { selectModelledOidcTrust } from '@cupboard/protocol/oidc-trust-diagnostics';
import {
	isClaimSatisfied,
	type OidcTrustRule,
	preferredModelledOidcTrustRules
} from '@cupboard/protocol/oidc-trust-match';
import { type ReadResourceState } from '@cupboard/protocol/read-access';
import { type Reporter, type ResultRow } from '@cupboard/reporter';

import {
	GithubCheckFailedError,
	GithubCheckIncompleteError,
	WorkflowReferenceMutableError,
	WorkflowReferenceNotFoundError
} from '../../errors.ts';
import { trustRuleRows } from '../oidc-trust/format.ts';
import {
	lookupRepository,
	type RepositoryIdentity
} from '../oidc-trust/github.ts';

import { warnUnboundAudienceRules } from './audience-binding.ts';
import {
	activeMatcherRules,
	checkPullRequestCacheAccess,
	checkReuseView,
	checkReuseViewCacheInfo,
	type GithubCheckClient
} from './check.ts';
import { githubActionsIssuer } from './claims.ts';
import {
	parseExactWorkflowReference,
	pullRequestViewName
} from './convention.ts';
import {
	type DiscoveredPublishingJob,
	discoverPublishingJobs,
	githubWorkflowSource,
	type ReadCredentialWiring,
	type WorkflowDiscovery,
	type WorkflowSource
} from './discovery.ts';
import {
	BranchWorkflowTrustFinding,
	CheckFinding,
	FailedCheckFinding,
	PassedCheckFinding,
	ReadAuthenticationConfiguredFinding,
	ReadAuthenticationIncompleteFinding,
	ReadAuthenticationUnverifiedFinding,
	ReuseViewAccessModeMismatchFinding,
	ReuseViewMissingFinding,
	RootGrantPrefixUnverifiedFinding
} from './finding.ts';
import {
	isPresetJob,
	isReadOnlyJob,
	modelPublishingJob,
	type PublicationCase,
	type PublishingJobFinding,
	type ReuseViewRequirement,
	withMergedCloseCases
} from './publication.ts';
import { pullRequestLifecycleFindings } from './pull-request-lifecycle.ts';
import { publicationReadAuthority } from './read-authority.ts';
import { checkPublicationTrust } from './release-authority.ts';
import {
	RepositoryTrustRuleMissingFinding,
	TrustRuleAudienceMismatchFinding,
	TrustRuleClaimMismatchFinding,
	TrustRuleGrantMissingFinding,
	TrustRuleIssuerMismatchFinding
} from './trust-selection.ts';
import { verifyWorkflowReference } from './workflow-reference.ts';

export interface DiscoveredGithubCheckOptions {
	readonly repo: string;
	/**
	 * Defaults to the repository's default branch.
	 */
	readonly branch?: string;
	readonly readUser?: string;
	readonly isFixRequested?: boolean;
	/**
	 * Reports the result as `github-check-verified`, without the repair
	 * suggestion or candidate rules, for the check that follows a repair.
	 */
	readonly isVerification?: boolean;
}

export interface DiscoveredGithubCheckDependencies {
	readonly source?: WorkflowSource;
	readonly lookupRepository?: typeof lookupRepository;
	readonly verifyWorkflowReference?: typeof verifyWorkflowReference;
	readonly fetchCacheInfo: (url: URL) => Promise<CacheInfo>;
	readonly fetchCacheAccess: (url: URL) => Promise<CacheAccessMode>;
	readonly signal?: AbortSignal;
}

export type PublishingJobStatus = 'ready' | 'failed' | 'unverified';

export interface PublishingJobResult {
	readonly caller: string;
	readonly job: string;
	readonly workflowRef?: string;
	readonly status: PublishingJobStatus;
	readonly findings: readonly PublishingJobFinding[];
}

export interface DiscoveredGithubCheckResult {
	readonly discovery: WorkflowDiscovery;
	readonly identity: RepositoryIdentity;
	readonly branch: string;
	readonly jobs: readonly PublishingJobResult[];
	/**
	 * The discovered jobs in which a repair can fix every failure: a missing
	 * trust rule, a matching rule without a required grant, or a missing
	 * preset reuse view.
	 */
	readonly repairableJobs: readonly DiscoveredPublishingJob[];
	readonly verifiedWorkflowReferences: ReadonlySet<string>;
	readonly scheduleNote?: string;
	readonly branchNote?: string;
}

export class DiscoveryUnverifiedFinding extends CheckFinding {
	readonly status = 'unverified' as const;

	constructor(public readonly reason: string) {
		super('workflow discovery');
	}

	detail(): string {
		return this.reason;
	}
}

export class PublishingJobMissingFinding extends CheckFinding {
	readonly status = 'unverified' as const;

	constructor(
		public readonly tenant: URL,
		public readonly branch: string
	) {
		super('workflow discovery');
	}

	detail(): string {
		return `no Cupboard publishing job targeting ${this.tenant.href} was found on ${this.branch}. If the workflow exists on another branch, pass --branch <branch>.`;
	}
}

/**
 * A job without a preset or claim-bound PR templates publishes its pull-request
 * runs to the cache and root of its branch runs. The check reports this case for manual review
 * whether or not a trust rule for those runs exists.
 */
export class SharedPullRequestCacheFinding extends CheckFinding {
	readonly status = 'unverified' as const;

	constructor() {
		super('trust rule');
	}

	detail(): string {
		return 'pull-request runs publish to the cache and root of the branch runs, so a pull_request trust rule would let any pull request from the repository write there; use the flake preset or a separate pull-request cache';
	}
}

export class WorkflowPinFailedFinding extends FailedCheckFinding {
	constructor(
		public readonly error:
			WorkflowReferenceMutableError | WorkflowReferenceNotFoundError
	) {
		super('workflow reference');
	}

	detail(): string {
		if (this.error instanceof WorkflowReferenceMutableError) {
			const { reference, pin } = this.error;
			const pinned = pin.startsWith('refs/heads/')
				? 'pins a branch, which can move'
				: `pins the tag ${pin.replace(/^refs\/tags\//u, '')}, and GitHub does not report its release as immutable`;

			return `the discovered reference '${reference}' ${pinned}; use an immutable release tag or full commit ID`;
		}

		const { reference } = this.error;
		const { pin } = parseExactWorkflowReference(reference);
		const isPossibleBranch = pin.kind === 'tag' && !/^v?\d/u.test(pin.tag);
		const branchHint = isPossibleBranch
			? `; if '${pin.tag}' is a branch, use an immutable release tag or full commit ID`
			: '';

		return `GitHub could not find a published release or workflow file for the discovered reference '${reference}'; check the workflow path and pin${branchHint}`;
	}
}

function publishingJobResult(
	job: Pick<PublishingJobResult, 'caller' | 'job' | 'workflowRef'>,
	findings: readonly PublishingJobFinding[]
): PublishingJobResult {
	const statuses = new Set(findings.map(({ finding }) => finding.status));

	return {
		...job,
		status: statuses.has('failed')
			? 'failed'
			: statuses.has('unverified')
				? 'unverified'
				: 'ready',
		findings
	};
}

// A repair can add trust rules and create the preset reuse view. Every other
// failure needs an operator to change the workflow or the tenant.
function isRepairableFinding(
	finding: CheckFinding,
	identity: RepositoryIdentity
): boolean {
	if (finding.status !== 'failed') {
		return (
			finding.status === 'ok' ||
			finding instanceof ReadAuthenticationUnverifiedFinding
		);
	}

	if (finding instanceof ReuseViewMissingFinding) {
		return finding.view === pullRequestViewName(identity.repositoryId);
	}

	return (
		finding instanceof RepositoryTrustRuleMissingFinding ||
		finding instanceof TrustRuleIssuerMismatchFinding ||
		finding instanceof TrustRuleAudienceMismatchFinding ||
		finding instanceof TrustRuleClaimMismatchFinding ||
		finding instanceof TrustRuleGrantMissingFinding
	);
}

function isRepairableJob(
	job: PublishingJobResult,
	identity: RepositoryIdentity
): boolean {
	return (
		job.status === 'failed' &&
		job.findings.every(({ finding }) => isRepairableFinding(finding, identity))
	);
}

export function isRepairOffered(
	result: Pick<DiscoveredGithubCheckResult, 'repairableJobs'>
): boolean {
	return result.repairableJobs.length > 0;
}

function findingDetails(findings: readonly PublishingJobFinding[]): string[] {
	return findings.flatMap(({ trigger, finding }) => {
		const detail = finding.humanDetail();

		if (detail === undefined) {
			return [];
		}

		return [trigger === undefined ? detail : `${trigger}: ${detail}`];
	});
}

function hasTrigger(job: DiscoveredPublishingJob, event: string): boolean {
	return job.triggers.some((trigger) => trigger.event === event);
}

function isPlaceholder(job: PublishingJobResult): boolean {
	return job.findings.some(
		({ finding }) => finding instanceof PublishingJobMissingFinding
	);
}

/**
 * Whether a GitHub trust rule can match a run of this repository whose token
 * has `workflowReference` as its `job_workflow_ref` claim. When it is
 * `undefined`, the rule's `job_workflow_ref` claim is not compared.
 */
export function canMatchRepositoryRun(
	rule: Pick<OidcTrustRule, 'issuer' | 'claims'>,
	identity: RepositoryIdentity,
	workflowReference: string | undefined
): boolean {
	const knownClaims: Readonly<Record<string, string>> = {
		repository_id: String(identity.repositoryId),
		repository_owner_id: String(identity.repositoryOwnerId),
		repository: identity.fullName,
		repository_owner: identity.fullName.split('/', 1)[0] ?? identity.fullName
	};
	const hasMatchingClaims = Object.entries(knownClaims).every(
		([claim, value]) => {
			const expected = rule.claims[claim];

			return expected === undefined || isClaimSatisfied(expected, value);
		}
	);
	const workflow = rule.claims.job_workflow_ref;
	const subject = rule.claims.sub;
	const hasMatchingSubject =
		typeof subject !== 'string' ||
		subject.startsWith(`repo:${identity.fullName}:`);

	return (
		rule.issuer === githubActionsIssuer &&
		hasMatchingClaims &&
		hasMatchingSubject &&
		(workflow === undefined ||
			workflowReference === undefined ||
			isClaimSatisfied(workflow, workflowReference))
	);
}

function candidateTrustRules(
	identity: RepositoryIdentity,
	unverified: readonly PublishingJobResult[],
	rules: readonly OidcTrustSummary[]
): OidcTrustSummary[] {
	const references = unverified.map((job) => job.workflowRef);
	const hasUnknownReference = references.includes(undefined);

	return rules.filter(
		(rule) =>
			!rule.disabled &&
			(hasUnknownReference
				? canMatchRepositoryRun(rule, identity, undefined)
				: references.some((reference) =>
						canMatchRepositoryRun(rule, identity, reference)
					))
	);
}

export async function checkView(
	tenant: URL,
	view: ReuseViewRequirement,
	identity: RepositoryIdentity,
	client: GithubCheckClient,
	fetchCacheInfo: (url: URL) => Promise<CacheInfo>
): Promise<CheckFinding> {
	if (view.name === pullRequestViewName(identity.repositoryId)) {
		return checkReuseView(
			tenant,
			identity,
			client,
			fetchCacheInfo,
			view.destination
		);
	}

	const { views } = await client.reuseViews.list();

	if (views.every((candidate) => candidate.name !== view.name)) {
		return new ReuseViewMissingFinding('reuse view', view.name);
	}

	return checkReuseViewCacheInfo(
		tenant,
		view.destination,
		view.name,
		fetchCacheInfo
	);
}

function checkRootGrantPrefixes(
	rules: readonly OidcTrustRule[],
	publication: PublicationCase
): CheckFinding {
	for (const request of publication.requests) {
		const selection = selectModelledOidcTrust(
			rules,
			publication.claims,
			request
		);

		if (selection.outcome !== 'selected') {
			continue;
		}

		for (const detail of request) {
			if (
				detail.type !== 'cupboard_cache' ||
				detail.root === undefined ||
				detail.actions.every((operation) => !isRootOperation(operation))
			) {
				continue;
			}

			const hasPrefixGrant = preferredModelledOidcTrustRules(
				rules,
				publication.claims
			).some((rule) =>
				rule.permittedGrants.some((grant) => {
					if (grant.type === 'cupboard_wildcard') {
						return true;
					}

					if (
						grant.type !== 'cupboard_cache' ||
						grant.resources.root === undefined
					) {
						return false;
					}

					const root =
						grant.resources.root.exact ?? grant.resources.root.equalsTemplate;

					return (
						root?.endsWith('/') === true &&
						isGrantPermittedByRule(
							[grant],
							{
								...detail,
								actions: detail.actions.filter((operation) =>
									isRootOperation(operation)
								)
							},
							publication.claims
						)
					);
				})
			);

			if (!hasPrefixGrant) {
				return new RootGrantPrefixUnverifiedFinding('root grant', detail.root);
			}
		}
	}

	return new PassedCheckFinding('root grant');
}

function trustFindings(
	isPreset: boolean,
	publication: PublicationCase,
	rules: readonly OidcTrustRule[],
	requests: readonly AuthorizationDetails[],
	readResources: readonly ReadResourceState[]
): CheckFinding[] {
	if (requests.length === 0) {
		return [];
	}

	if (
		!isPreset &&
		publication.trigger === 'pull_request' &&
		publication.pullRequestTemplates === undefined &&
		publication.lifecycle === undefined
	) {
		return [new SharedPullRequestCacheFinding()];
	}

	const trust = checkPublicationTrust({
		check: 'trust rule',
		publication,
		rules,
		requests,
		resources: readResources
	});

	if (
		publication.requests.length === 0 ||
		publication.lifecycle !== undefined
	) {
		return [trust];
	}

	return trust.status === 'ok'
		? [trust, checkRootGrantPrefixes(rules, publication)]
		: [trust];
}

function readAuthenticationFinding(
	resource: 'cache' | 'view',
	wiring: ReadCredentialWiring
): CheckFinding | undefined {
	switch (wiring) {
		case 'configured': {
			return new ReadAuthenticationConfiguredFinding(resource);
		}
		case 'incomplete': {
			return new ReadAuthenticationIncompleteFinding(resource);
		}
		case 'unknown': {
			return new ReadAuthenticationUnverifiedFinding(resource);
		}
		case 'none': {
			return;
		}
	}
}

async function inspectPublication(
	job: DiscoveredPublishingJob,
	publication: PublicationCase,
	identity: RepositoryIdentity,
	tenant: URL,
	rules: readonly OidcTrustRule[],
	client: GithubCheckClient,
	dependencies: DiscoveredGithubCheckDependencies
): Promise<CheckFinding[]> {
	const isPreset = isPresetJob(job);
	const cacheMode = job.inputs['cache-access-mode'];
	const accessSource: ReuseViewAccessModeMismatchFinding['source'] =
		!isReadOnlyJob(job) && (cacheMode === 'public' || cacheMode === 'private')
			? 'workflow-input'
			: 'tenant-default';
	const read = await publicationReadAuthority(
		job,
		publication,
		tenant,
		identity.repositoryId,
		client,
		dependencies.fetchCacheAccess
	);
	const findings = trustFindings(
		isPreset,
		publication,
		rules,
		[...publication.requests, ...read.requests],
		read.resources
	);
	for (const [resource, access, wiring] of [
		['cache', read.cacheAccess, read.cacheWiring],
		['view', read.viewAccess, read.viewWiring]
	] as const) {
		if (access !== 'private' && wiring !== 'incomplete') {
			continue;
		}

		const finding = readAuthenticationFinding(resource, wiring);

		if (finding !== undefined) {
			findings.push(finding);
		}
	}
	if (
		publication.reuseView !== undefined &&
		read.selectedViewAccess !== undefined &&
		read.viewAccess !== undefined &&
		read.selectedViewAccess !== read.viewAccess
	) {
		findings.push(
			new ReuseViewAccessModeMismatchFinding(
				'reuse view access',
				publication.reuseView.name,
				read.viewAccess,
				read.selectedViewAccess,
				accessSource
			)
		);
	}

	if (
		publication.lifecycle === undefined &&
		publication.reuseView !== undefined
	) {
		findings.push(
			await checkView(
				tenant,
				publication.reuseView,
				identity,
				client,
				dependencies.fetchCacheInfo
			)
		);
	}

	if (
		isPreset &&
		publication.trigger === 'pull_request' &&
		publication.lifecycle === undefined &&
		publication.requests.length > 0
	) {
		findings.push(
			await checkPullRequestCacheAccess(
				identity,
				client,
				read.selectedViewAccess,
				accessSource
			)
		);
	}

	return findings;
}

async function inspectJob(
	job: DiscoveredPublishingJob,
	discovery: WorkflowDiscovery,
	identity: RepositoryIdentity,
	tenant: URL,
	branch: string,
	rules: readonly OidcTrustRule[],
	client: GithubCheckClient,
	dependencies: DiscoveredGithubCheckDependencies
): Promise<PublishingJobResult> {
	const verifyReference =
		dependencies.verifyWorkflowReference ?? verifyWorkflowReference;
	const lookupOptions =
		dependencies.signal === undefined ? {} : { signal: dependencies.signal };
	const result = {
		caller: job.caller,
		job: job.job,
		workflowRef: job.workflowRef
	};

	try {
		const parsed = parseExactWorkflowReference(job.workflowRef);
		await verifyReference(parsed, {
			...lookupOptions,
			...(parsed.pin.kind === 'branch' && { allowBranchWorkflow: true })
		});
	} catch (error) {
		if (
			error instanceof WorkflowReferenceMutableError ||
			error instanceof WorkflowReferenceNotFoundError
		) {
			return publishingJobResult(result, [
				{ finding: new WorkflowPinFailedFinding(error) }
			]);
		}

		throw error;
	}

	const model = modelPublishingJob(job, identity, tenant, branch);
	const findings = [
		...(parseExactWorkflowReference(job.workflowRef).pin.kind === 'branch'
			? [{ finding: new BranchWorkflowTrustFinding(job.workflowRef) }]
			: []),
		...model.findings,
		...pullRequestLifecycleFindings(
			job,
			identity,
			discovery.jobs,
			discovery.unverified
		)
	];

	for (const publication of withMergedCloseCases(model.cases, identity)) {
		const checked = await inspectPublication(
			job,
			publication,
			identity,
			tenant,
			rules,
			client,
			dependencies
		);

		findings.push(
			...checked.map((finding) => ({
				trigger: publication.lifecycle ?? publication.trigger,
				finding
			}))
		);
	}

	return publishingJobResult(result, findings);
}

export async function inspectDiscoveredGithubCheck(
	tenant: URL,
	options: DiscoveredGithubCheckOptions,
	reporter: Reporter,
	client: GithubCheckClient,
	dependencies: DiscoveredGithubCheckDependencies
): Promise<DiscoveredGithubCheckResult> {
	const lookupOptions =
		dependencies.signal === undefined ? {} : { signal: dependencies.signal };
	const source = dependencies.source ?? githubWorkflowSource(lookupOptions);
	const verified = new Map<string, Promise<void>>();
	const verifiedWorkflowReferences = new Set<string>();
	const cacheInfo = new Map<string, Promise<CacheInfo>>();
	const cacheAccess = new Map<string, Promise<CacheAccessMode>>();
	let listedViews: ReturnType<typeof client.reuseViews.list> | undefined;
	const inspectionDependencies: DiscoveredGithubCheckDependencies = {
		...dependencies,
		verifyWorkflowReference: (reference, options) => {
			const key = reference.reference;
			const cached = verified.get(key);

			if (cached !== undefined) {
				return cached;
			}

			const check = (async () => {
				await (dependencies.verifyWorkflowReference ?? verifyWorkflowReference)(
					reference,
					options
				);
				verifiedWorkflowReferences.add(key);
			})();
			verified.set(key, check);

			return check;
		},
		fetchCacheInfo: (url) => {
			const cached = cacheInfo.get(url.href);

			if (cached !== undefined) {
				return cached;
			}

			const info = dependencies.fetchCacheInfo(url);
			cacheInfo.set(url.href, info);

			return info;
		},
		fetchCacheAccess: (url) => {
			const cached = cacheAccess.get(url.href);

			if (cached !== undefined) {
				return cached;
			}

			const access = dependencies.fetchCacheAccess(url);
			cacheAccess.set(url.href, access);

			return access;
		}
	};
	const inspectionClient: GithubCheckClient = {
		...client,
		reuseViews: {
			list: () => (listedViews ??= client.reuseViews.list())
		}
	};
	const identity = await reporter.phase(
		'Reading repository identity from GitHub',
		() =>
			(dependencies.lookupRepository ?? lookupRepository)(
				options.repo,
				lookupOptions
			)
	);
	const branch = options.branch ?? identity.defaultBranch;
	const discovery = await reporter.phase(
		'Reading publishing workflows from GitHub',
		() => discoverPublishingJobs(identity.fullName, branch, tenant, source)
	);
	const listed = await reporter.phase('Reading trust rules', () =>
		client.oidcTrust.list()
	);
	const rules = activeMatcherRules(listed.rules);

	warnUnboundAudienceRules(reporter, rules, identity, tenant);

	const jobs: PublishingJobResult[] = discovery.unverified.map((entry) =>
		publishingJobResult(
			{
				caller: entry.caller,
				job: entry.job,
				...(entry.workflowRef !== undefined && {
					workflowRef: entry.workflowRef
				})
			},
			[{ finding: new DiscoveryUnverifiedFinding(entry.detail) }]
		)
	);

	const repairableJobs: DiscoveredPublishingJob[] = [];

	for (const job of discovery.jobs) {
		const result = await inspectJob(
			job,
			discovery,
			identity,
			tenant,
			branch,
			rules,
			inspectionClient,
			inspectionDependencies
		);

		jobs.push(result);

		if (isRepairableJob(result, identity)) {
			repairableJobs.push(job);
		}
	}

	if (jobs.length === 0) {
		jobs.push(
			publishingJobResult({ caller: identity.fullName, job: 'publication' }, [
				{ finding: new PublishingJobMissingFinding(tenant, branch) }
			])
		);
	}

	const scheduleNote =
		identity.defaultBranch !== branch &&
		discovery.jobs.some((job) => hasTrigger(job, 'schedule'))
			? `GitHub runs schedules from the default branch ${identity.defaultBranch}. Schedule changes on ${branch} take effect after ${branch} is merged into ${identity.defaultBranch}.`
			: undefined;
	const branchNote =
		identity.defaultBranch !== branch &&
		discovery.jobs.some(
			(job) =>
				isPresetJob(job) &&
				(job.inputs.branch ?? 'main') === identity.defaultBranch &&
				(hasTrigger(job, 'push') || hasTrigger(job, 'workflow_dispatch'))
		)
			? `The check models the preset's push and manual runs on the default branch ${identity.defaultBranch}, using the workflow files from ${branch}. Changes on ${branch} take effect after ${branch} is merged into ${identity.defaultBranch}.`
			: undefined;
	const readCredential =
		options.readUser === undefined
			? ''
			: ' --read-user <user> --read-password <password>';

	const rows: ResultRow[] = [
		{
			label: 'Workflow revision',
			value: `${identity.fullName}@${discovery.revision}`
		},
		...jobs.map((job) => {
			const details = findingDetails(job.findings);

			return {
				label: `${job.caller}, ${job.job}`,
				value:
					details.length === 0
						? job.status
						: `${job.status}: ${details.join('; ')}`
			};
		}),
		...(scheduleNote === undefined
			? []
			: [{ label: 'Schedule', value: scheduleNote }]),
		...(branchNote === undefined
			? []
			: [{ label: 'Branch', value: branchNote }]),
		...(repairableJobs.length > 0 &&
		options.isFixRequested !== true &&
		options.isVerification !== true
			? [
					{
						label: 'Review a repair',
						raw: true,
						value: `cupboard github check ${canonicalHref(tenant)} --repo ${identity.fullName} --branch ${branch}${readCredential} --fix`
					}
				]
			: [])
	];

	reporter.result({
		kind:
			options.isVerification === true
				? 'github-check-verified'
				: 'github-check-discovered',
		title:
			options.isVerification === true
				? 'GitHub publishing access check'
				: 'GitHub publishing jobs',
		data: {
			revision: discovery.revision,
			jobs,
			...(scheduleNote !== undefined && { scheduleNote }),
			...(branchNote !== undefined && { branchNote })
		},
		rows
	});

	const unverified = jobs.filter(
		(job) => job.status === 'unverified' && !isPlaceholder(job)
	);

	if (unverified.length > 0 && options.isVerification !== true) {
		const candidates = candidateTrustRules(identity, unverified, listed.rules);

		reporter.result({
			kind: 'github-check-trust-rules',
			title: 'GitHub trust rules',
			data: candidates,
			rows: [
				{
					label: 'Note',
					value:
						'Active GitHub rules that match this repository and the workflow references of the unverified jobs. The check cannot determine whether the unverified jobs publish or whether these rules authorise a run.'
				},
				...(candidates.length === 0
					? [
							{
								label: 'Rules',
								value:
									'No active GitHub rules match this repository and the workflow references of the unverified jobs.'
							}
						]
					: candidates.flatMap((rule, index) => [
							...(index === 0 ? [] : [{ label: '', value: '' }]),
							...trustRuleRows(rule, `Rule ${String(index + 1)}`)
						]))
			]
		});
	}

	return {
		discovery,
		identity,
		branch,
		jobs,
		repairableJobs,
		verifiedWorkflowReferences,
		...(scheduleNote !== undefined && { scheduleNote }),
		...(branchNote !== undefined && { branchNote })
	};
}

export function finishDiscoveredGithubCheck(
	result: DiscoveredGithubCheckResult
): void {
	const failed = result.jobs.filter((job) => job.status === 'failed');

	if (failed.length > 0) {
		throw new GithubCheckFailedError(
			failed.map((job) => `${job.caller}, ${job.job}`)
		);
	}

	const unverified = result.jobs.filter((job) => job.status === 'unverified');

	if (unverified.length > 0) {
		throw new GithubCheckIncompleteError(
			unverified.map((job) => `${job.caller}, ${job.job}`)
		);
	}
}
