import { expect, it } from 'vitest';

import { ManualClock } from './manual-clock.ts';

it.each([0, 1000])(
	'waits for a %i ms delay to be scheduled before advancing',
	async (milliseconds) => {
		const clock = new ManualClock();
		const controller = new AbortController();
		const advance = clock.advanceThroughDelay(milliseconds);
		const delay = clock.wait(milliseconds, controller.signal);

		await advance;
		await delay;

		expect(clock.now()).toBe(milliseconds);
	}
);

it('ignores a cancelled delay when waiting for a replacement', async () => {
	const clock = new ManualClock();
	const controller = new AbortController();
	const error = new Error('cancelled');
	const cancelled = expect(clock.wait(1000, controller.signal)).rejects.toBe(
		error
	);
	controller.abort(error);
	const advance = clock.advanceThroughDelay(1000);
	const replacement = clock.wait(1000, new AbortController().signal);

	await cancelled;
	await advance;
	await replacement;

	expect(clock.now()).toBe(1000);
});
