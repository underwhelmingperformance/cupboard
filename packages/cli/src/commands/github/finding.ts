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

export class GracePolicyMissingFinding extends FailedCheckFinding {
	constructor(
		check: string,
		public readonly cache: string
	) {
		super(check);
	}

	detail(): string {
		return `no grace policy covers the ${this.cache} cache; a push with require-grace would fail because no policy would retain its paths`;
	}
}

export class GracePolicyTooShortFinding extends FailedCheckFinding {
	constructor(
		check: string,
		public readonly cache: string,
		public readonly graceSeconds: number,
		public readonly requiredGraceSeconds: number
	) {
		super(check);
	}

	detail(): string {
		return `the ${this.cache} cache has ${String(this.graceSeconds)}s of grace; GitHub publication requires at least ${String(this.requiredGraceSeconds)}s`;
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
