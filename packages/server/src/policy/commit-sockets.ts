import { positiveIntSchema } from '@cupboard/nix-store/scalars';

import { CommitSocketCeilingInvalidError } from '../errors.ts';

interface CommitSocketEnv {
	readonly CUPBOARD_COMMIT_SOCKET_CEILING: string;
}

// This anti-abuse ceiling includes hibernating sockets. Entry credit separately
// limits parsed commit work, so this value is not an execution-capacity bound.
export const defaultCommitSocketCeiling = 256;

// Legacy sessions do not negotiate credit and cannot be paced. Keep a separate
// cap on them until every supported client uses credit.
export const maxUncreditedCommitSessions = 8;

/**
 * Parses `CUPBOARD_COMMIT_SOCKET_CEILING`. An empty setting selects the built-in
 * tenant ceiling; a non-empty setting must be a positive integer.
 */
export function commitSocketCeiling(env: CommitSocketEnv): number {
	const raw = env.CUPBOARD_COMMIT_SOCKET_CEILING;

	if (!raw) {
		return defaultCommitSocketCeiling;
	}

	const result = positiveIntSchema.safeParse(Number(raw));

	if (!result.success) {
		throw new CommitSocketCeilingInvalidError(raw);
	}

	return result.data;
}
