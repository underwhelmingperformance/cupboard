import { startCapture } from '@cupboard/logger/testing';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
	currentServer,
	driveToCompletion,
	initialise,
	namedCache,
	putTestCache,
	resetTestServer,
	resolvedCache,
	syntheticNarHash,
	syntheticStorePathHash,
	testBase,
	withoutAlarmArming
} from '../test-support.ts';

import { gcDeferralWakeKey } from './deletion-queue-service.ts';
import {
	futureInstant,
	inputState,
	insertNarInfo,
	pastInstant,
	useMinScanInterval
} from './garbage-collection.test-support.ts';
import { gcContinuationKey, maintenancePassCursorKey } from './server.ts';

const methodLineSchema = z.object({
	method: z.string(),
	rowsRead: z.number(),
	rowsWritten: z.number()
});

// Each live cache contains a chain of paths, each referencing the next two, and
// an island of paths that only grace deadlines keep.
const chainLength = 300;
const islandLength = 50;
const pathsPerCache = chainLength + islandLength;
const verdicts = [
	undefined,
	'pending',
	'committing',
	'servable',
	'mismatch',
	'over-quota'
] as const;
const uploadsPerVerdict = 5;
const maxPasses = 16;

const insertNarInfoRow =
	'INSERT INTO narinfo (cache_id, store_path_hash, store_path, nar_hash, nar_size, references_json, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)';
const insertExpiringRootRow =
	'INSERT INTO retention_root (cache_id, name, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)';
const insertPermanentRootRow =
	'INSERT INTO retention_root (cache_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)';
const insertTargetRow =
	'INSERT INTO retention_root_target (cache_id, root_name, store_path_hash, store_path) VALUES (?, ?, ?, ?)';
const insertGraceRow =
	'INSERT INTO retention_grace (cache_id, store_path_hash, retain_until) VALUES (?, ?, ?)';
const insertUploadRow =
	'INSERT INTO pending_upload (id, cache_id, nar_hash, r2_key, metadata_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)';
const uploadVerdictUpdate =
	'UPDATE pending_upload SET verdict = ? WHERE id = ?';
const insertDeletedCacheRow =
	"INSERT INTO cache_identity (kind, name, access, priority, generation, created_at, deleted_at) VALUES ('named', ?, 'public', 40, 1, ?, ?)";
const selectLiveCaches =
	'SELECT id FROM cache_identity WHERE deleted_at IS NULL ORDER BY id';
const expireSettledUploads =
	"UPDATE pending_upload SET expires_at = ? WHERE verdict = 'servable'";
const countUploads = 'SELECT count(*) AS count FROM pending_upload';
const insertDeletedCacheRows = `WITH RECURSIVE sequence(n) AS (SELECT ?1 UNION ALL SELECT n + 1 FROM sequence WHERE n < ?2)
	INSERT INTO cache_identity (kind, name, access, priority, generation, created_at, deleted_at)
	SELECT 'named', printf('gone-%d', n), 'public', 40, 1, ?3, ?3 FROM sequence`;
const reopenGraceProjection =
	'UPDATE cache_listing_projection_migration SET grace_complete = 0 WHERE id = 1';
const insertFutureGraceRows = `WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 2000)
	INSERT INTO retention_grace (cache_id, store_path_hash, retain_until)
	SELECT ?1, printf('f%031d', n), ?2 FROM sequence`;
const insertPassedGraceRows = `WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 100000)
	INSERT INTO retention_grace (cache_id, store_path_hash, retain_until)
	SELECT ?1, printf('p%031d', n), ?2 FROM sequence`;
const clearInputFlag =
	'UPDATE garbage_collection_input SET inputs_changed = 0 WHERE cache_id = ?';
const selectNarInfo =
	'SELECT store_path_hash FROM narinfo WHERE cache_id = ? AND store_path_hash = ?';

interface PassCost {
	readonly invocations: number;
	readonly rowsRead: number;
	readonly rowsWritten: number;
}

const noCost: PassCost = { invocations: 0, rowsRead: 0, rowsWritten: 0 };

// Adds one invocation and the rows of its `garbage-collection` cost lines.
async function withInvocationCost(
	total: PassCost,
	run: () => Promise<unknown>
): Promise<PassCost> {
	const capture = startCapture();

	try {
		await run();
	} finally {
		capture.stop();
	}

	const lines = capture.logs
		.filter((entry) => entry.message === 'method finished')
		.map((entry) => methodLineSchema.parse(entry.properties))
		.filter((line) => line.method === 'garbage-collection');

	return {
		invocations: total.invocations + 1,
		rowsRead:
			total.rowsRead + lines.reduce((sum, line) => sum + line.rowsRead, 0),
		rowsWritten:
			total.rowsWritten + lines.reduce((sum, line) => sum + line.rowsWritten, 0)
	};
}

async function hasContinuation(): Promise<boolean> {
	return runInDurableObject(
		currentServer(),
		async (_instance, state) =>
			(await state.storage.get(gcContinuationKey)) !== undefined
	);
}

// Runs cron passes until the tenant-wide collection finishes, and adds up the
// rows of every pass.
async function cronSweepCost(): Promise<PassCost> {
	let total = noCost;
	const pass = async () => {
		total = await withInvocationCost(total, () =>
			currentServer().runGarbageCollection()
		);
	};

	await pass();
	await driveToCompletion(
		pass,
		async () => !(await hasContinuation()),
		maxPasses
	);

	return total;
}

// Four live caches, two deleted cache identities, and pending uploads in every
// verdict. Every path is kept: half the roots expire in 2099 and half are
// permanent, and the grace deadlines are in 2099.
async function seedRealisticTenant(): Promise<void> {
	const token = await initialise();

	for (const name of ['alpha', 'beta', 'gamma']) {
		await putTestCache(token, namedCache(name));
	}

	await runInDurableObject(currentServer(), (_instance, state) => {
		const { sql } = state.storage;
		const caches = Array.from(
			sql.exec<{ id: number }>(selectLiveCaches),
			(row) => row.id
		);

		for (const [cacheIndex, cacheId] of caches.entries()) {
			const offset = cacheIndex * pathsPerCache;
			const hash = (index: number) => syntheticStorePathHash(offset + index);
			const basename = (index: number) => `${hash(index)}-p${String(index)}`;

			for (let index = 0; index < pathsPerCache; index += 1) {
				const end = index < chainLength ? chainLength : pathsPerCache;
				const references = [index + 1, index + 2]
					.filter((reference) => reference < end)
					.map((reference) => basename(reference));

				sql.exec(
					insertNarInfoRow,
					cacheId,
					hash(index),
					`/nix/store/${basename(index)}`,
					syntheticNarHash(offset + index),
					JSON.stringify(references),
					pastInstant
				);
			}

			for (let root = 0; root < 10; root += 1) {
				const name = `root-${String(root)}`;

				if (root < 5) {
					sql.exec(
						insertExpiringRootRow,
						cacheId,
						name,
						futureInstant,
						pastInstant,
						pastInstant
					);
				} else {
					sql.exec(
						insertPermanentRootRow,
						cacheId,
						name,
						pastInstant,
						pastInstant
					);
				}

				for (let target = 0; target < 3; target += 1) {
					const index = (root * 3 + target) * 7;

					sql.exec(
						insertTargetRow,
						cacheId,
						name,
						hash(index),
						`/nix/store/${basename(index)}`
					);
				}
			}

			for (let index = chainLength; index < pathsPerCache; index += 1) {
				sql.exec(insertGraceRow, cacheId, hash(index), futureInstant);
			}

			for (const [position, verdict] of verdicts.entries()) {
				for (let row = 0; row < uploadsPerVerdict; row += 1) {
					const id = `upload-${String(cacheId)}-${String(position)}-${String(row)}`;
					const isInFlight = verdict === 'pending' || verdict === 'committing';

					sql.exec(
						insertUploadRow,
						id,
						cacheId,
						syntheticNarHash(90_000 + row),
						`staging/fixture/${id}`,
						JSON.stringify({ storePathHash: hash(row) }),
						pastInstant,
						isInFlight ? pastInstant : futureInstant
					);

					if (verdict !== undefined) {
						sql.exec(uploadVerdictUpdate, verdict, id);
					}
				}
			}
		}

		for (const name of ['old-1', 'old-2']) {
			sql.exec(insertDeletedCacheRow, name, pastInstant, pastInstant);
		}
	});
}

async function uploadCount(): Promise<number> {
	return runInDurableObject(
		currentServer(),
		(_instance, state) =>
			state.storage.sql.exec<{ count: number }>(countUploads).one().count
	);
}

// The cost of collection passes on a tenant whose caches have all been
// scanned once.
describe('garbage collection cost', () => {
	beforeEach(resetTestServer);

	it('skips every unchanged cache in one invocation', async () =>
		withoutAlarmArming(async () => {
			await seedRealisticTenant();
			await cronSweepCost();

			expect(await cronSweepCost()).toStrictEqual({
				invocations: 1,
				rowsRead: 283,
				rowsWritten: 5
			});
		}));

	it('skips a cache with many future grace deadlines before the listing projection is complete', async () =>
		withoutAlarmArming(async () => {
			await seedRealisticTenant();
			await runInDurableObject(currentServer(), (_instance, state) => {
				state.storage.sql.exec(reopenGraceProjection);
			});
			await cronSweepCost();
			const fewDeadlines = await cronSweepCost();

			await runInDurableObject(currentServer(), (instance, state) => {
				const cacheId = resolvedCache(instance.context, namedCache('alpha')).id;

				state.storage.sql.exec(insertFutureGraceRows, cacheId, futureInstant);
				state.storage.sql.exec(clearInputFlag, cacheId);
			});
			const manyDeadlines = await cronSweepCost();

			expect({ fewDeadlines, manyDeadlines }).toStrictEqual({
				fewDeadlines: { invocations: 1, rowsRead: 287, rowsWritten: 5 },
				manyDeadlines: { invocations: 1, rowsRead: 287, rowsWritten: 5 }
			});
		}));

	it('bounds the grace read before the listing projection is complete when another cache has many passed deadlines', async () =>
		withoutAlarmArming(async () => {
			await seedRealisticTenant();
			await runInDurableObject(currentServer(), (_instance, state) => {
				state.storage.sql.exec(reopenGraceProjection);
			});
			await cronSweepCost();
			await useMinScanInterval(6 * 60 * 60);
			await runInDurableObject(currentServer(), (instance, state) => {
				const cacheId = resolvedCache(instance.context, namedCache('alpha')).id;

				state.storage.sql.exec(insertPassedGraceRows, cacheId, pastInstant);
				state.storage.sql.exec(clearInputFlag, cacheId);
			});

			expect(await cronSweepCost()).toStrictEqual({
				invocations: 1,
				rowsRead: 539,
				rowsWritten: 5
			});
		}));

	it('skips deleted caches with nothing left to collect at constant cost', async () =>
		withoutAlarmArming(async () => {
			await seedRealisticTenant();
			await runInDurableObject(currentServer(), (_instance, state) => {
				state.storage.sql.exec(insertDeletedCacheRows, 1, 2, pastInstant);
			});
			await cronSweepCost();
			const fourDeleted = await cronSweepCost();

			await runInDurableObject(currentServer(), (_instance, state) => {
				state.storage.sql.exec(insertDeletedCacheRows, 3, 198, pastInstant);
			});
			await cronSweepCost();
			const twoHundredDeleted = await cronSweepCost();

			expect({ fourDeleted, twoHundredDeleted }).toStrictEqual({
				fourDeleted: { invocations: 1, rowsRead: 283, rowsWritten: 5 },
				twoHundredDeleted: { invocations: 1, rowsRead: 283, rowsWritten: 5 }
			});
		}));

	it('skips a cache that waits for its interval without scanning it', async () =>
		withoutAlarmArming(async () => {
			await seedRealisticTenant();
			await cronSweepCost();
			await useMinScanInterval(6 * 60 * 60);
			const idle = await cronSweepCost();

			await runInDurableObject(currentServer(), (instance) => {
				insertNarInfo(
					instance.context,
					syntheticStorePathHash(10_000),
					10_000,
					namedCache('alpha')
				);
			});

			expect({ idle, waiting: await cronSweepCost() }).toStrictEqual({
				idle: { invocations: 1, rowsRead: 283, rowsWritten: 5 },
				waiting: { invocations: 1, rowsRead: 281, rowsWritten: 5 }
			});
		}));

	it('deletes expired uploads without a scan on a cron wake', async () =>
		withoutAlarmArming(async () => {
			await seedRealisticTenant();
			await cronSweepCost();
			const before = await uploadCount();

			await runInDurableObject(currentServer(), (_instance, state) => {
				state.storage.sql.exec(expireSettledUploads, pastInstant);
			});

			expect({
				cost: await cronSweepCost(),
				deleted: before - (await uploadCount())
			}).toStrictEqual({
				cost: { invocations: 1, rowsRead: 401, rowsWritten: 25 },
				deleted: 4 * uploadsPerVerdict
			});
		}));

	it('deletes expired uploads without a scan on a deferral wake', async () =>
		withoutAlarmArming(async () => {
			await seedRealisticTenant();
			await cronSweepCost();
			const before = await uploadCount();

			await runInDurableObject(currentServer(), async (_instance, state) => {
				state.storage.sql.exec(expireSettledUploads, pastInstant);
				await state.storage.put(gcDeferralWakeKey, Date.now() - 1);
				await state.storage.delete(maintenancePassCursorKey);
			});
			const cost = await withInvocationCost(noCost, () =>
				runInDurableObject(currentServer(), (instance) => instance.alarm())
			);

			expect({
				cost,
				deleted: before - (await uploadCount()),
				continuation: await hasContinuation()
			}).toStrictEqual({
				cost: { invocations: 1, rowsRead: 148, rowsWritten: 20 },
				deleted: 4 * uploadsPerVerdict,
				continuation: false
			});
		}));

	// The scan of the changed cache ends its invocation, and the next one
	// skips the remaining caches.
	it('scans only the cache that changed', async () =>
		withoutAlarmArming(async () => {
			const added = syntheticStorePathHash(10_000);
			const firstSweepAt = isoTimestamp(testBase);
			const secondSweepAt = new Date(testBase.getTime() + 60 * 60 * 1000);

			await seedRealisticTenant();
			await cronSweepCost();

			await runInDurableObject(currentServer(), (instance) => {
				insertNarInfo(instance.context, added, 10_000, namedCache('alpha'));
			});
			vi.setSystemTime(secondSweepAt);
			const cost = await cronSweepCost();
			const caches = await runInDurableObject(
				currentServer(),
				(instance, state) => ({
					isAddedPathKept:
						state.storage.sql
							.exec(
								selectNarInfo,
								resolvedCache(instance.context, namedCache('alpha')).id,
								added
							)
							.toArray().length > 0,
					completions: Object.fromEntries(
						['alpha', 'beta', 'gamma'].map((name) => [
							name,
							inputState(instance.context, namedCache(name))
						])
					)
				})
			);
			const unchanged = { inputsChanged: false, scanCompletedAt: firstSweepAt };

			expect({ cost, caches }).toStrictEqual({
				cost: { invocations: 2, rowsRead: 9232, rowsWritten: 2836 },
				caches: {
					isAddedPathKept: false,
					completions: {
						alpha: {
							inputsChanged: false,
							scanCompletedAt: isoTimestamp(secondSweepAt)
						},
						beta: unchanged,
						gamma: unchanged
					}
				}
			});
		}));
});
