import { ORPCError } from '@orpc/client';
import { StatusCodes } from 'http-status-codes';

import {
	CupboardHttpError,
	CupboardUploadError,
	QuotaExceededError,
	ScopeForbiddenError,
	SessionRejectedError
} from '../errors.ts';

import { expiredRequestCode } from './r2-error.ts';

const notFoundStatus: number = StatusCodes.NOT_FOUND;
const forbiddenStatus: number = StatusCodes.FORBIDDEN;

/**
 * Whether a blob PUT failed because its presigned URL had expired by the time
 * it was used: R2 answers `403` with an `ExpiredRequest` code. The caller
 * re-presigns the upload and retries rather than failing the path, since the
 * NAR is built and only the short-lived URL went stale.
 */
export function isExpiredUploadUrlError(
	error: unknown
): error is CupboardUploadError {
	return (
		error instanceof CupboardUploadError &&
		error.status === forbiddenStatus &&
		error.r2Error?.code === expiredRequestCode
	);
}

/**
 * Whether a prepare or commit failed because its negotiated upload slot is no
 * longer there: the pending row expired and was reaped, so the server answers
 * `NOT_FOUND`. The caller re-negotiates the path rather than failing the push,
 * since a slow transfer that outran the slot's lifetime is still making
 * progress. Prepare speaks oRPC and commit speaks the WebSocket, so the same
 * condition arrives as either an `ORPCError` or a {@link CupboardHttpError}.
 */
export function isStaleUploadError(error: unknown): boolean {
	if (error instanceof ORPCError) {
		return error.code === 'NOT_FOUND';
	}

	return error instanceof CupboardHttpError && error.status === notFoundStatus;
}

/**
 * Turn an oRPC failure the admin API speaks into an actionable CLI error. A
 * refused or under-scoped token, or an over-quota write, becomes a message that
 * names the fix; anything else (including non-oRPC errors) is returned
 * unchanged so its own handling applies.
 */
export function translateRpcError(error: unknown): unknown {
	if (!(error instanceof ORPCError)) {
		return error;
	}

	switch (error.code) {
		case 'UNAUTHORIZED': {
			return new SessionRejectedError();
		}

		case 'FORBIDDEN': {
			return new ScopeForbiddenError();
		}

		case 'INSUFFICIENT_STORAGE': {
			return new QuotaExceededError(error.message);
		}

		default: {
			return error;
		}
	}
}
