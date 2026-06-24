#!/usr/bin/env node
import process from 'node:process';

import { CodedError, genericExitCode } from '@cupboard/shared/errors';

import { dispatch } from './cupboard-action.ts';

try {
	await dispatch(process.argv[2]);
} catch (error: unknown) {
	if (error instanceof CodedError) {
		console.error(error.message);
		process.exitCode = error.exitCode;
	} else {
		console.error(error);
		process.exitCode = genericExitCode;
	}
}
