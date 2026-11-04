import { Hono } from 'hono';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it, vi } from 'vitest';

import { withDeadlineBudget } from '../do/deadline.ts';
import { readRequestBudgetMs } from '../policy/streaming.ts';

import { serverErrorHandler } from './error-response.ts';
import { readDeadline, remainingReadBudgetMs } from './read-deadline.ts';

describe('remainingReadBudgetMs', () => {
	it('leaves the body what a slow read did not use', async () => {
		vi.useFakeTimers();

		try {
			const remaining = await withDeadlineBudget(
				readRequestBudgetMs,
				async () => {
					// The reads that select the object take 15 seconds.
					await vi.advanceTimersByTimeAsync(15_000);

					return remainingReadBudgetMs();
				}
			);

			expect(remaining).toBe(readRequestBudgetMs - 15_000);
		} finally {
			vi.useRealTimers();
		}
	});

	it('gives the whole budget outside a deadline scope', () => {
		expect(remainingReadBudgetMs()).toBe(readRequestBudgetMs);
	});
});

describe('readDeadline', () => {
	it('keeps the response of a handler that returns after the deadline', async () => {
		vi.useFakeTimers();

		try {
			const app = new Hono();
			app.onError(serverErrorHandler);
			app.get('/', readDeadline, () => {
				// Work that the deadline cannot abort outlasts the budget.
				vi.advanceTimersByTime(readRequestBudgetMs + 1);

				return new Response('served');
			});

			const response = await app.fetch(new Request('https://tenant.invalid/'));

			expect({
				status: response.status,
				body: await response.text()
			}).toStrictEqual({ status: StatusCodes.OK, body: 'served' });
		} finally {
			vi.useRealTimers();
		}
	});
});
