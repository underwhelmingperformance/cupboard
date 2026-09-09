import {
	narInfoGenerationSchema,
	rootNameSchema,
	type StorePathHash
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { type UploadPathMetadata } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	garbageCollectionFrontier,
	narInfoDeletions,
	retentionRoots,
	retentionRootTargets
} from '../db/schema.ts';
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
	underOneUnitOfWork,
	uploadMetadata,
	useTestServer,
	withoutAlarmArming
} from '../test-support.ts';

import { chunk } from './bulk.ts';
import type { ServerContext } from './context.ts';
import { maxNarInfoDeletionsFlushedPerRun } from './deletion-queue-service.ts';
import { phaseGranule } from './garbage-collection-service.ts';
import { gcContinuationKey } from './server.ts';

const repeated = (character: string): string => character.repeat(32);
const tenantWideContinuation = { scope: 'tenant' };

async function continuation(): Promise<unknown> {
	return runInDurableObject(currentServer(), (_instance, state) =>
		state.storage.get(gcContinuationKey)
	);
}

async function seedNarInfoDeletions(count: number): Promise<void> {
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

async function fireAlarm(): Promise<void> {
	// The test pool does not deliver alarms predictably, so invoke the same handler
	// directly.
	await runInDurableObject(currentServer(), (instance) =>
		underOneUnitOfWork(() => instance.alarm())
	);
}

/**
 * Runs collection passes one unit of work at a time and holds the continuation
 * they arm.
 *
 * The runtime can deliver an alarm it has already queued, and deleting the
 * alarm does not cancel that delivery. Such a delivery would advance the walk
 * under the alarm's own budget rather than the one these tests set, so each
 * driven pass removes the continuation, so a stray delivery finds no work and
 * returns without advancing the walk. `restore` puts the continuation back so
 * the alarms resume the remaining work.
 */
class DrivenCollection {
	private continuation: unknown;

	get isContinuationArmed(): boolean {
		return this.continuation !== undefined;
	}

	reset(): void {
		this.continuation = undefined;
	}

	async collectOneUnitOfWork(): Promise<void> {
		await runInDurableObject(currentServer(), async (instance, state) => {
			await underOneUnitOfWork(() => instance.runGarbageCollection());
			this.continuation = await state.storage.get(gcContinuationKey);
			await state.storage.delete(gcContinuationKey);
			await state.storage.deleteAlarm();
		});
	}

	async restore(): Promise<void> {
		const { continuation } = this;

		await runInDurableObject(currentServer(), async (_instance, state) => {
			if (continuation !== undefined) {
				await state.storage.put(gcContinuationKey, continuation);
			}
		});
	}
}

const driven = new DrivenCollection();

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

// A pass under a one-unit budget advances the walk by one step (seeding roots,
// marking a path, walking a step of its references, or collecting paths) or
// completes one scan phase, and one alarm runs one such pass. These fixtures
// hold at most three paths, so sixteen is slack rather than measured headroom.
// The bound is reached only when the walk has wedged; the assertions after the
// loop then fail, and their output shows the state it reached. To find what
// these runs really take, count the iterations `driveToCompletion` makes.
const maxDrivenPasses = 16;

async function drainContinuation(): Promise<void> {
	await driveToCompletion(
		fireAlarm,
		async () => (await continuation()) === undefined,
		maxDrivenPasses
	);
}

// A root that has already expired, with one target, so the expiry phase has
// exactly one unit of work to do.
async function seedExpiredRoot(target: UploadPathMetadata): Promise<void> {
	const name = rootNameSchema.parse('expired');
	const expiresAt = isoTimestamp(new Date(Date.now() - 1000));

	await runInDurableObject(currentServer(), (instance) => {
		const cache = resolvedCache(instance.context);

		instance.context.db
			.insert(retentionRoots)
			.values({
				cacheId: cache.id,
				name,
				expiresAt,
				createdAt: expiresAt,
				updatedAt: expiresAt
			})
			.run();
		instance.context.db
			.insert(retentionRootTargets)
			.values({
				cacheId: cache.id,
				rootName: name,
				storePathHash: target.storePathHash,
				storePath: target.storePath
			})
			.run();
	});
}

// Queues a path the way a barrier trigger does, without a write that would also
// change what the scan finds.
async function queueFrontier(storePathHash: StorePathHash): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		instance.context.db
			.insert(garbageCollectionFrontier)
			.values({ cacheId: resolvedCache(instance.context).id, storePathHash })
			.onConflictDoNothing()
			.run();
	});
}

async function retentionRootCounts(): Promise<{
	readonly roots: number;
	readonly targets: number;
}> {
	return runInDurableObject(currentServer(), (instance) => ({
		roots: instance.context.db.select().from(retentionRoots).all().length,
		targets: instance.context.db.select().from(retentionRootTargets).all()
			.length
	}));
}

interface ScanProgress {
	readonly phase: string;
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
		.exec<{ phase: string; cursor: string }>(
			`SELECT phase, cursor
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

async function currentScanProgress(): Promise<ScanProgress | undefined> {
	return runInDurableObject(currentServer(), (instance, state) =>
		scanProgress(instance.context, state)
	);
}

// Runs unit-budget passes until the scan reaches the state a test acts on.
async function driveScanTo(
	hasReached: (progress: ScanProgress | undefined) => boolean
): Promise<void> {
	await driveToCompletion(
		() => driven.collectOneUnitOfWork(),
		async () => hasReached(await currentScanProgress()),
		maxDrivenPasses
	);
}

// Where the mark phase has reached in one path's references, with the number of
// paths waiting behind it.
async function referenceWalk(): Promise<unknown> {
	return runInDurableObject(currentServer(), (instance, state) => {
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

		return {
			scan:
				scan === undefined
					? undefined
					: {
							...scan,
							// The column is SQL NULL while no path is being walked.
							markStorePathHash: scan.markStorePathHash ?? undefined
						},
			frontier
		};
	});
}

describe('garbage collection cap', () => {
	beforeEach(async () => {
		driven.reset();
		await resetTestServer();
	});

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

		await driven.collectOneUnitOfWork();
		await driven.restore();

		await drainContinuation();

		expect({
			collectable: await collectableRemaining(),
			continuation: await continuation()
		}).toStrictEqual({ collectable: 0, continuation: undefined });

		expect(await narInfoGeneration(kept.storePathHash)).not.toBeUndefined();
	});

	it('spends one budget across the refresh-family and collection phases', async () => {
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
		await seedExpiredRefreshFamily(phaseGranule + 1);

		const firstPass = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				await underOneUnitOfWork(() => instance.runGarbageCollection());
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
		// The refresh-family phase spends the budget on its first step of members
		// and leaves the rest, so the collection phases that follow advance by a
		// single step: the scan completes the expiry phase, which has no expired
		// root to read, and stops there.
		expect(firstPass).toStrictEqual({
			progress: {
				phase: 'expire-grace',
				cursor: '',
				frontier: 0,
				marks: 0
			},
			refresh: { families: 1, members: 1 },
			continuation: [tenantWideContinuation]
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

	it('expires a root in a pass whose budget was already spent', async () => {
		await useTestServer('gc-spent-budget');
		const { token } = await bootstrap();
		const expiring = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('a'),
			name: 'expiring'
		});

		await pushPath(token, expiring);
		await seedExpiredRoot(expiring);

		const seeded = await retentionRootCounts();

		// The work that precedes collection in this pass spends the budget, so the
		// expiry phase becomes due with nothing left to spend. The pass consults
		// the budget after a step and not before one, so the phase still runs a
		// whole step and expires the root.
		await driven.collectOneUnitOfWork();

		expect({ seeded, expired: await retentionRootCounts() }).toStrictEqual({
			seeded: { roots: 1, targets: 1 },
			expired: { roots: 0, targets: 0 }
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

		// Drive to the unit that marks the root's own path. The walk continues from
		// there: the next unit reads the path's one reference and queues it, and the
		// unit after that marks the reference.
		await driveScanTo(
			(scan) =>
				scan?.phase === 'mark' && scan.marks === 1 && scan.frontier === 0
		);
		const seeded = await currentScanProgress();

		await driven.collectOneUnitOfWork();
		const parentMarked = await currentScanProgress();

		await driven.collectOneUnitOfWork();
		const closureMarked = await currentScanProgress();
		const progress = { seeded, parentMarked, closureMarked };

		expect(progress).toStrictEqual({
			seeded: {
				phase: 'mark',
				cursor: '',
				frontier: 0,
				marks: 1
			},
			parentMarked: {
				phase: 'mark',
				cursor: '',
				frontier: 1,
				marks: 1
			},
			closureMarked: {
				phase: 'mark',
				cursor: '',
				frontier: 0,
				marks: 2
			}
		});

		await driven.restore();

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

	// The barrier queues a path when a write makes it reachable, and the mark may
	// not hold its closure yet. A collect phase that deleted with a queued path
	// waiting would delete that closure, so it returns to marking first.
	it('returns to marking when a path is queued during the collect phase', async () => {
		await useTestServer('gc-collect-requeue');
		const { token } = await bootstrap();
		const child = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('c'),
			name: 'child',
			references: []
		});
		const parent = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('b'),
			name: 'parent',
			references: [StorePath.basename(child.storePath)]
		});
		const rooted = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('a'),
			name: 'rooted',
			references: []
		});

		await pushPath(token, child);
		await pushPath(token, parent);
		await pushPath(token, rooted);
		await setRoot(token, { name: 'channel', targets: [rooted.storePath] });

		const generations = async (): Promise<
			Record<string, number | undefined>
		> => ({
			rooted: await narInfoGeneration(rooted.storePathHash),
			parent: await narInfoGeneration(parent.storePathHash),
			child: await narInfoGeneration(child.storePathHash)
		});
		const pushed = await generations();

		// Park the continuation with the scan about to collect, so the queued path
		// arrives after the mark phase finished and before anything is deleted.
		await driveScanTo((scan) => scan?.phase === 'collect');
		const collecting = await currentScanProgress();

		await queueFrontier(parent.storePathHash);

		// The next unit finds the queued path and goes back to marking, keeping the
		// mark it already made.
		await driven.collectOneUnitOfWork();
		const requeued = await currentScanProgress();

		await driven.restore();
		await drainContinuation();

		expect({
			collecting,
			requeued,
			scan: await currentScanProgress(),
			continuation: await continuation(),
			stored: await generations()
		}).toStrictEqual({
			collecting: {
				phase: 'collect',
				cursor: '',
				frontier: 0,
				marks: 1
			},
			requeued: {
				phase: 'mark',
				cursor: '',
				frontier: 1,
				marks: 1
			},
			scan: undefined,
			continuation: undefined,
			stored: pushed
		});
	});

	// A target attached while the scan is marking is queued by the barrier, so the
	// scan keeps the marks it has and walks the new target from where it stopped.
	it('continues an in-progress walk and marks a target attached between chunks', async () => {
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

		await driveScanTo((scan) => scan?.phase === 'mark' && scan.marks === 1);
		const initial = await currentScanProgress();

		expect(driven.isContinuationArmed).toBe(true);

		await setRoot(token, {
			name: 'channel',
			targets: [kept.storePath, newlyRetained.storePath]
		});

		// The write rewrites both targets of the root, so the barrier queues both
		// the marked path and the new one. Observe the scan once the queue holds
		// them.
		await driveScanTo((scan) => scan?.frontier === 2);
		const attached = await currentScanProgress();

		expect(driven.isContinuationArmed).toBe(true);

		expect({ initial, attached }).toStrictEqual({
			initial: {
				phase: 'mark',
				cursor: '',
				frontier: 0,
				marks: 1
			},
			attached: {
				phase: 'mark',
				cursor: '',
				frontier: 2,
				marks: 1
			}
		});

		await driven.restore();

		await drainContinuation();

		expect({
			continuation: await continuation(),
			scan: await currentScanProgress(),
			kept: await narInfoGeneration(kept.storePathHash),
			newlyRetained: await narInfoGeneration(newlyRetained.storePathHash)
		}).toStrictEqual({
			continuation: undefined,
			scan: undefined,
			kept: 0,
			newlyRetained: 0
		});
	});

	// A commit between two invocations used to bump a revision the next invocation
	// compared, which discarded the mark. A cache taking one commit per invocation
	// therefore never reached its collect phase and its unreachable paths grew
	// without bound.
	it('reaches the collect phase while commits land between invocations', async () => {
		await useTestServer('gc-sustained-commits');
		const { token } = await bootstrap();
		const kept = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('a'),
			name: 'kept',
			references: []
		});
		const collectable = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('b'),
			name: 'collectable',
			references: []
		});

		await pushPath(token, kept);
		await pushPath(token, collectable);
		await setRoot(token, { name: 'channel', targets: [kept.storePath] });

		let committed = 0;
		const hasCollectablePath = async (): Promise<boolean> =>
			(await narInfoGeneration(collectable.storePathHash)) !== undefined;

		// Commit one path after every invocation. Each commit is an insert into
		// `narinfo` for a path no mark holds, which the barrier does not queue, so
		// the scan keeps its marks and advances.
		await withoutAlarmArming(() =>
			driveToCompletion(
				async () => {
					await driven.collectOneUnitOfWork();
					await pushPath(
						token,
						uploadMetadata({
							fileSize: narBytes.byteLength,
							storePathHash: syntheticStorePathHash(committed),
							name: `committed-${String(committed)}`,
							references: []
						})
					);
					committed += 1;
				},
				async () => !(await hasCollectablePath()),
				maxDrivenPasses
			)
		);

		expect({
			collectable: await narInfoGeneration(collectable.storePathHash),
			kept: await narInfoGeneration(kept.storePathHash)
		}).toStrictEqual({ collectable: undefined, kept: 0 });
	});

	it('pages one high-fanout path across bounded mark chunks', async () => {
		await useTestServer('gc-bounded-references');
		const { token } = await bootstrap();
		const references = Array.from(
			{ length: phaseGranule + 5 },
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

		// Drive to the unit that marks the path itself, which leaves the walk about
		// to read its references. The path holds more of them than one step walks,
		// so the step records how far it reached and the next resumes from there.
		await driveScanTo(
			(scan) =>
				scan?.phase === 'mark' && scan.marks === 1 && scan.frontier === 0
		);

		await driven.collectOneUnitOfWork();
		const firstStep = await referenceWalk();

		await driven.collectOneUnitOfWork();
		const secondStep = await referenceWalk();

		expect({ firstStep, secondStep }).toStrictEqual({
			firstStep: {
				scan: {
					phase: 'mark',
					markStorePathHash: parent.storePathHash,
					referenceCursor: phaseGranule - 1
				},
				frontier: phaseGranule
			},
			// The remaining references fit in one step, so the walk finishes the path
			// and releases its cursor.
			secondStep: {
				scan: {
					phase: 'mark',
					markStorePathHash: undefined,
					referenceCursor: -1
				},
				frontier: phaseGranule + 5
			}
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

					await instance.runGarbageCollection();
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
