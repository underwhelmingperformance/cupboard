import { rootLogger } from '@cupboard/logger';
import {
	type CacheScope,
	graceSecondsSchema,
	narInfoGenerationSchema,
	rootNameSchema,
	storePathHashSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import {
	type AuthorizationDetails,
	authorizationDetailsSchema
} from '@cupboard/protocol/grants';
import {
	type IsoTimestamp,
	isoTimestamp,
	isoTimestampSchema
} from '@cupboard/protocol/scalars';
import { type UploadId, uploadIdSchema } from '@cupboard/protocol/upload';
import {
	acceptCapabilitiesHeader,
	uploadCapabilitiesHeader,
	uploadCapabilitiesValue,
	uploadConfirmMaxPaths,
	type UploadConfirmResponseInput,
	uploadConfirmResponseSchema,
	uploadGraceFactsCapability,
	uploadNegotiateResponseSchema
} from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cacheIdentityColumns } from '../db/cache.ts';
import { currentCacheGeneration } from '../db/cache-generation.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import {
	narInfoObjectKey,
	narObjectKey,
	r2ObjectKeySchema,
	requestOriginSchema
} from '../http/http.ts';
import { verifyTenant } from '../routing/scheduled.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	asOneInvocation,
	authorisedFetch,
	bootstrap,
	cacheWriteGrants,
	clearBlobStorage,
	commitUpload,
	currentNarObjectKey,
	currentServer,
	currentServerTenant,
	defaultCache,
	deletePath,
	drivenDirectly,
	expectSingleUploadDecision,
	flakyD1,
	issueServerSignedToken,
	listRoots,
	listRootTargets,
	markUploadPendingVerification,
	namedCache,
	narBytes,
	narInfoGeneration,
	negotiateUploads,
	openCommitSession,
	pendingUploadVerdict,
	pushPath,
	putNarBytes,
	removeRoot,
	resetTestServer,
	resolvedCache,
	setRoot,
	singleDecision,
	testPushId,
	uploadMetadata,
	uploadPathNegotiation,
	useTestServer,
	verifiableNar,
	verifyCurrentTenant
} from '../test-support.ts';

import { AttestationCasService } from './attestation-cas-service.ts';
import { AttestationsService } from './attestations-service.ts';
import { CommitPipelineService } from './commit-pipeline-service.ts';
import { ServerContext } from './context.ts';
import { DeletionQueueService } from './deletion-queue-service.ts';
import {
	maxExpiredRootTargetsPerRun,
	maxPathsCollectedPerRun,
	maxRootsExpiredPerRun
} from './garbage-collection-service.ts';
import {
	confirmGraceBatch,
	parseStoredGraceDecision,
	serialiseGraceDecision
} from './grace-decision.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';
import { ReconcileQueueService } from './reconcile-queue-service.ts';
import { RetentionService } from './retention-service.ts';
import { RootsService } from './roots-service.ts';
import { gcContinuationKey } from './server.ts';
import { SigningKeysService } from './signing-keys-service.ts';
import { UploadStateService } from './upload-state-service.ts';
import { UploadsService } from './uploads-service.ts';
import { VerificationService } from './verification-service.ts';

const repeated = (character: string): string => character.repeat(32);
const tenantWideContinuation = {
	scope: 'tenant',
	collectLimit: maxPathsCollectedPerRun
};

function pipelineFor(context: ServerContext): CommitPipelineService {
	const narInfoObjects = new NarInfoObjectsService(context);

	return new CommitPipelineService(
		context,
		new SigningKeysService(context, narInfoObjects),
		new UploadStateService(context),
		narInfoObjects,
		new RetentionService(context)
	);
}

function uploadsServiceFor(context: ServerContext): UploadsService {
	const narInfoObjects = new NarInfoObjectsService(context);
	const attestationCas = new AttestationCasService(context);
	const attestations = new AttestationsService(
		context,
		attestationCas,
		narInfoObjects
	);
	const deletionQueue = new DeletionQueueService(
		context,
		attestationCas,
		attestations,
		narInfoObjects
	);

	const retention = new RetentionService(context);

	return new UploadsService(
		context,
		new UploadStateService(context),
		narInfoObjects,
		deletionQueue,
		new ReconcileQueueService(context),
		retention,
		new RootsService(context, retention, narInfoObjects)
	);
}

const buildsCache = namedCache('builds');
const pr5Cache = namedCache('pr-5');

// The shared test clock is pinned to 2026-01-01, so these bracket "now".
const liveDeadline = isoTimestampSchema.parse('2026-06-01T00:00:00.000Z');
const expiredDeadline = isoTimestampSchema.parse('2025-12-01T00:00:00.000Z');

async function seedGraceDeadline(
	cache: CacheScope,
	storePathHash: string,
	retainUntil: IsoTimestamp
): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		const resolved = resolvedCache(instance.context, cache);

		instance.context.db
			.insert(schema.retentionGrace)
			.values({
				cacheId: resolved.id,
				storePathHash: storePathHashSchema.parse(storePathHash),
				retainUntil
			})
			.run();
	});
}

async function markGraceManaged(cache: CacheScope): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		const resolved = resolvedCache(instance.context, cache);

		instance.context.db
			.update(schema.caches)
			.set({ graceManaged: true })
			.where(eq(schema.caches.id, resolved.id))
			.run();
	});
}

async function graceDeadlines(cache: CacheScope): Promise<readonly string[]> {
	return runInDurableObject(currentServer(), (instance) => {
		const resolved = instance.context.cacheRepository.resolve(cache);

		if (resolved === undefined) {
			return [];
		}

		return instance.context.db
			.select({ storePathHash: schema.retentionGrace.storePathHash })
			.from(schema.retentionGrace)
			.where(eq(schema.retentionGrace.cacheId, resolved.id))
			.all()
			.map((row) => row.storePathHash);
	});
}

async function runGc(): Promise<void> {
	await currentServer().runGarbageCollection();
}

describe('retention grace deadlines in garbage collection', () => {
	beforeEach(resetTestServer);

	it('keeps a live deadline and its transitive closure through a collection', async () => {
		await useTestServer('grace-live-closure');
		const { token } = await bootstrap();

		const dependency = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('a'),
			name: 'dependency'
		});
		const kept = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('b'),
			name: 'kept',
			references: [
				`${repeated('b')}-kept`,
				`${dependency.storePathHash}-dependency`
			]
		});
		const collectable = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('c'),
			name: 'collectable'
		});

		await pushPath(token, dependency);
		await pushPath(token, kept);
		await pushPath(token, collectable);
		await seedGraceDeadline(defaultCache(), kept.storePathHash, liveDeadline);

		await runGc();

		expect({
			kept: (await narInfoGeneration(kept.storePathHash)) !== undefined,
			dependency:
				(await narInfoGeneration(dependency.storePathHash)) !== undefined,
			collectable:
				(await narInfoGeneration(collectable.storePathHash)) !== undefined,
			deadlines: await graceDeadlines(defaultCache())
		}).toStrictEqual({
			kept: true,
			dependency: true,
			collectable: false,
			deadlines: [kept.storePathHash]
		});
	});

	it('drains a grace-managed cache once its deadlines expire', async () => {
		await useTestServer('grace-expiry-drain');
		const { token } = await bootstrap();

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('d'),
			name: 'expiring'
		});

		await pushPath(token, path);
		await seedGraceDeadline(
			defaultCache(),
			path.storePathHash,
			expiredDeadline
		);
		await markGraceManaged(defaultCache());

		await runGc();

		expect({
			path: await narInfoGeneration(path.storePathHash),
			deadlines: await graceDeadlines(defaultCache())
		}).toStrictEqual({ path: undefined, deadlines: [] });
	});

	it('drains a grace-managed cache with no deadlines', async () => {
		await useTestServer('grace-managed-empty');
		const { token } = await bootstrap();

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('g'),
			name: 'drained'
		});

		await pushPath(token, path);
		await markGraceManaged(defaultCache());

		await runGc();

		expect(await narInfoGeneration(path.storePathHash)).toBeUndefined();
	});

	it('keeps the empty-cache guard for a cache never grace-managed', async () => {
		await useTestServer('grace-guard-kept');
		const { token } = await bootstrap();

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('f'),
			name: 'guarded'
		});

		await pushPath(token, path);

		await runGc();

		expect(await narInfoGeneration(path.storePathHash)).not.toBeUndefined();
	});

	it('drains a large expired closure across capped continuation runs', async () => {
		await useTestServer('grace-capped-drain');
		const { token } = await bootstrap();

		const first = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('1'),
			name: 'first'
		});
		const second = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('2'),
			name: 'second'
		});

		await pushPath(token, first);
		await pushPath(token, second);
		await seedGraceDeadline(
			defaultCache(),
			first.storePathHash,
			expiredDeadline
		);
		await seedGraceDeadline(
			defaultCache(),
			second.storePathHash,
			expiredDeadline
		);
		await markGraceManaged(defaultCache());

		await currentServer().runGarbageCollection(1);

		const remaining = async (): Promise<number> => {
			const generations = await Promise.all([
				narInfoGeneration(first.storePathHash),
				narInfoGeneration(second.storePathHash)
			]);

			return generations.filter((generation) => generation !== undefined)
				.length;
		};

		await vi.waitFor(async () => {
			await runInDurableObject(currentServer(), (instance) => instance.alarm());
			expect(await remaining()).toBe(0);
			expect(
				await runInDurableObject(currentServer(), (_instance, state) =>
					state.storage.get(gcContinuationKey)
				)
			).toBeUndefined();
		});
	});

	it('deletes the deadline with its narinfo', async () => {
		await useTestServer('grace-delete-cascade');
		const { token } = await bootstrap();

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('9'),
			name: 'deleted'
		});

		await pushPath(token, path);
		await seedGraceDeadline(defaultCache(), path.storePathHash, liveDeadline);

		const outcome = await deletePath(
			token,
			storePathHashSchema.parse(path.storePathHash)
		);

		expect({
			deleted: outcome.deleted,
			deadlines: await graceDeadlines(defaultCache())
		}).toStrictEqual({ deleted: true, deadlines: [] });
	});

	it('cache deletion removes its deadlines and grace-managed marker', async () => {
		await useTestServer('grace-cache-deletion');
		const { token } = await bootstrap({ caches: [{ scope: buildsCache }] });

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('8'),
			name: 'torn-down'
		});

		await pushPath(token, path, buildsCache);
		await seedGraceDeadline(buildsCache, path.storePathHash, liveDeadline);
		await markGraceManaged(buildsCache);

		const response = await authorisedFetch('/caches/builds?force=true', token, {
			method: 'DELETE'
		});
		const registryRow = await runInDurableObject(currentServer(), (instance) =>
			instance.context.db
				.select({ name: schema.caches.name })
				.from(schema.caches)
				.where(
					and(
						eq(schema.caches.name, buildsCache.name),
						isNull(schema.caches.deletedAt)
					)
				)
				.get()
		);

		expect({
			status: response.status,
			deadlines: await graceDeadlines(buildsCache),
			registryRow
		}).toStrictEqual({
			status: StatusCodes.OK,
			deadlines: [],
			registryRow: undefined
		});
	});
});

async function setDefaultCacheGrace(graceSeconds: number): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		const cache = resolvedCache(instance.context, defaultCache());

		instance.context.db
			.update(schema.caches)
			.set({ graceSeconds: graceSecondsSchema.parse(graceSeconds) })
			.where(eq(schema.caches.id, cache.id))
			.run();
	});
}

async function clearDefaultCacheGrace(): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		const cache = resolvedCache(instance.context, defaultCache());

		instance.context.db
			.update(schema.caches)
			.set({ graceSeconds: sql`NULL` })
			.where(eq(schema.caches.id, cache.id))
			.run();
	});
}

async function graceDeadlineRows(
	cache: CacheScope
): Promise<readonly { storePathHash: string; retainUntil: string }[]> {
	return runInDurableObject(currentServer(), (instance) => {
		const resolved = resolvedCache(instance.context, cache);

		return instance.context.db
			.select({
				storePathHash: schema.retentionGrace.storePathHash,
				retainUntil: schema.retentionGrace.retainUntil
			})
			.from(schema.retentionGrace)
			.where(eq(schema.retentionGrace.cacheId, resolved.id))
			.orderBy(schema.retentionGrace.storePathHash)
			.all();
	});
}

async function hasGraceManagedMarker(cache: CacheScope): Promise<boolean> {
	return runInDurableObject(currentServer(), (instance) => {
		const resolved = instance.context.cacheRepository.resolve(cache);

		if (resolved === undefined) {
			return false;
		}

		return (
			instance.context.db
				.select({ graceManaged: schema.caches.graceManaged })
				.from(schema.caches)
				.where(eq(schema.caches.id, resolved.id))
				.get()?.graceManaged ?? false
		);
	});
}

describe('retention grace transitions', () => {
	beforeEach(resetTestServer);

	// The shared clock starts at 2026-01-01T00:00:00Z, so a 24-hour grace from a
	// transition processed immediately lands on the next midnight.
	const dayGraceSeconds = graceSecondsSchema.parse(86_400);
	const dayAfterStart = '2026-01-02T00:00:00.000Z';

	it('grants deadlines to the targets a replacement releases', async () => {
		await useTestServer('transition-replace');
		const { token } = await bootstrap();

		const kept = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('a'),
			name: 'kept'
		});
		const released = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('b'),
			name: 'released'
		});

		await pushPath(token, kept);
		await pushPath(token, released);
		// Grace is configured only after publication, so the replacement below is
		// the sole source of any deadline.
		await setDefaultCacheGrace(dayGraceSeconds);
		await setRoot(token, {
			name: 'channel',
			targets: [kept.storePath, released.storePath]
		});
		await setRoot(token, { name: 'channel', targets: [kept.storePath] });

		expect({
			deadlines: await graceDeadlineRows(defaultCache()),
			graceManaged: await hasGraceManagedMarker(defaultCache())
		}).toStrictEqual({
			deadlines: [
				{ storePathHash: released.storePathHash, retainUntil: dayAfterStart }
			],
			graceManaged: true
		});
	});

	it('replaces a root with an empty target set and releases every target', async () => {
		await useTestServer('transition-settle-empty');
		const { token } = await bootstrap();

		const released = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('c'),
			name: 'released'
		});

		await pushPath(token, released);
		await setDefaultCacheGrace(dayGraceSeconds);
		await setRoot(token, { name: 'channel', targets: [released.storePath] });

		// Replacing the target set must preserve the root row and its expiry while
		// granting grace to the released path.
		const settled = await setRoot(token, { name: 'channel', targets: [] });
		const { roots } = await listRoots(token);
		const remaining = await listRootTargets(token, 'channel');
		const deadlines = await graceDeadlineRows(defaultCache());

		await runGc();
		const wasHeldDuringGrace =
			(await narInfoGeneration(released.storePathHash)) !== undefined;

		vi.setSystemTime(new Date('2026-01-03T00:00:00.000Z'));
		await runGc();

		expect({
			settled,
			roots,
			remaining: remaining.targets,
			deadlines,
			duringGrace: wasHeldDuringGrace,
			afterGrace:
				(await narInfoGeneration(released.storePathHash)) !== undefined
		}).toStrictEqual({
			settled: {
				name: 'channel',
				expired: false,
				createdAt: '2026-01-01T00:00:00.000Z',
				updatedAt: '2026-01-01T00:00:00.000Z',
				targets: []
			},
			roots: [
				{
					name: 'channel',
					expired: false,
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z',
					targetCount: 0
				}
			],
			remaining: [],
			deadlines: [
				{ storePathHash: released.storePathHash, retainUntil: dayAfterStart }
			],
			duringGrace: true,
			afterGrace: false
		});
	});

	it('grants no deadline to a released target whose path was deleted', async () => {
		await useTestServer('transition-deleted');
		const { token } = await bootstrap();

		const kept = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('7'),
			name: 'kept'
		});
		const deleted = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('8'),
			name: 'deleted'
		});

		await pushPath(token, kept);
		await pushPath(token, deleted);
		await setDefaultCacheGrace(dayGraceSeconds);
		await setRoot(token, {
			name: 'channel',
			targets: [kept.storePath, deleted.storePath]
		});
		// The delete leaves the root's target row behind, so the removal below
		// still releases the vanished hash; no deadline may back it.
		await deletePath(token, deleted.storePathHash);
		await removeRoot(token, 'channel');

		expect(await graceDeadlineRows(defaultCache())).toStrictEqual([
			{ storePathHash: kept.storePathHash, retainUntil: dayAfterStart }
		]);
	});

	it('grants deadlines to every target of a removed root, surviving a collection', async () => {
		await useTestServer('transition-remove');
		const { token } = await bootstrap();

		const first = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('1'),
			name: 'first'
		});
		const second = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('2'),
			name: 'second'
		});

		await pushPath(token, first);
		await pushPath(token, second);
		// Grace is configured only after publication, so the removal below is the
		// sole source of the deadlines.
		await setDefaultCacheGrace(dayGraceSeconds);
		await setRoot(token, {
			name: 'channel',
			targets: [first.storePath, second.storePath]
		});
		await removeRoot(token, 'channel');
		await runGc();

		expect({
			deadlines: await graceDeadlineRows(defaultCache()),
			first: (await narInfoGeneration(first.storePathHash)) !== undefined,
			second: (await narInfoGeneration(second.storePathHash)) !== undefined
		}).toStrictEqual({
			deadlines: [
				{ storePathHash: first.storePathHash, retainUntil: dayAfterStart },
				{ storePathHash: second.storePathHash, retainUntil: dayAfterStart }
			],
			first: true,
			second: true
		});
	});

	it('anchors an expiry transition at the nominal expiry, not the collection', async () => {
		await useTestServer('transition-expiry');
		const { token } = await bootstrap();
		await setDefaultCacheGrace(dayGraceSeconds);

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('3'),
			name: 'expiring'
		});

		await pushPath(token, path);
		await setRoot(token, {
			name: 'channel',
			targets: [path.storePath],
			ttlSeconds: 3600
		});

		// The collection runs an hour after the root's expiry; the deadline must
		// still measure from the expiry itself.
		vi.setSystemTime(new Date('2026-01-01T02:00:00.000Z'));
		await runGc();

		expect({
			deadlines: await graceDeadlineRows(defaultCache()),
			path: (await narInfoGeneration(path.storePathHash)) !== undefined,
			graceManaged: await hasGraceManagedMarker(defaultCache())
		}).toStrictEqual({
			deadlines: [
				{
					storePathHash: path.storePathHash,
					retainUntil: '2026-01-02T01:00:00.000Z'
				}
			],
			path: true,
			graceManaged: true
		});
	});

	it('expires roots in bounded batches and resumes the remainder by alarm', async () => {
		await useTestServer('transition-expiry-continuation');
		const { token } = await bootstrap();
		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('6'),
			name: 'shared-target'
		});

		await pushPath(token, path);
		await setDefaultCacheGrace(dayGraceSeconds);

		const rootCount = maxRootsExpiredPerRun + 1;
		const firstExpiry = Date.now() - rootCount * 1000;
		const finalDeadline = new Date(
			firstExpiry + maxRootsExpiredPerRun * 1000 + dayGraceSeconds * 1000
		).toISOString();

		await runInDurableObject(currentServer(), (instance) => {
			const cache = resolvedCache(instance.context);

			for (let index = 0; index < rootCount; index += 1) {
				const name = rootNameSchema.parse(
					`expired-${String(index).padStart(2, '0')}`
				);
				const expiresAt = isoTimestamp(new Date(firstExpiry + index * 1000));

				instance.context.db
					.insert(schema.retentionRoots)
					.values({
						cacheId: cache.id,
						name,
						expiresAt,
						createdAt: expiresAt,
						updatedAt: expiresAt
					})
					.run();
				instance.context.db
					.insert(schema.retentionRootTargets)
					.values({
						cacheId: cache.id,
						rootName: name,
						storePathHash: path.storePathHash,
						storePath: path.storePath
					})
					.run();
			}
		});

		const resolveGrace = vi.spyOn(
			RetentionService.prototype,
			'resolveGraceSeconds'
		);

		try {
			const observed = await runInDurableObject(
				currentServer(),
				async (instance, state) => {
					await instance.runGarbageCollection();

					const firstPass = {
						remainingRoots: instance.context.db
							.select({ name: schema.retentionRoots.name })
							.from(schema.retentionRoots)
							.all().length,
						continuation: await state.storage.get(gcContinuationKey),
						graceResolutions: resolveGrace.mock.calls.length
					};

					await state.storage.deleteAlarm();
					resolveGrace.mockClear();
					await instance.alarm();

					await state.storage.deleteAlarm();

					return {
						firstPass,
						settled: {
							remainingRoots: instance.context.db
								.select({ name: schema.retentionRoots.name })
								.from(schema.retentionRoots)
								.all().length,
							deadline: instance.context.db
								.select({ retainUntil: schema.retentionGrace.retainUntil })
								.from(schema.retentionGrace)
								.get()?.retainUntil,
							continuation: await state.storage.get(gcContinuationKey),
							graceResolutions: resolveGrace.mock.calls.length
						}
					};
				}
			);

			expect(observed).toStrictEqual({
				firstPass: {
					remainingRoots: 1,
					continuation: [tenantWideContinuation],
					graceResolutions: 1
				},
				settled: {
					remainingRoots: 0,
					deadline: finalDeadline,
					continuation: undefined,
					graceResolutions: 1
				}
			});
		} finally {
			resolveGrace.mockRestore();
		}
	});

	it('continues target batches within a stored root over the protocol limit', async () => {
		await useTestServer('transition-expiry-target-continuation');
		const { token } = await bootstrap();
		await setDefaultCacheGrace(dayGraceSeconds);
		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('0'),
			name: 'retained-across-target-batches'
		});
		await pushPath(token, path);
		const rootName = rootNameSchema.parse('oversized');
		const expiresAt = isoTimestamp(new Date(Date.now() - 1000));
		const targetCount = maxExpiredRootTargetsPerRun + 1;

		const observed = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const cache = resolvedCache(instance.context);

				instance.context.db
					.insert(schema.retentionRoots)
					.values({
						cacheId: cache.id,
						name: rootName,
						expiresAt,
						createdAt: expiresAt,
						updatedAt: expiresAt
					})
					.run();
				instance.context.db
					.insert(schema.retentionRootTargets)
					.values({
						cacheId: cache.id,
						rootName,
						storePathHash: path.storePathHash,
						storePath: path.storePath
					})
					.run();
				state.storage.sql.exec(
					`WITH RECURSIVE numbers(value) AS (
						VALUES (1)
						UNION ALL
						SELECT value + 1 FROM numbers WHERE value < ?
					)
					INSERT INTO retention_root_target (
						cache_id, root_name, store_path_hash, store_path
					)
					SELECT ?, ?, printf('%032d', value),
						'/nix/store/' || printf('%032d', value) || '-target'
					FROM numbers`,
					targetCount - 1,
					cache.id,
					rootName
				);

				const stateSnapshot = (): {
					readonly roots: number;
					readonly targets: number;
					readonly pathPresent: boolean;
					readonly deadlines: number;
				} => ({
					roots:
						instance.context.db
							.select({ count: sql<number>`count(*)` })
							.from(schema.retentionRoots)
							.get()?.count ?? 0,
					targets:
						instance.context.db
							.select({ count: sql<number>`count(*)` })
							.from(schema.retentionRootTargets)
							.get()?.count ?? 0,
					pathPresent:
						instance.context.db
							.select({ storePathHash: schema.narInfos.storePathHash })
							.from(schema.narInfos)
							.where(eq(schema.narInfos.storePathHash, path.storePathHash))
							.get() !== undefined,
					deadlines:
						instance.context.db
							.select({ count: sql<number>`count(*)` })
							.from(schema.retentionGrace)
							.get()?.count ?? 0
				});

				await instance.runGarbageCollection();
				const firstPass = {
					...stateSnapshot(),
					continuation: await state.storage.get(gcContinuationKey)
				};

				await state.storage.deleteAlarm();
				await instance.alarm();
				await state.storage.deleteAlarm();

				return {
					firstPass,
					settled: {
						...stateSnapshot(),
						continuation: await state.storage.get(gcContinuationKey)
					}
				};
			}
		);

		expect(observed).toStrictEqual({
			firstPass: {
				roots: 1,
				targets: 1,
				pathPresent: true,
				deadlines: 1,
				continuation: [tenantWideContinuation]
			},
			settled: {
				roots: 0,
				targets: 0,
				pathPresent: true,
				deadlines: 1,
				continuation: undefined
			}
		});
	});

	it('cannot shorten a deadline with a later, earlier-anchored event', async () => {
		await useTestServer('transition-monotonic');
		await bootstrap();

		const hash = storePathHashSchema.parse(repeated('7'));

		await runInDurableObject(currentServer(), (instance) => {
			const service = new RetentionService(instance.context);
			const cache = resolvedCache(instance.context);
			service.extendGraceDeadlines(
				cache,
				[hash],
				isoTimestampSchema.parse('2026-03-01T00:00:00.000Z')
			);
			service.extendGraceDeadlines(
				cache,
				[hash],
				isoTimestampSchema.parse('2026-02-01T00:00:00.000Z')
			);
		});

		expect(await graceDeadlineRows(defaultCache())).toStrictEqual([
			{ storePathHash: hash, retainUntil: '2026-03-01T00:00:00.000Z' }
		]);
	});

	it('marks the cache on a zero grace without granting a deadline', async () => {
		await useTestServer('transition-zero');
		const { token } = await bootstrap();
		await setDefaultCacheGrace(0);

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('4'),
			name: 'zero'
		});

		await pushPath(token, path);
		await setRoot(token, { name: 'channel', targets: [path.storePath] });
		await removeRoot(token, 'channel');

		expect({
			deadlines: await graceDeadlineRows(defaultCache()),
			graceManaged: await hasGraceManagedMarker(defaultCache())
		}).toStrictEqual({ deadlines: [], graceManaged: true });
	});

	it('leaves a cache with no configured grace untouched', async () => {
		await useTestServer('transition-no-grace');
		const { token } = await bootstrap();

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('5'),
			name: 'unmatched'
		});

		await pushPath(token, path);
		await setRoot(token, { name: 'channel', targets: [path.storePath] });
		await removeRoot(token, 'channel');

		expect({
			deadlines: await graceDeadlineRows(defaultCache()),
			graceManaged: await hasGraceManagedMarker(defaultCache())
		}).toStrictEqual({ deadlines: [], graceManaged: false });
	});

	it('resolves grace independently for each cache', async () => {
		await useTestServer('transition-cache-grace');
		await bootstrap();

		const resolved = await runInDurableObject(currentServer(), (instance) => {
			const service = new RetentionService(instance.context);
			const pr5 = instance.context.cacheRepository.resolveOrCreate(
				pr5Cache,
				'public'
			);
			const builds = instance.context.cacheRepository.resolveOrCreate(
				buildsCache,
				'public'
			);
			const withoutConfiguration = service.resolveGraceSeconds(pr5);

			instance.context.db
				.update(schema.caches)
				.set({ graceSeconds: graceSecondsSchema.parse(3600) })
				.where(eq(schema.caches.id, pr5.id))
				.run();
			instance.context.db
				.update(schema.caches)
				.set({ graceSeconds: graceSecondsSchema.parse(604_800) })
				.where(eq(schema.caches.id, builds.id))
				.run();

			return {
				withoutConfiguration,
				prCache: service.resolveGraceSeconds(pr5),
				otherCache: service.resolveGraceSeconds(builds)
			};
		});

		expect(resolved).toStrictEqual({
			withoutConfiguration: undefined,
			prCache: 3600,
			otherCache: 604_800
		});
	});

	it('supports grace on a private cache', async () => {
		await useTestServer('transition-cache-access');
		await bootstrap();

		const resolved = await runInDurableObject(currentServer(), (instance) => {
			const service = new RetentionService(instance.context);
			const privateCache = instance.context.cacheRepository.resolveOrCreate(
				buildsCache,
				'private'
			);
			const publicCache = instance.context.cacheRepository.resolveOrCreate(
				namedCache('private'),
				'public'
			);

			instance.context.db
				.update(schema.caches)
				.set({ graceSeconds: graceSecondsSchema.parse(604_800) })
				.where(eq(schema.caches.id, privateCache.id))
				.run();
			instance.context.db
				.update(schema.caches)
				.set({ graceSeconds: graceSecondsSchema.parse(3600) })
				.where(eq(schema.caches.id, publicCache.id))
				.run();

			return {
				privateCache: service.resolveGraceSeconds(privateCache),
				publicCache: service.resolveGraceSeconds(publicCache)
			};
		});

		expect(resolved).toStrictEqual({
			privateCache: 604_800,
			publicCache: 3600
		});
	});
});

describe('retention grace at publication', () => {
	beforeEach(resetTestServer);

	const dayGraceSeconds = graceSecondsSchema.parse(86_400);
	const dayAfterStart = '2026-01-02T00:00:00.000Z';

	it('normalises grace decisions across a rolling deployment', () => {
		const decision = {
			reportsGrace: true,
			graceSeconds: dayGraceSeconds
		};

		expect({
			current: parseStoredGraceDecision(JSON.stringify(decision)),
			rolling: parseStoredGraceDecision(
				JSON.stringify({ plan: true, graceSeconds: dayGraceSeconds })
			),
			written: serialiseGraceDecision(decision)
		}).toStrictEqual({
			current: decision,
			rolling: decision,
			written: JSON.stringify(decision)
		});
	});

	it('grants the deadline atomically with an immediate publication', async () => {
		await useTestServer('publication-immediate');
		const { token } = await bootstrap();
		await setDefaultCacheGrace(dayGraceSeconds);

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('a'),
			name: 'published'
		});

		await pushPath(token, path);
		await runGc();

		expect({
			deadlines: await graceDeadlineRows(defaultCache()),
			graceManaged: await hasGraceManagedMarker(defaultCache()),
			path: (await narInfoGeneration(path.storePathHash)) !== undefined
		}).toStrictEqual({
			deadlines: [
				{ storePathHash: path.storePathHash, retainUntil: dayAfterStart }
			],
			graceManaged: true,
			path: true
		});
	});

	it('grants the deadline to a rooted publication too', async () => {
		await useTestServer('publication-rooted');
		const { token } = await bootstrap();
		await setDefaultCacheGrace(dayGraceSeconds);

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('b'),
			name: 'rooted'
		});

		await pushPath(token, path);
		await setRoot(token, { name: 'channel', targets: [path.storePath] });

		expect(await graceDeadlineRows(defaultCache())).toStrictEqual([
			{ storePathHash: path.storePathHash, retainUntil: dayAfterStart }
		]);
	});

	it('keeps the captured grace after grace is cleared on a deferred upload', async () => {
		await useTestServer('publication-deferred');
		await clearBlobStorage();
		const { token } = await bootstrap();
		await setDefaultCacheGrace(dayGraceSeconds);

		const nar = await verifiableNar('grace-deferred');
		const metadata = uploadMetadata({
			storePathHash: repeated('c'),
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);

		await putNarBytes(upload.r2Key, nar);
		await markUploadPendingVerification(upload.uploadId);

		const pendingDecision = await runInDurableObject(
			currentServer(),
			(instance) =>
				parseStoredGraceDecision(
					instance.context.db
						.select({
							graceDecisionJson: schema.pendingUploads.graceDecisionJson
						})
						.from(schema.pendingUploads)
						.where(eq(schema.pendingUploads.id, upload.uploadId))
						.get()?.graceDecisionJson
				)
		);
		const beforeVerification = await graceDeadlineRows(defaultCache());

		await clearDefaultCacheGrace();
		await verifyTenant(rootLogger(), env, currentServerTenant(), 10);

		expect({
			pendingDecision,
			beforeVerification,
			afterVerification: await graceDeadlineRows(defaultCache())
		}).toStrictEqual({
			pendingDecision: { reportsGrace: false, graceSeconds: dayGraceSeconds },
			beforeVerification: [],
			afterVerification: [
				{ storePathHash: metadata.storePathHash, retainUntil: dayAfterStart }
			]
		});
	});

	// Rows written before the grace-decision column was added have NULL in that
	// column. Verification must treat NULL as no captured grace, even if the
	// cache now has grace configured.
	it('materialises a pre-decision pending row without granting grace', async () => {
		await useTestServer('publication-null-decision');
		await clearBlobStorage();
		const { token } = await bootstrap();
		await setDefaultCacheGrace(dayGraceSeconds);

		const nar = await verifiableNar('grace-null-decision');
		const metadata = uploadMetadata({
			storePathHash: repeated('h'),
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);

		await putNarBytes(upload.r2Key, nar);
		await markUploadPendingVerification(upload.uploadId);
		await runInDurableObject(currentServer(), (_instance, state) => {
			state.storage.sql.exec(
				'UPDATE pending_upload SET grace_decision_json = NULL WHERE id = ?',
				upload.uploadId
			);
		});
		await verifyCurrentTenant();

		expect({
			materialised:
				(await narInfoGeneration(metadata.storePathHash)) !== undefined,
			deadlines: await graceDeadlineRows(defaultCache()),
			graceManaged: await hasGraceManagedMarker(defaultCache())
		}).toStrictEqual({
			materialised: true,
			deadlines: [],
			graceManaged: false
		});
	});

	it('does not grant grace when verification fails', async () => {
		await useTestServer('publication-mismatch');
		await clearBlobStorage();
		const { token } = await bootstrap();
		await setDefaultCacheGrace(dayGraceSeconds);

		const good = await verifiableNar('grace-good');
		const wrong = await verifiableNar('grace-wrong');
		const metadata = uploadMetadata({
			storePathHash: repeated('d'),
			references: [],
			narHash: good.narHash,
			narSize: good.narSize,
			fileHash: wrong.fileHash,
			fileSize: wrong.narBytes.byteLength
		});
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);

		// The compressed hash matches, but the bytes decode to a different NAR.
		await putNarBytes(upload.r2Key, wrong);
		await markUploadPendingVerification(upload.uploadId);
		await verifyCurrentTenant();

		expect({
			deadlines: await graceDeadlineRows(defaultCache()),
			graceManaged: await hasGraceManagedMarker(defaultCache())
		}).toStrictEqual({ deadlines: [], graceManaged: false });
	});

	it('marks the cache grace-managed at publication on a zero grace', async () => {
		await useTestServer('publication-zero');
		const { token } = await bootstrap();
		await setDefaultCacheGrace(0);

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('f'),
			name: 'zero-grace'
		});

		await pushPath(token, path);

		const beforeCollection = {
			deadlines: await graceDeadlineRows(defaultCache()),
			graceManaged: await hasGraceManagedMarker(defaultCache())
		};

		await runGc();

		expect({
			...beforeCollection,
			path: await narInfoGeneration(path.storePathHash)
		}).toStrictEqual({
			deadlines: [],
			graceManaged: true,
			path: undefined
		});
	});

	it('leaves a publication without configured grace unmanaged', async () => {
		await useTestServer('publication-no-grace');
		const { token } = await bootstrap();

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('g'),
			name: 'unmatched'
		});

		await pushPath(token, path);

		expect({
			deadlines: await graceDeadlineRows(defaultCache()),
			graceManaged: await hasGraceManagedMarker(defaultCache())
		}).toStrictEqual({ deadlines: [], graceManaged: false });
	});

	it('reports the stored maximum deadline, not the shorter candidate this commit alone computed', async () => {
		await useTestServer('publication-stored-maximum');
		await clearBlobStorage();
		const { token } = await bootstrap();
		await setDefaultCacheGrace(dayGraceSeconds);

		const nar = await verifiableNar('publication-stored-maximum');
		const seed = uploadMetadata({
			storePathHash: repeated('h'),
			name: 'seed',
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		await pushPath(token, seed, defaultCache(), nar);

		const reused = uploadMetadata({
			storePathHash: repeated('i'),
			name: 'reused',
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		// Seed a later deadline than this commit would calculate.
		await seedGraceDeadline(defaultCache(), reused.storePathHash, liveDeadline);

		const negotiated = await negotiateUploads(
			token,
			[reused],
			defaultCache(),
			true
		);
		const decision = negotiated.uploads[0];

		if (decision?.action !== 'commit') {
			throw new Error('the reused path must plan a commit');
		}

		const conversation = await openCommitSession(token);

		conversation.send({ op: 'commit', uploadId: decision.uploadId });
		const frame = await conversation.nextFrame();
		conversation.socket.close();

		if (frame.ev !== 'settled') {
			throw new Error('the reused path must settle immediately');
		}

		expect({
			frameGrace: frame.grace,
			deadlines: await graceDeadlineRows(defaultCache())
		}).toStrictEqual({
			frameGrace: { retainUntil: liveDeadline },
			deadlines: [
				{ storePathHash: seed.storePathHash, retainUntil: dayAfterStart },
				{ storePathHash: reused.storePathHash, retainUntil: liveDeadline }
			]
		});
	});

	// A losing reservation returns success without materialising its own upload.
	// It must apply its captured grace decision before discarding the pending
	// row. Negotiate both reservations before committing either one so the
	// second commit deterministically takes this path.
	it.each([
		{
			id: 'positive',
			configuredGraceSeconds: 3600,
			reportsGrace: true,
			expectManaged: true,
			expectRetainUntil: '2026-01-01T01:00:00.000Z',
			expectGrace: { retainUntil: '2026-01-01T01:00:00.000Z' }
		},
		{
			id: 'legacy',
			configuredGraceSeconds: undefined,
			reportsGrace: false,
			expectManaged: false,
			expectRetainUntil: undefined,
			expectGrace: undefined
		},
		{
			id: 'zero',
			configuredGraceSeconds: 0,
			reportsGrace: true,
			expectManaged: true,
			expectRetainUntil: undefined,
			expectGrace: { graceSeconds: 0 }
		}
	] as const)(
		'applies captured grace to a re-drive concede ($id)',
		async ({
			id,
			configuredGraceSeconds,
			reportsGrace: shouldReportGrace,
			expectManaged,
			expectRetainUntil,
			expectGrace
		}) => {
			await useTestServer(`concede-redrive-${id}`);
			const { token } = await bootstrap();

			if (configuredGraceSeconds !== undefined) {
				await setDefaultCacheGrace(configuredGraceSeconds);
			}

			const nar = await verifiableNar(`concede-redrive-${id}`);
			const metadata = uploadMetadata({
				storePathHash: repeated('r'),
				name: 'contested',
				references: [],
				narHash: nar.narHash,
				narSize: nar.narSize,
				fileHash: nar.fileHash,
				fileSize: nar.narBytes.byteLength
			});
			const first = await negotiateUploads(
				token,
				[metadata],
				defaultCache(),
				shouldReportGrace
			);
			const second = await negotiateUploads(
				token,
				[metadata],
				defaultCache(),
				shouldReportGrace
			);
			const winnerDecision = first.uploads[0];
			const loserDecision = second.uploads[0];

			if (
				winnerDecision?.action !== 'upload' ||
				loserDecision?.action !== 'upload'
			) {
				throw new Error('both negotiations must plan a fresh upload');
			}

			await putNarBytes(winnerDecision.r2Key, nar);
			// commitUpload also runs verification when this fresh upload is deferred.
			await commitUpload(token, uploadIdSchema.parse(winnerDecision.uploadId));

			const loserConversation = await openCommitSession(token);

			loserConversation.send({
				op: 'commit',
				uploadId: loserDecision.uploadId
			});
			const loserFrame = await loserConversation.nextFrame();
			loserConversation.socket.close();

			if (loserFrame.ev !== 'settled') {
				throw new Error('the loser must concede immediately, not defer');
			}

			expect({
				status: loserFrame.response.status,
				hasGraceKey: 'grace' in loserFrame,
				grace: loserFrame.grace,
				graceManaged: await hasGraceManagedMarker(defaultCache()),
				deadlines: await graceDeadlineRows(defaultCache())
			}).toStrictEqual({
				status: 'already-present',
				hasGraceKey: shouldReportGrace,
				grace: expectGrace,
				graceManaged: expectManaged,
				deadlines:
					expectRetainUntil === undefined
						? []
						: [
								{
									storePathHash: metadata.storePathHash,
									retainUntil: expectRetainUntil
								}
							]
			});
		}
	);

	it('applies captured grace when a fresh reservation concedes to a committed winner', async () => {
		await useTestServer('concede-to-winner');
		const { token } = await bootstrap();
		await setDefaultCacheGrace(3600);

		const nar = await verifiableNar('concede-to-winner');
		const metadata = uploadMetadata({
			storePathHash: repeated('s'),
			name: 'contested',
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		// Commit the winning generation before exercising a losing reservation for
		// the same store path. This branch does not read the loser's pending row, so
		// the test can use a synthetic upload ID.
		await pushPath(token, metadata, defaultCache(), nar);

		const outcome = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const cache = resolvedCache(instance.context);

				return pipelineFor(instance.context).concedeToWinner(
					rootLogger(),
					cache,
					uploadIdSchema.parse('loser-upload'),
					uploadPathNegotiation(metadata),
					await currentNarObjectKey(metadata.narHash),
					{ reportsGrace: true, graceSeconds: graceSecondsSchema.parse(3600) }
				);
			}
		);

		expect({
			outcome,
			graceManaged: await hasGraceManagedMarker(defaultCache()),
			deadlines: await graceDeadlineRows(defaultCache())
		}).toStrictEqual({
			outcome: {
				kind: 'settled',
				response: {
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash,
					status: 'already-present'
				},
				grace: { retainUntil: '2026-01-01T01:00:00.000Z' }
			},
			graceManaged: true,
			deadlines: [
				{
					storePathHash: metadata.storePathHash,
					retainUntil: '2026-01-01T01:00:00.000Z'
				}
			]
		});
	});

	// The captured grace decision exists only on the pending row. Apply it before
	// deleting that row and its staging object so a cleanup failure cannot lose
	// the grant.
	it('applies the captured grace before the concede destroys the decision', async () => {
		await useTestServer('concede-ordering');
		const { token } = await bootstrap();

		const nar = await verifiableNar('concede-ordering');
		const metadata = uploadMetadata({
			storePathHash: repeated('w'),
			name: 'contested',
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		const loserRow = await pendingRowSnapshot(upload.uploadId);

		await putNarBytes(upload.r2Key, nar);
		await commitUpload(token, upload.uploadId);
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.insert(schema.pendingUploads)
				.values({
					...loserRow,
					id: uploadIdSchema.parse('loser-upload'),
					r2Key: r2ObjectKeySchema.parse('staging/loser-upload')
				})
				.run();
		});

		const outcome = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const cache = resolvedCache(instance.context);

				instance.context.env = {
					...instance.context.env,
					BLOBS: failingDeleteBucket(instance.context.env.BLOBS)
				};

				try {
					await pipelineFor(instance.context).concedeToWinner(
						rootLogger(),
						cache,
						uploadIdSchema.parse('loser-upload'),
						uploadPathNegotiation(metadata),
						r2ObjectKeySchema.parse('staging/loser-upload'),
						{ reportsGrace: true, graceSeconds: graceSecondsSchema.parse(3600) }
					);

					return 'settled' as const;
				} catch {
					return 'failed' as const;
				}
			}
		);

		expect({
			outcome,
			deadlines: await graceDeadlineRows(defaultCache())
		}).toStrictEqual({
			outcome: 'failed',
			deadlines: [
				{
					storePathHash: metadata.storePathHash,
					retainUntil: '2026-01-01T01:00:00.000Z'
				}
			]
		});
	});

	// A crash after the reference edge is committed can leave the grace decision
	// on the pending row. A later verification pass must apply that decision
	// before it clears the row.
	it('reapplies the stored decision when recovery re-claims a committed generation', async () => {
		await useTestServer('grace-recovery');
		await clearBlobStorage();
		const { token } = await bootstrap();
		await setDefaultCacheGrace(dayGraceSeconds);

		const nar = await verifiableNar('grace-recovery');
		const metadata = uploadMetadata({
			storePathHash: repeated('x'),
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);

		await putNarBytes(upload.r2Key, nar);
		await markUploadPendingVerification(upload.uploadId);

		const row = await pendingRowSnapshot(upload.uploadId);
		await verifyCurrentTenant();

		// Restore the pending row but remove the applied grace state to reproduce
		// that crash boundary.
		await runInDurableObject(currentServer(), (instance) => {
			const cache = resolvedCache(instance.context);

			instance.context.db
				.delete(schema.retentionGrace)
				.where(eq(schema.retentionGrace.cacheId, cache.id))
				.run();
			instance.context.db
				.update(schema.caches)
				.set({ graceManaged: false })
				.where(eq(schema.caches.id, cache.id))
				.run();
			instance.context.db
				.insert(schema.pendingUploads)
				.values({
					...row,
					r2Key: narObjectKey(metadata.narHash),
					verdict: 'pending',
					claimedAt: undefined
				})
				.run();
		});

		await verifyCurrentTenant();

		expect({
			deadlines: await graceDeadlineRows(defaultCache()),
			graceManaged: await hasGraceManagedMarker(defaultCache()),
			verdict: await pendingUploadVerdict(upload.uploadId)
		}).toStrictEqual({
			deadlines: [
				{ storePathHash: metadata.storePathHash, retainUntil: dayAfterStart }
			],
			graceManaged: true,
			verdict: undefined
		});
	});

	// The winner can change while object repair is awaited. Re-read its identity
	// before settling so a stale generation cannot discard the pending row and
	// its captured grace decision.
	it('defers when the winner changes during concession', async () => {
		await useTestServer('concede-moved-winner');
		const { token } = await bootstrap();

		const nar = await verifiableNar('concede-moved-winner');
		const metadata = uploadMetadata({
			storePathHash: repeated('0'),
			name: 'contested',
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		await pushPath(token, metadata, defaultCache(), nar);

		const hash = storePathHashSchema.parse(metadata.storePathHash);
		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const cache = resolvedCache(instance.context);

				// Change the generation during the first object-repair probe.
				let hasMoved = false;
				const moveWinner = (): void => {
					if (hasMoved) {
						return;
					}

					hasMoved = true;
					instance.context.db
						.update(schema.narInfos)
						.set({ generation: sql`${schema.narInfos.generation} + 1` })
						.where(
							and(
								eq(schema.narInfos.cacheId, cache.id),
								eq(schema.narInfos.storePathHash, hash)
							)
						)
						.run();
				};
				const context = new ServerContext(state, {
					...instance.context.env,
					BLOBS: headTappingBucket(instance.context.env.BLOBS, moveWinner)
				});
				const outcome = await pipelineFor(context).concedeToWinner(
					rootLogger(),
					cache,
					uploadIdSchema.parse('loser-upload'),
					uploadPathNegotiation(metadata),
					narObjectKey(metadata.narHash),
					{ reportsGrace: true, graceSeconds: graceSecondsSchema.parse(3600) }
				);

				return { outcome, hasMoved };
			}
		);

		// The replacement generation has no committed edge, so the losing upload
		// must remain pending for verification.
		expect({
			...result,
			deadlines: await graceDeadlineRows(defaultCache())
		}).toStrictEqual({
			outcome: {
				kind: 'deferred',
				storePathHash: metadata.storePathHash,
				narHash: metadata.narHash,
				grace: { graceSeconds: 3600 }
			},
			hasMoved: true,
			deadlines: []
		});
	});

	// Bound re-resolution so sustained recommits cannot keep one request alive
	// indefinitely. After the limit, retain the pending row for verification.
	it('defers after bounded attempts when the winner keeps moving', async () => {
		await useTestServer('concede-churn');
		const { token } = await bootstrap();

		const nar = await verifiableNar('concede-churn');
		const metadata = uploadMetadata({
			storePathHash: repeated('8'),
			name: 'churned',
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		await pushPath(token, metadata, defaultCache(), nar);

		const hash = storePathHashSchema.parse(metadata.storePathHash);
		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const cache = resolvedCache(instance.context);

				// Pre-seed reference edges and advance the generation on every probe so
				// each retry finds another committed winner.
				const database = drizzleD1(instance.context.env.CUPBOARD_DB, {
					schema: d1Schema
				});
				const live = instance.context.db
					.select({
						generation: schema.narInfos.generation,
						narHash: schema.narInfos.narHash
					})
					.from(schema.narInfos)
					.where(
						and(
							eq(schema.narInfos.cacheId, cache.id),
							eq(schema.narInfos.storePathHash, hash)
						)
					)
					.get();

				if (live === undefined) {
					throw new Error('the churned path must be committed');
				}
				const tenant = instance.context.requireTenant();

				await database.insert(d1Schema.blobReference).values(
					Array.from({ length: 8 }, (_, index) => ({
						tenant,
						...cacheIdentityColumns(cache.scope),
						storePathHash: hash,
						generation: narInfoGenerationSchema.parse(
							live.generation + index + 1
						),
						narHash: live.narHash,
						cacheGeneration: currentCacheGeneration(tenant, cache.scope)
					}))
				);

				let bumpCount = 0;
				const churn = (): void => {
					bumpCount += 1;
					instance.context.db
						.update(schema.narInfos)
						.set({ generation: sql`${schema.narInfos.generation} + 1` })
						.where(
							and(
								eq(schema.narInfos.cacheId, cache.id),
								eq(schema.narInfos.storePathHash, hash)
							)
						)
						.run();
				};
				const context = new ServerContext(state, {
					...instance.context.env,
					BLOBS: headTappingBucket(instance.context.env.BLOBS, churn)
				});
				const outcome = await pipelineFor(context).concedeToWinner(
					rootLogger(),
					cache,
					uploadIdSchema.parse('loser-upload'),
					uploadPathNegotiation(metadata),
					narObjectKey(metadata.narHash),
					{ reportsGrace: true, graceSeconds: graceSecondsSchema.parse(3600) }
				);

				return { outcome, bumpCount };
			}
		);

		expect({
			outcome: result.outcome,
			boundedBumps: result.bumpCount <= 6,
			deadlines: await graceDeadlineRows(defaultCache())
		}).toStrictEqual({
			outcome: {
				kind: 'deferred',
				storePathHash: metadata.storePathHash,
				narHash: metadata.narHash,
				grace: { graceSeconds: 3600 }
			},
			boundedBumps: true,
			deadlines: []
		});
	});

	// The local row can change while the recovery path checks its D1 reference
	// edge. Recheck the row before treating that edge as proof of the current
	// generation.
	it('declines the recovery short-circuit when the row moves during the edge check', async () => {
		await useTestServer('recovery-moved-row');
		await clearBlobStorage();
		const { token } = await bootstrap();
		await setDefaultCacheGrace(dayGraceSeconds);

		const nar = await verifiableNar('recovery-moved-row');
		const metadata = uploadMetadata({
			storePathHash: repeated('6'),
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);

		await putNarBytes(upload.r2Key, nar);
		await markUploadPendingVerification(upload.uploadId);

		const row = await pendingRowSnapshot(upload.uploadId);
		await verifyCurrentTenant();

		// Restore the pending row so the next pass takes the recovery path.
		const hash = storePathHashSchema.parse(metadata.storePathHash);
		await runInDurableObject(currentServer(), (instance) => {
			const cache = resolvedCache(instance.context);

			instance.context.db
				.delete(schema.retentionGrace)
				.where(eq(schema.retentionGrace.cacheId, cache.id))
				.run();
			instance.context.db
				.insert(schema.pendingUploads)
				.values({ ...row, verdict: 'pending', claimedAt: undefined })
				.run();
		});

		// Change the row while the pass awaits the committed-edge query.
		const hasMoved = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const cache = resolvedCache(instance.context);

				let hasMoved = false;
				const context = new ServerContext(state, {
					...instance.context.env,
					CUPBOARD_DB: prepareTappingD1(
						instance.context.env.CUPBOARD_DB,
						(query) => query.includes('blob_ref'),
						() => {
							if (hasMoved) {
								return;
							}

							hasMoved = true;
							instance.context.db
								.update(schema.narInfos)
								.set({ generation: sql`${schema.narInfos.generation} + 1` })
								.where(
									and(
										eq(schema.narInfos.cacheId, cache.id),
										eq(schema.narInfos.storePathHash, hash)
									)
								)
								.run();
						}
					)
				});

				await asOneInvocation(() =>
					verificationFor(context).processPendingWithoutDecode(rootLogger(), 10)
				);

				return hasMoved;
			}
		);
		await verifyCurrentTenant();

		// The superseded upload must fail without granting grace to the replacement
		// generation.
		expect({
			hasMoved,
			verdict: await pendingUploadVerdict(upload.uploadId),
			deadlines: await graceDeadlineRows(defaultCache())
		}).toStrictEqual({
			hasMoved: true,
			verdict: 'mismatch',
			deadlines: []
		});
	});
});

// Run the tap before each R2 head so tests can place a mutation inside an await.
function headTappingBucket(inner: R2Bucket, onHead: () => void): R2Bucket {
	return {
		head(key) {
			onHead();

			return inner.head(key);
		},
		get: inner.get.bind(inner),
		put: inner.put.bind(inner),
		delete: inner.delete.bind(inner),
		list: inner.list.bind(inner),
		createMultipartUpload: inner.createMultipartUpload.bind(inner),
		resumeMultipartUpload: inner.resumeMultipartUpload.bind(inner)
	};
}

// Run the tap before matching D1 queries so tests can place a mutation inside
// an await.
function prepareTappingD1(
	inner: D1Database,
	isMatch: (query: string) => boolean,
	onMatch: () => void
): D1Database {
	return {
		prepare(query) {
			if (isMatch(query)) {
				onMatch();
			}

			return inner.prepare(query);
		},
		batch: inner.batch.bind(inner),
		exec: inner.exec.bind(inner),
		withSession: inner.withSession.bind(inner),
		dump: () => Promise.reject(new Error('dump is not supported here'))
	};
}

function verificationFor(context: ServerContext): VerificationService {
	const narInfoObjects = new NarInfoObjectsService(context);
	const attestationCas = new AttestationCasService(context);
	const attestations = new AttestationsService(
		context,
		attestationCas,
		narInfoObjects
	);
	const deletionQueue = new DeletionQueueService(
		context,
		attestationCas,
		attestations,
		narInfoObjects
	);
	const uploadState = new UploadStateService(context);
	const retention = new RetentionService(context);

	return new VerificationService(
		context,
		new CommitPipelineService(
			context,
			new SigningKeysService(context, narInfoObjects),
			uploadState,
			narInfoObjects,
			retention
		),
		deletionQueue,
		narInfoObjects,
		uploadState,
		retention,
		() => {
			// Intentionally empty test callback.
		}
	);
}

function failingDeleteBucket(inner: R2Bucket): R2Bucket {
	return {
		head: inner.head.bind(inner),
		get: inner.get.bind(inner),
		put: inner.put.bind(inner),
		delete: () => Promise.reject(new Error('staging delete fault')),
		list: inner.list.bind(inner),
		createMultipartUpload: inner.createMultipartUpload.bind(inner),
		resumeMultipartUpload: inner.resumeMultipartUpload.bind(inner)
	};
}

async function pendingRowSnapshot(
	uploadId: UploadId
): Promise<typeof schema.pendingUploads.$inferSelect> {
	const row = await runInDurableObject(currentServer(), (instance) =>
		instance.context.db
			.select()
			.from(schema.pendingUploads)
			.where(eq(schema.pendingUploads.id, uploadId))
			.get()
	);

	if (row === undefined) {
		throw new Error(`no pending row for ${uploadId}`);
	}

	return row;
}

function plannedUploadDecision(
	response: Awaited<ReturnType<typeof negotiateUploads>>
): Extract<ReturnType<typeof singleDecision>, { action: 'upload' }> {
	const decision = singleDecision(response);

	if (decision.action !== 'upload') {
		throw new Error('expected a single upload decision');
	}

	return decision;
}

describe('retention grace facts reported to clients', () => {
	beforeEach(async () => {
		await resetTestServer();
		await clearBlobStorage();
	});

	const dayGraceSeconds = graceSecondsSchema.parse(86_400);
	const dayAfterStart = '2026-01-02T00:00:00.000Z';
	const shouldReportGrace = true;

	it.each([
		{ reportsGrace: false, capabilities: undefined },
		{ reportsGrace: true, capabilities: uploadCapabilitiesValue }
	])(
		'acknowledges grace facts only when requested ($reportsGrace)',
		async ({ reportsGrace: shouldAcceptGraceFacts, capabilities }) => {
			const { token } = await bootstrap();
			const response = await authorisedFetch('/uploads', token, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					...(shouldAcceptGraceFacts && {
						[acceptCapabilitiesHeader]: uploadGraceFactsCapability
					})
				},
				body: JSON.stringify({ pushId: testPushId, paths: [] })
			});

			expect({
				status: response.status,
				capabilities:
					response.headers.get(uploadCapabilitiesHeader) ?? undefined,
				body: uploadNegotiateResponseSchema.parse(await response.json())
			}).toStrictEqual({
				status: StatusCodes.OK,
				capabilities,
				body: { uploads: [] }
			});
		}
	);

	it('keeps legacy decision shapes without the capability, attaching facts with it', async () => {
		await useTestServer('reported-decisions');
		const { token } = await bootstrap();
		await setDefaultCacheGrace(dayGraceSeconds);

		const committed = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('a'),
			name: 'committed'
		});
		const fresh = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('b'),
			name: 'fresh'
		});

		await pushPath(token, committed);

		const legacy = await negotiateUploads(token, [committed, fresh]);
		// The legacy already-present decision still extended the deadline; only
		// the reported fact is capability-gated.
		const afterLegacy = await graceDeadlineRows(defaultCache());
		const capable = await negotiateUploads(
			token,
			[committed, fresh],
			defaultCache(),
			shouldReportGrace
		);

		expect({
			legacyFacts: legacy.uploads.map((decision) => 'grace' in decision),
			afterLegacy,
			capableFacts: capable.uploads.map((decision) => decision.grace)
		}).toStrictEqual({
			legacyFacts: [false, false],
			afterLegacy: [
				{ storePathHash: committed.storePathHash, retainUntil: dayAfterStart }
			],
			capableFacts: [
				{ retainUntil: dayAfterStart },
				{ graceSeconds: dayGraceSeconds }
			]
		});
	});

	it('includes the deadline on a settled frame only for a capable upload', async () => {
		await useTestServer('reported-settled');
		const { token } = await bootstrap();
		await setDefaultCacheGrace(dayGraceSeconds);

		const nar = await verifiableNar('reported-settled');
		const seed = uploadMetadata({
			storePathHash: repeated('a'),
			name: 'seed',
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		await pushPath(token, seed, defaultCache(), nar);

		const settledFrameFor = async (
			storePathHash: string,
			shouldAcceptGraceFacts = false
		): Promise<Record<string, unknown>> => {
			const metadata = uploadMetadata({
				storePathHash,
				name: `reuse-${storePathHash.slice(0, 4)}`,
				references: [],
				narHash: nar.narHash,
				narSize: nar.narSize,
				fileHash: nar.fileHash,
				fileSize: nar.narBytes.byteLength
			});
			const response = await negotiateUploads(
				token,
				[metadata],
				defaultCache(),
				shouldAcceptGraceFacts
			);
			const decision = response.uploads[0];

			if (decision?.action !== 'commit') {
				throw new Error('the reuse path must plan a commit');
			}

			const conversation = await openCommitSession(token);

			conversation.send({ op: 'commit', uploadId: decision.uploadId });
			const frame = await conversation.nextFrame();
			conversation.socket.close();

			return frame;
		};

		const capable = await settledFrameFor(repeated('b'), shouldReportGrace);
		const legacy = await settledFrameFor(repeated('c'));

		expect({
			capableEv: capable.ev,
			capableGrace: capable.grace,
			legacyEv: legacy.ev,
			legacyHasGrace: 'grace' in legacy
		}).toStrictEqual({
			capableEv: 'settled',
			capableGrace: { retainUntil: dayAfterStart },
			legacyEv: 'settled',
			legacyHasGrace: false
		});
	});

	it('reports the captured grace when deferred and the deadline on the verdict', async () => {
		await useTestServer('reported-deferred');
		const { token } = await bootstrap();
		await setDefaultCacheGrace(dayGraceSeconds);

		const nar = await verifiableNar('reported-deferred');
		const metadata = uploadMetadata({
			storePathHash: repeated('d'),
			name: 'deferred',
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		const decision = await negotiateUploads(
			token,
			[metadata],
			defaultCache(),
			shouldReportGrace
		);
		const upload = decision.uploads[0];

		if (upload?.action !== 'upload') {
			throw new Error('the fresh path must plan an upload');
		}

		await putNarBytes(upload.r2Key, nar);

		const conversation = await openCommitSession(token);

		conversation.send({ op: 'commit', uploadId: upload.uploadId });
		const deferred = await conversation.nextFrame();
		await verifyCurrentTenant();
		const verdict = await conversation.nextFrame();
		conversation.socket.close();

		if (deferred.ev !== 'deferred' || verdict.ev !== 'verdict') {
			throw new Error('unexpected frame order');
		}

		expect({
			deferredGrace: deferred.grace,
			verdictStatus: verdict.status,
			verdictGrace: verdict.grace
		}).toStrictEqual({
			deferredGrace: { graceSeconds: dayGraceSeconds },
			verdictStatus: 'servable',
			verdictGrace: { retainUntil: dayAfterStart }
		});
	});

	it('cannot shorten an already-present deadline on a retried negotiation', async () => {
		await useTestServer('reported-retry');
		const { token } = await bootstrap();
		await setDefaultCacheGrace(dayGraceSeconds);

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('f'),
			name: 'retried'
		});

		await pushPath(token, path);

		const factOf = async (): Promise<unknown> => {
			const response = await negotiateUploads(
				token,
				[path],
				defaultCache(),
				shouldReportGrace
			);

			return response.uploads[0]?.grace;
		};

		const first = await factOf();

		vi.setSystemTime(new Date('2026-01-01T00:02:00.000Z'));
		const later = await factOf();

		vi.setSystemTime(new Date('2026-01-01T00:01:00.000Z'));
		const retried = await factOf();

		expect({ first, later, retried }).toStrictEqual({
			first: { retainUntil: dayAfterStart },
			later: { retainUntil: '2026-01-02T00:02:00.000Z' },
			retried: { retainUntil: '2026-01-02T00:02:00.000Z' }
		});
	});

	// Apply grace for all already-present paths in one transaction so the
	// negotiation does not open one transaction per path.
	it('applies grace to several already-present paths in one transaction', async () => {
		await useTestServer('reported-skip-batch');
		const { token } = await bootstrap();
		await setDefaultCacheGrace(dayGraceSeconds);

		const paths = [repeated('y'), repeated('z'), repeated('v')].map(
			(storePathHash, index) =>
				uploadMetadata({
					fileSize: narBytes.byteLength,
					storePathHash,
					name: `present-${String(index)}`
				})
		);

		for (const path of paths) {
			await pushPath(token, path);
		}

		await runInDurableObject(currentServer(), (instance) => {
			vi.spyOn(instance.context.db, 'transaction');
		});

		const response = await negotiateUploads(
			token,
			paths,
			defaultCache(),
			shouldReportGrace
		);

		const transactionCount = await runInDurableObject(
			currentServer(),
			(instance) => {
				const transactions = vi.spyOn(instance.context.db, 'transaction');
				const calls = transactions.mock.calls.length;

				transactions.mockRestore();

				return calls;
			}
		);

		expect({ transactionCount, decisions: response.uploads }).toStrictEqual({
			transactionCount: 1,
			decisions: paths.map((path) => ({
				action: 'skip',
				storePathHash: path.storePathHash,
				narHash: path.narHash,
				grace: { retainUntil: dayAfterStart }
			}))
		});
	});

	// Shared-object checks run after the skippable-row snapshot. Recheck the row
	// before returning skip, or a legacy client could omit bytes for a generation
	// that is no longer committed.
	it('plans a path whose row moves during negotiation instead of skipping it', async () => {
		await useTestServer('reported-skip-moved');
		const { token } = await bootstrap();
		await setDefaultCacheGrace(dayGraceSeconds);

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('3'),
			name: 'moved'
		});

		await pushPath(token, path);

		// Mutate when the first shared-object query starts, after the row snapshot
		// and before the batched grace application.
		const hash = storePathHashSchema.parse(path.storePathHash);
		const response = await runInDurableObject(
			currentServer(),
			(instance, state) => {
				const cache = resolvedCache(instance.context);
				let hasMoved = false;
				const context = new ServerContext(state, {
					...instance.context.env,
					CUPBOARD_DB: prepareTappingD1(
						instance.context.env.CUPBOARD_DB,
						(query) =>
							query.includes('blob_ref') || query.includes('blob_state'),
						() => {
							if (hasMoved) {
								return;
							}

							hasMoved = true;
							instance.context.db
								.update(schema.narInfos)
								.set({ generation: sql`${schema.narInfos.generation} + 1` })
								.where(
									and(
										eq(schema.narInfos.cacheId, cache.id),
										eq(schema.narInfos.storePathHash, hash)
									)
								)
								.run();
						}
					)
				});

				return uploadsServiceFor(context).negotiate(
					defaultCache(),
					{
						pushId: testPushId,
						paths: [uploadPathNegotiation(path)]
					},
					requestOriginSchema.parse('https://cupboard.example'),
					undefined,
					shouldReportGrace
				);
			}
		);

		expect(
			response.uploads.map((decision) => ({
				action: decision.action,
				grace: 'grace' in decision ? decision.grace : undefined
			}))
		).toStrictEqual([
			{ action: 'upload', grace: { graceSeconds: dayGraceSeconds } }
		]);
	});

	// A reconnect can replace the pending row's session while the commit awaits
	// shared-object work. The eventual verdict must include the stored deadline
	// for the replacement session.
	it('sends the stored deadline on a reattached session verdict frame', async () => {
		await useTestServer('reported-reattach-verdict');
		await clearBlobStorage();
		const { token } = await bootstrap();
		await setDefaultCacheGrace(dayGraceSeconds);

		// Seed a canonical blob so the contested upload takes the reuse path.
		const seed = await verifiableNar('reattach-seed');
		const seeded = uploadMetadata({
			storePathHash: repeated('4'),
			name: 'seeded',
			references: [],
			narHash: seed.narHash,
			narSize: seed.narSize,
			fileHash: seed.fileHash,
			fileSize: seed.narBytes.byteLength
		});

		await pushPath(token, seeded, defaultCache(), seed);

		const contested = uploadMetadata({
			storePathHash: repeated('5'),
			name: 'contested',
			references: [],
			narHash: seed.narHash,
			narSize: seed.narSize,
			fileHash: seed.fileHash,
			fileSize: seed.narBytes.byteLength
		});
		const reuse = singleDecision(
			await negotiateUploads(
				token,
				[contested],
				defaultCache(),
				shouldReportGrace
			)
		);

		if (reuse.action !== 'commit') {
			throw new Error('the contested upload must plan a blob reuse');
		}

		// Park a second session on a deferred upload so its durable session ID is
		// available for the interleave below.
		const parked = await verifiableNar('reattach-parked');
		const parkedPath = uploadMetadata({
			storePathHash: repeated('7'),
			name: 'parked',
			references: [],
			narHash: parked.narHash,
			narSize: parked.narSize,
			fileHash: parked.fileHash,
			fileSize: parked.narBytes.byteLength
		});
		const parkedUpload = plannedUploadDecision(
			await negotiateUploads(
				token,
				[parkedPath],
				defaultCache(),
				shouldReportGrace
			)
		);

		await putNarBytes(parkedUpload.r2Key, parked);

		const conversation = await openCommitSession(token);

		conversation.send({ op: 'commit', uploadId: parkedUpload.uploadId });

		const parkedFrame = await conversation.nextFrame();

		if (parkedFrame.ev !== 'deferred') {
			throw new Error('the parked upload must defer to the verify pass');
		}

		const parkedSessionId = await runInDurableObject(
			currentServer(),
			(instance) =>
				instance.context.db
					.select({ sessionId: schema.pendingUploads.sessionId })
					.from(schema.pendingUploads)
					.where(eq(schema.pendingUploads.id, parkedUpload.uploadId))
					.get()?.sessionId ?? undefined
		);

		if (parkedSessionId === undefined) {
			throw new Error('the parked commit must record its session');
		}

		// Replace the contested row's session when the charge query starts. This
		// occurs after the commit captured its original caller and before it sends
		// the verdict.
		const outcome = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const cache = resolvedCache(instance.context);
				let hasAttached = false;
				const context = new ServerContext(state, {
					...instance.context.env,
					CUPBOARD_DB: prepareTappingD1(
						instance.context.env.CUPBOARD_DB,
						(query) => query.includes('blob_ref'),
						() => {
							if (hasAttached) {
								return;
							}

							hasAttached = true;
							instance.context.db
								.update(schema.pendingUploads)
								.set({ sessionId: parkedSessionId })
								.where(eq(schema.pendingUploads.id, reuse.uploadId))
								.run();
						}
					)
				});

				const settled = await drivenDirectly(pipelineFor(context)).commit(
					rootLogger(),
					cache,
					reuse.uploadId
				);

				return { settled, hasAttached };
			}
		);

		if (!outcome.hasAttached) {
			throw new Error('the reattach tap never fired');
		}

		// Ignore the parked upload's verdict if it arrives first.
		let frame = await conversation.nextFrame();

		while (!('uploadId' in frame) || frame.uploadId !== reuse.uploadId) {
			frame = await conversation.nextFrame();
		}

		conversation.socket.close();

		expect({ settled: outcome.settled, frame }).toStrictEqual({
			settled: {
				kind: 'settled',
				response: {
					storePathHash: contested.storePathHash,
					narHash: contested.narHash,
					status: 'committed'
				},
				grace: { retainUntil: dayAfterStart }
			},
			frame: {
				ev: 'verdict',
				uploadId: reuse.uploadId,
				status: 'servable',
				grace: { retainUntil: dayAfterStart }
			}
		});
	});

	// Verification can clear the pending row before a reconnect resends its
	// entry. For an entry marked `retention`, read the deadline stored by the
	// original commit because the captured grace decision is no longer present.
	it('attaches the durable deadline when a retention-marked commit-batch entry resolves a cleared row', async () => {
		await useTestServer('reported-reconnect-grace');
		const { token } = await bootstrap();
		await setDefaultCacheGrace(dayGraceSeconds);

		const metadata = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('g'),
			name: 'reconnect-grace'
		});
		const upload = plannedUploadDecision(
			await negotiateUploads(
				token,
				[metadata],
				defaultCache(),
				shouldReportGrace
			)
		);
		await putNarBytes(upload.r2Key);

		const committed = await commitUpload(token, upload.uploadId);
		expect(committed.status).toBe('committed');

		const session = await openCommitSession(token);
		session.send({
			op: 'commit-batch',
			commits: [
				{
					uploadId: upload.uploadId,
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash,
					retention: true
				}
			]
		});
		const frame = await session.nextFrame();
		session.socket.close();

		expect(frame).toStrictEqual({
			ev: 'settled',
			uploadId: upload.uploadId,
			response: {
				storePathHash: metadata.storePathHash,
				narHash: metadata.narHash,
				status: 'already-present'
			},
			grace: { retainUntil: dayAfterStart }
		});
	});

	it('reports an empty fact when a retention-marked reconnect resolves a cleared row with no stored deadline', async () => {
		await useTestServer('reported-reconnect-no-grace');
		const { token } = await bootstrap();

		const metadata = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('h'),
			name: 'reconnect-no-grace'
		});
		const upload = plannedUploadDecision(
			await negotiateUploads(
				token,
				[metadata],
				defaultCache(),
				shouldReportGrace
			)
		);
		await putNarBytes(upload.r2Key);

		const committed = await commitUpload(token, upload.uploadId);
		expect(committed.status).toBe('committed');

		const session = await openCommitSession(token);
		session.send({
			op: 'commit-batch',
			commits: [
				{
					uploadId: upload.uploadId,
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash,
					retention: true
				}
			]
		});
		const frame = await session.nextFrame();
		session.socket.close();

		expect(frame).toStrictEqual({
			ev: 'settled',
			uploadId: upload.uploadId,
			response: {
				storePathHash: metadata.storePathHash,
				narHash: metadata.narHash,
				status: 'already-present'
			},
			grace: {}
		});
	});

	// A missing pending row does not prove that this session negotiated the
	// upload. Report the stored deadline without extending it, or a commit-only
	// token could refresh any committed path by inventing an upload ID.
	it('reports the stored fact without extending when a retention-marked entry resolves a row another push committed', async () => {
		await useTestServer('reported-reconnect-reports');
		const { token } = await bootstrap();

		const metadata = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('j'),
			name: 'reconnect-reports'
		});

		// Publish before configuring grace so any deadline would prove that this
		// reconnect extended retention.
		await pushPath(token, metadata);
		await setDefaultCacheGrace(dayGraceSeconds);

		const session = await openCommitSession(token);
		session.send({
			op: 'commit-batch',
			commits: [
				{
					uploadId: 'reaped-upload',
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash,
					retention: true
				}
			]
		});
		const frame = await session.nextFrame();
		session.socket.close();

		expect({
			frame,
			deadlines: await graceDeadlineRows(defaultCache())
		}).toStrictEqual({
			frame: {
				ev: 'settled',
				uploadId: 'reaped-upload',
				response: {
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash,
					status: 'already-present'
				},
				grace: {}
			},
			deadlines: []
		});
	});

	// Only the `retention` marker opts into the grace field. Preserve the legacy
	// frame shape when an older client resends an unmarked entry.
	it('keeps the legacy shape for a capable reconnect entry with no retention marker', async () => {
		await useTestServer('reported-reconnect-unmarked');
		const { token } = await bootstrap();
		await setDefaultCacheGrace(dayGraceSeconds);

		const metadata = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('i'),
			name: 'reconnect-unmarked'
		});
		const upload = plannedUploadDecision(
			await negotiateUploads(
				token,
				[metadata],
				defaultCache(),
				shouldReportGrace
			)
		);
		await putNarBytes(upload.r2Key);

		const committed = await commitUpload(token, upload.uploadId);
		expect(committed.status).toBe('committed');

		const session = await openCommitSession(token);
		session.send({
			op: 'commit-batch',
			commits: [
				{
					uploadId: upload.uploadId,
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash
				}
			]
		});
		const frame = await session.nextFrame();
		session.socket.close();

		expect(frame).toStrictEqual({
			ev: 'settled',
			uploadId: upload.uploadId,
			response: {
				storePathHash: metadata.storePathHash,
				narHash: metadata.narHash,
				status: 'already-present'
			}
		});
	});

	it('attaches the durable deadline when a retention-marked subscribe-identity entry resolves a cleared row', async () => {
		await useTestServer('reported-reconnect-identity-grace');
		const { token } = await bootstrap();
		await setDefaultCacheGrace(dayGraceSeconds);

		const metadata = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('j'),
			name: 'reconnect-identity-grace'
		});
		const upload = plannedUploadDecision(
			await negotiateUploads(
				token,
				[metadata],
				defaultCache(),
				shouldReportGrace
			)
		);
		await putNarBytes(upload.r2Key);

		const committed = await commitUpload(token, upload.uploadId);
		expect(committed.status).toBe('committed');

		const session = await openCommitSession(token);
		session.send({
			op: 'subscribe-identity',
			entries: [
				{
					uploadId: upload.uploadId,
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash,
					retention: true
				}
			]
		});
		const frame = await session.nextFrame();
		session.socket.close();

		expect(frame).toStrictEqual({
			ev: 'settled',
			uploadId: upload.uploadId,
			response: {
				storePathHash: metadata.storePathHash,
				narHash: metadata.narHash,
				status: 'already-present'
			},
			grace: { retainUntil: dayAfterStart }
		});
	});
});

function confirmOnlyGrants(
	cache: CacheScope = defaultCache()
): AuthorizationDetails {
	return authorizationDetailsSchema.parse([
		{
			type: 'cupboard_cache',
			actions: ['upload:confirm'],
			cache
		}
	]);
}

async function confirmPaths(
	token: string,
	storePathHashes: readonly string[]
): Promise<{
	readonly status: number;
	readonly body: UploadConfirmResponseInput;
}> {
	const response = await authorisedFetch('/uploads/confirm', token, {
		body: JSON.stringify({ storePathHashes }),
		headers: { 'content-type': 'application/json' },
		method: 'POST'
	});

	return {
		status: response.status,
		body: uploadConfirmResponseSchema.parse(await response.json())
	};
}

class ForcedRollbackError extends Error {}

describe('grace transition atomicity', () => {
	beforeEach(resetTestServer);

	it('writes the marker and the deadline together through one transaction handle', async () => {
		await useTestServer('grace-atomic-commit');
		const hash = storePathHashSchema.parse(repeated('k'));

		await runInDurableObject(currentServer(), (instance) => {
			const retention = new RetentionService(instance.context);
			const cache = resolvedCache(instance.context);

			instance.context.db.transaction((tx) => {
				retention.markCacheGraceManaged(cache, tx);
				retention.extendGraceDeadlines(cache, [hash], liveDeadline, tx);
			});
		});

		expect({
			graceManaged: await hasGraceManagedMarker(defaultCache()),
			deadlines: await graceDeadlineRows(defaultCache())
		}).toStrictEqual({
			graceManaged: true,
			deadlines: [{ storePathHash: hash, retainUntil: liveDeadline }]
		});
	});

	it('rolls back the marker together with the deadline when the transaction fails', async () => {
		await useTestServer('grace-atomic-rollback');
		const hash = storePathHashSchema.parse(repeated('l'));

		await runInDurableObject(currentServer(), (instance) => {
			const retention = new RetentionService(instance.context);
			const cache = resolvedCache(instance.context);

			expect(() => {
				instance.context.db.transaction((tx) => {
					retention.markCacheGraceManaged(cache, tx);
					retention.extendGraceDeadlines(cache, [hash], liveDeadline, tx);
					throw new ForcedRollbackError();
				});
			}).toThrow(ForcedRollbackError);
		});

		expect({
			graceManaged: await hasGraceManagedMarker(defaultCache()),
			deadlines: await graceDeadlineRows(defaultCache())
		}).toStrictEqual({ graceManaged: false, deadlines: [] });
	});

	it('rolls back a root deletion together with the grace transition it releases', async () => {
		await useTestServer('grace-atomic-root-delete');
		await setDefaultCacheGrace(3600);

		const cacheScope = defaultCache();
		const name = rootNameSchema.parse('channel');
		const hash = storePathHashSchema.parse(repeated('m'));
		const storePath = storePathSchema.parse(`/nix/store/${repeated('m')}-x`);
		const nowIso = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');

		await runInDurableObject(currentServer(), (instance) => {
			const retention = new RetentionService(instance.context);
			const cache = resolvedCache(instance.context, cacheScope);

			instance.context.db
				.insert(schema.retentionRoots)
				.values({
					cacheId: cache.id,
					name,
					createdAt: nowIso,
					updatedAt: nowIso
				})
				.run();
			instance.context.db
				.insert(schema.retentionRootTargets)
				.values({
					cacheId: cache.id,
					rootName: name,
					storePathHash: hash,
					storePath
				})
				.run();

			expect(() => {
				instance.context.db.transaction((tx) => {
					tx.delete(schema.retentionRootTargets)
						.where(
							and(
								eq(schema.retentionRootTargets.cacheId, cache.id),
								eq(schema.retentionRootTargets.rootName, name)
							)
						)
						.run();
					tx.delete(schema.retentionRoots)
						.where(
							and(
								eq(schema.retentionRoots.cacheId, cache.id),
								eq(schema.retentionRoots.name, name)
							)
						)
						.run();
					retention.applyGraceTransition(cache, [hash], nowIso, tx);
					throw new ForcedRollbackError();
				});
			}).toThrow(ForcedRollbackError);
		});

		const survivors = await runInDurableObject(currentServer(), (instance) => {
			const cacheId = resolvedCache(instance.context, cacheScope).id;

			return {
				root: instance.context.db
					.select({ name: schema.retentionRoots.name })
					.from(schema.retentionRoots)
					.where(eq(schema.retentionRoots.cacheId, cacheId))
					.all(),
				targets: instance.context.db
					.select({ storePathHash: schema.retentionRootTargets.storePathHash })
					.from(schema.retentionRootTargets)
					.where(eq(schema.retentionRootTargets.cacheId, cacheId))
					.all()
			};
		});

		expect({
			survivors,
			graceManaged: await hasGraceManagedMarker(cacheScope),
			deadlines: await graceDeadlineRows(cacheScope)
		}).toStrictEqual({
			survivors: {
				root: [{ name }],
				targets: [{ storePathHash: hash }]
			},
			graceManaged: false,
			deadlines: []
		});
	});
});

describe('confirming an unretained publication', () => {
	beforeEach(resetTestServer);

	// The shared clock starts at 2026-01-01T00:00:00Z, so a 24-hour grace from a
	// confirmation processed immediately lands on the next midnight.
	const dayGraceSeconds = graceSecondsSchema.parse(86_400);
	const dayAfterStart = '2026-01-02T00:00:00.000Z';

	it('extends a confirmed path to now+grace and reports the deadline', async () => {
		await useTestServer('confirm-extends');
		const { token } = await bootstrap();
		await setDefaultCacheGrace(dayGraceSeconds);

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('a'),
			name: 'confirmed'
		});

		await pushPath(token, path);

		const confirmed = await confirmPaths(token, [path.storePathHash]);

		expect(confirmed).toStrictEqual({
			status: StatusCodes.OK,
			body: {
				paths: [
					{
						storePathHash: path.storePathHash,
						confirmed: true,
						grace: { retainUntil: dayAfterStart }
					}
				]
			}
		});
	});

	it('refuses a committed path whose canonical backing is gone', async () => {
		await useTestServer('confirm-lost-backing');
		const { token } = await bootstrap();
		await setDefaultCacheGrace(dayGraceSeconds);

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('b'),
			name: 'lost-backing'
		});

		await pushPath(token, path);

		// A dropped blob_state row is the shape of a reaped canonical NAR; a path
		// that can no longer be substituted must not be confirmed as kept. The
		// publication itself already granted a deadline legitimately; the clock
		// advances so a wrongful extension by the confirm would be visible.
		const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
		await database
			.delete(d1Schema.blobState)
			.where(eq(d1Schema.blobState.narHash, path.narHash));
		vi.setSystemTime(new Date('2026-01-01T00:05:00.000Z'));

		const confirmed = await confirmPaths(token, [path.storePathHash]);

		expect({
			confirmed,
			deadlines: await graceDeadlineRows(defaultCache())
		}).toStrictEqual({
			confirmed: {
				status: StatusCodes.OK,
				body: {
					paths: [{ storePathHash: path.storePathHash, confirmed: false }]
				}
			},
			deadlines: [
				{ storePathHash: path.storePathHash, retainUntil: dayAfterStart }
			]
		});
	});

	it('refuses a committed path whose canonical R2 object is gone', async () => {
		await useTestServer('confirm-lost-r2-backing');
		const { token } = await bootstrap();
		await setDefaultCacheGrace(dayGraceSeconds);

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('c'),
			name: 'lost-r2-backing'
		});

		await pushPath(token, path);
		await env.BLOBS.delete(await currentNarObjectKey(path.narHash));
		vi.setSystemTime(new Date('2026-01-01T00:05:00.000Z'));

		const confirmed = await confirmPaths(token, [path.storePathHash]);

		expect({
			confirmed,
			deadlines: await graceDeadlineRows(defaultCache())
		}).toStrictEqual({
			confirmed: {
				status: StatusCodes.OK,
				body: {
					paths: [{ storePathHash: path.storePathHash, confirmed: false }]
				}
			},
			deadlines: [
				{ storePathHash: path.storePathHash, retainUntil: dayAfterStart }
			]
		});
	});

	it('heals a missing tenant narinfo object before confirming', async () => {
		await useTestServer('confirm-heals-narinfo');
		const { token } = await bootstrap();
		await setDefaultCacheGrace(dayGraceSeconds);

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('d'),
			name: 'healed-narinfo'
		});

		await pushPath(token, path);
		const key = narInfoObjectKey(
			fixtureTenant,
			path.storePathHash,
			defaultCache()
		);
		await env.BLOBS.delete(key);

		const confirmed = await confirmPaths(token, [path.storePathHash]);
		const restored = await env.BLOBS.head(key);
		const narUrl = await currentNarObjectKey(path.narHash);

		expect({ confirmed, metadata: restored?.customMetadata }).toStrictEqual({
			confirmed: {
				status: StatusCodes.OK,
				body: {
					paths: [
						{
							storePathHash: path.storePathHash,
							confirmed: true,
							grace: { retainUntil: dayAfterStart }
						}
					]
				}
			},
			metadata: {
				generation: '0',
				narHash: path.narHash,
				narUrl,
				signatureGeneration: '1'
			}
		});
	});

	it('is idempotent and cannot shorten an already-extended deadline on retry', async () => {
		await useTestServer('confirm-retry');
		const { token } = await bootstrap();
		await setDefaultCacheGrace(dayGraceSeconds);

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('f'),
			name: 'retried'
		});

		await pushPath(token, path);

		const graceOf = async (): Promise<unknown> => {
			const confirmed = await confirmPaths(token, [path.storePathHash]);

			return confirmed.body.paths[0]?.grace;
		};

		const first = await graceOf();

		vi.setSystemTime(new Date('2026-01-01T00:02:00.000Z'));
		const later = await graceOf();

		vi.setSystemTime(new Date('2026-01-01T00:01:00.000Z'));
		const retried = await graceOf();

		expect({ first, later, retried }).toStrictEqual({
			first: { retainUntil: dayAfterStart },
			later: { retainUntil: '2026-01-02T00:02:00.000Z' },
			retried: { retainUntil: '2026-01-02T00:02:00.000Z' }
		});
	});

	it('marks the cache grace-managed and reports a configured zero grace', async () => {
		await useTestServer('confirm-zero');
		const { token } = await bootstrap();
		await setDefaultCacheGrace(0);

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('g'),
			name: 'zero'
		});

		await pushPath(token, path);

		const confirmed = await confirmPaths(token, [path.storePathHash]);

		expect({
			paths: confirmed.body.paths,
			graceManaged: await hasGraceManagedMarker(defaultCache()),
			deadlines: await graceDeadlineRows(defaultCache())
		}).toStrictEqual({
			paths: [
				{
					storePathHash: path.storePathHash,
					confirmed: true,
					grace: { graceSeconds: 0 }
				}
			],
			graceManaged: true,
			deadlines: []
		});
	});

	it('leaves the cache unmanaged when it has no configured grace', async () => {
		await useTestServer('confirm-no-grace');
		const { token } = await bootstrap();

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('h'),
			name: 'unmanaged'
		});

		await pushPath(token, path);

		const confirmed = await confirmPaths(token, [path.storePathHash]);

		expect({
			paths: confirmed.body.paths,
			graceManaged: await hasGraceManagedMarker(defaultCache())
		}).toStrictEqual({
			paths: [
				{ storePathHash: path.storePathHash, confirmed: true, grace: {} }
			],
			graceManaged: false
		});
	});

	it('returns false for an uncommitted or reserved path without extending grace', async () => {
		await useTestServer('confirm-uncommitted');
		const { token } = await bootstrap();
		await setDefaultCacheGrace(dayGraceSeconds);

		const untouched = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('i'),
			name: 'untouched'
		});
		const reserved = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('j'),
			name: 'reserved'
		});

		// Negotiated but never committed: a pending_upload row exists, but no
		// narinfo row does.
		await negotiateUploads(token, [reserved]);

		const confirmed = await confirmPaths(token, [
			untouched.storePathHash,
			reserved.storePathHash
		]);

		expect({
			paths: confirmed.body.paths,
			graceManaged: await hasGraceManagedMarker(defaultCache()),
			deadlines: await graceDeadlineRows(defaultCache())
		}).toStrictEqual({
			paths: [
				{ storePathHash: untouched.storePathHash, confirmed: false },
				{ storePathHash: reserved.storePathHash, confirmed: false }
			],
			graceManaged: false,
			deadlines: []
		});
	});

	// The narinfo row can change while the committed and backed checks await
	// shared state. Recheck its identity before granting a deadline to the
	// current generation.
	it('confirms false when the row moves during the shared-fact checks', async () => {
		await useTestServer('confirm-moved-row');
		const { token } = await bootstrap();
		await setDefaultCacheGrace(dayGraceSeconds);

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('n'),
			name: 'moved'
		});

		await pushPath(token, path);

		// The publication itself granted today's deadline legitimately; the
		// clock advances so a wrongful extension by the confirm would show.
		vi.setSystemTime(new Date('2026-01-01T00:05:00.000Z'));

		// The blob_ref edge read is the first shared-fact query the confirm
		// issues, so a recommit fired on its preparation lands after the
		// snapshot and before the grace application.
		const hash = storePathHashSchema.parse(path.storePathHash);
		const response = await runInDurableObject(
			currentServer(),
			(instance, state) => {
				const cache = resolvedCache(instance.context);
				const moveRow = (): void => {
					instance.context.db
						.update(schema.narInfos)
						.set({ generation: sql`${schema.narInfos.generation} + 1` })
						.where(
							and(
								eq(schema.narInfos.cacheId, cache.id),
								eq(schema.narInfos.storePathHash, hash)
							)
						)
						.run();
				};
				const context = new ServerContext(state, {
					...instance.context.env,
					CUPBOARD_DB: flakyD1(instance.context.env.CUPBOARD_DB, {
						failures: 0,
						matches: (query) => query.includes('blob_ref'),
						onMatch: moveRow
					})
				});

				return uploadsServiceFor(context).confirmPaths(defaultCache(), [hash]);
			}
		);

		expect({
			paths: response.paths,
			deadlines: await graceDeadlineRows(defaultCache())
		}).toStrictEqual({
			paths: [{ storePathHash: path.storePathHash, confirmed: false }],
			deadlines: [
				{ storePathHash: path.storePathHash, retainUntil: dayAfterStart }
			]
		});
	});

	// Deduplicate the work but preserve one result for every requested entry.
	it('returns duplicate entries from one batched application', async () => {
		await useTestServer('confirm-duplicates');
		const { token } = await bootstrap();
		await setDefaultCacheGrace(dayGraceSeconds);

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('p'),
			name: 'duplicated'
		});

		await pushPath(token, path);

		const hash = storePathHashSchema.parse(path.storePathHash);
		const result = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const transactions = vi.spyOn(instance.context.db, 'transaction');
				const uploads = uploadsServiceFor(instance.context);
				const response = await uploads.confirmPaths(defaultCache(), [
					hash,
					hash,
					hash
				]);
				const transactionCount = transactions.mock.calls.length;

				transactions.mockRestore();

				return { response, transactionCount };
			}
		);

		const confirmedEntry = {
			storePathHash: path.storePathHash,
			confirmed: true,
			grace: { retainUntil: dayAfterStart }
		};

		expect({
			...result,
			deadlines: await graceDeadlineRows(defaultCache())
		}).toStrictEqual({
			response: { paths: [confirmedEntry, confirmedEntry, confirmedEntry] },
			transactionCount: 1,
			deadlines: [
				{ storePathHash: path.storePathHash, retainUntil: dayAfterStart }
			]
		});
	});

	// Chunk the identity checks so a request at the protocol limit stays within
	// SQLite's bound-parameter limit.
	it('applies a batch at the request bound through chunked transactions', async () => {
		await useTestServer('confirm-at-bound');
		await bootstrap();

		const narHash = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('a'),
			name: 'template'
		}).narHash;
		const hashes = Array.from({ length: uploadConfirmMaxPaths }, (_, index) =>
			storePathHashSchema.parse(String(index).padStart(32, '0'))
		);

		const result = await runInDurableObject(currentServer(), (instance) => {
			const cache = resolvedCache(instance.context);

			for (let start = 0; start < hashes.length; start += 10) {
				instance.context.db
					.insert(schema.narInfos)
					.values(
						hashes.slice(start, start + 10).map((storePathHash) => ({
							cacheId: cache.id,
							storePathHash,
							storePath: storePathSchema.parse(
								`/nix/store/${storePathHash}-seeded`
							),
							narHash,
							narSize: narBytes.byteLength,
							referencesJson: '[]',
							generation: narInfoGenerationSchema.parse(1),
							createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z')
						}))
					)
					.run();
			}

			const transactions = vi.spyOn(instance.context.db, 'transaction');
			const facts = confirmGraceBatch(
				instance.context,
				new RetentionService(instance.context),
				cache,
				hashes.map((storePathHash) => ({
					storePathHash,
					generation: narInfoGenerationSchema.parse(1),
					narHash
				})),
				graceSecondsSchema.parse(86_400)
			);
			const transactionCount = transactions.mock.calls.length;

			transactions.mockRestore();

			return { matched: facts.size, transactionCount };
		});

		const deadlines = await graceDeadlineRows(defaultCache());

		expect({
			...result,
			deadlines: deadlines.length
		}).toStrictEqual({
			matched: uploadConfirmMaxPaths,
			transactionCount: 12,
			deadlines: uploadConfirmMaxPaths
		});
	});

	it('refuses negotiate and commit to a confirm-only grant, and confirm to a commit-only grant', async () => {
		await useTestServer('confirm-authz');
		const { token } = await bootstrap();

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('k'),
			name: 'authz'
		});

		await pushPath(token, path);

		const confirmOnlyToken = await issueServerSignedToken(confirmOnlyGrants());
		const commitToken = await issueServerSignedToken(cacheWriteGrants());

		const negotiateResponse = await authorisedFetch(
			'/uploads',
			confirmOnlyToken,
			{
				body: JSON.stringify({
					pushId: testPushId,
					paths: [uploadPathNegotiation(path)]
				}),
				headers: { 'content-type': 'application/json' },
				method: 'POST'
			}
		);
		const commitResponse = await authorisedFetch('/commit', confirmOnlyToken, {
			headers: { upgrade: 'websocket' }
		});
		// upload:commit is runtime authority over upload-specific state only; the
		// implication to upload:confirm (a refresh reaching any already-committed
		// path in the cache) is issuance-only, so a presented commit-only token
		// must not reach confirm.
		const confirmByCommitTokenResponse = await authorisedFetch(
			'/uploads/confirm',
			commitToken,
			{
				body: JSON.stringify({ storePathHashes: [path.storePathHash] }),
				headers: { 'content-type': 'application/json' },
				method: 'POST'
			}
		);

		expect({
			negotiateStatus: negotiateResponse.status,
			commitStatus: commitResponse.status,
			confirmByCommitTokenStatus: confirmByCommitTokenResponse.status
		}).toStrictEqual({
			negotiateStatus: StatusCodes.FORBIDDEN,
			commitStatus: StatusCodes.FORBIDDEN,
			confirmByCommitTokenStatus: StatusCodes.FORBIDDEN
		});
	});
});
