import { getLogger } from '@cupboard/logger';
import { type Env as HonoEnv, type Next } from 'hono';
import { createMiddleware } from 'hono/factory';

import {
	type DeadlineClock,
	remainingDeadlineMs,
	withDeadlineBudget
} from '../do/deadline.ts';
import {
	readRequestBudgetMs,
	tenantWorkerNarBudgetMs
} from '../policy/streaming.ts';

const tenantWorkerLogger = getLogger(['cupboard', 'tenant-worker']);

/**
Starts the deadline of a read whose response body is bounded in this Worker.
The reads that select the object and the response body share one budget of
{@link readRequestBudgetMs}, so a quick `get()` leaves the body the rest.
*/
export const readDeadline = createMiddleware<HonoEnv>(async (_context, next) =>
	withReadDeadline(readRequestBudgetMs, next, 'read.request')
);

/**
Returns middleware that runs the tenant Worker's work for a public NAR read,
up to its response headers, within {@link tenantWorkerNarBudgetMs} on
`clock`. Each storage call gets at most what remains of the budget. When the
budget passes before the handler returns, the call in progress fails, the
handler returns the retryable 503 of a timed-out read, and the middleware
logs `tenant Worker NAR budget passed`. The scope ends when the handler
returns, so it does not cover the NAR body.
*/
export function narReadDeadline(clock: DeadlineClock) {
	return createMiddleware<HonoEnv>(async (_context, next) =>
		withReadDeadline(tenantWorkerNarBudgetMs, next, 'read.nar', {
			clock,
			onBudgetPassed: () => {
				tenantWorkerLogger.warn('tenant Worker NAR budget passed', {
					budgetMs: tenantWorkerNarBudgetMs
				});
			}
		})
	);
}

/**
Runs the rest of a read within its deadline.

The deadline scope throws when its budget has run out, even after the
handler has returned. The response can then have a bounded body whose pipe
has already started, and an error response in its place would leave that
body without a reader. Keep the handler's response: an error inside the
handler has already become a response. The scope ends when the handler
returns, so a budget that has run out by then passed while the handler ran,
and `onBudgetPassed` reports it.
*/
async function withReadDeadline(
	budgetMs: number,
	next: Next,
	subrequest: string,
	options: {
		readonly clock?: DeadlineClock;
		readonly onBudgetPassed?: () => void;
	} = {}
): Promise<void> {
	const handler = { hasReturned: false };

	try {
		await withDeadlineBudget(
			budgetMs,
			async () => {
				await next();
				handler.hasReturned = true;
			},
			subrequest,
			options.clock
		);
	} catch (error) {
		if (!handler.hasReturned) {
			throw error;
		}

		options.onBudgetPassed?.();
	}
}

/**
The deadline for the body of a small object: what remains of the current
read's deadline, or the whole budget outside any deadline scope.
*/
export function remainingReadBudgetMs(): number {
	return remainingDeadlineMs() ?? readRequestBudgetMs;
}
