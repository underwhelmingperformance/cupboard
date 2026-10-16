import { type NarListingFact } from '@cupboard/protocol/artifacts';

import { type NarListingOutput } from './nar-listing-output.ts';
import { type NarMetadataSink } from './nar-metadata.ts';

export interface NarListingMetadataOptions {
	readonly output: NarListingOutput;
	readonly seal: (fact: NarListingFact, signal: AbortSignal) => Promise<void>;
	readonly abandon: (reason: unknown) => Promise<void>;
}
export class NarListingMetadataSink implements NarMetadataSink {
	constructor(private readonly options: NarListingMetadataOptions) {}
	async write(chunk: Uint8Array, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		await this.options.output.write(chunk);
		signal.throwIfAborted();
	}
	async finish(signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		const fact = await this.options.output.finish();
		signal.throwIfAborted();
		await this.options.seal(fact, signal);
		signal.throwIfAborted();
	}
	async abort(reason: unknown): Promise<void> {
		const results = await Promise.allSettled([
			Promise.try(() => this.options.output.abort(reason)),
			Promise.try(() => this.options.abandon(reason))
		]);
		const errors: unknown[] = [];
		for (const result of results) {
			if (result.status === 'rejected') {
				errors.push(result.reason);
			}
		}
		if (errors.length > 0) {
			throw new AggregateError(errors, 'Listing capture cleanup failed');
		}
	}
}
