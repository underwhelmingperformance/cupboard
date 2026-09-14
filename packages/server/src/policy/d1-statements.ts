import { positiveIntSchema } from '@cupboard/nix-store/scalars';
import {
	freeTierD1StatementsPerInvocation,
	paidTierD1StatementsPerInvocation
} from '@cupboard/protocol/platform';

interface D1StatementEnv {
	readonly CUPBOARD_D1_STATEMENTS_PER_INVOCATION: string;
}

/**
 * Reads the deployment's per-invocation D1 allowance. Integers from the Workers
 * Free limit through the Workers Paid limit are accepted. Missing or invalid
 * values use the Workers Free limit.
 *
 * This validates the value, not the account's plan. The deployment must supply
 * an allowance its account permits.
 */
export function d1StatementAllowance(env: D1StatementEnv): number {
	const supplied = positiveIntSchema.safeParse(
		Number(env.CUPBOARD_D1_STATEMENTS_PER_INVOCATION)
	);

	return supplied.success &&
		supplied.data >= freeTierD1StatementsPerInvocation &&
		supplied.data <= paidTierD1StatementsPerInvocation
		? supplied.data
		: freeTierD1StatementsPerInvocation;
}
