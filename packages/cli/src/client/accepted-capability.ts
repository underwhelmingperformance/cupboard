import { acceptCapabilitiesHeader } from '@cupboard/protocol/upload';
import { keepAliveFetch } from '@cupboard/shared/keep-alive-fetch';

/**
Returns a fetch that sends `capability` in `x-cupboard-accept-capabilities`
with every request, so the server can include response fields that an older
client would reject.
*/
export function acceptingCapability(
	capability: string,
	fetcher: typeof fetch = keepAliveFetch
): typeof fetch {
	return async (input, init) => {
		const request = new Request(input, init);
		const headers = new Headers(request.headers);
		headers.set(acceptCapabilitiesHeader, capability);

		return fetcher(new Request(request, { headers }));
	};
}
