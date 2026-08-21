/**
Creates the request used as the Workers Cache key for a public tenant read.
Client query parameters and fragments do not select different cache content.
*/
export function canonicalCacheRequest(request: Request): Request {
	const canonical = new URL(request.url);
	canonical.search = '';
	canonical.hash = '';

	return new Request(canonical, request);
}
