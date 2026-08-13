import { markErrorReported } from '@cupboard/reporter';
import { genericExitCode, usageExitCode } from '@cupboard/shared/errors';
import { CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';

import {
	CupboardReportedError,
	InvalidInputError,
	RootEnsureCommandError
} from './errors.ts';
import {
	ActionSignalError,
	buildProgram,
	reportActionFailure,
	runAction
} from './program.ts';

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

	it('passes the invocation signal to build-cohort', async () => {
		const reason = new Error('cancel build-cohort');

		await expect(
			buildProgram(noRunnerEnvironment, AbortSignal.abort(reason)).parseAsync([
				'node',
				'cupboard-action',
				'build-cohort',
				'--cohort-json',
				'{}',
				'--url',
				'https://cache.example.test/t/acme',
				'--cupboard-path',
				'/opt/cupboard/cupboard'
			])
		).rejects.toBe(reason);
	});
});

describe('runAction', () => {
	it('does not install signal handlers for a command that cannot honour them', async () => {
		const added: string[] = [];
		const removed: string[] = [];
		const signalSource: NonNullable<Parameters<typeof runAction>[2]> = {
			once(signal) {
				added.push(signal);
			},
			removeListener(signal) {
				removed.push(signal);
			}
		};
		const exitCode = await runAction(
			['node', 'cupboard-action', 'frobnicate'],
			noRunnerEnvironment,
			signalSource
		);

		expect({ exitCode, added, removed }).toStrictEqual({
			exitCode: usageExitCode,
			added: [],
			removed: []
		});
	});

	it.each([
		{ signal: 'SIGINT' as const, exitCode: 130 },
		{ signal: 'SIGTERM' as const, exitCode: 143 }
	])(
		'aborts build-cohort with the typed $signal exit and removes its production signal handlers',
		async ({ signal: interruptedBy, exitCode: expectedExitCode }) => {
			const active = new Map<string, () => void>();
			const added: string[] = [];
			const removed: string[] = [];
			const signalSource: NonNullable<Parameters<typeof runAction>[2]> = {
				once(signal, listener) {
					added.push(signal);
					active.set(signal, listener);

					if (signal === interruptedBy) {
						listener();
					}
				},
				removeListener(signal, listener) {
					removed.push(signal);

					if (active.get(signal) === listener) {
						active.delete(signal);
					}
				}
			};

			const exitCode = await runAction(
				[
					'node',
					'cupboard-action',
					'build-cohort',
					'--cohort-json',
					'{}',
					'--url',
					'https://cache.example.test/t/acme',
					'--cupboard-path',
					'/opt/cupboard/cupboard'
				],
				noRunnerEnvironment,
				signalSource
			);

			expect({
				exitCode,
				added,
				removed,
				active: active.keys().toArray()
			}).toStrictEqual({
				exitCode: expectedExitCode,
				added: ['SIGINT', 'SIGTERM'],
				removed: ['SIGINT', 'SIGTERM'],
				active: []
			});
		}
	);

	it.each([
		{ signal: 'SIGINT' as const, exitCode: 130 },
		{ signal: 'SIGTERM' as const, exitCode: 143 }
	])(
		'does not annotate an ordinary failure for $signal cancellation',
		({ signal, exitCode: expectedExitCode }) => {
			const annotations: string[] = [];
			const exitCode = reportActionFailure(
				{
					error(message) {
						annotations.push(message);
					}
				},
				new ActionSignalError(signal)
			);

			expect({ annotations, exitCode }).toStrictEqual({
				annotations: [],
				exitCode: expectedExitCode
			});
		}
	);

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
