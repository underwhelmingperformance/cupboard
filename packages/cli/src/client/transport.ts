import { InvalidWorkerUrlError, UnreachableHostError } from '../errors.ts';

import { retryingFetcher } from './retry.ts';

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
	try {
		return new URL(value);
	} catch {
		throw new InvalidWorkerUrlError(String(value));
	}
}

/**
 * Wrap a fetcher so a network-level failure (DNS lookup, refused connection)
 * surfaces as a typed {@link UnreachableHostError} naming the host. An abort
 * is a `DOMException`, not a `TypeError`, so it propagates unchanged.
 */
export function reachableFetcher(fetcher: typeof fetch): typeof fetch {
	return async (input, init) => {
		try {
			return await fetcher(input, init);
		} catch (error) {
			if (error instanceof TypeError) {
				throw new UnreachableHostError(hostOf(input), error);
			}

			throw error;
		}
	};
}

function hostOf(input: Parameters<typeof fetch>[0]): string {
	if (typeof input === 'string') {
		return safeHost(input);
	}

	if (input instanceof URL) {
		return input.host;
	}

	return safeHost(input.url);
}

function safeHost(value: string): string {
	try {
		const url = new URL(value);
		return url.host;
	} catch {
		return value;
	}
}
