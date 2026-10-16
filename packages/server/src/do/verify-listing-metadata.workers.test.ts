import { rootLogger } from '@cupboard/logger';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	sha256HexDigestSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { zstdCompressionStream } from '@cupboard/nix-store/zstd';
import {
	currentListingGeneratorRevision,
	type NarListingFact
} from '@cupboard/protocol/artifacts';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectionLimitedMultipartBucket } from '../blob/connection-limited-multipart.ts';
import { NarListingMetadataSink } from '../blob/nar-listing-metadata.ts';
import { NarListingOutput } from '../blob/nar-listing-output.ts';
import { type NarMetadataCapture } from '../blob/nar-metadata.ts';
import { NarReadBufferPool } from '../blob/nar-read-buffers.ts';
import { type R2RequestAdmission } from '../blob/r2-request-admission.ts';
import { sha256HexBytes } from '../crypto/crypto.ts';
import * as schema from '../db/schema.ts';
import { r2ObjectKeySchema } from '../http/http.ts';
import {
	type VerificationMetadataSource,
	verifyTenant,
	type VerifyTenantOptions
} from '../routing/scheduled.ts';
import {
	currentServer,
	currentServerTenant,
	expectSingleUploadDecision,
	fetchNarInfo,
	initialise,
	markUploadPendingVerification,
	negotiateUploads,
	putNarBytes,
	resetTestServer,
	uploadMetadata
} from '../test-support.ts';

import { boundedBlobs } from './bounded-io.ts';

async function sourceNar(contents = 'hello') {
	const parts = [
		'nix-archive-1',
		'(',
		'type',
		'regular',
		'contents',
		contents,
		')'
	].map((value) => {
		const bytes = new TextEncoder().encode(value);
		const part = new Uint8Array(8 + Math.ceil(bytes.byteLength / 8) * 8);
		new DataView(part.buffer).setBigUint64(0, BigInt(bytes.byteLength), true);
		part.set(bytes, 8);
		return part;
	});
	const raw = new Uint8Array(
		parts.reduce((total, part) => total + part.byteLength, 0)
	);
	let offset = 0;
	for (const part of parts) {
		raw.set(part, offset);
		offset += part.byteLength;
	}
	const input = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(raw);
			controller.close();
		}
	});
	const compressed = new Response(input.pipeThrough(zstdCompressionStream()));
	const narBytes = new Uint8Array(await compressed.arrayBuffer());
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
	const fileDigest = new Uint8Array(
		await crypto.subtle.digest('SHA-256', narBytes)
	);
	return {
		narBytes,
		narHash: NixSha256Hash.fromDigest(digest).value,
		narSize: raw.byteLength,
		fileHash: NixSha256Hash.fromDigest(fileDigest).value
	};
}

async function fixture(isDeclared = false) {
	const token = await initialise();
	const nar = await sourceNar();
	const storePathHash = storePathHashSchema.parse('a'.repeat(32));
	const metadata = uploadMetadata({
		storePathHash,
		narHash: nar.narHash,
		narSize: nar.narSize,
		fileHash: nar.fileHash,
		fileSize: nar.narBytes.byteLength
	});
	const upload = expectSingleUploadDecision(
		await negotiateUploads(token, [metadata]),
		metadata
	);
	await putNarBytes(upload.r2Key, nar);
	await markUploadPendingVerification(upload.uploadId);
	if (isDeclared) {
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.update(schema.pendingUploads)
				.set({
					declaredFileHash: nar.fileHash,
					declaredFileSize: nar.narBytes.byteLength
				})
				.where(eq(schema.pendingUploads.id, upload.uploadId))
				.run();
		});
	}
	return { nar, upload, storePathHash };
}

function verify(options: VerifyTenantOptions) {
	return verifyTenant(
		rootLogger(),
		env,
		new NarReadBufferPool(),
		currentServerTenant(),
		undefined,
		undefined,
		undefined,
		options
	);
}

describe('fresh verification listing metadata', () => {
	beforeEach(resetTestServer);
	it.each([false, true])(
		'publishes the NAR while optional listing sealing is blocked (isDeclared: %s)',
		async (isDeclared) => {
			const value = await fixture(isDeclared);
			const key = r2ObjectKeySchema.parse(
				`artifact-staging/forward-${crypto.randomUUID()}`
			);
			const upload = await env.BLOBS.createMultipartUpload(key);
			const gate = Promise.withResolvers<undefined>();
			const sealing = Promise.withResolvers<undefined>();
			const deferred: Promise<void>[] = [];
			const facts: NarListingFact[] = [];
			const sources: VerificationMetadataSource[] = [];
			const abandoned: unknown[] = [];
			const sinkFor = (admission: R2RequestAdmission) => {
				const metadata = new ConnectionLimitedMultipartBucket(
					boundedBlobs(env.BLOBS),
					admission,
					{ priority: 'optional' }
				);
				return new NarListingMetadataSink({
					output: new NarListingOutput({
						upload: metadata.resumeMultipartUpload(key, upload.uploadId),
						narHash: value.nar.narHash
					}),
					seal: async (fact, signal) => {
						sealing.resolve(undefined);
						await gate.promise;
						signal.throwIfAborted();
						facts.push(fact);
					},
					abandon: async (reason) => {
						abandoned.push(reason);
						await env.BLOBS.delete(key);
					}
				});
			};
			try {
				await verify({
					metadataFor: (source, resources) => {
						sources.push(source);
						return {
							sink: sinkFor(resources.admission),
							defer: (completion) => {
								deferred.push(completion);
							}
						};
					}
				});
				await fetchNarInfo(value.storePathHash);
				expect({
					facts,
					deferred: deferred.length,
					sources: sources.map(({ tenant, owner, claim }) => ({
						tenant,
						owned: owner.length > 0,
						uploadId: claim.uploadId,
						key: claim.r2Key,
						narHash: claim.narHash,
						narSize: claim.narSize,
						reuse: claim.reuse,
						blob: claim.blob
					}))
				}).toStrictEqual({
					facts: [],
					deferred: 1,
					sources: [
						{
							tenant: currentServerTenant(),
							owned: true,
							uploadId: value.upload.uploadId,
							key: value.upload.r2Key,
							narHash: value.nar.narHash,
							narSize: value.nar.narSize,
							reuse: false,
							blob: isDeclared
								? {
										fileHash: value.nar.fileHash,
										fileSize: value.nar.narBytes.byteLength
									}
								: undefined
						}
					]
				});
				await sealing.promise;
				gate.resolve(undefined);
				await Promise.all(deferred);
				const object = await env.BLOBS.get(key);
				if (object === null) {
					throw new Error('The captured listing is missing');
				}
				const bytes = new Uint8Array(await object.arrayBuffer());
				const listing: unknown = JSON.parse(new TextDecoder().decode(bytes));
				expect({ facts, listing, abandoned }).toStrictEqual({
					facts: [
						{
							narHash: value.nar.narHash,
							generatorRevision: currentListingGeneratorRevision,
							format: 1,
							digest: sha256HexDigestSchema.parse(await sha256HexBytes(bytes)),
							size: bytes.byteLength
						}
					],
					listing: {
						version: 1,
						root: { type: 'regular', size: 5, narOffset: 96 }
					},
					abandoned: []
				});
			} finally {
				gate.resolve(undefined);
				await Promise.all(deferred);
				await upload.abort();
				await env.BLOBS.delete(key);
			}
		}
	);
	it('publishes a valid NAR when optional capture setup throws', async () => {
		const value = await fixture();
		const metadataFor = vi.fn(() => {
			throw new Error('Metadata setup failed');
		});
		await verify({ metadataFor });
		await fetchNarInfo(value.storePathHash);
		expect(metadataFor).toHaveBeenCalledOnce();
	});
	it('uses the Worker capture policy even when a provider supplies custom limits', async () => {
		const value = await fixture();
		const deferred: Promise<void>[] = [];
		const sink = {
			write: vi.fn(() => Promise.resolve()),
			finish: vi.fn(() => Promise.resolve()),
			abort: vi.fn(() => Promise.resolve())
		};
		const capture: NarMetadataCapture = {
			sink,
			defer: (completion) => {
				deferred.push(completion);
			},
			maxBufferedBytes: 0,
			operationTimeoutMs: 0
		};
		await verify({ metadataFor: () => capture });
		await Promise.all(deferred);
		await fetchNarInfo(value.storePathHash);
		expect({
			writes: sink.write.mock.calls.length,
			finishes: sink.finish.mock.calls.length,
			aborts: sink.abort.mock.calls.length,
			deferred: deferred.length
		}).toStrictEqual({ writes: 1, finishes: 1, aborts: 0, deferred: 1 });
	});
});
