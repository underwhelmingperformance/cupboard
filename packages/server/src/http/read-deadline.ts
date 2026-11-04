import { type Env as HonoEnv, type Next } from 'hono';
import { createMiddleware } from 'hono/factory';

import { remainingDeadlineMs, withDeadlineBudget } from '../do/deadline.ts';
import { readRequestBudgetMs } from '../policy/streaming.ts';

/**
Starts the deadline of a read whose response body is bounded in this Worker.
The reads that select the object and the response body share one budget of
{@link readRequestBudgetMs}, so a quick `get()` leaves the body the rest.
*/
export const readDeadline = createMiddleware<HonoEnv>(async (_context, next) =>
	withReadDeadline(readRequestBudgetMs, next)
);

/**
Runs the rest of a read within its deadline.

The deadline scope throws when its budget has run out, even after the
handler has returned. The response can then have a bounded body whose pipe
has already started, and an error response in its place would leave that
body without a reader. Keep the handler's response: an error inside the
handler has already become a response.
*/
async function withReadDeadline(budgetMs: number, next: Next): Promise<void> {
	const handler = { hasReturned: false };

	try {
		await withDeadlineBudget(
			budgetMs,
			async () => {
				await next();
				handler.hasReturned = true;
			},
			'read.request'
		);
	} catch (error) {
		if (!handler.hasReturned) {
			throw error;
		}
	}
}

/**
The deadline for the body of a small object: what remains of the current
read's deadline, or the whole budget outside any deadline scope.
*/
export function remainingReadBudgetMs(): number {
	return remainingDeadlineMs() ?? readRequestBudgetMs;
}
