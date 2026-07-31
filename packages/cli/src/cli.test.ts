import { ConfirmationRequiredError } from '@cupboard/cli-ui';
import { markErrorReported, type Reporter } from '@cupboard/reporter';
import { usageExitCode } from '@cupboard/shared/errors';
import { type Command, CommanderError } from 'commander';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

import { buildProgram, cliExitCode, reportCliFailure } from './cli.ts';
import { GithubRateLimitError } from './commands/oidc-trust/github.ts';
import {
	authExitCode,
	CacheInfoRateLimitedError,
	CacheInfoServerError,
	CliAbortError,
	CupboardHttpError,
	InvalidCacheNameError,
	OwnerLoginRequiredError,
	transientExitCode,
	UploadWaitTimeoutError
} from './errors.ts';

const abortExitCode = 130;

function expectCommanderError(value: unknown): asserts value is CommanderError {
	expect(value).toBeInstanceOf(CommanderError);
}

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
			name: 'a rate-limited cache-info response',
			error: new CacheInfoRateLimitedError(
				new URL('https://cupboard.example/nix-cache-info')
			),
			expected: transientExitCode
		},
		{
			name: 'an unavailable cache-info response',
			error: new CacheInfoServerError(
				new URL('https://cupboard.example/nix-cache-info'),
				StatusCodes.SERVICE_UNAVAILABLE
			),
			expected: transientExitCode
		},
		{
			name: 'an exhausted GitHub rate limit',
			error: new GithubRateLimitError(),
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
		{
			name: 'a refused confirmation',
			error: new ConfirmationRequiredError('Remove tenant acme?'),
			expected: usageExitCode
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

	it('rejects an unknown --output-mode as a usage error', async () => {
		await expect(
			buildProgram().parseAsync([
				'node',
				'cupboard',
				'--output-mode',
				'fancy',
				'pubkey',
				'https://cupboard.example'
			])
		).rejects.toBeInstanceOf(CommanderError);
	});

	it('accepts github as an output mode', async () => {
		const program = buildProgram();
		program.configureOutput({
			writeErr() {
				return;
			},
			writeOut() {
				return;
			}
		});

		let result: unknown;
		try {
			await program.parseAsync([
				'node',
				'cupboard',
				'--output-mode',
				'github',
				'--help'
			]);
			result = { kind: 'parsed' as const };
		} catch (error_: unknown) {
			result = error_;
		}

		// A valid mode is coerced before `--help` displays and exits; an unknown
		// mode would have thrown a usage error instead of reaching help.
		expectCommanderError(result);
		expect(result.code).toBe('commander.helpDisplayed');
	});

	it('displays help as a usage error for a bare invocation', async () => {
		const program = buildProgram();

		program.configureOutput({
			writeErr() {
				return;
			},
			writeOut() {
				return;
			}
		});

		let result: unknown;

		try {
			await program.parseAsync(['node', 'cupboard']);
			result = { kind: 'parsed' as const };
		} catch (error_: unknown) {
			result = error_;
		}

		expect(result).toBeInstanceOf(CommanderError);

		if (result instanceof CommanderError) {
			expect({ code: result.code, exitCode: result.exitCode }).toStrictEqual({
				code: 'commander.help',
				exitCode: 1
			});
		}
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
			phase: (_label, body) =>
				Promise.resolve(body({ fact: noop, warn: noop })),
			progress: (_label, _options, body) =>
				Promise.resolve(body({ advance: noop, fact: noop, warn: noop })),
			steps: (_label, body) =>
				Promise.resolve(
					body({
						message: noop,
						group: () => ({ message: noop, success: noop, error: noop }),
						warn: noop
					})
				),
			result: noop,
			data: noop,
			warn: noop,
			info: noop,
			success: noop,
			step: noop,
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

	it.each([
		{
			name: 'an explicit --help/help request',
			error: new CommanderError(0, 'commander.helpDisplayed', '(outputHelp)')
		},
		{
			name: 'a bare invocation with no subcommand',
			error: new CommanderError(1, 'commander.help', '(outputHelp)')
		},
		{
			name: 'an explicit --version request',
			error: new CommanderError(0, 'commander.version', '0.0.0')
		}
	])(
		'stays silent when commander merely displayed help ($name)',
		({ error }) => {
			const { reporter, errors } = fakeReporter();

			reportCliFailure(reporter, error);

			expect(errors).toStrictEqual([]);
		}
	);

	it('stays silent when a reporter phase already annotated the failure', () => {
		const { reporter, errors } = fakeReporter();
		const error = new Error('phase failed');

		markErrorReported(error);
		reportCliFailure(reporter, error);

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

function helpFor(path: readonly string[]): string {
	let command: Command = buildProgram();

	for (const name of path) {
		const available = command.commands.map((candidate) => ({
			aliases: candidate.aliases(),
			name: candidate.name()
		}));
		const next = command.commands.find(
			(candidate) =>
				candidate.name() === name || candidate.aliases().includes(name)
		);

		expectCommandFound(next, path, available);

		command = next;
	}

	// `helpInformation()` omits `addHelpText('after')`, which is appended only
	// when help is written, so capture the full rendered output instead.
	let captured = '';
	command.configureOutput({
		writeOut: (text) => {
			captured += text;
		}
	});
	command.outputHelp();

	return captured;
}

function expectCommandFound(
	command: Command | undefined,
	path: readonly string[],
	available: readonly {
		readonly aliases: readonly string[];
		readonly name: string;
	}[]
): asserts command is Command {
	expect({
		available,
		foundType: typeof command?.name(),
		path
	}).toStrictEqual({
		available,
		foundType: 'string',
		path
	});
}

describe('command help', () => {
	it('shows usage examples for push', () => {
		const help = helpFor(['push']);

		expect(help).toContain('Examples:');
		expect(help).toContain('cupboard push');
		expect(help).toContain('--dry-run');
		expect(help).toContain('--no-retain');
		expect(help).toContain('--closure');
		expect(help).toContain('--intermediate-paths-file');
		expect(help).toContain(
			'cupboard push --github-oidc https://cache.example.workers.dev/t/acme ./result \\\n' +
				'    --root github:acme/infra/main'
		);
	});

	it('shows local and remote examples for attest verify', () => {
		const help = helpFor(['attest', 'verify']);

		expect(help).toContain('Local mode');
		expect(help).toContain('Remote mode');
	});

	it('notes that most commands need a login', () => {
		expect(helpFor([])).toContain('cupboard login');
	});

	it('lists the retention grace subcommands under policy', () => {
		const help = helpFor(['policy']);

		expect(help).toContain('add-grace');
		expect(help).toContain('remove-grace');
	});

	it('shows the cache-prefix and grace options for policy add-grace', () => {
		const help = helpFor(['policy', 'add-grace']);

		expect(help).toContain('--cache-prefix');
		expect(help).toContain('--grace');
		expect(help).toContain('Example:');
	});

	it('shows the auth options and an example for confirm', () => {
		const help = helpFor(['confirm']);

		expect(help).toContain('--github-oidc');
		expect(help).toContain('--audience');
		expect(help).toContain('--cache');
		expect(help).toContain('Example:');
	});

	it('lists the list, set and remove subcommands under reuse-view', () => {
		const help = helpFor(['reuse-view']);

		expect(help).toContain('list');
		expect(help).toContain('set');
		expect(help).toContain('remove');
	});

	it('shows the selector and priority options and an example for reuse-view set', () => {
		const help = helpFor(['reuse-view', 'set']);

		expect(help).toContain('--exact');
		expect(help).toContain('--prefix');
		expect(help).toContain('--priority');
		expect(help).toContain('matches');
		expect(help).toContain('every cache');
		expect(help).toContain('Example:');
	});

	it('shows the confirmation option for reuse-view remove', () => {
		const help = helpFor(['reuse-view', 'remove']);

		expect(help).toContain('-y, --yes');
	});
});
