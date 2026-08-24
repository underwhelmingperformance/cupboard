import process, { env } from 'node:process';

import { configureLogging, rootLogger } from '@cupboard/logger';
import { wasErrorReported } from '@cupboard/reporter';
import {
	CodedError,
	formatErrorWithCauses,
	genericExitCode,
	usageExitCode
} from '@cupboard/shared/errors';
import { workflowCommands } from '@cupboard/shared/github-actions';
import { Command, CommanderError } from 'commander';

import { registerAttestCommand } from './commands/attest.ts';
import { registerAttestAttachCommand } from './commands/attest-attach.ts';
import {
	type AttestSignDependencies,
	registerAttestSignCommand
} from './commands/attest-sign.ts';
import { registerBuildCommand } from './commands/build.ts';
import { registerBuildCohortCommand } from './commands/build-cohort.ts';
import { registerPlanCommand } from './commands/plan.ts';
import { registerPushCommand } from './commands/push.ts';
import { registerResolveCupboardCommand } from './commands/resolve-cupboard.ts';
import { registerSetupCommand } from './commands/setup.ts';
import { wasAlreadyReported } from './errors.ts';
import type { Environment } from './inputs.ts';

type GithubActions = Pick<ReturnType<typeof workflowCommands>, 'error'>;

interface ActionSignalSource {
	once(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
	removeListener(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

/**
 * Services that command registrations use instead of process-owned defaults.
 */
export interface ActionProgramDependencies {
	readonly attestSign?: AttestSignDependencies;
}

/**
Maps runner cancellation signals to their conventional shell exit statuses.
*/
export class ActionSignalError extends CodedError {
	constructor(public readonly signal: 'SIGINT' | 'SIGTERM') {
		super(`Action cancelled by ${signal}`);
		this.name = 'ActionSignalError';
	}

	override get exitCode(): number {
		return this.signal === 'SIGINT' ? 130 : 143;
	}
}

/**
 * Creates the command tree for the composite GitHub Action. Commands receive
 * the supplied environment when they resolve runner-derived defaults. Other
 * process-owned services can be replaced through `dependencies`.
 */
export function buildProgram(
	environment: Environment = env,
	signal?: AbortSignal,
	dependencies: ActionProgramDependencies = {}
): Command {
	const program = new Command()
		.name('cupboard-action')
		.description('Run the cupboard composite GitHub Action steps.')
		// Throw a CommanderError rather than exiting the process, and keep
		// commander silent on stderr, so a usage error reaches
		// `reportActionFailure` and is annotated once through the workflow
		// commands.
		.exitOverride()
		.configureOutput({
			outputError: () => {
				// `reportActionFailure` annotates the failure; commander stays silent.
			}
		});

	registerSetupCommand(program, environment, signal);
	registerPushCommand(program, environment, signal);
	registerResolveCupboardCommand(program, environment);
	registerAttestCommand(program, environment);
	registerAttestSignCommand(program, dependencies.attestSign ?? {});
	registerAttestAttachCommand(program, environment, signal);
	registerBuildCommand(program, environment, signal);
	registerBuildCohortCommand(program, environment, signal);
	registerPlanCommand(program, environment, signal);

	return program;
}

/**
 * Parses the arguments, runs the matching subcommand, and returns its process
 * exit code. Logging uses GitHub Actions workflow commands.
 */
export async function runAction(
	argument: readonly string[],
	environment: Environment = env,
	signalSource: ActionSignalSource = process,
	dependencies: ActionProgramDependencies = {}
): Promise<number> {
	const githubActions = workflowCommands();
	const isSignalAwareCommand = [
		'setup',
		'attest-attach',
		'build',
		'build-cohort',
		'plan',
		'push'
	].includes(argument[2] ?? '');
	const controller = isSignalAwareCommand ? new AbortController() : undefined;
	const abortSigint = (): void => {
		controller?.abort(new ActionSignalError('SIGINT'));
	};
	const abortSigterm = (): void => {
		controller?.abort(new ActionSignalError('SIGTERM'));
	};

	configureLogging();

	if (controller !== undefined) {
		signalSource.once('SIGINT', abortSigint);
		signalSource.once('SIGTERM', abortSigterm);
	}

	try {
		await buildProgram(
			environment,
			controller?.signal,
			dependencies
		).parseAsync([...argument]);
		return 0;
	} catch (error: unknown) {
		return reportActionFailure(githubActions, error);
	} finally {
		if (controller !== undefined) {
			signalSource.removeListener('SIGINT', abortSigint);
			signalSource.removeListener('SIGTERM', abortSigterm);
		}
	}
}

export function reportActionFailure(
	githubActions: GithubActions,
	error: unknown
): number {
	// A CommanderError's exit code is 0 when it merely displayed help or the
	// version; any other commander failure is a usage error.
	if (error instanceof CommanderError) {
		if (error.exitCode === 0) {
			return 0;
		}

		githubActions.error(error.message);

		return usageExitCode;
	}

	if (error instanceof ActionSignalError) {
		return error.exitCode;
	}

	// githubActions.error escapes newlines, so the multi-line text stays one
	// annotation.
	if (error instanceof CodedError) {
		if (!wasAlreadyReported(error) && !wasErrorReported(error)) {
			githubActions.error(formatErrorWithCauses(error));
		}

		return error.exitCode;
	}

	if (!wasErrorReported(error)) {
		githubActions.error(formatErrorWithCauses(error));
	}
	rootLogger().debug('action failed', { error });

	return genericExitCode;
}
