import { ORPCError } from '@orpc/client';

import {
	QuotaExceededError,
	ScopeForbiddenError,
	SessionRejectedError
} from '../errors.ts';

/**
 * Whether a prepare or commit failed because its negotiated upload slot is no
 * longer there: the pending row expired and was reaped, so the server answers
 * `NOT_FOUND`. The caller re-negotiates the path rather than failing the push,
 * since a slow transfer that outran the slot's lifetime is still making
 * progress.
 */
export function isStaleUploadError(error: unknown): boolean {
	return error instanceof ORPCError && error.code === 'NOT_FOUND';
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
