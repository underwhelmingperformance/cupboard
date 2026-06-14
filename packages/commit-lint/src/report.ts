import pc from 'picocolors';

import type { CommitMessageCheck, Finding } from './linter.ts';
import { formatCount as formatInteger } from './reporter.ts';

export type CommitMessageLintStatus = 'failed' | 'ok';

/** The machine-readable JSONL event emitted by the non-terminal CLI mode. */
export interface CommitMessageLintJsonReport {
	readonly event: 'commit-message-lint';
	readonly failures: readonly CommitMessageJsonFailure[];
	readonly status: CommitMessageLintStatus;
	readonly total: number;
}

/** One failing commit in the machine-readable report. */
export interface CommitMessageJsonFailure {
	readonly commit: string;
	readonly findings: readonly CommitMessageJsonFinding[];
	readonly subject: string;
}

/** One finding in the machine-readable report. */
export interface CommitMessageJsonFinding {
	readonly actual?: string;
	readonly expected?: string;
	readonly fixable: boolean;
	readonly message: string;
	readonly rule?: string;
}

/** Builds the JSONL payload used when stdout/stderr is not a terminal. */
export function jsonReport(
	status: CommitMessageLintStatus,
	checks: readonly CommitMessageCheck[]
): CommitMessageLintJsonReport {
	return {
		event: 'commit-message-lint',
		failures: checks
			.filter((check) => check.failed)
			.map((check) => ({
				commit: check.commitMessage.label,
				findings: check.findings.map((finding) => jsonFinding(finding)),
				subject: check.commitMessage.subject
			})),
		status,
		total: checks.length
	};
}

/** Formats the human-readable terminal failure report. */
export function terminalFailureReport(
	checks: readonly CommitMessageCheck[],
	totalCount: number
): string {
	const lines = [
		`${pc.red('Commit message lint failed')} for ${formatNamedCount(
			checks.length,
			'commit message'
		)} out of ${formatInteger(totalCount)}.`
	];

	for (const check of checks) {
		lines.push(
			'',
			`${pc.bold(check.commitMessage.label)} ${check.commitMessage.subject}`
		);

		for (const finding of check.findings) {
			lines.push(`  ${pc.red('x')} ${finding.message}`);

			if (finding.kind === 'body-format') {
				lines.push(formatPatchForTerminal(finding.patch));
			}
		}
	}

	return lines.join('\n');
}

/** Formats a unified diff for terminal output. */
export function formatPatchForTerminal(patch: string): string {
	return patch
		.trimEnd()
		.split('\n')
		.map((line) => `    ${colourPatchLine(line)}`)
		.join('\n');
}

function colourPatchLine(line: string): string {
	if (line.startsWith('+')) {
		return pc.green(line);
	}

	if (line.startsWith('-')) {
		return pc.red(line);
	}

	if (line.startsWith('@')) {
		return pc.cyan(line);
	}

	return pc.dim(line);
}

function jsonFinding(finding: Finding): CommitMessageJsonFinding {
	switch (finding.kind) {
		case 'body-format': {
			return {
				actual: finding.actual,
				expected: finding.expected,
				fixable: finding.fixable,
				message: finding.message,
				rule: finding.rule
			};
		}
		case 'rule': {
			return {
				fixable: finding.fixable,
				message: finding.message,
				rule: finding.rule
			};
		}
	}
}

function formatNamedCount(count: number, name: string): string {
	return `${formatInteger(count)} ${name}${count === 1 ? '' : 's'}`;
}
