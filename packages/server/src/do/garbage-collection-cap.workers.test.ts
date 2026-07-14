import { DEFAULT_CACHE } from '@cupboard/nix-store/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { narInfoDeletions } from '../db/schema.ts';
import {
	bootstrap,
	currentServer,
	narBytes,
	narInfoGeneration,
	pushPath,
	resetTestServer,
	setRoot,
	syntheticNarHash,
	syntheticStorePathHash,
	uploadMetadata,
	useTestServer
} from '../test-support.ts';

import { chunk } from './bulk.ts';
import { maxNarInfoDeletionsFlushedPerRun } from './deletion-queue-service.ts';
import { maxPathsSweptPerRun } from './garbage-collection-service.ts';
import { gcContinuationKey } from './server.ts';

const repeated = (character: string): string => character.repeat(32);

async function continuationLimit(): Promise<number | undefined> {
	return runInDurableObject(currentServer(), (_instance, state) =>
		state.storage.get<number>(gcContinuationKey)
	);
}

async function seedNarInfoDeletions(count: number): Promise<void> {
	const createdAt = new Date().toISOString();
	const rows = Array.from({ length: count }, (_unused, index) => ({
		cache: DEFAULT_CACHE,
		storePathHash: syntheticStorePathHash(index),
		narHash: syntheticNarHash(index),
		generation: 1,
		createdAt
	}));

	await runInDurableObject(currentServer(), (_instance, state) => {
		const database = drizzle(state.storage, { schema: { narInfoDeletions } });

		// Each row binds five parameters, so the insert is chunked under the
		// driver's bound-parameter limit.
		for (const batch of chunk(rows, 18)) {
			database.insert(narInfoDeletions).values(batch).run();
		}
	});
}

async function fireAlarm(): Promise<void> {
	// The handler is invoked directly: the continuation relies on the same entry
	// point in production, and the test pool's alarm delivery is racy to observe.
	await runInDurableObject(currentServer(), (instance) => instance.alarm());
}

describe('garbage collection sweep cap', () => {
	beforeEach(resetTestServer);

	it('caps each sweep and drains the remainder across alarm firings', async () => {
		await useTestServer('gc-cap');
		const { token } = await bootstrap();

		const kept = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('a'),
			name: 'kept'
		});
		const first = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('b'),
			name: 'first'
		});
		const second = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('c'),
			name: 'second'
		});

		await pushPath(token, kept);
		await pushPath(token, first);
		await pushPath(token, second);

		// Retaining `kept` makes the other two collectable while keeping the cache
		// off the empty-cache skip guard.
		await setRoot(token, { name: 'channel', targets: [kept.storePath] });

		const collectableRemaining = async (): Promise<number> => {
			const generations = await Promise.all([
				narInfoGeneration(first.storePathHash),
				narInfoGeneration(second.storePathHash)
			]);

			return generations.filter((generation) => generation !== undefined)
				.length;
		};

		expect(await collectableRemaining()).toBe(2);

		// A cap of one path per sweep records a continuation.
		await currentServer().runGarbageCollection(1);

		// The continuation drains the remaining collectable paths a chunk at a time
		// and clears itself, so the bounded sweep still collects everything. The
		// alarm is driven here because the test pool's delivery is racy to observe.
		await vi.waitFor(async () => {
			await fireAlarm();
			expect(await collectableRemaining()).toBe(0);
			expect(await continuationLimit()).toBeUndefined();
		});

		// The retained path is never swept.
		expect(await narInfoGeneration(kept.storePathHash)).not.toBeUndefined();
	});
});

describe('garbage collection narinfo-deletion continuation', () => {
	beforeEach(resetTestServer);

	it('arms the alarm while a narinfo-deletion backlog exceeds the flush cap', async () => {
		const backlog = maxNarInfoDeletionsFlushedPerRun + 5;
		await seedNarInfoDeletions(backlog);

		// The sweep and the storage reads share one Durable Object turn, so the
		// armed continuation alarm cannot fire and drain the backlog before it is
		// observed. No committed paths are swept, so the continuation is armed
		// solely by the queued narinfo-deletion backlog the capped flush leaves.
		const observed = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				await instance.runGarbageCollection();

				const remaining = drizzle(state.storage, {
					schema: { narInfoDeletions }
				})
					.select({ storePathHash: narInfoDeletions.storePathHash })
					.from(narInfoDeletions)
					.all().length;

				const observed = {
					armed: (await state.storage.getAlarm()) !== null,
					continuation: await state.storage.get<number>(gcContinuationKey),
					remaining
				};

				await state.storage.deleteAlarm();

				return observed;
			}
		);

		expect(observed).toStrictEqual({
			armed: true,
			continuation: maxPathsSweptPerRun,
			remaining: backlog - maxNarInfoDeletionsFlushedPerRun
		});
	});
});
