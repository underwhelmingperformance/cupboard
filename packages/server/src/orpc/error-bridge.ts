import { type Logger } from '@cupboard/logger';
import { ORPCError } from '@orpc/server';
import { StatusCodes } from 'http-status-codes';

import {
	CacheAlreadyExistsError,
	CacheNotEmptyError,
	CacheNotFoundError,
	ServerHttpError,
	SigningKeyBackfillIncompleteError,
	SigningKeyRotationAbortNotAllowedError,
	SigningKeyRotationInProgressError
} from '../errors.ts';
import { serverHttpErrorHeaders } from '../http/error-response.ts';

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
 * Converts cache conflicts to the contract's typed cache errors.
 * Other `ServerHttpError` statuses in `codeByStatus` use the corresponding
 * generic oRPC code. An unlisted status uses `INTERNAL_SERVER_ERROR`, while the
 * original HTTP status and message remain unchanged.
 *
 * Existing `ORPCError` values pass through. Unexpected errors are logged with
 * the request logger and returned unchanged so oRPC can mask them with its own
 * 500 response.
 */
export function bridgedError(
	logger: Logger,
	error: unknown,
	responseHeaders?: Headers
): unknown {
	if (responseHeaders !== undefined && error instanceof ServerHttpError) {
		for (const [name, value] of serverHttpErrorHeaders(error)) {
			responseHeaders.set(name, value);
		}
	}

	if (error instanceof CacheNotEmptyError) {
		return new ORPCError('CACHE_NOT_EMPTY', {
			status: error.status,
			message: error.message,
			data: { cache: error.cache }
		});
	}

	if (error instanceof CacheAlreadyExistsError) {
		return new ORPCError('CACHE_ALREADY_EXISTS', {
			status: error.status,
			message: error.message,
			data: { cache: error.cache }
		});
	}

	if (error instanceof CacheNotFoundError) {
		return new ORPCError('CACHE_NOT_FOUND', {
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
