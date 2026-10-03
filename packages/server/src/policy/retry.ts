import { type TenantStatus } from '@cupboard/protocol/tenants';

export type RetryPhase = 'verification' | 'inheritance';
export type RetryExhaustion = 'attempt-limit' | 'eligible-age-limit';
export type RetryFailureCategory =
	| 'verification-failed'
	| 'commit-state-probe-failed'
	| 'prepare-failed'
	| 'materialisation-failed'
	| 'inheritance-failed';

export interface RetryBudget {
	readonly failures: number;
	readonly eligibleAgeMs: number;
}

export type RetryDecision =
	| {
			readonly kind: 'retry';
			readonly failures: number;
			readonly delayMs: number;
	  }
	| {
			readonly kind: 'exhausted';
			readonly failures: number;
			readonly reason: RetryExhaustion;
	  };

export class RetryPolicy {
	constructor(private readonly phase: RetryPhase) {}

	exhaustion(budget: RetryBudget): RetryExhaustion | undefined {
		if (budget.failures >= 12) {
			return 'attempt-limit';
		}

		if (budget.eligibleAgeMs >= 24 * 60 * 60_000) {
			return 'eligible-age-limit';
		}

		return undefined;
	}

	delayAfterFailure(failures: number): number {
		const initialDelayMs = this.phase === 'verification' ? 30_000 : 60_000;
		const maxDelayMs = (this.phase === 'verification' ? 10 : 60) * 60_000;
		return Math.min(
			initialDelayMs * 2 ** Math.min(failures - 1, 6),
			maxDelayMs
		);
	}

	afterFailure(budget: RetryBudget): RetryDecision {
		const failures = budget.failures + 1;
		const reason = this.exhaustion({ ...budget, failures });

		if (reason !== undefined) {
			return { kind: 'exhausted', failures, reason };
		}

		const delayMs = this.delayAfterFailure(failures);

		return { kind: 'retry', failures, delayMs };
	}
}

export interface EligibleRetryClockState {
	readonly status: TenantStatus;
	readonly activeElapsedMs: number;
	readonly activeSinceMs: number | undefined;
}

export class EligibleRetryClock {
	constructor(private readonly state: EligibleRetryClockState) {}

	get isActive(): boolean {
		return this.state.status === 'active';
	}

	elapsedAt(nowMs: number): number {
		const activeMs =
			this.state.status === 'active' && this.state.activeSinceMs !== undefined
				? Math.max(0, nowMs - this.state.activeSinceMs)
				: 0;

		return this.state.activeElapsedMs + activeMs;
	}

	ageAt(startedAt: number, nowMs: number): number {
		return Math.max(0, this.elapsedAt(nowMs) - startedAt);
	}
}
