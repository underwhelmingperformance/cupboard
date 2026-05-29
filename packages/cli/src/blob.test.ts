import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pathModule from 'node:path';

import { describe, expect, it } from 'vitest';

import { withTemporaryDirectory } from '../../../tests/support/filesystem.ts';

import {
	compressAndHashNarToFile,
	CompressedNarFile,
	compressNarToFile
} from './blob.ts';
import { byteStream } from './byte-stream.ts';
import { NixSha256Hash } from './nar.ts';
import { zstdDecompressionStream } from './zstd.ts';

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

			expect(compressed).toStrictEqual({
				compressed: new CompressedNarFile(output, {
					fileHash: NixSha256Hash.fromDigest(
						createHash('sha256').update(bytes).digest()
					),
					fileSize: bytes.byteLength,
					compression: 'zstd'
				}),
				narDigest: {
					narHash: NixSha256Hash.fromDigest(
						createHash('sha256').update(input).digest()
					),
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
		let done = false;

		while (!done) {
			const next = await reader.read();
			done = next.done;

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
