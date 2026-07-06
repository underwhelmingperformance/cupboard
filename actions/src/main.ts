#!/usr/bin/env node
import process from 'node:process';

import { configureLogging, rootLogger } from '@cupboard/logger';
import { CodedError, genericExitCode } from '@cupboard/shared/errors';

import * as annotations from './annotations.ts';
import { dispatch } from './cupboard-action.ts';
import { githubActionsSink } from './logging.ts';

// The action runs under Node on a CI runner, so logs are emitted as GitHub
// Actions workflow commands: annotations for warnings and errors, and
// `::debug::` for detail.
configureLogging({ sink: githubActionsSink() });

try {
	await dispatch(process.argv[2]);
} catch (error: unknown) {
	if (error instanceof CodedError) {
		annotations.error(error.message);
		process.exitCode = error.exitCode;
	} else {
		annotations.error(error instanceof Error ? error.message : String(error));
		// The full error, with its stack, goes to the Actions debug log.
		rootLogger().debug('action dispatch failed', { error });
		process.exitCode = genericExitCode;
	}
}
