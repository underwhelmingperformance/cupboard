import { NarListingWriter } from '@cupboard/nix-store/nar-listing';
import {
	currentListingGeneratorRevision,
	type ListingGeneratorRevision,
	maxArtifactBytes,
	type NarListingFact,
	narListingFactSchema
} from '@cupboard/protocol/artifacts';

import {
	ArtifactMultipartWriter,
	type ArtifactOutputBuffer
} from './artifact-multipart-writer.ts';
import { type ByteBufferPool } from './byte-buffers.ts';

export interface NarListingOutputOptions {
	readonly upload: R2MultipartUpload;
	readonly narHash: string;
	readonly generatorRevision?: ListingGeneratorRevision;
	readonly maximumOutputBytes?: number;
	readonly outputBuffers?: ByteBufferPool;
	readonly outputBuffer?: ArtifactOutputBuffer;
	readonly signal?: AbortSignal;
	readonly assertCurrent?: () => Promise<void>;
}
export class NarListingOutput {
	private readonly output: ArtifactMultipartWriter;
	private readonly listing: NarListingWriter;
	private completion: Promise<NarListingFact> | undefined;
	constructor(private readonly options: NarListingOutputOptions) {
		const encoder = new TextEncoder();
		const maximumBytes = options.maximumOutputBytes ?? maxArtifactBytes.listing;
		this.output = new ArtifactMultipartWriter(options.upload, {
			kind: 'listing',
			maximumBytes,
			pool: options.outputBuffers,
			buffer: options.outputBuffer,
			signal: options.signal,
			assertCurrent: options.assertCurrent
		});
		this.listing = new NarListingWriter({
			write: (json) => this.output.write(encoder.encode(json)),
			maxOutputBytes: maximumBytes
		});
	}
	private async complete(): Promise<NarListingFact> {
		await this.listing.end();
		const measurement = await this.output.finish();
		return narListingFactSchema.parse({
			narHash: this.options.narHash,
			generatorRevision:
				this.options.generatorRevision ?? currentListingGeneratorRevision,
			format: 1,
			...measurement
		});
	}
	write(chunk: Uint8Array): Promise<void> {
		return this.listing.write(chunk);
	}
	finish(): Promise<NarListingFact> {
		this.completion ??= this.complete();
		return this.completion;
	}
	abort(reason?: unknown): Promise<void> {
		return this.output.abort(reason);
	}
}
