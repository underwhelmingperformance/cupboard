import { ORPCError } from '@orpc/server';
import { StatusCodes } from 'http-status-codes';

import { CacheNotEmptyError, ServerHttpError } from '../errors.ts';

// The oRPC error codes for the statuses our ServerHttpError hierarchy uses.
const codeByStatus: Record<number, string> = {
	[StatusCodes.BAD_REQUEST]: 'BAD_REQUEST',
	[StatusCodes.UNAUTHORIZED]: 'UNAUTHORIZED',
	[StatusCodes.FORBIDDEN]: 'FORBIDDEN',
	[StatusCodes.NOT_FOUND]: 'NOT_FOUND',
	[StatusCodes.CONFLICT]: 'CONFLICT',
	[StatusCodes.GONE]: 'GONE',
	[StatusCodes.REQUEST_TOO_LONG]: 'PAYLOAD_TOO_LARGE',
	[StatusCodes.UNPROCESSABLE_ENTITY]: 'UNPROCESSABLE_CONTENT',
	[StatusCodes.INSUFFICIENT_STORAGE]: 'INSUFFICIENT_STORAGE',
	[StatusCodes.SERVICE_UNAVAILABLE]: 'SERVICE_UNAVAILABLE'
};

/**
 * Maps a thrown ServerHttpError to the ORPCError the contract speaks.
 * Classes the CLI acts on become defined contract errors carrying data (the
 * server re-validates them against the procedure's error map, so they arrive
 * typed); any other ServerHttpError keeps its status and message under the
 * matching generic code. Anything else is returned unchanged for the
 * handler's own 500 path.
 */
export function bridgedError(error: unknown): unknown {
	if (error instanceof CacheNotEmptyError) {
		return new ORPCError('CACHE_NOT_EMPTY', {
			status: error.status,
			message: error.message,
			data: { cache: error.cache }
		});
	}

	if (error instanceof ServerHttpError) {
		return new ORPCError(
			codeByStatus[error.status] ?? 'INTERNAL_SERVER_ERROR',
			{ status: error.status, message: error.message }
		);
	}

	return error;
}
