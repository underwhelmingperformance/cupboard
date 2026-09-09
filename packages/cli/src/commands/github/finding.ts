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

	render(): string {
		const detail = this.detail();

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

export class PassedCheckFinding extends CheckFinding {
	readonly status = 'ok' as const;

	detail(): undefined {
		return;
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

// A reuse view aggregates only the caches whose access equals its own, and it
// returns no error for one that differs. Such a cache is absent from every
// lookup through the view, so the detail has to name both accesses for the
// operator to see why.
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
