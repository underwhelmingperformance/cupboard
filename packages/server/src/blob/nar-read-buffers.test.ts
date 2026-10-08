import { describe, expect, it } from 'vitest';

import { NarReadBufferPool } from './nar-read-buffers.ts';

describe('NarReadBufferPool', () => {
	it('refuses a lease while every buffer is leased and counts each release once', () => {
		const buffers = new NarReadBufferPool({ buffers: 2, bufferSize: 16 });
		const first = buffers.tryAcquire();
		const second = buffers.tryAcquire();
		const refused = buffers.tryAcquire();
		const exhausted = buffers.state;
		first?.release();
		first?.release();

		expect({
			leased: [first, second].map((lease) => lease?.buffer.byteLength),
			refused,
			exhausted,
			released: buffers.state
		}).toStrictEqual({
			leased: [16, 16],
			refused: undefined,
			exhausted: { free: 0, allocations: 2 },
			released: { free: 1, allocations: 2 }
		});
	});

	it('replaces a buffer that a read left detached', () => {
		const buffers = new NarReadBufferPool({ buffers: 1, bufferSize: 16 });
		const lease = buffers.tryAcquire();

		if (lease === undefined) {
			throw new Error('expected a free buffer');
		}

		void lease.buffer.transfer();
		lease.release();
		const next = buffers.tryAcquire();

		expect({
			size: next?.buffer.byteLength,
			state: buffers.state
		}).toStrictEqual({
			size: 16,
			state: { free: 0, allocations: 2 }
		});
	});
});
