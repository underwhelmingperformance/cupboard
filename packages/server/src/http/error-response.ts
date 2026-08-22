import { type Logger } from '@cupboard/logger';
import type { Context, ErrorHandler } from 'hono';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';

import { isD1Overload } from '../db/transient.ts';
import {
	DatabaseOverloadedError,
	OAuthError,
	ServerHttpError,
	TenantDispatchInterruptedError,
	UnauthenticatedError
} from '../errors.ts';
import { rootLogger } from '../observability/logging.ts';

import { oauthJsonResponse } from './oauth-response.ts';

// Maps a thrown error to an HTTP response: an OAuth error to its RFC 6749 JSON
// body, any other `ServerHttpError` to its status and message. Anything else
// is not ours to map and returns undefined.
function errorResponse(error: unknown): Response | undefined {
	if (error instanceof OAuthError) {
		return oauthJsonResponse(
			{
				error: error.error,
				error_description: error.message,
				...(error.problem !== undefined && { problem: error.problem }),
				...(error.detail !== undefined && { detail: error.detail })
			},
			{ status: error.status }
		);
	}

	if (error instanceof ServerHttpError) {
		return serverHttpErrorResponse(error);
	}

	return undefined;
}

function serverHttpErrorResponse(error: ServerHttpError): Response {
	// A retryable refusal must never be cached, on any route: a reader that
	// stored this response would keep retrying against a cache instead of the
	// origin, well past whatever made it transient.
	const headers = serverHttpErrorHeaders(error);

	return new Response(`${error.message}\n`, {
		status: error.status,
		headers
	});
}

/**
HTTP metadata shared by ordinary and oRPC error renderers.
*/
export function serverHttpErrorHeaders(error: ServerHttpError): Headers {
	const headers = new Headers();

	if (error.retryAfterSeconds !== undefined) {
		headers.set('retry-after', String(error.retryAfterSeconds));
		headers.set('cache-control', 'no-store');
	}

	if (error instanceof UnauthenticatedError) {
		headers.set('www-authenticate', 'Bearer');
	}

	return headers;
}

// The Hono error handler applies the same mapping. A D1 overload or a fault the
// runtime marks retryable is a transient refusal, not a server fault; anything
// else we do not model uses {@link unmappedErrorResponse}.
export const serverErrorHandler: ErrorHandler = (error, context) => {
	const mapped = errorResponse(error);

	if (mapped !== undefined) {
		return mapped;
	}

	if (isD1Overload(error)) {
		return serverHttpErrorResponse(new DatabaseOverloadedError(error));
	}

	if (isRuntimeRetryable(error)) {
		loggerFor(context).warn('retryable dispatch fault', { error });

		return serverHttpErrorResponse(new TenantDispatchInterruptedError(error));
	}

	return unmappedErrorResponse(error, context);
};

// An error can reach this handler before the first middleware creates the
// request logger. In that case, create a logger with the ray so Workers
// observability still associates the error with the request.
function loggerFor(context: Context): Logger {
	const seeded = (context.var as { logger?: Logger }).logger;

	if (seeded !== undefined) {
		return seeded;
	}

	const ray = context.req.raw.headers.get('cf-ray') ?? undefined;

	return ray === undefined ? rootLogger() : rootLogger().with({ ray });
}

// Cloudflare can mark a runtime fault as retryable through any of these fields.
const runtimeFaultFlags = z.object({
	retryable: z.boolean().optional(),
	durableObjectReset: z.boolean().optional(),
	overloaded: z.boolean().optional()
});

function isRuntimeRetryable(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}

	const flags = runtimeFaultFlags.safeParse(error);

	if (!flags.success) {
		return false;
	}

	return (
		flags.data.retryable === true ||
		flags.data.durableObjectReset === true ||
		flags.data.overloaded === true
	);
}

// Log the full error, but return only the request ray. The ray lets an operator
// find the corresponding Workers log without exposing the error to the client.
function unmappedErrorResponse(error: unknown, context: Context): Response {
	const ray = context.req.raw.headers.get('cf-ray') ?? undefined;

	loggerFor(context).error('unhandled server error', { error });

	return Response.json(
		{ error: 'internal_error', ...(ray !== undefined && { ray }) },
		{
			status: StatusCodes.INTERNAL_SERVER_ERROR,
			headers: { 'cache-control': 'no-store' }
		}
	);
}
