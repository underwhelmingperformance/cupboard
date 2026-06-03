import { NixSha256Hash, zstdCompressionStream } from '@cupboard/shared';
import { describe, expect, it } from 'vitest';

import { verifyDecompressedNar } from './nar-verify.ts';

async function nixNarHash(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));

	return NixSha256Hash.fromDigest(digest).toString();
}

function compressedStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
	const source = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		}
	});

	return source.pipeThrough(zstdCompressionStream());
}

describe('verifyDecompressedNar', () => {
	// ~3 MB so the stream cycles the bridge's chunk queue rather than passing in
	// one piece; a true multi-hundred-MB bounded-memory check belongs in the
	// runtime benchmark, not the unit suite.
	const nar = new TextEncoder().encode('nar payload '.repeat(250_000));

	it('accepts a blob whose decompressed bytes match the claimed hash and size', async () => {
		const narHash = await nixNarHash(nar);

		const result = await verifyDecompressedNar(compressedStream(nar), {
			narHash,
			narSize: nar.byteLength
		});

		expect(result).toStrictEqual({ ok: true });
	});

	it('rejects a hash mismatch and reports the recomputed hash', async () => {
		const claimed = await nixNarHash(
			new TextEncoder().encode('something else')
		);
		const actualNarHash = await nixNarHash(nar);

		const result = await verifyDecompressedNar(compressedStream(nar), {
			narHash: claimed,
			narSize: nar.byteLength
		});

		expect(result).toStrictEqual({
			ok: false,
			reason: 'nar-hash-mismatch',
			actualNarHash
		});
	});

	it('rejects a size mismatch when the hash matches', async () => {
		const narHash = await nixNarHash(nar);

		const result = await verifyDecompressedNar(compressedStream(nar), {
			narHash,
			narSize: nar.byteLength + 1
		});

		expect(result).toStrictEqual({
			ok: false,
			reason: 'nar-size-mismatch',
			actualNarSize: nar.byteLength
		});
	});
});
