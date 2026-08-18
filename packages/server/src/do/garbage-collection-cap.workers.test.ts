import {
	DEFAULT_CACHE,
	narInfoGenerationSchema,
	type StoredCache
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeEach, describe, expect, it } from 'vitest';

import { narInfoDeletions } from '../db/schema.ts';
import {
	StoredReferencesJsonMalformedError,
	StoredReferencesNotArrayError
} from '../errors.ts';
import {
	bootstrap,
	currentServer,
	driveToCompletion,
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
import { maxPathsCollectedPerRun } from './garbage-collection-service.ts';
import { gcContinuationKey } from './server.ts';

const repeated = (character: string): string => character.repeat(32);
const defaultCache: StoredCache = DEFAULT_CACHE;
const tenantWideContinuation = {
	scope: 'tenant',
	collectLimit: maxPathsCollectedPerRun
};

async function continuation(): Promise<unknown> {
	return runInDurableObject(currentServer(), (_instance, state) =>
		state.storage.get(gcContinuationKey)
	);
}

async function seedNarInfoDeletions(count: number): Promise<void> {
	const createdAt = isoTimestamp(new Date());
	const rows = Array.from({ length: count }, (_unused, index) => ({
		cache: defaultCache,
		storePathHash: syntheticStorePathHash(index),
		narHash: syntheticNarHash(index),
		generation: narInfoGenerationSchema.parse(1),
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

// An alarm with a collect budget of one either advances the walk by one unit
// of work (seeding a root, marking a path, or collecting a path) or completes
// one of the six scan phases. These fixtures hold at most three paths and two
// roots, so a drain needs at most fourteen alarms: two root seedings, three
// markings, three collections, and six phase completions. Sixteen leaves a
// little slack. The bound is reached only when a drain has wedged; the
// assertions after the loop then fail, and their output shows the state the
// drain reached.
const maxDrainAlarms = 16;

async function drainContinuation(): Promise<void> {
	await driveToCompletion(
		fireAlarm,
		async () => (await continuation()) === undefined,
		maxDrainAlarms
	);
}

interface ScanProgress {
	readonly phase: string;
	readonly revision: number;
	readonly cursor: string;
	readonly frontier: number;
	readonly marks: number;
}

function scanProgress(state: DurableObjectState): ScanProgress | undefined {
	const scan = state.storage.sql
		.exec<{ phase: string; revision: number; cursor: string }>(
			`SELECT phase, revision, cursor
			 FROM garbage_collection_scan
			 WHERE cache = ?`,
			DEFAULT_CACHE
		)
		.toArray()[0];

	if (scan === undefined) {
		return undefined;
	}

	const count = (table: string): number =>
		state.storage.sql
			.exec<{ count: number }>(
				`SELECT count(*) AS count FROM ${table} WHERE cache = ?`,
				DEFAULT_CACHE
			)
			.toArray()[0]?.count ?? 0;

	return {
		...scan,
		frontier: count('garbage_collection_frontier'),
		marks: count('garbage_collection_mark')
	};
}

describe('garbage collection cap', () => {
	beforeEach(resetTestServer);

	it('caps each collection and drains the remainder across alarm firings', async () => {
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

		// A cap of one path per collection records a continuation.
		await currentServer().runGarbageCollection(1);

		// The continuation drains the remaining collectable paths a chunk at a time
		// and clears itself, so the capped run still collects everything. The
		// alarm is driven here because the test pool's delivery is racy to observe.
		await drainContinuation();

		expect({
			collectable: await collectableRemaining(),
			continuation: await continuation()
		}).toStrictEqual({ collectable: 0, continuation: undefined });

		// The retained path is never collected.
		expect(await narInfoGeneration(kept.storePathHash)).not.toBeUndefined();
	});

	it('continues a reachability walk instead of rescanning its roots', async () => {
		await useTestServer('gc-bounded-mark');
		const { token } = await bootstrap();
		const child = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('b'),
			name: 'child',
			references: []
		});
		const parent = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('a'),
			name: 'parent',
			references: [StorePath.basename(child.storePath)]
		});
		const collectable = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('c'),
			name: 'collectable',
			references: []
		});

		await pushPath(token, child);
		await pushPath(token, parent);
		await pushPath(token, collectable);
		await setRoot(token, { name: 'channel', targets: [parent.storePath] });

		const progress = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				await instance.runGarbageCollection(1);
				const seeded = scanProgress(state);
				await state.storage.deleteAlarm();

				await instance.alarm();
				const parentMarked = scanProgress(state);
				await state.storage.deleteAlarm();

				await instance.alarm();
				const closureMarked = scanProgress(state);
				await state.storage.deleteAlarm();

				return { seeded, parentMarked, closureMarked };
			}
		);
		const revision = progress.seeded?.revision;

		expect(typeof revision).toBe('number');

		expect(progress).toStrictEqual({
			seeded: {
				phase: 'mark',
				revision,
				cursor: '',
				frontier: 0,
				marks: 1
			},
			parentMarked: {
				phase: 'mark',
				revision: progress.seeded?.revision,
				cursor: '',
				frontier: 1,
				marks: 1
			},
			closureMarked: {
				phase: 'mark',
				revision: progress.seeded?.revision,
				cursor: '',
				frontier: 0,
				marks: 2
			}
		});

		await drainContinuation();

		expect(await continuation()).toBeUndefined();

		const generations = {
			parent: await narInfoGeneration(parent.storePathHash),
			child: await narInfoGeneration(child.storePathHash),
			collectable: await narInfoGeneration(collectable.storePathHash)
		};

		expect(typeof generations.parent).toBe('number');
		expect(typeof generations.child).toBe('number');
		expect(generations.collectable).toBeUndefined();
	});

	it('restarts an in-progress walk when retention changes between chunks', async () => {
		await useTestServer('gc-bounded-mutation');
		const { token } = await bootstrap();
		const kept = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('a'),
			name: 'kept',
			references: []
		});
		const newlyRetained = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('c'),
			name: 'newly-retained',
			references: []
		});

		await pushPath(token, kept);
		await pushPath(token, newlyRetained);
		await setRoot(token, { name: 'channel', targets: [kept.storePath] });

		// Deleting the alarm does not stop an already-due delivery: the runtime
		// can still run the handler afterwards, and a delivery that finds the
		// continuation advances the walk mid-test. Parking the continuation
		// alongside each alarm deletion makes such a delivery a no-op, so the
		// walk only moves when this test drives it.
		let parked: unknown;

		const initial = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				await instance.runGarbageCollection(1);
				const progress = scanProgress(state);
				parked = await state.storage.get(gcContinuationKey);
				await state.storage.delete(gcContinuationKey);
				await state.storage.deleteAlarm();

				return progress;
			}
		);

		expect(parked).not.toBeUndefined();

		await setRoot(token, {
			name: 'channel',
			targets: [kept.storePath, newlyRetained.storePath]
		});

		const restarted = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				if (parked !== undefined) {
					await state.storage.put(gcContinuationKey, parked);
				}

				await instance.alarm();
				const progress = scanProgress(state);
				parked = await state.storage.get(gcContinuationKey);
				await state.storage.delete(gcContinuationKey);
				await state.storage.deleteAlarm();

				return progress;
			}
		);

		expect(parked).not.toBeUndefined();
		const initialRevision = initial?.revision;
		const restartedRevision = restarted?.revision;

		expect(typeof initialRevision).toBe('number');
		expect(typeof restartedRevision).toBe('number');

		expect({ initial, restarted }).toStrictEqual({
			initial: {
				phase: 'mark',
				revision: initialRevision,
				cursor: '',
				frontier: 0,
				marks: 1
			},
			restarted: {
				phase: 'roots',
				revision: restartedRevision,
				cursor: kept.storePathHash,
				frontier: 1,
				marks: 0
			}
		});
		expect(restartedRevision).toBeGreaterThan(initialRevision ?? 0);

		await runInDurableObject(currentServer(), async (_instance, state) => {
			if (parked !== undefined) {
				await state.storage.put(gcContinuationKey, parked);
			}
		});

		await drainContinuation();

		expect(await continuation()).toBeUndefined();
		expect(await narInfoGeneration(newlyRetained.storePathHash)).toEqual(
			expect.any(Number)
		);
	});

	it('pages one high-fanout path across bounded mark chunks', async () => {
		await useTestServer('gc-bounded-references');
		const { token } = await bootstrap();
		const references = Array.from(
			{ length: 25 },
			(_unused, index) => `${syntheticStorePathHash(index)}-reference`
		);
		const parent = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('a'),
			name: 'parent',
			references
		});

		await pushPath(token, parent);
		await setRoot(token, { name: 'channel', targets: [parent.storePath] });

		const progress = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				await instance.runGarbageCollection(5);
				const scan = state.storage.sql
					.exec<{
						phase: string;
						markStorePathHash: string | null;
						referenceCursor: number;
					}>(
						`SELECT phase,
						        mark_store_path_hash AS markStorePathHash,
						        reference_cursor AS referenceCursor
						 FROM garbage_collection_scan
						 WHERE cache = ?`,
						DEFAULT_CACHE
					)
					.toArray()[0];
				const frontier = state.storage.sql
					.exec<{ count: number }>(
						`SELECT count(*) AS count
						 FROM garbage_collection_frontier
						 WHERE cache = ?`,
						DEFAULT_CACHE
					)
					.toArray()[0]?.count;

				await state.storage.deleteAlarm();

				return { scan, frontier };
			}
		);

		expect(progress).toStrictEqual({
			scan: {
				phase: 'mark',
				markStorePathHash: parent.storePathHash,
				referenceCursor: 3
			},
			frontier: 4
		});
	});

	it.each([
		{
			kind: 'malformed JSON',
			server: 'gc-invalid-json',
			stored: '{',
			error: StoredReferencesJsonMalformedError
		},
		{
			kind: 'a non-array container',
			server: 'gc-invalid-container',
			stored: JSON.stringify({ reference: `${repeated('b')}-child` }),
			error: StoredReferencesNotArrayError
		}
	])(
		'reports $kind as invalid stored references',
		async ({ server, stored, error: ErrorClass }) => {
			await useTestServer(server);
			const { token } = await bootstrap();
			const parent = uploadMetadata({
				fileSize: narBytes.byteLength,
				storePathHash: repeated('a'),
				name: 'parent',
				references: []
			});

			await pushPath(token, parent);
			await setRoot(token, { name: 'channel', targets: [parent.storePath] });

			await expect(
				runInDurableObject(currentServer(), async (instance, state) => {
					state.storage.sql.exec(
						'UPDATE narinfo SET references_json = ? WHERE cache = ? AND store_path_hash = ?',
						stored,
						DEFAULT_CACHE,
						parent.storePathHash
					);

					await instance.runGarbageCollection(10);
				})
			).rejects.toStrictEqual(new ErrorClass(parent.storePathHash));
		}
	);
});

describe('garbage collection narinfo-deletion continuation', () => {
	beforeEach(resetTestServer);

	it('arms the alarm while a narinfo-deletion backlog exceeds the flush cap', async () => {
		const backlog = maxNarInfoDeletionsFlushedPerRun + 5;
		await seedNarInfoDeletions(backlog);

		// The collection and the storage reads share one Durable Object turn, so the
		// armed continuation alarm cannot fire and drain the backlog before it is
		// observed. No committed paths are collected, so the continuation is armed
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
					continuation: await state.storage.get(gcContinuationKey),
					remaining
				};

				await state.storage.deleteAlarm();

				return observed;
			}
		);

		expect(observed).toStrictEqual({
			armed: true,
			continuation: [tenantWideContinuation],
			remaining: backlog - maxNarInfoDeletionsFlushedPerRun
		});
	});
});
