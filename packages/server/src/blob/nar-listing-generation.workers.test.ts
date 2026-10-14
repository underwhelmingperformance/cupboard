import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	nixSha256HashSchema,
	sha256HexDigestSchema
} from '@cupboard/nix-store/scalars';
import { zstdCompressionStream } from '@cupboard/nix-store/zstd';
import { currentListingGeneratorRevision } from '@cupboard/protocol/artifacts';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { sha256HexBytes } from '../crypto/crypto.ts';
import { r2ObjectKeySchema } from '../http/http.ts';

import { StoredNarListingGenerator } from './nar-listing-generation.ts';
import { NarReadBufferPool } from './nar-read-buffers.ts';

function archive(values: readonly string[]): Uint8Array {
	const chunks = values.map((value) => {
		const bytes = new TextEncoder().encode(value);
		const chunk = new Uint8Array(8 + Math.ceil(bytes.byteLength / 8) * 8);
		new DataView(chunk.buffer).setBigUint64(0, BigInt(bytes.byteLength), true);
		chunk.set(bytes, 8);
		return chunk;
	});
	const result = new Uint8Array(
		chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
	);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

async function fixture(
	raw = archive([
		'nix-archive-1',
		'(',
		'type',
		'regular',
		'contents',
		'hello',
		')'
	])
) {
	const source = r2ObjectKeySchema.parse(
		`nar/listing-${crypto.randomUUID()}.nar.zst`
	);
	const target = r2ObjectKeySchema.parse(
		`artifact-staging/listing-${crypto.randomUUID()}`
	);
	const input = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(raw);
			controller.close();
		}
	});
	const stream = input.pipeThrough(zstdCompressionStream());
	const response = new Response(stream);
	const compressed = new Uint8Array(await response.arrayBuffer());
	await env.BLOBS.put(source, compressed);
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
	const expected = {
		narHash: NixSha256Hash.fromDigest(digest).value,
		narSize: raw.byteLength
	};
	const upload = await env.BLOBS.createMultipartUpload(target);
	return { source, target, upload, expected };
}

describe('verified stored NAR listing generation', () => {
	it('generates and measures native listing bytes from a verified compressed NAR', async () => {
		const value = await fixture();
		const generator = new StoredNarListingGenerator({
			objects: env.BLOBS,
			source: value.source,
			expected: value.expected,
			upload: value.upload,
			buffers: new NarReadBufferPool({ bufferSize: 1024 * 1024 })
		});
		const result = await generator.run();
		const object = await env.BLOBS.get(value.target);
		if (object === null) {
			throw new Error('The generated listing is missing');
		}
		const bytes = new Uint8Array(await object.arrayBuffer());
		const listing: unknown = JSON.parse(new TextDecoder().decode(bytes));
		expect({ result, listing }).toStrictEqual({
			result: {
				kind: 'generated',
				fact: {
					narHash: value.expected.narHash,
					generatorRevision: currentListingGeneratorRevision,
					format: 1,
					digest: sha256HexDigestSchema.parse(await sha256HexBytes(bytes)),
					size: bytes.byteLength
				}
			},
			listing: { version: 1, root: { type: 'regular', size: 5, narOffset: 96 } }
		});
		await env.BLOBS.delete([value.source, value.target]);
	});

	it.each(['hash', 'size'] as const)(
		'does not complete staged output when the NAR %s is wrong',
		async (mismatch) => {
			const value = await fixture();
			const expected =
				mismatch === 'hash'
					? {
							...value.expected,
							narHash: nixSha256HashSchema.parse(`sha256:${'0'.repeat(52)}`)
						}
					: { ...value.expected, narSize: value.expected.narSize + 1 };
			const generator = new StoredNarListingGenerator({
				objects: env.BLOBS,
				source: value.source,
				expected,
				upload: value.upload,
				buffers: new NarReadBufferPool({ bufferSize: 1024 * 1024 })
			});
			const result = await generator.run();
			expect({
				kind: result.kind,
				exists: (await env.BLOBS.head(value.target)) !== null
			}).toStrictEqual({ kind: 'mismatch', exists: false });
			await env.BLOBS.delete(value.source);
		}
	);

	it('refuses structurally invalid NAR bytes even when their hash and size match', async () => {
		const value = await fixture(new TextEncoder().encode('not a NAR'));
		const generator = new StoredNarListingGenerator({
			objects: env.BLOBS,
			source: value.source,
			expected: value.expected,
			upload: value.upload,
			buffers: new NarReadBufferPool({ bufferSize: 1024 * 1024 })
		});
		await expect(generator.run()).rejects.toThrow('NAR listing');
		expect(await env.BLOBS.head(value.target)).toBeNull();
		await env.BLOBS.delete(value.source);
	});

	it('refuses an incomplete archive after its hash and size have been accepted', async () => {
		const raw = archive([
			'nix-archive-1',
			'(',
			'type',
			'regular',
			'contents',
			'hello'
		]);
		const value = await fixture(raw);
		const generator = new StoredNarListingGenerator({
			objects: env.BLOBS,
			source: value.source,
			expected: value.expected,
			upload: value.upload,
			buffers: new NarReadBufferPool({ bufferSize: 1024 * 1024 })
		});
		await expect(generator.run()).rejects.toThrow('incomplete archive');
		expect(await env.BLOBS.head(value.target)).toBeNull();
		await env.BLOBS.delete(value.source);
	});

	it('fails the generation job when the required listing output exceeds its budget', async () => {
		const value = await fixture();
		const generator = new StoredNarListingGenerator({
			objects: env.BLOBS,
			source: value.source,
			expected: value.expected,
			upload: value.upload,
			buffers: new NarReadBufferPool({ bufferSize: 1024 * 1024 }),
			maximumOutputBytes: 8
		});
		await expect(generator.run()).rejects.toThrow('limit');
		expect(await env.BLOBS.head(value.target)).toBeNull();
		await env.BLOBS.delete(value.source);
	});

	it('propagates producer revocation before completing the generated object', async () => {
		const value = await fixture();
		const generator = new StoredNarListingGenerator({
			objects: env.BLOBS,
			source: value.source,
			expected: value.expected,
			upload: value.upload,
			buffers: new NarReadBufferPool({ bufferSize: 1024 * 1024 }),
			assertCurrent: () => Promise.reject(new Error('producer revoked'))
		});
		await expect(generator.run()).rejects.toThrow('producer revoked');
		expect(await env.BLOBS.head(value.target)).toBeNull();
		await env.BLOBS.delete(value.source);
	});
});
