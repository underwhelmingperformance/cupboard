import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { stderr } from 'node:process';
import { promisify } from 'node:util';

import { createReporter, type ReporterMode } from '@cupboard/reporter';
import { resolveReporterMode } from '@cupboard/shared';
import { Command, Option } from 'commander';
import { createGit } from 'just-git';
import { readHead, revParse } from 'just-git/repo';

import {
	checkCommitMessages,
	type CommitMessage,
	CommitMessageCheckError,
	UnfixableCommitMessageCheckError
} from './linter.ts';
import {
	commitSubject,
	normaliseLineEndings,
	stripCommitMessageComments
} from './message.ts';
import { NodeFileSystem } from './node-file-system.ts';
import { jsonReport, terminalFailureReport } from './report.ts';
import {
	CommitMessageRewriteError,
	CommitMessageRewriter,
	type CommitMessageRewriteResult,
	StaleHeadError
} from './rewriter.ts';

interface RangeOptions {
	readonly dryRun: boolean;
	readonly kind: 'range';
	readonly from: string;
	readonly mode: ReporterMode;
	readonly reword: boolean;
	readonly to: string;
}

interface EditOptions {
	readonly kind: 'edit';
	readonly file: string;
	readonly mode: ReporterMode;
}

interface CliOptions {
	readonly colour?: boolean;
	readonly dryRun?: boolean;
	readonly edit?: string;
	readonly from?: string;
	readonly reword?: boolean;
	readonly to: string;
}

type Options = EditOptions | RangeOptions;

abstract class CommitMessageCliError extends Error {
	protected constructor(message: string) {
		super(message);
	}
}

class DetachedHeadError extends CommitMessageCliError {
	constructor(public readonly head: string) {
		super('cannot reword commit messages while HEAD is detached');
		this.name = 'DetachedHeadError';
	}
}

class DirtyWorktreeError extends CommitMessageCliError {
	constructor() {
		super('working tree must be clean before rewording commit messages');
		this.name = 'DirtyWorktreeError';
	}
}

class MissingRepositoryError extends CommitMessageCliError {
	constructor() {
		super('could not find a Git repository');
		this.name = 'MissingRepositoryError';
	}
}

class NonHeadRewordError extends CommitMessageCliError {
	constructor(public readonly to: string) {
		super('--reword only supports --to HEAD');
		this.name = 'NonHeadRewordError';
	}
}

class RevisionNotFoundError extends CommitMessageCliError {
	constructor(public readonly revision: string) {
		super(`revision not found: ${revision}`);
		this.name = 'RevisionNotFoundError';
	}
}

class UnbornHeadError extends CommitMessageCliError {
	constructor() {
		super('cannot reword commit messages on an unborn HEAD');
		this.name = 'UnbornHeadError';
	}
}

const execFileAsync = promisify(execFile);
const root = process.cwd();

/** Runs the commit-message lint CLI. */
export async function main(): Promise<void> {
	try {
		const options = parseOptions();
		const reporter = createReporter({ mode: options.mode });
		const checks = await reporter.phase(
			'Checking commit messages',
			async (phase) => {
				const commitMessages = await readCommitMessages(options);
				phase.fact('messages', commitMessages.length);

				return checkCommitMessages(commitMessages, { root });
			}
		);
		const failures = checks.filter((check) => check.failed);

		if (failures.length === 0) {
			if (options.mode === 'json') {
				emitJsonReport(jsonReport('ok', checks));
			}

			return;
		}

		if (options.kind === 'range' && options.reword) {
			const rewriteResult = await reporter.phase(
				options.dryRun
					? 'Checking reworded commit messages'
					: 'Rewording commit messages',
				async (phase) => {
					const result = await rewordCommitMessages(options, checks);
					phase.fact(
						options.dryRun ? 'would reword' : 'reworded',
						rewordedMessageCount(result)
					);

					return result;
				}
			);

			reportRewriteResult(rewriteResult, options.mode);
			return;
		}

		if (options.mode === 'terminal') {
			console.error(terminalFailureReport(failures, checks.length));
		} else {
			emitJsonReport(jsonReport('failed', checks));
		}

		process.exitCode = 1;
	} catch (error) {
		console.error(errorMessage(error));
		process.exitCode = 1;
	}
}

async function readCommitMessages(
	options: EditOptions | RangeOptions
): Promise<readonly CommitMessage[]> {
	if (options.kind === 'edit') {
		const message = stripCommitMessageComments(
			await readFile(options.file, 'utf8')
		);

		return [
			{
				label: options.file,
				message,
				subject: commitSubject(message)
			}
		];
	}

	const hashes = await gitLines([
		'rev-list',
		'--reverse',
		`${options.from}..${options.to}`
	]);

	return Promise.all(
		hashes.map(async (hash) => ({
			hash,
			label: hash.slice(0, 12),
			message: await gitOutput(['show', '-s', '--format=%B', hash]),
			subject: await gitOutput(['show', '-s', '--format=%s', hash])
		}))
	);
}

async function gitLines(
	arguments_: readonly string[]
): Promise<readonly string[]> {
	const output = await gitOutput(arguments_);

	if (output === '') {
		return [];
	}

	return output.split('\n');
}

async function gitOutput(arguments_: readonly string[]): Promise<string> {
	const { stdout } = await execFileAsync('git', [...arguments_], {
		cwd: root
	});

	return normaliseLineEndings(stdout).trimEnd();
}

function parseOptions(): Options {
	const program = new Command()
		.name('pnpm lint:commit-messages')
		.description('Lint Conventional Commit messages and 72-column bodies.')
		.option('--colour', 'force spinner and colour output')
		.option('--no-colour', 'force JSONL output')
		.option('--dry-run', 'show what --reword would change without moving refs')
		.addOption(
			new Option(
				'--edit <file>',
				'lint a commit message file, for commit-msg hooks'
			).conflicts(['from', 'to'])
		)
		.addOption(
			new Option('--from <revision>', 'lint commits after this revision')
		)
		.addOption(
			new Option(
				'--reword',
				'rewrite fixable commit messages in the selected range'
			).conflicts('edit')
		)
		.option('--to <revision>', 'lint commits up to this revision', 'HEAD')
		.showHelpAfterError();

	program.parse();

	const parsed = program.opts<CliOptions>();
	const mode = resolveReporterMode(parsed.colour);

	if (parsed.edit !== undefined) {
		if (parsed.dryRun === true) {
			program.error('error: --dry-run requires --reword');
		}

		return {
			file: parsed.edit,
			kind: 'edit',
			mode
		};
	}

	if (parsed.from !== undefined) {
		if (parsed.dryRun === true && parsed.reword !== true) {
			program.error('error: --dry-run requires --reword');
		}

		if (parsed.reword === true && parsed.to !== 'HEAD') {
			throw new NonHeadRewordError(parsed.to);
		}

		return {
			dryRun: parsed.dryRun ?? false,
			from: parsed.from,
			kind: 'range',
			mode,
			reword: parsed.reword ?? false,
			to: parsed.to
		};
	}

	return program.error('error: one of --edit or --from is required');
}

function emitJsonReport(report: ReturnType<typeof jsonReport>): void {
	stderr.write(`${JSON.stringify(report)}\n`);
}

function errorMessage(error: unknown): string {
	if (error instanceof UnfixableCommitMessageCheckError) {
		return terminalFailureReport([error.check], 1);
	}

	if (error instanceof CommitMessageCliError) {
		return cliErrorMessage(error);
	}

	if (error instanceof CommitMessageRewriteError) {
		return rewriteErrorMessage(error);
	}

	if (error instanceof CommitMessageCheckError) {
		return error.message;
	}

	return error instanceof Error ? error.message : String(error);
}

async function rewordCommitMessages(
	options: RangeOptions,
	checks: Awaited<ReturnType<typeof checkCommitMessages>>
): Promise<CommitMessageRewriteResult> {
	await ensureCleanWorkingTree();

	const fileSystem = new NodeFileSystem();
	const git = createGit({ cwd: root, fs: fileSystem });
	const repo = await git.findRepo();

	if (repo === null) {
		throw new MissingRepositoryError();
	}

	const head = await readHead(repo);

	if (head.hash === null) {
		throw new UnbornHeadError();
	}

	if (head.ref === null) {
		throw new DetachedHeadError(head.hash);
	}

	const baseHash = await revParse(repo, options.from);

	if (baseHash === null) {
		throw new RevisionNotFoundError(options.from);
	}

	return new CommitMessageRewriter({
		backupRef: backupReferenceName(),
		baseHash,
		branchRef: head.ref,
		dryRun: options.dryRun,
		expectedHeadHash: head.hash,
		repo
	}).reword(checks);
}

async function ensureCleanWorkingTree(): Promise<void> {
	const status = await gitOutput(['status', '--porcelain']);

	if (status !== '') {
		throw new DirtyWorktreeError();
	}
}

function backupReferenceName(): string {
	return `refs/backup/commit-message-lint/${new Date()
		.toISOString()
		.replaceAll(/[:.]/g, '-')}`;
}

function reportRewriteResult(
	result: CommitMessageRewriteResult,
	mode: ReporterMode
): void {
	if (mode === 'json') {
		stderr.write(
			`${JSON.stringify({
				event: 'commit-message-rewrite',
				outcome: result.outcome,
				...(result.outcome === 'applied'
					? { backupRef: result.backupRef }
					: {}),
				newHead: result.newHead,
				oldHead: result.oldHead,
				rewritten: result.rewritten
			})}\n`
		);
		return;
	}

	if (result.rewritten.length === 0) {
		console.error('No commit messages needed rewording.');
		return;
	}

	const action = result.outcome === 'dry-run' ? 'Would reword' : 'Reworded';
	console.error(
		`${action} ${String(rewordedMessageCount(result))} commit message(s).`
	);

	if (result.outcome === 'applied') {
		console.error(`Backup ref: ${result.backupRef}`);
	}
}

function rewordedMessageCount(result: CommitMessageRewriteResult): number {
	return result.rewritten.filter((commit) => commit.messageChanged).length;
}

function cliErrorMessage(error: CommitMessageCliError): string {
	return error.message;
}

function rewriteErrorMessage(error: CommitMessageRewriteError): string {
	if (error instanceof StaleHeadError) {
		return 'branch moved while rewording commit messages; no ref update was applied';
	}

	return error.message;
}
