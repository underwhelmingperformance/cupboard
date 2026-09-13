/**
 * Platform figures the request caps in this package are sized against.
 *
 * Both request caps and the deployment plan decision use these figures.
 * Cloudflare applies the runtime ceiling for the account's Workers plan.
 */

export interface WorkersInvocationAllowance {
	readonly subrequests: number;
}

export const workersInvocationAllowances = {
	free: { subrequests: 1000 },
	paid: { subrequests: 10_000 }
} as const satisfies Record<string, WorkersInvocationAllowance>;

export type WorkersPlanTier = keyof typeof workersInvocationAllowances;

export const subrequestSafetyReserve = 100;

export const freeTierD1StatementsPerInvocation = 50;
export const paidTierD1StatementsPerInvocation = 1000;
