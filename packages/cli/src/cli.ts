import {
	clackSink,
	type CliUi,
	ConfirmationRequiredError,
	createCliUi,
	resolveReporterMode
} from '@cupboard/cli-ui';
import {
	configureLogging,
	type Logger,
	rootLogger,
	type Sink
} from '@cupboard/logger';
import { jsonLinesSink } from '@cupboard/logger/sinks';
import {
	type Reporter,
	type ReporterMode,
	wasErrorReported
} from '@cupboard/reporter';
import { usageExitCode } from '@cupboard/shared/errors';
import { Command, CommanderError, InvalidArgumentError } from 'commander';
import pc from 'picocolors';
import { z } from 'zod';

import { isAbortError } from './abort.ts';
import { registerAttestCommands } from './commands/attest.ts';
import { registerAuthKeyCommands } from './commands/auth-key.ts';
import { registerCacheCommands } from './commands/cache.ts';
import { registerCheckCommand } from './commands/check.ts';
import { registerConfigCommand } from './commands/config.ts';
import { registerConfirmCommand } from './commands/confirm.ts';
import { registerControlKeyCommands } from './commands/control-key.ts';
import { registerDeleteCommand } from './commands/delete.ts';
import { registerDeployCommand } from './commands/deploy.ts';
import { registerKeyCommands } from './commands/key.ts';
import { registerLoginCommand } from './commands/login.ts';
import {
	registerControlOidcTrustCommands,
	registerOidcTrustCommands
} from './commands/oidc-trust.ts';
import { registerPolicyCommands } from './commands/policy.ts';
import { registerPubkeyCommand } from './commands/pubkey.ts';
import { registerPushCommand } from './commands/push.ts';
import { registerReuseViewCommands } from './commands/reuse-view.ts';
import { registerRootCommands } from './commands/root.ts';
import { registerStatsCommand } from './commands/stats.ts';
import { registerTenantCommands } from './commands/tenant.ts';
import { CliError } from './errors.ts';
import { cupboardVersion } from './version.ts';

export interface GlobalOptions {
	readonly outputMode?: ReporterMode;
	readonly colour?: boolean;
	readonly resultFile?: string;
}

const reporterModeSchema = z.enum([
	'terminal',
	'json',
	'github'
]) satisfies z.ZodType<ReporterMode>;

// Parse `--output-mode` into a `ReporterMode` at the flag boundary, so the rest
// of the CLI never handles the raw string. A bad value is a usage error.
function parseOutputMode(value: string): ReporterMode {
	const parsed = reporterModeSchema.safeParse(value);

	if (!parsed.success) {
		throw new InvalidArgumentError(
			`Output mode must be one of: ${reporterModeSchema.options.join(', ')}.`
		);
	}

	return parsed.data;
}

// The LogTape sink diagnostics flow through for a run: clack narration in
// terminal mode (sharing the UI's colour setting) or line-delimited JSON on
// stderr in machine mode, so structured logs never contaminate stdout.
function loggingSink(mode: ReporterMode, colour: boolean | undefined): Sink {
	if (mode === 'terminal') {
		return clackSink(pc.createColors(colour ?? pc.isColorSupported));
	}

	return jsonLinesSink((line) => process.stderr.write(line));
}

// The command-scoped logger for the run in progress, set once the invoked
// subcommand is known (the `preAction` hook). Held on an object so the hook
// updates a field on it; before a command begins, callers fall back to the bare
// root logger.
const commandLoggerState: { logger?: Logger } = {};

/**
 * The logger for the running command: the application root logger tagged with
 * the invoked subcommand's name, so every record it emits carries `command`.
 * Handlers call this to obtain a logger without threading one through their
 * signatures; it falls back to {@link rootLogger} before a command has begun.
 */
export function commandLogger(): Logger {
	return commandLoggerState.logger ?? rootLogger();
}

export interface ProgramOptions {
	readonly signal?: AbortSignal;
}

export function buildProgram(options: ProgramOptions = {}): Command {
	const command = new Command();
	const program = command
		.name('cupboard')
		.description(
			'Operate a multi-tenant Nix binary cache hosted on Cloudflare Workers: ' +
				'push store paths, manage tenants and keys, and configure Nix clients.'
		)
		.version(cupboardVersion)
		.option(
			'--output-mode <mode>',
			'force the output mode: terminal (spinner), json (line-delimited) or github (workflow commands)',
			parseOutputMode
		)
		.option('--colour', 'force ANSI colour output')
		.option('--no-colour', 'disable ANSI colour output')
		.option(
			'--result-file <path>',
			'append machine-readable result events (JSONL) to this file'
		)
		.addHelpText(
			'after',
			'\nMost commands act on a deployment and need a session first: ' +
				'run `cupboard login <url>`.'
		)
		// Throw a CommanderError with commander's own error text suppressed, so a
		// usage error (unknown command, missing argument) reaches the top-level
		// funnel and is reported once in the active mode, not as prose plus a usage
		// block.
		.exitOverride()
		.configureOutput({
			outputError: () => {
				// The top-level funnel reports the failure; commander stays silent.
			}
		})
		// The one place a run's output mode and colour are settled: the global flags
		// have parsed and the invoked subcommand is known, so configure logging once
		// (idempotent) and scope the root logger to the command for its handler.
		.hook('preAction', (_thisCommand, actionCommand) => {
			const mode = reporterModeFromGlobals(command);

			configureLogging({ sink: loggingSink(mode, colourFromGlobals(command)) });
			commandLoggerState.logger = rootLogger().with({
				command: actionCommand.name()
			});
		});

	registerDeployCommand(program, options);
	registerLoginCommand(program, options);
	registerAttestCommands(program, options);
	registerPushCommand(program, options);
	registerConfigCommand(program, options);
	registerPubkeyCommand(program, options);
	registerStatsCommand(program, options);
	registerDeleteCommand(program, options);
	registerRootCommands(program, options);
	registerConfirmCommand(program, options);
	registerKeyCommands(program, options);
	registerAuthKeyCommands(program, options);
	registerControlKeyCommands(program, options);
	registerControlOidcTrustCommands(program, options);
	registerTenantCommands(program, options);
	registerCacheCommands(program, options);
	registerPolicyCommands(program, options);
	registerReuseViewCommands(program, options);
	registerOidcTrustCommands(program, options);
	registerCheckCommand(program, options);

	return program;
}

function reporterModeFromGlobals(program: Command): ReporterMode {
	return resolveReporterMode(program.opts<GlobalOptions>().outputMode);
}

export function colourFromGlobals(program: Command): boolean | undefined {
	return program.opts<GlobalOptions>().colour;
}

function resultFileFromGlobals(program: Command): string | undefined {
	return program.opts<GlobalOptions>().resultFile;
}

/**
 * The {@link CliUi} for a command: the output mode comes from `--output-mode`
 * and the environment, the colour from `--colour`/`--no-colour`, connected to
 * the program's abort signal so an interrupted command renders its active spinner,
 * bar or task as cancelled. `assumeYes` carries a command's `--yes` flag through
 * to confirmations.
 */
export function commandUi(
	program: Command,
	options: ProgramOptions,
	extra: { readonly assumeYes?: boolean } = {}
): CliUi {
	return createCliUi({
		mode: reporterModeFromGlobals(program),
		colour: colourFromGlobals(program),
		resultFile: resultFileFromGlobals(program),
		signal: options.signal,
		...extra
	});
}

/**
 * The reporter mode for a top-level failure. The `--output-mode` flag wins when
 * it parsed; a failure before parsing finished falls back to the environment.
 */
export function failureReporterMode(program: Command): ReporterMode {
	try {
		return reporterModeFromGlobals(program);
	} catch {
		return resolveReporterMode();
	}
}

/**
 * The colour preference for a top-level failure, or undefined when the flag did
 * not parse, so the reporter falls back to picocolors' own detection.
 */
export function failureColour(program: Command): boolean | undefined {
	try {
		return colourFromGlobals(program);
	} catch {
		return undefined;
	}
}

/**
 * The process exit code a thrown value maps to: the abort code for a Ctrl-C, a
 * typed CLI failure's own code, or the catch-all 1 for anything else.
 */
export function cliExitCode(error: unknown, abortExitCode: number): number {
	if (isAbortError(error)) {
		return abortExitCode;
	}

	// A CommanderError's own exit code is 0 when it merely displayed help or the
	// version; any other commander failure is a usage error.
	if (error instanceof CommanderError) {
		return error.exitCode === 0 ? error.exitCode : usageExitCode;
	}

	// A confirmation refused for want of a terminal is the caller's to fix by
	// passing --yes or running interactively: a usage error, like a bad flag.
	if (error instanceof ConfirmationRequiredError) {
		return usageExitCode;
	}

	return error instanceof CliError ? error.exitCode : 1;
}

/**
 * Reports a top-level failure through the reporter: one `{event:'error'}` in JSON
 * mode, one red marker line in terminal mode. An abort (Ctrl-C) is a
 * cancellation, not a failure, so it reports nothing and the exit code carries
 * it.
 */
export function reportCliFailure(reporter: Reporter, error: unknown): void {
	if (isAbortError(error)) {
		return;
	}

	if (wasErrorReported(error)) {
		return;
	}

	// Commander has already rendered successful informational output or help.
	// A bare invocation reports help with exit 1, so its code must be recognised
	// separately from successful `--help` and `--version` exits.
	if (
		error instanceof CommanderError &&
		(error.exitCode === 0 || error.code.startsWith('commander.help'))
	) {
		return;
	}

	reporter.error(error);
}
