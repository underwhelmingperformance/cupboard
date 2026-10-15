import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	cacheGenerationSchema,
	narInfoGenerationSchema,
	storePathHashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { zstdCompressionStream } from '@cupboard/nix-store/zstd';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';

import * as schema from '../db/d1-schema.ts';
import { type sharedNarDiscoveryFixture } from '../db/shared-nar-discovery.test-support.ts';
import { narObjectKey } from '../http/http.ts';
const now = isoTimestamp(new Date('2026-01-01T00:00:00.000Z'));

export function archiveTokens(values: readonly string[]): Uint8Array {
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
	let position = 0;
	for (const chunk of chunks) {
		result.set(chunk, position);
		position += chunk.byteLength;
	}
	return result;
}

export function archive(contents: string): Uint8Array {
	return archiveTokens([
		'nix-archive-1',
		'(',
		'type',
		'regular',
		'contents',
		contents,
		')'
	]);
}

export async function registerNar(
	database: Awaited<ReturnType<typeof sharedNarDiscoveryFixture>>['database'],
	raw: Uint8Array,
	index = 0
) {
	const narHash = NixSha256Hash.fromDigest(
		new Uint8Array(await crypto.subtle.digest('SHA-256', raw))
	).value;
	const input = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(raw);
			controller.close();
		}
	});
	const stream = input.pipeThrough(zstdCompressionStream());
	const response = new Response(stream);
	const compressed = new Uint8Array(await response.arrayBuffer());
	const fileHash = NixSha256Hash.fromDigest(
		new Uint8Array(await crypto.subtle.digest('SHA-256', compressed))
	).value;
	const source = narObjectKey(narHash);
	await env.BLOBS.put(source, compressed);
	const storePathHash = storePathHashSchema.parse(
		String(index).padStart(32, '0')
	);
	await database.batch([
		database.insert(schema.blobState).values({
			narHash,
			fileHash,
			narSize: raw.byteLength,
			fileSize: compressed.byteLength,
			compression: 'zstd',
			incarnation: 1,
			verifiedAt: now
		}),
		database.insert(schema.objectIncarnation).values({
			kind: 'nar',
			objectId: narHash,
			incarnation: 1,
			state: 'live',
			updatedAt: now
		}),
		database.insert(schema.blobReference).values({
			tenant: tenantIdSchema.parse('discovery-first'),
			cacheKind: 'default',
			cacheGeneration: cacheGenerationSchema.parse(1),
			storePathHash,
			generation: narInfoGenerationSchema.parse(1),
			narHash
		})
	]);
	return { narHash, source, compressed };
}
