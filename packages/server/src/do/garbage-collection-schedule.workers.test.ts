import { startCapture } from '@cupboard/logger/testing';
import { type CacheScope } from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import {
	GarbageCollectionMarksBeforeSeedError,
	MinScanIntervalInvalidError
} from '../errors.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	authorisedFetch,
	currentServer,
	defaultCache,
	initialise,
	namedCache,
	putTestCache,
	resetTestServer,
	resolvedCache,
	runGcResult,
	setRoot,
	syntheticStorePathHash,
	testBase,
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
	pastInstant,
	storePathString,
	useMinScanInterval
} from './garbage-collection.test-support.ts';
import { MaintenanceEligibilityService } from './maintenance-eligibility-service.ts';

const kept = syntheticStorePathHash(1);
const released = syntheticStorePathHash(2);
const uploaded = syntheticStorePathHash(3);
const sixHours = 6 * 60 * 60;
const closedCache = namedCache('pr-1');
const insertPendingUpload =
	"INSERT INTO pending_upload (id, cache_id, nar_hash, r2_key, metadata_json, created_at, expires_at, verdict) VALUES ('upload', ?, 'sha256:nar', 'staging/fixture/upload', ?, ?, ?, 'pending')";
const otherTargetDeletion =
	"DELETE FROM retention_root_target WHERE cache_id = ? AND root_name = 'other'";
const settleAsMismatch =
	"UPDATE pending_upload SET verdict = 'mismatch' WHERE id = 'upload'";

const otherCache = namedCache('beta');
const insertOldUpload =
	"INSERT INTO pending_upload (id, cache_id, nar_hash, r2_key, metadata_json, created_at, expires_at) VALUES ('old', ?, 'sha256:nar', 'staging/fixture/old', '{}', ?, ?)";
const oldUploadVerdictUpdate =
	"UPDATE pending_upload SET verdict = ? WHERE id = 'old'";
const insertExpiringOldRoot =
	"INSERT INTO retention_root (cache_id, name, retention_epoch, close_applied_epoch, expires_at, created_at, updated_at) VALUES (?1, 'old', ?2, ?3, ?4, ?5, ?5)";
const insertCloseEvent =
	'INSERT INTO cache_close_event (cache_id, epoch, closed_at, grace_until) VALUES (?1, ?2, ?3, ?3)';
const insertHeldUpload =
	"INSERT INTO pending_upload (id, cache_id, retention_epoch, nar_hash, r2_key, metadata_json, created_at, expires_at, verdict) VALUES (?1, ?2, ?3, 'sha256:nar', 'staging/fixture/' || ?1, '{}', ?4, ?5, 'pending')";
const insertGraceExpiryScan =
	"INSERT INTO garbage_collection_scan (cache_id, phase, cursor, reference_cursor, allow_empty_collection) VALUES (?, 'expire-grace', '', -1, 0)";
const insertMark =
	'INSERT INTO garbage_collection_mark (cache_id, store_path_hash) VALUES (?, ?)';
const heldUploadsSettle =
	"UPDATE pending_upload SET verdict = 'servable' WHERE cache_id = ?";
const retentionEpochUpdate =
	'UPDATE cache_identity SET retention_epoch = ? WHERE id = ?';
const markCacheDeleted =
	'UPDATE cache_identity SET deleted_at = ? WHERE id = ?';
const markInputsChanged =
	'UPDATE garbage_collection_input SET inputs_changed = 1 WHERE cache_id = ?';
const clearInputsChanged =
	'UPDATE garbage_collection_input SET inputs_changed = 0 WHERE cache_id = ?';
const selectInputRow =
	'SELECT inputs_changed, scan_completed_at FROM garbage_collection_input WHERE cache_id = ?';
const selectCloseEpochs =
	'SELECT epoch FROM cache_close_event WHERE cache_id = ? ORDER BY epoch';
const reopenGraceProjection =
	'UPDATE cache_listing_projection_migration SET grace_complete = 0 WHERE id = 1';
const backdateCompletion =
	'UPDATE garbage_collection_input SET scan_completed_at = ? WHERE cache_id = ?';

// A pending upload of the first retention epoch, which never expires.
function insertHeldUploadFor(sql: SqlStorage, cacheId: number): void {
	sql.exec(insertHeldUpload, 'held', cacheId, 0, pastInstant, futureInstant);
}

async function closeEpochs(): Promise<number[]> {
	return runInDurableObject(currentServer(), (instance, state) =>
		Array.from(
			state.storage.sql.exec<{ epoch: number }>(
				selectCloseEpochs,
				resolvedCache(instance.context, closedCache).id
			),
			(row) => row.epoch
		)
	);
}

function hoursAfterBase(hours: number): Date {
	return new Date(testBase.getTime() + hours * 60 * 60 * 1000);
}

// A reconciliation replaces the pass's published wake only when it is newer.
const afterThePass = new Date(testBase.getTime() + 1);

function at(hours: number): void {
	vi.setSystemTime(hoursAfterBase(hours));
}

async function stateOf(scope: CacheScope = defaultCache()): Promise<unknown> {
	return runInDurableObject(currentServer(), (instance) =>
		collectionState(instance.context, scope)
	);
}

async function maintenanceWakeAt(): Promise<string | null | undefined> {
	const row = await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
		.select({ nextWakeAt: d1Schema.tenantMaintenanceEligibility.nextWakeAt })
		.from(d1Schema.tenantMaintenanceEligibility)
		.where(eq(d1Schema.tenantMaintenanceEligibility.tenant, fixtureTenant))
		.get();

	return row?.nextWakeAt;
}

// A permanent root keeps one path, so a scan of the cache can collect.
async function seedKeptPath(): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		insertNarInfo(instance.context, kept, 1);
		insertRoot(instance.context, { name: 'live', target: kept });
	});
}

describe('garbage collection schedule', () => {
	beforeEach(resetTestServer);

	it('does not scan a cache again while its inputs are unchanged', async () =>
		withoutAlarmArming(async () => {
			await initialise();
			await seedKeptPath();

			at(0);
			await collectTenant();
			at(1);
			await collectTenant();

			expect(await stateOf()).toStrictEqual({
				narInfos: [kept],
				roots: ['live'],
				inputs: {
					inputsChanged: false,
					scanCompletedAt: isoTimestamp(hoursAfterBase(0))
				}
			});
		}));

	it('scans again after a write between two invocations of a scan', async () =>
		withoutAlarmArming(async () => {
			await initialise();
			await seedKeptPath();
			await runInDurableObject(currentServer(), (instance) => {
				insertNarInfo(instance.context, released, 2);
				insertRoot(instance.context, { name: 'other', target: released });
			});

			at(0);
			await driveScanTo(collectOneUnitOfWork, 'mark');
			await runInDurableObject(currentServer(), (instance, state) => {
				state.storage.sql.exec(
					otherTargetDeletion,
					resolvedCache(instance.context).id
				);
			});
			await driveScanTo(collectOneUnitOfWork, undefined);
			const afterScan = await stateOf();

			at(1);
			await collectTenant();

			expect({ afterScan, afterNextScan: await stateOf() }).toStrictEqual({
				afterScan: {
					narInfos: [kept, released],
					roots: ['live', 'other'],
					inputs: {
						inputsChanged: true,
						scanCompletedAt: isoTimestamp(hoursAfterBase(0))
					}
				},
				afterNextScan: {
					narInfos: [kept],
					roots: ['live', 'other'],
					inputs: {
						inputsChanged: false,
						scanCompletedAt: isoTimestamp(hoursAfterBase(1))
					}
				}
			});
		}));

	it('scans an unchanged cache once one of its roots expires', async () =>
		withoutAlarmArming(async () => {
			await initialise();
			await seedKeptPath();
			await runInDurableObject(currentServer(), (instance) => {
				insertNarInfo(instance.context, released, 2);
				insertRoot(instance.context, {
					name: 'nightly',
					expiresAt: hoursAfterBase(2).toISOString(),
					target: released
				});
			});

			at(0);
			await collectTenant();
			at(1);
			await collectTenant();
			const beforeExpiry = await stateOf();
			at(3);
			await collectTenant();

			expect({ beforeExpiry, afterExpiry: await stateOf() }).toStrictEqual({
				beforeExpiry: {
					narInfos: [kept, released],
					roots: ['live', 'nightly'],
					inputs: {
						inputsChanged: false,
						scanCompletedAt: isoTimestamp(hoursAfterBase(0))
					}
				},
				afterExpiry: {
					narInfos: [kept],
					roots: ['live'],
					inputs: {
						inputsChanged: false,
						scanCompletedAt: isoTimestamp(hoursAfterBase(3))
					}
				}
			});
		}));

	it('expires the roots of a closed cache once the interval allows a scan', async () =>
		withoutAlarmArming(async () => {
			const token = await initialise();

			await putTestCache(token, closedCache);
			await runInDurableObject(currentServer(), (instance) => {
				insertNarInfo(instance.context, kept, 1, closedCache);
				insertRoot(instance.context, {
					name: 'channel',
					target: kept,
					scope: closedCache
				});
			});

			at(0);
			await collectTenant();
			await useMinScanInterval(sixHours);
			at(1);
			const closed = await authorisedFetch(
				'/caches/pr-1/close',
				await initialise(),
				{ method: 'POST' }
			);
			at(2);
			await collectTenant();
			const withinInterval = await stateOf(closedCache);
			at(7);
			await collectTenant();

			expect({
				closed: closed.status,
				withinInterval,
				afterInterval: await stateOf(closedCache)
			}).toStrictEqual({
				closed: StatusCodes.OK,
				withinInterval: {
					narInfos: [kept],
					roots: ['channel'],
					inputs: {
						inputsChanged: true,
						scanCompletedAt: isoTimestamp(hoursAfterBase(0))
					}
				},
				afterInterval: {
					narInfos: [],
					roots: [],
					inputs: {
						inputsChanged: false,
						scanCompletedAt: isoTimestamp(hoursAfterBase(7))
					}
				}
			});
		}));

	it("collects a path once its upload's mismatch verdict ends its protection", async () =>
		withoutAlarmArming(async () => {
			await initialise();
			await seedKeptPath();
			await runInDurableObject(currentServer(), (instance, state) => {
				insertNarInfo(instance.context, uploaded, 3);
				state.storage.sql.exec(
					insertPendingUpload,
					resolvedCache(instance.context).id,
					JSON.stringify({ storePathHash: uploaded }),
					pastInstant,
					futureInstant
				);
			});

			at(0);
			await collectTenant();
			await useMinScanInterval(sixHours);
			at(1);
			await runInDurableObject(currentServer(), (_instance, state) => {
				state.storage.sql.exec(settleAsMismatch);
			});
			at(2);
			await collectTenant();
			const withinInterval = await stateOf();
			at(7);
			await collectTenant();

			expect({
				withinInterval,
				afterInterval: await stateOf()
			}).toStrictEqual({
				withinInterval: {
					narInfos: [kept, uploaded],
					roots: ['live'],
					inputs: {
						inputsChanged: true,
						scanCompletedAt: isoTimestamp(hoursAfterBase(0))
					}
				},
				afterInterval: {
					narInfos: [kept],
					roots: ['live'],
					inputs: {
						inputsChanged: false,
						scanCompletedAt: isoTimestamp(hoursAfterBase(7))
					}
				}
			});
		}));

	it('scans at once when an administrator requests collection', async () =>
		withoutAlarmArming(async () => {
			await initialise();
			await seedKeptPath();

			at(0);
			await collectTenant();
			await useMinScanInterval(sixHours);
			at(1);
			await runInDurableObject(currentServer(), (instance) => {
				insertNarInfo(instance.context, released, 2);
			});
			const result = await runGcResult();

			expect({
				pathsCollected: result.pathsCollected,
				state: await stateOf()
			}).toStrictEqual({
				pathsCollected: 1,
				state: {
					narInfos: [kept],
					roots: ['live'],
					inputs: {
						inputsChanged: false,
						scanCompletedAt: isoTimestamp(hoursAfterBase(1))
					}
				}
			});
		}));

	it.each([
		{
			name: 'when the interval of a changed cache ends',
			rootExpiresAfterHours: undefined,
			addsPath: true,
			wakeAfterHours: 6
		},
		{
			name: 'at the end of the interval for a deadline that passes within the interval',
			rootExpiresAfterHours: 1,
			addsPath: false,
			wakeAfterHours: 6
		},
		{
			name: 'at a deadline after the interval',
			rootExpiresAfterHours: 8,
			addsPath: false,
			wakeAfterHours: 8
		}
	])(
		'wakes the tenant $name',
		async ({ rootExpiresAfterHours, addsPath, wakeAfterHours }) =>
			withoutAlarmArming(async () => {
				await initialise();
				await seedKeptPath();

				if (rootExpiresAfterHours !== undefined) {
					await runInDurableObject(currentServer(), (instance) => {
						insertNarInfo(instance.context, released, 2);
						insertRoot(instance.context, {
							name: 'nightly',
							expiresAt: hoursAfterBase(rootExpiresAfterHours).toISOString(),
							target: released
						});
					});
				}

				at(0);
				await collectTenant();
				await useMinScanInterval(sixHours);
				await runInDurableObject(currentServer(), async (instance) => {
					if (addsPath) {
						insertNarInfo(instance.context, uploaded, 3);
					}

					await new MaintenanceEligibilityService(instance.context).reconcile(
						afterThePass
					);
				});

				expect(await maintenanceWakeAt()).toBe(
					isoTimestamp(hoursAfterBase(wakeAfterHours))
				);
			})
	);

	it.each([
		{
			name: 'a negotiated upload from before the close expires',
			verdict: undefined
		},
		{
			name: 'a servable upload from before the close expires',
			verdict: 'servable'
		}
	] as const)(
		'deletes the close event of a closed cache once $name',
		async ({ verdict }) =>
			withoutAlarmArming(async () => {
				const token = await initialise();

				await putTestCache(token, closedCache);
				await runInDurableObject(currentServer(), (instance, state) => {
					const cacheId = resolvedCache(instance.context, closedCache).id;

					state.storage.sql.exec(
						insertOldUpload,
						cacheId,
						pastInstant,
						hoursAfterBase(2).toISOString()
					);

					if (verdict !== undefined) {
						state.storage.sql.exec(oldUploadVerdictUpdate, verdict);
					}
				});

				at(0);
				await collectTenant();
				at(1);
				await authorisedFetch('/caches/pr-1/close', await initialise(), {
					method: 'POST'
				});
				await collectTenant();
				const afterClose = await closeEpochs();
				at(3);
				await collectTenant();

				expect({ afterClose, later: await closeEpochs() }).toStrictEqual({
					afterClose: [1],
					later: []
				});
			})
	);

	it.each([32, 64])(
		'completes a scan of a cache that keeps %i close events',
		async (eventCount) =>
			withoutAlarmArming(async () => {
				const token = await initialise();

				await putTestCache(token, closedCache);
				await putTestCache(token, otherCache);
				await runInDurableObject(currentServer(), (instance, state) => {
					const cacheId = resolvedCache(instance.context, closedCache).id;

					for (let epoch = 1; epoch <= eventCount; epoch += 1) {
						state.storage.sql.exec(
							insertCloseEvent,
							cacheId,
							epoch,
							pastInstant
						);
						state.storage.sql.exec(
							insertHeldUpload,
							`held-${String(epoch)}`,
							cacheId,
							epoch - 1,
							pastInstant,
							futureInstant
						);
					}

					state.storage.sql.exec(retentionEpochUpdate, eventCount, cacheId);
					insertNarInfo(instance.context, kept, 1, otherCache);
					insertNarInfo(instance.context, released, 2, otherCache);
					insertRoot(instance.context, {
						name: 'live',
						target: kept,
						scope: otherCache
					});
				});

				at(0);
				await collectTenant();
				const epochs = await closeEpochs();

				expect({
					closeEvents: epochs.length,
					closed: await stateOf(closedCache),
					other: await stateOf(otherCache)
				}).toStrictEqual({
					closeEvents: eventCount,
					closed: {
						narInfos: [],
						roots: [],
						inputs: {
							inputsChanged: false,
							scanCompletedAt: isoTimestamp(hoursAfterBase(0))
						}
					},
					other: {
						narInfos: [kept],
						roots: ['live'],
						inputs: {
							inputsChanged: false,
							scanCompletedAt: isoTimestamp(hoursAfterBase(0))
						}
					}
				});
			})
	);

	it('deletes more close events than one page once the uploads that kept them expire', async () =>
		withoutAlarmArming(async () => {
			const eventCount = 40;
			const token = await initialise();

			await putTestCache(token, closedCache);
			await runInDurableObject(currentServer(), (instance, state) => {
				const cacheId = resolvedCache(instance.context, closedCache).id;

				for (let epoch = 1; epoch <= eventCount; epoch += 1) {
					state.storage.sql.exec(insertCloseEvent, cacheId, epoch, pastInstant);
					state.storage.sql.exec(
						insertHeldUpload,
						`held-${String(epoch)}`,
						cacheId,
						epoch - 1,
						pastInstant,
						hoursAfterBase(2).toISOString()
					);
				}

				state.storage.sql.exec(heldUploadsSettle, cacheId);
				state.storage.sql.exec(retentionEpochUpdate, eventCount, cacheId);
			});

			at(0);
			await collectTenant();
			const beforeExpiry = await closeEpochs();
			at(3);
			await collectTenant();

			expect({
				beforeExpiry: beforeExpiry.length,
				afterExpiry: await closeEpochs()
			}).toStrictEqual({ beforeExpiry: eventCount, afterExpiry: [] });
		}));

	it('reads the close history from the first event when a scan starts', async () =>
		withoutAlarmArming(async () => {
			const eventCount = 40;
			const rootEpoch = 4;
			const token = await initialise();

			await putTestCache(token, closedCache);
			await runInDurableObject(currentServer(), (instance, state) => {
				const cacheId = resolvedCache(instance.context, closedCache).id;

				for (let epoch = 1; epoch <= eventCount; epoch += 1) {
					state.storage.sql.exec(insertCloseEvent, cacheId, epoch, pastInstant);

					if (epoch !== rootEpoch + 1) {
						state.storage.sql.exec(
							insertHeldUpload,
							`held-${String(epoch)}`,
							cacheId,
							epoch - 1,
							pastInstant,
							futureInstant
						);
					}
				}

				state.storage.sql.exec(retentionEpochUpdate, eventCount, cacheId);
				state.storage.sql.exec(
					insertExpiringOldRoot,
					cacheId,
					rootEpoch,
					eventCount,
					hoursAfterBase(2).toISOString(),
					pastInstant
				);
			});

			at(0);
			await collectTenant();
			at(1);
			await currentServer().runGarbageCollection();
			at(3);
			await collectTenant();

			expect(await closeEpochs()).toStrictEqual(
				Array.from({ length: eventCount }, (_, index) => index + 1).filter(
					(epoch) => epoch !== rootEpoch + 1
				)
			);
		}));

	it.each([
		{ name: 'a narinfo', leftover: 'narinfo', isScanned: false },
		{ name: 'a pending upload', leftover: 'upload', isScanned: false },
		{
			name: 'a close event that a pending upload needs',
			leftover: 'close',
			isScanned: false
		},
		{ name: 'changed inputs', leftover: 'flag', isScanned: true }
	] as const)(
		'keeps visiting a deleted cache that still has $name',
		async ({ leftover, isScanned }) =>
			withoutAlarmArming(async () => {
				const token = await initialise();

				await putTestCache(token, closedCache);
				at(0);
				await collectTenant();

				const cacheId = await runInDurableObject(
					currentServer(),
					(instance, state) => {
						const id = resolvedCache(instance.context, closedCache).id;

						switch (leftover) {
							case 'narinfo': {
								insertNarInfo(instance.context, released, 2, closedCache);
								break;
							}
							case 'close': {
								state.storage.sql.exec(insertCloseEvent, id, 1, pastInstant);
								state.storage.sql.exec(retentionEpochUpdate, 1, id);
								insertHeldUploadFor(state.storage.sql, id);
								break;
							}
							case 'upload': {
								insertHeldUploadFor(state.storage.sql, id);
								break;
							}
							case 'flag': {
								break;
							}
						}

						state.storage.sql.exec(markCacheDeleted, pastInstant, id);
						state.storage.sql.exec(
							leftover === 'flag' ? markInputsChanged : clearInputsChanged,
							id
						);

						return id;
					}
				);

				at(1);
				await collectTenant();

				const row = await runInDurableObject(
					currentServer(),
					(_instance, state) =>
						Array.from(
							state.storage.sql.exec<{
								inputs_changed: number;
								scan_completed_at: string | null;
							}>(selectInputRow, cacheId),
							(found) => ({
								inputsChanged: found.inputs_changed,
								scanCompletedAt: found.scan_completed_at ?? undefined
							})
						)
				);

				expect(row).toStrictEqual([
					{
						inputsChanged: 0,
						scanCompletedAt: isoTimestamp(hoursAfterBase(isScanned ? 1 : 0))
					}
				]);
			})
	);

	it('refuses to empty the frontier of a scan that has marks', async () =>
		withoutAlarmArming(async () => {
			await initialise();
			await seedKeptPath();

			const cacheId = await runInDurableObject(
				currentServer(),
				(instance, state) => {
					const id = resolvedCache(instance.context).id;

					state.storage.sql.exec(insertGraceExpiryScan, id);
					state.storage.sql.exec(insertMark, id, kept);

					return id;
				}
			);

			await expect(
				runInDurableObject(currentServer(), (instance) =>
					instance.runGarbageCollection()
				)
			).rejects.toStrictEqual(
				new GarbageCollectionMarksBeforeSeedError(cacheId)
			);
		}));

	it('scans a cache again when an administrator requests collection during a scan', async () =>
		withoutAlarmArming(async () => {
			await initialise();
			await seedKeptPath();
			await runInDurableObject(currentServer(), (instance) => {
				insertNarInfo(instance.context, released, 2);
				insertRoot(instance.context, { name: 'other', target: released });
			});

			at(0);
			await driveScanTo(collectOneUnitOfWork, 'mark');
			await useMinScanInterval(sixHours);
			await runInDurableObject(currentServer(), (instance, state) => {
				state.storage.sql.exec(
					otherTargetDeletion,
					resolvedCache(instance.context).id
				);
			});
			const result = await runGcResult();

			expect({
				pathsCollected: result.pathsCollected,
				state: await stateOf()
			}).toStrictEqual({
				pathsCollected: 1,
				state: {
					narInfos: [kept],
					roots: ['live', 'other'],
					inputs: {
						inputsChanged: false,
						scanCompletedAt: isoTimestamp(hoursAfterBase(0))
					}
				}
			});
		}));

	it.each([
		{ name: 'is complete', isProjectionComplete: true },
		{ name: 'is not yet complete', isProjectionComplete: false }
	])(
		'scans an unchanged cache once a grace deadline passes while the listing projection $name',
		async ({ isProjectionComplete }) =>
			withoutAlarmArming(async () => {
				await initialise();
				await seedKeptPath();
				await runInDurableObject(currentServer(), (instance, state) => {
					insertNarInfo(instance.context, released, 2);
					instance.context.db
						.insert(schema.retentionGrace)
						.values({
							cacheId: resolvedCache(instance.context).id,
							storePathHash: released,
							retainUntil: isoTimestamp(hoursAfterBase(2))
						})
						.run();

					if (!isProjectionComplete) {
						state.storage.sql.exec(reopenGraceProjection);
					}
				});

				at(0);
				await collectTenant();
				at(1);
				await collectTenant();
				const beforeDeadline = await stateOf();
				at(3);
				await collectTenant();

				expect({
					beforeDeadline,
					afterDeadline: await stateOf()
				}).toStrictEqual({
					beforeDeadline: {
						narInfos: [kept, released],
						roots: ['live'],
						inputs: {
							inputsChanged: false,
							scanCompletedAt: isoTimestamp(hoursAfterBase(0))
						}
					},
					afterDeadline: {
						narInfos: [kept],
						roots: ['live'],
						inputs: {
							inputsChanged: false,
							scanCompletedAt: isoTimestamp(hoursAfterBase(3))
						}
					}
				});
			})
	);

	it('wakes the tenant when the cache with the earliest deadline can be scanned', async () =>
		withoutAlarmArming(async () => {
			const token = await initialise();

			await putTestCache(token, otherCache);
			await seedKeptPath();
			await runInDurableObject(currentServer(), (instance) => {
				insertNarInfo(instance.context, released, 2);
				insertRoot(instance.context, {
					name: 'nightly',
					expiresAt: hoursAfterBase(1).toISOString(),
					target: released
				});
			});

			at(0);
			await collectTenant();
			await useMinScanInterval(sixHours);
			await runInDurableObject(currentServer(), async (instance, state) => {
				state.storage.sql.exec(
					backdateCompletion,
					hoursAfterBase(-48).toISOString(),
					resolvedCache(instance.context, otherCache).id
				);
				await new MaintenanceEligibilityService(instance.context).reconcile(
					afterThePass
				);
			});

			expect(await maintenanceWakeAt()).toBe(isoTimestamp(hoursAfterBase(6)));
		}));

	it('logs an invalid interval and keeps the tenant due when a mutation reconciles', async () =>
		withoutAlarmArming(async () => {
			const token = await initialise();

			await seedKeptPath();
			at(0);
			await collectTenant();
			const wasEligibilityRowPresent =
				(await maintenanceWakeAt()) !== undefined;

			await runInDurableObject(currentServer(), (instance) => {
				instance.context.env = {
					...instance.context.env,
					CUPBOARD_GC_MIN_SCAN_INTERVAL_SECONDS: 'six hours'
				};
				insertNarInfo(instance.context, released, 2);
			});
			const capture = startCapture();

			try {
				await setRoot(token, {
					name: 'live',
					targets: [storePathString(kept)]
				});
			} finally {
				capture.stop();
			}

			expect({
				wasEligibilityRowPresent,
				isEligibilityRowPresent: (await maintenanceWakeAt()) !== undefined,
				errors: capture.logs
					.filter((record) => record.level === 'error')
					.map((record) => ({
						level: record.level,
						properties: record.properties
					}))
			}).toStrictEqual({
				wasEligibilityRowPresent: true,
				isEligibilityRowPresent: false,
				errors: [
					{
						level: 'error',
						properties: {
							error: new MinScanIntervalInvalidError('six hours')
						}
					}
				]
			});
		}));
});
