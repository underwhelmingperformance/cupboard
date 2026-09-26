import { CodedError, genericExitCode } from '@cupboard/shared/errors';

import { translateRpcError } from './client/rpc-errors.ts';
import {
	authExitCode,
	publicationExitCode,
	type RankedExitStatus,
	transientExitCode,
	unavailableExitCode
} from './errors.ts';

/**
 * Returns the exit status for a failure: a `CodedError`'s own exit status, or 1
 * for anything else. `cliExitCode` handles cancellation and Commander errors.
 */
export function errorExitCode(error: unknown): number {
	return error instanceof CodedError ? error.exitCode : genericExitCode;
}

/**
 * The exit statuses that {@link classifyFailures} checks for, in the order in
 * which it checks them.
 */
const rankedExitStatuses: readonly RankedExitStatus[] = [
	authExitCode,
	transientExitCode,
	unavailableExitCode
];

/**
 * The exit status to report when several independent operations fail, and the
 * failure that has that exit status.
 */
export interface FailureClassification<Fallback extends number> {
	readonly exitCode: RankedExitStatus | Fallback;
	readonly cause: unknown;
}

/**
 * Returns 77 and the first authentication or authorisation failure if there is
 * one, otherwise 75 and the first transient failure, otherwise 69 and the first
 * failure caused by an unavailable dependency. Otherwise it returns
 * `fallbackExitCode` and the first defined cause. Authentication and
 * authorisation rank first because a re-run cannot succeed until the user signs
 * in again or uses a credential with the required access.
 *
 * Each cause is converted with `translateRpcError` first, so the returned cause
 * is the converted CLI error. A converted session or scope error keeps the oRPC
 * error as its cause, so a report of the returned cause includes the server's
 * message.
 */
export function classifyFailures<Fallback extends number>(
	causes: readonly unknown[],
	fallbackExitCode: Fallback
): FailureClassification<Fallback> {
	const translated = causes.map((cause) =>
		translateRpcError(cause, { keepAuthCause: true })
	);

	for (const exitCode of rankedExitStatuses) {
		const cause = translated.find(
			(candidate) =>
				candidate !== undefined && errorExitCode(candidate) === exitCode
		);

		if (cause !== undefined) {
			return { exitCode, cause };
		}
	}

	return {
		exitCode: fallbackExitCode,
		cause: translated.find((cause) => cause !== undefined)
	};
}

/**
 * Classifies build-push publication failures with {@link classifyFailures}. The
 * fallback exit status, 74, means that publication or retention failed without
 * a more specific exit status.
 */
export function classifyPublicationFailures(
	causes: readonly unknown[]
): FailureClassification<typeof publicationExitCode> {
	return classifyFailures(causes, publicationExitCode);
}
