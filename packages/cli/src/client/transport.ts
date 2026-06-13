import { InvalidWorkerUrlError, UnreachableHostError } from '../errors.ts';

/**
 * Parse a Worker URL, turning a malformed value into a typed usage error that
 * names the offending input rather than a bare `TypeError [ERR_INVALID_URL]`.
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
 * surfaces as a typed {@link UnreachableHostError} naming the host, rather than
 * a bare `TypeError: fetch failed`. An abort is a `DOMException`, not a
 * `TypeError`, so it propagates unchanged.
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
		return new URL(value).host;
	} catch {
		return value;
	}
}
