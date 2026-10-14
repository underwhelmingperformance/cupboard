import { bytesToHex } from '@cupboard/nix-store/encoding';
import { sha256HexDigestSchema } from '@cupboard/nix-store/scalars';
import {
	type ArtifactKind,
	maxArtifactBytes
} from '@cupboard/protocol/artifacts';
import { positiveSafeInteger } from '@cupboard/shared/limits';

import { raceVerificationOperation } from '../do/verification-claim-lease.ts';
import { SubrequestTimeoutError } from '../errors.ts';

import { type ArtifactStageMeasurement } from './artifact-staging.ts';
import { ByteBufferLease, ByteBufferPool } from './byte-buffers.ts';

const minimumPartBytes = 5 * 1024 * 1024;
const sharedBuffers = new ByteBufferPool({
	buffers: 2,
	bufferSize: minimumPartBytes
});
type WriterState = 'open' | 'finishing' | 'complete' | 'failed';

export interface ArtifactMultipartWriterOptions {
	readonly kind: ArtifactKind;
	readonly maximumBytes?: number;
	readonly signal?: AbortSignal;
	readonly assertCurrent?: () => Promise<void>;
	readonly pool?: ByteBufferPool;
}
export class ArtifactWriterUnavailableError extends Error {
	constructor(reason: string) {
		super(`Cannot write artifact: ${reason}`);
		this.name = 'ArtifactWriterUnavailableError';
	}
}

export class ArtifactMultipartWriter {
	private readonly lease: ByteBufferLease;
	private readonly buffer: Uint8Array;
	private readonly hash: DigestStream;
	private readonly hashWriter: WritableStreamDefaultWriter<
		ArrayBuffer | ArrayBufferView
	>;
	private readonly controller = new AbortController();
	private readonly signal: AbortSignal;
	private readonly maximumBytes: number;
	private readonly outstanding = new Set<Promise<void>>();
	private readonly parts: R2UploadedPart[] = [];
	private state: WriterState = 'open';
	private isBusy = false;
	private buffered = 0;
	private size = 0;
	private measurement: ArtifactStageMeasurement | undefined;

	constructor(
		private readonly upload: R2MultipartUpload,
		private readonly options: ArtifactMultipartWriterOptions
	) {
		this.maximumBytes = positiveSafeInteger(
			options.maximumBytes ?? maxArtifactBytes[options.kind],
			'artifact output byte limit'
		);
		if (this.maximumBytes > maxArtifactBytes[options.kind]) {
			throw new RangeError('The artifact output limit exceeds its kind budget');
		}
		const pool = options.pool ?? sharedBuffers;
		if (pool.bufferSize < minimumPartBytes) {
			throw new RangeError('Artifact multipart buffers must be at least 5 MiB');
		}
		const lease = pool.tryAcquire();
		if (lease === undefined) {
			throw new ArtifactWriterUnavailableError('upload buffers are busy');
		}
		this.lease = lease;
		this.buffer = new Uint8Array(lease.buffer);
		this.hash = new crypto.DigestStream('SHA-256');
		this.hashWriter = this.hash.getWriter();
		this.signal =
			options.signal === undefined
				? this.controller.signal
				: AbortSignal.any([this.controller.signal, options.signal]);
	}
	private begin(): void {
		if (this.isBusy) {
			throw new ArtifactWriterUnavailableError('the writer is busy');
		}
		if (this.state !== 'open') {
			throw new ArtifactWriterUnavailableError('the writer is no longer open');
		}
		this.signal.throwIfAborted();
		this.isBusy = true;
	}
	private releaseIfFinished(): void {
		if (
			!this.isBusy &&
			this.state !== 'open' &&
			this.state !== 'finishing' &&
			this.outstanding.size === 0
		) {
			this.lease.release();
		}
	}
	private async track(operation: Promise<unknown>): Promise<void> {
		try {
			await operation;
		} catch (error) {
			if (
				error instanceof SubrequestTimeoutError &&
				error.abandoned !== undefined
			) {
				await error.abandoned;
			}
		}
	}
	private async removeWhenSettled(settled: Promise<void>): Promise<void> {
		await settled;
		this.outstanding.delete(settled);
		this.releaseIfFinished();
	}
	private async perform<T>(operation: () => Promise<T>): Promise<T> {
		const started = operation();
		const settled = this.track(started);
		this.outstanding.add(settled);
		void this.removeWhenSettled(settled);
		return raceVerificationOperation(started, this.signal);
	}
	private async assertCurrent(): Promise<void> {
		this.signal.throwIfAborted();
		await this.options.assertCurrent?.();
		this.signal.throwIfAborted();
	}
	private async flush(): Promise<void> {
		await this.assertCurrent();
		const partNumber = this.parts.length + 1;
		const bytes = this.buffer.subarray(0, this.buffered);
		const part = await this.perform(() =>
			this.upload.uploadPart(partNumber, bytes)
		);
		this.parts.push(part);
		this.buffered = 0;
	}
	async write(bytes: Uint8Array): Promise<void> {
		this.begin();
		try {
			if (bytes.byteLength > this.maximumBytes - this.size) {
				throw new RangeError('Artifact output exceeds its byte budget');
			}
			await this.hashWriter.write(bytes);
			this.size += bytes.byteLength;
			let position = 0;
			while (position < bytes.byteLength) {
				this.signal.throwIfAborted();
				const copied = Math.min(
					this.buffer.byteLength - this.buffered,
					bytes.byteLength - position
				);
				this.buffer.set(
					bytes.subarray(position, position + copied),
					this.buffered
				);
				this.buffered += copied;
				position += copied;
				if (this.buffered === this.buffer.byteLength) {
					await this.flush();
				}
			}
		} catch (error) {
			this.state = 'failed';
			throw error;
		} finally {
			this.isBusy = false;
			this.releaseIfFinished();
		}
	}
	async finish(): Promise<ArtifactStageMeasurement> {
		if (this.state === 'complete' && this.measurement !== undefined) {
			return this.measurement;
		}
		this.begin();
		this.state = 'finishing';
		try {
			if (this.buffered > 0 || this.parts.length === 0) {
				await this.flush();
			}
			await this.hashWriter.close();
			const digest = sha256HexDigestSchema.parse(
				bytesToHex(new Uint8Array(await this.hash.digest))
			);
			await this.assertCurrent();
			const object = await this.perform(() => this.upload.complete(this.parts));
			await this.assertCurrent();
			if (object.size !== this.size) {
				throw new Error(
					'The completed artifact size differs from its measured bytes'
				);
			}
			this.measurement = { digest, size: this.size };
			this.state = 'complete';
			return this.measurement;
		} catch (error) {
			this.state = 'failed';
			throw error;
		} finally {
			this.isBusy = false;
			this.releaseIfFinished();
		}
	}
	async abort(
		reason: unknown = new ArtifactWriterUnavailableError(
			'the writer was aborted'
		)
	): Promise<void> {
		if (this.state === 'complete' || this.controller.signal.aborted) {
			return;
		}
		this.state = 'failed';
		this.controller.abort(reason);
		const aborted = this.upload.abort();
		const settled = this.track(aborted);
		this.outstanding.add(settled);
		void this.removeWhenSettled(settled);
		await Promise.allSettled([this.hashWriter.abort(reason), this.hash.digest]);
		try {
			await aborted;
		} finally {
			this.releaseIfFinished();
		}
	}
	async settled(): Promise<void> {
		await Promise.all(this.outstanding);
		this.releaseIfFinished();
	}
}
