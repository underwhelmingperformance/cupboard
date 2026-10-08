const mebibyte = 1024 * 1024;

export interface NarReadBufferPoolOptions {
	readonly buffers?: number;
	readonly bufferSize?: number;
}

export interface NarReadBufferPoolState {
	readonly free: number;
	readonly allocations: number;
}

/**
 * A buffer that one ranged read keeps until the decoder has consumed its
 * bytes. Every exit path must call `release`; a second call has no effect.
 */
export class NarReadBufferLease {
	private isReleased = false;
	private current: ArrayBuffer;

	constructor(
		buffer: ArrayBuffer,
		private readonly onRelease: (buffer: ArrayBuffer) => void
	) {
		this.current = buffer;
	}

	get buffer(): ArrayBuffer {
		return this.current;
	}

	/**
	 * A BYOB read detaches the `ArrayBuffer` that it is given and returns the
	 * same memory as a new `ArrayBuffer`. The reader passes `value.buffer` here
	 * after every read, so the pool gets back the live buffer.
	 */
	replaceBuffer(buffer: ArrayBuffer): void {
		this.current = buffer;
	}

	release(): void {
		if (this.isReleased) {
			return;
		}

		this.isReleased = true;
		this.onRelease(this.current);
	}
}

/**
 * A fixed number of equal-sized buffers for reading parts of a stored NAR
 * ahead of the decoder. `tryAcquire` never waits: it returns `undefined` when
 * every buffer is leased, and the caller reads sequentially instead. The pool
 * allocates a buffer when it first leases it, so it uses no memory until a
 * read needs one.
 */
export class NarReadBufferPool {
	private readonly capacity: number;
	private readonly idle: ArrayBuffer[] = [];
	private leased = 0;
	private allocated = 0;
	readonly bufferSize: number;

	constructor({
		buffers = 4,
		bufferSize = 8 * mebibyte
	}: NarReadBufferPoolOptions = {}) {
		this.capacity = buffers;
		this.bufferSize = bufferSize;
	}

	private allocate(): ArrayBuffer {
		this.allocated += 1;

		return new ArrayBuffer(this.bufferSize);
	}

	private restore(buffer: ArrayBuffer): void {
		this.leased -= 1;

		// A cancelled or failed BYOB read can keep the memory that it was given and
		// leave the lease with a detached buffer. The next lease allocates a
		// replacement.
		if (buffer.detached) {
			return;
		}

		this.idle.push(buffer);
	}

	get state(): NarReadBufferPoolState {
		return {
			free: this.capacity - this.leased,
			allocations: this.allocated
		};
	}

	tryAcquire(): NarReadBufferLease | undefined {
		if (this.leased === this.capacity) {
			return undefined;
		}

		this.leased += 1;

		return new NarReadBufferLease(
			this.idle.pop() ?? this.allocate(),
			(buffer) => {
				this.restore(buffer);
			}
		);
	}
}
