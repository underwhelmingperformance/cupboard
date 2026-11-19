import { isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	currentServer,
	defaultCache,
	initialise,
	resetTestServer,
	resolvedCache,
	syntheticStorePathHash,
	withoutAlarmArming
} from '../test-support.ts';

import { type ServerContext } from './context.ts';
import {
	collectionState,
	collectOneUnitOfWork,
	collectTenant,
	driveScanTo,
	futureInstant,
	insertNarInfo,
	insertRoot,
	storePathBasename,
	storePathString
} from './garbage-collection.test-support.ts';

const target = syntheticStorePathHash(1);
const input = syntheticStorePathHash(2);
const inputReference = syntheticStorePathHash(3);
const added = syntheticStorePathHash(4);
const unrelated = syntheticStorePathHash(5);

const recordBuildInputs =
	'UPDATE narinfo SET build_inputs_json = ? WHERE cache_id = ? AND store_path_hash = ?';
const gracePeriodUpdate =
	'UPDATE cache_identity SET grace_seconds = ? WHERE id = ?';

const selectQueued =
	'SELECT store_path_hash FROM garbage_collection_frontier WHERE store_path_hash = ?';
const selectScans = 'SELECT cache_id FROM garbage_collection_scan';
const insertGrace =
	'INSERT INTO retention_grace (cache_id, store_path_hash, retain_until) VALUES (?, ?, ?)';
const insertRootTarget =
	"INSERT INTO retention_root_target (cache_id, root_name, store_path_hash, store_path) VALUES (?, 'channel', ?, ?)";
const selectNarInfoPaths =
	'SELECT store_path_hash AS hash FROM narinfo ORDER BY store_path_hash';

async function defaultCacheState(): Promise<unknown> {
	return runInDurableObject(currentServer(), (instance) =>
		collectionState(instance.context)
	);
}

// A build input that refers to another path at run time, and a path that
// nothing refers to.
function insertInputs(context: ServerContext): void {
	insertNarInfo(context, input, 2, defaultCache(), {
		references: [inputReference]
	});
	insertNarInfo(context, inputReference, 3);
	insertNarInfo(context, unrelated, 5);
}

describe('garbage collection build inputs', () => {
	beforeEach(resetTestServer);

	it.each([
		{
			edge: 'a build edge',
			buildInputs: [input],
			narInfos: [target, input, inputReference]
		},
		{ edge: 'no build edge', buildInputs: undefined, narInfos: [target] }
	])(
		'keeps the build inputs of a root target with $edge',
		async ({ buildInputs, narInfos }) =>
			withoutAlarmArming(async () => {
				await initialise();
				await runInDurableObject(currentServer(), (instance) => {
					insertNarInfo(instance.context, target, 1, defaultCache(), {
						buildInputs
					});
					insertRoot(instance.context, { name: 'channel', target });
					insertInputs(instance.context);
				});

				await collectTenant();

				expect(await defaultCacheState()).toStrictEqual({
					narInfos,
					roots: ['channel'],
					inputs: {
						inputsChanged: false,
						scanCompletedAt: isoTimestamp(new Date())
					}
				});
			})
	);

	it('keeps the build inputs of a released target through its grace deadline', async () =>
		withoutAlarmArming(async () => {
			await initialise();
			await runInDurableObject(currentServer(), (instance, state) => {
				state.storage.sql.exec(
					gracePeriodUpdate,
					24 * 60 * 60,
					resolvedCache(instance.context).id
				);
				insertNarInfo(instance.context, target, 1, defaultCache(), {
					buildInputs: [input]
				});
				insertRoot(instance.context, {
					name: 'channel',
					expiresAt: new Date(Date.now() - 60 * 1000).toISOString(),
					target
				});
				insertInputs(instance.context);
			});

			await collectTenant();

			expect(await defaultCacheState()).toStrictEqual({
				narInfos: [target, input, inputReference],
				roots: [],
				inputs: {
					inputsChanged: false,
					scanCompletedAt: isoTimestamp(new Date())
				}
			});
		}));

	it('walks a marked path again when its build inputs are recorded during a scan', async () =>
		withoutAlarmArming(async () => {
			await initialise();
			await runInDurableObject(currentServer(), (instance) => {
				insertNarInfo(instance.context, target, 1);
				insertRoot(instance.context, { name: 'channel', target });
				insertInputs(instance.context);
			});

			await driveScanTo(collectOneUnitOfWork, 'collect');
			await runInDurableObject(currentServer(), (instance, state) => {
				state.storage.sql.exec(
					recordBuildInputs,
					JSON.stringify([storePathBasename(input)]),
					resolvedCache(instance.context).id,
					target
				);
			});
			await driveScanTo(collectOneUnitOfWork, undefined);

			expect(await defaultCacheState()).toStrictEqual({
				narInfos: [target, input, inputReference],
				roots: ['channel'],
				inputs: {
					inputsChanged: false,
					scanCompletedAt: isoTimestamp(new Date())
				}
			});
		}));

	it('keeps a path inserted during a scan and leaves it to the next scan', async () =>
		withoutAlarmArming(async () => {
			await initialise();
			await runInDurableObject(currentServer(), (instance) => {
				insertNarInfo(instance.context, target, 1);
				insertRoot(instance.context, { name: 'channel', target });
			});

			await driveScanTo(collectOneUnitOfWork, 'collect');
			await runInDurableObject(currentServer(), (instance) => {
				insertNarInfo(instance.context, added, 4);
			});
			await driveScanTo(collectOneUnitOfWork, undefined);
			const scanned = await defaultCacheState();

			await collectTenant();

			const scannedAt = isoTimestamp(new Date());

			expect({ scanned, rescanned: await defaultCacheState() }).toStrictEqual({
				scanned: {
					narInfos: [target, added],
					roots: ['channel'],
					inputs: { inputsChanged: true, scanCompletedAt: scannedAt }
				},
				rescanned: {
					narInfos: [target],
					roots: ['channel'],
					inputs: { inputsChanged: false, scanCompletedAt: scannedAt }
				}
			});
		}));

	// A narinfo row is queued only while a path can already have been walked.
	// A root target or grace row is queued from the seed phases on, because
	// the seed phase that reads its table can already have passed its page.
	// One written in an expire phase is not queued, and the seed phases read
	// it. The `clear` phase deletes the frontier after collection, so nothing is
	// queued there. The `narinfo` cases insert the path during the phase. The
	// seed cases insert an unretained narinfo row before the scan and the seed
	// row during the phase.
	it.each([
		{ phase: 'roots', write: 'narinfo', isQueued: false, narInfos: [target] },
		{ phase: 'grace', write: 'narinfo', isQueued: false, narInfos: [target] },
		{
			phase: 'mark',
			write: 'narinfo',
			isQueued: true,
			narInfos: [target, added]
		},
		{
			phase: 'collect',
			write: 'narinfo',
			isQueued: true,
			narInfos: [target, added]
		},
		{
			phase: 'clear',
			write: 'narinfo',
			isQueued: false,
			narInfos: [target, added]
		},
		{
			phase: 'expire-grace',
			write: 'grace',
			isQueued: false,
			narInfos: [target, added]
		},
		{
			phase: 'roots',
			write: 'root target',
			isQueued: true,
			narInfos: [target, added]
		},
		{
			phase: 'grace',
			write: 'grace',
			isQueued: true,
			narInfos: [target, added]
		},
		{ phase: 'clear', write: 'grace', isQueued: false, narInfos: [target] },
		{
			phase: 'clear',
			write: 'root target',
			isQueued: false,
			narInfos: [target]
		}
	])(
		'queues a $write row inserted during the $phase phase: $isQueued',
		async ({ phase, write, isQueued, narInfos }) =>
			withoutAlarmArming(async () => {
				await initialise();
				await runInDurableObject(currentServer(), (instance) => {
					insertNarInfo(instance.context, target, 1);
					insertRoot(instance.context, { name: 'channel', target });

					if (write !== 'narinfo') {
						insertNarInfo(instance.context, added, 4);
					}
				});

				await driveScanTo(collectOneUnitOfWork, phase);
				const wasQueued = await runInDurableObject(
					currentServer(),
					(instance, state) => {
						const cacheId = resolvedCache(instance.context).id;

						switch (write) {
							case 'narinfo': {
								insertNarInfo(instance.context, added, 4);
								break;
							}
							case 'grace': {
								state.storage.sql.exec(
									insertGrace,
									cacheId,
									added,
									futureInstant
								);
								break;
							}
							case 'root target': {
								state.storage.sql.exec(
									insertRootTarget,
									cacheId,
									added,
									storePathString(added)
								);
								break;
							}
						}

						return (
							state.storage.sql.exec(selectQueued, added).toArray().length > 0
						);
					}
				);
				await driveScanTo(collectOneUnitOfWork, undefined);

				const stored = await runInDurableObject(
					currentServer(),
					(_instance, state) => ({
						scans: state.storage.sql.exec(selectScans).toArray().length,
						narInfos: Array.from(
							state.storage.sql.exec<{ hash: string }>(selectNarInfoPaths),
							(row) => row.hash
						)
					})
				);

				expect({ isQueued: wasQueued, ...stored }).toStrictEqual({
					isQueued,
					scans: 0,
					narInfos
				});
			})
	);
});
