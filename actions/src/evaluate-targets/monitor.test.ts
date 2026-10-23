import process from 'node:process';
import { setImmediate } from 'node:timers/promises';

import { expect, it, onTestFinished, vi } from 'vitest';

import { withEvaluationMonitor } from './monitor.ts';

it.each([undefined, '0', '1'])(
	'collects resources only in runner debug mode %s',
	async (debug) => {
		const sample = vi.fn(() => Promise.resolve());
		const result = await withEvaluationMonitor(
			{ RUNNER_DEBUG: debug },
			() => Promise.resolve('manifest'),
			{ sample }
		);
		expect({ result, samples: sample.mock.calls.length }).toStrictEqual({
			result: 'manifest',
			samples: debug === '1' ? 1 : 0
		});
	}
);

it.each([false, true])(
	'cancels the pending sample timer promptly after evaluation failure=%s',
	async (fails) => {
		const sampled = Promise.withResolvers<undefined>();
		const failure = new Error('evaluation failed');
		const sample = vi.fn(() => {
			sampled.resolve(undefined);
			return Promise.resolve();
		});
		const result = withEvaluationMonitor(
			{ RUNNER_DEBUG: '1' },
			async () => {
				await sampled.promise;
				await setImmediate();
				if (fails) {
					throw failure;
				}
				return 'manifest';
			},
			{ sample }
		);
		if (fails) {
			await expect(result).rejects.toBe(failure);
		} else {
			await expect(result).resolves.toBe('manifest');
		}
		expect(sample.mock.calls).toStrictEqual([[expect.any(AbortSignal)]]);
	},
	1000
);

it.each([false, true])(
	'aborts and joins an active sample after evaluation failure=%s',
	async (fails) => {
		const events: string[] = [];
		const failure = new Error('evaluation failed');
		const result = withEvaluationMonitor(
			{ RUNNER_DEBUG: '1' },
			() => {
				events.push('evaluate');
				return fails ? Promise.reject(failure) : Promise.resolve('manifest');
			},
			{
				sample: (signal) =>
					new Promise((resolve) => {
						signal.addEventListener(
							'abort',
							() => {
								events.push('abort');
								queueMicrotask(() => {
									events.push('closed');
									resolve();
								});
							},
							{ once: true }
						);
					})
			}
		);
		if (fails) {
			await expect(result).rejects.toBe(failure);
		} else {
			await expect(result).resolves.toBe('manifest');
		}
		expect(events).toStrictEqual(['evaluate', 'abort', 'closed']);
	}
);

it('leaves evaluation usable when a resource sample fails', async () => {
	const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
	onTestFinished(() => {
		stderr.mockRestore();
	});
	const sampled = Promise.withResolvers<undefined>();
	const failure = new Error('monitor unavailable');
	const result = await withEvaluationMonitor(
		{ RUNNER_DEBUG: '1' },
		async () => {
			await sampled.promise;
			await setImmediate();
			return 'manifest';
		},
		{
			sample: () => {
				sampled.resolve(undefined);
				return Promise.reject(failure);
			}
		}
	);
	expect({ result, reports: stderr.mock.calls }).toStrictEqual({
		result: 'manifest',
		reports: [['Evaluation monitor unavailable: Error: monitor unavailable\n']]
	});
});
