import {
	ExponentialBackoff,
	type RandomSource
} from '@cupboard/shared/backoff';

import { WorkersCachePurgeError } from '../errors.ts';

// Workers Cache applies the Free plan's purge limits on every plan: a token
// bucket that refills at 5 requests a minute and has a capacity of 25 tokens.
// The bucket is shared by every Worker in the account. See
// https://developers.cloudflare.com/workers/cache/limitations/#purge-rate-limits
// and "Token bucket rate limiting" at
// https://developers.cloudflare.com/cache/how-to/purge-cache/.

// 1134 is the purge rate limit. 971 is Cloudflare's general API throttling
// code, which callers of the zone purge API also receive.
const rateLimitedCodes: ReadonlySet<number> = new Set([1134, 971]);

// The bucket refills 5 tokens in this time.
const rateLimitedBaseMs = 60_000;
// The bucket refills one token in this time.
const transientBaseMs = 12_000;
/**
The longest wait before a failed purge is sent again. An empty bucket is full
again after this time.
*/
export const cachePurgeBackoffCapMs = 300_000;

/**
Decides when a failed cache-tag purge may be sent again.

The wait grows exponentially with the number of consecutive failures, up to
a cap. It starts longer after a rate-limited failure than after any other
failure. The jitter spreads the retries of tenant objects that failed at the
same time.
*/
export class CachePurgeRetryPolicy {
	readonly #rateLimitedBackoff: ExponentialBackoff;
	readonly #transientBackoff: ExponentialBackoff;

	/**
	@param random Returns a number in [0, 1). The wait is between half and all
	of the exponential delay. The default is `Math.random`.
	*/
	constructor(random?: RandomSource) {
		this.#rateLimitedBackoff = new ExponentialBackoff(
			{
				baseMs: rateLimitedBaseMs,
				maximumMs: cachePurgeBackoffCapMs,
				jitter: 'half'
			},
			random
		);
		this.#transientBackoff = new ExponentialBackoff(
			{
				baseMs: transientBaseMs,
				maximumMs: cachePurgeBackoffCapMs,
				jitter: 'half'
			},
			random
		);
	}

	/**
	Returns the earliest time, in milliseconds since the epoch, for the next
	attempt after a purge failed with `error` at `failedAt`. `failedAttempts`
	counts the consecutive failures, including this one.
	*/
	nextAttemptAt(
		error: unknown,
		failedAttempts: number,
		failedAt: number
	): number {
		const backoff = isRateLimitedPurgeFailure(error)
			? this.#rateLimitedBackoff
			: this.#transientBackoff;

		return failedAt + Math.round(backoff.delayMs(failedAttempts));
	}
}

/**
Whether Cloudflare refused a purge because of the purge rate limit.
*/
export function isRateLimitedPurgeFailure(error: unknown): boolean {
	return (
		error instanceof WorkersCachePurgeError &&
		error.codes.some((code) => rateLimitedCodes.has(code))
	);
}
