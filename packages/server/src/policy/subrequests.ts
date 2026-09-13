import { workersInvocationAllowances } from '@cupboard/protocol/platform';

interface SubrequestEnv {
	readonly CUPBOARD_SUBREQUESTS_PER_INVOCATION?: string;
}

/**
 * Reads the subrequest allowance selected for the deployed Workers plan.
 * Missing or invalid configuration uses the Workers Free allowance.
 */
export function subrequestsPerInvocation(env: SubrequestEnv): number {
	return env.CUPBOARD_SUBREQUESTS_PER_INVOCATION ===
		String(workersInvocationAllowances.paid.subrequests)
		? workersInvocationAllowances.paid.subrequests
		: workersInvocationAllowances.free.subrequests;
}
