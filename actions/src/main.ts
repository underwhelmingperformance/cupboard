#!/usr/bin/env node
import process from 'node:process';

import { configureLogging, rootLogger } from '@cupboard/logger';
import { CodedError, genericExitCode } from '@cupboard/shared/errors';
import { workflowCommands } from '@cupboard/shared/github-actions';

import { dispatch } from './cupboard-action.ts';

const githubActions = workflowCommands();

// The action runs under Node on a CI runner, so logging auto-configures to
// GitHub Actions workflow commands: annotations for warnings and errors, and
// `::debug::` for detail.
configureLogging();

try {
	await dispatch(process.argv[2]);
} catch (error: unknown) {
	if (error instanceof CodedError) {
		githubActions.error(error.message);
		process.exitCode = error.exitCode;
	} else {
		githubActions.error(error instanceof Error ? error.message : String(error));
		// The full error, with its stack, goes to the Actions debug log.
		rootLogger().debug('action dispatch failed', { error });
		process.exitCode = genericExitCode;
	}
}
