import { cacheUrl, parseTenantCacheUrl } from '@cupboard/nix-store/cache-url';
import {
	cacheNameSchema,
	type CacheScope,
	type RootName
} from '@cupboard/nix-store/scalars';
import { type AuthorizationDetails } from '@cupboard/protocol/grants';

import {
	attestAttachAuthorizationDetails,
	cacheCreateAuthorizationDetails,
	cacheRemoveAuthorizationDetails,
	confirmAuthorizationDetails,
	pushAuthorizationDetails,
	rootEnsureAuthorizationDetails,
	rootListAuthorizationDetails
} from '../../auth/attenuate.ts';
import { InvalidRootNameError } from '../../errors.ts';
import { parseRootName } from '../../root-name.ts';
import { type RepositoryIdentity } from '../oidc-trust/github.ts';

import {
	type GithubActionsClaims,
	githubBranchClaims,
	githubPullRequestClaims,
	githubTagPushClaims
} from './claims.ts';
import { pullRequestCacheName, pullRequestViewName } from './convention.ts';
import {
	type DiscoveredPublishingJob,
	type ReferenceFilterKey,
	type WorkflowTrigger
} from './discovery.ts';
import { CheckFinding } from './finding.ts';
import { ReferencePattern } from './reference-pattern.ts';

type BranchTrigger = 'push' | 'workflow_dispatch' | 'schedule';

interface BranchReference {
	readonly kind: 'branch';
	readonly name: string;
}

interface TagReference {
	readonly kind: 'tag';
	readonly pattern: ReferencePattern;
}

type TriggerReference =
	| {
			readonly trigger: 'pull_request';
			readonly ref: { readonly kind: 'pull-request' };
	  }
	| { readonly trigger: 'push'; readonly ref: BranchReference | TagReference }
	| {
			readonly trigger: 'workflow_dispatch' | 'schedule';
			readonly ref: BranchReference;
	  };

export interface ReuseViewRequirement {
	readonly name: string;
	readonly destination: URL;
}

export type PublicationCase = TriggerReference & {
	readonly claims: GithubActionsClaims;
	readonly requests: readonly AuthorizationDetails[];
	readonly reuseView?: ReuseViewRequirement;
};

export interface PublishingJobFinding {
	readonly trigger?: string;
	readonly finding: CheckFinding;
}

export interface PublicationModel {
	readonly cases: readonly PublicationCase[];
	readonly findings: readonly PublishingJobFinding[];
}

export class PublicationUnmodelledFinding extends CheckFinding {
	readonly status = 'unverified' as const;

	constructor(public readonly reason: string) {
		super('publication model');
	}

	detail(): string {
		return this.reason;
	}
}

/**
 * What an operator can change when a filter excludes the modelled branch.
 * `select-branch` produces a hint to use `--branch`. `change-filter` is for a
 * preset job whose `branch` input is the default branch. For that job,
 * `--branch` does not change the modelled branch.
 */
export type FilterRemedy = 'select-branch' | 'change-filter' | 'none';

const filterRemedies: Readonly<Record<FilterRemedy, string>> = {
	'select-branch': '; check a matching branch with --branch',
	'change-filter': "; change the filter or the preset's branch input",
	none: ''
};

export class ReferenceFilterExcludesFinding extends CheckFinding {
	readonly status = 'unverified' as const;

	constructor(
		public readonly filter: ReferenceFilterKey,
		public readonly patterns: readonly string[],
		public readonly branch: string,
		public readonly remedy: FilterRemedy
	) {
		super('ref filter');
	}

	detail(): string {
		return `the ${this.filter} filter (${this.patterns.join(', ')}) excludes ${this.branch}${filterRemedies[this.remedy]}`;
	}
}

export class ReferenceFilterUnsupportedFinding extends CheckFinding {
	readonly status = 'unverified' as const;

	constructor(
		public readonly filter: ReferenceFilterKey,
		public readonly pattern: string
	) {
		super('ref filter');
	}

	detail(): string {
		return `the check cannot evaluate the ${this.filter} pattern '${this.pattern}'`;
	}
}

export class TagsIgnoreUnmodelledFinding extends CheckFinding {
	readonly status = 'unverified' as const;

	constructor(public readonly patterns: readonly string[]) {
		super('ref filter');
	}

	detail(): string {
		return `the check does not evaluate tags-ignore filters (${this.patterns.join(', ')})`;
	}
}

export class PresetTagPushFinding extends CheckFinding {
	readonly status = 'unverified' as const;

	constructor() {
		super('ref filter');
	}

	detail(): string {
		return 'a flake preset run fails on a tag push, because the preset accepts only pull requests and pushes to its branch; publish tags from a job without the preset';
	}
}

export class PushCoverageFinding extends CheckFinding {
	readonly status = 'ok' as const;

	constructor(public readonly branch: string) {
		super('push coverage');
	}

	detail(): string {
		return `the push event has no branch or tag filter, so pushes to every branch and tag start runs; the check models only pushes to ${this.branch}`;
	}
}

export class PresetPushFilterFinding extends CheckFinding {
	readonly status = 'ok' as const;

	constructor(public readonly branch: string) {
		super('push coverage');
	}

	detail(): string {
		return `the push event has no branch filter, and a flake preset run fails on a push to any branch other than ${this.branch}; add branches: [${this.branch}] to the push event`;
	}
}

export class ForkPullRequestFinding extends CheckFinding {
	readonly status = 'ok' as const;

	constructor() {
		super('job condition');
	}

	detail(): string {
		return 'the job condition limits the job to pull requests from this repository; the check does not model pull requests from forks';
	}
}

export class CustomReuseViewFinding extends CheckFinding {
	readonly status = 'ok' as const;

	constructor(public readonly view: string) {
		super('reuse view');
	}

	detail(): string {
		return `the check verifies the priority and store directory of reuse view ${this.view}, not the caches that its selectors include`;
	}
}

export class PathFilterNotModelledFinding extends CheckFinding {
	readonly status = 'ok' as const;

	constructor() {
		super('paths filter');
	}

	detail(): string {
		return 'the check does not evaluate paths filters, which determine whether a run starts';
	}
}

export class JobConditionUndecidedFinding extends CheckFinding {
	readonly status = 'unverified' as const;

	constructor(public readonly conditions: readonly string[]) {
		super('job condition');
	}

	detail(): string {
		return `the check cannot evaluate whether the job condition (${this.conditions.join(' && ')}) allows the job to run`;
	}
}

export class ManualRunBranchFinding extends CheckFinding {
	readonly status = 'ok' as const;

	constructor(public readonly branch: string) {
		super('manual run');
	}

	detail(): string {
		return `the check models manual runs on ${this.branch}; manual runs on other branches are not covered`;
	}
}

type JobCache =
	| { readonly outcome: 'resolved'; readonly scope: CacheScope }
	| { readonly outcome: 'unresolved'; readonly reason: string };

interface ModelContext {
	readonly isPreset: boolean;
	readonly configuredBranch: string;
	readonly selectedBranch: string;
	readonly defaultBranch: string;
}

function scalar(
	job: DiscoveredPublishingJob,
	key: string,
	fallback = ''
): string | undefined {
	const value = job.inputs[key] ?? fallback;

	if (typeof value !== 'string' || value.includes('${{')) {
		return;
	}

	return value;
}

/**
 * Whether a job uses the flake workflow's `pull-request-and-branch` preset.
 */
export function isPresetJob(job: DiscoveredPublishingJob): boolean {
	return (
		job.kind === 'flake' && job.inputs.preset === 'pull-request-and-branch'
	);
}

function unresolved(reason: string): JobCache {
	return { outcome: 'unresolved', reason };
}

/**
 * The cache that a job publishes to. The installable workflow accepts a
 * named-cache URL or a cache input, and the flake workflow accepts only the
 * cache input.
 */
export function jobCache(job: DiscoveredPublishingJob): JobCache {
	const input = scalar(job, 'cache');

	if (input === undefined) {
		return unresolved('cache must be a literal string');
	}

	const url = job.inputs.url;

	if (typeof url !== 'string') {
		return unresolved('url must be a literal string');
	}

	let target: ReturnType<typeof parseTenantCacheUrl>;

	try {
		target = parseTenantCacheUrl(new URL(url));
	} catch {
		return unresolved(`url ${url} is not a tenant or cache URL`);
	}

	if (target.cache.kind === 'named') {
		if (job.kind === 'flake') {
			return unresolved(
				'the flake workflow takes a tenant URL; use the cache input for a named cache'
			);
		}

		if (input !== '') {
			return unresolved(
				`url selects cache ${target.cache.name} and the cache input selects ${input}; use one of them`
			);
		}

		return { outcome: 'resolved', scope: target.cache };
	}

	if (input === '') {
		return { outcome: 'resolved', scope: { kind: 'default' } };
	}

	const name = cacheNameSchema.safeParse(input);

	if (!name.success) {
		return unresolved(`cache '${input}' is invalid`);
	}

	return { outcome: 'resolved', scope: { kind: 'named', name: name.data } };
}

function root(value: string): RootName | undefined {
	try {
		return parseRootName(value);
	} catch (error) {
		if (error instanceof InvalidRootNameError) {
			return;
		}

		throw error;
	}
}

interface FlakeRoots {
	readonly target: RootName;
	readonly run: RootName;
}

function flakeRoots(rootPrefix: string): FlakeRoots | undefined {
	const target = root(`${rootPrefix}/target`);
	const run = root(`${rootPrefix}/_cupboard-run/1`);

	if (target === undefined || run === undefined) {
		return;
	}

	return { target, run };
}

/**
 * The requests of one flake workflow run. The workflow creates and removes the
 * cache only for a pull request under the preset.
 */
export function flakeRequests(
	cache: CacheScope,
	{ target, run }: FlakeRoots,
	shouldCreateCache: boolean
): AuthorizationDetails[] {
	return [
		...(shouldCreateCache
			? [
					cacheCreateAuthorizationDetails({ cache }),
					cacheRemoveAuthorizationDetails({ cache })
				]
			: []),
		pushAuthorizationDetails({
			cache,
			attest: true,
			root: target,
			runRoot: run
		}),
		rootListAuthorizationDetails({ cache, root: target }),
		rootEnsureAuthorizationDetails({ cache, root: target }),
		confirmAuthorizationDetails({ cache })
	];
}

// The push action never passes --no-attest, so the push that it runs requests
// the attestation operations even when the workflow skips signing. The workflow
// appends the builder's Nix system to the root. The model uses the system of
// the workflow's default runner, and checkRootGrantPrefixes then requires a
// grant for the whole prefix, which covers every other system.
function installableRequests(
	cache: CacheScope,
	rootPrefix: string,
	shouldAttest: boolean
): AuthorizationDetails[] | undefined {
	const retentionRoot =
		rootPrefix === '' ? undefined : root(`${rootPrefix}/x86_64-linux`);

	if (rootPrefix !== '' && retentionRoot === undefined) {
		return;
	}

	return [
		pushAuthorizationDetails({
			cache,
			attest: true,
			...(retentionRoot !== undefined && { root: retentionRoot })
		}),
		...(shouldAttest ? [attestAttachAuthorizationDetails({ cache })] : [])
	];
}

function branchFilterFinding(
	trigger: WorkflowTrigger,
	branch: string,
	remedy: FilterRemedy
): CheckFinding | undefined {
	for (const filter of ['branches', 'branches-ignore'] as const) {
		const globs = trigger.filters[filter];

		if (globs === undefined) {
			continue;
		}

		const unsupported = globs.find(
			(glob) => ReferencePattern.parse(glob) === undefined
		);

		if (unsupported !== undefined) {
			return new ReferenceFilterUnsupportedFinding(filter, unsupported);
		}

		const isMatched = globs.some(
			(glob) => ReferencePattern.parse(glob)?.matches(branch) === true
		);

		if (isMatched !== (filter === 'branches')) {
			return new ReferenceFilterExcludesFinding(filter, globs, branch, remedy);
		}
	}

	return undefined;
}

function presetBranchFinding(
	context: ModelContext,
	trigger: BranchTrigger,
	branch: string
): CheckFinding | undefined {
	if (!context.isPreset || context.configuredBranch === branch) {
		return undefined;
	}

	return new PublicationUnmodelledFinding(
		trigger === 'schedule'
			? `the branch input (${context.configuredBranch}) differs from the repository default branch ${branch}; set the branch input to ${branch}`
			: `the branch input (${context.configuredBranch}) differs from the checked branch ${branch}; set the branch input to ${branch} or pass --branch ${context.configuredBranch}`
	);
}

function branchReference(
	context: ModelContext,
	trigger: BranchTrigger,
	branch: string
): TriggerReference | CheckFinding {
	return (
		presetBranchFinding(context, trigger, branch) ?? {
			trigger,
			ref: { kind: 'branch', name: branch }
		}
	);
}

// When the preset's branch input is the default branch, model its push and
// manual runs on the default branch, as if the selected revision were merged
// into it.
function branchRunBranch(context: ModelContext): string {
	return context.isPreset && context.configuredBranch === context.defaultBranch
		? context.defaultBranch
		: context.selectedBranch;
}

function pushReferences(
	context: ModelContext,
	trigger: WorkflowTrigger
): (TriggerReference | CheckFinding)[] {
	const { filters } = trigger;
	const hasTagFilter =
		filters.tags !== undefined || filters['tags-ignore'] !== undefined;
	const hasBranchFilter =
		filters.branches !== undefined || filters['branches-ignore'] !== undefined;
	const branch = branchRunBranch(context);
	const references: (TriggerReference | CheckFinding)[] = [];

	const remedy: FilterRemedy =
		context.isPreset && context.configuredBranch === context.defaultBranch
			? 'change-filter'
			: 'select-branch';

	if (hasBranchFilter || !hasTagFilter) {
		references.push(
			branchFilterFinding(trigger, branch, remedy) ??
				branchReference(context, 'push', branch)
		);
	}

	if (!hasBranchFilter && !hasTagFilter) {
		references.push(
			context.isPreset
				? new PresetPushFilterFinding(context.configuredBranch)
				: new PushCoverageFinding(branch)
		);
	}

	if (!hasTagFilter) {
		return references;
	}

	if (context.isPreset) {
		return [...references, new PresetTagPushFinding()];
	}

	if (filters['tags-ignore'] !== undefined) {
		return [
			...references,
			new TagsIgnoreUnmodelledFinding(filters['tags-ignore'])
		];
	}

	const tagGlobs = filters.tags ?? [];

	for (const glob of tagGlobs) {
		const pattern = ReferencePattern.parse(glob);

		references.push(
			pattern === undefined
				? new ReferenceFilterUnsupportedFinding('tags', glob)
				: { trigger: 'push', ref: { kind: 'tag', pattern } }
		);
	}

	return references;
}

function triggerReferences(
	context: ModelContext,
	trigger: WorkflowTrigger
): (TriggerReference | CheckFinding)[] {
	switch (trigger.event) {
		case 'push': {
			return pushReferences(context, trigger);
		}
		case 'pull_request': {
			return [
				branchFilterFinding(trigger, context.defaultBranch, 'none') ?? {
					trigger: 'pull_request',
					ref: { kind: 'pull-request' }
				}
			];
		}
		case 'schedule': {
			return [branchReference(context, 'schedule', context.defaultBranch)];
		}
		case 'workflow_dispatch': {
			const branch = branchRunBranch(context);

			return [
				branchReference(context, 'workflow_dispatch', branch),
				...(context.isPreset ? [] : [new ManualRunBranchFinding(branch)])
			];
		}
		default: {
			return [
				new PublicationUnmodelledFinding(
					`the check does not model '${trigger.event}' events`
				)
			];
		}
	}
}

function claimsForReference(
	tenant: URL,
	identity: RepositoryIdentity,
	job: DiscoveredPublishingJob,
	entry: TriggerReference
): GithubActionsClaims {
	if (entry.trigger === 'pull_request') {
		return githubPullRequestClaims(tenant, identity, {
			pullRequestNumber: 1,
			workflowReference: job.workflowRef
		});
	}

	if (entry.ref.kind === 'tag') {
		return githubTagPushClaims(tenant, identity, {
			tag: entry.ref.pattern.example(),
			workflowReference: job.workflowRef
		});
	}

	return githubBranchClaims(tenant, identity, {
		branch: entry.ref.name,
		eventName: entry.trigger,
		workflowReference: job.workflowRef
	});
}

function unmodelled(reason: string): PublicationModel {
	return {
		cases: [],
		findings: [{ finding: new PublicationUnmodelledFinding(reason) }]
	};
}

export function modelPublishingJob(
	job: DiscoveredPublishingJob,
	identity: RepositoryIdentity,
	tenant: URL,
	branch: string
): PublicationModel {
	const findings: PublishingJobFinding[] = [];
	const cases: PublicationCase[] = [];
	const mode = scalar(job, 'preset');

	if (mode === undefined) {
		return unmodelled('preset must be a literal string');
	}

	const cache = jobCache(job);

	if (cache.outcome === 'unresolved') {
		return unmodelled(cache.reason);
	}

	const isPreset = isPresetJob(job);
	// The flake workflow reads `branch` only with the preset, and only the flake
	// workflow has a `reuse-view` input.
	const configuredBranch = isPreset ? scalar(job, 'branch', 'main') : branch;

	if (configuredBranch === undefined) {
		return unmodelled('branch must be a literal string');
	}

	const reuseView = job.kind === 'flake' ? scalar(job, 'reuse-view') : '';

	if (reuseView === undefined) {
		return unmodelled('reuse-view must be a literal string');
	}

	const rootInput = job.kind === 'flake' ? 'root-prefix' : 'root';
	const rootPrefix = scalar(job, rootInput);

	if (rootPrefix === undefined) {
		return unmodelled(`${rootInput} must be a literal string`);
	}

	if (mode !== '' && !isPreset && job.kind === 'flake') {
		return unmodelled(`preset '${mode}' is not supported`);
	}

	if (mode === '' && rootPrefix === '' && job.kind === 'flake') {
		return unmodelled('root-prefix is required without a preset');
	}

	if (isPreset && (rootPrefix !== '' || cache.scope.kind !== 'default')) {
		return unmodelled(
			'the preset cannot be combined with cache or root-prefix'
		);
	}

	if (reuseView !== '' && job.kind === 'flake') {
		findings.push({ finding: new CustomReuseViewFinding(reuseView) });
	}

	const attestInput = job.inputs.attest;

	if (
		attestInput !== undefined &&
		typeof attestInput !== 'boolean' &&
		job.kind === 'installable'
	) {
		return unmodelled('attest must be a literal boolean');
	}

	const context: ModelContext = {
		isPreset,
		configuredBranch,
		selectedBranch: branch,
		defaultBranch: identity.defaultBranch
	};

	for (const trigger of job.triggers) {
		if (trigger.undecidedConditions !== undefined) {
			findings.push({
				trigger: trigger.event,
				finding: new JobConditionUndecidedFinding(trigger.undecidedConditions)
			});
		}

		if (trigger.hasPathFilter) {
			findings.push({
				trigger: trigger.event,
				finding: new PathFilterNotModelledFinding()
			});
		}

		if (trigger.isSameRepositoryOnly === true) {
			findings.push({
				trigger: trigger.event,
				finding: new ForkPullRequestFinding()
			});
		}

		for (const entry of triggerReferences(context, trigger)) {
			if (entry instanceof CheckFinding) {
				findings.push({ trigger: trigger.event, finding: entry });
				continue;
			}

			const isPullRequest = entry.trigger === 'pull_request';
			const claims = claimsForReference(tenant, identity, job, entry);

			if (job.kind === 'installable') {
				const requests = installableRequests(
					cache.scope,
					rootPrefix,
					attestInput !== false
				);

				if (requests === undefined) {
					return unmodelled(`root '${rootPrefix}' is invalid`);
				}

				cases.push({ ...entry, claims, requests });
				continue;
			}

			const publicationCache: CacheScope =
				isPreset && isPullRequest
					? {
							kind: 'named',
							name: cacheNameSchema.parse(
								pullRequestCacheName(identity.repositoryId, 1)
							)
						}
					: cache.scope;
			const selectedRoot = isPreset
				? `github:${identity.fullName}/${isPullRequest ? 'pr-1' : configuredBranch}`
				: rootPrefix;
			const roots = flakeRoots(selectedRoot);

			if (roots === undefined) {
				return unmodelled(`root-prefix '${selectedRoot}' is invalid`);
			}

			const requests = flakeRequests(
				publicationCache,
				roots,
				isPreset && isPullRequest
			);

			const hasReuseView = isPreset ? !isPullRequest : reuseView !== '';

			cases.push({
				...entry,
				claims,
				requests,
				...(hasReuseView && {
					reuseView: {
						name:
							reuseView === ''
								? pullRequestViewName(identity.repositoryId)
								: reuseView,
						destination: cacheUrl(tenant, cache.scope)
					}
				})
			});
		}
	}

	return { cases, findings };
}
