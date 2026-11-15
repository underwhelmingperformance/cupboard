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
	'cancels the pending sample delay after evaluation failure=%s',
	async (fails) => {
		const delayed = Promise.withResolvers<undefined>();
		const failure = new Error('evaluation failed');
		const delays: {
			readonly milliseconds: number;
			readonly signal: AbortSignal | undefined;
		}[] = [];
		const sample = vi.fn(() => Promise.resolve());
		// Like the delay from `node:timers/promises`, it never ends until its
		// signal aborts.
		const delay = vi.fn(
			(
				milliseconds: number,
				_value: undefined,
				options?: { readonly signal: AbortSignal }
			) => {
				delays.push({ milliseconds, signal: options?.signal });
				delayed.resolve(undefined);

				if (options === undefined) {
					return Promise.reject(new Error('the delay received no signal'));
				}

				return new Promise<void>((_resolve, reject) => {
					options.signal.addEventListener(
						'abort',
						() => {
							reject(new Error('the delay was cancelled'));
						},
						{ once: true }
					);
				});
			}
		);
		const result = withEvaluationMonitor(
			{ RUNNER_DEBUG: '1' },
			async () => {
				await delayed.promise;
				if (fails) {
					throw failure;
				}
				return 'manifest';
			},
			{ sample, delay }
		);
		if (fails) {
			await expect(result).rejects.toBe(failure);
		} else {
			await expect(result).resolves.toBe('manifest');
		}
		expect({
			samples: sample.mock.calls.length,
			delays: delays.map(({ milliseconds, signal }) => ({
				milliseconds,
				isCancelled: signal?.aborted
			}))
		}).toStrictEqual({
			samples: 1,
			delays: [{ milliseconds: 5000, isCancelled: true }]
		});
	}
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
	const canWriteStderr = vi
		.spyOn(process.stderr, 'write')
		.mockReturnValue(true);
	onTestFinished(() => {
		canWriteStderr.mockRestore();
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
	expect({ result, reports: canWriteStderr.mock.calls }).toStrictEqual({
		result: 'manifest',
		reports: [['Evaluation monitor unavailable: Error: monitor unavailable\n']]
	});
});
