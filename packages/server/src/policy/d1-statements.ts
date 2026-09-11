import { positiveIntSchema } from '@cupboard/nix-store/scalars';
import {
	freeTierD1StatementsPerInvocation,
	paidTierD1StatementsPerInvocation
} from '@cupboard/protocol/platform';

interface D1StatementEnv {
	readonly CUPBOARD_D1_STATEMENTS_PER_INVOCATION: string;
}

/**
 * The D1 statements one invocation of this deployment may run. The D1 binding
 * holds every Durable Object invocation to this allowance and refuses the
 * statement that would exceed it.
 *
 * `cupboard deploy` writes this variable after it establishes the account's
 * Workers plan. Everything else means the free figure: an unset variable, a
 * value that is not a positive integer, and a value above what the paid plan
 * allows. The errors are asymmetric, so raise the allowance only on a value the
 * deploy established.
 */
export function d1StatementAllowance(env: D1StatementEnv): number {
	const supplied = positiveIntSchema.safeParse(
		Number(env.CUPBOARD_D1_STATEMENTS_PER_INVOCATION)
	);

	return supplied.success && supplied.data <= paidTierD1StatementsPerInvocation
		? supplied.data
		: freeTierD1StatementsPerInvocation;
}
