import { readCommit, resolveRef } from 'just-git/repo';
import { createServer, MemoryStorage } from 'just-git/server';
import { describe, expect, it } from 'vitest';

import {
	checkCommitMessages,
	type CommitMessage,
	CommitMessageCheck,
	type Finding,
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

async function rejectedBy(run: () => Promise<unknown>): Promise<unknown> {
	let rejected: unknown;

	try {
		await run();
	} catch (error) {
		rejected = error;
	}

	return rejected;
}

function expectBackupReferenceExistsError(
	error: unknown
): asserts error is BackupReferenceExistsError {
	expect(error).toBeInstanceOf(BackupReferenceExistsError);
}

function expectUnfixableCommitMessageCheckError(
	error: unknown
): asserts error is UnfixableCommitMessageCheckError {
	expect(error).toBeInstanceOf(UnfixableCommitMessageCheckError);
}

function expectMergeCommitRewriteError(
	error: unknown
): asserts error is MergeCommitRewriteError {
	expect(error).toBeInstanceOf(MergeCommitRewriteError);
}

function expectNonLinearHistoryError(
	error: unknown
): asserts error is NonLinearHistoryError {
	expect(error).toBeInstanceOf(NonLinearHistoryError);
}

function expectStaleHeadError(error: unknown): asserts error is StaleHeadError {
	expect(error).toBeInstanceOf(StaleHeadError);
}

type StructuralFinding =
	| Omit<Extract<Finding, { readonly kind: 'body-format' }>, 'message'>
	| Omit<Extract<Finding, { readonly kind: 'rule' }>, 'message'>;

function findingShape(finding: Finding): StructuralFinding {
	switch (finding.kind) {
		case 'body-format': {
			return {
				kind: finding.kind,
				actual: finding.actual,
				expected: finding.expected,
				fixable: finding.fixable,
				patch: finding.patch,
				rule: finding.rule
			};
		}
		case 'rule': {
			return {
				kind: finding.kind,
				fixable: finding.fixable,
				rule: finding.rule
			};
		}
	}

	const exhaustive: never = finding;

	return exhaustive;
}

function findingShapes(findings: readonly Finding[]): StructuralFinding[] {
	return findings.map((finding) => findingShape(finding));
}

function expectPair<T>(
	values: readonly T[]
): asserts values is readonly [T, T] {
	expect(values).toStrictEqual([expect.anything(), expect.anything()]);
}

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

		expectPair(result.rewritten);
		const [rewrittenBad, rewrittenDescendant] = result.rewritten;
		const newBad = await readCommit(fixture.repo, rewrittenBad.newHash);
		const newDescendant = await readCommit(fixture.repo, result.newHead);
		const [newBadCheck] = await checkCommitMessages([
			commitMessage(rewrittenBad.newHash, newBad.message)
		]);

		expect({
			backupRef: backupReference,
			newHead: result.newHead,
			newHeadRef: newHeadReference,
			oldHead: result.oldHead,
			rewritten: result.rewritten.map((commit) => ({
				messageChanged: commit.messageChanged,
				oldHash: commit.oldHash,
				newHash: commit.newHash,
				subject: commit.subject
			})),
			rewrittenCheck: {
				changed: newBadCheck?.changed,
				findings: newBadCheck?.findings,
				status: newBadCheck?.status,
				subject: newBadCheck?.commitMessage.subject
			}
		}).toStrictEqual({
			backupRef: fixture.descendant,
			newHead: rewrittenDescendant.newHash,
			newHeadRef: rewrittenDescendant.newHash,
			oldHead: fixture.descendant,
			rewritten: [
				{
					messageChanged: true,
					newHash: rewrittenBad.newHash,
					oldHash: fixture.bad,
					subject: 'fix: explain body wrapping'
				},
				{
					messageChanged: false,
					newHash: rewrittenDescendant.newHash,
					oldHash: fixture.descendant,
					subject: 'docs: add descendant'
				}
			],
			rewrittenCheck: {
				changed: false,
				findings: [],
				status: 'passed',
				subject: 'fix: explain body wrapping'
			}
		});
		expect(newDescendant).toStrictEqual({
			...originalHead,
			parents: [rewrittenBad.newHash]
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

		const error = await rejectedBy(() =>
			new CommitMessageRewriter({
				backupRef: 'refs/backup/commit-message-lint/test',
				baseHash: fixture.base,
				branchRef: 'refs/heads/main',
				expectedHeadHash: fixture.descendant,
				repo: fixture.repo
			}).reword([check])
		);

		expectUnfixableCommitMessageCheckError(error);
		expect({
			name: error.name,
			changed: error.check.changed,
			status: error.check.status,
			findings: findingShapes(error.check.findings)
		}).toStrictEqual({
			name: 'UnfixableCommitMessageCheckError',
			changed: false,
			status: 'failed',
			findings: [
				{
					kind: 'rule',
					fixable: false,
					rule: 'type-empty'
				}
			]
		});
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

		const error = await rejectedBy(() =>
			new CommitMessageRewriter({
				backupRef: 'refs/backup/commit-message-lint/test',
				baseHash: fixture.base,
				branchRef: 'refs/heads/main',
				expectedHeadHash: fixture.descendant,
				repo: fixture.repo
			}).reword(checks)
		);

		expectBackupReferenceExistsError(error);
		expect({
			name: error.name,
			backupReference: error.backupReference
		}).toStrictEqual({
			name: 'BackupReferenceExistsError',
			backupReference: 'refs/backup/commit-message-lint/test'
		});
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

		const error = await rejectedBy(() =>
			new CommitMessageRewriter({
				backupRef: 'refs/backup/commit-message-lint/test',
				baseHash: fixture.base,
				branchRef: 'refs/heads/main',
				expectedHeadHash: fixture.descendant,
				repo: fixture.repo
			}).reword(checks)
		);

		expectStaleHeadError(error);
		expect({
			name: error.name,
			expectedHead: error.expectedHead
		}).toStrictEqual({
			name: 'StaleHeadError',
			expectedHead: fixture.descendant
		});
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

		const error = await rejectedBy(() =>
			new CommitMessageRewriter({
				backupRef: 'refs/backup/commit-message-lint/test',
				baseHash: fixture.base,
				branchRef: 'refs/heads/main',
				expectedHeadHash: fixture.merge,
				repo: fixture.repo
			}).reword(checks)
		);

		expectMergeCommitRewriteError(error);
		expect({
			name: error.name,
			commit: error.commit
		}).toStrictEqual({
			name: 'MergeCommitRewriteError',
			commit: fixture.merge
		});
	});

	it('rejects a non-linear check sequence', async () => {
		const fixture = await createLinearFixture();
		const checks = await checksFor(fixture.repo, [fixture.descendant]);

		const error = await rejectedBy(() =>
			new CommitMessageRewriter({
				backupRef: 'refs/backup/commit-message-lint/test',
				baseHash: fixture.base,
				branchRef: 'refs/heads/main',
				expectedHeadHash: fixture.descendant,
				repo: fixture.repo
			}).reword(checks)
		);

		expectNonLinearHistoryError(error);
		expect({
			name: error.name,
			commit: error.commit,
			expectedParent: error.expectedParent,
			actualParent: error.actualParent
		}).toStrictEqual({
			name: 'NonLinearHistoryError',
			commit: fixture.descendant,
			expectedParent: fixture.base,
			actualParent: fixture.bad
		});
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
