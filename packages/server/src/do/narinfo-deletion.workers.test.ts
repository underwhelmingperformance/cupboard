import { rootLogger } from '@cupboard/logger';
import {
	type CacheScope,
	narInfoGenerationSchema,
	nixSha256HashSchema,
	type NixSha256HashString,
	type StorePathHash,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { isoTimestamp, isoTimestampSchema } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import {
	attestationInheritances,
	narInfoDeletions,
	narInfos
} from '../db/schema.ts';
import { SubrequestTimeoutError } from '../errors.ts';
import { internalOrigin, narInfoObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	asOneInvocation,
	authorisedFetch,
	blobReferenceRows,
	commitPath,
	commitUpload,
	currentServer,
	defaultCache,
	flakyD1,
	initialise,
	namedCache,
	narInfoDeletionRows,
	negotiateUploads,
	putNarBytes,
	resetTestServer,
	resolvedCache,
	singleDecision,
	syntheticNarHash,
	syntheticStorePathHash,
	testBase,
	testServerFor,
	uploadMetadata,
	useTestServer,
	verifiableNar
} from '../test-support.ts';

import { AttestationCasService } from './attestation-cas-service.ts';
import { AttestationsService } from './attestations-service.ts';
import { chunk } from './bulk.ts';
import { CacheRegistrationService } from './cache-registration-service.ts';
import { ServerContext } from './context.ts';
import {
	DeletionQueueService,
	maxFencedRetireRows,
	type TornDownNarInfo
} from './deletion-queue-service.ts';
import { GarbageCollectionService } from './garbage-collection-service.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';
import { gcContinuationKey, maintenancePassCursorKey } from './server.ts';

const selectDeletions =
	'SELECT cache_id, store_path_hash FROM narinfo_deletion';
const buildsCache = namedCache('builds');

function syntheticEntries(count: number): TornDownNarInfo[] {
	return Array.from({ length: count }, (_unused, index) => ({
		storePathHash: syntheticStorePathHash(index),
		generation: narInfoGenerationSchema.parse(1),
		narHash: syntheticNarHash(index)
	}));
}

function objectKey(storePathHash: StorePathHash) {
	return narInfoObjectKey(fixtureTenant, storePathHash, { kind: 'default' });
}

function buildAttestations(context: ServerContext): AttestationsService {
	return new AttestationsService(
		context,
		new CacheRegistrationService(context),
		new AttestationCasService(context),
		new NarInfoObjectsService(context)
	);
}

function buildDeletionQueue(context: ServerContext): DeletionQueueService {
	const narInfoObjects = new NarInfoObjectsService(context);
	const attestationCas = new AttestationCasService(context);
	const attestations = new AttestationsService(
		context,
		new CacheRegistrationService(context),
		attestationCas,
		narInfoObjects
	);

	return new DeletionQueueService(
		context,
		attestationCas,
		attestations,
		narInfoObjects
	);
}

async function seedQueuedDeletions(
	entries: readonly TornDownNarInfo[]
): Promise<void> {
	const createdAt = isoTimestamp(testBase);

	await runInDurableObject(currentServer(), (instance, state) => {
		const database = drizzle(state.storage, { schema: { narInfoDeletions } });
		const cache = resolvedCache(instance.context);

		// Each row binds five parameters; sixteen rows stay below maxBoundParameters.
		for (const batch of chunk(entries, 16)) {
			database
				.insert(narInfoDeletions)
				.values(
					batch.map((entry) => ({
						cacheId: cache.id,
						storePathHash: entry.storePathHash,
						narHash: entry.narHash,
						generation: entry.generation,
						createdAt
					}))
				)
				.run();
		}
	});
}

function expectedQueueRows(entries: readonly TornDownNarInfo[]): {
	cache: CacheScope;
	storePathHash: StorePathHash;
	narHash: NixSha256HashString;
	generation: number;
}[] {
	return entries
		.map((entry) => ({
			cache: defaultCache(),
			storePathHash: entry.storePathHash,
			narHash: entry.narHash,
			generation: entry.generation
		}))
		.toSorted((left, right) =>
			byCodeUnit(left.storePathHash, right.storePathHash)
		);
}

describe('narinfo deletion queue', () => {
	beforeEach(resetTestServer);

	it('flushes independent pending deletions for one hash across caches', async () => {
		await useTestServer('narinfo-deletion-caches');
		const token = await initialise();
		const hash = storePathHashSchema.parse('0'.repeat(32));
		const narHash = nixSha256HashSchema.parse(`sha256:${'0'.repeat(52)}`);
		const createdAt = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');

		await runInDurableObject(
			testServerFor('narinfo-deletion-caches'),
			(instance, state) => {
				const defaultResolved = resolvedCache(instance.context);
				const buildsResolved = instance.context.cacheRepository.resolveOrCreate(
					buildsCache,
					'public'
				);

				drizzle(state.storage, { schema: { narInfoDeletions } })
					.insert(narInfoDeletions)
					.values([
						{
							cacheId: defaultResolved.id,
							storePathHash: hash,
							narHash,
							createdAt
						},
						{
							cacheId: buildsResolved.id,
							storePathHash: hash,
							narHash,
							createdAt
						}
					])
					.run();
			}
		);

		await env.BLOBS.put(
			narInfoObjectKey(fixtureTenant, hash, defaultCache()),
			'default narinfo'
		);
		await env.BLOBS.put(
			narInfoObjectKey(fixtureTenant, hash, buildsCache),
			'builds narinfo'
		);

		const response = await authorisedFetch('/gc', token, { method: 'POST' });
		expect(response.status).toBe(StatusCodes.OK);

		const remaining = await runInDurableObject(
			testServerFor('narinfo-deletion-caches'),
			(_instance, state) => state.storage.sql.exec(selectDeletions).toArray()
		);

		const defaultObject = await env.BLOBS.head(
			narInfoObjectKey(fixtureTenant, hash, defaultCache())
		);
		const namedObject = await env.BLOBS.head(
			narInfoObjectKey(fixtureTenant, hash, buildsCache)
		);

		expect({
			defaultObjectGone: defaultObject === null,
			namedObjectGone: namedObject === null,
			remaining
		}).toStrictEqual({
			defaultObjectGone: true,
			namedObjectGone: true,
			remaining: []
		});
	});

	it('keeps the time a version was first queued when it is queued again', async () => {
		const first = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');
		const second = isoTimestampSchema.parse('2026-01-02T00:00:00.000Z');
		const entry: TornDownNarInfo = {
			storePathHash: syntheticStorePathHash(0),
			generation: narInfoGenerationSchema.parse(1),
			narHash: syntheticNarHash(0)
		};
		const replacement = syntheticNarHash(1);

		const rows = await runInDurableObject(currentServer(), (instance) => {
			const queue = buildDeletionQueue(instance.context);
			const cache = resolvedCache(instance.context);

			queue.enqueueNarInfoDeletion(
				instance.context.db,
				cache,
				entry.storePathHash,
				entry.narHash,
				entry.generation,
				first
			);
			queue.enqueueNarInfoDeletion(
				instance.context.db,
				cache,
				entry.storePathHash,
				replacement,
				entry.generation,
				second
			);

			return instance.context.db.select().from(narInfoDeletions).all();
		});

		expect(rows).toStrictEqual([
			{
				cacheId: 1,
				storePathHash: entry.storePathHash,
				narHash: replacement,
				generation: entry.generation,
				createdAt: first,
				withdrawn: false
			}
		]);
	});

	it.each([
		{ name: 'with a deferred deletion', isDeferred: true },
		{ name: 'without a deferral', isDeferred: false }
	])(
		'runs garbage collection once across repeated alarms $name',
		async ({ isDeferred }) => {
			const token = await initialise();
			const nar = await verifiableNar('alarm-deferred-deletion');
			const metadata = uploadMetadata({
				storePathHash: 'd'.repeat(32),
				narHash: nar.narHash,
				narSize: nar.narSize,
				fileHash: nar.fileHash,
				fileSize: nar.narBytes.byteLength
			});
			const first = singleDecision(await negotiateUploads(token, [metadata]));

			if (isDeferred) {
				// A second upload of the same path and NAR stays pending.
				await negotiateUploads(token, [metadata]);
			}

			if (first.action !== 'upload') {
				throw new Error('the first negotiation must plan an upload');
			}

			await putNarBytes(first.r2Key, nar);
			await commitUpload(token, first.uploadId);
			await runInDurableObject(currentServer(), async (instance, state) => {
				await buildAttestations(instance.context).drainInheritanceQueue(
					rootLogger()
				);
				const cache = resolvedCache(instance.context);

				instance.context.db
					.delete(narInfos)
					.where(
						and(
							eq(narInfos.cacheId, cache.id),
							eq(narInfos.storePathHash, metadata.storePathHash)
						)
					)
					.run();
				instance.context.db
					.insert(narInfoDeletions)
					.values({
						cacheId: cache.id,
						storePathHash: metadata.storePathHash,
						narHash: metadata.narHash,
						generation: narInfoGenerationSchema.parse(0),
						createdAt: isoTimestamp(new Date())
					})
					.run();
				await state.storage.put(gcContinuationKey, [{ scope: 'tenant' }]);
			});
			const collections = vi.spyOn(
				GarbageCollectionService.prototype,
				'collectGarbage'
			);
			const objectDeletions = vi.spyOn(
				NarInfoObjectsService.prototype,
				'deleteNarInfoObjects'
			);

			const driven = await (async () => {
				try {
					for (let alarm = 0; alarm < 6; alarm += 1) {
						await runInDurableObject(
							currentServer(),
							async (instance, state) => {
								// Start each rotation at the first pass.
								await state.storage.delete(maintenancePassCursorKey);
								await instance.alarm();
							}
						);
					}

					return {
						collections: collections.mock.calls.length,
						objectDeletions: objectDeletions.mock.calls.length
					};
				} finally {
					collections.mockRestore();
					objectDeletions.mockRestore();
				}
			})();
			const continuation = await runInDurableObject(
				currentServer(),
				(_instance, state) => state.storage.get(gcContinuationKey)
			);

			const queued = await narInfoDeletionRows();

			expect({
				...driven,
				continuation,
				queued: queued.length
			}).toStrictEqual({
				collections: 1,
				objectDeletions: 1,
				continuation: undefined,
				queued: isDeferred ? 1 : 0
			});
		}
	);

	it('withdraws a deferred narinfo and retires the rest of the queue in a flush', async () => {
		const token = await initialise();
		const [deferredNar, retiredNar] = await Promise.all([
			verifiableNar('flush-deferred'),
			verifiableNar('flush-retired')
		]);
		const deferred = uploadMetadata({
			storePathHash: 'a'.repeat(32),
			narHash: deferredNar.narHash,
			narSize: deferredNar.narSize,
			fileHash: deferredNar.fileHash,
			fileSize: deferredNar.narBytes.byteLength
		});
		const retired = uploadMetadata({
			storePathHash: 'b'.repeat(32),
			narHash: retiredNar.narHash,
			narSize: retiredNar.narSize,
			fileHash: retiredNar.fileHash,
			fileSize: retiredNar.narBytes.byteLength
		});
		// A second upload of the deferred path and NAR stays pending, so its
		// commit will inherit attestations from generation 0.
		const first = singleDecision(await negotiateUploads(token, [deferred]));
		const second = singleDecision(await negotiateUploads(token, [deferred]));

		if (first.action !== 'upload' || second.action !== 'upload') {
			throw new Error('both negotiations must plan an upload');
		}

		await putNarBytes(first.r2Key, deferredNar);
		await commitUpload(token, first.uploadId);
		await commitPath(token, retired, retiredNar);
		await runInDurableObject(currentServer(), async (instance, state) => {
			await buildAttestations(instance.context).drainInheritanceQueue(
				rootLogger()
			);
			await state.storage.deleteAlarm();
		});
		const flush = (limit: number) =>
			runInDurableObject(currentServer(), (instance) =>
				asOneInvocation(() =>
					instance.context.criticalSection(() =>
						buildDeletionQueue(instance.context).flushQueuedNarInfoDeletions(
							undefined,
							limit
						)
					)
				)
			);

		await runInDurableObject(currentServer(), (instance) => {
			const cache = resolvedCache(instance.context);
			const createdAt = isoTimestamp(new Date());

			for (const metadata of [deferred, retired]) {
				instance.context.db
					.delete(narInfos)
					.where(
						and(
							eq(narInfos.cacheId, cache.id),
							eq(narInfos.storePathHash, metadata.storePathHash)
						)
					)
					.run();
				instance.context.db
					.insert(narInfoDeletions)
					.values({
						cacheId: cache.id,
						storePathHash: metadata.storePathHash,
						narHash: metadata.narHash,
						generation: narInfoGenerationSchema.parse(0),
						createdAt
					})
					.run();
			}
		});

		await flush(1);
		const afterFirst = {
			queued: await narInfoDeletionRows(),
			deferredObject:
				(await env.BLOBS.head(objectKey(deferred.storePathHash))) !== null,
			retiredObject:
				(await env.BLOBS.head(objectKey(retired.storePathHash))) !== null
		};
		await flush(2);
		const afterSecond = {
			queued: await narInfoDeletionRows(),
			deferredObject:
				(await env.BLOBS.head(objectKey(deferred.storePathHash))) !== null
		};
		const edges = await blobReferenceRows();

		expect({
			afterFirst,
			afterSecond,
			edges: edges.map((edge) => edge.storePathHash)
		}).toStrictEqual({
			afterFirst: {
				queued: [
					{
						cache: defaultCache(),
						storePathHash: deferred.storePathHash,
						narHash: deferred.narHash,
						generation: 0
					}
				],
				deferredObject: true,
				retiredObject: false
			},
			afterSecond: {
				queued: [
					{
						cache: defaultCache(),
						storePathHash: deferred.storePathHash,
						narHash: deferred.narHash,
						generation: 0
					}
				],
				deferredObject: false
			},
			edges: [deferred.storePathHash]
		});
	});

	it('retires a queued edge whose own generation is in the inheritance queue', async () => {
		const token = await initialise();
		const nar = await verifiableNar('flush-own-inheritance');
		const metadata = uploadMetadata({
			storePathHash: 'c'.repeat(32),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		await commitPath(token, metadata, nar);

		// Queue, remove and flush in one call, so that the alarm cannot drain the
		// commit's inheritance row first.
		await runInDurableObject(currentServer(), async (instance) => {
			const cache = resolvedCache(instance.context);

			instance.context.db
				.insert(attestationInheritances)
				.values({
					cacheId: cache.id,
					storePathHash: metadata.storePathHash,
					generation: narInfoGenerationSchema.parse(0),
					narHash: metadata.narHash,
					notBefore: isoTimestamp(new Date())
				})
				.onConflictDoNothing()
				.run();
			instance.context.db
				.delete(narInfos)
				.where(
					and(
						eq(narInfos.cacheId, cache.id),
						eq(narInfos.storePathHash, metadata.storePathHash)
					)
				)
				.run();
			instance.context.db
				.insert(narInfoDeletions)
				.values({
					cacheId: cache.id,
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash,
					generation: narInfoGenerationSchema.parse(0),
					createdAt: isoTimestamp(new Date())
				})
				.run();
			await asOneInvocation(() =>
				instance.context.criticalSection(() =>
					buildDeletionQueue(instance.context).flushQueuedNarInfoDeletions()
				)
			);
		});

		expect({
			queued: await narInfoDeletionRows(),
			edges: await blobReferenceRows()
		}).toStrictEqual({ queued: [], edges: [] });
	});

	it('caps a flush at its limit and reports the remaining backlog', async () => {
		const total = 6;
		const flushLimit = 4;
		const entries = syntheticEntries(total);
		await seedQueuedDeletions(entries);

		const firstPass = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const queue = buildDeletionQueue(instance.context);
				const retired = await asOneInvocation(() =>
					instance.context.criticalSection(() =>
						queue.flushQueuedNarInfoDeletions(undefined, flushLimit)
					)
				);

				return { retired, hasMore: queue.hasQueuedNarInfoDeletions() };
			}
		);
		const remainingAfterFirst = await narInfoDeletionRows();

		const secondPass = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const queue = buildDeletionQueue(instance.context);
				const retired = await asOneInvocation(() =>
					instance.context.criticalSection(() =>
						queue.flushQueuedNarInfoDeletions(undefined, flushLimit)
					)
				);

				return { retired, hasMore: queue.hasQueuedNarInfoDeletions() };
			}
		);
		const remainingAfterSecond = await narInfoDeletionRows();

		expect({
			firstPass,
			remainingAfterFirst,
			secondPass,
			remainingAfterSecond
		}).toStrictEqual({
			firstPass: { retired: flushLimit, hasMore: true },
			remainingAfterFirst: expectedQueueRows(entries.slice(flushLimit)),
			secondPass: { retired: total - flushLimit, hasMore: false },
			remainingAfterSecond: []
		});
	});

	it('clears a completed chunk and leaves the rest when a later chunk fails', async () => {
		const overflow = 3;
		const entries = syntheticEntries(maxFencedRetireRows + overflow);
		await seedQueuedDeletions(entries);

		const deleteSpy = vi.spyOn(
			NarInfoObjectsService.prototype,
			'deleteNarInfoObjects'
		);
		deleteSpy.mockResolvedValueOnce(undefined);
		deleteSpy.mockRejectedValueOnce(
			new SubrequestTimeoutError('narinfo-object-delete')
		);

		const error = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const queue = buildDeletionQueue(instance.context);

				try {
					await asOneInvocation(() =>
						instance.context.criticalSection(() =>
							queue.retireTornDownNarInfos(
								resolvedCache(instance.context),
								entries
							)
						)
					);

					return;
				} catch (error_: unknown) {
					return error_;
				}
			}
		);

		deleteSpy.mockRestore();

		const remaining = await narInfoDeletionRows();

		expect({
			errorIsTimeout: error instanceof SubrequestTimeoutError,
			remaining
		}).toStrictEqual({
			errorIsTimeout: true,
			remaining: expectedQueueRows(entries.slice(maxFencedRetireRows))
		});
	});

	// A failed edge retirement leaves the object absent and the edge intact.
	// Reversing the operations would let a public read serve an unreferenced
	// object because public narinfo reads do not consult D1.
	it('removes the published object before it retires the reference edge', async () => {
		const token = await initialise();
		const nar = await verifiableNar('retirement-order');
		const metadata = uploadMetadata({
			name: 'retirement-order',
			storePathHash: 'r'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});
		await commitPath(token, metadata, nar);

		const storePathHash = storePathHashSchema.parse(metadata.storePathHash);
		const objectKey = narInfoObjectKey(
			fixtureTenant,
			storePathHash,
			defaultCache()
		);
		const failure = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const context = new ServerContext(state, {
					...instance.context.env,
					CUPBOARD_DB: flakyD1(instance.context.env.CUPBOARD_DB, {
						failures: 1,
						matches: (query) => query.startsWith('delete from "blob_ref"')
					})
				});

				try {
					await buildDeletionQueue(context).deleteStorePath(
						defaultCache(),
						storePathHash,
						internalOrigin
					);

					return;
				} catch (error: unknown) {
					return error;
				}
			}
		);
		const edge = await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
			.select({ narHash: d1Schema.blobReference.narHash })
			.from(d1Schema.blobReference)
			.where(
				and(
					eq(d1Schema.blobReference.tenant, fixtureTenant),
					eq(d1Schema.blobReference.storePathHash, storePathHash)
				)
			)
			.get();

		expect({
			retirementFailed: failure !== undefined,
			objectGone: (await env.BLOBS.head(objectKey)) === null,
			edgeKept: edge !== undefined
		}).toStrictEqual({
			retirementFailed: true,
			objectGone: true,
			edgeKept: true
		});
	});
});
