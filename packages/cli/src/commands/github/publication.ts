import { cacheUrl, parseTenantCacheUrl } from '@cupboard/nix-store/cache-url';
import {
	cacheNameSchema,
	type CacheScope,
	isSameCacheScope,
	type RootName
} from '@cupboard/nix-store/scalars';
import { canonicalHref } from '@cupboard/nix-store/url';
import { type AuthorizationDetails } from '@cupboard/protocol/grants';
import { readResourcesSchema } from '@cupboard/protocol/read-access';

import {
	attestAttachAuthorizationDetails,
	cacheCreateAuthorizationDetails,
	cacheLifecycleAuthorizationDetails,
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
	githubMergedPullRequestClaims,
	githubPullRequestClaims,
	githubReleaseClaims,
	githubTagPushClaims
} from './claims.ts';
import { pullRequestCacheName, pullRequestViewName } from './convention.ts';
import {
	type DiscoveredPublishingJob,
	type ReferenceFilterKey,
	type WorkflowTrigger
} from './discovery.ts';
import { CheckFinding } from './finding.ts';
import {
	isPullRequestConditionUndecided,
	pullRequestLifecycleOutcome,
	pullRequestPublicationOutcome
} from './pull-request-lifecycle.ts';
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
			readonly trigger: 'release';
			readonly ref: { readonly kind: 'release-tag' };
	  }
	| {
			readonly trigger: 'workflow_dispatch' | 'schedule';
			readonly ref: BranchReference;
	  };

export interface ReuseViewRequirement {
	readonly name: string;
	readonly destination: URL;
}

export type PublicationCase = TriggerReference & {
	readonly lifecycle?: 'closed' | 'merged-close';
	readonly mergedCloseBlocked?: true;
	readonly mergedCloseRequests?: readonly AuthorizationDetails[];
	readonly claims: GithubActionsClaims;
	readonly requests: readonly AuthorizationDetails[];
	readonly cache?: CacheScope;
	readonly rootPrefix?: string;
	readonly releaseRootTemplate?: string;
	readonly pullRequestTemplates?: {
		readonly cache: string;
		readonly root: string;
	};
	readonly reuseView?: ReuseViewRequirement;
	readonly readCaches?: readonly CacheScope[];
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

export class TagPatternCoverageFinding extends CheckFinding {
	readonly status = 'unverified' as const;

	constructor(public readonly pattern: string) {
		super('tag coverage');
	}

	detail(): string {
		return `the tags filter '${this.pattern}' admits several tag names with different OIDC claims; the check does not test a fabricated tag; use an exact tag filter or review trust rules for every matching tag`;
	}
}

export class BranchFilterCoverageFinding extends CheckFinding {
	readonly status = 'unverified' as const;

	constructor(
		public readonly filter: 'branches' | 'branches-ignore',
		public readonly patterns: readonly string[],
		public readonly branch: string
	) {
		super('branch coverage');
	}

	detail(): string {
		return `the ${this.filter} filter (${this.patterns.join(', ')}) can start runs for branches other than ${this.branch}; the check models only ${this.branch}; use one exact branch filter or review trust rules for every matching branch`;
	}
}

export class PresetTagPushFinding extends CheckFinding {
	readonly status = 'failed' as const;

	constructor() {
		super('ref filter');
	}

	detail(): string {
		return 'a flake preset run fails on a tag push, because the preset accepts only pull requests and pushes to its branch; publish tags from a job without the preset';
	}
}

export class PushCoverageFinding extends CheckFinding {
	readonly status = 'unverified' as const;

	constructor(public readonly branch: string) {
		super('push coverage');
	}

	detail(): string {
		return `the push event has no branch or tag filter, so pushes to every branch and tag start runs; the check models only pushes to ${this.branch}; add branch or tag filters for the refs that should publish`;
	}
}

export class PresetPushFilterFinding extends CheckFinding {
	readonly status = 'failed' as const;

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
	readonly status = 'unverified' as const;

	constructor(public readonly branch: string) {
		super('manual run');
	}

	detail(): string {
		return `the check models workflow_dispatch on ${this.branch}, but GitHub can start this workflow on other branches with different OIDC claims; review trust rules for those branches`;
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

interface PublicationInput {
	readonly value: string;
	readonly template?: string;
	readonly releaseTemplate?: string;
}

const repositoryExpression = /\$\{\{\s*github\.repository\s*\}\}/gu;
const pullRequestNumberExpression =
	/\$\{\{\s*github\.event\.pull_request\.number\s*\}\}/gu;
const releaseTagExpression =
	/\$\{\{\s*github\.event\.release\.tag_name\s*\}\}/gu;

function publicationInput(
	job: DiscoveredPublishingJob,
	key: string,
	identity: RepositoryIdentity
): PublicationInput | undefined {
	const input = job.inputs[key] ?? '';

	if (typeof input !== 'string') {
		return;
	}

	const repository = input.replaceAll(
		repositoryExpression,
		() => identity.fullName
	);
	const occurrences = repository
		.matchAll(pullRequestNumberExpression)
		.toArray();

	if (occurrences.length > 1) {
		return;
	}

	const releaseOccurrences = repository
		.matchAll(releaseTagExpression)
		.toArray();
	if (
		releaseOccurrences.length > 1 ||
		(releaseOccurrences.length > 0 && occurrences.length > 0)
	) {
		return;
	}
	const value = repository
		.replaceAll(pullRequestNumberExpression, '1')
		.replaceAll(releaseTagExpression, 'v0.0.0');

	if (value.includes('${{')) {
		return;
	}

	return {
		value,
		...(releaseOccurrences.length === 1 && {
			releaseTemplate: repository.replaceAll(releaseTagExpression, '{tag}')
		}),
		...(occurrences.length === 1 && {
			template: repository.replaceAll(pullRequestNumberExpression, '{pr}')
		})
	};
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

export function isReadOnlyJob(job: DiscoveredPublishingJob): boolean {
	return (
		job.inputs.publish === 'none' ||
		(job.kind === 'flake' && job.inputs.push === false)
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

	return cacheForInput(job, input);
}

function cacheForInput(job: DiscoveredPublishingJob, input: string): JobCache {
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
 * The publication requests of one flake workflow run. The workflow creates
 * and closes or reopens the cache only for a pull request under the preset.
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
					cacheLifecycleAuthorizationDetails({ cache, action: 'close' }),
					cacheLifecycleAuthorizationDetails({ cache, action: 'reopen' })
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

interface InstallableRoots {
	readonly target?: RootName;
	readonly run?: RootName;
}

function installableRoots(
	rootPrefix: string,
	context: {
		readonly identity: RepositoryIdentity;
		readonly hasRunRoot: boolean;
	},
	entry: TriggerReference
): InstallableRoots | undefined {
	if (rootPrefix !== '') {
		const target = root(`${rootPrefix}/x86_64-linux`);

		if (target === undefined) {
			return;
		}

		if (!context.hasRunRoot) {
			return { target };
		}

		const run = root(`${target}/_cupboard-run/1`);

		if (run === undefined) {
			return;
		}

		return { target, run };
	}

	if (!context.hasRunRoot) {
		return {};
	}

	const referenceName =
		entry.ref.kind === 'pull-request'
			? '1/merge'
			: entry.ref.kind === 'release-tag'
				? 'v0.0.0'
				: entry.ref.kind === 'tag'
					? entry.ref.pattern.example()
					: entry.ref.name;
	const run = root(
		`github:${context.identity.fullName}/${referenceName}/_cupboard-run/1`
	);

	if (run === undefined) {
		return;
	}

	return { run };
}

// The push action requests attestation operations even when signing is off.
// Explicit root prefixes include the runner's system. The grant check requires
// the whole prefix so every runner system remains authorised.
function installableRequests(
	cache: CacheScope,
	{ target, run }: InstallableRoots,
	shouldAttest: boolean
): AuthorizationDetails[] {
	return [
		pushAuthorizationDetails({
			cache,
			attest: true,
			...(target !== undefined && { root: target }),
			runRoot: run
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
		const filterFinding = branchFilterFinding(trigger, branch, remedy);

		references.push(filterFinding ?? branchReference(context, 'push', branch));

		if (filterFinding === undefined && hasBranchFilter) {
			const filter =
				filters.branches === undefined ? 'branches-ignore' : 'branches';
			const patterns = filters[filter] ?? [];

			if (
				filter !== 'branches' ||
				patterns.some((pattern) => pattern !== branch)
			) {
				references.push(
					new BranchFilterCoverageFinding(filter, patterns, branch)
				);
			}
		}
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

		if (pattern === undefined) {
			references.push(new ReferenceFilterUnsupportedFinding('tags', glob));
			continue;
		}

		if (pattern.glob.includes('*')) {
			references.push(new TagPatternCoverageFinding(glob));
			continue;
		}

		references.push({ trigger: 'push', ref: { kind: 'tag', pattern } });
	}

	return references;
}

function triggerReferences(
	context: ModelContext,
	trigger: WorkflowTrigger
): (TriggerReference | CheckFinding)[] {
	switch (trigger.event) {
		case 'release': {
			return [
				context.isPreset
					? new PublicationUnmodelledFinding(
							'the flake preset does not support release events'
						)
					: { trigger: 'release', ref: { kind: 'release-tag' } }
			];
		}
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
	audience: string | URL,
	identity: RepositoryIdentity,
	job: DiscoveredPublishingJob,
	entry: TriggerReference
): GithubActionsClaims {
	if (entry.trigger === 'release') {
		return githubReleaseClaims(audience, identity, {
			tag: 'v0.0.0',
			workflowReference: job.workflowRef
		});
	}
	if (entry.trigger === 'pull_request') {
		return githubPullRequestClaims(audience, identity, {
			pullRequestNumber: 1,
			workflowReference: job.workflowRef
		});
	}

	if (entry.ref.kind === 'tag') {
		return githubTagPushClaims(audience, identity, {
			tag: entry.ref.pattern.example(),
			workflowReference: job.workflowRef
		});
	}

	return githubBranchClaims(audience, identity, {
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

function jobReadCaches(
	job: DiscoveredPublishingJob,
	tenant: URL,
	cache: CacheScope
):
	| { readonly outcome: 'resolved'; readonly caches: readonly CacheScope[] }
	| { readonly outcome: 'unresolved'; readonly reason: string } {
	const input = scalar(job, 'read-caches');
	if (input === undefined) {
		return {
			outcome: 'unresolved',
			reason:
				'read-caches must be a literal newline-separated list of cache URLs; resolve expressions before checking or repairing.'
		};
	}
	const entries = input
		.split(/\r?\n/u)
		.map((entry) => entry.trim())
		.filter((entry) => entry !== '');
	if (entries.length === 0) {
		return { outcome: 'resolved', caches: [] };
	}
	if (job.kind !== 'flake') {
		return {
			outcome: 'unresolved',
			reason:
				'read-caches is supported by the flake publishing workflow; remove it from the installable workflow.'
		};
	}
	if ((job.readCredentialWiring?.view ?? 'none') !== 'none') {
		return {
			outcome: 'unresolved',
			reason:
				'read-caches requires OIDC reads; omit the default static read credential and provide complete destination credentials separately.'
		};
	}
	if (job.privateSubstitutersWiring !== undefined) {
		return {
			outcome: 'unresolved',
			reason:
				'The check cannot compare read-caches with secret private_substituters; verify that the same cache does not also use a static credential before repairing.'
		};
	}
	const caches: CacheScope[] = [];
	for (const entry of entries) {
		let target: ReturnType<typeof parseTenantCacheUrl>;
		try {
			target = parseTenantCacheUrl(new URL(entry));
		} catch {
			return {
				outcome: 'unresolved',
				reason:
					'read-caches must use canonical HTTP(S) cache URLs without credentials, a query or a fragment.'
			};
		}
		if (canonicalHref(target.tenantUrl) !== canonicalHref(tenant)) {
			return {
				outcome: 'unresolved',
				reason: 'Every read-caches URL must belong to the selected tenant.'
			};
		}
		if (
			isSameCacheScope(cache, target.cache) &&
			(job.readCredentialWiring?.cache ?? 'none') !== 'none'
		) {
			return {
				outcome: 'unresolved',
				reason:
					'Do not request OIDC reads for a destination with an explicit static credential.'
			};
		}
		if (caches.every((selected) => !isSameCacheScope(selected, target.cache))) {
			caches.push(target.cache);
		}
	}
	return { outcome: 'resolved', caches };
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

	const audience = scalar(job, 'audience')?.trim();
	if (audience === undefined) {
		return unmodelled('audience must be a literal string');
	}

	const cacheInput = publicationInput(job, 'cache', identity);

	if (cacheInput === undefined) {
		return unmodelled('cache must be a literal string');
	}

	const cache = cacheForInput(job, cacheInput.value);

	if (cache.outcome === 'unresolved') {
		return unmodelled(cache.reason);
	}

	const readCaches = jobReadCaches(job, tenant, cache.scope);
	if (readCaches.outcome === 'unresolved') {
		return unmodelled(readCaches.reason);
	}

	const isPreset = isPresetJob(job);
	const isReadOnly = isReadOnlyJob(job);
	const managePrCache =
		job.kind === 'installable' ? job.inputs['manage-pr-cache'] : undefined;
	if (managePrCache !== undefined && typeof managePrCache !== 'boolean') {
		return unmodelled('manage-pr-cache must be a literal boolean');
	}
	if (managePrCache === true && cache.scope.kind === 'default') {
		return unmodelled('manage-pr-cache requires a named cache');
	}
	const cacheAccessMode = scalar(job, 'cache-access-mode');

	if (
		isPreset &&
		!isReadOnly &&
		(cacheAccessMode === undefined ||
			!['', 'public', 'private'].includes(cacheAccessMode))
	) {
		return unmodelled('cache-access-mode must be public, private or omitted');
	}
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
	const rootInputValue = publicationInput(job, rootInput, identity);

	if (rootInputValue === undefined) {
		return unmodelled(`${rootInput} must be a literal string`);
	}

	const rootPrefix = rootInputValue.value;
	const releaseRootTemplate = rootInputValue.releaseTemplate;
	if (
		cacheInput.releaseTemplate !== undefined ||
		(releaseRootTemplate !== undefined && job.kind !== 'installable')
	) {
		return unmodelled(
			'release tag expressions require a literal cache and an installable workflow root'
		);
	}

	const hasPullRequestExpression =
		cacheInput.template !== undefined || rootInputValue.template !== undefined;
	if (
		hasPullRequestExpression &&
		(job.kind !== 'installable' ||
			cacheInput.template === undefined ||
			rootInputValue.template === undefined)
	) {
		return unmodelled(
			'PR cache and root expressions must both include github.event.pull_request.number in an installable workflow'
		);
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

	if (attestInput !== undefined && typeof attestInput !== 'boolean') {
		return unmodelled('attest must be a literal boolean');
	}

	const pullRequestTemplates =
		cacheInput.template !== undefined && rootInputValue.template !== undefined
			? {
					cache: cacheInput.template,
					root: `${rootInputValue.template}/`
				}
			: undefined;

	const context: ModelContext = {
		isPreset,
		configuredBranch,
		selectedBranch: branch,
		defaultBranch: identity.defaultBranch
	};

	for (const trigger of job.triggers) {
		if (
			trigger.undecidedConditions !== undefined &&
			(trigger.event !== 'pull_request' ||
				isPullRequestConditionUndecided(job, identity))
		) {
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

			if (releaseRootTemplate !== undefined && entry.trigger !== 'release') {
				findings.push({
					trigger: entry.trigger,
					finding: new PublicationUnmodelledFinding(
						'github.event.release.tag_name is available only for release runs'
					)
				});
				continue;
			}
			if (!isReadOnly && rootPrefix === '' && entry.trigger === 'release') {
				return unmodelled('release publication requires an explicit root');
			}
			const isPullRequest = entry.trigger === 'pull_request';
			if (hasPullRequestExpression && !isPullRequest) {
				findings.push({
					trigger: entry.trigger,
					finding: new PublicationUnmodelledFinding(
						'github.event.pull_request.number is available only for pull_request runs'
					)
				});
				continue;
			}
			const claims = claimsForReference(
				audience === '' ? tenant : audience,
				identity,
				job,
				entry
			);

			if (job.kind === 'installable') {
				const roots = isReadOnly
					? undefined
					: installableRoots(
							rootPrefix,
							{ identity, hasRunRoot: job.installableRunRoot === true },
							entry
						);

				if (roots === undefined && !isReadOnly) {
					return unmodelled(`root '${rootPrefix}' is invalid`);
				}

				const requests =
					roots === undefined
						? []
						: installableRequests(cache.scope, roots, attestInput !== false);

				cases.push({
					...entry,
					claims,
					...(releaseRootTemplate !== undefined && {
						releaseRootTemplate: `${releaseRootTemplate.replace(/\/$/u, '')}/`
					}),
					...(rootInputValue.value !== scalar(job, rootInput) &&
						pullRequestTemplates === undefined && { rootPrefix }),
					...(cacheInput.value !== scalar(job, 'cache') &&
						cacheInput.template === undefined && { cache: cache.scope }),
					...(pullRequestTemplates !== undefined && {
						cache: cache.scope,
						pullRequestTemplates
					}),
					requests: [
						...(managePrCache === true && isPullRequest && !isReadOnly
							? [
									cacheCreateAuthorizationDetails({ cache: cache.scope }),
									cacheLifecycleAuthorizationDetails({
										cache: cache.scope,
										action: 'close'
									}),
									cacheLifecycleAuthorizationDetails({
										cache: cache.scope,
										action: 'reopen'
									})
								]
							: []),
						...requests
					]
				});
				continue;
			}

			const publicationCache: CacheScope =
				isPreset && isPullRequest && !isReadOnly
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

			const requests = isReadOnly
				? []
				: flakeRequests(publicationCache, roots, isPreset && isPullRequest);

			const hasReuseView = isPreset ? !isPullRequest : reuseView !== '';
			const additionalCaches = readCaches.caches.filter(
				(selected) => !isSameCacheScope(selected, publicationCache)
			);
			if (
				readCaches.caches.length > 0 &&
				!readResourcesSchema.safeParse([
					...[publicationCache, ...additionalCaches].map((selected) => ({
						type: 'cupboard_cache',
						cache: selected,
						mode: 'content'
					})),
					...(hasReuseView
						? [
								{
									type: 'cupboard_view',
									view:
										reuseView === ''
											? pullRequestViewName(identity.repositoryId)
											: reuseView
								}
							]
						: [])
				]).success
			) {
				return unmodelled(
					'read-caches and the destination and reuse view must select at most sixteen distinct resources.'
				);
			}

			cases.push({
				...entry,
				claims,
				...(rootInputValue.value !== scalar(job, rootInput) && { rootPrefix }),
				...(cacheInput.value !== scalar(job, 'cache') && {
					cache: cache.scope
				}),
				requests,
				...(additionalCaches.length > 0 && { readCaches: additionalCaches }),
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

	return {
		cases: cases.map((publication) => {
			if (publication.trigger !== 'pull_request') {
				return publication;
			}

			const closed = pullRequestLifecycleOutcome(job, 'closed', identity);
			const merged = pullRequestLifecycleOutcome(job, 'merged-close', identity);
			const reopened = pullRequestLifecycleOutcome(job, 'reopened', identity);
			const closeRequests = publication.requests.filter((request) =>
				request.some(
					(detail) =>
						detail.type === 'cupboard_cache' &&
						detail.actions.includes('cache:close')
				)
			);
			const isCloseOnly =
				pullRequestPublicationOutcome(job, identity) === false;
			const selected: PublicationCase = isCloseOnly
				? {
						trigger: publication.trigger,
						ref: publication.ref,
						claims: publication.claims,
						...(publication.cache !== undefined && {
							cache: publication.cache
						}),
						...(publication.pullRequestTemplates !== undefined && {
							pullRequestTemplates: publication.pullRequestTemplates
						}),
						requests: publication.requests
					}
				: publication;
			return {
				...selected,
				...(isCloseOnly && { lifecycle: 'closed' as const }),
				...(closeRequests.length > 0 &&
					merged === false && { mergedCloseBlocked: true as const }),
				...(closeRequests.length > 0 &&
					closed === false &&
					merged !== false && { mergedCloseRequests: closeRequests }),
				requests: publication.requests.filter(
					(request) =>
						(!isCloseOnly || closeRequests.includes(request)) &&
						request.every(
							(detail) =>
								!(
									detail.type === 'cupboard_cache' &&
									((closed === false &&
										detail.actions.includes('cache:close')) ||
										(reopened === false &&
											detail.actions.includes('cache:reopen')))
								)
						)
				)
			};
		}),
		findings:
			job.triggers.every((trigger) => trigger.event === 'pull_request') &&
			pullRequestPublicationOutcome(job, identity) === false
				? findings.filter(
						({ finding }) => !(finding instanceof CustomReuseViewFinding)
					)
				: findings
	};
}

/**
 * Includes the merged-close identity when a PR run manages its cache.
 */
export function withMergedCloseCases(
	cases: readonly PublicationCase[],
	identity: RepositoryIdentity
): readonly PublicationCase[] {
	const lifecycle: PublicationCase[] = [];

	for (const publication of cases) {
		if (
			publication.trigger !== 'pull_request' ||
			publication.mergedCloseBlocked === true
		) {
			continue;
		}

		const requests = (
			publication.mergedCloseRequests ?? publication.requests
		).filter(
			(request) =>
				request.length > 0 &&
				request.every(
					(detail) =>
						detail.type === 'cupboard_cache' &&
						detail.actions.length === 1 &&
						detail.actions[0] === 'cache:close'
				)
		);

		if (requests.length === 0) {
			continue;
		}

		const audience = publication.claims.aud;
		const workflowReference = publication.claims.job_workflow_ref;

		if (audience === undefined || workflowReference === undefined) {
			throw new Error(
				'Modelled merged-close claims require an audience and workflow reference.'
			);
		}

		lifecycle.push({
			trigger: 'pull_request',
			ref: { kind: 'pull-request' },
			lifecycle: 'merged-close',
			...(publication.cache !== undefined && { cache: publication.cache }),
			...(publication.pullRequestTemplates !== undefined && {
				pullRequestTemplates: publication.pullRequestTemplates
			}),
			requests,
			claims: githubMergedPullRequestClaims(audience, identity, {
				baseBranch: identity.defaultBranch,
				workflowReference
			})
		});
	}

	return [...cases, ...lifecycle];
}
