import conventionalCommitlintConfiguration from '@commitlint/config-conventional';
import commitlint from '@commitlint/lint';
import loadCommitlint from '@commitlint/load';
import { createPatch } from 'diff';
import type { Configuration, LintError } from 'markdownlint';
import { lint as lintMarkdown } from 'markdownlint/promise';

import { MarkdownBodyReflower } from './markdown-body-reflow.ts';
import { CommitMessageDocument } from './message.ts';

/**
 * A commit message with the display metadata needed to report failures for one
 * commit without mixing the result with other commits in the same range.
 */
export interface CommitMessage {
	readonly hash?: string;
	readonly label: string;
	readonly message: string;
	readonly subject: string;
}

/** A finding that names a violated rule with no further detail. */
export interface RuleFinding {
	readonly kind: 'rule';
	readonly fixable: boolean;
	readonly message: string;
	readonly rule: string;
}

/** The body-wrapping finding, which carries the before/after diff. */
export interface BodyFormatFinding {
	readonly kind: 'body-format';
	readonly actual: string;
	readonly expected: string;
	readonly fixable: boolean;
	readonly message: string;
	readonly patch: string;
	readonly rule: 'body-format';
}

/** A single lint finding for a commit message. */
export type Finding = BodyFormatFinding | RuleFinding;

/**
 * Filesystem locations used by the commit-message linter. Tests can override
 * these paths while the CLI uses the repository root.
 */
export interface CommitMessageLinterOptions {
	readonly root?: string;
}

/** Base class for expected commit-message check errors. */
export abstract class CommitMessageCheckError extends Error {
	protected constructor(message: string) {
		super(message);
	}
}

/** A passed or unchanged check has no replacement message to apply. */
export class UnchangedCommitMessageCheckError extends CommitMessageCheckError {
	constructor(public readonly check: CommitMessageCheck) {
		super(
			`commit ${check.commitMessage.label} does not need a replacement message`
		);
		this.name = 'UnchangedCommitMessageCheckError';
	}
}

/** The check contains findings which cannot be fixed automatically. */
export class UnfixableCommitMessageCheckError extends CommitMessageCheckError {
	constructor(public readonly check: CommitMessageCheck) {
		super(
			`commit ${check.commitMessage.label} has findings that cannot be fixed automatically`
		);
		this.name = 'UnfixableCommitMessageCheckError';
	}
}

/** The complete lint result for one commit message. */
export class CommitMessageCheck {
	constructor(
		public readonly commitMessage: CommitMessage,
		public readonly originalMessage: string,
		public readonly fixedMessage: string,
		public readonly findings: readonly Finding[]
	) {}

	get changed(): boolean {
		return this.fixedMessage !== this.originalMessage;
	}

	get failed(): boolean {
		return this.findings.length > 0;
	}

	get fixable(): boolean {
		return (
			this.failed &&
			this.changed &&
			this.findings.every((finding) => finding.fixable)
		);
	}

	get passed(): boolean {
		return !this.failed;
	}

	get status(): 'failed' | 'fixable' | 'passed' {
		if (this.passed) {
			return 'passed';
		}

		return this.fixable ? 'fixable' : 'failed';
	}

	/** Returns the corrected message or throws a typed error. */
	rewordMessage(): string {
		if (!this.changed) {
			throw new UnchangedCommitMessageCheckError(this);
		}

		if (!this.fixable) {
			throw new UnfixableCommitMessageCheckError(this);
		}

		return this.fixedMessage;
	}
}

const defaultRoot = process.cwd();
const commitBodyMarkdownlintConfiguration: Configuration = {
	default: false,
	MD013: {
		code_blocks: false,
		line_length: 72,
		tables: false
	},
	MD024: {
		siblings_only: true
	}
};

/**
 * Lints each commit message independently, preserving a separate report per
 * commit so multi-commit pull requests show each failing commit clearly.
 */
export async function checkCommitMessages(
	commitMessages: readonly CommitMessage[],
	options: CommitMessageLinterOptions = {}
): Promise<readonly CommitMessageCheck[]> {
	const root = options.root ?? defaultRoot;
	const commitlintConfiguration = await loadCommitlint(
		conventionalCommitlintConfiguration,
		{
			cwd: root
		}
	);
	const reflower = new MarkdownBodyReflower();

	return Promise.all(
		commitMessages.map(async (commitMessage) => {
			const bodyCheck = await checkMarkdownBody(commitMessage, reflower);

			return new CommitMessageCheck(
				commitMessage,
				commitMessage.message,
				bodyCheck.fixedMessage,
				[
					...(await lintConventionalCommit(
						commitlintConfiguration,
						bodyCheck.fixedMessage
					)),
					...bodyCheck.findings
				]
			);
		})
	);
}

/**
 * Extracts the commit body as Markdown, excluding the Conventional Commit
 * subject and surrounding blank lines.
 */
export function commitBody(message: string): string {
	return CommitMessageDocument.parse(message).body;
}

/** Creates the unified diff shown for body wrapping failures. */
export function formatBodyPatch(actual: string, expected: string): string {
	return createPatch('commit-body.md', actual, expected, 'actual', 'check', {
		context: 2
	});
}

/** Builds the body-wrapping finding, deriving the patch from the diff. */
function bodyFormatFinding(
	actual: string,
	expected: string,
	fixable: boolean
): BodyFormatFinding {
	return {
		kind: 'body-format',
		actual,
		expected,
		fixable,
		message: 'body is not wrapped to 72 columns',
		patch: formatBodyPatch(actual, expected),
		rule: 'body-format'
	};
}

type CommitlintParserOptions = NonNullable<
	NonNullable<Parameters<typeof commitlint>[2]>['parserOpts']
>;

/**
 * `@commitlint/load` types the loaded `parserOpts` as `unknown` because presets
 * load dynamically, while `commitlint` wants the parser options shape, so narrow
 * it here. The options carry the Conventional Commits header grammar (for
 * example the `!` breaking-change marker), so they cannot be dropped.
 *
 * `@commitlint/cli`'s own `selectParserOpts` does the same `typeof === 'object'`
 * check and nothing more; the shape is all-optional so there is no required
 * field to assert. We additionally reject `null` (which `typeof` alone admits).
 */
function isParserOptions(value: unknown): value is CommitlintParserOptions {
	return typeof value === 'object' && value !== null;
}

async function lintConventionalCommit(
	commitlintConfiguration: Awaited<ReturnType<typeof loadCommitlint>>,
	message: string
): Promise<readonly Finding[]> {
	const parserOptions = commitlintConfiguration.parserPreset?.parserOpts;
	const report = await commitlint(
		message,
		{
			...commitlintConfiguration.rules,
			'body-max-line-length': [0],
			'footer-max-line-length': [0]
		},
		{
			defaultIgnores: commitlintConfiguration.defaultIgnores,
			ignores: commitlintConfiguration.ignores,
			parserOpts: isParserOptions(parserOptions) ? parserOptions : undefined,
			plugins: commitlintConfiguration.plugins
		}
	);

	return [...report.errors, ...report.warnings].map((finding): RuleFinding => {
		const rule = finding.name;

		return {
			kind: 'rule',
			fixable: false,
			message: `${rule}: ${finding.message}`,
			rule
		};
	});
}

async function checkMarkdownBody(
	commitMessage: CommitMessage,
	reflower: MarkdownBodyReflower
): Promise<{
	readonly findings: readonly Finding[];
	readonly fixedMessage: string;
}> {
	const document = CommitMessageDocument.parse(commitMessage.message);
	const body = document.body;

	if (body === '') {
		return { findings: [], fixedMessage: commitMessage.message };
	}

	const findings: Finding[] = [];

	if (document.separatorMissing) {
		findings.push({
			kind: 'rule',
			fixable: true,
			message: 'trailer is not separated from the body by a blank line',
			rule: 'trailer-format'
		});
	}

	const reflow = reflower.reflow(body);
	const fixedMessage = document.withBody(reflow.reflowed);
	const finalLintResults = await lintMarkdown({
		config: commitBodyMarkdownlintConfiguration,
		strings: {
			body: reflow.reflowed
		}
	});
	const markdownlintFindings = finalLintResults.body ?? [];

	if (reflow.changed) {
		findings.push(
			bodyFormatFinding(
				body,
				reflow.reflowed,
				markdownlintFindings.length === 0
			)
		);
	}

	return {
		findings: [
			...findings,
			...markdownlintFindings.map(
				(finding): RuleFinding => ({
					kind: 'rule',
					fixable: false,
					message: markdownlintFailure(finding),
					rule: finding.ruleNames[0] ?? finding.ruleNames.join('/')
				})
			)
		],
		fixedMessage
	};
}

function markdownlintFailure(finding: LintError): string {
	const ruleNames = finding.ruleNames.join('/');
	const details =
		finding.errorDetail === null ? '' : `: ${finding.errorDetail}`;
	const context =
		finding.errorContext === null ? '' : ` [${finding.errorContext}]`;

	return `body line ${String(finding.lineNumber)} ${ruleNames}: ${
		finding.ruleDescription
	}${details}${context}`;
}
