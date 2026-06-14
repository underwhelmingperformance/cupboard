import type { ErrorHandler } from 'hono';

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
				...(error.problem === undefined ? {} : { problem: error.problem })
			},
			{ status: error.status, headers: { 'Cache-Control': 'no-store' } }
		);
	}

	if (error instanceof ServerHttpError) {
		return new Response(`${error.message}\n`, {
			status: error.status
		});
	}

	return undefined;
}

// Hono error handler carrying the same mapping; an unrecognised error is
// rethrown for the platform's 500.
export const serverErrorHandler: ErrorHandler = (error) => {
	const mapped = errorResponse(error);

	if (mapped === undefined) {
		throw error;
	}

	return mapped;
};
