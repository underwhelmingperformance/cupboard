import { z } from 'zod';

const oauthErrorResponseSchema = z.object({
	error: z.string().min(1),
	error_description: z.string().optional(),
	problem: z.string().min(1).optional()
});

export type OAuthErrorResponse = z.infer<typeof oauthErrorResponseSchema>;

/**
Parses an OAuth error response without accepting an arbitrary JSON object.
*/
export function parseOAuthErrorResponse(
	payload: unknown
): OAuthErrorResponse | undefined {
	const parsed = oauthErrorResponseSchema.safeParse(payload);

	return parsed.success ? parsed.data : undefined;
}

/**
Parses an OAuth error from a response body that has already been bounded.
*/
export function parseOAuthErrorBody(
	body: string
): OAuthErrorResponse | undefined {
	try {
		return parseOAuthErrorResponse(JSON.parse(body));
	} catch {
		return undefined;
	}
}

interface OAuthErrorCarrier {
	readonly oauthError: OAuthErrorResponse | undefined;
}

function hasParsedOAuthError(error: unknown): error is OAuthErrorCarrier {
	return (
		typeof error === 'object' &&
		error !== null &&
		'oauthError' in error &&
		parseOAuthErrorResponse(error.oauthError) !== undefined
	);
}

/**
Whether an OAuth client failure contains the specified protocol error code.
*/
export function hasOAuthErrorCode(error: unknown, code: string): boolean {
	return hasParsedOAuthError(error) && error.oauthError?.error === code;
}

/**
Returns the Cupboard problem subtype from an OAuth client failure.
*/
export function oauthErrorProblem(error: unknown): string | undefined {
	return hasParsedOAuthError(error) ? error.oauthError?.problem : undefined;
}
