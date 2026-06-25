import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pathModule from 'node:path';

import { zstdDecompressionStream } from '@cupboard/nix-store/zstd';
import { describe, expect, it } from 'vitest';

import { withTemporaryDirectory } from '../../../../tests/support/filesystem.ts';
import { byteStream } from '../io/byte-stream.ts';

import {
	compressAndHashNarToFile,
	CompressedNarFile,
	compressNarToFile
} from './blob.ts';
import { NixSha256Hash } from './nar.ts';

describe('compressNarToFile', () => {
	it('writes zstd data and records compressed blob metadata', async () => {
		await withTemporaryDirectory('cupboard-blob-', async (directory) => {
			const output = pathModule.join(directory, 'test.nar.zst');
			const input = Buffer.from('nix-archive-1 test payload');
			const compressed = await compressNarToFile(byteStream([input]), output);
			const bytes = await readFile(output);

			expect(compressed.path).toBe(output);
			expect(compressed.blob).toStrictEqual({
				fileHash: NixSha256Hash.fromDigest(
					createHash('sha256').update(bytes).digest()
				),
				fileSize: bytes.byteLength,
				compression: 'zstd'
			});
			expect(await decompress(bytes)).toStrictEqual(input);
		});
	});
});

describe('compressAndHashNarToFile', () => {
	it('records compressed blob metadata and uncompressed NAR metadata in one pass', async () => {
		await withTemporaryDirectory('cupboard-blob-', async (directory) => {
			const output = pathModule.join(directory, 'test.nar.zst');
			const input = Buffer.from('nix-archive-1 test payload');
			const compressed = await compressAndHashNarToFile(
				byteStream([input]),
				output
			);
			const bytes = await readFile(output);

			const fileDigest = createHash('sha256').update(bytes).digest();
			const narDigest = createHash('sha256').update(input).digest();

			expect(compressed).toStrictEqual({
				compressed: new CompressedNarFile(output, {
					fileHash: NixSha256Hash.fromDigest(fileDigest),
					fileSize: bytes.byteLength,
					compression: 'zstd'
				}),
				narDigest: {
					narHash: NixSha256Hash.fromDigest(narDigest),
					narSize: input.byteLength
				}
			});
			expect(await decompress(bytes)).toStrictEqual(input);
		});
	});
});

async function decompress(bytes: Uint8Array): Promise<Buffer> {
	const decompressed = byteStream([bytes]).pipeThrough(
		zstdDecompressionStream()
	);

	return Buffer.concat(await collect(decompressed));
}

async function collect(
	stream: ReadableStream<Uint8Array>
): Promise<Uint8Array[]> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];

	try {
		let isDone = false;

		while (!isDone) {
			const next = await reader.read();
			isDone = next.done;

			if (next.done) {
				continue;
			}

			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}

	return chunks;
}
