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

		controller.abort(new CliAbortError());

		await expect(aborted).rejects.toBeInstanceOf(CliAbortError);
	});

	it('removes the abort listener after the promise settles', async () => {
		const controller = new AbortController();
		const value = await abortable(Promise.resolve('done'), controller.signal);

		controller.abort(new CliAbortError());

		expect(value).toBe('done');
	});
});
