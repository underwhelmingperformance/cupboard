import { StatusCodes } from 'http-status-codes';
import { describe, expect, it, vi } from 'vitest';

import {
	BoundedBodyCollector,
	fetchWithBoundedResponseBodies,
	readResponseBytes,
	readResponseJson,
	readResponseText,
	RemoteBodyTooLargeError
} from './response-body.ts';

describe('bounded response bodies', () => {
	it('rejects a declared body before reading it and discards the stream', async () => {
		const cancel = vi.fn(() => Promise.reject(new Error('cancel failed')));
		const body = new ReadableStream<Uint8Array>({ cancel });
		const response = new Response(body, {
			headers: { 'content-length': '9' }
		});

		await expect(
			readResponseBytes(response, {
				description: 'test response',
				maximumBytes: 8
			})
		).rejects.toStrictEqual(
			new RemoteBodyTooLargeError('test response', 8, 9, 'declared')
		);
		expect(cancel).toHaveBeenCalledOnce();
	});

	it('cancels a streamed body at the first over-limit chunk', async () => {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({
			cancel,
			start(controller) {
				controller.enqueue(new Uint8Array([1, 2]));
				controller.enqueue(new Uint8Array([3, 4]));
			}
		});

		await expect(
			readResponseBytes(new Response(body), {
				description: 'test response',
				maximumBytes: 3
			})
		).rejects.toStrictEqual(new RemoteBodyTooLargeError('test response', 3, 4));
		expect(cancel).toHaveBeenCalledOnce();
	});

	it('reads bounded text and JSON through the same byte limit', async () => {
		await expect(
			readResponseText(new Response('hello'), {
				description: 'text response',
				maximumBytes: 5
			})
		).resolves.toBe('hello');
		await expect(
			readResponseJson(new Response('{"ok":true}'), {
				description: 'JSON response',
				maximumBytes: 11
			})
		).resolves.toStrictEqual({ ok: true });
	});
});

describe('bounded fetch responses', () => {
	it('counts streamed bytes without retaining them in a collector', async () => {
		const append = vi.spyOn(BoundedBodyCollector.prototype, 'append');
		const fetcher = fetchWithBoundedResponseBodies(
			() => Promise.resolve(new Response('accepted')),
			{
				description: 'provider response',
				errorMaximumBytes: 4,
				successMaximumBytes: 8
			}
		);

		const response = await fetcher('https://example.test');

		await expect(response.text()).resolves.toBe('accepted');
		expect(append).not.toHaveBeenCalled();
	});

	it('combines a caller signal with the request signal', async () => {
		const caller = new AbortController();
		const request = new AbortController();
		const reason = new Error('cancelled');
		let observed: AbortSignal | null | undefined;
		const fetcher = fetchWithBoundedResponseBodies(
			(_input, init) => {
				observed = init?.signal;

				return new Promise((_resolve, reject) => {
					observed?.addEventListener(
						'abort',
						() => {
							reject(reason);
						},
						{ once: true }
					);
				});
			},
			{
				description: 'provider response',
				errorMaximumBytes: 4,
				successMaximumBytes: 8,
				signal: caller.signal
			}
		);
		const pending = fetcher('https://example.test', {
			signal: request.signal
		});

		caller.abort(reason);

		await expect(pending).rejects.toBe(reason);
		expect(observed).not.toBe(caller.signal);
		expect(observed).not.toBe(request.signal);
	});

	it('cancels a response stream when the caller aborts after the headers arrive', async () => {
		const controller = new AbortController();
		const reason = new Error('stop reading');
		const cancelled = vi.fn();
		const source = new ReadableStream<Uint8Array>({ cancel: cancelled });
		const boundedFetch = fetchWithBoundedResponseBodies(
			() => Promise.resolve(new Response(source)),
			{
				description: 'test response',
				errorMaximumBytes: 8,
				successMaximumBytes: 8,
				signal: controller.signal
			}
		);
		const response = await boundedFetch('https://example.test');
		const body = response.text();

		controller.abort(reason);

		await expect(body).rejects.toBe(reason);
		expect(cancelled).toHaveBeenCalledWith(reason);
	});

	it.each([
		{ status: StatusCodes.OK, maximumBytes: 4, observedBytes: 6 },
		{
			status: StatusCodes.INTERNAL_SERVER_ERROR,
			maximumBytes: 2,
			observedBytes: 3
		}
	])(
		'limits a $status response while preserving streaming consumption',
		async ({ status, maximumBytes, observedBytes }) => {
			let wasCancelled = false;
			const response = new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('abc'));
						controller.enqueue(new TextEncoder().encode('def'));
					},
					cancel() {
						wasCancelled = true;
					}
				}),
				{ status }
			);
			const fetcher = fetchWithBoundedResponseBodies(
				() => Promise.resolve(response),
				{
					description: 'provider response',
					errorMaximumBytes: 2,
					successMaximumBytes: 4
				}
			);

			const bounded = await fetcher('https://example.test');

			await expect(bounded.text()).rejects.toEqual(
				new RemoteBodyTooLargeError(
					'provider response',
					maximumBytes,
					observedBytes
				)
			);
			expect(wasCancelled).toBe(true);
		}
	);
});

describe('BoundedBodyCollector', () => {
	it('keeps a bounded diagnostic prefix and marks it as truncated', () => {
		const collector = new BoundedBodyCollector(4, 'truncate');

		expect(collector.append(new TextEncoder().encode('abc'))).toBe(true);
		expect(collector.append(new TextEncoder().encode('def'))).toBe(false);
		expect(collector.byteLength).toBe(4);
		expect(collector.text()).toBe('abcd\n[response body truncated]');
	});
});
