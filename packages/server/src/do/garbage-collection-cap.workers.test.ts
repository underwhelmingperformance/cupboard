import { narInfoGenerationSchema } from '@cupboard/nix-store/scalars';
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
	resolvedCache,
	setRoot,
	syntheticNarHash,
	syntheticStorePathHash,
	uploadMetadata,
	useTestServer
} from '../test-support.ts';

import { chunk } from './bulk.ts';
import type { ServerContext } from './context.ts';
import { maxNarInfoDeletionsFlushedPerRun } from './deletion-queue-service.ts';
import {
	maxPathsCollectedPerRun,
	maxRefreshTokenMembersDeletedPerRun
} from './garbage-collection-service.ts';
import { gcContinuationKey } from './server.ts';

const repeated = (character: string): string => character.repeat(32);
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

	await runInDurableObject(currentServer(), (instance, state) => {
		const cacheId = resolvedCache(instance.context).id;
		const rows = Array.from({ length: count }, (_unused, index) => ({
			cacheId,
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

async function fireAlarm(): Promise<void> {
	// The test pool does not deliver alarms predictably, so invoke the same handler
	// directly.
	await runInDurableObject(currentServer(), (instance) => instance.alarm());
}

async function seedExpiredRefreshFamily(memberCount: number): Promise<void> {
	await runInDurableObject(currentServer(), (_instance, state) => {
		const activeGeneration = memberCount - 1;
		state.storage.sql.exec(
			"INSERT INTO refresh_token_family (id, active_member_id, generation, rule_id, subject, grants_json, created_at, expires_at) VALUES ('expired-family', 'expired-active', ?, 'admin-rule', 'alice', ?, '2019-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')",
			activeGeneration,
			JSON.stringify([{ type: 'cupboard_wildcard' }])
		);
		state.storage.sql.exec(
			`WITH digits(digit) AS (VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)),
			 generations(value) AS (
			   SELECT ones.digit + tens.digit * 10 + hundreds.digit * 100 + thousands.digit * 1000
			   FROM digits AS ones
			   CROSS JOIN digits AS tens
			   CROSS JOIN digits AS hundreds
			   CROSS JOIN digits AS thousands
			 )
			 INSERT INTO refresh_token_member (id, family_id, generation, secret_hash, created_at)
			 SELECT CASE WHEN value = ? THEN 'expired-active' ELSE printf('expired-spent-%d', value) END,
			        'expired-family', value, lower(hex(randomblob(32))), '2019-01-01T00:00:00.000Z'
			 FROM generations
			 WHERE value < ?`,
			activeGeneration,
			memberCount
		);
	});
}

async function refreshFamilyCounts(): Promise<{
	readonly families: number;
	readonly members: number;
}> {
	return runInDurableObject(currentServer(), (_instance, state) => ({
		families:
			state.storage.sql
				.exec<{ count: number }>(
					'SELECT count(*) AS count FROM refresh_token_family'
				)
				.toArray()[0]?.count ?? 0,
		members:
			state.storage.sql
				.exec<{ count: number }>(
					'SELECT count(*) AS count FROM refresh_token_member'
				)
				.toArray()[0]?.count ?? 0
	}));
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

function scanProgress(
	context: ServerContext,
	state: DurableObjectState
): ScanProgress | undefined {
	const cache = resolvedCache(context);
	const scan = state.storage.sql
		.exec<{ phase: string; revision: number; cursor: string }>(
			`SELECT phase, revision, cursor
			 FROM garbage_collection_scan
			 WHERE cache_id = ?`,
			cache.id
		)
		.toArray()[0];

	if (scan === undefined) {
		return undefined;
	}

	const count = (table: string): number =>
		state.storage.sql
			.exec<{ count: number }>(
				`SELECT count(*) AS count FROM ${table} WHERE cache_id = ?`,
				cache.id
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

		await currentServer().runGarbageCollection(1);

		await drainContinuation();

		expect({
			collectable: await collectableRemaining(),
			continuation: await continuation()
		}).toStrictEqual({ collectable: 0, continuation: undefined });

		expect(await narInfoGeneration(kept.storePathHash)).not.toBeUndefined();
	});

	it('advances refresh-family and path collection in the same bounded pass', async () => {
		await useTestServer('gc-refresh-and-path-cap');
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
		await seedExpiredRefreshFamily(maxRefreshTokenMembersDeletedPerRun + 1);

		const firstPass = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				await instance.runGarbageCollection(1);
				const progress = scanProgress(instance.context, state);
				const refresh = {
					families:
						state.storage.sql
							.exec<{ count: number }>(
								'SELECT count(*) AS count FROM refresh_token_family'
							)
							.toArray()[0]?.count ?? 0,
					members:
						state.storage.sql
							.exec<{ count: number }>(
								'SELECT count(*) AS count FROM refresh_token_member'
							)
							.toArray()[0]?.count ?? 0
				};
				const pending = await state.storage.get(gcContinuationKey);
				await state.storage.deleteAlarm();

				return { progress, refresh, continuation: pending };
			}
		);
		const revision = firstPass.progress?.revision;

		expect(typeof revision).toBe('number');
		expect(firstPass).toStrictEqual({
			progress: {
				phase: 'mark',
				revision,
				cursor: '',
				frontier: 0,
				marks: 1
			},
			refresh: { families: 1, members: 1 },
			continuation: [{ scope: 'tenant', collectLimit: 1 }]
		});

		await drainContinuation();
		const keptGeneration = await narInfoGeneration(kept.storePathHash);

		expect(typeof keptGeneration).toBe('number');

		expect({
			collectable: await narInfoGeneration(collectable.storePathHash),
			kept: keptGeneration,
			refresh: await refreshFamilyCounts(),
			continuation: await continuation()
		}).toStrictEqual({
			collectable: undefined,
			kept: keptGeneration,
			refresh: { families: 0, members: 0 },
			continuation: undefined
		});
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
				const seeded = scanProgress(instance.context, state);
				await state.storage.deleteAlarm();

				await instance.alarm();
				const parentMarked = scanProgress(instance.context, state);
				await state.storage.deleteAlarm();

				await instance.alarm();
				const closureMarked = scanProgress(instance.context, state);
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
				const progress = scanProgress(instance.context, state);
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
				const progress = scanProgress(instance.context, state);
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
				const cache = resolvedCache(instance.context);
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
						 WHERE cache_id = ?`,
						cache.id
					)
					.toArray()[0];
				const frontier = state.storage.sql
					.exec<{ count: number }>(
						`SELECT count(*) AS count
						 FROM garbage_collection_frontier
						 WHERE cache_id = ?`,
						cache.id
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
					const cache = resolvedCache(instance.context);
					state.storage.sql.exec(
						'UPDATE narinfo SET references_json = ? WHERE cache_id = ? AND store_path_hash = ?',
						stored,
						cache.id,
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

		// Read the backlog in the same Durable Object turn as collection so the alarm
		// cannot drain it first. With no committed paths, only the capped deletion
		// flush can arm this continuation.
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
