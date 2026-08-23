import { positiveIntSchema } from '@cupboard/nix-store/scalars';
import { commitBatchMaxEntries } from '@cupboard/protocol/upload';

import { CommitCreditBudgetInvalidError } from '../errors.ts';

interface CommitCreditEnv {
	readonly CUPBOARD_COMMIT_ENTRY_CREDIT_BUDGET: string;
}

export const defaultCommitEntryCreditBudget = 2 * commitBatchMaxEntries;

/**
 * Parses `CUPBOARD_COMMIT_ENTRY_CREDIT_BUDGET`. An empty setting selects the
 * built-in tenant budget; a non-empty setting must be a positive integer.
 */
export function commitEntryCreditBudget(env: CommitCreditEnv): number {
	const raw = env.CUPBOARD_COMMIT_ENTRY_CREDIT_BUDGET;

	if (!raw) {
		return defaultCommitEntryCreditBudget;
	}

	const result = positiveIntSchema.safeParse(Number(raw));

	if (!result.success) {
		throw new CommitCreditBudgetInvalidError(raw);
	}

	return result.data;
}
