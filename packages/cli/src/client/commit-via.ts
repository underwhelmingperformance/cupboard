import type { CommitOptions, CommitTarget } from './client.ts';
import type { CommitOutcome, CommitSession } from './commit-socket.ts';

/**
 * What a phase of a publication needs in order to commit a path: the session
 * the run opened, when it opened one, and the client to fall back to when it
 * did not.
 */
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
 * Commits one path over the session the run holds, falling back to a one-off
 * commit for a client that opened none. A run that shares one session commits
 * every path of every phase over a single socket, which is what lets the server
 * pace the run as a whole rather than each phase separately.
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
