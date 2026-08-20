import { positiveIntSchema } from '@cupboard/nix-store/scalars';

import { CommitSocketCeilingInvalidError } from '../errors.ts';

interface CommitSocketEnv {
	readonly CUPBOARD_COMMIT_SOCKET_CEILING: string;
}

// The commit sockets one tenant may hold at once, hibernating ones included.
// Credit bounds the work a session admits, so this is an anti-abuse ceiling and
// not a capacity bound: a publication run opens one socket, which puts a
// legitimate tenant orders of magnitude below this, and 256 sockets cost on the
// order of a megabyte of socket state and attachments.
export const defaultCommitSocketCeiling = 256;

// A session that did not negotiate credit sends as fast as it likes, so the
// only bound on the entries it can have parked in memory is the number of such
// sockets the tenant holds. That is what the old per-tenant session cap bounded,
// and it keeps bounding it until every client speaks credit.
export const maxUncreditedCommitSessions = 8;

/**
 * The configured ceiling on a tenant's commit sockets. An empty (or absent)
 * variable means the built-in ceiling; any other value must be a positive
 * integer, otherwise the deployment is misconfigured. Deployments leave it
 * unset; the tests set it low so a suite can reach the ceiling with a handful
 * of sockets.
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
