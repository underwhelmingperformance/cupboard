/**
 * Process exit codes by failure category, so a caller can tell a misuse from
 * the catch-all. 2 is the usual shell convention for a usage error and 1 is the
 * catch-all; packages layer their own categories (for example the BSD sysexits
 * codes) on top.
 */
export const genericExitCode = 1;
export const usageExitCode = 2;

/** An error that carries the process exit code its failure should produce. */
export abstract class CodedError extends Error {
	get exitCode(): number {
		return genericExitCode;
	}
}

/** A misuse: a bad argument value or an unsupported combination of them. */
export abstract class UsageError extends CodedError {
	override get exitCode(): number {
		return usageExitCode;
	}
}
