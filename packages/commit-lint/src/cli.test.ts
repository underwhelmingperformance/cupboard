import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../..');
const script = path.join(import.meta.dirname, 'main.ts');

// Each case spawns the CLI as a node subprocess that compiles its TypeScript on
// start, which can run past the default 5s under load.
const cliTimeoutMs = 30_000;

describe('lint-commit-messages CLI', () => {
	it(
		'prints useful help',
		async () => {
			await expect(runCli(['--help'])).resolves.toStrictEqual({
				code: 0,
				stderr: '',
				stdout: [
					'Usage: pnpm lint:commit-messages [options]',
					'',
					'Lint Conventional Commit messages and 72-column bodies.',
					'',
					'Options:',
					'  --colour           force spinner and colour output',
					'  --no-colour        force JSONL output',
					'  --dry-run          show what --reword would change without moving refs',
					'  --edit <file>      lint a commit message file, for commit-msg hooks',
					'  --from <revision>  lint commits after this revision',
					'  --reword           rewrite fixable commit messages in the selected range',
					'  --to <revision>    lint commits up to this revision (default: "HEAD")',
					'  -h, --help         display help for command',
					''
				].join('\n')
			});
		},
		cliTimeoutMs
	);

	it(
		'emits JSONL reports for non-terminal commit-msg checks',
		async () => {
			const directory = await mkdtemp(
				path.join(os.tmpdir(), 'cupboard-commit-message-')
			);

			try {
				const messageFile = path.join(directory, 'COMMIT_EDITMSG');
				await writeFile(messageFile, 'not conventional\n');
				const result = await runCli(['--edit', messageFile]);

				expect({
					code: result.code,
					events: normaliseCommitLintEvents(
						normaliseEventDurations(parseJsonLines(result.stderr))
					),
					stdout: result.stdout
				}).toStrictEqual({
					code: 1,
					events: [
						{
							durationMs: 'number',
							event: 'phase',
							facts: {
								messages: '1'
							},
							label: 'Checking commit messages',
							status: 'ok'
						},
						{
							event: 'commit-message-lint',
							failures: [
								{
									commit: messageFile,
									findings: [
										{
											fixable: false,
											rule: 'subject-empty'
										},
										{
											fixable: false,
											rule: 'type-empty'
										}
									],
									subject: 'not conventional'
								}
							],
							status: 'failed',
							total: 1
						}
					],
					stdout: ''
				});
			} finally {
				await rm(directory, { force: true, recursive: true });
			}
		},
		cliTimeoutMs
	);
});

function parseJsonLines(value: string): readonly unknown[] {
	return value
		.trimEnd()
		.split('\n')
		.map((line): unknown => JSON.parse(line));
}

function normaliseEventDurations(
	events: readonly unknown[]
): readonly unknown[] {
	return events.map((event) => {
		if (!isRecord(event) || event.event !== 'phase') {
			return event;
		}

		return {
			...event,
			durationMs: typeof event.durationMs
		};
	});
}

function normaliseCommitLintEvents(
	events: readonly unknown[]
): readonly unknown[] {
	return events.map((event) => {
		if (!isRecord(event) || event.event !== 'commit-message-lint') {
			return event;
		}

		return {
			...event,
			failures: Array.isArray(event.failures)
				? event.failures.map((failure) => commitLintFailureShape(failure))
				: event.failures
		};
	});
}

function commitLintFailureShape(failure: unknown): unknown {
	if (!isRecord(failure) || !Array.isArray(failure.findings)) {
		return failure;
	}

	return {
		...failure,
		findings: failure.findings.map((finding) => commitLintFindingShape(finding))
	};
}

function commitLintFindingShape(finding: unknown): unknown {
	if (!isRecord(finding)) {
		return finding;
	}

	return Object.fromEntries(
		Object.entries(finding).filter(([key]) => key !== 'message')
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface CliResult {
	readonly code: number;
	readonly stderr: string;
	readonly stdout: string;
}

function runCli(arguments_: readonly string[]): Promise<CliResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[
				'--no-warnings',
				'--experimental-transform-types',
				script,
				...arguments_
			],
			{
				cwd: root,
				stdio: ['ignore', 'pipe', 'pipe']
			}
		);
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];

		child.stdout.on('data', (chunk: Buffer) => {
			stdout.push(chunk);
		});
		child.stderr.on('data', (chunk: Buffer) => {
			stderr.push(chunk);
		});
		child.on('error', reject);
		child.on('close', (code) => {
			resolve({
				code: code ?? 1,
				stderr: Buffer.concat(stderr).toString('utf8'),
				stdout: Buffer.concat(stdout).toString('utf8')
			});
		});
	});
}
