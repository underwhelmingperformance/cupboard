import { type CacheInfo } from '@cupboard/nix-store/cache-info';
import { isGrantPermittedByRule } from '@cupboard/protocol/grant-match';
import { isRootOperation } from '@cupboard/protocol/grants';
import { type OidcTrustSummary } from '@cupboard/protocol/oidc';
import { selectModelledOidcTrust } from '@cupboard/protocol/oidc-trust-diagnostics';
import {
	isClaimSatisfied,
	type OidcTrustRule
} from '@cupboard/protocol/oidc-trust-match';
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

import {
	activeMatcherRules,
	checkPullRequestCacheAccess,
	checkReuseView,
	checkReuseViewCacheInfo,
	checkTrustRule,
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
	type WorkflowDiscovery,
	type WorkflowSource
} from './discovery.ts';
import {
	CheckFinding,
	FailedCheckFinding,
	PassedCheckFinding,
	ReuseViewMissingFinding,
	RootGrantPrefixUnverifiedFinding
} from './finding.ts';
import {
	isPresetJob,
	modelPublishingJob,
	type PublicationCase,
	type PublishingJobFinding,
	type ReuseViewRequirement
} from './publication.ts';
import { verifyWorkflowReference } from './workflow-reference.ts';

export interface DiscoveredGithubCheckOptions {
	readonly repo: string;
	/**
	 * Defaults to the repository's default branch.
	 */
	readonly branch?: string;
}

export interface DiscoveredGithubCheckDependencies {
	readonly source?: WorkflowSource;
	readonly lookupRepository?: typeof lookupRepository;
	readonly verifyWorkflowReference?: typeof verifyWorkflowReference;
	readonly fetchCacheInfo: (url: URL) => Promise<CacheInfo>;
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
		return `no Cupboard publishing job targeting ${this.tenant.href} was found on ${this.branch}`;
	}
}

/**
 * A job without the flake preset publishes its pull-request runs to the cache
 * and root of its branch runs. The check reports this case for manual review
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

function findingDetails(findings: readonly PublishingJobFinding[]): string[] {
	return findings.flatMap(({ trigger, finding }) => {
		const detail = finding.detail();

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

function candidateTrustRules(
	identity: RepositoryIdentity,
	unverified: readonly PublishingJobResult[],
	rules: readonly OidcTrustSummary[]
): OidcTrustSummary[] {
	const knownClaims: Readonly<Record<string, string>> = {
		repository_id: String(identity.repositoryId),
		repository_owner_id: String(identity.repositoryOwnerId),
		repository: identity.fullName,
		repository_owner: identity.fullName.split('/', 1)[0] ?? identity.fullName
	};
	const references = unverified.flatMap((job) =>
		job.workflowRef === undefined ? [] : [job.workflowRef]
	);
	const hasUnknownReference = unverified.some(
		(job) => job.workflowRef === undefined
	);
	return rules.filter((rule) => {
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
			!rule.disabled &&
			rule.issuer === githubActionsIssuer &&
			hasMatchingClaims &&
			hasMatchingSubject &&
			(workflow === undefined ||
				hasUnknownReference ||
				references.some((reference) => isClaimSatisfied(workflow, reference)))
		);
	});
}

async function checkView(
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

			const hasPrefixGrant = selection.rule.permittedGrants.some((grant) => {
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
					isGrantPermittedByRule([grant], detail, publication.claims)
				);
			});

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
	rules: readonly OidcTrustRule[]
): CheckFinding[] {
	if (!isPreset && publication.trigger === 'pull_request') {
		return [new SharedPullRequestCacheFinding()];
	}

	const trust = checkTrustRule(
		'trust rule',
		rules,
		publication.claims,
		publication.requests
	);

	return trust.status === 'ok'
		? [trust, checkRootGrantPrefixes(rules, publication)]
		: [trust];
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
	const findings = trustFindings(isPreset, publication, rules);

	if (publication.reuseView !== undefined) {
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

	if (isPreset && publication.trigger === 'pull_request') {
		findings.push(await checkPullRequestCacheAccess(identity, client));
	}

	return findings;
}

async function inspectJob(
	job: DiscoveredPublishingJob,
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
		await verifyReference(
			parseExactWorkflowReference(job.workflowRef),
			lookupOptions
		);
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
	const findings = [...model.findings];

	for (const publication of model.cases) {
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
				trigger: publication.trigger,
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

	for (const job of discovery.jobs) {
		jobs.push(
			await inspectJob(
				job,
				identity,
				tenant,
				branch,
				rules,
				inspectionClient,
				inspectionDependencies
			)
		);
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
			: [{ label: 'Branch', value: branchNote }])
	];

	reporter.result({
		kind: 'github-check-discovered',
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

	if (unverified.length > 0) {
		const candidates = candidateTrustRules(identity, unverified, listed.rules);

		reporter.result({
			kind: 'github-check-trust-rules',
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
