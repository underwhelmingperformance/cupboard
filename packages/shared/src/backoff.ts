/**
Returns a number from 0 up to but not including 1. A backoff uses it to
choose a delay below its ceiling. Production code uses `Math.random`. Tests
pass a function that returns a fixed value, so the delay is predictable.
*/
export type RandomSource = () => number;

/**
How a backoff chooses each delay from its ceiling for the attempt:

- `full`: a random delay from zero up to the ceiling.
- `half`: a random delay from half the ceiling up to the ceiling.
- `none`: the ceiling itself.
*/
export type BackoffJitter = 'full' | 'half' | 'none';

export interface ExponentialBackoffPolicy {
	/**
	The ceiling for the first attempt, in milliseconds.
	*/
	readonly baseMs: number;
	/**
	The largest ceiling, in milliseconds. Without it, the ceiling keeps
	growing with each attempt.
	*/
	readonly maximumMs?: number;
	readonly jitter: BackoffJitter;
}

const maximumDoublings = 31;

/**
Computes the delay before each retry of a failed operation. The ceiling
doubles with each attempt. Jitter spreads the delays of clients that failed
at the same time, so they do not all retry together.

Create one from a policy, and call {@link ExponentialBackoff.delayMs} after
each failed attempt.
*/
export class ExponentialBackoff {
	readonly #policy: ExponentialBackoffPolicy;
	readonly #random: RandomSource;

	constructor(
		policy: ExponentialBackoffPolicy,
		random: RandomSource = Math.random
	) {
		this.#policy = policy;
		this.#random = random;
	}

	/**
	Returns the delay in milliseconds after `attempt` has failed, counting the
	first attempt as 1. The ceiling is `baseMs` after the first attempt and
	doubles after each later attempt, up to `maximumMs`. It doubles at most
	31 times, so a large attempt still gives a finite delay.
	*/
	delayMs(attempt: number): number {
		const { baseMs, maximumMs = Infinity, jitter } = this.#policy;
		const doublings = Math.min(attempt - 1, maximumDoublings);
		const ceiling = Math.min(baseMs * 2 ** doublings, maximumMs);

		switch (jitter) {
			case 'full': {
				return this.#random() * ceiling;
			}
			case 'half': {
				return ceiling * (0.5 + this.#random() / 2);
			}
			case 'none': {
				return ceiling;
			}
		}
	}
}
