/**
Platform figures the request caps in this package are sized against.

Both request caps and the deployment plan decision use these figures.
Cloudflare applies the runtime ceiling for the account's Workers plan.
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

/**
The number of KV operations that one Worker invocation can make, on the Free
and the Paid plan. Cloudflare's KV limits list 1,000 operations for each
invocation on both plans: https://developers.cloudflare.com/kv/platform/limits/
The Paid plan allows more subrequests than this, so KV work is sized against
this figure on every plan.
*/
export const kvOperationsPerInvocation = 1000;

/**
The KV operations that a batch of KV writes leaves unused in an invocation.
The invocation also writes the admission filter and can read KV outside the
batch, for example while it authenticates, and the code does not count those
operations.
*/
export const kvOperationsReserve = 100;
