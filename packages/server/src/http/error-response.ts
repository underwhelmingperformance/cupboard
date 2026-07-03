import type { Context, ErrorHandler } from 'hono';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';

import {
	OAuthError,
	ServerHttpError,
	TenantDispatchInterruptedError
} from '../errors.ts';

// Maps a thrown error to an HTTP response: an OAuth error to its RFC 6749 JSON
// body, any other `ServerHttpError` to its status and message. Anything else
// is not ours to map and returns undefined.
function errorResponse(error: unknown): Response | undefined {
	if (error instanceof OAuthError) {
		return Response.json(
			{
				error: error.error,
				error_description: error.message,
				...(error.problem !== undefined && { problem: error.problem })
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
	const headers =
		error.retryAfterSeconds === undefined
			? undefined
			: { 'retry-after': String(error.retryAfterSeconds) };

	return new Response(`${error.message}\n`, {
		status: error.status,
		headers
	});
}

// Hono error handler carrying the same mapping. A fault the runtime marks
// retryable is a transient refusal, not a server fault; anything else we do
// not model is answered by {@link unmappedErrorResponse}.
export const serverErrorHandler: ErrorHandler = (error, context) => {
	const mapped = errorResponse(error);

	if (mapped !== undefined) {
		return mapped;
	}

	if (isRuntimeRetryable(error)) {
		const ray = context.req.raw.headers.get('cf-ray') ?? undefined;

		console.warn('Retryable dispatch fault', { ray, error });

		return serverHttpErrorResponse(new TenantDispatchInterruptedError(error));
	}

	return unmappedErrorResponse(error, context);
};

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

	console.error('Unhandled server error', { ray, error });

	return Response.json(
		{ error: 'internal_error', ...(ray !== undefined && { ray }) },
		{
			status: StatusCodes.INTERNAL_SERVER_ERROR,
			headers: { 'cache-control': 'no-store' }
		}
	);
}
