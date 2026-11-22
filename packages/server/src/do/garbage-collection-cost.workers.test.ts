import { startCapture } from '@cupboard/logger/testing';
import { type StorePathHash } from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
	currentServer,
	defaultCache,
	driveToCompletion,
	initialise,
	namedCache,
	putTestCache,
	resetTestServer,
	resolvedCache,
	syntheticNarHash,
	syntheticStorePathHash,
	testBase,
	underOneUnitOfWork,
	withoutAlarmArming
} from '../test-support.ts';

import { gcDeferralWakeKey } from './deletion-queue-service.ts';
import {
	futureInstant,
	inputState,
	insertNarInfo,
	insertRoot,
	pastInstant,
	storePathBasename,
	useMinScanInterval
} from './garbage-collection.test-support.ts';
import { phaseStepSize } from './garbage-collection-service.ts';
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
const recordBuildInputs =
	'UPDATE narinfo SET build_inputs_json = ? WHERE cache_id = ? AND store_path_hash = ?';
const selectWalkPosition =
	'SELECT mark_store_path_hash AS markStorePathHash, reference_cursor AS referenceCursor FROM garbage_collection_scan WHERE cache_id = ?';
const markInputsChanged =
	'UPDATE garbage_collection_input SET inputs_changed = 1 WHERE cache_id = ?';

interface PassCost {
	readonly invocations: number;
	readonly rowsRead: number;
	readonly rowsWritten: number;
}

const noCost: PassCost = { invocations: 0, rowsRead: 0, rowsWritten: 0 };

function basenameList(paths: readonly StorePathHash[]): string {
	return JSON.stringify(paths.map((path) => storePathBasename(path)));
}

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

interface WalkStepCost {
	readonly referenceCursor: number;
	readonly rowsRead: number;
	readonly rowsWritten: number;
}

// Enough one-step passes for a scan of one path with five steps of edges.
const maxUnitPasses = 32;

// The path that the default cache's scan is walking and its reference cursor,
// or undefined when the cache has no scan.
async function walkPosition(): Promise<
	| {
			readonly markStorePathHash: string | null;
			readonly referenceCursor: number;
	  }
	| undefined
> {
	return runInDurableObject(currentServer(), (instance, state) =>
		state.storage.sql
			.exec<{ markStorePathHash: string | null; referenceCursor: number }>(
				selectWalkPosition,
				resolvedCache(instance.context).id
			)
			.toArray()
			.at(0)
	);
}

async function hasContinuation(): Promise<boolean> {
	return runInDurableObject(
		currentServer(),
		async (_instance, state) =>
			(await state.storage.get(gcContinuationKey)) !== undefined
	);
}

// Runs one collection pass under a one-row budget and drops the continuation
// that it arms, so the next step runs only when the test calls for it.
async function oneUnitPass(): Promise<void> {
	await runInDurableObject(currentServer(), async (instance, state) => {
		await underOneUnitOfWork(() => instance.runGarbageCollection());
		await state.storage.delete(gcContinuationKey);
		await state.storage.deleteAlarm();
	});
}

// The phase of the default cache's scan, or undefined when it has no scan.
async function scanPhase(): Promise<string | undefined> {
	const selectScanPhase =
		'SELECT phase FROM garbage_collection_scan WHERE cache_id = ?';

	return runInDurableObject(
		currentServer(),
		(instance, state) =>
			state.storage.sql
				.exec<{
					phase: string;
				}>(selectScanPhase, resolvedCache(instance.context).id)
				.toArray()
				.at(0)?.phase
	);
}

// The root target fixture of the seed tests: one root, `channel`, with more
// targets than two seed pages.
const seedCount = 2 * phaseStepSize + 10;
const seedBase = 50_000;
const selectNarInfoPaths =
	'SELECT store_path_hash AS hash FROM narinfo ORDER BY store_path_hash';

// Gives `channel` its targets. Only the first target, which sorts first, can
// have a narinfo row.
async function insertChannelTargets(isFirstPresent: boolean): Promise<void> {
	const insertChannelTargetRow =
		"INSERT INTO retention_root_target (cache_id, root_name, store_path_hash, store_path) VALUES (?, 'channel', ?, ?)";

	await runInDurableObject(currentServer(), (instance, state) => {
		const cacheId = resolvedCache(instance.context).id;
		const first = syntheticStorePathHash(seedBase);

		insertRoot(instance.context, { name: 'channel', target: first });

		if (isFirstPresent) {
			insertNarInfo(instance.context, first, seedBase);
		}

		for (let index = 1; index < seedCount; index += 1) {
			const target = syntheticStorePathHash(seedBase + index);

			state.storage.sql.exec(
				insertChannelTargetRow,
				cacheId,
				target,
				`/nix/store/${target}-app`
			);
		}
	});
}

interface ScanStepCost {
	readonly before: string | undefined;
	readonly after: string | undefined;
	readonly rowsRead: number;
	readonly rowsWritten: number;
}

// Runs one-step passes until the scan ends. Records the steps of the `roots`
// phase, the step that ends the mark phase, and the last step that marks a
// path.
async function recordSeedAndGuardSteps(): Promise<{
	readonly steps: readonly ScanStepCost[];
	readonly lastMarkStep: ScanStepCost | undefined;
}> {
	const steps: ScanStepCost[] = [];
	let lastMarkStep: ScanStepCost | undefined;
	const pass = async (): Promise<void> => {
		const before = await scanPhase();
		const cost = await withInvocationCost(noCost, oneUnitPass);
		const after = await scanPhase();
		const step = {
			before,
			after,
			rowsRead: cost.rowsRead,
			rowsWritten: cost.rowsWritten
		};

		if (before === 'mark' && after === 'mark') {
			lastMarkStep = step;
			return;
		}

		if (before === 'roots' || before === 'mark') {
			steps.push(step);
		}
	};

	await pass();
	await driveToCompletion(
		pass,
		async () => (await scanPhase()) === undefined,
		seedCount + maxPasses
	);

	return { steps, lastMarkStep };
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
				rowsRead: 317,
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
				fewDeadlines: { invocations: 1, rowsRead: 321, rowsWritten: 5 },
				manyDeadlines: { invocations: 1, rowsRead: 321, rowsWritten: 5 }
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
				rowsRead: 573,
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
				fourDeleted: { invocations: 1, rowsRead: 317, rowsWritten: 5 },
				twoHundredDeleted: { invocations: 1, rowsRead: 317, rowsWritten: 5 }
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
				idle: { invocations: 1, rowsRead: 317, rowsWritten: 5 },
				waiting: { invocations: 1, rowsRead: 315, rowsWritten: 5 }
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
				cost: { invocations: 1, rowsRead: 435, rowsWritten: 25 },
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
				cost: { invocations: 1, rowsRead: 150, rowsWritten: 20 },
				deleted: 4 * uploadsPerVerdict,
				continuation: false
			});
		}));

	// A root target and four other paths list the same absent build inputs. A
	// scan reads the cache's narinfo rows to find that the inputs are absent,
	// and writes nothing for them. Each path's build inputs fit in one mark
	// step, so the scan row's cursor is written as often in both scans.
	it('writes no rows for build inputs that the cache does not have', async () =>
		withoutAlarmArming(async () => {
			const target = syntheticStorePathHash(20_000);
			const present = [1, 2, 3, 4].map((index) =>
				syntheticStorePathHash(20_000 + index)
			);
			const absent = Array.from(
				{ length: phaseStepSize - present.length },
				(_unused, index) => syntheticStorePathHash(30_000 + index)
			);

			await initialise();
			await runInDurableObject(currentServer(), (instance) => {
				insertNarInfo(instance.context, target, 20_000, defaultCache(), {
					buildInputs: present
				});
				insertRoot(instance.context, { name: 'channel', target });

				for (const [index, path] of present.entries()) {
					insertNarInfo(instance.context, path, 20_001 + index);
				}
			});
			await cronSweepCost();

			const scanWithAbsentInputs = async (
				absentInputs: readonly StorePathHash[]
			): Promise<PassCost> => {
				await runInDurableObject(currentServer(), (instance, state) => {
					const cacheId = resolvedCache(instance.context).id;

					state.storage.sql.exec(
						recordBuildInputs,
						basenameList([...present, ...absentInputs]),
						cacheId,
						target
					);

					for (const path of present) {
						state.storage.sql.exec(
							recordBuildInputs,
							basenameList(absentInputs),
							cacheId,
							path
						);
					}

					state.storage.sql.exec(markInputsChanged, cacheId);
				});

				return cronSweepCost();
			};
			const presentOnly = await scanWithAbsentInputs([]);
			const withAbsent = await scanWithAbsentInputs(absent);

			expect({ presentOnly, withAbsent }).toStrictEqual({
				presentOnly: { invocations: 1, rowsRead: 434, rowsWritten: 54 },
				withAbsent: { invocations: 1, rowsRead: 4158, rowsWritten: 54 }
			});
		}));

	// One path lists five mark steps of absent build inputs, and each pass runs
	// one step. Every full step reads the same number of rows, however long
	// the list is.
	it('reads one step of build inputs in each mark step', async () =>
		withoutAlarmArming(async () => {
			const target = syntheticStorePathHash(40_000);
			const absent = Array.from(
				{ length: 5 * phaseStepSize },
				(_unused, index) => syntheticStorePathHash(41_000 + index)
			);

			await initialise();
			await runInDurableObject(currentServer(), (instance) => {
				insertNarInfo(instance.context, target, 40_000, defaultCache(), {
					buildInputs: absent
				});
				insertRoot(instance.context, { name: 'channel', target });
			});

			const steps: WalkStepCost[] = [];
			const pass = async (): Promise<void> => {
				const before = await walkPosition();
				const cost = await withInvocationCost(noCost, oneUnitPass);

				if (before?.markStorePathHash !== target) {
					return;
				}

				steps.push({
					referenceCursor: before.referenceCursor,
					rowsRead: cost.rowsRead,
					rowsWritten: cost.rowsWritten
				});
			};

			await pass();
			await driveToCompletion(
				pass,
				async () => (await walkPosition()) === undefined,
				maxUnitPasses
			);

			expect(steps).toStrictEqual(
				[-1, 127, 255, 383, 511].map((referenceCursor) => ({
					referenceCursor,
					rowsRead: 1063,
					rowsWritten: 1
				}))
			);
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
				cost: { invocations: 2, rowsRead: 9627, rowsWritten: 2837 },
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

	// Every root target points at a path that the cache does not have, so the
	// empty-cache guard ends the scan without collecting. Each step of the
	// `roots` phase checks one page of seeds for narinfo rows. The step that
	// ends the mark phase reads one row fewer than a step that marks a path,
	// so it reads no seed.
	it('checks the seeds for narinfo rows one page at a time', async () =>
		withoutAlarmArming(async () => {
			await initialise();
			await insertChannelTargets(false);

			const { steps, lastMarkStep } = await recordSeedAndGuardSteps();
			const seedPage = {
				before: 'roots',
				after: 'roots',
				rowsRead: 680,
				rowsWritten: 257
			};

			expect({ steps, lastMarkStep }).toStrictEqual({
				steps: [
					seedPage,
					seedPage,
					{ before: 'roots', after: 'grace', rowsRead: 324, rowsWritten: 21 },
					{ before: 'mark', after: 'clear', rowsRead: 293, rowsWritten: 1 }
				],
				lastMarkStep: {
					before: 'mark',
					after: 'mark',
					rowsRead: 294,
					rowsWritten: 3
				}
			});
		}));

	// The first seed page has a present seed, so the later pages skip the
	// check and read less. The guard confirms the seed, and the scan deletes
	// the path that nothing retains.
	it('stops checking seeds once a page has a present one', async () =>
		withoutAlarmArming(async () => {
			const unretained = syntheticStorePathHash(60_000);

			await initialise();
			await insertChannelTargets(true);
			await runInDurableObject(currentServer(), (instance) => {
				insertNarInfo(instance.context, unretained, 60_000);
			});

			const { steps } = await recordSeedAndGuardSteps();
			const narInfos = await runInDurableObject(
				currentServer(),
				(_instance, state) =>
					Array.from(
						state.storage.sql.exec<{ hash: string }>(selectNarInfoPaths),
						(row) => row.hash
					)
			);

			expect({ steps, narInfos }).toStrictEqual({
				steps: [
					{ before: 'roots', after: 'roots', rowsRead: 681, rowsWritten: 257 },
					{ before: 'roots', after: 'roots', rowsRead: 551, rowsWritten: 257 },
					{ before: 'roots', after: 'grace', rowsRead: 313, rowsWritten: 21 },
					{ before: 'mark', after: 'collect', rowsRead: 294, rowsWritten: 1 }
				],
				narInfos: [syntheticStorePathHash(seedBase)]
			});
		}));
});
