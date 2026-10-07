import { StatusCodes } from 'http-status-codes';

const oauthResponseHeaders = {
	'cache-control': 'no-store',
	pragma: 'no-cache'
} as const;

/**
Renders the empty RFC 7009 revocation response with the same cache directives
as a token response.
*/
export function oauthEmptyResponse(): Response {
	return new Response(undefined, {
		status: StatusCodes.OK,
		headers: oauthResponseHeaders
	});
}

/**
Renders a token endpoint response with the RFC 6749 cache directives.
*/
export function oauthJsonResponse(
	body: unknown,
	init?: Omit<ResponseInit, 'headers'>
): Response {
	return Response.json(body, { ...init, headers: oauthResponseHeaders });
}
