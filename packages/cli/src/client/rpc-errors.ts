import { ORPCError } from '@orpc/client';
import { StatusCodes } from 'http-status-codes';

import {
	CupboardHttpError,
	QuotaExceededError,
	ScopeForbiddenError,
	SessionRejectedError
} from '../errors.ts';

const notFoundStatus: number = StatusCodes.NOT_FOUND;

/**
 * Whether a prepare or commit failed because what it negotiated is no longer
 * there, so the server answers `NOT_FOUND`: the pending row expired and was
 * reaped, the staged bytes vanished before the commit ran, or the shared blob
 * a reuse commit was negotiated against was collected. The caller
 * re-negotiates the path rather than failing the push, since every one of
 * those recovers by planning afresh (a lost reuse re-plans as an upload).
 * Prepare speaks oRPC and commit speaks the WebSocket, so the same condition
 * arrives as either an `ORPCError` or a {@link CupboardHttpError}.
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
