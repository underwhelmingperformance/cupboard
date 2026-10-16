import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	nixSha256HashSchema,
	sha256HexDigestSchema
} from '@cupboard/nix-store/scalars';
import { zstdCompressionStream } from '@cupboard/nix-store/zstd';
import {
	currentListingGeneratorRevision,
	type NarListingFact
} from '@cupboard/protocol/artifacts';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import { sha256HexBytes } from '../crypto/crypto.ts';
import { r2ObjectKeySchema } from '../http/http.ts';

import { StoredNarListingGenerator } from './nar-listing-generation.ts';
import { NarListingMetadataSink } from './nar-listing-metadata.ts';
import { NarListingOutput } from './nar-listing-output.ts';
import {
	type NarMetadataCapture,
	type NarMetadataSink
} from './nar-metadata.ts';
import { NarReadBufferPool } from './nar-read-buffers.ts';
import {
	type ExpectedNar,
	verifyAndWriteStoredNar,
	verifyStoredNar
} from './nar-verify.ts';

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
	const fileHash = NixSha256Hash.fromDigest(
		new Uint8Array(await crypto.subtle.digest('SHA-256', compressed))
	).value;
	const canonical = r2ObjectKeySchema.parse(`${target}-canonical`);
	return {
		source,
		target,
		upload,
		expected,
		raw,
		compressed,
		canonical,
		blob: { fileHash, fileSize: compressed.byteLength }
	};
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

type CaptureMode = 'verify' | 'canonical';
async function captureVerification(
	value: Awaited<ReturnType<typeof fixture>>,
	sink: NarMetadataSink,
	mode: CaptureMode = 'verify',
	expected: ExpectedNar = value.expected
) {
	const deferred: Promise<void>[] = [];
	const metadata: NarMetadataCapture = {
		sink,
		defer: (completion) => {
			deferred.push(completion);
		}
	};
	const options = { buffers: new NarReadBufferPool(), metadata };
	const verification =
		mode === 'verify'
			? await verifyStoredNar(env.BLOBS, value.source, expected, options)
			: await verifyAndWriteStoredNar(
					env.BLOBS,
					value.source,
					expected,
					{ key: value.canonical, ...value.blob },
					options
				);
	return { verification, deferred };
}
function captureSink(
	value: Awaited<ReturnType<typeof fixture>>,
	maximumOutputBytes?: number
) {
	const facts: NarListingFact[] = [];
	const abandoned: unknown[] = [];
	const output = new NarListingOutput({
		upload: value.upload,
		narHash: value.expected.narHash,
		maximumOutputBytes
	});
	const sink = new NarListingMetadataSink({
		output,
		seal: (fact) => {
			facts.push(fact);
			return Promise.resolve();
		},
		abandon: async (reason) => {
			abandoned.push(reason);
			await env.BLOBS.delete(value.target);
		}
	});
	return { output, sink, facts, abandoned };
}
describe('optional listing verification capture', () => {
	it.each(['verify', 'canonical'] as const)(
		'seals a measured listing from the existing %s decode without rereading the NAR',
		async (mode) => {
			const value = await fixture();
			const capture = captureSink(value);
			const get = vi.spyOn(env.BLOBS, 'get');
			try {
				const { verification, deferred } = await captureVerification(
					value,
					capture.sink,
					mode
				);
				await Promise.all(deferred);
				const object = await env.BLOBS.get(value.target);
				if (object === null) {
					throw new Error('The captured listing is missing');
				}
				const bytes = new Uint8Array(await object.arrayBuffer());
				const listing: unknown = JSON.parse(new TextDecoder().decode(bytes));
				const canonical = await env.BLOBS.get(value.canonical);
				expect({
					verification,
					facts: capture.facts,
					abandoned: capture.abandoned,
					listing,
					reads: get.mock.calls.filter(([key]) => key === value.source).length,
					canonical:
						canonical === null
							? undefined
							: new Uint8Array(await canonical.arrayBuffer())
				}).toStrictEqual({
					verification:
						mode === 'canonical' ? { ok: true } : { ok: true, ...value.blob },
					facts: [
						{
							narHash: value.expected.narHash,
							generatorRevision: currentListingGeneratorRevision,
							format: 1,
							digest: sha256HexDigestSchema.parse(await sha256HexBytes(bytes)),
							size: bytes.byteLength
						}
					],
					abandoned: [],
					listing: {
						version: 1,
						root: { type: 'regular', size: 5, narOffset: 96 }
					},
					reads: 1,
					canonical: mode === 'canonical' ? value.compressed : undefined
				});
			} finally {
				get.mockRestore();
			}
		}
	);
	it.each(
		(['verify', 'canonical'] as const).flatMap((mode) =>
			(['hash', 'size'] as const).map((mismatch) => ({ mode, mismatch }))
		)
	)(
		'abandons output when the $mode NAR $mismatch is rejected',
		async ({ mode, mismatch }) => {
			const value = await fixture();
			const capture = captureSink(value);
			const expected =
				mismatch === 'hash'
					? {
							...value.expected,
							narHash: nixSha256HashSchema.parse(`sha256:${'0'.repeat(52)}`)
						}
					: { ...value.expected, narSize: value.expected.narSize + 1 };
			const { verification, deferred } = await captureVerification(
				value,
				capture.sink,
				mode,
				expected
			);
			await Promise.all(deferred);
			expect({
				verification,
				facts: capture.facts,
				abandoned: capture.abandoned.map((reason) => reason instanceof Error),
				objectExists: (await env.BLOBS.head(value.target)) !== null
			}).toStrictEqual({
				verification:
					mismatch === 'hash'
						? {
								ok: false,
								reason: 'nar-hash-mismatch',
								actualNarHash: value.expected.narHash
							}
						: {
								ok: false,
								reason: 'nar-size-mismatch',
								actualNarSize: value.expected.narSize
							},
				facts: [],
				abandoned: [true],
				objectExists: false
			});
		}
	);
	it.each(['invalid archive', 'incomplete archive', 'output limit'] as const)(
		'preserves accepted NAR verification after an optional %s failure',
		async (failure) => {
			const raw =
				failure === 'invalid archive'
					? new TextEncoder().encode('not a NAR')
					: failure === 'incomplete archive'
						? archive([
								'nix-archive-1',
								'(',
								'type',
								'regular',
								'contents',
								'hello'
							])
						: undefined;
			const value = await fixture(raw);
			const capture = captureSink(
				value,
				failure === 'output limit' ? 8 : undefined
			);
			const { verification, deferred } = await captureVerification(
				value,
				capture.sink
			);
			await Promise.all(deferred);
			expect({
				verification,
				facts: capture.facts,
				abandoned: capture.abandoned.map((reason) => reason instanceof Error),
				objectExists: (await env.BLOBS.head(value.target)) !== null
			}).toStrictEqual({
				verification: { ok: true, ...value.blob },
				facts: [],
				abandoned: [true],
				objectExists: false
			});
		}
	);
	it('does not seal completed bytes after cancellation while R2 completes', async () => {
		const value = await fixture();
		const capture = captureSink(value);
		const controller = new AbortController();
		const reason = new Error('Capture cancelled during completion');
		const complete = value.upload.complete.bind(value.upload);
		const completion = vi
			.spyOn(value.upload, 'complete')
			.mockImplementation(async (parts) => {
				const object = await complete(parts);
				controller.abort(reason);
				return object;
			});
		try {
			await capture.sink.write(value.raw, controller.signal);
			await expect(capture.sink.finish(controller.signal)).rejects.toThrow(
				reason
			);
			await capture.sink.abort(reason);
			expect({
				facts: capture.facts,
				abandoned: capture.abandoned,
				objectExists: (await env.BLOBS.head(value.target)) !== null
			}).toStrictEqual({ facts: [], abandoned: [reason], objectExists: false });
		} finally {
			completion.mockRestore();
		}
	});
	it('requests owner cleanup even when the multipart abort fails', async () => {
		const value = await fixture();
		const capture = captureSink(value);
		const reason = new Error('Capture cancelled');
		const abort = vi
			.spyOn(value.upload, 'abort')
			.mockRejectedValueOnce(new Error('Multipart abort failed'));
		try {
			await expect(capture.sink.abort(reason)).rejects.toBeInstanceOf(
				AggregateError
			);
			expect(capture.abandoned).toStrictEqual([reason]);
		} finally {
			abort.mockRestore();
			await value.upload.abort();
		}
	});
});

describe('synchronous cleanup failures', () => {
	it('observes multipart cleanup and a synchronous owner failure together', async () => {
		const value = await fixture();
		const output = new NarListingOutput({
			upload: value.upload,
			narHash: value.expected.narHash
		});
		const multipartFailure = new Error('Multipart cleanup failed');
		const ownerFailure = new Error('Owner cleanup failed');
		const abort = vi
			.spyOn(value.upload, 'abort')
			.mockRejectedValueOnce(multipartFailure);
		const sink = new NarListingMetadataSink({
			output,
			seal: () => Promise.resolve(),
			abandon: () => {
				throw ownerFailure;
			}
		});
		try {
			await expect(
				sink.abort(new Error('Capture cancelled'))
			).rejects.toStrictEqual(
				new AggregateError(
					[multipartFailure, ownerFailure],
					'Listing capture cleanup failed'
				)
			);
		} finally {
			abort.mockRestore();
			await value.upload.abort();
		}
	});
});
