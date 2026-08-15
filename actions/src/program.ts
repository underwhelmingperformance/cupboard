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

/** A runner signal whose conventional shell exit status the action preserves. */
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
 * The `cupboard-action` command: the composite GitHub Action's `setup`, `push`,
 * `attest` and `plan` steps run through it, with the runner-contract
 * environment threaded to each subcommand so its handler can resolve
 * runner-derived defaults.
 */
export function buildProgram(
	environment: Environment = env,
	signal?: AbortSignal
): Command {
	const program = new Command()
		.name('cupboard-action')
		.description('Run the cupboard composite GitHub Action steps.')
		// Throw a CommanderError rather than exiting the process, and keep
		// commander silent on stderr, so a usage error reaches the funnel and is
		// annotated once through the workflow commands.
		.exitOverride()
		.configureOutput({
			outputError: () => {
				// The funnel annotates the failure; commander stays silent.
			}
		});

	registerSetupCommand(program, environment, signal);
	registerPushCommand(program, environment, signal);
	registerResolveCupboardCommand(program, environment);
	registerAttestCommand(program, environment);
	registerAttestAttachCommand(program, environment, signal);
	registerBuildCommand(program, environment, signal);
	registerBuildCohortCommand(program, environment, signal);
	registerPlanCommand(program, environment, signal);

	return program;
}

/**
 * Parse `argument` and run the matching subcommand, returning the process exit
 * code. The action runs under Node on a CI runner, so logging auto-configures
 * to GitHub Actions workflow commands.
 */
export async function runAction(
	argument: readonly string[],
	environment: Environment = env,
	signalSource: ActionSignalSource = process
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
		await buildProgram(environment, controller?.signal).parseAsync([
			...argument
		]);
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
	// The full error, with its stack, goes to the Actions debug log.
	rootLogger().debug('action failed', { error });

	return genericExitCode;
}
