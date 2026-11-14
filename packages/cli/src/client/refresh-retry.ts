import { setTimeout as delay } from 'node:timers/promises';

import { getLogger } from '@cupboard/logger';
import { refreshTokenRetryGraceMs } from '@cupboard/protocol/oidc';
import { type RandomSource } from '@cupboard/shared/backoff';
import {
	maxTransientRetries,
	transientResponseDelayMs,
	transientRetryBackoff
} from '@cupboard/shared/retry';
import { ProbeTimeoutError } from '@cupboard/shared/timeout';

import { abortable, throwIfAborted } from '../abort.ts';
import {
	SessionRenewalExpiredError,
	SessionRenewalUnconfirmedError
} from '../errors.ts';

import { observeDispatch } from './request-dispatch.ts';

const logger = getLogger(['cupboard', 'fetch']);

/**
The CLI sends a refresh token no later than this after the first attempt with
that token started. The server returns the successor to a repeat for
{@link refreshTokenRetryGraceMs} after it creates the successor, and it
creates the successor only after the first request arrives. The other half
of that period covers the time for a request to reach the server and for the
server to handle it.
*/
const refreshRetryWindowMs = refreshTokenRetryGraceMs / 2;

/**
How long the CLI waits for one refresh attempt before it abandons the
attempt. Three unanswered attempts fit in the window.
*/
const refreshAttemptDeadlineMs = 10_000;

/**
Measures and waits for the time of a refresh and its retries. Tests replace
it to drive both without a real clock.
*/
export interface RefreshRetryTiming {
	/**
	Starts measuring, and returns a function that reports the milliseconds
	elapsed since.
	*/
	readonly stopwatch: () => () => number;
	/**
	Resolves after `milliseconds`, and rejects when `signal` aborts first.
	*/
	readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

/**
Returns a stopwatch that reports the larger of the elapsed monotonic and
wall-clock times. The monotonic clock stops while the machine is suspended,
and the wall clock can step backwards, so neither reading alone is a lower
bound on the real elapsed time.
*/
export function suspendAwareStopwatch(
	monotonicNow: () => number,
	wallNow: () => number
): () => () => number {
	return () => {
		const monotonicStart = monotonicNow();
		const wallStart = wallNow();

		return () =>
			Math.max(monotonicNow() - monotonicStart, wallNow() - wallStart);
	};
}

export const systemRefreshRetryTiming: RefreshRetryTiming = {
	stopwatch: suspendAwareStopwatch(() => performance.now(), Date.now),
	wait: (milliseconds, signal) => delay(milliseconds, undefined, { signal })
};

/**
The result of one refresh attempt:

- `succeeded`: the server returned the token response.
- `failed`: the attempt can be repeated. `response` is the transient response
  that failed it, if there was one, so that its `Retry-After` can set the
  delay.
- `refused`: the server or a proxy answered with an error that a repeat would
  not fix, such as a 429, a 403, a 500 or a body that is not a token
  response.

`mayHaveBeenProcessed` is false only when the token handler cannot have
received the attempt: the token endpoint's rate limiter answered 429 before
it read the request, or the connection failed before the request was
written. The attempt reports a failed connection setup from its error code.
`retryRefresh` also marks an attempt as not processed, whatever its
outcome, when undici reported creating its request and never reported
writing it. When undici reports nothing about the request, the error code
is the only evidence.
*/
export type RefreshAttemptOutcome<T> =
	| { readonly kind: 'succeeded'; readonly value: T }
	| {
			readonly kind: 'failed';
			readonly failure: Error;
			readonly mayHaveBeenProcessed: boolean;
			readonly response?: Response;
	  }
	| {
			readonly kind: 'refused';
			readonly failure: Error;
			readonly mayHaveBeenProcessed: boolean;
	  };

/**
Where a renewal stands in the window of its refresh token:

- `new`: no earlier attempt has sent the token, and this renewal recorded
  the start of the window. `onNotProcessed` is called before the renewal
  fails when the token handler cannot have received any of its attempts, so
  the caller can remove the record.
- `continued`: an earlier renewal recorded the start of the window
  `sinceFirstAttemptMs` ago. That renewal may have been processed, so this
  one treats the token as possibly rotated from the start.
*/
export type RefreshWindow =
	| {
			readonly kind: 'new';
			readonly onNotProcessed: () => Promise<void>;
	  }
	| { readonly kind: 'continued'; readonly sinceFirstAttemptMs: number };

export interface RefreshRetryOptions {
	readonly window: RefreshWindow;
	readonly timing: RefreshRetryTiming;
	/**
	The host of the session's server, for the errors.
	*/
	readonly host: string;
	/**
	The URL of the token endpoint, for the error of an abandoned attempt.
	*/
	readonly target: string;
	readonly random?: RandomSource;
	readonly signal?: AbortSignal;
}

/**
Runs `attempt` until it succeeds, with the transient backoff and at most
{@link maxTransientRetries} retries.

The window of {@link refreshRetryWindowMs} starts with the first attempt
with the refresh token, which can belong to an earlier call or an earlier
command. No attempt starts, and no attempt is still running, once the window
has passed. Each attempt is abandoned after {@link refreshAttemptDeadlineMs}
or at the end of the window, whichever comes first. A negative
`sinceFirstAttemptMs` means that the clock has moved backwards since the
first attempt, so the window is treated as passed.

Any attempt, including one that is abandoned or interrupted by `signal`,
may have been processed only if undici may have written its request (see
`RequestDispatch`). When no attempt of a new window may have been
processed, the renewal cannot have rotated the token. The function then
calls `onNotProcessed` and throws the last failure unchanged, or the abort
reason. Otherwise it throws {@link SessionRenewalExpiredError} when the
window has passed, and {@link SessionRenewalUnconfirmedError} when it stops
with time left in the window: the retries are used up, the next delay would
end after the window, or the server refuses an attempt of a continued window
or after an earlier attempt. A refusal of the first attempt of a new window,
and any error that `attempt` throws, propagate unchanged.
*/
export async function retryRefresh<T>(
	attempt: (signal: AbortSignal) => Promise<RefreshAttemptOutcome<T>>,
	options: RefreshRetryOptions
): Promise<T> {
	const { window, host } = options;

	if (window.kind === 'continued') {
		const { sinceFirstAttemptMs } = window;

		if (
			sinceFirstAttemptMs < 0 ||
			sinceFirstAttemptMs >= refreshRetryWindowMs
		) {
			throw new SessionRenewalExpiredError(host, refreshRetryWindowMs);
		}

		return attemptUntilSettled(attempt, options, {
			sinceFirstAttemptMs,
			mayHaveBeenProcessed: true
		});
	}

	const progress: RenewalProgress = {
		sinceFirstAttemptMs: 0,
		mayHaveBeenProcessed: false
	};

	try {
		return await attemptUntilSettled(attempt, options, progress);
	} catch (error) {
		if (!progress.mayHaveBeenProcessed) {
			await window.onNotProcessed();
		}

		throw error;
	}
}

interface RenewalProgress {
	readonly sinceFirstAttemptMs: number;
	mayHaveBeenProcessed: boolean;
}

async function attemptUntilSettled<T>(
	attempt: (signal: AbortSignal) => Promise<RefreshAttemptOutcome<T>>,
	options: RefreshRetryOptions,
	progress: RenewalProgress
): Promise<T> {
	const { timing, host, signal, window } = options;
	const stopwatch = timing.stopwatch();
	const elapsedMs = (): number => progress.sinceFirstAttemptMs + stopwatch();
	const backoff = transientRetryBackoff(options.random);
	const waitSignal = signal ?? new AbortController().signal;
	let attempts = 0;

	for (;;) {
		throwIfAborted(signal);
		attempts += 1;

		const budgetMs = Math.min(
			refreshAttemptDeadlineMs,
			refreshRetryWindowMs - elapsedMs()
		);
		const outcome = await attemptWithDeadline(attempt, budgetMs, options);

		if (outcome.kind === 'succeeded') {
			return outcome.value;
		}

		progress.mayHaveBeenProcessed ||= outcome.mayHaveBeenProcessed;

		if (outcome.kind === 'thrown') {
			throw outcome.error;
		}

		const { failure } = outcome;
		const stop: RenewalStop = { progress, host, attempts, failure };

		if (outcome.kind === 'refused') {
			throw attempts === 1 && window.kind === 'new'
				? failure
				: unconfirmedStop(stop);
		}

		if (elapsedMs() >= refreshRetryWindowMs) {
			throw expiredStop(stop);
		}

		if (attempts > maxTransientRetries) {
			throw unconfirmedStop(stop);
		}

		const delayMs =
			outcome.response === undefined
				? backoff.delayMs(attempts)
				: transientResponseDelayMs(outcome.response, attempts, backoff);

		if (elapsedMs() + delayMs >= refreshRetryWindowMs) {
			throw unconfirmedStop(stop);
		}

		logger.debug('retrying a session refresh', () => ({
			retry: attempts,
			failure: failure.name,
			delayMs,
			elapsedMs: elapsedMs()
		}));

		if (delayMs > 0) {
			try {
				await timing.wait(delayMs, waitSignal);
			} catch (error) {
				throwIfAborted(signal);
				throw error;
			}
		}

		if (elapsedMs() >= refreshRetryWindowMs) {
			throw expiredStop(stop);
		}
	}
}

interface RenewalStop {
	readonly progress: RenewalProgress;
	readonly host: string;
	readonly attempts: number;
	readonly failure: Error;
}

// Without an attempt that may have been processed, the token cannot have
// rotated, so the last failure itself is the report.
function unconfirmedStop(stop: RenewalStop): Error {
	return stop.progress.mayHaveBeenProcessed
		? new SessionRenewalUnconfirmedError(
				stop.host,
				stop.attempts,
				refreshRetryWindowMs,
				stop.failure
			)
		: stop.failure;
}

function expiredStop(stop: RenewalStop): Error {
	return stop.progress.mayHaveBeenProcessed
		? new SessionRenewalExpiredError(
				stop.host,
				refreshRetryWindowMs,
				stop.failure
			)
		: stop.failure;
}

// The outcome of an attempt that threw, including an interruption by the
// caller's signal.
type AttemptResult<T> =
	| RefreshAttemptOutcome<T>
	| {
			readonly kind: 'thrown';
			readonly error: unknown;
			readonly mayHaveBeenProcessed: boolean;
	  };

// Runs one attempt and abandons it after `budgetMs`. Abandoning aborts the
// attempt's signal, which destroys the attempt's connection. Once that has
// happened, the attempt's failure is the `ProbeTimeoutError`, whichever of
// the deadline and the aborted request settles first.
async function attemptWithDeadline<T>(
	attempt: (signal: AbortSignal) => Promise<RefreshAttemptOutcome<T>>,
	budgetMs: number,
	options: RefreshRetryOptions
): Promise<AttemptResult<T>> {
	const { timing, target, signal } = options;
	const deadline = new AbortController();
	const timer = new AbortController();
	const attemptSignal =
		signal === undefined
			? deadline.signal
			: AbortSignal.any([signal, deadline.signal]);
	const { dispatch, result } = observeDispatch(() => attempt(attemptSignal));
	const abandoned = (failure: ProbeTimeoutError): AttemptResult<T> => ({
		kind: 'failed',
		failure,
		mayHaveBeenProcessed: dispatch.mayHaveBeenSent
	});
	const expire = async (): Promise<AttemptResult<T>> => {
		await timing.wait(budgetMs, timer.signal);
		const failure = new ProbeTimeoutError(target);
		deadline.abort(failure);

		return abandoned(failure);
	};
	const expiry = (): ProbeTimeoutError | undefined => {
		const reason: unknown = deadline.signal.reason;

		return reason instanceof ProbeTimeoutError ? reason : undefined;
	};

	try {
		const outcome = await abortable(Promise.race([result, expire()]), signal);

		if (outcome.kind === 'succeeded') {
			return outcome;
		}

		const failure = expiry();

		if (failure !== undefined) {
			return abandoned(failure);
		}

		return {
			...outcome,
			mayHaveBeenProcessed:
				outcome.mayHaveBeenProcessed && dispatch.mayHaveBeenSent
		};
	} catch (error) {
		const failure = expiry();

		if (failure === undefined || signal?.aborted === true) {
			return {
				kind: 'thrown',
				error,
				mayHaveBeenProcessed: dispatch.mayHaveBeenSent
			};
		}

		return abandoned(failure);
	} finally {
		timer.abort();
	}
}
