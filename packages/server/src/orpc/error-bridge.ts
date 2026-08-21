import { type Logger } from '@cupboard/logger';
import { ORPCError } from '@orpc/server';
import { StatusCodes } from 'http-status-codes';

import {
	CacheNotEmptyError,
	ServerHttpError,
	SigningKeyBackfillIncompleteError,
	SigningKeyRotationAbortNotAllowedError,
	SigningKeyRotationInProgressError
} from '../errors.ts';

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
 * matching generic code. An ORPCError (a defined contract error or an auth
 * rejection) passes through untouched. Anything else is an unexpected fault
 * oRPC will mask as a context-free 500, so it is logged (through the request
 * logger, which already carries the ray) the way the wire routes' unmapped-error
 * handler does, before being returned unchanged for the handler's own 500 path.
 */
export function bridgedError(logger: Logger, error: unknown): unknown {
	if (error instanceof CacheNotEmptyError) {
		return new ORPCError('CACHE_NOT_EMPTY', {
			status: error.status,
			message: error.message,
			data: { cache: error.cache }
		});
	}

	if (error instanceof SigningKeyRotationInProgressError) {
		return new ORPCError('SIGNING_KEY_ROTATION_IN_PROGRESS', {
			status: error.status,
			message: error.message,
			data: { id: error.id }
		});
	}

	if (error instanceof SigningKeyBackfillIncompleteError) {
		return new ORPCError('SIGNING_KEY_BACKFILL_INCOMPLETE', {
			status: error.status,
			message: error.message,
			data: { id: error.id }
		});
	}

	if (error instanceof SigningKeyRotationAbortNotAllowedError) {
		return new ORPCError('SIGNING_KEY_ROTATION_ABORT_NOT_ALLOWED', {
			status: error.status,
			message: error.message,
			data: { id: error.id }
		});
	}

	if (error instanceof ServerHttpError) {
		return new ORPCError(
			codeByStatus[error.status] ?? 'INTERNAL_SERVER_ERROR',
			{ status: error.status, message: error.message }
		);
	}

	if (error instanceof ORPCError) {
		return error;
	}

	logger.error('unhandled server error', { error });

	return error;
}
