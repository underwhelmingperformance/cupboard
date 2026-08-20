import { positiveIntSchema } from '@cupboard/nix-store/scalars';
import { commitBatchMaxEntries } from '@cupboard/protocol/upload';

import { CommitCreditBudgetInvalidError } from '../errors.ts';

interface CommitCreditEnv {
	readonly CUPBOARD_COMMIT_ENTRY_CREDIT_BUDGET: string;
}

// The tenant-global budget of commit-entry credit. Commits execute
// `maxOutgoingConnections` at a time, so two full messages' worth of entries
// keep every execution slot fed with a parsed chunk in reserve, which is also
// what one busy session could have outstanding before credit existed. It bounds
// the parsed backlog at roughly 100 KB whatever the socket count.
export const defaultCommitEntryCreditBudget = 2 * commitBatchMaxEntries;

/**
 * The configured budget of commit-entry credit for one tenant. An empty (or
 * absent) variable means the built-in budget; any other value must be a
 * positive integer, otherwise the deployment is misconfigured. Deployments
 * leave it unset; a test sets it low so that saturation is arranged by the test
 * rather than raced for.
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
