import { describe, expect, it, vi } from 'vitest';

import {
	BoundedBodyCollector,
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
		).rejects.toStrictEqual(new RemoteBodyTooLargeError('test response', 8, 9));
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

describe('BoundedBodyCollector', () => {
	it('keeps a bounded diagnostic prefix and marks it as truncated', () => {
		const collector = new BoundedBodyCollector(4, 'truncate');

		expect(collector.append(new TextEncoder().encode('abc'))).toBe(true);
		expect(collector.append(new TextEncoder().encode('def'))).toBe(false);
		expect(collector.byteLength).toBe(4);
		expect(collector.text()).toBe('abcd\n[response body truncated]');
	});
});
