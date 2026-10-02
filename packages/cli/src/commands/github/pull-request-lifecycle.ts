import { cacheNameSchema } from '@cupboard/nix-store/scalars';

import { type RepositoryIdentity } from '../oidc-trust/github.ts';

import {
	type DiscoveredPublishingJob,
	type UnverifiedPublishingJob,
	type WorkflowTrigger
} from './discovery.ts';
import { CheckFinding, FailedCheckFinding } from './finding.ts';
import {
	type ConditionOutcome,
	jobConditionOutcome,
	jobDependencyOutcome
} from './job-condition.ts';
import { ReferencePattern } from './reference-pattern.ts';

export type PullRequestLifecycle = 'closed' | 'merged-close' | 'reopened';

const lifecycleEvents: readonly PullRequestLifecycle[] = [
	'closed',
	'merged-close',
	'reopened'
];
const defaultActivities = ['opened', 'synchronize', 'reopened'];
const knownActivities = new Set([
	'assigned',
	'unassigned',
	'labeled',
	'unlabeled',
	'opened',
	'edited',
	'closed',
	'reopened',
	'synchronize',
	'converted_to_draft',
	'ready_for_review',
	'locked',
	'unlocked',
	'review_requested',
	'review_request_removed',
	'auto_merge_enabled',
	'auto_merge_disabled',
	'enqueued',
	'dequeued',
	'milestoned',
	'demilestoned'
]);

export function isPullRequestCacheManaged(
	job: DiscoveredPublishingJob
): boolean {
	if (job.inputs.publish === 'none') {
		return false;
	}

	return job.kind === 'flake'
		? job.inputs.preset === 'pull-request-and-branch' &&
				job.inputs.push !== false
		: job.inputs['manage-pr-cache'] === true;
}

function managementOutcome(job: DiscoveredPublishingJob): ConditionOutcome {
	if (isPullRequestCacheManaged(job)) {
		return true;
	}
	if (job.inputs.publish === 'none' || job.inputs.push === false) {
		return false;
	}
	if (job.kind === 'installable') {
		if (
			job.inputs['manage-pr-cache'] === undefined ||
			job.inputs['manage-pr-cache'] === false
		) {
			return false;
		}
		return undefined;
	}
	if (
		typeof job.inputs.preset === 'string' &&
		job.inputs.preset.includes('${{')
	) {
		return undefined;
	}
	return false;
}

function pullRequestTrigger(
	job: DiscoveredPublishingJob
): WorkflowTrigger | undefined {
	return (
		job.triggers.find((trigger) => trigger.event === 'pull_request') ??
		job.excludedPullRequestTrigger
	);
}

export function pullRequestLifecycleOutcome(
	job: DiscoveredPublishingJob,
	lifecycle: PullRequestLifecycle,
	identity: RepositoryIdentity
): ConditionOutcome {
	const trigger = pullRequestTrigger(job);
	if (trigger === undefined) {
		return false;
	}

	const action = lifecycle === 'reopened' ? 'reopened' : 'closed';
	return activityOutcome(
		trigger,
		action,
		lifecycle === 'merged-close',
		identity
	);
}

function activityOutcome(
	trigger: WorkflowTrigger,
	action: string,
	isMerged: boolean,
	identity: RepositoryIdentity
): ConditionOutcome {
	const types = trigger.activityTypes ?? defaultActivities;
	const hasUnknownTypes =
		types === 'unknown' || types.some((type) => !knownActivities.has(type));
	const activity = {
		action,
		merged: isMerged,
		isCancelled: false,
		...(isMerged && { ref: `refs/heads/${identity.defaultBranch}` })
	};
	const outcomes = new Set([
		...(trigger.undecidedConditions ?? []).map((condition) =>
			jobConditionOutcome(condition, 'pull_request', 'repository', activity)
		),
		...(trigger.dependencyGates ?? []).map((gate) =>
			jobDependencyOutcome(gate, activity)
		)
	]);

	if (outcomes.has(false) || (!hasUnknownTypes && !types.includes(action))) {
		return false;
	}

	if (hasUnknownTypes || outcomes.has(undefined)) {
		return undefined;
	}

	if (trigger.hasPathFilter) {
		return undefined;
	}

	for (const [filter, patterns] of Object.entries(trigger.filters)) {
		const matches = new Set(
			patterns.map((pattern) =>
				ReferencePattern.parse(pattern)?.matches(identity.defaultBranch)
			)
		);
		if (matches.has(undefined)) {
			return undefined;
		}
		if (
			(filter === 'branches' && !matches.has(true)) ||
			(filter === 'branches-ignore' && matches.has(true))
		) {
			return false;
		}
	}

	return true;
}

function activityOutcomes(
	job: DiscoveredPublishingJob,
	identity: RepositoryIdentity
): ConditionOutcome[] {
	const trigger = pullRequestTrigger(job);
	if (trigger === undefined) {
		return [false];
	}
	const types = trigger.activityTypes ?? defaultActivities;
	if (types === 'unknown' || types.some((type) => !knownActivities.has(type))) {
		return [undefined];
	}
	return types.flatMap((action) => [
		activityOutcome(trigger, action, false, identity),
		...(action === 'closed'
			? [activityOutcome(trigger, action, true, identity)]
			: [])
	]);
}

export function isPullRequestConditionUndecided(
	job: DiscoveredPublishingJob,
	identity: RepositoryIdentity
): boolean {
	return activityOutcomes(job, identity).includes(undefined);
}

export function pullRequestPublicationOutcome(
	job: DiscoveredPublishingJob,
	identity: RepositoryIdentity
): ConditionOutcome {
	const trigger = pullRequestTrigger(job);
	if (trigger === undefined) {
		return false;
	}
	const types = trigger.activityTypes ?? defaultActivities;
	if (types === 'unknown' || types.some((type) => !knownActivities.has(type))) {
		return undefined;
	}
	const outcomes = new Set(
		types
			.filter((action) => action !== 'closed')
			.map((action) => activityOutcome(trigger, action, false, identity))
	);
	if (outcomes.has(true)) {
		return true;
	}
	if (outcomes.has(undefined)) {
		return undefined;
	}
	return false;
}

function cacheIdentity(job: DiscoveredPublishingJob): string | undefined {
	if (job.kind === 'flake') {
		return 'pull-request-template';
	}

	const selected = cacheNameSchema.safeParse(job.inputs.cache);
	return selected.success ? `named:${selected.data}` : undefined;
}

export class PullRequestLifecycleMissingFinding extends FailedCheckFinding {
	constructor(public readonly lifecycle: PullRequestLifecycle) {
		super('pull-request lifecycle');
	}

	detail(): string {
		const action = this.lifecycle === 'reopened' ? 'reopened' : 'closed';
		const operation = this.lifecycle === 'reopened' ? 'reopen' : 'close';
		const merged = this.lifecycle === 'merged-close' ? ' after a merge' : '';
		return `no job in this caller can ${operation} the managed pull-request cache${merged}; include '${action}' in pull_request.types and allow that activity in the calling jobs' if conditions and event filters`;
	}
}

export class PullRequestLifecycleUnverifiedFinding extends CheckFinding {
	readonly status = 'unverified' as const;
	constructor(public readonly lifecycle: PullRequestLifecycle) {
		super('pull-request lifecycle');
	}

	detail(): string {
		return `the check cannot verify ${this.lifecycle} handling for the managed pull-request cache; use literal pull_request.types and cache inputs, and review unresolved job conditions, event filters and possible handlers`;
	}
}

export function pullRequestLifecycleFindings(
	job: DiscoveredPublishingJob,
	identity: RepositoryIdentity,
	jobs: readonly DiscoveredPublishingJob[],
	unverified: readonly UnverifiedPublishingJob[] = []
): {
	readonly trigger: PullRequestLifecycle;
	readonly finding: CheckFinding;
}[] {
	if (
		!isPullRequestCacheManaged(job) ||
		pullRequestTrigger(job) === undefined
	) {
		return [];
	}

	const selected = cacheIdentity(job);
	const candidates = jobs.filter(
		(candidate) =>
			candidate.caller === job.caller &&
			managementOutcome(candidate) !== false &&
			(selected === undefined ||
				cacheIdentity(candidate) === undefined ||
				cacheIdentity(candidate) === selected)
	);

	return lifecycleEvents.flatMap((lifecycle) => {
		const outcomes = new Set(
			candidates.map((candidate) => {
				const outcome = pullRequestLifecycleOutcome(
					candidate,
					lifecycle,
					identity
				);
				if (outcome === false) {
					return outcome;
				}
				if (managementOutcome(candidate) === undefined) {
					return;
				}
				if (candidate === job) {
					return outcome;
				}
				return selected === undefined || cacheIdentity(candidate) === undefined
					? undefined
					: outcome;
			})
		);
		if (outcomes.has(true)) {
			return [];
		}
		return [
			{
				trigger: lifecycle,
				finding:
					outcomes.has(undefined) ||
					unverified.some((candidate) => candidate.caller === job.caller)
						? new PullRequestLifecycleUnverifiedFinding(lifecycle)
						: new PullRequestLifecycleMissingFinding(lifecycle)
			}
		];
	});
}
