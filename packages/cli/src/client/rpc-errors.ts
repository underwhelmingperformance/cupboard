import { ORPCError } from '@orpc/client';
import { StatusCodes } from 'http-status-codes';

import {
	AdminApiTransientError,
	type AdminApiTransientStatus,
	CupboardHttpError,
	QuotaExceededError,
	ScopeForbiddenError,
	SessionRejectedError
} from '../errors.ts';

const notFoundStatus: number = StatusCodes.NOT_FOUND;
const insufficientStorageStatus: number = StatusCodes.INSUFFICIENT_STORAGE;

// oRPC takes an error's status from the error envelope, and the server's
// envelopes use the response's HTTP status. The admin client throws a
// CupboardHttpError for every other 5xx response than 503 and 507, so an
// ORPCError with another 5xx status comes only from an envelope that the
// server did not write, and it passes through unchanged.
const transientRpcStatuses: readonly AdminApiTransientStatus[] = [
	StatusCodes.REQUEST_TIMEOUT,
	StatusCodes.TOO_MANY_REQUESTS,
	StatusCodes.SERVICE_UNAVAILABLE
];

/**
 * Whether an oRPC procedure reports that its route or requested resource is
 * absent.
 */
export function isRpcNotFoundError(
	error: unknown
): error is ORPCError<'NOT_FOUND', unknown> {
	return (
		error instanceof ORPCError &&
		error.code === 'NOT_FOUND' &&
		error.status === notFoundStatus
	);
}

export function isRpcCacheAlreadyExistsError(error: unknown): boolean {
	return error instanceof ORPCError && error.code === 'CACHE_ALREADY_EXISTS';
}

/**
 * Whether a prepare or commit failed because what it negotiated is no longer
 * there, so the server returns `NOT_FOUND`: the pending row expired and was
 * reaped, the staged bytes vanished before the commit ran, or the shared blob
 * a reuse commit was negotiated against was collected. The caller
 * re-negotiates the path, since every one of those recovers by planning afresh
 * (a lost reuse re-plans as an upload).
 * Prepare speaks oRPC and commit speaks the WebSocket, so the same condition
 * arrives as either an `ORPCError` or a {@link CupboardHttpError}.
 */
export function isStaleUploadError(error: unknown): boolean {
	if (error instanceof ORPCError) {
		return isRpcNotFoundError(error);
	}

	return error instanceof CupboardHttpError && error.status === notFoundStatus;
}

export interface TranslateRpcErrorOptions {
	/**
	 * Whether a session or scope error keeps the oRPC error as its cause. The
	 * error report prints the cause chain, so a caller that reports the
	 * converted error as a cause sets this to include the server's message. The
	 * top-level report leaves it unset because the messages of these two errors
	 * already say what to do. The other conversions need no option: a
	 * transient error and a quota error without an envelope always keep the
	 * oRPC error as their cause, and a quota error from `INSUFFICIENT_STORAGE`
	 * includes the server's message.
	 */
	readonly keepAuthCause?: boolean;
}

/**
 * Converts authentication and scope failures, and any oRPC error with status
 * 408, 429, 503 or 507, into CLI errors. Every other oRPC error and every
 * non-oRPC error passes through unchanged. A caller that needs the oRPC code or
 * data of a 408, 429, 503 or 507 must inspect the error before calling this
 * function.
 */
export function translateRpcError(
	error: unknown,
	options: TranslateRpcErrorOptions = {}
): unknown {
	if (!(error instanceof ORPCError)) {
		return error;
	}

	const causeOptions = options.keepAuthCause === true ? { cause: error } : {};

	switch (error.code) {
		case 'UNAUTHORIZED': {
			return new SessionRejectedError(causeOptions);
		}

		case 'FORBIDDEN': {
			return new ScopeForbiddenError(causeOptions);
		}

		case 'INSUFFICIENT_STORAGE': {
			return new QuotaExceededError(error.message);
		}

		default: {
			// For a 507 whose body is not an oRPC error envelope, oRPC uses the code
			// `MALFORMED_ORPC_ERROR_RESPONSE`.
			if (error.status === insufficientStorageStatus) {
				return new QuotaExceededError('', { cause: error });
			}

			const transientStatus = transientRpcStatuses.find(
				(status) => status === error.status
			);

			return transientStatus === undefined
				? error
				: new AdminApiTransientError(transientStatus, String(error.code), {
						cause: error
					});
		}
	}
}
