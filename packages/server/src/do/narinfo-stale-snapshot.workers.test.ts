import {
	DEFAULT_CACHE,
	narInfoGenerationSchema
} from '@cupboard/nix-store/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { narInfoObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	clearBlobStorage,
	commitPath,
	currentServer,
	initialise,
	resetTestServer,
	uploadMetadata,
	verifiableNar
} from '../test-support.ts';

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
				return service.committedReferenceEdges(DEFAULT_CACHE, [
					metadata.storePathHash
				]);
			}
		);

		// Advance the row and edge without the normal commit pipeline, which would
		// also republish the narinfo object.
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.update(schema.narInfos)
				.set({ generation: narInfoGenerationSchema.parse(1) })
				.where(
					and(
						eq(schema.narInfos.cache, DEFAULT_CACHE),
						eq(schema.narInfos.storePathHash, metadata.storePathHash)
					)
				)
				.run();

			instance.context.db
				.update(schema.generationSeq)
				.set({ nextGeneration: narInfoGenerationSchema.parse(2) })
				.where(
					and(
						eq(schema.generationSeq.cache, DEFAULT_CACHE),
						eq(schema.generationSeq.storePathHash, metadata.storePathHash)
					)
				)
				.run();
		});

		await drizzleD1(env.CUPBOARD_DB, {
			schema: { blobReference: d1Schema.blobReference }
		})
			.insert(d1Schema.blobReference)
			.values({
				tenant: fixtureTenant,
				cache: DEFAULT_CACHE,
				storePathHash: metadata.storePathHash,
				generation: narInfoGenerationSchema.parse(1),
				narHash: metadata.narHash
			})
			.onConflictDoNothing()
			.run();

		await env.BLOBS.delete(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash)
		);

		const isServableResult = await runInDurableObject(
			currentServer(),
			(instance) => {
				const service = new NarInfoObjectsService(instance.context);
				return service.isServable(
					DEFAULT_CACHE,
					metadata.storePathHash,
					staleSnapshot
				);
			}
		);

		const isObjectPresent =
			(await env.BLOBS.head(
				narInfoObjectKey(fixtureTenant, metadata.storePathHash)
			)) !== null;

		expect({ isServableResult, isObjectPresent }).toStrictEqual({
			isServableResult: true,
			isObjectPresent: true
		});
	});
});
