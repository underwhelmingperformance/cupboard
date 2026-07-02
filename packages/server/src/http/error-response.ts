import type { Context, ErrorHandler } from 'hono';
import { StatusCodes } from 'http-status-codes';

import { OAuthError, ServerHttpError } from '../errors.ts';

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
		const headers =
			error.retryAfterSeconds === undefined
				? undefined
				: { 'retry-after': String(error.retryAfterSeconds) };

		return new Response(`${error.message}\n`, {
			status: error.status,
			headers
		});
	}

	return undefined;
}

// Hono error handler carrying the same mapping; an error we do not model is a
// server fault answered by {@link unmappedErrorResponse}.
export const serverErrorHandler: ErrorHandler = (error, context) => {
	const mapped = errorResponse(error);

	return mapped ?? unmappedErrorResponse(error, context);
};

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
