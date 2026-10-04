import type { StorePathHash } from '@cupboard/nix-store/scalars';

export interface AttestationPair {
	readonly storePathHash: StorePathHash;
	readonly digest: string;
}

export interface AttestationPartialBundleOutcome extends AttestationPair {
	readonly outcome:
		'attached' | 'reused' | 'unservable' | 'unconfirmed' | 'unattempted';
}

export interface AttestationAttachPartialOutcome {
	readonly uploadedBytes: number;
	readonly bundles: readonly AttestationPartialBundleOutcome[];
}

export class AttachmentProgress {
	private readonly outcomes = new Map<
		string,
		AttestationPartialBundleOutcome
	>();
	private failed = false;
	private bytes = 0;

	constructor(pairs: readonly AttestationPair[]) {
		for (const pair of pairs) {
			this.record({ ...pair, outcome: 'unattempted' });
		}
	}

	isStopped(): boolean {
		return this.failed;
	}

	stop(): void {
		this.failed = true;
	}

	uploaded(bytes: number): void {
		this.bytes += bytes;
	}

	started(pairs: readonly AttestationPair[]): void {
		for (const pair of pairs) {
			this.record({ ...pair, outcome: 'unconfirmed' });
		}
	}

	record(result: AttestationPartialBundleOutcome): void {
		this.outcomes.set(`${result.storePathHash}\0${result.digest}`, {
			storePathHash: result.storePathHash,
			digest: result.digest,
			outcome: result.outcome
		});
	}

	snapshot(): AttestationAttachPartialOutcome {
		return {
			uploadedBytes: this.bytes,
			bundles: this.outcomes.values().toArray()
		};
	}
}
