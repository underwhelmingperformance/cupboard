import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';

import {
	deliverAlarms,
	ignoreAlarmDeliveries
} from '../alarm-fence.test-support.ts';
import { type ResolvedCache } from '../db/cache.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import {
	currentServer,
	initialise,
	namedCache,
	putTestCache,
	resetTestServer
} from '../test-support.ts';

import {
	cacheRowCounts,
	drainTeardown,
	markCacheRemoved,
	noCacheRows,
	operationOutcomes,
	putSeededStagingObjects,
	seedCacheRows,
	seededAttestations,
	seededReservations,
	seededStagingObjects,
	seededVerdicts,
	teardownDrainFor
} from './cache-teardown.test-support.ts';
import { withRowBudget } from './row-budget.ts';
import { withSubrequestSlice } from './subrequest-slice.ts';

const builds = namedCache('builds');
const other = namedCache('other');
const removedPaths = 3000;
const livePaths = 5;

interface Seeded {
	readonly removed: ResolvedCache;
	readonly live: ResolvedCache;
}

// Seeds `builds` and `other`, then marks `builds` removed and leaves its rows.
async function seedRemovedCache(): Promise<Seeded> {
	const token = await initialise();
	await putTestCache(token, builds);
	await putTestCache(token, other);

	const seeded = await runInDurableObject(
		currentServer(),
		async (instance, state) => {
			const live = instance.context.cacheRepository.require(other);
			seedCacheRows(
				instance.context,
				state.storage,
				instance.context.cacheRepository.require(builds),
				'b',
				removedPaths
			);
			seedCacheRows(instance.context, state.storage, live, 'c', livePaths);

			return {
				removed: await markCacheRemoved(
					instance.context,
					state.storage,
					builds
				),
				live
			};
		}
	);
	await putSeededStagingObjects(seeded.removed.id);
	await d1
		.insert(d1Schema.objectIncarnation)
		.values(
			seededReservations(seeded.removed.id).map((reservation) => ({
				kind: 'nar' as const,
				objectId: reservation.narHash,
				incarnation: reservation.incarnation,
				state: 'pending' as const,
				reservationOwner: reservation.owner
			}))
		)
		.run();

	return seeded;
}

const d1 = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });

async function finalState({ removed, live }: Seeded) {
	const staged = await seededStagingObjects(removed.id);
	const reservedNars = seededReservations(removed.id).map(
		({ narHash }) => narHash
	);
	// A given-up reservation is absent and has no owner.
	const reservations = await d1
		.select({ state: d1Schema.objectIncarnation.state })
		.from(d1Schema.objectIncarnation)
		.where(
			and(
				inArray(d1Schema.objectIncarnation.objectId, reservedNars),
				isNull(d1Schema.objectIncarnation.reservationOwner)
			)
		)
		.all();

	return runInDurableObject(currentServer(), (instance) => ({
		removed: cacheRowCounts(instance.context, removed.id),
		live: cacheRowCounts(instance.context, live.id),
		operations: operationOutcomes(instance.context, removed.id),
		staged,
		reservations: reservations.map(({ state }) => state)
	}));
}

// Every row of the removed cache is gone, its staged objects are deleted, its
// operations have failed and each reserved incarnation has been given up. The
// live cache keeps all of its rows.
const expectedFinalState = {
	removed: noCacheRows,
	live: {
		...noCacheRows,
		narinfo: livePaths,
		roots: 1,
		releases: 1,
		targets: livePaths,
		grace: livePaths,
		uploads: seededVerdicts.length,
		attestations: seededAttestations,
		marks: livePaths,
		frontier: livePaths,
		scans: 1
	},
	operations: seededVerdicts.map(() => ({
		state: 'failed',
		resultJson: '{"verdict":"absent"}'
	})),
	staged: [
		...seededVerdicts,
		...Array.from({ length: seededAttestations })
	].map(() => false),
	reservations: ['absent', 'absent']
};

describe('cache teardown drain', () => {
	beforeEach(async () => {
		await resetTestServer();
		const id = currentServer().id;
		ignoreAlarmDeliveries(id);
		onTestFinished(() => {
			deliverAlarms(id);
		});
	});

	it('deletes a removed cache in passes within the row budget', async () => {
		const seeded = await seedRemovedCache();

		const passes = await drainTeardown(seeded.removed.id);

		// The first five passes delete rows until the row budget is spent; the
		// first also concludes the promotions of the two uploads that reserved
		// an incarnation. From the sixth pass on, each pass retires one chunk of
		// queued deletions, and the sixth also deletes the staged objects.
		const retirement = {
			d1Calls: 17,
			r2Delete: 8,
			rowsRead: 1663,
			rowsWritten: 204
		};
		expect({ passes, state: await finalState(seeded) }).toStrictEqual({
			passes: [
				{ d1Calls: 3, r2Delete: 0, rowsRead: 20_532, rowsWritten: 4580 },
				{ d1Calls: 1, r2Delete: 0, rowsRead: 19_877, rowsWritten: 7152 },
				{ d1Calls: 1, r2Delete: 0, rowsRead: 15_508, rowsWritten: 9856 },
				{ d1Calls: 1, r2Delete: 0, rowsRead: 16_385, rowsWritten: 9225 },
				{ d1Calls: 1, r2Delete: 0, rowsRead: 20_243, rowsWritten: 5048 },
				{ d1Calls: 18, r2Delete: 9, rowsRead: 2443, rowsWritten: 397 },
				...Array.from({ length: 15 }, () => retirement),
				{ d1Calls: 14, r2Delete: 6, rowsRead: 1118, rowsWritten: 139 }
			],
			state: expectedFinalState
		});
	});

	it('finishes a teardown that stopped after one page', async () => {
		const seeded = await seedRemovedCache();
		const afterOnePage = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const drain = teardownDrainFor(instance.context);
				const progress = await withSubrequestSlice(() =>
					withRowBudget(() => drain.drain(seeded.removed), 1)
				);

				return {
					progress,
					counts: cacheRowCounts(instance.context, seeded.removed.id)
				};
			}
		);

		await drainTeardown(seeded.removed.id);

		expect({ afterOnePage, state: await finalState(seeded) }).toStrictEqual({
			afterOnePage: {
				progress: { isEmpty: false, hasConcludedPromotions: true },
				counts: {
					...noCacheRows,
					narinfo: removedPaths,
					roots: 1,
					releases: 1,
					targets: removedPaths,
					grace: removedPaths,
					attestations: seededAttestations,
					stagingCleanup: seededVerdicts.length,
					marks: removedPaths,
					frontier: removedPaths,
					scans: 1,
					teardowns: 1
				}
			},
			state: expectedFinalState
		});
	});

	it('stops after the page that spends the budget when that page empties its table', async () => {
		const seeded = await seedRemovedCache();
		const afterOnePage = await runInDurableObject(
			currentServer(),
			async (instance) => {
				instance.context.db
					.delete(schema.pendingUploads)
					.where(eq(schema.pendingUploads.cacheId, seeded.removed.id))
					.run();
				const drain = teardownDrainFor(instance.context);
				const progress = await withSubrequestSlice(() =>
					withRowBudget(() => drain.drain(seeded.removed), 1)
				);

				return {
					progress,
					counts: cacheRowCounts(instance.context, seeded.removed.id)
				};
			}
		);

		// A single page deletes both attestation uploads, spends the budget and
		// empties its table. No root target is deleted in the same pass.
		expect(afterOnePage).toStrictEqual({
			progress: { isEmpty: false, hasConcludedPromotions: false },
			counts: {
				...noCacheRows,
				narinfo: removedPaths,
				roots: 1,
				releases: 1,
				targets: removedPaths,
				grace: removedPaths,
				stagingCleanup: seededAttestations,
				marks: removedPaths,
				frontier: removedPaths,
				scans: 1,
				teardowns: 1
			}
		});
	});

	it.each([
		{
			name: 'pending uploads',
			hasUploads: true,
			afterOnePage: {
				progress: { isEmpty: false, hasConcludedPromotions: true },
				counts: {
					...noCacheRows,
					narinfo: removedPaths,
					roots: 1,
					releases: 1,
					targets: removedPaths,
					grace: removedPaths,
					attestations: seededAttestations,
					stagingCleanup: seededVerdicts.length,
					marks: removedPaths,
					frontier: removedPaths,
					scans: 1,
					teardowns: 1
				}
			}
		},
		{
			// The empty upload table does not use up the pass's first page.
			name: 'no pending upload',
			hasUploads: false,
			afterOnePage: {
				progress: { isEmpty: false, hasConcludedPromotions: false },
				counts: {
					...noCacheRows,
					narinfo: removedPaths,
					roots: 1,
					releases: 1,
					targets: removedPaths,
					grace: removedPaths,
					stagingCleanup: seededAttestations,
					marks: removedPaths,
					frontier: removedPaths,
					scans: 1,
					teardowns: 1
				}
			}
		}
	])(
		'deletes one page of a cache with $name when earlier work in the invocation has spent the budget',
		async ({ hasUploads, afterOnePage }) => {
			const seeded = await seedRemovedCache();
			const observed = await runInDurableObject(
				currentServer(),
				async (instance) => {
					if (!hasUploads) {
						instance.context.db
							.delete(schema.pendingUploads)
							.where(eq(schema.pendingUploads.cacheId, seeded.removed.id))
							.run();
					}
					const drain = teardownDrainFor(instance.context);
					const progress = await withSubrequestSlice(() =>
						withRowBudget(() => {
							// An alarm runs other steps before the teardown pass, and they
							// spend the same budget.
							cacheRowCounts(instance.context, seeded.live.id);

							return drain.drain(seeded.removed);
						}, 1)
					);

					return {
						progress,
						counts: cacheRowCounts(instance.context, seeded.removed.id)
					};
				}
			);

			expect(observed).toStrictEqual(afterOnePage);
		}
	);
});
