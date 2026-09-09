import { narInfoGenerationSchema } from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeEach, describe, expect, it } from 'vitest';

import { narInfoDeletions, narInfos } from '../db/schema.ts';
import { narInfoObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	blobReferenceRows,
	bootstrap,
	clearBlobStorage,
	currentNarObjectKey,
	currentServer,
	defaultCache,
	driveToCompletion,
	fetchNarInfo,
	narBytes,
	narInfoDeletionRows,
	narInfoGeneration,
	pushPath,
	resetTestServer,
	resolvedCache,
	setRoot,
	syntheticNarHash,
	syntheticStorePathHash,
	uploadMetadata,
	verifiableNar,
	withoutAlarmArming
} from '../test-support.ts';

import { chunk } from './bulk.ts';
import { maxNarInfoDeletionsFlushedPerRun } from './deletion-queue-service.ts';

const repeated = (character: string): string => character.repeat(32);

// One collection pass, with its alarm taken away so the test decides when the
// next one runs.
async function collectOnce(): Promise<void> {
	await runInDurableObject(currentServer(), async (instance, state) => {
		await instance.runGarbageCollection();
		await state.storage.deleteAlarm();
	});
}

// Queued deletions for paths this cache never held. Every synthetic hash begins
// with zeroes, so they sort before a path named by a letter and one flush page
// is spent on them.
//
// That ordering is a condition of the test, not an incidental detail: it is what
// leaves the collected path's entry for a later pass. A flush ordered by age
// instead would not fail this test. It would retire that entry in the first
// pass, so the recommit would have nothing to race and the test would exercise
// nothing.
async function seedQueuedDeletions(count: number): Promise<void> {
	const createdAt = isoTimestamp(new Date());

	await runInDurableObject(currentServer(), (instance, state) => {
		const cache = resolvedCache(instance.context);
		const rows = Array.from({ length: count }, (_unused, index) => ({
			cacheId: cache.id,
			storePathHash: syntheticStorePathHash(index),
			narHash: syntheticNarHash(index),
			generation: narInfoGenerationSchema.parse(1),
			createdAt
		}));
		const database = drizzle(state.storage, { schema: { narInfoDeletions } });

		// Each row binds five parameters, so the insert is chunked under the
		// driver's bound-parameter limit.
		for (const batch of chunk(rows, 18)) {
			database.insert(narInfoDeletions).values(batch).run();
		}
	});
}

interface GateEntry {
	readonly storedPaths: number;
	readonly queuedDeletions: number;
}

describe('garbage collection critical section', () => {
	beforeEach(async () => {
		await resetTestServer();
		await clearBlobStorage();
	});

	// The scan is synchronous, so the input gate never decided whether a write
	// could interleave with it; only the awaited narinfo-deletion flush needs the
	// gate. Each entry reports what the pass had already done, which is how the
	// test tells that the scan ran before the gate rather than inside it.
	it('enters the critical section once, for the narinfo-deletion flush', async () => {
		const { token } = await bootstrap();
		const kept = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('a'),
			name: 'kept'
		});
		const collectable = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('b'),
			name: 'collectable'
		});

		await pushPath(token, kept);
		await pushPath(token, collectable);
		await setRoot(token, { name: 'channel', targets: [kept.storePath] });

		const entries = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const { context } = instance;
				const enterSection = context.criticalSection.bind(context);
				const observed: GateEntry[] = [];

				context.criticalSection = async <T>(
					run: () => Promise<T>
				): Promise<T> => {
					observed.push({
						storedPaths: context.db.select().from(narInfos).all().length,
						queuedDeletions: context.db.select().from(narInfoDeletions).all()
							.length
					});

					return enterSection(run);
				};

				try {
					await instance.runGarbageCollection();
				} finally {
					context.criticalSection = enterSection;
				}

				await state.storage.deleteAlarm();

				return observed;
			}
		);

		// One path was collected before the gate was entered, and its deletion was
		// waiting in the queue the flush drains.
		expect(entries).toStrictEqual([{ storedPaths: 1, queuedDeletions: 1 }]);
	});

	// A collect step queues the deletion of the path it removed, and a queue
	// longer than one flush leaves that entry for a later pass. A commit that
	// lands in between writes a new generation, and the queued entry still names
	// the old one, which is what keeps the flush from deleting what the recommit
	// wrote. Moving the scan out of the critical section widened the window in
	// which such a commit can arrive.
	it('leaves a recommitted path servable when its queued deletion retires', async () => {
		const { token } = await bootstrap();
		const nar = await verifiableNar('collect-then-recommit');
		const rooted = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('a'),
			name: 'rooted'
		});
		const recommitted = uploadMetadata({
			storePathHash: repeated('b'),
			name: 'recommitted',
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		await pushPath(token, rooted);
		await pushPath(token, recommitted, defaultCache(), nar);
		await setRoot(token, { name: 'channel', targets: [rooted.storePath] });
		await seedQueuedDeletions(maxNarInfoDeletionsFlushedPerRun);

		await withoutAlarmArming(async () => {
			await collectOnce();

			// The pass collected the unrooted path and queued its generation, and
			// the flush spent its page on the seeded entries. Without this the rest
			// of the test would prove nothing: there would be no queued deletion for
			// the recommit to race.
			const queuedAfterCollect = await narInfoDeletionRows();

			expect({
				stored: await narInfoGeneration(recommitted.storePathHash),
				queued: queuedAfterCollect.filter(
					(entry) => entry.storePathHash === recommitted.storePathHash
				)
			}).toStrictEqual({
				stored: undefined,
				queued: [
					{
						cache: defaultCache(),
						storePathHash: recommitted.storePathHash,
						narHash: nar.narHash,
						generation: 0
					}
				]
			});

			// The path comes back at a new generation and is rooted, so only the
			// stale queue entry can remove it now. Its NAR is still in R2, so this
			// commit reuses the blob rather than uploading again.
			await pushPath(token, recommitted, defaultCache(), nar);
			await setRoot(token, {
				name: 'channel',
				targets: [rooted.storePath, recommitted.storePath]
			});

			await driveToCompletion(
				collectOnce,
				async () => {
					const queued = await narInfoDeletionRows();

					return queued.length === 0;
				},
				4
			);
		});

		const narInfo = await fetchNarInfo(recommitted.storePathHash);
		const edges = await blobReferenceRows();

		const recommittedNarInfoKey = narInfoObjectKey(
			fixtureTenant,
			recommitted.storePathHash,
			defaultCache()
		);

		expect({
			queued: await narInfoDeletionRows(),
			generation: await narInfoGeneration(recommitted.storePathHash),
			servedStorePath: narInfo.storePath.value,
			narInfoObject: (await env.BLOBS.head(recommittedNarInfoKey)) !== null,
			blob:
				(await env.BLOBS.head(await currentNarObjectKey(nar.narHash))) !== null,
			edges: edges.filter(
				(edge) => edge.storePathHash === recommitted.storePathHash
			)
		}).toStrictEqual({
			queued: [],
			generation: 1,
			servedStorePath: recommitted.storePath,
			narInfoObject: true,
			blob: true,
			edges: [
				{
					tenant: 'v1',
					cache: defaultCache(),
					storePathHash: recommitted.storePathHash,
					generation: 1,
					narHash: nar.narHash,
					cacheGeneration: 1
				}
			]
		});
	});
});
