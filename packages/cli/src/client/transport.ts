import { InvalidCacheUrlBaseError } from '@cupboard/nix-store/errors';
import { parseBaseUrl } from '@cupboard/nix-store/url';
import {
	reachableFetcher as sharedReachableFetcher,
	retryingFetcher
} from '@cupboard/shared/retry';

import {
	InvalidWorkerUrlBaseError,
	InvalidWorkerUrlError,
	UnreachableHostError
} from '../errors.ts';

/**
 * A fetcher carrying the client's shared resilience: a transient failure retries
 * with back-off, and a network fault that outlives the retries surfaces as a
 * typed {@link UnreachableHostError} naming the host. This is the fetcher every
 * remote call should use unless it has its own retry loop.
 */
export function resilientFetcher(fetcher: typeof fetch = fetch): typeof fetch {
	return reachableFetcher(retryingFetcher(fetcher));
}

/**
 * Parse a Worker URL, turning a malformed value into a typed usage error that
 * naming the offending input.
 */
export function parseWorkerUrl(value: string | URL): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new InvalidWorkerUrlError(String(value));
	}

	// A Worker URL is the base every route and every cache URL resolves under,
	// so it is held to the same shape, reported here in the CLI's own usage
	// vocabulary.
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
 * Wrap a fetcher so a network-level failure (DNS lookup, refused connection)
 * surfaces as a typed {@link UnreachableHostError} naming the host. An abort
 * is a `DOMException`, not a `TypeError`, so it propagates unchanged.
 */
export function reachableFetcher(fetcher: typeof fetch): typeof fetch {
	return sharedReachableFetcher(
		fetcher,
		(host, cause) => new UnreachableHostError(host, cause)
	);
}
