import { positiveSafeInteger } from '@cupboard/shared/limits';
import { withDeadline } from '@cupboard/shared/timeout';

import { raceVerificationOperation } from '../do/verification-claim-lease.ts';
import { SubrequestTimeoutError } from '../errors.ts';

/**
 * Receives uncompressed bytes during verification. Writes may create staging
 * objects; only `finish` may publish metadata, after the NAR is accepted.
 * Operations must respect cancellation and fence any late publication.
 */
export interface NarMetadataSink {
	write(chunk: Uint8Array, signal: AbortSignal): Promise<void>;
	finish(signal: AbortSignal): Promise<void>;
	abort(reason: unknown): Promise<void>;
}

export interface NarMetadataCapture {
	readonly sink: NarMetadataSink;
	/**
	 * Keeps the completion and cleanup task alive, for example with `waitUntil`.
	 */
	readonly defer: (completion: Promise<void>) => void;
	readonly maxBufferedBytes?: number;
	readonly operationTimeoutMs?: number;
}

/**
 * Limits copied NAR bytes across optional metadata captures in one isolate.
 */
export class NarMetadataBufferBudget {
	private reserved = 0;
	private readonly limit: number;

	constructor(limit: number) {
		this.limit = positiveSafeInteger(limit, 'metadata buffer budget');
	}

	reserve(size: number): boolean {
		if (size > this.limit - this.reserved) {
			return false;
		}
		this.reserved += size;
		return true;
	}

	release(size: number): void {
		this.reserved -= size;
	}
}

const sharedMetadataBuffers = new NarMetadataBufferBudget(8 * 1024 * 1024);

type CaptureState = 'recording' | 'finishing' | 'done' | 'aborted';

/**
 * Copies a bounded amount of decoder output without delaying NAR verification.
 * Completion and cleanup run in the caller's deferred task.
 */
export class OptionalNarMetadata {
	private state: CaptureState;
	private readonly controller = new AbortController();
	private readonly completed = Promise.withResolvers<undefined>();
	private readonly queue: Uint8Array[] = [];
	private buffered = 0;
	private pumping: Promise<void> | undefined;
	private readonly maxBufferedBytes: number;
	private readonly operationTimeoutMs: number;

	constructor(
		private readonly capture?: NarMetadataCapture,
		private readonly budget = sharedMetadataBuffers
	) {
		this.state = capture === undefined ? 'done' : 'recording';
		this.maxBufferedBytes = positiveSafeInteger(
			capture?.maxBufferedBytes ?? 4 * 1024 * 1024,
			'metadata buffered bytes'
		);
		this.operationTimeoutMs = positiveSafeInteger(
			capture?.operationTimeoutMs ?? 5000,
			'metadata operation timeout'
		);
		if (capture === undefined) {
			return;
		}
		try {
			capture.defer(this.completed.promise);
		} catch (error) {
			this.abort(error);
		}
	}

	private operation(work: () => Promise<void>): Promise<void> {
		return withDeadline(
			() => raceVerificationOperation(work(), this.controller.signal),
			this.operationTimeoutMs,
			(abandoned) => new SubrequestTimeoutError('nar.metadata', abandoned)
		);
	}

	private release(size: number): void {
		this.buffered -= size;
		this.budget.release(size);
	}

	private async drain(): Promise<void> {
		try {
			while (!this.controller.signal.aborted) {
				const chunk = this.queue.shift();
				if (chunk === undefined) {
					return;
				}
				const size = chunk.byteLength;
				const write = async (): Promise<void> => {
					try {
						await this.capture?.sink.write(chunk, this.controller.signal);
					} finally {
						// A sink can still use the copy after its deadline.
						// Release the buffer only when the sink settles.
						this.release(size);
					}
				};
				await this.operation(write);
			}
		} catch (error) {
			this.abort(error);
		} finally {
			this.pumping = undefined;
		}
	}

	private async cleanup(reason: unknown): Promise<void> {
		try {
			await withDeadline(
				async () => this.capture?.sink.abort(reason),
				this.operationTimeoutMs,
				(abandoned) =>
					new SubrequestTimeoutError('nar.metadata.abort', abandoned)
			);
		} catch {
			return;
		} finally {
			this.completed.resolve(undefined);
		}
	}

	private async complete(): Promise<void> {
		try {
			await this.operation(async () => this.pumping);
			this.controller.signal.throwIfAborted();
			await this.operation(async () =>
				this.capture?.sink.finish(this.controller.signal)
			);
			this.controller.signal.throwIfAborted();
			this.state = 'done';
			this.completed.resolve(undefined);
		} catch (error) {
			this.abort(error);
		}
	}

	write(chunk: Uint8Array): void {
		if (this.state !== 'recording' || chunk.byteLength === 0) {
			return;
		}
		if (
			chunk.byteLength > this.maxBufferedBytes - this.buffered ||
			!this.budget.reserve(chunk.byteLength)
		) {
			this.abort(new RangeError('NAR metadata exceeded its buffering limit.'));
			return;
		}
		this.buffered += chunk.byteLength;
		this.queue.push(new Uint8Array(chunk));
		this.pumping ??= this.drain();
	}

	finish(): void {
		if (this.state !== 'recording') {
			return;
		}
		this.state = 'finishing';
		void this.complete();
	}

	abort(reason: unknown): void {
		if (this.state === 'done' || this.state === 'aborted') {
			return;
		}
		this.state = 'aborted';
		this.controller.abort(reason);
		for (const chunk of this.queue.splice(0)) {
			this.release(chunk.byteLength);
		}
		void this.cleanup(reason);
	}
}
