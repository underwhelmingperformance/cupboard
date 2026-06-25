import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { zstdCompressionStream } from '@cupboard/nix-store/zstd';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

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
	const encoder = new TextEncoder();
	const nar = encoder.encode('nar payload '.repeat(250_000));

	it('accepts a blob whose decompressed bytes match the claimed hash and size', async () => {
		const narHash = await nixNarHash(nar);

		const result = await verifyDecompressedNar(compressedStream(nar), {
			narHash,
			narSize: nar.byteLength
		});

		expect(result).toStrictEqual({ ok: true });
	});

	it('rejects a hash mismatch and reports the recomputed hash', async () => {
		const encoder = new TextEncoder();
		const claimed = await nixNarHash(encoder.encode('something else'));
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

	it('aborts decompression mid-stream once the declared size is exceeded', async () => {
		const narHash = await nixNarHash(nar);
		const declaredNarSize = 1024;

		// Declaring a size far below the ~3 MB payload trips the overrun guard after
		// the first over-limit chunk, so the read loop bails without draining the
		// stream — the zstd-bomb defence. A reported size past the limit but well
		// short of the full payload proves it stopped mid-stream.
		const result = await verifyDecompressedNar(compressedStream(nar), {
			narHash,
			narSize: declaredNarSize
		});
		const mismatch = z
			.object({
				ok: z.literal(false),
				reason: z.literal('nar-size-mismatch'),
				actualNarSize: z.number()
			})
			.parse(result);

		expect({
			mismatch,
			bounds: {
				overDeclared: mismatch.actualNarSize > declaredNarSize,
				underFullPayload: mismatch.actualNarSize < nar.byteLength
			}
		}).toStrictEqual({
			mismatch: {
				ok: false,
				reason: 'nar-size-mismatch',
				actualNarSize: mismatch.actualNarSize
			},
			bounds: {
				overDeclared: true,
				underFullPayload: true
			}
		});
	});
});
