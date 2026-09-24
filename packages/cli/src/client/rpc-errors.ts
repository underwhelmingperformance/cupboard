import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import { ORPCError } from '@orpc/client';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';

import {
	CupboardHttpError,
	QuotaExceededError,
	ScopeForbiddenError,
	SessionRejectedError,
	TenantRemovalInProgressError
} from '../errors.ts';

// The data the control contract declares for `TENANT_OFFBOARDING`.
const tenantOffboardingDataSchema = z.object({ id: tenantIdSchema });

const notFoundStatus: number = StatusCodes.NOT_FOUND;

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

/**
 * Converts authentication, scope, `INSUFFICIENT_STORAGE` and
 * `TENANT_OFFBOARDING` failures into CLI errors. `SERVICE_UNAVAILABLE` and every other oRPC code remain unchanged so
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

		case 'TENANT_OFFBOARDING': {
			const data = tenantOffboardingDataSchema.safeParse(error.data);

			return data.success
				? new TenantRemovalInProgressError(data.data.id)
				: error;
		}

		default: {
			return error;
		}
	}
}
