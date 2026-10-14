import { NarListingWriter } from '@cupboard/nix-store/nar-listing';
import {
	currentListingGeneratorRevision,
	type ListingGeneratorRevision,
	maxArtifactBytes,
	type NarListingFact,
	narListingFactSchema
} from '@cupboard/protocol/artifacts';

import type { R2ObjectKey } from '../http/http.ts';

import {
	ArtifactMultipartWriter,
	type ArtifactOutputBuffer
} from './artifact-multipart-writer.ts';
import type { ByteBufferPool } from './byte-buffers.ts';
import type { R2ObjectStore } from './connection-limited-bucket.ts';
import type { NarReadBufferPool } from './nar-read-buffers.ts';
import {
	type ExpectedNar,
	type NarVerification,
	type NarVerifyProgress,
	verifyStoredNar
} from './nar-verify.ts';

export interface StoredNarListingOptions {
	readonly objects: R2ObjectStore;
	readonly source: R2ObjectKey;
	readonly expected: ExpectedNar;
	readonly upload: R2MultipartUpload;
	readonly buffers: NarReadBufferPool;
	readonly outputBuffers?: ByteBufferPool;
	readonly outputBuffer?: ArtifactOutputBuffer;
	readonly signal?: AbortSignal;
	readonly assertCurrent?: () => Promise<void>;
	readonly generatorRevision?: ListingGeneratorRevision;
	readonly maximumOutputBytes?: number;
	readonly progress?: NarVerifyProgress;
}
export type NarListingGeneration =
	| { readonly kind: 'generated'; readonly fact: NarListingFact }
	| {
			readonly kind: 'mismatch';
			readonly verification: Extract<NarVerification, { readonly ok: false }>;
	  };

export class StoredNarListingGenerator {
	constructor(private readonly options: StoredNarListingOptions) {}

	async run(): Promise<NarListingGeneration> {
		const encoder = new TextEncoder();
		const maximumBytes =
			this.options.maximumOutputBytes ?? maxArtifactBytes.listing;
		const output = new ArtifactMultipartWriter(this.options.upload, {
			kind: 'listing',
			maximumBytes,
			pool: this.options.outputBuffers,
			buffer: this.options.outputBuffer,
			signal: this.options.signal,
			assertCurrent: this.options.assertCurrent
		});
		const listing = new NarListingWriter({
			write: (json) => output.write(encoder.encode(json)),
			maxOutputBytes: maximumBytes
		});
		let isComplete = false;
		try {
			await this.options.assertCurrent?.();
			const verification = await verifyStoredNar(
				this.options.objects,
				this.options.source,
				this.options.expected,
				{
					buffers: this.options.buffers,
					signal: this.options.signal,
					progress: this.options.progress,
					decoded: (chunk) => listing.write(chunk)
				}
			);
			if (!verification.ok) {
				return { kind: 'mismatch', verification };
			}
			await listing.end();
			const measurement = await output.finish();
			const fact = narListingFactSchema.parse({
				narHash: this.options.expected.narHash,
				generatorRevision:
					this.options.generatorRevision ?? currentListingGeneratorRevision,
				format: 1,
				...measurement
			});
			isComplete = true;
			return { kind: 'generated', fact };
		} finally {
			if (!isComplete) {
				await Promise.allSettled([output.abort()]);
			}
		}
	}
}
