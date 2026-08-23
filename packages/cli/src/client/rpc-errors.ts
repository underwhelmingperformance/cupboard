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
 * Returns true when prepare or commit reports `NOT_FOUND` because negotiated
 * state disappeared. The pending row may have expired, staged bytes may have
 * vanished, or a shared blob selected for reuse may have been collected. The
 * caller recovers by negotiating again; a missing reuse blob is then planned as
 * an upload. Handles the `ORPCError` from prepare and the
 * {@link CupboardHttpError} from WebSocket commit.
 */
export function isStaleUploadError(error: unknown): boolean {
	if (error instanceof ORPCError) {
		return error.code === 'NOT_FOUND';
	}

	return error instanceof CupboardHttpError && error.status === notFoundStatus;
}

/**
 * Converts authentication, scope and `INSUFFICIENT_STORAGE` failures into CLI
 * errors. `SERVICE_UNAVAILABLE` and every other oRPC code remain unchanged so
 * their callers can inspect them. Non-oRPC errors also pass through unchanged.
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
