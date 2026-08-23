import type { CommitOptions, CommitTarget } from './client.ts';
import type { CommitOutcome, CommitSession } from './commit-socket.ts';

export interface CommitSource {
	readonly session?: CommitSession;
	readonly client: {
		commit(
			target: CommitTarget,
			options: CommitOptions
		): Promise<CommitOutcome>;
	};
	readonly commitOptions?: CommitOptions;
}

/**
 * When a publication has a shared commit session, use it for commits from every
 * phase. All paths then draw from one server credit grant and declared demand
 * budget. Without a session, use a one-off client commit.
 */
export function commitOverSession(
	source: CommitSource,
	target: CommitTarget
): Promise<CommitOutcome> {
	if (source.session === undefined) {
		return source.client.commit(target, source.commitOptions ?? {});
	}

	return source.session.commit(target);
}
