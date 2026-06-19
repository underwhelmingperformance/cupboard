import { describe, expect, it } from 'vitest';

import { abortable } from './abort.ts';
import { CliAbortError } from './errors.ts';

function pendingPromise(): Promise<never> {
	return new Promise<never>(() => {
		// Intentionally pending.
	});
}

describe('abortable', () => {
	it('rejects with the abort reason while the underlying promise is pending', async () => {
		const controller = new AbortController();
		const pending = pendingPromise();
		const aborted = abortable(pending, controller.signal);
		const reason = new CliAbortError();

		controller.abort(reason);

		let error: unknown;
		try {
			error = await aborted;
		} catch (error_: unknown) {
			error = error_;
		}

		expect({
			error:
				error instanceof CliAbortError
					? { name: error.name, reason: error === reason }
					: undefined
		}).toStrictEqual({
			error: { name: 'CliAbortError', reason: true }
		});
	});

	it('removes the abort listener after the promise settles', async () => {
		const controller = new AbortController();
		const value = await abortable(Promise.resolve('done'), controller.signal);

		controller.abort(new CliAbortError());

		expect(value).toBe('done');
	});
});
