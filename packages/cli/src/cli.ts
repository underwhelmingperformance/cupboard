import { ConfirmationRequiredError } from '@cupboard/cli-ui';
import type { Reporter, ReporterMode } from '@cupboard/reporter';
import { resolveReporterMode } from '@cupboard/shared';
import { Command, CommanderError } from 'commander';

import { isAbortError } from './abort.ts';
import { registerAttestCommands } from './commands/attest.ts';
import { registerAuthKeyCommands } from './commands/auth-key.ts';
import { registerCacheCommands } from './commands/cache.ts';
import { registerCheckCommand } from './commands/check.ts';
import { registerConfigCommand } from './commands/config.ts';
import { registerControlKeyCommands } from './commands/control-key.ts';
import { registerDeleteCommand } from './commands/delete.ts';
import { registerDeployCommand } from './commands/deploy.ts';
import { registerKeyCommands } from './commands/key.ts';
import { registerLoginCommand } from './commands/login.ts';
import { registerOidcTrustCommands } from './commands/oidc-trust.ts';
import { registerPolicyCommands } from './commands/policy.ts';
import { registerPubkeyCommand } from './commands/pubkey.ts';
import { registerPushCommand } from './commands/push.ts';
import { registerRootCommands } from './commands/root.ts';
import { registerStatsCommand } from './commands/stats.ts';
import { registerTenantCommands } from './commands/tenant.ts';
import { CliError, usageExitCode } from './errors.ts';
import { cupboardVersion } from './version.ts';

export interface GlobalOptions {
	readonly colour?: boolean;
}

export interface ProgramOptions {
	readonly signal?: AbortSignal;
}

export function buildProgram(options: ProgramOptions = {}): Command {
	const program = new Command()
		.name('cupboard')
		.description(
			'Operate a multi-tenant Nix binary cache hosted on Cloudflare Workers: ' +
				'push store paths, manage tenants and keys, and configure Nix clients.'
		)
		.version(cupboardVersion)
		.option('--colour', 'force interactive spinner and colour output')
		.option('--no-colour', 'force plain line-delimited JSON output')
		.addHelpText(
			'after',
			'\nMost commands act on a deployment and need a session first: ' +
				'run `cupboard login <url>`.'
		)
		// Throw a CommanderError instead of writing to stderr and exiting, and
		// suppress commander's own error text, so a usage error (unknown command,
		// missing argument) reaches the top-level funnel and is reported once in the
		// active mode rather than as prose plus a usage block.
		.exitOverride()
		.configureOutput({
			outputError: () => {
				// The top-level funnel reports the failure; commander stays silent.
			}
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
	registerKeyCommands(program, options);
	registerAuthKeyCommands(program, options);
	registerControlKeyCommands(program, options);
	registerTenantCommands(program, options);
	registerCacheCommands(program, options);
	registerPolicyCommands(program, options);
	registerOidcTrustCommands(program, options);
	registerCheckCommand(program, options);

	return program;
}

export function reporterModeFromGlobals(program: Command): ReporterMode {
	return resolveReporterMode(program.opts<GlobalOptions>().colour);
}

/**
 * The reporter mode for a top-level failure. The `--colour` flag wins when it
 * parsed; a failure before parsing finished falls back to the environment.
 */
export function failureReporterMode(program: Command): ReporterMode {
	try {
		return reporterModeFromGlobals(program);
	} catch {
		return resolveReporterMode();
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

	// Displaying help or the version is a clean exit, not a failure to report.
	if (error instanceof CommanderError && error.exitCode === 0) {
		return;
	}

	reporter.error(error);
}
