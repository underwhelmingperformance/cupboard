export type CheckStatus = 'ok' | 'failed' | 'unverified';

export interface SerialisedCheckFinding {
	readonly check: string;
	readonly status: CheckStatus;
	readonly detail?: string;
}

export abstract class CheckFinding {
	abstract readonly status: CheckStatus;

	constructor(public readonly check: string) {}

	abstract detail(): string | undefined;

	humanDetail(): string | undefined {
		return this.detail();
	}

	render(): string {
		const detail = this.humanDetail();

		return detail === undefined ? this.status : `${this.status}: ${detail}`;
	}

	toJSON(): SerialisedCheckFinding {
		const detail = this.detail();

		return {
			check: this.check,
			status: this.status,
			...(detail !== undefined && { detail })
		};
	}
}

export abstract class FailedCheckFinding extends CheckFinding {
	readonly status = 'failed' as const;
}

export class ReadAuthenticationUnverifiedFinding extends CheckFinding {
	readonly status = 'unverified' as const;

	constructor(public readonly resource: 'cache' | 'view') {
		super('read authentication');
	}

	detail(): string {
		return `the workflow's ${this.resource} read-secret wiring is inherited or ambiguous`;
	}
}

export class ReadAuthenticationConfiguredFinding extends CheckFinding {
	readonly status = 'ok' as const;
	constructor(public readonly resource: 'cache' | 'view') {
		super('read authentication');
	}

	detail(): string {
		return `the workflow declares a complete ${this.resource} read-secret pair; secret values are not inspected`;
	}
}

export class ReadAuthenticationIncompleteFinding extends FailedCheckFinding {
	constructor(public readonly resource: 'cache' | 'view') {
		super('read authentication');
	}

	detail(): string {
		return `the workflow declares only part of a ${this.resource} read-secret pair`;
	}
}

export class PassedCheckFinding extends CheckFinding {
	readonly status = 'ok' as const;

	detail(): undefined {
		return;
	}
}

export class BranchWorkflowTrustFinding extends CheckFinding {
	readonly status = 'ok' as const;

	constructor(public readonly reference: string) {
		super('branch workflow trust');
	}

	detail(): string {
		return `${this.reference}; trust rules accept future edits to this branch workflow`;
	}
}

export class ReuseViewMissingFinding extends FailedCheckFinding {
	constructor(
		check: string,
		public readonly view: string
	) {
		super(check);
	}

	detail(): string {
		return `the ${this.view} view is not defined`;
	}
}

export class ReuseViewSelectorsMismatchFinding extends FailedCheckFinding {
	constructor(
		check: string,
		public readonly cachePrefix: string
	) {
		super(check);
	}

	detail(): string {
		return `stored selectors differ from the single ${this.cachePrefix} prefix setup would write`;
	}
}

export class ReuseViewUnreadableFinding extends FailedCheckFinding {
	constructor(
		check: string,
		public readonly view: string
	) {
		super(check);
	}

	detail(): string {
		return `could not read nix-cache-info from the ${this.view} view`;
	}
}

export class ReuseViewStoreDirectoryMismatchFinding extends FailedCheckFinding {
	constructor(
		check: string,
		public readonly viewStoreDirectory: string,
		public readonly destinationStoreDirectory: string
	) {
		super(check);
	}

	detail(): string {
		return `view advertises store directory ${this.viewStoreDirectory}; the destination advertises ${this.destinationStoreDirectory}`;
	}
}

export class ReuseViewPriorityInsufficientFinding extends FailedCheckFinding {
	constructor(
		check: string,
		public readonly viewPriority: number,
		public readonly destinationPriority: number
	) {
		super(check);
	}

	detail(): string {
		return `view priority ${String(this.viewPriority)} does not exceed the destination's ${String(this.destinationPriority)}`;
	}
}

export class ReuseViewCacheAccessMismatchFinding extends FailedCheckFinding {
	constructor(
		check: string,
		public readonly viewName: string,
		public readonly viewAccess: string,
		public readonly cacheNames: readonly string[],
		public readonly cacheAccess: string
	) {
		super(check);
	}

	detail(): string {
		return `${this.cacheNames.join(', ')} ${this.cacheNames.length === 1 ? 'is' : 'are'} ${this.cacheAccess}; the ${this.viewName} view aggregates only ${this.viewAccess} caches, so the view never serves ${this.cacheNames.length === 1 ? 'it' : 'them'}`;
	}
}

export class ReuseViewAccessModeMismatchFinding extends FailedCheckFinding {
	constructor(
		check: string,
		public readonly viewName: string,
		public readonly viewAccess: string,
		public readonly requestedAccess: string,
		public readonly source:
			'workflow-input' | 'tenant-default' = 'workflow-input'
	) {
		super(check);
	}

	detail(): string {
		const selection =
			this.source === 'workflow-input'
				? `the workflow's cache-access-mode input selects ${this.requestedAccess}. Use a view with ${this.requestedAccess} access, or set cache-access-mode to ${this.viewAccess}`
				: `the tenant's default cache is ${this.requestedAccess}, so the workflow expects a ${this.requestedAccess} reuse view. Use a view with ${this.requestedAccess} access, or change the tenant's default cache access`;
		return `reuse view ${this.viewName} is ${this.viewAccess}; ${selection}.`;
	}
}

export class RootPrefixUnspecifiedFinding extends CheckFinding {
	readonly status = 'unverified' as const;

	detail(): string {
		return "no --root-prefix given; pass the value from the caller's workflow";
	}
}

export class RootPrefixOutsideGrantFinding extends FailedCheckFinding {
	constructor(
		check: string,
		public readonly rootPrefix: string,
		public readonly grantedPrefix: string
	) {
		super(check);
	}

	detail(): string {
		return `${this.rootPrefix} does not nest under the granted ${this.grantedPrefix}`;
	}
}

export class RootGrantPrefixUnverifiedFinding extends CheckFinding {
	readonly status = 'unverified' as const;

	constructor(
		check: string,
		public readonly root: string
	) {
		super(check);
	}

	detail(): string {
		return `the selected rule permits only ${this.root}; the job also creates roots below its root prefix, and no grant covers them`;
	}
}

export class TrustedContributorReuseFinding extends CheckFinding {
	readonly status = 'ok' as const;
	constructor(public readonly isEnabled: boolean) {
		super('reuse direction');
	}
	detail(): string {
		return this.isEnabled
			? 'branch runs reuse only the merged PR cache; enable only for trusted contributors because a PR controls its Nix configuration and builders'
			: 'PR runs reuse the default cache; branch runs build outputs without PR-cache reuse';
	}
}

export class PullRequestsReadPermissionFinding extends CheckFinding {
	readonly status: CheckStatus;
	constructor(public readonly permission: 'granted' | 'missing' | 'unknown') {
		super('pull request lookup permission');
		this.status =
			permission === 'granted'
				? 'ok'
				: permission === 'missing'
					? 'failed'
					: 'unverified';
	}
	detail(): string {
		return this.permission === 'granted'
			? 'the trusted-contributor caller grants pull-requests: read'
			: 'set permissions.pull-requests: read on the job that calls cupboard-flake-publish-trusted.yml';
	}
}

export class PullRequestCacheAccessMismatchFinding extends FailedCheckFinding {
	constructor(
		public readonly caches: readonly string[],
		public readonly expectedAccess: string
	) {
		super('pull-request cache access');
	}
	detail(): string {
		return `${this.caches.join(', ')} has access that differs from the selected ${this.expectedAccess} mode`;
	}
}
