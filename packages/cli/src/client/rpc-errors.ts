import { ORPCError } from '@orpc/client';

import {
	QuotaExceededError,
	ScopeForbiddenError,
	SessionRejectedError
} from '../errors.ts';

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
