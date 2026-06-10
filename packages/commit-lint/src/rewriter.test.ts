import { readCommit, resolveRef } from 'just-git/repo';
import { createServer, MemoryStorage } from 'just-git/server';
import { describe, expect, it } from 'vitest';

import {
	checkCommitMessages,
	type CommitMessage,
	CommitMessageCheck,
	UnfixableCommitMessageCheckError
} from './linter.ts';
import {
	BackupReferenceExistsError,
	CommitMessageRewriter,
	MergeCommitRewriteError,
	NonLinearHistoryError,
	StaleHeadError
} from './rewriter.ts';

const author = {
	date: new Date('2026-01-01T00:00:00.000Z'),
	email: 'test@example.test',
	name: 'Test Author'
};

describe('CommitMessageRewriter', () => {
	it('rewords fixable commit-message checks and preserves final tree state', async () => {
		const fixture = await createLinearFixture();
		const checks = await checksFor(fixture.repo, [
			fixture.bad,
			fixture.descendant
		]);
		const originalHead = await readCommit(fixture.repo, fixture.descendant);
		const result = await new CommitMessageRewriter({
			backupRef: 'refs/backup/commit-message-lint/test',
			baseHash: fixture.base,
			branchRef: 'refs/heads/main',
			expectedHeadHash: fixture.descendant,
			repo: fixture.repo
		}).reword(checks);

		const newHeadReference = await resolveRef(fixture.repo, 'refs/heads/main');
		const backupReference = await resolveRef(
			fixture.repo,
			'refs/backup/commit-message-lint/test'
		);
		const newBad = await readCommit(
			fixture.repo,
			result.rewritten[0]?.newHash ?? ''
		);
		const newDescendant = await readCommit(fixture.repo, result.newHead);

		expect({
			backupRef: backupReference,
			newHead: result.newHead,
			newHeadRef: newHeadReference,
			oldHead: result.oldHead,
			rewritten: result.rewritten.map((commit) => commit.oldHash)
		}).toStrictEqual({
			backupRef: fixture.descendant,
			newHead: result.rewritten[1]?.newHash,
			newHeadRef: result.newHead,
			oldHead: fixture.descendant,
			rewritten: [fixture.bad, fixture.descendant]
		});
		expect(newBad.message).toBe(
			[
				'fix: explain body wrapping',
				'',
				'This body line is deliberately longer than seventy two columns so the',
				'commit-message checker can wrap it.'
			].join('\n')
		);
		expect(newDescendant).toStrictEqual({
			...originalHead,
			parents: [result.rewritten[0]?.newHash ?? '']
		});
	});

	it('does not move refs in dry-run mode', async () => {
		const fixture = await createLinearFixture();
		const checks = await checksFor(fixture.repo, [
			fixture.bad,
			fixture.descendant
		]);
		const result = await new CommitMessageRewriter({
			backupRef: 'refs/backup/commit-message-lint/test',
			baseHash: fixture.base,
			branchRef: 'refs/heads/main',
			dryRun: true,
			expectedHeadHash: fixture.descendant,
			repo: fixture.repo
		}).reword(checks);

		await expect(resolveRef(fixture.repo, 'refs/heads/main')).resolves.toBe(
			fixture.descendant
		);
		await expect(
			resolveRef(fixture.repo, 'refs/backup/commit-message-lint/test')
		).resolves.toBeNull();
		expect(result.outcome).toBe('dry-run');
		expect(result.rewritten.map((commit) => commit.oldHash)).toStrictEqual([
			fixture.bad,
			fixture.descendant
		]);
	});

	it('returns a no-op result when no commit messages need rewording', async () => {
		const fixture = await createLinearFixture();
		const checks = await checksFor(fixture.repo, [fixture.descendant]);
		const result = await new CommitMessageRewriter({
			backupRef: 'refs/backup/commit-message-lint/test',
			baseHash: fixture.bad,
			branchRef: 'refs/heads/main',
			expectedHeadHash: fixture.descendant,
			repo: fixture.repo
		}).reword(checks);

		await expect(resolveRef(fixture.repo, 'refs/heads/main')).resolves.toBe(
			fixture.descendant
		);
		await expect(
			resolveRef(fixture.repo, 'refs/backup/commit-message-lint/test')
		).resolves.toBeNull();
		expect(result).toStrictEqual({
			outcome: 'unchanged',
			newHead: fixture.descendant,
			oldHead: fixture.descendant,
			rewritten: []
		});
	});

	it('rejects unfixable checks', async () => {
		const fixture = await createLinearFixture();
		const check = new CommitMessageCheck(
			commitMessage(fixture.bad, 'not conventional'),
			'not conventional',
			'not conventional',
			[
				{
					kind: 'rule',
					fixable: false,
					message: 'type-empty: type may not be empty',
					rule: 'type-empty'
				}
			]
		);

		await expect(
			new CommitMessageRewriter({
				backupRef: 'refs/backup/commit-message-lint/test',
				baseHash: fixture.base,
				branchRef: 'refs/heads/main',
				expectedHeadHash: fixture.descendant,
				repo: fixture.repo
			}).reword([check])
		).rejects.toBeInstanceOf(UnfixableCommitMessageCheckError);
	});

	it('rejects rewriting when the backup ref already exists', async () => {
		const fixture = await createLinearFixture();
		const checks = await checksFor(fixture.repo, [
			fixture.bad,
			fixture.descendant
		]);
		await fixture.repo.refStore.writeRef(
			'refs/backup/commit-message-lint/test',
			{
				hash: fixture.base,
				type: 'direct'
			}
		);

		await expect(
			new CommitMessageRewriter({
				backupRef: 'refs/backup/commit-message-lint/test',
				baseHash: fixture.base,
				branchRef: 'refs/heads/main',
				expectedHeadHash: fixture.descendant,
				repo: fixture.repo
			}).reword(checks)
		).rejects.toStrictEqual(
			new BackupReferenceExistsError('refs/backup/commit-message-lint/test')
		);
		await expect(resolveRef(fixture.repo, 'refs/heads/main')).resolves.toBe(
			fixture.descendant
		);
		await expect(
			resolveRef(fixture.repo, 'refs/backup/commit-message-lint/test')
		).resolves.toBe(fixture.base);
	});

	it('rejects rewriting when the branch has moved before the final ref update', async () => {
		const fixture = await createLinearFixture();
		const checks = await checksFor(fixture.repo, [
			fixture.bad,
			fixture.descendant
		]);
		const { hash: movedHead } = await fixture.server.commit('test', {
			author,
			branch: 'main',
			files: { 'moved.txt': 'moved\n' },
			message: 'docs: move head'
		});

		await expect(
			new CommitMessageRewriter({
				backupRef: 'refs/backup/commit-message-lint/test',
				baseHash: fixture.base,
				branchRef: 'refs/heads/main',
				expectedHeadHash: fixture.descendant,
				repo: fixture.repo
			}).reword(checks)
		).rejects.toStrictEqual(new StaleHeadError(fixture.descendant));
		await expect(resolveRef(fixture.repo, 'refs/heads/main')).resolves.toBe(
			movedHead
		);
		await expect(
			resolveRef(fixture.repo, 'refs/backup/commit-message-lint/test')
		).resolves.toBe(fixture.descendant);
	});

	it('rejects merge commits', async () => {
		const fixture = await createMergeFixture();
		const checks = await checksFor(fixture.repo, [fixture.merge]);

		await expect(
			new CommitMessageRewriter({
				backupRef: 'refs/backup/commit-message-lint/test',
				baseHash: fixture.base,
				branchRef: 'refs/heads/main',
				expectedHeadHash: fixture.merge,
				repo: fixture.repo
			}).reword(checks)
		).rejects.toBeInstanceOf(MergeCommitRewriteError);
	});

	it('rejects a non-linear check sequence', async () => {
		const fixture = await createLinearFixture();
		const checks = await checksFor(fixture.repo, [fixture.descendant]);

		await expect(
			new CommitMessageRewriter({
				backupRef: 'refs/backup/commit-message-lint/test',
				baseHash: fixture.base,
				branchRef: 'refs/heads/main',
				expectedHeadHash: fixture.descendant,
				repo: fixture.repo
			}).reword(checks)
		).rejects.toBeInstanceOf(NonLinearHistoryError);
	});
});

async function createLinearFixture(): Promise<{
	readonly bad: string;
	readonly base: string;
	readonly descendant: string;
	readonly repo: Awaited<
		ReturnType<ReturnType<typeof createServer>['requireRepo']>
	>;
	readonly server: ReturnType<typeof createServer>;
}> {
	const server = createServer({ storage: new MemoryStorage() });
	await server.createRepo('test');
	const { hash: base } = await server.commit('test', {
		author,
		branch: 'main',
		files: { 'base.txt': 'base\n' },
		message: 'chore: add base'
	});
	const { hash: bad } = await server.commit('test', {
		author,
		branch: 'main',
		files: { 'bad.txt': 'bad\n' },
		message: [
			'fix: explain body wrapping',
			'',
			'This body line is deliberately longer than seventy two columns so the commit-message checker can wrap it.'
		].join('\n')
	});
	const { hash: descendant } = await server.commit('test', {
		author,
		branch: 'main',
		files: { 'descendant.txt': 'descendant\n' },
		message: 'docs: add descendant'
	});

	return {
		bad,
		base,
		descendant,
		repo: await server.requireRepo('test'),
		server
	};
}

async function createMergeFixture(): Promise<{
	readonly base: string;
	readonly merge: string;
	readonly repo: Awaited<
		ReturnType<ReturnType<typeof createServer>['requireRepo']>
	>;
}> {
	const server = createServer({ storage: new MemoryStorage() });
	const repo = await server.createRepo('test');
	const { hash: base } = await server.commit('test', {
		author,
		branch: 'main',
		files: { 'base.txt': 'base\n' },
		message: 'chore: add base'
	});
	const { hash: left } = await server.commit('test', {
		author,
		branch: 'main',
		files: { 'left.txt': 'left\n' },
		message: 'feat: add left'
	});
	const { hash: right } = await server.commit('test', {
		author,
		branch: 'side',
		files: { 'right.txt': 'right\n' },
		message: 'feat: add right'
	});
	const leftCommit = await readCommit(repo, left);
	const { createCommit } = await import('just-git/repo');
	const merge = await createCommit(repo, {
		author,
		message: [
			'fix: explain merge message',
			'',
			'This body line is deliberately longer than seventy two columns so the commit-message checker can wrap it.'
		].join('\n'),
		parents: [left, right],
		tree: leftCommit.tree
	});
	await repo.refStore.writeRef('refs/heads/main', {
		hash: merge,
		type: 'direct'
	});

	return { base, merge, repo };
}

async function checksFor(
	repo: Awaited<ReturnType<ReturnType<typeof createServer>['requireRepo']>>,
	hashes: readonly string[]
): Promise<readonly CommitMessageCheck[]> {
	return checkCommitMessages(
		await Promise.all(
			hashes.map(async (hash) => {
				const commit = await readCommit(repo, hash);
				return commitMessage(hash, commit.message);
			})
		)
	);
}

function commitMessage(hash: string, message: string): CommitMessage {
	return {
		hash,
		label: hash.slice(0, 12),
		message,
		subject: message.split('\n', 1)[0] ?? ''
	};
}
