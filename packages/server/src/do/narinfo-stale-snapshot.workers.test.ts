import { narInfoGenerationSchema } from '@cupboard/nix-store/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it } from 'vitest';

import { cacheIdentityCondition } from '../db/cache.ts';
import * as schema from '../db/schema.ts';
import { internalOrigin, narInfoObjectKey } from '../http/http.ts';
import { cacheMigrationColumns } from '../migration/cache-access.ts';
import * as migrationSchema from '../migration/cache-access-schema.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	clearBlobStorage,
	commitPath,
	currentServer,
	defaultCache,
	initialise,
	resetTestServer,
	resolvedCache,
	uploadMetadata,
	verifiableNar
} from '../test-support.ts';

import { AttestationCasService } from './attestation-cas-service.ts';
import { AttestationsService } from './attestations-service.ts';
import { DeletionQueueService } from './deletion-queue-service.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';

// A D1 edge snapshot can predate a recommit. If the snapshot does not contain
// the current generation, servability must read D1 again before deleting the
// narinfo object or declining to repair it.
describe('servability after a committed-edge snapshot becomes stale', () => {
	beforeEach(async () => {
		await resetTestServer();
		await clearBlobStorage();
	});

	it('heals a missing narinfo object after a recommit makes the edge snapshot stale', async () => {
		const token = await initialise();
		const nar = await verifiableNar('stale-snapshot-nar');

		const metadata = uploadMetadata({
			storePathHash: 'f'.repeat(32),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		await commitPath(token, metadata, nar);

		const staleSnapshot = await runInDurableObject(
			currentServer(),
			(instance) => {
				const service = new NarInfoObjectsService(instance.context);
				return service.committedReferenceEdges(
					resolvedCache(instance.context),
					[metadata.storePathHash]
				);
			}
		);

		// Advance the row and edge without the normal commit pipeline, which would
		// also republish the narinfo object.
		await runInDurableObject(currentServer(), (instance) => {
			const cache = resolvedCache(instance.context);

			instance.context.db
				.update(schema.narInfos)
				.set({ generation: narInfoGenerationSchema.parse(1) })
				.where(
					and(
						eq(schema.narInfos.cacheId, cache.id),
						eq(schema.narInfos.storePathHash, metadata.storePathHash)
					)
				)
				.run();

			instance.context.db
				.update(schema.generationSeq)
				.set({ nextGeneration: narInfoGenerationSchema.parse(2) })
				.where(
					and(
						cacheIdentityCondition(
							schema.generationSeq.cacheKind,
							schema.generationSeq.cacheName,
							cache.scope
						),
						eq(schema.generationSeq.storePathHash, metadata.storePathHash)
					)
				)
				.run();
		});

		await drizzleD1(env.CUPBOARD_DB, {
			schema: { blobReferences: migrationSchema.blobReferences }
		})
			.insert(migrationSchema.blobReferences)
			.values({
				tenant: fixtureTenant,
				...cacheMigrationColumns(defaultCache(), 'public'),
				storePathHash: metadata.storePathHash,
				generation: narInfoGenerationSchema.parse(1),
				narHash: metadata.narHash
			})
			.onConflictDoNothing()
			.run();

		await env.BLOBS.delete(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash, {
				kind: 'default'
			})
		);

		const isServableResult = await runInDurableObject(
			currentServer(),
			(instance) => {
				const service = new NarInfoObjectsService(instance.context);
				return service.isServable(
					resolvedCache(instance.context),
					metadata.storePathHash,
					staleSnapshot
				);
			}
		);

		const isObjectPresent =
			(await env.BLOBS.head(
				narInfoObjectKey(fixtureTenant, metadata.storePathHash, {
					kind: 'default'
				})
			)) !== null;

		expect({ isServableResult, isObjectPresent }).toStrictEqual({
			isServableResult: true,
			isObjectPresent: true
		});
	});

	it('does not reconcile a replacement from an older row snapshot', async () => {
		const token = await initialise();
		const nar = await verifiableNar('stale-reconcile-snapshot');
		const metadata = uploadMetadata({
			storePathHash: 'd'.repeat(32),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		await commitPath(token, metadata, nar);

		const remaining = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const captured = instance.context.db
					.select()
					.from(schema.narInfos)
					.where(eq(schema.narInfos.storePathHash, metadata.storePathHash))
					.get();

				if (captured === undefined) {
					throw new Error('expected committed narinfo');
				}

				instance.context.db
					.update(schema.narInfos)
					.set({ generation: narInfoGenerationSchema.parse(1) })
					.where(eq(schema.narInfos.storePathHash, metadata.storePathHash))
					.run();

				const narInfoObjects = new NarInfoObjectsService(instance.context);
				const attestationCas = new AttestationCasService(instance.context);
				const attestations = new AttestationsService(
					instance.context,
					attestationCas,
					narInfoObjects
				);
				const deletionQueue = new DeletionQueueService(
					instance.context,
					attestationCas,
					attestations,
					narInfoObjects
				);

				await deletionQueue.removeStaleNarInfo(captured, internalOrigin);

				return instance.context.db
					.select({ generation: schema.narInfos.generation })
					.from(schema.narInfos)
					.where(eq(schema.narInfos.storePathHash, metadata.storePathHash))
					.get();
			}
		);

		expect(remaining).toStrictEqual({
			generation: narInfoGenerationSchema.parse(1)
		});
	});
});
