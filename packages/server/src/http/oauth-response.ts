const oauthResponseHeaders = {
	'cache-control': 'no-store',
	pragma: 'no-cache'
} as const;

/**
Renders a token endpoint response with the RFC 6749 cache directives.
*/
export function oauthJsonResponse(
	body: unknown,
	init?: Omit<ResponseInit, 'headers'>
): Response {
	return Response.json(body, { ...init, headers: oauthResponseHeaders });
}
