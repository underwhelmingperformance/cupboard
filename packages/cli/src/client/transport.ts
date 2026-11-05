import { setImmediate } from 'node:timers/promises';

import { withReadAuthentication } from '@cupboard/nix';
import { InvalidCacheUrlBaseError } from '@cupboard/nix-store/errors';
import { isHttpsOrLoopbackHttp, parseBaseUrl } from '@cupboard/nix-store/url';
import {
	reachableFetcher as sharedReachableFetcher,
	type ReplaySafety,
	retryingFetcher
} from '@cupboard/shared/retry';

import {
	InsecureWorkerUrlError,
	InvalidWorkerUrlBaseError,
	InvalidWorkerUrlError,
	UnreachableHostError
} from '../errors.ts';

/**
Calls the global `fetch` after the event loop has run its pending
`setImmediate` callbacks. When a response ends, undici returns its keep-alive
connection to the pool in a `setImmediate` callback. A request sent before that
callback finds the connection busy and opens another one, so without this wait
a request that directly follows another to the same origin opens a second
connection.
*/
export const keepAliveFetch: typeof fetch = async (input, init) => {
	await setImmediate();

	return fetch(input, init);
};

/**
Retries rejected fetches and transient status responses with backoff. After
the retry budget is exhausted, a rejected `TypeError` becomes an
{@link UnreachableHostError} for the requested host. Other errors pass through
unchanged.
*/
export function resilientFetcher(
	replaySafety: ReplaySafety,
	fetcher: typeof fetch = keepAliveFetch,
	trustedOrigin?: string
): typeof fetch {
	return reachableFetcher(
		retryingFetcher(fetcher, replaySafety, { trustedOrigin })
	);
}

interface CacheReadOptions {
	readonly netrcFile?: string;
	readonly trustedOrigin?: string;
}

export function cacheReadFetcher(
	tenantUrl: URL,
	fetcher?: typeof fetch,
	options: CacheReadOptions = {}
): typeof fetch {
	const authenticated = withReadAuthentication(fetcher ?? keepAliveFetch, {
		tenantUrl,
		netrcFile: options.netrcFile
	});

	return fetcher === undefined
		? resilientFetcher('replay-safe', authenticated, options.trustedOrigin)
		: authenticated;
}

/**
Parses and canonicalises a Worker URL. It accepts only HTTPS, or HTTP to a
loopback host, without credentials, a query or a fragment, and removes
trailing path slashes except for the root slash. A malformed URL throws
{@link InvalidWorkerUrlError}; an invalid base throws
{@link InvalidWorkerUrlBaseError}; plain HTTP to another host throws
{@link InsecureWorkerUrlError}. The returned URL is a copy, so a URL
supplied by the caller remains unchanged.
*/
export function parseWorkerUrl(value: string | URL): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new InvalidWorkerUrlError(String(value));
	}

	let base: URL;
	try {
		base = parseBaseUrl(url);
	} catch (error: unknown) {
		if (error instanceof InvalidCacheUrlBaseError) {
			throw new InvalidWorkerUrlBaseError();
		}

		throw error;
	}

	if (!isHttpsOrLoopbackHttp(base)) {
		throw new InsecureWorkerUrlError(url.href);
	}

	return base;
}

/**
Converts a network failure identified by the shared fetch classifier into an
{@link UnreachableHostError} for the requested host. Every other rejection
passes through unchanged.
*/
export function reachableFetcher(fetcher: typeof fetch): typeof fetch {
	return sharedReachableFetcher(
		fetcher,
		(host, cause) => new UnreachableHostError(host, cause)
	);
}
