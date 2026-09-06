import { rootLogger } from '@cupboard/logger';
import { startCapture } from '@cupboard/logger/testing';
import {
	nixSha256HashSchema,
	sha256HexDigestSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { uploadIdSchema } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../db/schema.ts';
import { r2ObjectKeySchema } from '../http/http.ts';
import {
	clearBlobStorage,
	currentServer,
	initialise,
	negotiateUploads,
	resetTestServer,
	resolvedCache,
	runGcResult,
	uploadMetadata,
	verifiableNar
} from '../test-support.ts';

import {
	GarbageCollectionService,
	maxOrphanListPages
} from './garbage-collection-service.ts';

// A push credential is scoped to `staging/<pushId>/`, so a client may write keys
// beneath it that it never negotiated. The negotiated keys have pending rows the
// reaper owns; reconciliation reclaims the rest once they age past the upload
// grace. The harness fakes `Date` at a fixed epoch but R2 stamps
// `R2Object.uploaded` from the real wall clock, so these tests read the real time
// back from a probe object and move the garbage collector's clock relative to it.

const uploadGraceMs = 15 * 60 * 1000;

async function realUploadInstant(): Promise<number> {
	await env.BLOBS.put('probe/now', new Uint8Array([0]));
	const head = await env.BLOBS.head('probe/now');
	await env.BLOBS.delete('probe/now');

	if (head === null) {
		throw new Error('probe object vanished');
	}

	return head.uploaded.getTime();
}

describe('orphan staging reconciliation', () => {
	beforeEach(async () => {
		await resetTestServer();
		await clearBlobStorage();
	});

	it('reclaims an un-negotiated staging object and spares the negotiated one', async () => {
		const realNow = await realUploadInstant();
		vi.setSystemTime(new Date(realNow + uploadGraceMs + 5 * 60 * 1000));

		const token = await initialise();
		const nar = await verifiableNar('orphan-tracked');
		const metadata = uploadMetadata({
			storePathHash: 'a'.repeat(32),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		const negotiation = await negotiateUploads(token, [metadata]);
		const decision = negotiation.uploads[0];

		if (decision?.action !== 'upload') {
			throw new Error('expected an upload decision for a fresh nar');
		}

		const trackedKey = decision.r2Key;
		const pushPrefix = trackedKey.slice(0, trackedKey.lastIndexOf('/') + 1);
		const orphanKey = `${pushPrefix}un-negotiated.nar.zst`;

		await env.BLOBS.put(trackedKey, nar.narBytes);
		await env.BLOBS.put(orphanKey, new Uint8Array([1, 2, 3]));

		const result = await runGcResult();

		expect({
			orphanStagingDeleted: result.orphanStagingDeleted,
			trackedPresent: (await env.BLOBS.head(trackedKey)) !== null,
			orphanPresent: (await env.BLOBS.head(orphanKey)) !== null
		}).toStrictEqual({
			orphanStagingDeleted: 1,
			trackedPresent: true,
			orphanPresent: false
		});
	});

	it('spares pending NAR and attestation objects with current and historical keys', async () => {
		const fixtures = [
			{
				kind: 'nar',
				id: uploadIdSchema.parse('historical-nar'),
				key: r2ObjectKeySchema.parse('staging/historical-nar.nar.zst')
			},
			{
				kind: 'nar',
				id: uploadIdSchema.parse('current-nar'),
				key: r2ObjectKeySchema.parse('staging/current-push/current-nar.nar.zst')
			},
			{
				kind: 'attestation',
				id: uploadIdSchema.parse('historical-attestation'),
				key: r2ObjectKeySchema.parse(
					'staging/attestations/historical-attestation'
				)
			},
			{
				kind: 'attestation',
				id: uploadIdSchema.parse('current-attestation'),
				key: r2ObjectKeySchema.parse(
					'staging/current-push/attestations/current-attestation'
				)
			}
		] as const;
		const realNow = await realUploadInstant();
		const collectionTime = realNow + uploadGraceMs + 5 * 60 * 1000;
		const expiresAt = isoTimestampSchema.parse(
			new Date(collectionTime + 60 * 60 * 1000).toISOString()
		);

		await Promise.all(
			fixtures.map((fixture) =>
				env.BLOBS.put(fixture.key, new Uint8Array([1, 2, 3]))
			)
		);
		await runInDurableObject(currentServer(), (instance) => {
			const cacheId = resolvedCache(instance.context).id;

			for (const fixture of fixtures) {
				if (fixture.kind === 'nar') {
					instance.context.db
						.insert(schema.pendingUploads)
						.values({
							id: fixture.id,
							cacheId,
							narHash: nixSha256HashSchema.parse(`sha256:${'0'.repeat(52)}`),
							r2Key: fixture.key,
							metadataJson: '{}',
							createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
							expiresAt,
							verdict: 'pending'
						})
						.run();

					continue;
				}

				instance.context.db
					.insert(schema.pendingAttestations)
					.values({
						id: fixture.id,
						cacheId,
						storePathHash: storePathHashSchema.parse('a'.repeat(32)),
						digest: sha256HexDigestSchema.parse('0'.repeat(64)),
						r2Key: fixture.key,
						createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
						expiresAt
					})
					.run();
			}
		});
		vi.setSystemTime(new Date(collectionTime));

		const result = await runGcResult();
		const objects = await Promise.all(
			fixtures.map(async (fixture) => ({
				key: fixture.key,
				present: (await env.BLOBS.head(fixture.key)) !== null
			}))
		);

		expect({
			orphanStagingDeleted: result.orphanStagingDeleted,
			objects
		}).toStrictEqual({
			orphanStagingDeleted: 0,
			objects: fixtures.map((fixture) => ({
				key: fixture.key,
				present: true
			}))
		});
	});

	it('spares an untracked staging object still within the upload grace', async () => {
		const realNow = await realUploadInstant();
		vi.setSystemTime(new Date(realNow + 60_000));

		const orphanKey = 'staging/recent-push/recent.nar.zst';
		await env.BLOBS.put(orphanKey, new Uint8Array([1, 2, 3]));

		const result = await runGcResult();

		expect({
			orphanStagingDeleted: result.orphanStagingDeleted,
			orphanPresent: (await env.BLOBS.head(orphanKey)) !== null
		}).toStrictEqual({ orphanStagingDeleted: 0, orphanPresent: true });
	});

	it('bounds list pages when every staged object is still young', async () => {
		const realNow = await realUploadInstant();
		vi.setSystemTime(new Date(realNow + 60_000));
		const key = 'staging/recent-push/recent.nar.zst';
		await env.BLOBS.put(key, new Uint8Array([1]));
		const page = await env.BLOBS.list({ prefix: 'staging/' });
		let listCalls = 0;

		const result = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const original = instance.context.env;
				instance.context.env = {
					...original,
					BLOBS: {
						...original.BLOBS,
						head: original.BLOBS.head.bind(original.BLOBS),
						get: original.BLOBS.get.bind(original.BLOBS),
						put: original.BLOBS.put.bind(original.BLOBS),
						delete: original.BLOBS.delete.bind(original.BLOBS),
						list: () => {
							listCalls += 1;

							return Promise.resolve({
								...page,
								truncated: true,
								cursor: String(listCalls)
							});
						},
						createMultipartUpload: original.BLOBS.createMultipartUpload.bind(
							original.BLOBS
						),
						resumeMultipartUpload: original.BLOBS.resumeMultipartUpload.bind(
							original.BLOBS
						)
					}
				};

				try {
					const garbageCollection = (
						instance as unknown as {
							garbageCollection: GarbageCollectionService;
						}
					).garbageCollection;

					return await garbageCollection.collectGarbage(rootLogger(), {
						scope: 'tenant'
					});
				} finally {
					instance.context.env = original;
				}
			}
		);

		expect({
			listCalls,
			deleted: result.orphanStagingDeleted,
			objectPresent: (await env.BLOBS.head(key)) !== null
		}).toStrictEqual({
			listCalls: maxOrphanListPages,
			deleted: 0,
			objectPresent: true
		});
	});

	it('checks one listed key at constant cost as the pending backlog grows', async () => {
		const measured = await runInDurableObject(currentServer(), (instance) => {
			const { db, dbCost } = instance.context;
			const cacheId = resolvedCache(instance.context).id;
			const garbageCollection = (
				instance as unknown as {
					garbageCollection: {
						trackedStagingKeys(keys: readonly string[]): ReadonlySet<string>;
					};
				}
			).garbageCollection;
			const insert = (from: number, to: number): void => {
				for (let index = from; index < to; index += 1) {
					const uploadId = uploadIdSchema.parse(`pending-${String(index)}`);
					const attestationId = uploadIdSchema.parse(
						`attestation-${String(index)}`
					);

					db.insert(schema.pendingUploads)
						.values({
							id: uploadId,
							cacheId,
							narHash: nixSha256HashSchema.parse(`sha256:${'0'.repeat(52)}`),
							r2Key: r2ObjectKeySchema.parse(
								`staging/push/${uploadId}.nar.zst`
							),
							metadataJson: '{}',
							createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
							expiresAt: isoTimestampSchema.parse('2026-01-02T00:00:00.000Z')
						})
						.run();
					db.insert(schema.pendingAttestations)
						.values({
							id: attestationId,
							cacheId,
							storePathHash: storePathHashSchema.parse('a'.repeat(32)),
							digest: sha256HexDigestSchema.parse('0'.repeat(64)),
							r2Key: r2ObjectKeySchema.parse(
								`staging/push/attestations/${attestationId}`
							),
							createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
							expiresAt: isoTimestampSchema.parse('2026-01-02T00:00:00.000Z')
						})
						.run();
				}
			};
			const measure = (): number => {
				dbCost.recordOutstanding();
				const before = dbCost.rowsRead;
				garbageCollection.trackedStagingKeys([
					'staging/push/not-pending.nar.zst',
					'staging/push/attestations/not-pending'
				]);
				dbCost.recordOutstanding();

				return dbCost.rowsRead - before;
			};

			insert(0, 3);
			const smallBacklog = measure();
			insert(3, 503);
			const largeBacklog = measure();

			return { smallBacklog, largeBacklog };
		});

		expect(measured.largeBacklog).toBe(measured.smallBacklog);
	});

	it('caps the reclaim per run and leaves the overflow for the next run', async () => {
		const perRunCap = 1000;
		const total = perRunCap + 1;

		const realNow = await realUploadInstant();
		vi.setSystemTime(new Date(realNow + uploadGraceMs + 5 * 60 * 1000));

		await Promise.all(
			Array.from({ length: total }, (_unused, index) =>
				env.BLOBS.put(
					`staging/flood/${String(index)}.nar.zst`,
					new Uint8Array([1])
				)
			)
		);

		const capture = startCapture();

		let result;
		try {
			result = await runGcResult();
		} finally {
			capture.stop();
		}

		const remaining = await env.BLOBS.list({ prefix: 'staging/flood/' });

		expect({
			orphanStagingDeleted: result.orphanStagingDeleted,
			remaining: remaining.objects.length,
			warnedAboutCap: capture.logs.some(
				(entry) => entry.message === 'orphan staging scan hit the per-run cap'
			)
		}).toStrictEqual({
			orphanStagingDeleted: perRunCap,
			remaining: total - perRunCap,
			warnedAboutCap: true
		});
	});
});
