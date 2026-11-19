import { isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	currentServer,
	initialise,
	resetTestServer,
	resolvedCache,
	syntheticStorePathHash,
	withoutAlarmArming
} from '../test-support.ts';

import {
	collectionState,
	collectOneUnitOfWork,
	collectTenant,
	driveScanTo,
	futureInstant,
	insertNarInfo,
	insertRoot,
	storePathString
} from './garbage-collection.test-support.ts';

const target = syntheticStorePathHash(1);
const added = syntheticStorePathHash(4);

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

describe('garbage collection build inputs', () => {
	beforeEach(resetTestServer);

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
