import { InvalidCacheUrlBaseError } from '@cupboard/nix-store/errors';
import { parseBaseUrl } from '@cupboard/nix-store/url';
import {
	reachableFetcher as sharedReachableFetcher,
	type ReplaySafety,
	retryingFetcher
} from '@cupboard/shared/retry';

import {
	InvalidWorkerUrlBaseError,
	InvalidWorkerUrlError,
	UnreachableHostError
} from '../errors.ts';

/**
 * Retries rejected fetches and transient status responses with backoff. After
 * the retry budget is exhausted, a rejected `TypeError` becomes an
 * {@link UnreachableHostError} for the requested host. Other errors pass through
 * unchanged.
 */
export function resilientFetcher(
	replaySafety: ReplaySafety,
	fetcher: typeof fetch = fetch
): typeof fetch {
	return reachableFetcher(retryingFetcher(fetcher, replaySafety));
}

/**
 * Parses and canonicalises a Worker URL. It accepts only HTTP or HTTPS without
 * credentials, a query or a fragment, and removes trailing path slashes except
 * for the root slash. A malformed URL throws {@link InvalidWorkerUrlError}; an
 * invalid base throws {@link InvalidWorkerUrlBaseError}. The returned URL is a
 * copy, so a URL supplied by the caller remains unchanged.
 */
export function parseWorkerUrl(value: string | URL): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new InvalidWorkerUrlError(String(value));
	}

	try {
		return parseBaseUrl(url);
	} catch (error: unknown) {
		if (error instanceof InvalidCacheUrlBaseError) {
			throw new InvalidWorkerUrlBaseError();
		}

		throw error;
	}
}

/**
 * Converts a network failure identified by the shared fetch classifier into an
 * {@link UnreachableHostError} for the requested host. Every other rejection
 * passes through unchanged.
 */
export function reachableFetcher(fetcher: typeof fetch): typeof fetch {
	return sharedReachableFetcher(
		fetcher,
		(host, cause) => new UnreachableHostError(host, cause)
	);
}
