import { withReadAuthentication } from '@cupboard/nix';
import { InvalidCacheUrlBaseError } from '@cupboard/nix-store/errors';
import { isHttpsOrLoopbackHttp, parseBaseUrl } from '@cupboard/nix-store/url';
import { type RandomSource } from '@cupboard/shared/backoff';
import { keepAliveFetch } from '@cupboard/shared/keep-alive-fetch';
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
Retries rejected fetches and transient status responses with backoff. After
the retry budget is exhausted, a rejected `TypeError` becomes an
{@link UnreachableHostError} for the requested host. Other errors pass through
unchanged. `random` is the random source for the backoff, and defaults to
`Math.random`.
*/
export function resilientFetcher(
	replaySafety: ReplaySafety,
	fetcher: typeof fetch = keepAliveFetch,
	trustedOrigin?: string,
	random?: RandomSource
): typeof fetch {
	return reachableFetcher(
		retryingFetcher(fetcher, replaySafety, { trustedOrigin, random })
	);
}

interface CacheReadOptions {
	readonly netrcFile?: string;
	readonly trustedOrigin?: string;
	readonly random?: RandomSource;
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
		? resilientFetcher(
				'replay-safe',
				authenticated,
				options.trustedOrigin,
				options.random
			)
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
