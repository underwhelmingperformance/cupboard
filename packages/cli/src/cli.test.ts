import { ConfirmationRequiredError } from '@cupboard/cli-ui';
import { markErrorReported, type Reporter } from '@cupboard/reporter';
import { usageExitCode } from '@cupboard/shared/errors';
import { ORPCError } from '@orpc/client';
import { type Command, CommanderError } from 'commander';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

import { buildProgram, cliExitCode, reportCliFailure } from './cli.ts';
import { GithubRateLimitError } from './commands/oidc-trust/github.ts';
import {
	authExitCode,
	CacheInfoRateLimitedError,
	CacheInfoServerError,
	CheckDiscrepanciesError,
	CliAbortError,
	CupboardHttpError,
	InvalidCacheNameError,
	OwnerLoginRequiredError,
	PushIncompleteError,
	RootRetentionOptionError,
	transientExitCode,
	TrustRuleFileConflictError,
	TrustRuleOptionsRequiredError,
	UploadWaitTimeoutError
} from './errors.ts';
import { RootTargetLimitError } from './push/push.ts';

const abortExitCode = 130;

const unreachable = new CupboardHttpError('PUT', '/nar', 502, 'bad gateway');
const rateLimited = new CupboardHttpError('PUT', '/nar', 429, 'slow down');
const notFound = new CupboardHttpError('PUT', '/nar', 404, 'gone');
const rejected = new CupboardHttpError('PUT', '/nar', 401, 'expired');
const commitTimedOut = new UploadWaitTimeoutError(1, 600);

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
			name: 'a 507 quota response',
			error: new CupboardHttpError('GET', '/x', 507, ''),
			expected: 1
		},
		{
			name: 'a rate-limited admin-API response',
			error: new ORPCError('TOO_MANY_REQUESTS', { status: 429 }),
			expected: transientExitCode
		},
		{
			name: 'an unavailable admin-API response',
			error: new ORPCError('SERVICE_UNAVAILABLE', { status: 503 }),
			expected: transientExitCode
		},
		{
			name: 'a failed admin-API response',
			error: new ORPCError('INTERNAL_SERVER_ERROR', { status: 500 }),
			expected: transientExitCode
		},
		{
			name: 'an admin-API response for a missing resource',
			error: new ORPCError('NOT_FOUND', { status: 404 }),
			expected: 1
		},
		{
			name: 'an admin-API conflict',
			error: new ORPCError('CACHE_ALREADY_EXISTS', { status: 409 }),
			expected: 1
		},
		{
			name: 'a push whose paths failed only transiently',
			error: new PushIncompleteError(
				['app', 'runtime', 'lib'],
				[unreachable, rateLimited, commitTimedOut]
			),
			expected: transientExitCode
		},
		{
			name: 'a push with a transient and a permanent path failure',
			error: new PushIncompleteError(['app', 'lib'], [notFound, unreachable]),
			expected: transientExitCode
		},
		{
			name: 'a push with an authentication path failure',
			error: new PushIncompleteError(['app', 'lib'], [unreachable, rejected]),
			expected: authExitCode
		},
		{
			name: 'a push whose admin-API prepare was rate limited',
			error: new PushIncompleteError(
				['app'],
				[new ORPCError('TOO_MANY_REQUESTS', { status: 429 })]
			),
			expected: transientExitCode
		},
		{
			name: 'a push whose paths failed permanently',
			error: new PushIncompleteError(
				['app'],
				[new Error('the NAR hash did not match')]
			),
			expected: 1
		},
		{
			name: 'a push over the root target limit',
			error: new RootTargetLimitError(150, 149),
			expected: usageExitCode
		},
		{
			name: 'a check that found discrepancies',
			error: new CheckDiscrepanciesError(2),
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

	it('rejects an invalid instance name as a concise usage error', async () => {
		let result: unknown;

		try {
			await buildProgram().parseAsync([
				'node',
				'cupboard',
				'init',
				'--instance-name',
				'Not Valid'
			]);
			result = { kind: 'parsed' as const };
		} catch (error: unknown) {
			result = error;
		}

		expectCommanderError(result);
		expect({
			code: result.code,
			exitCode: cliExitCode(result, abortExitCode),
			message: result.message
		}).toStrictEqual({
			code: 'commander.invalidArgument',
			exitCode: usageExitCode,
			message:
				"error: option '--instance-name <name>' argument 'Not Valid' is invalid. " +
				'Instance name must contain only lower-case letters, digits and internal ' +
				'hyphens, and must be at most 63 characters long.'
		});
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
	/*
	a reporter method the funnel does not exercise
	*/
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

// Commander wraps option descriptions to the terminal width, so compare a
// multi-word description against the help with its line breaks flattened.
function unwrapped(text: string): string {
	return text.replaceAll(/\s+/gu, ' ');
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
			'cupboard push --github-oidc https://cupboard.example.workers.dev/t/acme ./result \\\n' +
				'    --root github:acme/app/main'
		);
	});

	// A control-plane rule grants control, tenant or wildcard authority, which
	// has no flags, so its `add` reads the whole rule from a file and offers
	// none of the tenant rule's cache, root or template flags.
	it.each([
		{
			path: ['control-oidc-trust', 'add'],
			shown: [
				'--from-file <path>',
				'cupboard control-oidc-trust add https://cupboard.example.workers.dev \\',
				'"permittedGrants": [{ "type": "cupboard_wildcard" }]'
			],
			hidden: [
				'--issuer',
				'--audience',
				'--claim',
				'--allow',
				'--cache',
				'--root',
				'--capture',
				'--template-source',
				'/t/acme'
			]
		},
		{
			path: ['oidc-trust', 'add'],
			shown: [
				'--issuer <issuer>',
				'--allow <action>',
				'--cache <name>',
				'--cache-template <template>',
				'--template-source <name>',
				'--from-file <path>',
				'cupboard oidc-trust add https://cupboard.example.workers.dev/t/acme'
			],
			hidden: ['control-oidc-trust']
		}
	])(
		'shows only the options that apply to $path',
		({ path, shown, hidden }) => {
			const help = helpFor(path);

			expect({
				shown: shown.filter((text) => !help.includes(text)),
				hidden: hidden.filter((text) => help.includes(text))
			}).toStrictEqual({ shown: [], hidden: [] });
		}
	);

	it('offers no GitHub presets for control-plane trust rules', () => {
		const help = helpFor(['control-oidc-trust']);

		expect(help).not.toContain('add-github');
	});

	it('requires --from-file for a control-plane trust rule', async () => {
		await expect(
			buildProgram().parseAsync([
				'node',
				'cupboard',
				'control-oidc-trust',
				'add',
				'https://cupboard.example.workers.dev'
			])
		).rejects.toMatchObject({ code: 'commander.missingMandatoryOptionValue' });
	});

	it.each([
		{
			name: 'rule options alongside --from-file',
			args: [
				'--from-file',
				'rule.json',
				'--issuer',
				'https://token.actions.githubusercontent.com'
			],
			error: TrustRuleFileConflictError
		},
		{
			name: 'no --issuer or --audience without --from-file',
			args: ['--allow', 'push'],
			error: TrustRuleOptionsRequiredError
		}
	])('refuses $name for a tenant trust rule', async ({ args, error }) => {
		await expect(
			buildProgram().parseAsync([
				'node',
				'cupboard',
				'oidc-trust',
				'add',
				'https://cupboard.example.workers.dev/t/acme',
				...args
			])
		).rejects.toBeInstanceOf(error);
	});

	it('shows local and remote examples for attest verify', () => {
		const help = helpFor(['attest', 'verify']);

		expect(help).toContain('Verify local bundle files');
		expect(help).toContain('Verify the bundles that a cache has');
	});

	it('notes that most commands need a login', () => {
		expect(helpFor([])).toContain('cupboard login');
	});

	it('requires --access when creating a tenant', async () => {
		const help = helpFor(['tenant', 'create']);

		expect(help).toContain('--access <mode>');
		expect(unwrapped(help)).toContain(
			"read access for the tenant's default cache: public or private"
		);
		await expect(
			buildProgram().parseAsync([
				'node',
				'cupboard',
				'tenant',
				'create',
				'https://cupboard.example',
				'acme',
				'--owner-issuer',
				'https://issuer.example',
				'--owner-subject',
				'owner',
				'--owner-audience',
				'cupboard'
			])
		).rejects.toMatchObject({ code: 'commander.missingMandatoryOptionValue' });
	});

	it('lists --access in init help', () => {
		const help = helpFor(['init']);

		expect(help).toContain('--access <mode>');
		expect(unwrapped(help)).toContain(
			"read access for the first tenant's default cache: public or " +
				'private (you are asked if you leave it out)'
		);
	});

	it('describes immediate read and write suspension', () => {
		expect(helpFor(['tenant', 'suspend'])).toContain(
			'Suspend a tenant. Its reads, pushes, sign-in and maintenance stop immediately.'
		);
	});

	it('sets a tenant quota in bytes and clears it with its own command', () => {
		expect(unwrapped(helpFor(['tenant', 'set-quota']))).toContain(
			"Set a tenant's storage quota. It can't be less than the tenant " +
				'already stores.'
		);
		expect(helpFor(['tenant', 'set-quota'])).toContain('<bytes>');
		expect(helpFor(['tenant', 'clear-quota'])).toContain(
			"Remove a tenant's storage quota, leaving it unlimited."
		);
	});

	it('shows the auth options and an example for confirm', () => {
		const help = helpFor(['confirm']);

		expect(help).toContain('--github-oidc');
		expect(help).toContain('--audience');
		expect(help).toContain('optional cache name');
		expect(help).toContain('Example:');
	});

	it('lists the list, set and remove subcommands under reuse-view', () => {
		const help = helpFor(['reuse-view']);

		expect(help).toContain('list');
		expect(help).toContain('set');
		expect(help).toContain('remove');
	});

	it('lists cache creation and direct property updates under cache', () => {
		const help = helpFor(['cache']);

		expect(help).toContain('create');
		expect(help).toContain('set-access');
		expect(help).toContain('set-priority');
		expect(help).toContain('set-root-ttl');
		expect(help).toContain('clear-root-ttl');
		expect(help).toContain('set-grace');
		expect(help).toContain('clear-grace');
	});

	it.each([
		['set-access', '--access <mode>'],
		['set-priority', '--priority <n>'],
		['set-grace', '--grace <duration>']
	])('requires the new value for cache %s', async (command, option) => {
		expect(helpFor(['cache', command])).toContain(option);
		await expect(
			buildProgram().parseAsync([
				'node',
				'cupboard',
				'cache',
				command,
				'https://cupboard.example/t/acme',
				'builds'
			])
		).rejects.toMatchObject({ code: 'commander.missingMandatoryOptionValue' });
	});

	it('requires one retention value for cache set-root-ttl', async () => {
		expect(helpFor(['cache', 'set-root-ttl'])).toContain(
			'--root-ttl <duration>'
		);
		await expect(
			buildProgram().parseAsync([
				'node',
				'cupboard',
				'cache',
				'set-root-ttl',
				'https://cupboard.example/t/acme',
				'builds'
			])
		).rejects.toThrow(RootRetentionOptionError);
	});

	it('requires cache create to select a named cache', () => {
		const help = helpFor(['cache', 'create']);

		expect(help).toContain('Create a named cache.');
		expect(help).toContain('cache name, if the URL is a tenant URL');
		expect(help).toContain('--root-ttl <duration>');
		expect(help).toContain('--grace <duration>');
	});

	it.each(['set-root-ttl', 'clear-root-ttl'])(
		'shows the optional root prefix for cache %s',
		(command) => {
			expect(helpFor(['cache', command])).toContain('--root-prefix <prefix>');
		}
	);

	it('shows the selector, priority and access options and examples for reuse-view set', () => {
		const help = helpFor(['reuse-view', 'set']);

		expect(help).toContain('--select');
		expect(help).toContain('--priority');
		expect(help).toContain('--access');
		expect(help).toContain('cache:<name>');
		expect(help).toContain('prefix:<prefix>');
		expect(help).toContain('Examples:');
	});

	it('shows the confirmation option for reuse-view remove', () => {
		const help = helpFor(['reuse-view', 'remove']);

		expect(help).toContain('-y, --yes');
	});
});
