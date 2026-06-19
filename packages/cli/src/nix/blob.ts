import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';

import { zstdCompressionStream } from '@cupboard/nix/zstd';

import { type ByteSource, byteStream } from '../io/byte-stream.ts';
import { writeFileByteStream } from '../io/file-stream.ts';

import type { NarDigest } from './nar.ts';
import { NixSha256Hash } from './nar.ts';

export type NarCompression = 'zstd';

export interface CompressedNarBlob {
	readonly fileHash: NixSha256Hash;
	readonly fileSize: number;
	readonly compression: NarCompression;
}

export class CompressedNarFile {
	constructor(
		public readonly path: string,
		public readonly blob: CompressedNarBlob
	) {}
}

export interface CompressedAndHashedNarFile {
	readonly compressed: CompressedNarFile;
	readonly narDigest: NarDigest;
}

export async function compressNarToFile(
	nar: ByteSource,
	path: string
): Promise<CompressedNarFile> {
	const compressedHasher = new HashingByteTransform();

	await byteStream(nar)
		.pipeThrough(zstdCompressionStream())
		.pipeThrough(compressedHasher.stream)
		.pipeTo(writeFileByteStream(path));

	const written = await stat(path);
	const digest = compressedHasher.digest();

	return new CompressedNarFile(path, {
		fileHash: digest.hash,
		fileSize: written.size,
		compression: 'zstd'
	});
}

export async function compressAndHashNarToFile(
	nar: ByteSource,
	path: string
): Promise<CompressedAndHashedNarFile> {
	const narHasher = new HashingByteTransform();
	const compressedHasher = new HashingByteTransform();

	await byteStream(nar)
		.pipeThrough(narHasher.stream)
		.pipeThrough(zstdCompressionStream())
		.pipeThrough(compressedHasher.stream)
		.pipeTo(writeFileByteStream(path));

	const written = await stat(path);
	const compressedDigest = compressedHasher.digest();
	const narDigest = narHasher.digest();

	return {
		compressed: new CompressedNarFile(path, {
			fileHash: compressedDigest.hash,
			fileSize: written.size,
			compression: 'zstd'
		}),
		narDigest: {
			narHash: narDigest.hash,
			narSize: narDigest.size
		}
	};
}

class HashingByteTransform {
	private readonly hash = createHash('sha256');

	private size = 0;

	readonly stream: TransformStream<Uint8Array, Uint8Array>;

	constructor() {
		this.stream = new TransformStream<Uint8Array, Uint8Array>({
			transform: (chunk, controller) => {
				this.hash.update(chunk);
				this.size += chunk.byteLength;
				controller.enqueue(chunk);
			}
		});
	}

	digest(): {
		readonly hash: NixSha256Hash;
		readonly size: number;
	} {
		return {
			hash: NixSha256Hash.fromDigest(this.hash.digest()),
			size: this.size
		};
	}
}
