#!/usr/bin/env node
import process from 'node:process';

import { CodedError, genericExitCode } from '@cupboard/shared/errors';

import * as annotations from './annotations.ts';
import { dispatch } from './cupboard-action.ts';

try {
	await dispatch(process.argv[2]);
} catch (error: unknown) {
	if (error instanceof CodedError) {
		annotations.error(error.message);
		process.exitCode = error.exitCode;
	} else {
		annotations.error(error instanceof Error ? error.message : String(error));
		// Keep the full error, with its stack, in the log for debugging.
		console.error(error);
		process.exitCode = genericExitCode;
	}
}
