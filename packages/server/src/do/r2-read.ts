import { getLogger, withContext } from '@cupboard/logger';
import { abortableSleep, backoffDelayMs } from '@cupboard/shared/retry';

import { R2ReadUnavailableError, SubrequestTimeoutError } from '../errors.ts';
import type { withSpan } from '../observability/span.ts';

import {
	boundedSubrequest,
	currentDeadlineSignal,
	remainingDeadlineMs,
	withDeadlineBudget
} from './deadline.ts';
import { hasSubrequestsFor } from './subrequest-slice.ts';

type R2ReadResult = R2ObjectBody | R2Object | null;

const r2GetBudgetMs = 15_000;
const maximumAttempts = 3;
const logger = getLogger(['cupboard', 'storage', 'read']);

// An R2 binding call that fails with one of these codes can succeed when
// retried.
const transientFailure = /^(\w+): [^\r\n]+ \((10001|10043|10058)\)$/u;

function transientReadCode(error: unknown): number | undefined {
	if (!(error instanceof Error)) {
		return undefined;
	}

	const match = transientFailure.exec(error.message);
	return match?.[1] === 'get' ? Number(match[2]) : undefined;
}

/**
Whether an R2 binding call failed with a code for which a retry can succeed.
*/
export function isTransientR2Error(error: unknown): boolean {
	return error instanceof Error && transientFailure.test(error.message);
}

async function cancelLateBody(object: R2ReadResult): Promise<void> {
	if (object === null || !('body' in object)) {
		return;
	}
	await object.body.cancel();
	logger.debug('R2 late body cancelled', { phase: 'cleanup' });
}

/**
Bounds the wait for R2 `get()` to return, including transient retries. The
budget does not limit body streaming. A late, unused stream is cancelled
best-effort.
An observer must start its callback synchronously so subrequest accounting
precedes subsequent admission checks.
*/
export function getR2Object(
	operation: () => Promise<R2ReadResult>,
	key: string,
	observeRead?: typeof withSpan
): Promise<R2ReadResult> {
	const storageOperationId = crypto.randomUUID();
	const objectKey = key.slice(0, 1024);
	return withContext({ storageOperationId, objectKey, phase: 'get' }, () => {
		const run = async (span?: Span): Promise<R2ReadResult> => {
			const started = performance.now();
			let attempts = 0;
			logger.debug('R2 get started', {
				budgetMs: r2GetBudgetMs,
				remainingBudgetMs: remainingDeadlineMs()
			});

			const getWithRetries = async (): Promise<R2ReadResult> => {
				for (;;) {
					currentDeadlineSignal()?.throwIfAborted();
					attempts += 1;
					logger.debug('R2 get attempt started', {
						attempt: attempts
					});
					try {
						return await operation();
					} catch (error) {
						const code = transientReadCode(error);
						if (
							code === undefined ||
							currentDeadlineSignal()?.aborted === true
						) {
							throw error;
						}
						if (attempts >= maximumAttempts) {
							throw new R2ReadUnavailableError(error);
						}
						const delayMs = backoffDelayMs(attempts);
						logger.debug('R2 get retrying', {
							attempt: attempts,
							code,
							delayMs
						});
						await abortableSleep(delayMs, currentDeadlineSignal());
						if (!hasSubrequestsFor(1)) {
							throw new R2ReadUnavailableError(error);
						}
					}
				}
			};

			try {
				const result = await withDeadlineBudget(
					r2GetBudgetMs,
					() =>
						boundedSubrequest(
							getWithRetries,
							'r2.get',
							r2GetBudgetMs,
							cancelLateBody
						),
					'r2.get'
				);
				const disposition =
					result === null
						? 'missing'
						: 'body' in result
							? 'returned'
							: 'conditional';
				span?.setAttribute('cupboard.storage.outcome', disposition);
				span?.setAttribute('cupboard.storage.attempts', attempts);
				logger.debug('R2 get returned', {
					attempts,
					disposition,
					elapsedMs: performance.now() - started
				});
				return result;
			} catch (error) {
				const disposition =
					error instanceof SubrequestTimeoutError
						? 'timeout'
						: error instanceof R2ReadUnavailableError
							? 'exhausted'
							: 'failed';
				span?.setAttribute('cupboard.storage.outcome', disposition);
				span?.setAttribute('cupboard.storage.attempts', attempts);
				logger.debug('R2 get failed', {
					attempts,
					disposition,
					elapsedMs: performance.now() - started,
					error
				});
				throw error;
			}
		};
		return observeRead === undefined
			? run()
			: observeRead(
					'r2-get',
					{
						'cupboard.storage.operation_id': storageOperationId,
						'cupboard.storage.object_key': objectKey,
						'cupboard.storage.budget_ms': r2GetBudgetMs
					},
					run
				);
	});
}
