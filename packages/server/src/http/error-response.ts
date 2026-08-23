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
	// A cache could retain a transient refusal after the origin has recovered.
	// Mark every retryable Hono response no-store so the next attempt reaches the
	// origin.
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

// D1 overloads and faults that Cloudflare marks as retryable become transient
// refusals. Other unmodelled errors use the redacted 500 response below.
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
