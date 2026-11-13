import { rootLogger } from '@cupboard/logger';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import {
	cacheRemovedVerdictCapability,
	type CommitSessionFrame,
	uploadIdSchema
} from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';

import {
	deliverAlarms,
	ignoreAlarmDeliveries
} from '../alarm-fence.test-support.ts';
import { type ResolvedCache } from '../db/cache.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { r2ObjectKeySchema } from '../http/http.ts';
import {
	asOneInvocation,
	authorisedFetch,
	closeSessionAndWait,
	currentServer,
	framesThroughProbe,
	initialise,
	namedCache,
	openCommitSession,
	probeAnswer,
	putTestCache,
	resetTestServer,
	testPushId,
	uploadMetadata,
	verificationOf
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
import { type ServerContext } from './context.ts';
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

const waitingUploadId = uploadIdSchema.parse('a'.repeat(64));
const waitingPath = uploadMetadata({
	fileSize: 1,
	storePathHash: 'a'.repeat(32)
});

interface WaitingUpload {
	readonly verdict: 'pending' | 'servable';
	readonly graceDecisionJson?: string;
	// An accepted publication operation of the upload whose recovery deadline
	// has passed.
	readonly expiredOperation?: { readonly graceDecisionJson: string };
}

function insertWaitingUpload(
	context: ServerContext,
	cache: ResolvedCache,
	{ verdict, graceDecisionJson, expiredOperation }: WaitingUpload
): void {
	const now = new Date();
	const inAnHour = new Date(now.getTime() + 60 * 60 * 1000);

	context.db
		.insert(schema.pendingUploads)
		.values({
			id: waitingUploadId,
			cacheId: cache.id,
			narHash: waitingPath.narHash,
			r2Key: r2ObjectKeySchema.parse(`staging/${waitingUploadId}`),
			metadataJson: JSON.stringify(waitingPath),
			createdAt: isoTimestamp(now),
			expiresAt: isoTimestamp(inAnHour),
			verdict,
			graceDecisionJson
		})
		.run();
	if (expiredOperation === undefined) {
		return;
	}

	context.db
		.insert(schema.publicationOperations)
		.values({
			id: waitingUploadId,
			cacheId: cache.id,
			cacheGeneration: cache.generation,
			pushId: testPushId,
			canonicalJson: '[]',
			acceptedAt: now.toISOString(),
			pushExpiresAt: now.toISOString(),
			recoveryDeadline: new Date(now.getTime() - 1000).toISOString(),
			pruneAfter: inAnHour.toISOString(),
			graceDecisionJson: expiredOperation.graceDecisionJson
		})
		.run();
}

// Runs publication expiry and returns the waiting upload's operation.
function expirePublications() {
	return runInDurableObject(currentServer(), async (instance) => {
		await asOneInvocation(() =>
			verificationOf(instance).expirePublications(rootLogger())
		);

		return instance.context.db
			.select({
				state: schema.publicationOperations.state,
				resultJson: schema.publicationOperations.resultJson
			})
			.from(schema.publicationOperations)
			.where(eq(schema.publicationOperations.id, waitingUploadId))
			.get();
	});
}

const deferredFrame: CommitSessionFrame = {
	ev: 'deferred',
	uploadId: waitingUploadId,
	storePathHash: waitingPath.storePathHash,
	narHash: waitingPath.narHash
};
const cacheRemovedFrame: CommitSessionFrame = {
	ev: 'verdict',
	uploadId: waitingUploadId,
	status: 'absent',
	reason: 'cache-removed'
};

interface DrainNotificationCase {
	readonly name: string;
	readonly upload: WaitingUpload;
	// The capabilities that the session accepts.
	readonly accepted?: string;
	readonly subscribed: CommitSessionFrame;
	// Whether publication expiry runs between the removal and the drain.
	readonly expiresBeforeDrain: boolean;
	readonly drained: readonly CommitSessionFrame[];
}

const drainNotificationCases: readonly DrainNotificationCase[] = [
	{
		name: 'tells a session that accepts the reason that the cache of its upload was removed',
		upload: { verdict: 'pending' },
		accepted: cacheRemovedVerdictCapability,
		subscribed: deferredFrame,
		expiresBeforeDrain: false,
		drained: [cacheRemovedFrame, probeAnswer]
	},
	{
		// An older client negotiates the path again after `absent`, and the
		// server refuses the negotiation of a push that started before the
		// removal.
		name: 'sends a plain absent verdict to a session that does not accept the reason',
		upload: { verdict: 'pending', graceDecisionJson: '{"reportsGrace":true}' },
		subscribed: { ...deferredFrame, grace: {} },
		expiresBeforeDrain: false,
		drained: [
			{ ev: 'verdict', uploadId: waitingUploadId, status: 'absent', grace: {} },
			probeAnswer
		]
	},
	{
		// Expiry fails the operation and leaves its upload for the drain.
		name: 'tells the session of an expired publication when its upload is drained',
		upload: {
			verdict: 'pending',
			graceDecisionJson: '{"reportsGrace":true}',
			expiredOperation: { graceDecisionJson: '{"reportsGrace":true}' }
		},
		accepted: cacheRemovedVerdictCapability,
		subscribed: { ...deferredFrame, grace: {} },
		expiresBeforeDrain: true,
		drained: [
			{
				ev: 'verdict',
				uploadId: waitingUploadId,
				status: 'absent',
				reason: 'cache-removed',
				grace: {}
			},
			probeAnswer
		]
	},
	{
		// The session received the upload's verdict when it settled.
		name: 'sends no frame to the session of a settled upload',
		upload: { verdict: 'servable' },
		accepted: cacheRemovedVerdictCapability,
		subscribed: {
			ev: 'verdict',
			uploadId: waitingUploadId,
			status: 'servable'
		},
		expiresBeforeDrain: false,
		drained: [probeAnswer]
	}
];

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

	it.each(drainNotificationCases)(
		'$name',
		async ({ upload, accepted, subscribed, expiresBeforeDrain, drained }) => {
			const token = await initialise();
			await putTestCache(token, builds);
			const removed = await runInDurableObject(currentServer(), (instance) => {
				const cache = instance.context.cacheRepository.require(builds);
				insertWaitingUpload(instance.context, cache, upload);

				return cache;
			});
			const session = await openCommitSession(token, builds, accepted);

			try {
				session.send({ op: 'subscribe', uploadIds: [waitingUploadId] });
				const reply = await session.nextFrame();
				const removal = await authorisedFetch(
					'/caches/builds?force=true',
					token,
					{ method: 'DELETE' }
				);
				const expiry = expiresBeforeDrain
					? {
							operation: await expirePublications(),
							frames: await framesThroughProbe(session)
						}
					: undefined;
				await drainTeardown(removed.id);

				expect({
					reply,
					removal: removal.status,
					expiry,
					drained: await framesThroughProbe(session)
				}).toStrictEqual({
					reply: subscribed,
					removal: StatusCodes.OK,
					expiry: expiresBeforeDrain
						? {
								operation: {
									state: 'failed',
									resultJson: '{"verdict":"absent"}'
								},
								frames: [probeAnswer]
							}
						: undefined,
					drained
				});
			} finally {
				await closeSessionAndWait(session.socket);
			}
		}
	);
});
