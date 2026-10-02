import { rootLogger } from '@cupboard/logger';
import {
	type CacheScope,
	firstCacheGeneration,
	narInfoGenerationSchema,
	nixSha256HashSchema,
	type NixSha256HashString,
	predicateTypeSchema,
	sha256HexDigestSchema,
	type StorePathHash,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { isoTimestamp, isoTimestampSchema } from '@cupboard/protocol/scalars';
import { uploadIdSchema } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import * as d1Schema from '../db/d1-schema.ts';
import {
	attestationInheritances,
	narInfoDeletions,
	narInfos,
	pendingUploads
} from '../db/schema.ts';
import { ServerHttpError, SubrequestTimeoutError } from '../errors.ts';
import { internalOrigin, narInfoObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	asOneInvocation,
	attestationReferenceRows,
	authorisedFetch,
	blobReferenceRows,
	commitPath,
	commitUpload,
	currentServer,
	defaultCache,
	fileAttestationReference,
	flakyD1,
	initialise,
	namedCache,
	narInfoDeletionRows,
	negotiateUploads,
	putNarBytes,
	putTestCache,
	recordTransition,
	resetTestServer,
	resolvedCache,
	singleDecision,
	syntheticNarHash,
	syntheticStorePathHash,
	testBase,
	testServerFor,
	uploadMetadata,
	useTestServer,
	verifiableNar,
	withoutAlarmArming
} from '../test-support.ts';

import { AttestationCasService } from './attestation-cas-service.ts';
import { AttestationsService } from './attestations-service.ts';
import { chunk } from './bulk.ts';
import { CacheRegistrationService } from './cache-registration-service.ts';
import { ServerContext } from './context.ts';
import {
	deferredDeletionCondition,
	DeletionQueueService,
	maxFencedRetireRows,
	type TornDownNarInfo
} from './deletion-queue-service.ts';
import { GarbageCollectionService } from './garbage-collection-service.ts';
import { jsonRowList } from './json-list.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';
import { OffboardingService } from './offboarding-service.ts';
import {
	PathReadAuthorityService,
	reclaimPathReadFence
} from './path-read-authority-service.ts';
import { ProtectedInheritanceService } from './protected-inheritance-service.ts';
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

		// Each row binds seven parameters; fourteen rows stay below maxBoundParameters.
		for (const batch of chunk(entries, 14)) {
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

// Runs maintenance alarms, each starting its rotation at the first pass.
async function runMaintenanceAlarms(count: number): Promise<void> {
	for (let alarm = 0; alarm < count; alarm += 1) {
		await runInDurableObject(currentServer(), async (instance, state) => {
			await state.storage.delete(maintenancePassCursorKey);
			await instance.alarm();
		});
	}
}

function deletionSnapshots(context: ServerContext) {
	return context.db
		.select()
		.from(narInfoDeletions)
		.all()
		.map((row) => ({
			...row,
			protectionCutoff: row.protectionCutoff ?? undefined,
			protectionCapturedAt: row.protectionCapturedAt ?? undefined
		}));
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

	it.each([
		{ stage: 'only the tenant Worker uploaded', contractedAt: undefined },
		{ stage: 'both Workers uploaded before contract', contractedAt: undefined },
		{
			stage: 'contract started but not completed',
			contractedAt: isoTimestamp(testBase)
		}
	])(
		'refuses explicit deletion before authority activation when $stage',
		async ({ contractedAt }) => {
			const token = await initialise();
			const nar = await verifiableNar('authority-activation');
			const metadata = uploadMetadata({
				narHash: nar.narHash,
				narSize: nar.narSize,
				fileHash: nar.fileHash,
				fileSize: nar.narBytes.byteLength
			});
			await commitPath(token, metadata, nar);
			await recordTransition('blob-reference-read-authority', 'expanded');
			if (contractedAt !== undefined) {
				await drizzleD1(env.CUPBOARD_DB)
					.update(d1Schema.deploymentTransition)
					.set({ contractedAt })
					.where(
						eq(
							d1Schema.deploymentTransition.id,
							'blob-reference-read-authority'
						)
					);
			}
			const objectBefore = await env.BLOBS.head(
				objectKey(metadata.storePathHash)
			);
			const before = {
				edges: await blobReferenceRows(),
				queue: await narInfoDeletionRows(),
				object: objectBefore?.etag
			};
			const failure = await runInDurableObject(
				currentServer(),
				async (instance) => {
					try {
						await buildDeletionQueue(instance.context).deleteStorePath(
							defaultCache(),
							metadata.storePathHash,
							internalOrigin
						);
					} catch (error) {
						return error instanceof ServerHttpError
							? {
									name: error.name,
									status: error.status,
									retryAfterSeconds: error.retryAfterSeconds
								}
							: error;
					}
				}
			);

			const objectAfter = await env.BLOBS.head(
				objectKey(metadata.storePathHash)
			);
			expect({
				failure,
				after: {
					edges: await blobReferenceRows(),
					queue: await narInfoDeletionRows(),
					object: objectAfter?.etag
				}
			}).toStrictEqual({
				failure: {
					name: 'PathReadAuthorityMigrationPendingError',
					status: 503,
					retryAfterSeconds: 1
				},
				after: before
			});
		}
	);

	it.each(['reserve', 'remove', 'offboard'] as const)(
		'refuses %s before reference storage contraction without changing shared facts',
		async (operation) => {
			await initialise();
			await recordTransition('blob-reference-read-authority', 'expanded');
			const before = await blobReferenceRows();
			const result = await runInDurableObject(
				currentServer(),
				async (instance, state) => {
					const context = new ServerContext(state, instance.context.env);
					const service = new AttestationCasService(context);
					const reference = {
						cache: defaultCache(),
						storePathHash: syntheticStorePathHash(91),
						generation: narInfoGenerationSchema.parse(1),
						predicateType: predicateTypeSchema.parse(
							'https://example.com/predicate'
						),
						digest: sha256HexDigestSchema.parse('0'.repeat(64))
					};
					try {
						if (operation === 'reserve') {
							await service.reserveReferenceAndCharge(reference, 1);
						} else if (operation === 'remove') {
							await service.removeCapturedReference(reference);
						} else {
							await new OffboardingService(context).drain(100);
						}
					} catch (error) {
						return error instanceof ServerHttpError
							? {
									name: error.name,
									status: error.status,
									retryAfterSeconds: error.retryAfterSeconds,
									offboarding: context.offboarding
								}
							: error;
					}
				}
			);
			expect({ result, after: await blobReferenceRows() }).toStrictEqual({
				result: {
					name: 'PathReadAuthorityMigrationPendingError',
					status: 503,
					retryAfterSeconds: 1,
					offboarding: false
				},
				after: before
			});
		}
	);

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

			return deletionSnapshots(instance.context);
		});

		expect(rows).toStrictEqual([
			{
				cacheId: 1,
				storePathHash: entry.storePathHash,
				narHash: replacement,
				generation: entry.generation,
				createdAt: first,
				explicit: false,
				protectionCutoff: undefined,
				protectionCapturedAt: undefined,
				withdrawn: false
			}
		]);
	});

	it('keeps a public source edge while another cache has a pending reference commit', async () => {
		const token = await initialise();
		const destination = namedCache('pending-reference-destination');
		await putTestCache(token, destination);
		const nar = await verifiableNar('pending-reference-source');
		const metadata = uploadMetadata({
			storePathHash: syntheticStorePathHash(82),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		await commitPath(token, metadata, nar);
		const pending = singleDecision(
			await negotiateUploads(token, [metadata], destination)
		);
		const outcome = await runInDurableObject(
			currentServer(),
			async (instance) => {
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
				const queue = buildDeletionQueue(instance.context);
				const retired = await instance.context.criticalSection(() =>
					queue.flushQueuedNarInfoDeletions()
				);
				return {
					retired,
					wakeScheduled: queue.earliestPendingDeferralEnd() !== undefined
				};
			}
		);
		const deletionRows = await narInfoDeletionRows();
		const referenceRows = await blobReferenceRows();
		expect({
			pending: pending.action,
			outcome,
			deletions: deletionRows.map((row) => ({
				cache: row.cache,
				storePathHash: row.storePathHash
			})),
			edges: referenceRows.map((row) => ({
				cache: row.cache,
				storePathHash: row.storePathHash
			}))
		}).toStrictEqual({
			pending: 'commit',
			outcome: { retired: 0, wakeScheduled: true },
			deletions: [
				{
					cache: defaultCache(),
					storePathHash: metadata.storePathHash
				}
			],
			edges: [
				{
					cache: defaultCache(),
					storePathHash: metadata.storePathHash
				}
			]
		});
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

	it('resumes collection when the inheritance drain releases a deferred deletion', async () => {
		const token = await initialise();
		const nar = await verifiableNar('drain-released-deletion');
		const metadata = uploadMetadata({
			storePathHash: 'f'.repeat(32),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		await commitPath(token, metadata, nar);
		await runInDurableObject(currentServer(), async (instance, state) => {
			await buildAttestations(instance.context).drainInheritanceQueue(
				rootLogger()
			);
			await state.storage.deleteAlarm();
			const cache = resolvedCache(instance.context);
			const now = isoTimestamp(new Date());

			// A newer generation with the same NAR is queued for inheritance, so a
			// flush has already withdrawn the deletion of generation 0.
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
				.insert(attestationInheritances)
				.values({
					cacheId: cache.id,
					storePathHash: metadata.storePathHash,
					generation: narInfoGenerationSchema.parse(1),
					narHash: metadata.narHash,
					notBefore: now
				})
				.run();
			instance.context.db
				.insert(narInfoDeletions)
				.values({
					cacheId: cache.id,
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash,
					generation: narInfoGenerationSchema.parse(0),
					createdAt: now,
					explicit: false,
					protectionCutoff: undefined,
					protectionCapturedAt: undefined,
					withdrawn: true
				})
				.run();
		});

		await runMaintenanceAlarms(6);

		expect({
			queued: await narInfoDeletionRows(),
			edges: await blobReferenceRows()
		}).toStrictEqual({ queued: [], edges: [] });
	});

	it.each([1, 2])(
		'resumes public source retirement after %i destinations finish inheritance',
		async (destinationCount) =>
			withoutAlarmArming(async () => {
				const token = await initialise();
				const nar = await verifiableNar('released-public-source');
				const metadata = uploadMetadata({
					storePathHash: syntheticStorePathHash(83),
					narHash: nar.narHash,
					narSize: nar.narSize,
					fileHash: nar.fileHash,
					fileSize: nar.narBytes.byteLength
				});
				await commitPath(token, metadata, nar);
				await runInDurableObject(currentServer(), (instance) =>
					buildAttestations(instance.context).drainInheritanceQueue(
						rootLogger()
					)
				);
				const bundle = await fileAttestationReference({
					uploadId: 'released-source-bundle',
					bytes: new TextEncoder().encode('source evidence'),
					storePathHash: metadata.storePathHash,
					generation: 0
				});
				const destinations = Array.from(
					{ length: destinationCount },
					(_unused, index) => namedCache(`destination-${String(index)}`)
				);

				for (const destination of destinations) {
					await putTestCache(token, destination);
					const decision = singleDecision(
						await negotiateUploads(token, [metadata], destination)
					);
					if (decision.action !== 'commit') {
						throw new Error('the destination must reuse the source NAR');
					}
					await commitUpload(token, decision.uploadId, destination);
				}

				const queued = await runInDurableObject(
					currentServer(),
					async (instance, state) => {
						const source = resolvedCache(instance.context);
						const now = isoTimestamp(new Date());
						instance.context.db
							.delete(narInfos)
							.where(eq(narInfos.cacheId, source.id))
							.run();
						buildDeletionQueue(instance.context).enqueueNarInfoDeletion(
							instance.context.db,
							source,
							metadata.storePathHash,
							metadata.narHash,
							narInfoGenerationSchema.parse(0),
							now
						);
						await instance.context.criticalSection(() =>
							buildDeletionQueue(instance.context).flushQueuedNarInfoDeletions()
						);
						await state.storage.delete(gcContinuationKey);

						if (destinationCount === 2) {
							const destination = destinations[1];
							if (destination === undefined) {
								throw new Error('the second destination must exist');
							}
							const later =
								instance.context.cacheRepository.require(destination);
							const notBefore = isoTimestamp(new Date(Date.now() + 60_000));
							instance.context.db
								.update(attestationInheritances)
								.set({ notBefore })
								.where(eq(attestationInheritances.cacheId, later.id))
								.run();
						}
						return deletionSnapshots(instance.context);
					}
				);
				const drainAlarm = () =>
					runInDurableObject(currentServer(), async (instance, state) => {
						await state.storage.put(
							maintenancePassCursorKey,
							'garbage-collection'
						);
						await instance.alarm();
						return state.storage.get(gcContinuationKey);
					});
				const firstContinuation = await drainAlarm();

				if (destinationCount === 2) {
					expect({
						continuation: firstContinuation,
						queued: await narInfoDeletionRows()
					}).toStrictEqual({
						continuation: undefined,
						queued: [
							{
								cache: defaultCache(),
								storePathHash: metadata.storePathHash,
								narHash: metadata.narHash,
								generation: 0
							}
						]
					});
					await runInDurableObject(currentServer(), (instance) => {
						instance.context.db
							.update(attestationInheritances)
							.set({ notBefore: isoTimestamp(new Date()) })
							.run();
					});
				}
				let continuation =
					destinationCount === 2 ? await drainAlarm() : firstContinuation;
				for (let pass = 0; pass < 6; pass += 1) {
					const remaining = await runInDurableObject(
						currentServer(),
						(instance) =>
							instance.context.db
								.select({ cacheId: attestationInheritances.cacheId })
								.from(attestationInheritances)
								.where(
									eq(
										attestationInheritances.storePathHash,
										metadata.storePathHash
									)
								)
								.all()
					);
					if (remaining.length === 0) {
						break;
					}
					await runInDurableObject(currentServer(), (instance) => {
						instance.context.db
							.update(attestationInheritances)
							.set({ notBefore: isoTimestamp(new Date()) })
							.where(
								eq(
									attestationInheritances.storePathHash,
									metadata.storePathHash
								)
							)
							.run();
					});
					continuation = await drainAlarm();
				}

				const predicateType = 'https://slsa.dev/provenance/v1';
				const expectedReferences = [defaultCache(), ...destinations].map(
					(cache) => ({
						tenant: fixtureTenant,
						cache,
						storePathHash: metadata.storePathHash,
						generation: 0,
						predicateType,
						digest: bundle.digest
					})
				);
				const references = await attestationReferenceRows();
				const destinationEdges = destinations.map((cache) => ({
					tenant: fixtureTenant,
					cache,
					storePathHash: metadata.storePathHash,
					generation: 0,
					narHash: metadata.narHash,
					cacheGeneration: firstCacheGeneration
				}));

				expect({
					continuation,
					queued: await runInDurableObject(currentServer(), (instance) =>
						deletionSnapshots(instance.context)
					),
					references
				}).toStrictEqual({
					continuation: [{ scope: 'tenant' }],
					queued,
					references: expectedReferences
				});

				await runMaintenanceAlarms(6);
				const retiredEdges = await blobReferenceRows();

				expect({
					queued: await narInfoDeletionRows(),
					references: await attestationReferenceRows(),
					edges: retiredEdges.toSorted((left, right) =>
						byCodeUnit(JSON.stringify(left.cache), JSON.stringify(right.cache))
					)
				}).toStrictEqual({
					queued: [],
					references: expectedReferences.slice(1),
					edges: destinationEdges
				});
			})
	);

	it.each([
		{ source: 'same', generation: 0, matchesNar: true, released: true },
		{ source: 'same', generation: 1, matchesNar: true, released: false },
		{ source: 'same', generation: 2, matchesNar: true, released: false },
		{ source: 'public', generation: 2, matchesNar: true, released: true },
		{ source: 'private', generation: 0, matchesNar: true, released: false },
		{ source: 'public', generation: 0, matchesNar: false, released: false }
	] as const)(
		'checks released deletion identity for $source generation $generation (matching NAR: $matchesNar)',
		async ({ source, generation, matchesNar, released }) => {
			const path = syntheticStorePathHash(84);
			const narHash = syntheticNarHash(84);
			const queuedNar = matchesNar ? narHash : syntheticNarHash(85);
			const createdAt = isoTimestamp(new Date());
			const result = await runInDurableObject(currentServer(), (instance) => {
				const destination = resolvedCache(instance.context);
				const sourceCache =
					source === 'same'
						? destination
						: instance.context.cacheRepository.resolveOrCreate(
								buildsCache,
								source
							);
				instance.context.db
					.insert(narInfoDeletions)
					.values({
						cacheId: sourceCache.id,
						storePathHash: path,
						narHash: queuedNar,
						generation: narInfoGenerationSchema.parse(generation),
						createdAt,
						explicit: false,
						protectionCutoff: undefined,
						protectionCapturedAt: undefined,
						withdrawn: true
					})
					.run();

				return {
					released: buildDeletionQueue(
						instance.context
					).hasDeletionReleasedByInheritance(
						destination.id,
						path,
						narInfoGenerationSchema.parse(1),
						narHash
					),
					queued: deletionSnapshots(instance.context),
					sourceId: sourceCache.id
				};
			});

			expect(result).toStrictEqual({
				released,
				queued: [
					{
						cacheId: result.sourceId,
						storePathHash: path,
						narHash: queuedNar,
						generation,
						createdAt,
						explicit: false,
						protectionCutoff: undefined,
						protectionCapturedAt: undefined,
						withdrawn: true
					}
				],
				sourceId: result.sourceId
			});
		}
	);

	it.each([
		{ name: 'a collection pass', withdrawnBy: 'collection' },
		{ name: 'a direct retirement', withdrawnBy: 'retirement' }
	] as const)(
		'retires a deletion that $name withdrew when the deferring upload expires',
		async ({ withdrawnBy }) => {
			const token = await initialise();
			const nar = await verifiableNar(`expired-deferral-${withdrawnBy}`);
			const metadata = uploadMetadata({
				storePathHash: 'g'.repeat(32),
				narHash: nar.narHash,
				narSize: nar.narSize,
				fileHash: nar.fileHash,
				fileSize: nar.narBytes.byteLength
			});
			const first = singleDecision(await negotiateUploads(token, [metadata]));
			const second = singleDecision(await negotiateUploads(token, [metadata]));

			if (first.action !== 'upload' || second.action !== 'upload') {
				throw new Error('both negotiations must plan an upload');
			}

			await putNarBytes(first.r2Key, nar);
			await commitUpload(token, first.uploadId);
			await runInDurableObject(currentServer(), async (instance, state) => {
				await buildAttestations(instance.context).drainInheritanceQueue(
					rootLogger()
				);
				await state.storage.deleteAlarm();
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

				if (withdrawnBy === 'collection') {
					await state.storage.put(gcContinuationKey, [{ scope: 'tenant' }]);
					return;
				}

				await asOneInvocation(() =>
					instance.context.criticalSection(() =>
						buildDeletionQueue(instance.context).retireQueuedNarInfoEdge(
							cache,
							metadata.storePathHash,
							narInfoGenerationSchema.parse(0)
						)
					)
				);
			});

			if (withdrawnBy === 'collection') {
				await runMaintenanceAlarms(6);
			}

			const beforeExpiry = await narInfoDeletionRows();
			const expiresAt = await runInDurableObject(
				currentServer(),
				(instance) =>
					instance.context.db
						.select({ expiresAt: pendingUploads.expiresAt })
						.from(pendingUploads)
						.where(eq(pendingUploads.id, second.uploadId))
						.get()?.expiresAt
			);

			if (expiresAt === undefined) {
				throw new Error('the second upload must still be pending');
			}

			vi.setSystemTime(Date.parse(expiresAt) + 1);
			await runMaintenanceAlarms(6);

			expect({
				beforeExpiry: beforeExpiry.length,
				queued: await narInfoDeletionRows(),
				edges: await blobReferenceRows()
			}).toStrictEqual({ beforeExpiry: 1, queued: [], edges: [] });
		}
	);

	it('resumes collection when the deferring upload expires while collection settles', async () => {
		const token = await initialise();
		const nar = await verifiableNar('expired-during-settlement');
		const metadata = uploadMetadata({
			storePathHash: 'h'.repeat(32),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		const first = singleDecision(await negotiateUploads(token, [metadata]));
		const second = singleDecision(await negotiateUploads(token, [metadata]));

		if (first.action !== 'upload' || second.action !== 'upload') {
			throw new Error('both negotiations must plan an upload');
		}

		await putNarBytes(first.r2Key, nar);
		await commitUpload(token, first.uploadId);
		const clearWake = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				await buildAttestations(instance.context).drainInheritanceQueue(
					rootLogger()
				);
				await state.storage.deleteAlarm();
				const cache = resolvedCache(instance.context);
				const queue = buildDeletionQueue(instance.context);
				const expiresAt = instance.context.db
					.select({ expiresAt: pendingUploads.expiresAt })
					.from(pendingUploads)
					.where(eq(pendingUploads.id, second.uploadId))
					.get()?.expiresAt;

				if (expiresAt === undefined) {
					throw new Error('the second upload must still be pending');
				}

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

				// The upload expires while settlement clears the stored wake. Install
				// the spy before collection can run, including from an alarm that the
				// runtime delivers on its own.
				const spy = vi
					.spyOn(DeletionQueueService.prototype, 'clearDeferralWake')
					.mockImplementationOnce(async () => {
						await queue.clearDeferralWake();
						vi.setSystemTime(Date.parse(expiresAt) + 1);
					});
				await state.storage.put(gcContinuationKey, [{ scope: 'tenant' }]);

				return spy;
			}
		);
		const hasExpiredDuringSettlement = await (async () => {
			try {
				await runMaintenanceAlarms(6);

				return clearWake.mock.calls.length > 0;
			} finally {
				clearWake.mockRestore();
			}
		})();

		expect({
			hasExpiredDuringSettlement,
			queued: await narInfoDeletionRows(),
			edges: await blobReferenceRows()
		}).toStrictEqual({
			hasExpiredDuringSettlement: true,
			queued: [],
			edges: []
		});
	});

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

	it('bounds authority revocation across 25,000 retained generations', async () => {
		const token = await initialise();
		const nar = await verifiableNar('revocation-generations-scale');
		const metadata = uploadMetadata({
			storePathHash: syntheticStorePathHash(79),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		await commitPath(token, metadata, nar);
		await env.CUPBOARD_DB.prepare(
			`WITH RECURSIVE source(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM source WHERE n < 24999)
			INSERT INTO blob_ref_storage(tenant, cache_kind, store_path_hash, generation, nar_hash, cache_generation)
			SELECT ?, 'default', ?, n, ?, 1 FROM source`
		)
			.bind(fixtureTenant, metadata.storePathHash, nar.narHash)
			.run();

		await env.CUPBOARD_DB.prepare(
			`WITH RECURSIVE source(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM source WHERE n < 25000)
   INSERT INTO attestation_ref_storage(tenant,cache_kind,store_path_hash,generation,predicate_type,digest)
   SELECT ?, 'default', ?, 0, 'https://example.com/predicate', printf('%064x',n) FROM source`
		)
			.bind(fixtureTenant, metadata.storePathHash)
			.run();

		await env.CUPBOARD_DB.prepare(
			`WITH RECURSIVE source(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM source WHERE n < 25000)
			INSERT INTO cache_lifecycle_storage(tenant,cache_kind,cache_name,access,generation,updated_at)
			SELECT ?, 'named', printf('migration-cache-%08d',n), 'public', 1, '2026-01-01T00:00:00.000Z' FROM source`
		)
			.bind(fixtureTenant)
			.run();

		await env.CUPBOARD_DB.batch(
			[
				'DROP VIEW attestation_ref',
				'DROP VIEW blob_ref',
				'ALTER TABLE blob_ref_storage RENAME TO blob_ref',
				'ALTER TABLE attestation_ref_storage RENAME TO attestation_ref',
				'CREATE VIEW blob_ref_storage AS SELECT * FROM blob_ref',
				'CREATE VIEW attestation_ref_storage AS SELECT * FROM attestation_ref',
				'DROP VIEW cache_lifecycle',
				'ALTER TABLE cache_lifecycle_storage RENAME TO cache_lifecycle',
				'CREATE VIEW cache_lifecycle_storage AS SELECT * FROM cache_lifecycle'
			].map((query) => env.CUPBOARD_DB.prepare(query))
		);
		const contract = env.TEST_MIGRATIONS.find(
			(migration) => migration.name === '0036_path_read_authority_contract.sql'
		);
		if (contract === undefined) {
			throw new Error('The path read authority contract migration is missing.');
		}
		const contractResults = await env.CUPBOARD_DB.batch(
			contract.queries.map((query) => env.CUPBOARD_DB.prepare(query))
		);
		expect(
			contractResults.map((result) => ({
				rows: result.results,
				read: result.meta.rows_read,
				written: result.meta.rows_written
			}))
		).toStrictEqual([
			{ rows: [], read: 80, written: 0 },
			{ rows: [], read: 79, written: 0 },
			{ rows: [], read: 327, written: 44 },
			{ rows: [], read: 323, written: 42 },
			{ rows: [], read: 1, written: 2 },
			{ rows: [], read: 1, written: 2 },
			{ rows: [], read: 80, written: 0 },
			{ rows: [], read: 316, written: 37 },
			{ rows: [], read: 1, written: 2 }
		]);

		const precedingAdmission = await env.CUPBOARD_DB.prepare(
			'SELECT count(*) AS admitted FROM cache_lifecycle WHERE tenant = ?'
		)
			.bind(fixtureTenant)
			.all();
		expect({
			rows: precedingAdmission.results,
			read: precedingAdmission.meta.rows_read,
			written: precedingAdmission.meta.rows_written
		}).toStrictEqual({ rows: [{ admitted: 0 }], read: 0, written: 0 });

		const costs: { read: number; written: number }[] = [];
		const binding: D1Database = {
			prepare: (query) => env.CUPBOARD_DB.prepare(query),
			async batch<T>(statements: D1PreparedStatement[]) {
				const results = await env.CUPBOARD_DB.batch<T>(statements);
				costs.push(
					...results.map((result) => ({
						read: result.meta.rows_read,
						written: result.meta.rows_written
					}))
				);
				return results;
			},
			exec: (query) => env.CUPBOARD_DB.exec(query),
			withSession: (constraint) => env.CUPBOARD_DB.withSession(constraint),
			dump: () =>
				Promise.reject(new Error('The scale fixture does not dump D1.'))
		};
		await runInDurableObject(currentServer(), async (instance, state) => {
			const context = new ServerContext(state, {
				...instance.context.env,
				CUPBOARD_DB: binding
			});
			const cache = resolvedCache(context);
			context.db
				.update(narInfos)
				.set({ generation: narInfoGenerationSchema.parse(24_999) })
				.where(eq(narInfos.storePathHash, metadata.storePathHash))
				.run();
			context.db
				.insert(attestationInheritances)
				.values({
					cacheId: cache.id,
					storePathHash: metadata.storePathHash,
					generation: narInfoGenerationSchema.parse(25_000),
					narHash: nar.narHash,
					notBefore: isoTimestamp(new Date())
				})
				.run();
			await buildDeletionQueue(context).deleteStorePath(
				defaultCache(),
				metadata.storePathHash,
				internalOrigin
			);
		});
		const revocationCosts = [...costs];
		costs.length = 0;
		await runInDurableObject(currentServer(), async (instance, state) => {
			const context = new ServerContext(state, {
				...instance.context.env,
				CUPBOARD_DB: binding
			});
			const service = new PathReadAuthorityService(context);
			for (let page = 0; page < 250; page++) {
				await service.drain();
			}
			await service.drain();
			expect(await service.hasPending()).toBe(false);
		});
		const retained = await env.CUPBOARD_DB.prepare(
			'SELECT count(*) AS total, sum(readable) AS readable FROM blob_ref_storage WHERE tenant = ? AND store_path_hash = ?'
		)
			.bind(fixtureTenant, metadata.storePathHash)
			.first();
		const bundles = await env.CUPBOARD_DB.prepare(
			'SELECT count(*) AS total, sum(readable) AS readable FROM attestation_ref_storage WHERE tenant = ? AND store_path_hash = ?'
		)
			.bind(fixtureTenant, metadata.storePathHash)
			.first();
		expect({
			revocationCosts,
			maxRead: Math.max(...costs.map((row) => row.read)),
			maxWritten: Math.max(...costs.map((row) => row.written)),
			retained,
			bundles
		}).toStrictEqual({
			revocationCosts: [{ read: 0, written: 4 }],
			maxRead: 600,
			maxWritten: 100,
			retained: { total: 25_000, readable: 0 },
			bundles: { total: 25_000, readable: 0 }
		});
		const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
		const reclaim = reclaimPathReadFence(
			database,
			fixtureTenant,
			defaultCache(),
			jsonRowList([{ storePathHash: metadata.storePathHash }])
		).toSQL();
		const kept = await env.CUPBOARD_DB.prepare(reclaim.sql)
			.bind(...reclaim.params)
			.run();
		await env.CUPBOARD_DB.prepare(
			'DELETE FROM blob_ref_storage WHERE tenant = ? AND store_path_hash = ?'
		)
			.bind(fixtureTenant, metadata.storePathHash)
			.run();
		await env.CUPBOARD_DB.prepare(
			'DELETE FROM attestation_ref_storage WHERE tenant = ? AND store_path_hash = ?'
		)
			.bind(fixtureTenant, metadata.storePathHash)
			.run();
		await database.insert(d1Schema.blobReference).values({
			tenant: fixtureTenant,
			cacheKind: 'default',
			storePathHash: metadata.storePathHash,
			generation: narInfoGenerationSchema.parse(25_000),
			narHash: metadata.narHash,
			cacheGeneration: firstCacheGeneration
		});
		const reclaimed = await env.CUPBOARD_DB.prepare(reclaim.sql)
			.bind(...reclaim.params)
			.run();
		const fences = await database
			.select()
			.from(d1Schema.pathReadRevocation)
			.where(eq(d1Schema.pathReadRevocation.tenant, fixtureTenant));
		expect({
			kept: { read: kept.meta.rows_read, written: kept.meta.rows_written },
			reclaimed: {
				read: reclaimed.meta.rows_read,
				written: reclaimed.meta.rows_written
			},
			fences
		}).toStrictEqual({
			kept: { read: 4, written: 0 },
			reclaimed: { read: 6, written: 1 },
			fences: []
		});
	});

	it('continues to later caches when a lower cache publishes a new generation', async () => {
		await initialise();
		const result = await runInDurableObject(
			currentServer(),
			(instance, state) => {
				const context = instance.context;
				const cache = resolvedCache(context);
				const path = syntheticStorePathHash(95);
				const narHash = syntheticNarHash(95);
				const generation = narInfoGenerationSchema.parse(1);
				state.storage.sql.exec(
					"INSERT INTO cache_identity(id, kind, name, access, priority, created_at) VALUES (10, 'named', 'first-source', 'public', 40, ?), (11, 'named', 'later-source', 'public', 40, ?)",
					isoTimestamp(testBase),
					isoTimestamp(testBase)
				);
				state.storage.sql.exec(
					'INSERT INTO narinfo_deletion(cache_id, store_path_hash, nar_hash, generation, created_at) VALUES (10, ?, ?, 0, ?), (11, ?, ?, 0, ?)',
					path,
					narHash,
					isoTimestamp(testBase),
					path,
					narHash,
					isoTimestamp(testBase)
				);
				context.db
					.insert(attestationInheritances)
					.values({
						cacheId: cache.id,
						storePathHash: path,
						generation,
						narHash,
						notBefore: isoTimestamp(testBase)
					})
					.run();
				const service = new ProtectedInheritanceService(context);
				const first = service.nextSource(cache, path, narHash, generation);
				if (first === undefined) {
					throw new Error('The first source must exist.');
				}
				service.advanceSource(cache, path, generation, first);
				state.storage.sql.exec(
					'INSERT INTO narinfo_deletion(cache_id, store_path_hash, nar_hash, generation, created_at) VALUES (10, ?, ?, 1, ?)',
					path,
					narHash,
					isoTimestamp(testBase)
				);
				const next = service.nextSource(cache, path, narHash, generation);
				return {
					first: { cacheId: first.cacheId, generation: first.generation },
					next:
						next === undefined
							? undefined
							: { cacheId: next.cacheId, generation: next.generation }
				};
			}
		);
		expect(result).toStrictEqual({
			first: { cacheId: 10, generation: 0 },
			next: { cacheId: 11, generation: 0 }
		});
	});

	it(
		'bounds source lookup and mutation costs with 25,000 source and destination generations',
		{ timeout: 120_000 },
		async () => {
			await initialise();
			const result = await withoutAlarmArming(() =>
				runInDurableObject(currentServer(), async (instance, state) => {
					const context = instance.context;
					const cache = resolvedCache(context);
					const path = storePathHashSchema.parse('a'.repeat(32));
					const narHash = syntheticNarHash(1);
					const generation = narInfoGenerationSchema.parse(1);
					const now = isoTimestamp(testBase);
					state.storage.sql.exec(
						`WITH RECURSIVE rows(value) AS (VALUES(100) UNION ALL SELECT value + 1 FROM rows WHERE value < 25_099)
			INSERT INTO cache_identity(id, kind, name, access, priority, created_at) SELECT value, 'named', printf('source-%08d', value), 'public', 40, ? FROM rows`,
						now
					);
					state.storage.sql.exec(
						`WITH RECURSIVE rows(value) AS (VALUES(100) UNION ALL SELECT value + 1 FROM rows WHERE value < 25_099)
			INSERT INTO narinfo_deletion(cache_id, store_path_hash, nar_hash, generation, created_at, explicit, protection_cutoff, protection_captured_at) SELECT value, ?, ?, 0, ?, 1, 10, ? FROM rows`,
						path,
						narHash,
						now,
						now
					);
					state.storage.sql.exec(
						`WITH RECURSIVE rows(value) AS (VALUES(100) UNION ALL SELECT value + 1 FROM rows WHERE value < 25_099)
			INSERT INTO attestation_inheritance(cache_id, store_path_hash, nar_hash, generation, not_before) SELECT value, ?, ?, 1, ? FROM rows`,
						path,
						narHash,
						now
					);
					state.storage.sql.exec(
						'INSERT INTO attestation_inheritance(cache_id, store_path_hash, nar_hash, generation, not_before) VALUES (?, ?, ?, 1, ?)',
						cache.id,
						path,
						narHash,
						now
					);
					state.storage.sql.exec(
						'INSERT INTO narinfo_deletion(cache_id, store_path_hash, nar_hash, generation, created_at) VALUES (?, ?, ?, 0, ?)',
						cache.id,
						path,
						narHash,
						now
					);
					state.storage.sql.exec(
						'UPDATE work_sequence SET value = 10 WHERE id = 1'
					);
					const service = new ProtectedInheritanceService(context);
					const meter = context.dbCost;
					const measure = <T>(body: () => T) => {
						meter.recordOutstanding();
						const before = {
							rowsRead: meter.rowsRead,
							rowsWritten: meter.rowsWritten
						};
						const value = body();
						meter.recordOutstanding();
						return {
							value,
							cost: {
								rowsRead: meter.rowsRead - before.rowsRead,
								rowsWritten: meter.rowsWritten - before.rowsWritten
							}
						};
					};
					const capture = measure(() => {
						service.capture(
							context.db,
							cache,
							{
								storePathHash: path,
								generation: narInfoGenerationSchema.parse(0)
							},
							now
						);
					});
					const names: string[] = [];
					let pages = 0;
					let maxRead = 0;
					let maxWrite = 0;
					for (let visited = 0; visited <= 25_001; visited += 1) {
						const { cost, value: source } = measure(() => {
							const source = service.nextSource(
								cache,
								path,
								narHash,
								generation
							);
							if (source === undefined) {
								return;
							}
							if (
								source.scope !== undefined &&
								service.isReferenceProtected(
									cache,
									path,
									generation,
									source.cacheId,
									source.generation
								)
							) {
								names.push(source.cache?.name ?? '');
							}
							service.advanceSource(cache, path, generation, source);
							return source;
						});
						if (source === undefined) {
							break;
						}
						pages += 1;
						maxRead = Math.max(maxRead, cost.rowsRead);
						maxWrite = Math.max(maxWrite, cost.rowsWritten);
					}

					const expiresAt = isoTimestamp(new Date(testBase.getTime() + 60_000));
					const uploadId = uploadIdSchema.parse(
						'00000000-0000-4000-8000-000000000001'
					);
					state.storage.sql.exec(
						'INSERT INTO pending_upload(id, cache_id, nar_hash, r2_key, metadata_json, created_at, expires_at, accepted_sequence) VALUES (?, ?, ?, ?, ?, ?, ?, 10)',
						uploadId,
						cache.id,
						narHash,
						'staging/test',
						JSON.stringify({ storePathHash: path }),
						now,
						expiresAt
					);
					meter.recordOutstanding();
					const beforeTransfer = {
						rowsRead: meter.rowsRead,
						rowsWritten: meter.rowsWritten
					};
					await buildAttestations(context).queueInheritance(
						cache,
						path,
						narInfoGenerationSchema.parse(2),
						narHash,
						uploadId
					);
					meter.recordOutstanding();
					const transfer = {
						rowsRead: meter.rowsRead - beforeTransfer.rowsRead,
						rowsWritten: meter.rowsWritten - beforeTransfer.rowsWritten
					};
					const release = measure(() => {
						service.releaseDestination(cache.id, path, generation);
					});
					const retire = measure(() =>
						context.db
							.delete(narInfoDeletions)
							.where(
								and(
									eq(narInfoDeletions.cacheId, cache.id),
									eq(narInfoDeletions.storePathHash, path)
								)
							)
							.run()
					);
					return {
						names,
						pages,
						maxRead,
						maxWrite,
						capture: capture.cost,
						transfer,
						release: release.cost,
						retire: retire.cost
					};
				})
			);
			expect(result).toStrictEqual({
				names: [
					'',
					...Array.from(
						{ length: 25_000 },
						(_unused, index) => `source-${String(index + 100).padStart(8, '0')}`
					)
				],
				pages: 25_001,
				maxRead: 15,
				maxWrite: 3,
				capture: { rowsRead: 2, rowsWritten: 3 },
				transfer: { rowsRead: 3, rowsWritten: 6 },
				release: { rowsRead: 1, rowsWritten: 1 },
				retire: { rowsRead: 4, rowsWritten: 1 }
			});
		}
	);

	it('excludes 25,000 destinations accepted after deletion from indexed deferral probes', async () => {
		await initialise();
		const costs = await runInDurableObject(
			currentServer(),
			(instance, state) => {
				const context = instance.context;
				const cache = resolvedCache(context);
				const path = syntheticStorePathHash(99);
				const narHash = syntheticNarHash(99);
				const now = isoTimestamp(testBase);
				state.storage.sql.exec(
					'INSERT INTO narinfo_deletion(cache_id, store_path_hash, nar_hash, generation, created_at, explicit, protection_cutoff, protection_captured_at) VALUES (?, ?, ?, 0, ?, 1, 1, ?)',
					cache.id,
					path,
					narHash,
					now,
					now
				);
				const measure = () => {
					context.dbCost.recordOutstanding();
					const before = context.dbCost.rowsRead;
					const row = context.db
						.select({ isDeferred: deferredDeletionCondition(now) })
						.from(narInfoDeletions)
						.where(eq(narInfoDeletions.storePathHash, path))
						.get();
					context.dbCost.recordOutstanding();
					return { row, rowsRead: context.dbCost.rowsRead - before };
				};
				const baseline = measure();
				const expiresAt = isoTimestamp(new Date(testBase.getTime() + 60_000));
				state.storage.sql.exec(
					`WITH RECURSIVE rows(value) AS (VALUES(1) UNION ALL SELECT value + 1 FROM rows WHERE value < 25000)
			INSERT INTO pending_upload(id, cache_id, nar_hash, r2_key, metadata_json, created_at, expires_at, accepted_sequence) SELECT printf('future-%d', value), ?, ?, 'staging/future', ?, ?, ?, value + 1 FROM rows`,
					cache.id,
					narHash,
					JSON.stringify({ storePathHash: path }),
					now,
					expiresAt
				);
				state.storage.sql.exec(
					`WITH RECURSIVE rows(value) AS (VALUES(1) UNION ALL SELECT value + 1 FROM rows WHERE value < 25000)
			INSERT INTO attestation_inheritance(cache_id, store_path_hash, nar_hash, generation, not_before, accepted_sequence, queued_sequence) SELECT ?, ?, ?, value, ?, value + 1, value + 2 FROM rows`,
					cache.id,
					path,
					narHash,
					now
				);
				return [baseline, measure()];
			}
		);
		expect(costs).toStrictEqual([
			{ row: { isDeferred: false }, rowsRead: 3 },
			{ row: { isDeferred: false }, rowsRead: 3 }
		]);
	});

	it('seeks pending inheritance by path and NAR without scanning cache history', async () => {
		await initialise();
		const details = await runInDurableObject(
			currentServer(),
			(instance, state) => {
				const statement = instance.context.db
					.select({
						isDeferred: deferredDeletionCondition(isoTimestamp(testBase))
					})
					.from(narInfoDeletions)
					.toSQL();
				const parameters = z
					.array(z.union([z.string(), z.number(), z.null()]))
					.parse(statement.params);
				return Array.from(
					state.storage.sql.exec<{ detail: string }>(
						`EXPLAIN QUERY PLAN ${statement.sql}`,
						...parameters
					),
					(row) => row.detail
				).filter(
					(detail) =>
						detail.includes('pending_upload') ||
						detail.includes('attestation_inheritance') ||
						detail.includes('cache_identity')
				);
			}
		);
		expect(details).toStrictEqual([
			'SEARCH pending_upload USING INDEX pending_upload_inheritance_cutoff_idx (<expr>=? AND nar_hash=? AND accepted_sequence<?)',
			'SEARCH cache_identity USING INTEGER PRIMARY KEY (rowid=?)',
			'SEARCH attestation_inheritance USING COVERING INDEX attestation_inheritance_cutoff_idx (store_path_hash=? AND nar_hash=? AND accepted_sequence<?)',
			'SEARCH cache_identity USING INTEGER PRIMARY KEY (rowid=?)',
			'SEARCH cache_identity USING INTEGER PRIMARY KEY (rowid=?)',
			'SEARCH pending_upload USING INDEX pending_upload_inheritance_path_idx (<expr>=? AND nar_hash=?)',
			'SEARCH attestation_inheritance USING COVERING INDEX attestation_inheritance_path_nar_idx (store_path_hash=? AND nar_hash=?)',
			'SEARCH pending_upload USING INDEX pending_upload_inheritance_path_idx (<expr>=? AND nar_hash=? AND cache_id=?)',
			'SEARCH attestation_inheritance USING COVERING INDEX attestation_inheritance_path_nar_idx (store_path_hash=? AND nar_hash=? AND cache_id=? AND generation>?)'
		]);
	});

	it('reads the same rows in a flush however many uploads are pending in the cache', async () => {
		await initialise();
		const entries = syntheticEntries(8);
		const flushRowsRead = async (
			batch: readonly TornDownNarInfo[]
		): Promise<number> => {
			await seedQueuedDeletions(batch);

			return runInDurableObject(currentServer(), async (instance) => {
				const { dbCost } = instance.context;
				dbCost.recordOutstanding();
				const before = dbCost.rowsRead;

				await asOneInvocation(() =>
					instance.context.criticalSection(() =>
						buildDeletionQueue(instance.context).flushQueuedNarInfoDeletions()
					)
				);
				dbCost.recordOutstanding();

				return dbCost.rowsRead - before;
			});
		};

		const withoutUploads = await flushRowsRead(entries.slice(0, 4));
		await runInDurableObject(currentServer(), (instance, state) => {
			state.storage.sql.exec(
				`WITH digits(digit) AS (VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)),
				 rows(value) AS (
				   SELECT ones.digit + tens.digit * 10 + hundreds.digit * 100
				   FROM digits AS ones CROSS JOIN digits AS tens CROSS JOIN digits AS hundreds
				 )
				 INSERT INTO pending_upload
				   (id, cache_id, nar_hash, r2_key, metadata_json, created_at, expires_at, verdict)
				 SELECT printf('pending-%d', value), ?, ?, printf('staging/pending-%d', value),
				        json_object('storePathHash', printf('p%031d', value)),
				        '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z', 'pending'
				 FROM rows`,
				resolvedCache(instance.context).id,
				syntheticNarHash(0)
			);
		});
		await runInDurableObject(currentServer(), (_instance, state) => {
			state.storage.sql.exec(
				`WITH RECURSIVE rows(value) AS (VALUES (1) UNION ALL SELECT value + 1 FROM rows WHERE value < 1000)
				 INSERT INTO cache_identity (kind, name, access, priority, created_at, deleted_at)
				 SELECT 'named', printf('historic-%d', value), 'public', 40,
				 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z' FROM rows`
			);
		});
		const withUploads = await flushRowsRead(entries.slice(4));

		expect({ withoutUploads, withUploads }).toStrictEqual({
			withoutUploads: 82,
			withUploads: 82
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
						matches: (query) =>
							query.startsWith('delete from "blob_ref_storage"')
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
