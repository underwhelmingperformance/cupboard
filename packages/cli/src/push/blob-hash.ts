import { createHash } from 'node:crypto';

import { toNixSha256 } from '@cupboard/nix-store/hash';
import type { CommitBlobDeclaration } from '@cupboard/protocol/upload';

/**
 * Hashes the final compressed object, including its skippable frames.
 */
export class CompressedBlobHasher {
	private readonly hash = createHash('sha256');

	private size = 0;

	update(bytes: Uint8Array): void {
		this.hash.update(bytes);
		this.size += bytes.byteLength;
	}

	declaration(): CommitBlobDeclaration {
		return {
			fileHash: toNixSha256(this.hash.copy().digest()).toString(),
			fileSize: this.size
		};
	}
}
