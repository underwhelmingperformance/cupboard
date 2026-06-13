import type { Reporter } from '@cupboard/reporter';
import { CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';

import { buildProgram, cliExitCode, reportCliFailure } from './cli.ts';
import {
	authExitCode,
	CliAbortError,
	CupboardHttpError,
	InvalidCacheNameError,
	OwnerLoginRequiredError,
	transientExitCode,
	UploadWaitTimeoutError,
	usageExitCode
} from './errors.ts';

const abortExitCode = 130;

describe('cliExitCode', () => {
	it.each([
		{ name: 'an abort', error: new CliAbortError(), expected: abortExitCode },
		{
			name: 'a usage error',
			error: new InvalidCacheNameError('Bad/Name'),
			expected: usageExitCode
		},
		{
			name: 'a missing session',
			error: new OwnerLoginRequiredError(),
			expected: authExitCode
		},
		{
			name: 'a 401 response',
			error: new CupboardHttpError('GET', '/x', 401, ''),
			expected: authExitCode
		},
		{
			name: 'a 503 response',
			error: new CupboardHttpError('GET', '/x', 503, ''),
			expected: transientExitCode
		},
		{
			name: 'a 404 response',
			error: new CupboardHttpError('GET', '/x', 404, ''),
			expected: 1
		},
		{
			name: 'a wait timeout',
			error: new UploadWaitTimeoutError(1, 600),
			expected: transientExitCode
		},
		{
			name: 'a commander usage error',
			error: new CommanderError(
				1,
				'commander.unknownCommand',
				"error: unknown command 'bogus'"
			),
			expected: usageExitCode
		},
		{
			name: 'a commander help display',
			error: new CommanderError(0, 'commander.helpDisplayed', '(outputHelp)'),
			expected: 0
		},
		{ name: 'an unknown error', error: new Error('boom'), expected: 1 }
	])('maps $name to its exit code', ({ error, expected }) => {
		expect(cliExitCode(error, abortExitCode)).toBe(expected);
	});
});

describe('buildProgram', () => {
	it('throws a commander usage error for an unknown command', async () => {
		await expect(
			buildProgram().parseAsync(['node', 'cupboard', 'bogus'])
		).rejects.toBeInstanceOf(CommanderError);
	});
});

const noop = (): void => {
	/* a reporter method the funnel does not exercise */
};

function fakeReporter(): { readonly reporter: Reporter; errors: unknown[] } {
	const errors: unknown[] = [];

	return {
		errors,
		reporter: {
			phase: (_label, body) => Promise.resolve(body({ fact: noop })),
			result: noop,
			data: noop,
			warn: noop,
			info: noop,
			error: (error) => {
				errors.push(error);
			}
		}
	};
}

describe('reportCliFailure', () => {
	it('reports a failure through the reporter', () => {
		const { reporter, errors } = fakeReporter();
		const error = new InvalidCacheNameError('Bad/Name');

		reportCliFailure(reporter, error);

		expect(errors).toStrictEqual([error]);
	});

	it('stays silent on an abort', () => {
		const { reporter, errors } = fakeReporter();

		reportCliFailure(reporter, new CliAbortError());

		expect(errors).toStrictEqual([]);
	});

	it('stays silent when commander merely displayed help', () => {
		const { reporter, errors } = fakeReporter();

		reportCliFailure(
			reporter,
			new CommanderError(0, 'commander.helpDisplayed', '(outputHelp)')
		);

		expect(errors).toStrictEqual([]);
	});

	it('reports a commander usage error', () => {
		const { reporter, errors } = fakeReporter();
		const error = new CommanderError(
			1,
			'commander.unknownCommand',
			"error: unknown command 'bogus'"
		);

		reportCliFailure(reporter, error);

		expect(errors).toStrictEqual([error]);
	});
});
