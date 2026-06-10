import type { GitRepo } from 'just-git';
import { createCommit, readCommit } from 'just-git/repo';

import {
	type CommitMessageCheck,
	UnfixableCommitMessageCheckError
} from './linter.ts';

/** Base class for expected commit-message rewrite failures. */
export abstract class CommitMessageRewriteError extends Error {
	protected constructor(message: string) {
		super(message);
	}
}

export class BackupReferenceExistsError extends CommitMessageRewriteError {
	constructor(public readonly backupReference: string) {
		super(`backup ref already exists: ${backupReference}`);
		this.name = 'BackupReferenceExistsError';
	}
}

export class MergeCommitRewriteError extends CommitMessageRewriteError {
	constructor(public readonly commit: string) {
		super(`cannot reword through merge commit ${commit}`);
		this.name = 'MergeCommitRewriteError';
	}
}

export class MissingCommitHashError extends CommitMessageRewriteError {
	constructor(public readonly commit: string) {
		super(`commit ${commit} has no hash`);
		this.name = 'MissingCommitHashError';
	}
}

export class NonLinearHistoryError extends CommitMessageRewriteError {
	constructor(
		public readonly commit: string,
		public readonly expectedParent: string,
		public readonly actualParent: string | undefined
	) {
		super(`selected range is not a linear history at ${commit}`);
		this.name = 'NonLinearHistoryError';
	}
}

export class StaleHeadError extends CommitMessageRewriteError {
	constructor(public readonly expectedHead: string) {
		super('branch moved while rewording commit messages');
		this.name = 'StaleHeadError';
	}
}

export interface CommitMessageRewriteOptions {
	readonly backupRef: string;
	readonly baseHash: string;
	readonly branchRef: string;
	readonly dryRun?: boolean;
	readonly expectedHeadHash: string;
	readonly repo: GitRepo;
}

export interface RewrittenCommit {
	readonly oldHash: string;
	readonly newHash: string;
	readonly subject: string;
	/**
	 * Whether this commit's own message changed. A descendant of a reworded
	 * commit is recreated to reattach its new parent even when its message is
	 * untouched, so this is `false` for those.
	 */
	readonly messageChanged: boolean;
}

interface RewriteResultBase {
	readonly newHead: string;
	readonly oldHead: string;
	readonly rewritten: readonly RewrittenCommit[];
}

/** No commit needed rewording; the branch was left where it was. */
export interface UnchangedRewriteResult extends RewriteResultBase {
	readonly outcome: 'unchanged';
	readonly rewritten: readonly [];
}

/** A dry run computed the new head without moving any ref. */
export interface DryRunRewriteResult extends RewriteResultBase {
	readonly outcome: 'dry-run';
}

/** The branch was advanced; `backupRef` points at the previous head. */
export interface AppliedRewriteResult extends RewriteResultBase {
	readonly outcome: 'applied';
	readonly backupRef: string;
}

export type CommitMessageRewriteResult =
	| AppliedRewriteResult
	| DryRunRewriteResult
	| UnchangedRewriteResult;

/** Rewrites Git commit objects using precomputed commit-message checks. */
export class CommitMessageRewriter {
	constructor(private readonly options: CommitMessageRewriteOptions) {}

	async reword(
		checks: readonly CommitMessageCheck[]
	): Promise<CommitMessageRewriteResult> {
		this.assertChecksCanBeReworded(checks);

		let currentOriginalParent = this.options.baseHash;
		let currentRewrittenParent = this.options.baseHash;
		let rewriting = false;
		const rewritten: RewrittenCommit[] = [];

		for (const check of checks) {
			const oldHash = commitHash(check);
			const commit = await readCommit(this.options.repo, oldHash);

			if (commit.parents.length > 1) {
				throw new MergeCommitRewriteError(oldHash);
			}

			const actualParent = commit.parents[0];

			if (actualParent !== currentOriginalParent) {
				throw new NonLinearHistoryError(
					oldHash,
					currentOriginalParent,
					actualParent
				);
			}

			if (!rewriting && !check.changed) {
				currentOriginalParent = oldHash;
				currentRewrittenParent = oldHash;
				continue;
			}

			rewriting = true;
			const newHash = await createCommit(this.options.repo, {
				author: commit.author,
				committer: commit.committer,
				message: check.changed ? check.rewordMessage() : check.originalMessage,
				parents: [currentRewrittenParent],
				tree: commit.tree
			});

			rewritten.push({
				messageChanged: check.changed,
				newHash,
				oldHash,
				subject: check.commitMessage.subject
			});
			currentOriginalParent = oldHash;
			currentRewrittenParent = newHash;
		}

		const newHead = currentRewrittenParent;

		if (newHead === this.options.expectedHeadHash) {
			return {
				outcome: 'unchanged',
				newHead,
				oldHead: this.options.expectedHeadHash,
				rewritten: []
			};
		}

		if (this.options.dryRun === true) {
			return {
				outcome: 'dry-run',
				newHead,
				oldHead: this.options.expectedHeadHash,
				rewritten
			};
		}

		await this.createBackupRef();
		await this.advanceBranch(newHead);

		return {
			outcome: 'applied',
			backupRef: this.options.backupRef,
			newHead,
			oldHead: this.options.expectedHeadHash,
			rewritten
		};
	}

	private assertChecksCanBeReworded(
		checks: readonly CommitMessageCheck[]
	): void {
		for (const check of checks) {
			if (check.commitMessage.hash === undefined) {
				throw new MissingCommitHashError(check.commitMessage.label);
			}

			if (check.failed && !check.fixable) {
				throw new UnfixableCommitMessageCheckError(check);
			}
		}
	}

	private async createBackupRef(): Promise<void> {
		const created = await this.options.repo.refStore.compareAndSwapRef(
			this.options.backupRef,
			// eslint-disable-next-line unicorn/no-null -- just-git uses null for create-only compare-and-swap refs.
			null,
			{
				hash: this.options.expectedHeadHash,
				type: 'direct'
			}
		);

		if (!created) {
			throw new BackupReferenceExistsError(this.options.backupRef);
		}
	}

	private async advanceBranch(newHead: string): Promise<void> {
		const advanced = await this.options.repo.refStore.compareAndSwapRef(
			this.options.branchRef,
			this.options.expectedHeadHash,
			{
				hash: newHead,
				type: 'direct'
			}
		);

		if (!advanced) {
			throw new StaleHeadError(this.options.expectedHeadHash);
		}
	}
}

function commitHash(check: CommitMessageCheck): string {
	if (check.commitMessage.hash === undefined) {
		throw new MissingCommitHashError(check.commitMessage.label);
	}

	return check.commitMessage.hash;
}
