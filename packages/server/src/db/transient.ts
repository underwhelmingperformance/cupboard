import { type Logger, rootLogger } from '@cupboard/logger';
import { type TenantId } from '@cupboard/nix-store/scalars';

import { remainingDeadlineMs } from '../do/deadline.ts';
import {
	DatabaseOverloadedError,
	SharedFactsUnavailableError
} from '../errors.ts';

const readRetryDelayMs = 100;

/**
Retries an authoritative request-path D1 read once after 100 milliseconds.
If the second attempt fails, the function propagates the error so the route
can return its typed retryable response. A read is not retried when the
enclosing deadline ends before the retry delay does, because the deadline
would refuse the second attempt.
*/
export async function readWithOneRetry<T>(read: () => Promise<T>): Promise<T> {
	try {
		return await read();
	} catch (error) {
		const remainingMs = remainingDeadlineMs();

		if (remainingMs !== undefined && remainingMs <= readRetryDelayMs) {
			throw error;
		}

		await new Promise((resolve) => setTimeout(resolve, readRetryDelayMs));

		return read();
	}
}

// The first message is in Cloudflare's D1 error list. The second is an
// account-level throttle that the list does not document. The first sentence of
// it is enough to identify the throttle, so the match leaves out the rest.
const d1OverloadMessages = [
	'D1 DB is overloaded',
	'Your account is generating too much load on D1 DBs'
];

/**
Cloudflare's D1 overload errors do not expose a structured code that the
server can test, so detect them by matching the message. Drizzle can wrap the
D1 error in another error's cause. Follow at most five causes; the limit also
prevents a cyclic chain from looping forever.
*/
export function isD1Overload(error: unknown): boolean {
	let current: unknown = error;

	for (let depth = 0; depth < 5; depth += 1) {
		if (!(current instanceof Error)) {
			return false;
		}

		const { message } = current;

		if (d1OverloadMessages.some((text) => message.includes(text))) {
			return true;
		}

		current = current.cause;
	}

	return false;
}

/**
Creates the retryable refusal for a D1 overload and logs the underlying error
at `warn`. The 503 response does not contain the error, so the record is
what lets an operator tell the account throttle from a database overload.
*/
export function d1OverloadRefusal(
	logger: Logger,
	error: unknown
): DatabaseOverloadedError {
	logger.warn('request refused: database overloaded', { error });

	return new DatabaseOverloadedError(error);
}

/**
The group of reads that failed, given as `step` in the "request refused: cache
facts unavailable" record. One step can cover several call sites that read
the same facts. A probe that reads objects in parallel uses one step for the
object reads and the body reads of every path in a group.
*/
export type SharedFactsStep =
	| 'attestation-list-read'
	| 'bundle-reference-read'
	| 'canonical-narinfo-read'
	| 'nar-reference-read'
	| 'narinfo-object-read'
	| 'narinfo-reference-read'
	| 'read-scope-recheck'
	| 'reuse-view-object-probe'
	| 'reuse-view-reference-read';

const sharedFactsRefusalMessage = 'request refused: cache facts unavailable';

/**
Creates the retryable refusal for a failed shared-fact read and logs the
underlying error at `warn`. The 503 response does not contain the error, so
the record shows why the read failed. Pass the request's logger when the
caller has one.
*/
export function sharedFactsRefusal(
	logger: Logger,
	tenant: TenantId,
	step: SharedFactsStep,
	error: unknown
): SharedFactsUnavailableError {
	logger.warn(sharedFactsRefusalMessage, { tenant, step, error });

	return new SharedFactsUnavailableError(error);
}

/**
Logs the refusal once for a group of reads that run in parallel. Each read in
the group throws `new SharedFactsUnavailableError(cause)` without logging, so
a failure of several reads does not write one record for each. Call this
where the group's first failure is rethrown. It returns `failure` unchanged,
and logs only when `failure` is a `SharedFactsUnavailableError`.
*/
export function logGroupRefusal(
	logger: Logger,
	tenant: TenantId,
	step: SharedFactsStep,
	failure: unknown
): unknown {
	if (failure instanceof SharedFactsUnavailableError) {
		logger.warn(sharedFactsRefusalMessage, {
			tenant,
			step,
			error: failure.cause
		});
	}

	return failure;
}

/**
The deployment and lifecycle transition reads that fail with a
`SharedFactsUnavailableError`.
*/
export type TransitionReadStep =
	'deployment-transition-read' | 'lifecycle-transition-read';

/**
Creates the retryable error for a failed transition read and logs the
underlying error at `warn`. Background work (the local step, the deletion
queue and migrations) and admin writes make these reads as well as cache
requests, so the message does not say that a request was refused.
*/
export function transitionReadFailure(
	step: TransitionReadStep,
	error: unknown
): SharedFactsUnavailableError {
	rootLogger().warn('transition read failed', { step, error });

	return new SharedFactsUnavailableError(error);
}

/**
Recognises the SQL trigger refusal, including Drizzle's wrapped cause.
*/
export function isControlDatabaseMigrationPending(error: unknown): boolean {
	let current: unknown = error;

	for (let depth = 0; depth < 5; depth += 1) {
		if (!(current instanceof Error)) {
			return false;
		}

		if (current.message.includes('control database migration pending')) {
			return true;
		}

		current = current.cause;
	}

	return false;
}
