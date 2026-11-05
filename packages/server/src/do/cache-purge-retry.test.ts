import { describe, expect, it } from 'vitest';

import { SubrequestTimeoutError, WorkersCachePurgeError } from '../errors.ts';

import { CachePurgeRetryPolicy } from './cache-purge-retry.ts';

const rateLimited = new WorkersCachePurgeError([
	{ code: 1134, message: 'Unable to purge, rate limit reached.' }
]);
const refused = new WorkersCachePurgeError([
	{ code: 1092, message: 'Request cannot contain purge_everything.' }
]);
const timedOut = new SubrequestTimeoutError('cache.purge');

describe('cache purge retry policy', () => {
	it.each([
		{ error: rateLimited, failedAttempts: 1, jitter: 0, delayMs: 30_000 },
		{ error: rateLimited, failedAttempts: 1, jitter: 0.5, delayMs: 45_000 },
		{ error: rateLimited, failedAttempts: 1, jitter: 0.999, delayMs: 59_970 },
		{ error: rateLimited, failedAttempts: 2, jitter: 0.5, delayMs: 90_000 },
		{ error: rateLimited, failedAttempts: 3, jitter: 0.5, delayMs: 180_000 },
		{ error: rateLimited, failedAttempts: 4, jitter: 0.5, delayMs: 225_000 },
		{ error: rateLimited, failedAttempts: 40, jitter: 0.5, delayMs: 225_000 },
		{ error: timedOut, failedAttempts: 1, jitter: 0.5, delayMs: 9000 },
		{ error: refused, failedAttempts: 1, jitter: 0.5, delayMs: 9000 },
		{ error: timedOut, failedAttempts: 5, jitter: 0.5, delayMs: 144_000 },
		{ error: timedOut, failedAttempts: 6, jitter: 0.5, delayMs: 225_000 },
		{ error: timedOut, failedAttempts: 6, jitter: 0, delayMs: 150_000 },
		{ error: timedOut, failedAttempts: 6, jitter: 0.999, delayMs: 299_850 }
	])(
		'waits $delayMs ms after failure $failedAttempts with jitter $jitter',
		({ error, failedAttempts, jitter, delayMs }) => {
			const policy = new CachePurgeRetryPolicy(() => jitter);

			expect(policy.nextAttemptAt(error, failedAttempts, 1000)).toBe(
				1000 + delayMs
			);
		}
	);
});
