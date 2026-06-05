import { OAuthError, ServerHttpError } from './errors.ts';

// Resolves a handler's response, mapping a thrown error to an HTTP response: an
// OAuth error to its RFC 6749 JSON body, any other `ServerHttpError` to its
// status and message, and anything else rethrown for the platform's 500.
export async function serverErrorResponse(
	response: Promise<Response>
): Promise<Response> {
	try {
		return await response;
	} catch (error) {
		if (error instanceof OAuthError) {
			return Response.json(
				{ error: error.error, error_description: error.message },
				{ status: error.status, headers: { 'Cache-Control': 'no-store' } }
			);
		}

		if (error instanceof ServerHttpError) {
			return new Response(`${error.message}\n`, {
				status: error.status
			});
		}

		throw error;
	}
}
