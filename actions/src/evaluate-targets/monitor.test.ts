import { execFile } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { AbortableChildProcessLifecycle } from '@cupboard/shared/child-process';
import { expect, it, vi } from 'vitest';

import { withEvaluationMonitor } from './monitor.ts';

const execute = promisify(execFile);
const script = fileURLToPath(
	new URL('../../evaluate-targets/monitor.sh', import.meta.url)
);

it.each(['', '0', '1'])(
	'collects resources only in runner debug mode %j',
	async (debug) => {
		const result = await execute('bash', [script, '--once'], {
			env: { ...process.env, RUNNER_DEBUG: debug }
		});
		expect({
			stdout: result.stdout,
			resourceSample: result.stderr.includes('[evaluation resource-sample]'),
			processMemory: result.stderr.includes('RSS'),
			diskSpace: result.stderr.includes('Filesystem')
		}).toStrictEqual({
			stdout: '',
			resourceSample: debug === '1',
			processMemory: debug === '1',
			diskSpace: debug === '1'
		});
	}
);

it.each([false, true])(
	'joins the monitor after evaluation failure=%s',
	async (fails) => {
		const events: string[] = [];
		let close:
			Parameters<AbortableChildProcessLifecycle['onceClose']>[0] | undefined;
		const failure = new Error('evaluation failed');
		const result = withEvaluationMonitor(
			{ RUNNER_DEBUG: '1' },
			() => {
				events.push('evaluate');
				return fails ? Promise.reject(failure) : Promise.resolve('manifest');
			},
			{
				start: () => ({
					kill(signal) {
						events.push(signal);
						queueMicrotask(() => {
							events.push('closed');
							close?.(0, undefined);
						});
						return true;
					},
					onceError: vi.fn(),
					onceClose(listener) {
						close = listener;
					}
				})
			}
		);
		if (fails) {
			await expect(result).rejects.toBe(failure);
		} else {
			await expect(result).resolves.toBe('manifest');
		}
		expect(events).toStrictEqual(['evaluate', 'SIGTERM', 'closed']);
	}
);

it.each([undefined, '0', '1'])(
	'monitor startup failure leaves evaluation usable with debug=%s',
	async (debug) => {
		const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
		try {
			const start = vi.fn(() => {
				throw new Error('monitor unavailable');
			});
			const result = await withEvaluationMonitor(
				{ RUNNER_DEBUG: debug },
				() => Promise.resolve('manifest'),
				{ start }
			);
			expect({
				result,
				starts: start.mock.calls.length,
				reports: stderr.mock.calls.length
			}).toStrictEqual({
				result: 'manifest',
				starts: debug === '1' ? 1 : 0,
				reports: debug === '1' ? 1 : 0
			});
		} finally {
			stderr.mockRestore();
		}
	}
);
