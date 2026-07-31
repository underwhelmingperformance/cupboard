import { env } from 'node:process';

import { configureLogging, rootLogger } from '@cupboard/logger';
import { wasErrorReported } from '@cupboard/reporter';
import {
	CodedError,
	genericExitCode,
	usageExitCode
} from '@cupboard/shared/errors';
import { workflowCommands } from '@cupboard/shared/github-actions';
import { Command, CommanderError } from 'commander';

import { registerAttestCommand } from './commands/attest.ts';
import { registerBuildCommand } from './commands/build.ts';
import { registerBuildCohortCommand } from './commands/build-cohort.ts';
import { registerPlanCommand } from './commands/plan.ts';
import { registerPushCommand } from './commands/push.ts';
import { registerSetupCommand } from './commands/setup.ts';
import { wasAlreadyReported } from './errors.ts';
import type { Environment } from './inputs.ts';

type GithubActions = Pick<ReturnType<typeof workflowCommands>, 'error'>;

/**
 * The `cupboard-action` command: the composite GitHub Action's `setup`, `push`,
 * `attest` and `plan` steps run through it, with the runner-contract
 * environment threaded to each subcommand so its handler can resolve
 * runner-derived defaults.
 */
export function buildProgram(environment: Environment = env): Command {
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

	registerSetupCommand(program, environment);
	registerPushCommand(program, environment);
	registerAttestCommand(program, environment);
	registerBuildCommand(program, environment);
	registerBuildCohortCommand(program, environment);
	registerPlanCommand(program, environment);

	return program;
}

/**
 * Parse `argument` and run the matching subcommand, returning the process exit
 * code. The action runs under Node on a CI runner, so logging auto-configures
 * to GitHub Actions workflow commands.
 */
export async function runAction(
	argument: readonly string[],
	environment: Environment = env
): Promise<number> {
	const githubActions = workflowCommands();

	configureLogging();

	try {
		await buildProgram(environment).parseAsync([...argument]);
		return 0;
	} catch (error: unknown) {
		return reportActionFailure(githubActions, error);
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

	if (error instanceof CodedError) {
		if (!wasAlreadyReported(error) && !wasErrorReported(error)) {
			githubActions.error(error.message);
		}

		return error.exitCode;
	}

	if (!wasErrorReported(error)) {
		githubActions.error(error instanceof Error ? error.message : String(error));
	}
	// The full error, with its stack, goes to the Actions debug log.
	rootLogger().debug('action failed', { error });

	return genericExitCode;
}
