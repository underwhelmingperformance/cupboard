import { describe, expect, it, vi } from 'vitest';

import { fetchWithProbeDeadline } from './cache-probe.ts';
import { ProbeTimeoutError } from './errors.ts';

describe('fetchWithProbeDeadline', () => {
	it('aborts the underlying fetch while body consumption is stalled', async () => {
		vi.useFakeTimers();

		try {
			let receivedSignal: AbortSignal | undefined;
			const fetcher: typeof fetch = (_input, init) => {
				receivedSignal = init?.signal ?? undefined;
				const body = new ReadableStream({
					start(controller) {
						receivedSignal?.addEventListener(
							'abort',
							() => {
								controller.error(new Error('response body aborted'));
							},
							{ once: true }
						);
					}
				});

				return Promise.resolve(new Response(body));
			};
			const pending = fetchWithProbeDeadline(
				fetcher,
				'https://cache.example.test/path.narinfo',
				undefined,
				(response) => response.text(),
				100
			);
			const rejection =
				expect(pending).rejects.toBeInstanceOf(ProbeTimeoutError);

			await vi.advanceTimersByTimeAsync(100);
			await rejection;

			expect(receivedSignal?.aborted).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});
