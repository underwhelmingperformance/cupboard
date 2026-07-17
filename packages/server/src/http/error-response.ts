import { type Logger } from '@cupboard/logger';
import type { Context, ErrorHandler } from 'hono';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';

import { isD1Overload } from '../db/transient.ts';
import {
	DatabaseOverloadedError,
	OAuthError,
	ServerHttpError,
	TenantDispatchInterruptedError
} from '../errors.ts';
import { rootLogger } from '../observability/logging.ts';

// Maps a thrown error to an HTTP response: an OAuth error to its RFC 6749 JSON
// body, any other `ServerHttpError` to its status and message. Anything else
// is not ours to map and returns undefined.
function errorResponse(error: unknown): Response | undefined {
	if (error instanceof OAuthError) {
		return Response.json(
			{
				error: error.error,
				error_description: error.message,
				...(error.problem !== undefined && { problem: error.problem }),
				...(error.detail !== undefined && { detail: error.detail })
			},
			{ status: error.status, headers: { 'Cache-Control': 'no-store' } }
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
	const headers =
		error.retryAfterSeconds === undefined
			? undefined
			: {
					'retry-after': String(error.retryAfterSeconds),
					'cache-control': 'no-store'
				};

	return new Response(`${error.message}\n`, {
		status: error.status,
		headers
	});
}

// Hono error handler carrying the same mapping. A D1 overload or a fault the
// runtime marks retryable is a transient refusal, not a server fault; anything
// else we do not model is answered by {@link unmappedErrorResponse}.
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

// The request logger seeded by the app's first middleware, or a fallback carrying
// just the ray when the fault was raised before that middleware ran (a malformed
// path, say). Either way the line lands in Workers observability keyed to the ray.
function loggerFor(context: Context): Logger {
	const seeded = (context.var as { logger?: Logger }).logger;

	if (seeded !== undefined) {
		return seeded;
	}

	const ray = context.req.raw.headers.get('cf-ray') ?? undefined;

	return ray === undefined ? rootLogger() : rootLogger().with({ ray });
}

// The flags the Workers runtime sets on a fault it knows to be transient: a
// Durable Object reset or overload that killed the request mid-flight.
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

// An unmodelled error would otherwise escape into Cloudflare's generic exception
// page, which carries no usable detail. Log the full error instead (it lands in
// Workers observability, keyed to this invocation) and answer with a small JSON
// body carrying the request's ray, the handle that finds the logged line.
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
