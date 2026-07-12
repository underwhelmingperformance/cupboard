import { markErrorReported } from '@cupboard/reporter';
import { genericExitCode, usageExitCode } from '@cupboard/shared/errors';
import { CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';

import {
	CupboardReportedError,
	InvalidInputError,
	RootEnsureCommandError
} from './errors.ts';
import { buildProgram, reportActionFailure, runAction } from './program.ts';

const noRunnerEnvironment = {};

function expectCommanderError(value: unknown): asserts value is CommanderError {
	expect(value).toBeInstanceOf(CommanderError);
}

describe('buildProgram', () => {
	it.each([
		['an unknown command', ['node', 'cupboard-action', 'frobnicate']],
		['an unknown option', ['node', 'cupboard-action', 'setup', '--frobnicate']],
		['a missing required option', ['node', 'cupboard-action', 'push']]
	])('rejects %s with a commander usage error', async (_name, argv) => {
		await expect(
			buildProgram(noRunnerEnvironment).parseAsync(argv)
		).rejects.toBeInstanceOf(CommanderError);
	});

	it('exits zero after displaying help', async () => {
		const program = buildProgram(noRunnerEnvironment);
		program.configureOutput({
			writeOut() {
				return;
			},
			writeErr() {
				return;
			}
		});

		let result: unknown;
		try {
			await program.parseAsync(['node', 'cupboard-action', '--help']);
			result = { kind: 'parsed' as const };
		} catch (error: unknown) {
			result = error;
		}

		expectCommanderError(result);
		expect(result.exitCode).toBe(0);
	});

	it('maps the build installables option into the typed command input', async () => {
		await expect(
			buildProgram(noRunnerEnvironment).parseAsync([
				'node',
				'cupboard-action',
				'build',
				'--installables',
				''
			])
		).rejects.toBeInstanceOf(InvalidInputError);
	});
});

describe('runAction', () => {
	it.each([
		['an unknown command', ['node', 'cupboard-action', 'frobnicate']],
		['an unknown option', ['node', 'cupboard-action', 'setup', '--frobnicate']],
		['a missing required option', ['node', 'cupboard-action', 'push']]
	])('maps %s to the usage exit code', async (_name, argv) => {
		expect(await runAction(argv, noRunnerEnvironment)).toBe(usageExitCode);
	});

	it('does not annotate a result-file failure the child already reported', () => {
		const annotations: string[] = [];
		const error = new CupboardReportedError(3, [], undefined, true);

		const exitCode = reportActionFailure(
			{
				error(message) {
					annotations.push(message);
				}
			},
			error
		);

		expect({ annotations, exitCode }).toStrictEqual({
			annotations: [],
			exitCode: 3
		});
	});

	it('still annotates a legacy child failure converted from JSON output', () => {
		const annotations: string[] = [];
		const error = new CupboardReportedError(3, [], 'tenant denied the push');

		const exitCode = reportActionFailure(
			{
				error(message) {
					annotations.push(message);
				}
			},
			error
		);

		expect({ annotations, exitCode }).toStrictEqual({
			annotations: ['tenant denied the push'],
			exitCode: 3
		});
	});

	it('does not duplicate a planner child annotation after wrapping it', () => {
		const annotations: string[] = [];
		const error = new RootEnsureCommandError('github:owner/repo/main', {
			cause: new Error('cupboard exited 1'),
			wasReported: true
		});

		const exitCode = reportActionFailure(
			{
				error(message) {
					annotations.push(message);
				}
			},
			error
		);

		expect({ annotations, exitCode }).toStrictEqual({
			annotations: [],
			exitCode: genericExitCode
		});
	});

	it('does not annotate a failure a reporter phase already annotated', () => {
		const annotations: string[] = [];
		const error = new InvalidInputError('input', 'phase failed');
		markErrorReported(error);

		const exitCode = reportActionFailure(
			{
				error(message) {
					annotations.push(message);
				}
			},
			error
		);

		expect({ annotations, exitCode }).toStrictEqual({
			annotations: [],
			exitCode: usageExitCode
		});
	});
});
