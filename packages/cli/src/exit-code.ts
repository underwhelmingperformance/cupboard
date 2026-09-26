import { CodedError, genericExitCode } from '@cupboard/shared/errors';

/**
 * Returns the exit status for a failure: a `CodedError`'s own exit status, or 1
 * for anything else. `cliExitCode` handles cancellation and Commander errors.
 */
export function errorExitCode(error: unknown): number {
	return error instanceof CodedError ? error.exitCode : genericExitCode;
}
