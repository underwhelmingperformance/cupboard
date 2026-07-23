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

// The committed-edges snapshot that `servableTargets` reads from D1 before
// entering the heal gate can become stale when a concurrent commit advances a
// row's generation between the snapshot read and the `isServable` call. Inside
// the gate, `rowStillCommitted` sees the fresh row at gen N+1 against a snapshot
// that only holds the gen-N edge, finds no match, and can leave the narinfo
// object unmaterialised (or delete it) when it should heal or keep it.
describe('isServable with a stale committed-edges snapshot', () => {
	beforeEach(async () => {
		await resetTestServer();
		await clearBlobStorage();
	});

	it('heals a narinfo object when the committed-edges snapshot predates a concurrent recommit', async () => {
		const token = await initialise();
		const nar = await verifiableNar('stale-snapshot-nar');

		const metadata = uploadMetadata({
			storePathHash: 'f'.repeat(32),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		// Commit the path at generation 0.
		await commitPath(token, metadata, nar);

		// Capture the committed-edges snapshot while the row is at generation 0.
		// This is the snapshot that `servableTargets` would have read.
		const staleSnapshot = await runInDurableObject(
			currentServer(),
			(instance) => {
				const service = new NarInfoObjectsService(instance.context);
				return service.committedReferenceEdges(DEFAULT_CACHE, [
					metadata.storePathHash
				]);
			}
		);

		// Simulate a concurrent recommit advancing the row to generation 1, the
		// state a commit arriving between the snapshot read and the isServable call
		// would leave. The DO row's generation is bumped and a generation-1 edge is
		// written to D1 directly, without going through the full commit pipeline.
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

		// Drop the narinfo object so `materialiseIfRecoverable` must re-create it.
		await env.BLOBS.delete(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash)
		);

		// `isServable` with the stale gen-0 snapshot: the row is now at gen 1, so
		// `rowStillCommitted` finds no match in the snapshot and must confirm with
		// a fresh D1 read before it may treat the row as uncommitted.
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
