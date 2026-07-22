import { rootLogger } from '@cupboard/logger';
import {
	cacheNameSchema,
	DEFAULT_CACHE,
	rootNameSchema,
	type StoredCache,
	storedCacheSchema,
	storePathHashSchema,
	storePathSchema,
	WIRE_DEFAULT_CACHE
} from '@cupboard/nix-store/scalars';
import {
	type AuthorizationDetails,
	authorizationDetailsSchema
} from '@cupboard/protocol/grants';
import { type UploadId, uploadIdSchema } from '@cupboard/protocol/upload';
import {
	acceptCapabilitiesHeader,
	uploadCapabilitiesHeader,
	uploadCapabilitiesValue,
	uploadConfirmMaxPaths,
	type UploadConfirmResponse,
	uploadConfirmResponseSchema,
	uploadGraceFactsCapability,
	uploadNegotiateResponseSchema
} from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { narInfoObjectKey, narObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	authorisedFetch,
	bootstrap,
	cacheWriteGrants,
	clearBlobStorage,
	commitUpload,
	currentServer,
	deletePath,
	expectSingleUploadDecision,
	flakyD1,
	issueServerSignedToken,
	markUploadPendingVerification,
	narBytes,
	narInfoGeneration,
	negotiateUploads,
	openCommitSession,
	pendingUploadVerdict,
	pushPath,
	putNarBytes,
	removeRoot,
	resetTestServer,
	setRoot,
	singleDecision,
	testPushId,
	uploadMetadata,
	uploadPathNegotiation,
	useTestServer,
	verifiableNar
} from '../test-support.ts';

import { AttestationCasService } from './attestation-cas-service.ts';
import { AttestationsService } from './attestations-service.ts';
import { CacheAdminService } from './cache-admin-service.ts';
import { CommitPipelineService } from './commit-pipeline-service.ts';
import { ServerContext } from './context.ts';
import { DeletionQueueService } from './deletion-queue-service.ts';
import {
	maxExpiredRootTargetsPerRun,
	maxPathsSweptPerRun,
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
import { gcContinuationKey } from './server.ts';
import { SigningKeysService } from './signing-keys-service.ts';
import { UploadStateService } from './upload-state-service.ts';
import { UploadsService } from './uploads-service.ts';
import { VerificationService } from './verification-service.ts';

const repeated = (character: string): string => character.repeat(32);
const tenantWideContinuation = {
	scope: 'tenant',
	sweepLimit: maxPathsSweptPerRun
};

// The pipeline over a live instance's context, as the server itself builds it.
function pipelineFor(context: ServerContext): CommitPipelineService {
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

	return new CommitPipelineService(
		context,
		new CacheAdminService(context, deletionQueue),
		new SigningKeysService(context),
		new UploadStateService(context),
		narInfoObjects,
		new RetentionService(context)
	);
}

// The uploads service over a live instance's context, as the server itself
// builds it.
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

	return new UploadsService(
		context,
		new UploadStateService(context),
		narInfoObjects,
		deletionQueue,
		new ReconcileQueueService(context),
		new RetentionService(context)
	);
}

const defaultCache: StoredCache = DEFAULT_CACHE;
const buildsCache = cacheNameSchema.parse('builds');
const pr5Cache = cacheNameSchema.parse('pr-5');

// The shared test clock is pinned to 2026-01-01, so these bracket "now".
const liveDeadline = '2026-06-01T00:00:00.000Z';
const expiredDeadline = '2025-12-01T00:00:00.000Z';

async function seedGraceDeadline(
	cache: string,
	storePathHash: string,
	retainUntil: string
): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		instance.context.db
			.insert(schema.retentionGrace)
			.values({
				cache: storedCacheSchema.parse(cache),
				storePathHash: storePathHashSchema.parse(storePathHash),
				retainUntil
			})
			.run();
	});
}

async function markGraceManaged(cache: string): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		instance.context.db
			.update(schema.caches)
			.set({ graceManaged: true })
			.where(eq(schema.caches.name, storedCacheSchema.parse(cache)))
			.run();
	});
}

async function graceDeadlines(cache: string): Promise<readonly string[]> {
	return runInDurableObject(currentServer(), (instance) =>
		instance.context.db
			.select({ storePathHash: schema.retentionGrace.storePathHash })
			.from(schema.retentionGrace)
			.where(eq(schema.retentionGrace.cache, storedCacheSchema.parse(cache)))
			.all()
			.map((row) => row.storePathHash)
	);
}

async function runGc(): Promise<void> {
	await currentServer().runGarbageCollection();
}

describe('retention grace deadlines in garbage collection', () => {
	beforeEach(resetTestServer);

	it('keeps a live deadline and its transitive closure through a sweep', async () => {
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
		await seedGraceDeadline(DEFAULT_CACHE, kept.storePathHash, liveDeadline);

		await runGc();

		expect({
			kept: (await narInfoGeneration(kept.storePathHash)) !== undefined,
			dependency:
				(await narInfoGeneration(dependency.storePathHash)) !== undefined,
			collectable:
				(await narInfoGeneration(collectable.storePathHash)) !== undefined,
			deadlines: await graceDeadlines(DEFAULT_CACHE)
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
		await seedGraceDeadline(DEFAULT_CACHE, path.storePathHash, expiredDeadline);
		await markGraceManaged(DEFAULT_CACHE);

		await runGc();

		expect({
			path: await narInfoGeneration(path.storePathHash),
			deadlines: await graceDeadlines(DEFAULT_CACHE)
		}).toStrictEqual({ path: undefined, deadlines: [] });
	});

	it('drains a grace-managed cache that holds no deadlines at all', async () => {
		await useTestServer('grace-managed-empty');
		const { token } = await bootstrap();

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('g'),
			name: 'drained'
		});

		await pushPath(token, path);
		await markGraceManaged(DEFAULT_CACHE);

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
			DEFAULT_CACHE,
			first.storePathHash,
			expiredDeadline
		);
		await seedGraceDeadline(
			DEFAULT_CACHE,
			second.storePathHash,
			expiredDeadline
		);
		await markGraceManaged(DEFAULT_CACHE);

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
		await seedGraceDeadline(DEFAULT_CACHE, path.storePathHash, liveDeadline);

		const outcome = await deletePath(
			token,
			storePathHashSchema.parse(path.storePathHash)
		);

		expect({
			deleted: outcome.deleted,
			deadlines: await graceDeadlines(DEFAULT_CACHE)
		}).toStrictEqual({ deleted: true, deadlines: [] });
	});

	it('cache deletion removes its deadlines and grace-managed marker', async () => {
		await useTestServer('grace-cache-deletion');
		const { token } = await bootstrap();

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('8'),
			name: 'torn-down'
		});

		await pushPath(token, path, 'builds');
		await seedGraceDeadline('builds', path.storePathHash, liveDeadline);
		await markGraceManaged('builds');

		const response = await authorisedFetch('/caches/builds?force=true', token, {
			method: 'DELETE'
		});
		const registryRow = await runInDurableObject(currentServer(), (instance) =>
			instance.context.db
				.select({ name: schema.caches.name })
				.from(schema.caches)
				.where(eq(schema.caches.name, buildsCache))
				.get()
		);

		expect({
			status: response.status,
			deadlines: await graceDeadlines('builds'),
			registryRow
		}).toStrictEqual({
			status: StatusCodes.OK,
			deadlines: [],
			registryRow: undefined
		});
	});
});

async function addGracePolicy(
	cachePrefix: string,
	graceSeconds: number
): Promise<string> {
	return runInDurableObject(
		currentServer(),
		(instance) =>
			new RetentionService(instance.context).addGracePolicy({
				cachePrefix,
				graceSeconds
			}).id
	);
}

async function removeGracePolicy(id: string): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		new RetentionService(instance.context).removeGracePolicy(id);
	});
}

async function graceDeadlineRows(
	cache: string
): Promise<readonly { storePathHash: string; retainUntil: string }[]> {
	return runInDurableObject(currentServer(), (instance) =>
		instance.context.db
			.select({
				storePathHash: schema.retentionGrace.storePathHash,
				retainUntil: schema.retentionGrace.retainUntil
			})
			.from(schema.retentionGrace)
			.where(eq(schema.retentionGrace.cache, storedCacheSchema.parse(cache)))
			.orderBy(schema.retentionGrace.storePathHash)
			.all()
	);
}

async function graceManagedMarker(cache: string): Promise<boolean> {
	return runInDurableObject(
		currentServer(),
		(instance) =>
			instance.context.db
				.select({ graceManaged: schema.caches.graceManaged })
				.from(schema.caches)
				.where(eq(schema.caches.name, storedCacheSchema.parse(cache)))
				.get()?.graceManaged ?? false
	);
}

describe('retention grace transitions', () => {
	beforeEach(resetTestServer);

	// The shared clock starts at 2026-01-01T00:00:00Z, so a 24-hour grace from a
	// transition processed immediately lands on the next midnight.
	const dayGraceSeconds = 86_400;
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
		// The policy arrives only after publication, so the replacement below is
		// the sole source of any deadline.
		await addGracePolicy('', dayGraceSeconds);
		await setRoot(token, {
			name: 'channel',
			targets: [kept.storePath, released.storePath]
		});
		await setRoot(token, { name: 'channel', targets: [kept.storePath] });

		expect({
			deadlines: await graceDeadlineRows(DEFAULT_CACHE),
			graceManaged: await graceManagedMarker(DEFAULT_CACHE)
		}).toStrictEqual({
			deadlines: [
				{ storePathHash: released.storePathHash, retainUntil: dayAfterStart }
			],
			graceManaged: true
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
		await addGracePolicy('', dayGraceSeconds);
		await setRoot(token, {
			name: 'channel',
			targets: [kept.storePath, deleted.storePath]
		});
		// The delete leaves the root's target row behind, so the removal below
		// still releases the vanished hash; no deadline may back it.
		await deletePath(token, deleted.storePathHash);
		await removeRoot(token, 'channel');

		expect(await graceDeadlineRows(DEFAULT_CACHE)).toStrictEqual([
			{ storePathHash: kept.storePathHash, retainUntil: dayAfterStart }
		]);
	});

	it('grants deadlines to every target of a removed root, surviving a sweep', async () => {
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
		// The policy arrives only after publication, so the removal below is the
		// sole source of the deadlines.
		await addGracePolicy('', dayGraceSeconds);
		await setRoot(token, {
			name: 'channel',
			targets: [first.storePath, second.storePath]
		});
		await removeRoot(token, 'channel');
		await runGc();

		expect({
			deadlines: await graceDeadlineRows(DEFAULT_CACHE),
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

	it('anchors an expiry transition at the nominal expiry, not the sweep', async () => {
		await useTestServer('transition-expiry');
		const { token } = await bootstrap();
		await addGracePolicy('', dayGraceSeconds);

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

		// The sweep runs an hour after the root's expiry; the deadline must still
		// measure from the expiry itself.
		vi.setSystemTime(new Date('2026-01-01T02:00:00.000Z'));
		await runGc();

		expect({
			deadlines: await graceDeadlineRows(DEFAULT_CACHE),
			path: (await narInfoGeneration(path.storePathHash)) !== undefined,
			graceManaged: await graceManagedMarker(DEFAULT_CACHE)
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
		await addGracePolicy('', dayGraceSeconds);

		const rootCount = maxRootsExpiredPerRun + 1;
		const firstExpiry = Date.now() - rootCount * 1000;
		const finalDeadline = new Date(
			firstExpiry + maxRootsExpiredPerRun * 1000 + dayGraceSeconds * 1000
		).toISOString();

		await runInDurableObject(currentServer(), (instance) => {
			for (let index = 0; index < rootCount; index += 1) {
				const name = rootNameSchema.parse(
					`expired-${String(index).padStart(2, '0')}`
				);
				const expiresAt = new Date(firstExpiry + index * 1000).toISOString();

				instance.context.db
					.insert(schema.retentionRoots)
					.values({
						cache: defaultCache,
						name,
						expiresAt,
						createdAt: expiresAt,
						updatedAt: expiresAt
					})
					.run();
				instance.context.db
					.insert(schema.retentionRootTargets)
					.values({
						cache: defaultCache,
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
						policyResolutions: resolveGrace.mock.calls.length
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
							policyResolutions: resolveGrace.mock.calls.length
						}
					};
				}
			);

			expect(observed).toStrictEqual({
				firstPass: {
					remainingRoots: 1,
					continuation: [tenantWideContinuation],
					policyResolutions: 1
				},
				settled: {
					remainingRoots: 0,
					deadline: finalDeadline,
					continuation: undefined,
					policyResolutions: 1
				}
			});
		} finally {
			resolveGrace.mockRestore();
		}
	});

	it('continues target batches within a stored root over the protocol limit', async () => {
		await useTestServer('transition-expiry-target-continuation');
		const { token } = await bootstrap();
		await addGracePolicy('', dayGraceSeconds);
		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('0'),
			name: 'retained-across-target-batches'
		});
		await pushPath(token, path);
		const rootName = rootNameSchema.parse('oversized');
		const expiresAt = new Date(Date.now() - 1000).toISOString();
		const targetCount = maxExpiredRootTargetsPerRun + 1;

		const observed = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				instance.context.db
					.insert(schema.retentionRoots)
					.values({
						cache: defaultCache,
						name: rootName,
						expiresAt,
						createdAt: expiresAt,
						updatedAt: expiresAt
					})
					.run();
				instance.context.db
					.insert(schema.retentionRootTargets)
					.values({
						cache: defaultCache,
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
						cache, root_name, store_path_hash, store_path
					)
					SELECT ?, ?, printf('%032d', value),
						'/nix/store/' || printf('%032d', value) || '-target'
					FROM numbers`,
					targetCount - 1,
					DEFAULT_CACHE,
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
			service.extendGraceDeadlines('', [hash], '2026-03-01T00:00:00.000Z');
			service.extendGraceDeadlines('', [hash], '2026-02-01T00:00:00.000Z');
		});

		expect(await graceDeadlineRows(DEFAULT_CACHE)).toStrictEqual([
			{ storePathHash: hash, retainUntil: '2026-03-01T00:00:00.000Z' }
		]);
	});

	it('marks the cache on a zero grace without granting a deadline', async () => {
		await useTestServer('transition-zero');
		const { token } = await bootstrap();
		await addGracePolicy('', 0);

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('4'),
			name: 'zero'
		});

		await pushPath(token, path);
		await setRoot(token, { name: 'channel', targets: [path.storePath] });
		await removeRoot(token, 'channel');

		expect({
			deadlines: await graceDeadlineRows(DEFAULT_CACHE),
			graceManaged: await graceManagedMarker(DEFAULT_CACHE)
		}).toStrictEqual({ deadlines: [], graceManaged: true });
	});

	it('leaves a cache with no matching policy untouched', async () => {
		await useTestServer('transition-no-policy');
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
			deadlines: await graceDeadlineRows(DEFAULT_CACHE),
			graceManaged: await graceManagedMarker(DEFAULT_CACHE)
		}).toStrictEqual({ deadlines: [], graceManaged: false });
	});

	it('resolves the longest matching prefix', async () => {
		await useTestServer('transition-longest-prefix');
		await bootstrap();

		const resolved = await runInDurableObject(currentServer(), (instance) => {
			const service = new RetentionService(instance.context);
			const withoutPolicies = service.resolveGraceSeconds(pr5Cache);

			service.addGracePolicy({ cachePrefix: '', graceSeconds: 604_800 });
			service.addGracePolicy({ cachePrefix: 'pr-', graceSeconds: 3600 });

			return {
				withoutPolicies,
				prCache: service.resolveGraceSeconds(pr5Cache),
				otherCache: service.resolveGraceSeconds(buildsCache)
			};
		});

		expect(resolved).toStrictEqual({
			withoutPolicies: undefined,
			prCache: 3600,
			otherCache: 604_800
		});
	});
});

describe('retention grace at publication', () => {
	beforeEach(resetTestServer);

	const dayGraceSeconds = 86_400;
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
		await addGracePolicy('', dayGraceSeconds);

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('a'),
			name: 'published'
		});

		await pushPath(token, path);
		await runGc();

		expect({
			deadlines: await graceDeadlineRows(DEFAULT_CACHE),
			graceManaged: await graceManagedMarker(DEFAULT_CACHE),
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
		await addGracePolicy('', dayGraceSeconds);

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('b'),
			name: 'rooted'
		});

		await pushPath(token, path);
		await setRoot(token, { name: 'channel', targets: [path.storePath] });

		expect(await graceDeadlineRows(DEFAULT_CACHE)).toStrictEqual([
			{ storePathHash: path.storePathHash, retainUntil: dayAfterStart }
		]);
	});

	it('keeps the captured grace across policy removal on a deferred upload', async () => {
		await useTestServer('publication-deferred');
		await clearBlobStorage();
		const { token } = await bootstrap();
		const policyId = await addGracePolicy('', dayGraceSeconds);

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
		const beforeVerification = await graceDeadlineRows(DEFAULT_CACHE);

		await removeGracePolicy(policyId);
		await currentServer().runVerification();

		expect({
			pendingDecision,
			beforeVerification,
			afterVerification: await graceDeadlineRows(DEFAULT_CACHE)
		}).toStrictEqual({
			pendingDecision: { reportsGrace: false, graceSeconds: dayGraceSeconds },
			beforeVerification: [],
			afterVerification: [
				{ storePathHash: metadata.storePathHash, retainUntil: dayAfterStart }
			]
		});
	});

	// A pending upload negotiated before the grace-decision column existed
	// carries NULL there. Verification must still materialise it, treating the
	// row as though no policy matched, even when a policy now covers the cache.
	it('materialises a pre-decision pending row without granting grace', async () => {
		await useTestServer('publication-null-decision');
		await clearBlobStorage();
		const { token } = await bootstrap();
		await addGracePolicy('', dayGraceSeconds);

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
		await currentServer().runVerification();

		expect({
			materialised:
				(await narInfoGeneration(metadata.storePathHash)) !== undefined,
			deadlines: await graceDeadlineRows(DEFAULT_CACHE),
			graceManaged: await graceManagedMarker(DEFAULT_CACHE)
		}).toStrictEqual({
			materialised: true,
			deadlines: [],
			graceManaged: false
		});
	});

	it('grants nothing when verification fails', async () => {
		await useTestServer('publication-mismatch');
		await clearBlobStorage();
		const { token } = await bootstrap();
		await addGracePolicy('', dayGraceSeconds);

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

		// Bytes whose checksum matches the declared fileHash but which decompress
		// to a different NAR than the declared hash: a background mismatch.
		await putNarBytes(upload.r2Key, wrong);
		await markUploadPendingVerification(upload.uploadId);
		await currentServer().runVerification();

		expect({
			deadlines: await graceDeadlineRows(DEFAULT_CACHE),
			graceManaged: await graceManagedMarker(DEFAULT_CACHE)
		}).toStrictEqual({ deadlines: [], graceManaged: false });
	});

	it('marks the cache grace-managed at publication on a zero grace', async () => {
		await useTestServer('publication-zero');
		const { token } = await bootstrap();
		await addGracePolicy('', 0);

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('f'),
			name: 'zero-grace'
		});

		await pushPath(token, path);

		const beforeSweep = {
			deadlines: await graceDeadlineRows(DEFAULT_CACHE),
			graceManaged: await graceManagedMarker(DEFAULT_CACHE)
		};

		await runGc();

		expect({
			...beforeSweep,
			path: await narInfoGeneration(path.storePathHash)
		}).toStrictEqual({
			deadlines: [],
			graceManaged: true,
			path: undefined
		});
	});

	it('leaves a publication with no matching policy unmanaged', async () => {
		await useTestServer('publication-no-policy');
		const { token } = await bootstrap();

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('g'),
			name: 'unmatched'
		});

		await pushPath(token, path);

		expect({
			deadlines: await graceDeadlineRows(DEFAULT_CACHE),
			graceManaged: await graceManagedMarker(DEFAULT_CACHE)
		}).toStrictEqual({ deadlines: [], graceManaged: false });
	});

	it('reports the stored maximum deadline, not the shorter candidate this commit alone computed', async () => {
		await useTestServer('publication-stored-maximum');
		await clearBlobStorage();
		const { token } = await bootstrap();
		await addGracePolicy('', dayGraceSeconds);

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

		await pushPath(token, seed, DEFAULT_CACHE, nar);

		const reused = uploadMetadata({
			storePathHash: repeated('i'),
			name: 'reused',
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		// A later deadline already sits on this path (an earlier longer policy,
		// or a root transition) before this commit's own candidate runs.
		await seedGraceDeadline(DEFAULT_CACHE, reused.storePathHash, liveDeadline);

		const negotiated = await negotiateUploads(
			token,
			[reused],
			DEFAULT_CACHE,
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
			deadlines: await graceDeadlineRows(DEFAULT_CACHE)
		}).toStrictEqual({
			frameGrace: { retainUntil: liveDeadline },
			deadlines: [
				{ storePathHash: seed.storePathHash, retainUntil: dayAfterStart },
				{ storePathHash: reused.storePathHash, retainUntil: liveDeadline }
			]
		});
	});

	// A concede answers success without ever running its own materialisation,
	// so a naive implementation reports the winner's bytes but never applies
	// the loser's own captured grace decision, leaving a positive policy
	// ungranted whenever nothing else established a deadline. Drives a real
	// concede deterministically: negotiate two upload ids for the identical
	// metadata before either commits, settle the first (the winner), then
	// commit the second — its own commit() call finds the row the winner just
	// committed and concedes through the hasCommittedReference re-drive.
	it.each([
		{
			id: 'positive',
			policySeconds: 3600,
			reportsGrace: true,
			expectManaged: true,
			expectRetainUntil: '2026-01-01T01:00:00.000Z',
			expectGrace: { retainUntil: '2026-01-01T01:00:00.000Z' }
		},
		{
			id: 'legacy',
			policySeconds: undefined,
			reportsGrace: false,
			expectManaged: false,
			expectRetainUntil: undefined,
			expectGrace: undefined
		},
		{
			id: 'zero',
			policySeconds: 0,
			reportsGrace: true,
			expectManaged: true,
			expectRetainUntil: undefined,
			expectGrace: { graceSeconds: 0 }
		}
	] as const)(
		'applies captured grace to a re-drive concede ($id)',
		async ({
			id,
			policySeconds,
			reportsGrace: shouldReportGrace,
			expectManaged,
			expectRetainUntil,
			expectGrace
		}) => {
			await useTestServer(`concede-redrive-${id}`);
			const { token } = await bootstrap();

			if (policySeconds !== undefined) {
				await addGracePolicy('', policySeconds);
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
				DEFAULT_CACHE,
				shouldReportGrace
			);
			const second = await negotiateUploads(
				token,
				[metadata],
				DEFAULT_CACHE,
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
			// Handles both an immediate settlement and a deferred one that needs a
			// verification pass; either way, the winner ends up fully committed.
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
				graceManaged: await graceManagedMarker(DEFAULT_CACHE),
				deadlines: await graceDeadlineRows(DEFAULT_CACHE)
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
		await addGracePolicy('', 3600);

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

		// Commit the winner so its canonical blob and its narinfo row both
		// exist, then call concedeToWinner directly for the identical store
		// path: the deterministic shape a losing reservation reaches when
		// committedNarInfoRow now finds the winner. A synthetic upload id and
		// the canonical staging key are safe here, matching how the sibling
		// "defers when no committed winner exists" test in
		// commit-reservation-reclaim.workers.test.ts drives this same method.
		await pushPath(token, metadata, DEFAULT_CACHE, nar);

		const outcome = await runInDurableObject(currentServer(), (instance) =>
			pipelineFor(instance.context).concedeToWinner(
				rootLogger(),
				DEFAULT_CACHE,
				uploadIdSchema.parse('loser-upload'),
				uploadPathNegotiation(metadata),
				narObjectKey(metadata.narHash),
				{ reportsGrace: true, graceSeconds: 3600 }
			)
		);

		expect({
			outcome,
			graceManaged: await graceManagedMarker(DEFAULT_CACHE),
			deadlines: await graceDeadlineRows(DEFAULT_CACHE)
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

	// The concede destroys the pending row (and its staging object) as its
	// bookkeeping, and the captured decision lives on that row: the grace
	// application must precede the destruction, or an interruption between
	// the two would lose the grant with the row. Faulting the staging delete
	// proves the order — the deadline exists even though the concede failed.
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

		await pushPath(token, metadata, DEFAULT_CACHE, nar);

		const outcome = await runInDurableObject(
			currentServer(),
			async (instance) => {
				instance.context.env = {
					...instance.context.env,
					BLOBS: failingDeleteBucket(instance.context.env.BLOBS)
				};

				// A private, non-canonical staging key so the concede's clean-up
				// issues the faulting delete.
				try {
					await pipelineFor(instance.context).concedeToWinner(
						rootLogger(),
						DEFAULT_CACHE,
						uploadIdSchema.parse('loser-upload'),
						uploadPathNegotiation(metadata),
						'staging/loser-upload',
						{ reportsGrace: true, graceSeconds: 3600 }
					);

					return 'settled' as const;
				} catch {
					return 'failed' as const;
				}
			}
		);

		expect({
			outcome,
			deadlines: await graceDeadlineRows(DEFAULT_CACHE)
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

	// The flush charges the durable edge before applying the captured grace,
	// so an interruption between the two leaves a committed generation whose
	// decision still sits on the pending row. The verify pass that re-claims
	// such a row must reapply the decision before clearing it, not just
	// finish the marker bookkeeping.
	it('reapplies the stored decision when recovery re-claims a committed generation', async () => {
		await useTestServer('grace-recovery');
		await clearBlobStorage();
		const { token } = await bootstrap();
		await addGracePolicy('', dayGraceSeconds);

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
		await currentServer().runVerification();

		// Reconstruct the interruption: the generation is committed and
		// charged, but the captured decision was never applied and the row
		// holding it never cleared.
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.delete(schema.retentionGrace)
				.where(eq(schema.retentionGrace.cache, DEFAULT_CACHE))
				.run();
			instance.context.db
				.update(schema.caches)
				.set({ graceManaged: false })
				.where(eq(schema.caches.name, DEFAULT_CACHE))
				.run();
			instance.context.db
				.insert(schema.pendingUploads)
				.values({ ...row, verdict: 'pending', claimedAt: undefined })
				.run();
		});

		await currentServer().runVerification();

		expect({
			deadlines: await graceDeadlineRows(DEFAULT_CACHE),
			graceManaged: await graceManagedMarker(DEFAULT_CACHE),
			verdict: await pendingUploadVerdict(upload.uploadId)
		}).toStrictEqual({
			deadlines: [
				{ storePathHash: metadata.storePathHash, retainUntil: dayAfterStart }
			],
			graceManaged: true,
			verdict: undefined
		});
	});

	// A concede reads its winner, awaits an object heal, and only then applies
	// the captured grace, so the row can move inside the window. Settling on
	// the stale read would report a row that no longer holds the path and
	// silently drop the grant; the concede must re-resolve, and a moved row
	// whose new holder has not committed defers to the verify pass.
	it('refuses to settle on a winner that moved during the concede', async () => {
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

		await pushPath(token, metadata, DEFAULT_CACHE, nar);

		const hash = storePathHashSchema.parse(metadata.storePathHash);
		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				// The first head probe of the object heal bumps the winner's
				// generation, the shape of a recommit landing inside the
				// concede's await window; the retry that follows sees the row
				// hold still.
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
								eq(schema.narInfos.cache, DEFAULT_CACHE),
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
					DEFAULT_CACHE,
					uploadIdSchema.parse('loser-upload'),
					uploadPathNegotiation(metadata),
					narObjectKey(metadata.narHash),
					{ reportsGrace: true, graceSeconds: 3600 }
				);

				return { outcome, hasMoved };
			}
		);

		// The moved row's new generation has no committed edge, so the re-read
		// finds no committed winner: the concede defers, keeping the upload row
		// (and its captured decision) live for the verify pass, instead of
		// settling on the stale winner with no deadline behind it.
		expect({
			...result,
			deadlines: await graceDeadlineRows(DEFAULT_CACHE)
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

	// The concede's re-resolution is bounded: sustained recommit churn would
	// otherwise keep one request re-reading the winner and healing its object
	// indefinitely. Past the cap the upload defers, keeping its row and
	// captured decision for the verify pass.
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

		await pushPath(token, metadata, DEFAULT_CACHE, nar);

		const hash = storePathHashSchema.parse(metadata.storePathHash);
		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				// Every object-heal probe bumps the winner again, and an edge is
				// pre-seeded for each future generation so every re-read still
				// finds a committed winner: the shape of sustained recommit
				// churn that never lets the path hold still.
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
							eq(schema.narInfos.cache, DEFAULT_CACHE),
							eq(schema.narInfos.storePathHash, hash)
						)
					)
					.get();

				if (live === undefined) {
					throw new Error('the churned path must be committed');
				}

				await database.insert(d1Schema.blobReference).values(
					Array.from({ length: 8 }, (_, index) => ({
						tenant: instance.context.requireTenant(),
						cache: defaultCache,
						storePathHash: hash,
						generation: live.generation + index + 1,
						narHash: live.narHash
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
								eq(schema.narInfos.cache, DEFAULT_CACHE),
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
					DEFAULT_CACHE,
					uploadIdSchema.parse('loser-upload'),
					uploadPathNegotiation(metadata),
					narObjectKey(metadata.narHash),
					{ reportsGrace: true, graceSeconds: 3600 }
				);

				return { outcome, bumpCount };
			}
		);

		expect({
			outcome: result.outcome,
			// One heal probe per attempt, so a bounded loop probes a bounded
			// number of times.
			boundedBumps: result.bumpCount <= 6,
			deadlines: await graceDeadlineRows(DEFAULT_CACHE)
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

	// The recovery short-circuit checks the committed edge over D1, so the
	// local row can move inside that await. Its "already committed" conclusion
	// is then stale: finishing the bookkeeping would clear the upload as a
	// success it never had. The pass must decline the short-circuit and drive
	// the upload to an honest terminal verdict instead.
	it('declines the recovery short-circuit when the row moves during the edge check', async () => {
		await useTestServer('recovery-moved-row');
		await clearBlobStorage();
		const { token } = await bootstrap();
		await addGracePolicy('', dayGraceSeconds);

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
		await currentServer().runVerification();

		// Reconstruct the interrupted flush, exactly as the recovery test
		// above does, so the next pass re-claims a committed generation.
		const hash = storePathHashSchema.parse(metadata.storePathHash);
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.delete(schema.retentionGrace)
				.where(eq(schema.retentionGrace.cache, DEFAULT_CACHE))
				.run();
			instance.context.db
				.insert(schema.pendingUploads)
				.values({ ...row, verdict: 'pending', claimedAt: undefined })
				.run();
		});

		// Drive the pass through a context whose committed-edge read moves the
		// row, the shape of a recommit landing inside the short-circuit's
		// window.
		const hasMoved = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
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
										eq(schema.narInfos.cache, DEFAULT_CACHE),
										eq(schema.narInfos.storePathHash, hash)
									)
								)
								.run();
						}
					)
				});

				await verificationFor(context).verifyPendingUploads(rootLogger(), 10);

				return hasMoved;
			}
		);

		// The moved row means the short-circuit's success is stale: the pass
		// declines it and, finding the row superseded by a replacement, settles
		// the upload to an honest terminal verdict in the same pass. No
		// deadline is ever granted against the moved identity.
		expect({
			hasMoved,
			verdict: await pendingUploadVerdict(upload.uploadId),
			deadlines: await graceDeadlineRows(DEFAULT_CACHE)
		}).toStrictEqual({
			hasMoved: true,
			verdict: 'mismatch',
			deadlines: []
		});
	});
});

// An R2 binding whose head probes run the given tap before delegating: a
// deterministic point for a test to interleave a concurrent mutation with the
// code under test.
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

// A D1 binding whose matching prepared queries run the given tap before
// delegating, the same deterministic interleaving point for reads that go to
// the shared database.
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

// The verification service over a live instance's context, as the server
// itself builds it. Failed verifications prune retention targets through the
// roots service; these tests never fail one into a root, so the prune is
// inert.
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
			new CacheAdminService(context, deletionQueue),
			new SigningKeysService(context),
			uploadState,
			narInfoObjects,
			retention
		),
		deletionQueue,
		narInfoObjects,
		uploadState,
		retention,
		() => {
			// These tests never fail a rooted upload, so nothing is pruned.
		}
	);
}

// An R2 binding whose deletes throw, the shape of a fault in the staging
// clean-up that follows a concede.
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

// Narrows a negotiate response to its single `upload` decision, the reconnect
// tests below use instead of `expectSingleUploadDecision`: a capable response
// also carries a `grace` fact, which that helper's fixed shape does
// not expect.
function plannedUploadDecision(
	response: Awaited<ReturnType<typeof negotiateUploads>>
): Extract<ReturnType<typeof singleDecision>, { action: 'upload' }> {
	const decision = singleDecision(response);

	if (decision.action !== 'upload') {
		throw new Error('expected a single upload decision');
	}

	return decision;
}

describe('retention grace facts on the wire', () => {
	beforeEach(async () => {
		await resetTestServer();
		await clearBlobStorage();
	});

	const dayGraceSeconds = 86_400;
	const dayAfterStart = '2026-01-02T00:00:00.000Z';
	const shouldReportGrace = true;

	it.each([
		{ reportsGrace: false, capabilities: undefined },
		{ reportsGrace: true, capabilities: uploadCapabilitiesValue }
	])(
		'acknowledges grace facts only when requested ($reportsGrace)',
		async ({ reportsGrace: shouldAcceptGraceFacts, capabilities }) => {
			const { token } = await bootstrap();
			const response = await authorisedFetch(
				`/cache/${WIRE_DEFAULT_CACHE}/uploads`,
				token,
				{
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						...(shouldAcceptGraceFacts && {
							[acceptCapabilitiesHeader]: uploadGraceFactsCapability
						})
					},
					body: JSON.stringify({ pushId: testPushId, paths: [] })
				}
			);

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
		await useTestServer('wire-decisions');
		const { token } = await bootstrap();
		await addGracePolicy('', dayGraceSeconds);

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
		const afterLegacy = await graceDeadlineRows(DEFAULT_CACHE);
		const capable = await negotiateUploads(
			token,
			[committed, fresh],
			DEFAULT_CACHE,
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

	it('carries the deadline on a settled frame only for a capable upload', async () => {
		await useTestServer('wire-settled');
		const { token } = await bootstrap();
		await addGracePolicy('', dayGraceSeconds);

		const nar = await verifiableNar('wire-settled');
		const seed = uploadMetadata({
			storePathHash: repeated('a'),
			name: 'seed',
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		await pushPath(token, seed, DEFAULT_CACHE, nar);

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
				DEFAULT_CACHE,
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
		await useTestServer('wire-deferred');
		const { token } = await bootstrap();
		await addGracePolicy('', dayGraceSeconds);

		const nar = await verifiableNar('wire-deferred');
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
			DEFAULT_CACHE,
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
		await currentServer().runVerification();
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
		await useTestServer('wire-retry');
		const { token } = await bootstrap();
		await addGracePolicy('', dayGraceSeconds);

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
				DEFAULT_CACHE,
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

	// Every already-present decision in one negotiation shares one batched
	// grace application: the identity checks and extensions for the whole
	// closure run through a single transaction, not one per path.
	it('answers a multi-path already-present negotiation from one batched application', async () => {
		await useTestServer('wire-skip-batch');
		const { token } = await bootstrap();
		await addGracePolicy('', dayGraceSeconds);

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
			DEFAULT_CACHE,
			shouldReportGrace
		);

		const transactionCount = await runInDurableObject(
			currentServer(),
			(instance) => {
				// Spying on an already-spied method returns the existing spy, so
				// this reads the count the negotiation accumulated above.
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

	// The skippable snapshot is read before awaited shared-fact checks, so a
	// row can move inside the window. A skip from that snapshot would describe
	// a row that no longer holds the path, and a legacy client would take it
	// at face value and never push its bytes. A moved row must be planned like
	// any other path.
	it('plans a path whose row moves during negotiation instead of skipping it', async () => {
		await useTestServer('wire-skip-moved');
		const { token } = await bootstrap();
		await addGracePolicy('', dayGraceSeconds);

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('3'),
			name: 'moved'
		});

		await pushPath(token, path);

		// The blob_ref edge read is the first shared-fact query the negotiate
		// awaits, so a recommit fired on its preparation lands after the
		// snapshot and before the batched grace application.
		const hash = storePathHashSchema.parse(path.storePathHash);
		const response = await runInDurableObject(
			currentServer(),
			(instance, state) => {
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
										eq(schema.narInfos.cache, DEFAULT_CACHE),
										eq(schema.narInfos.storePathHash, hash)
									)
								)
								.run();
						}
					)
				});

				return uploadsServiceFor(context).negotiate(
					DEFAULT_CACHE,
					{
						pushId: testPushId,
						paths: [uploadPathNegotiation(path)]
					},
					'https://cupboard.example',
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

	// A client that reconnects mid-commit re-points the pending row at its new
	// session and parks; the saga that finishes the upload then answers that
	// session with a verdict frame. The frame must carry the same capability-gated
	// stored deadline every other verdict path reports, or a client enforcing
	// grace deadlines would reject a publication whose deadline was written.
	it('sends the stored deadline on a reattached session verdict frame', async () => {
		await useTestServer('wire-reattach-verdict');
		await clearBlobStorage();
		const { token } = await bootstrap();
		await addGracePolicy('', dayGraceSeconds);

		// A committed path whose blob the contested upload reuses, so its
		// commit settles synchronously through the reuse saga.
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

		await pushPath(token, seeded, DEFAULT_CACHE, seed);

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
				DEFAULT_CACHE,
				shouldReportGrace
			)
		);

		if (reuse.action !== 'commit') {
			throw new Error('the contested upload must plan a blob reuse');
		}

		// A parked session whose id the pending row can be re-pointed at: its
		// own deferred fresh upload writes its session id to that row, where
		// the test can read it back.
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
				DEFAULT_CACHE,
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

		// Drive the contested commit directly, re-pointing its row at the parked
		// session on the saga's charge write: that runs after the saga captured
		// its (session-less) committer and before it notifies, the shape of a
		// reconnect attaching mid-commit. The parked session is then a
		// reattached waiter, not the committer.
		const outcome = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
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

				const settled = await pipelineFor(context).commit(
					rootLogger(),
					DEFAULT_CACHE,
					reuse.uploadId
				);

				return { settled, hasAttached };
			}
		);

		if (!outcome.hasAttached) {
			throw new Error('the reattach tap never fired');
		}

		// The parked session may hear its own upload's verdict too; the frame
		// under test is the contested upload's.
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

	// A reconnect that re-sends a `commit-batch` (or `subscribe-identity`) entry
	// for a row verification already cleared has no pending row left to read a
	// captured grace decision from. A `retention`-marked entry tells the server
	// this upload negotiated grace facts, so `resolveGoneCommit` reads the durable
	// deadline the original commit recorded instead of answering with none.
	it('attaches the durable deadline when a retention-marked commit-batch entry resolves a cleared row', async () => {
		await useTestServer('wire-reconnect-grace');
		const { token } = await bootstrap();
		await addGracePolicy('', dayGraceSeconds);

		const metadata = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('g'),
			name: 'reconnect-grace'
		});
		const upload = plannedUploadDecision(
			await negotiateUploads(
				token,
				[metadata],
				DEFAULT_CACHE,
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
		await useTestServer('wire-reconnect-no-grace');
		const { token } = await bootstrap();
		// No grace policy: the capable negotiation captures no graceSeconds,
		// so the commit never writes a retention_grace row.

		const metadata = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('h'),
			name: 'reconnect-no-grace'
		});
		const upload = plannedUploadDecision(
			await negotiateUploads(
				token,
				[metadata],
				DEFAULT_CACHE,
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

	// A gone pending row leaves no durable proof that this session ever
	// negotiated the upload, so its already-present answer only reports the
	// stored fact. Extending retention for a path the session did not push is
	// upload:confirm authority, which a commit socket must not exercise: a
	// commit-scoped token could otherwise refresh any committed path by
	// fabricating an unknown uploadId with the path's public identity.
	it('reports the stored fact without extending when a retention-marked entry resolves a row another push committed', async () => {
		await useTestServer('wire-reconnect-reports');
		const { token } = await bootstrap();

		const metadata = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('j'),
			name: 'reconnect-reports'
		});

		// The path lands before any policy exists, so its commit stores no
		// deadline; the policy added afterwards is what a wrongful extension
		// would draw on.
		await pushPath(token, metadata);
		await addGracePolicy('', dayGraceSeconds);

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
			deadlines: await graceDeadlineRows(DEFAULT_CACHE)
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

	// An unmarked entry gets exactly the legacy shape even for an upload that did
	// negotiate grace facts: the marker, not negotiation alone, gates the durable-fact
	// read, so an old client's re-sent entry never trips a schema it predates.
	it('keeps the legacy shape for a capable reconnect entry with no retention marker', async () => {
		await useTestServer('wire-reconnect-unmarked');
		const { token } = await bootstrap();
		await addGracePolicy('', dayGraceSeconds);

		const metadata = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('i'),
			name: 'reconnect-unmarked'
		});
		const upload = plannedUploadDecision(
			await negotiateUploads(
				token,
				[metadata],
				DEFAULT_CACHE,
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
		await useTestServer('wire-reconnect-identity-grace');
		const { token } = await bootstrap();
		await addGracePolicy('', dayGraceSeconds);

		const metadata = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('j'),
			name: 'reconnect-identity-grace'
		});
		const upload = plannedUploadDecision(
			await negotiateUploads(
				token,
				[metadata],
				DEFAULT_CACHE,
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
	cacheSelector: string = WIRE_DEFAULT_CACHE
): AuthorizationDetails {
	return authorizationDetailsSchema.parse([
		{
			type: 'cupboard_cache',
			actions: ['upload:confirm'],
			cache: cacheSelector
		}
	]);
}

async function confirmPaths(
	token: string,
	storePathHashes: readonly string[]
): Promise<{ readonly status: number; readonly body: UploadConfirmResponse }> {
	const response = await authorisedFetch(
		`/cache/${WIRE_DEFAULT_CACHE}/uploads/confirm`,
		token,
		{
			body: JSON.stringify({ storePathHashes }),
			headers: { 'content-type': 'application/json' },
			method: 'POST'
		}
	);

	return {
		status: response.status,
		body: uploadConfirmResponseSchema.parse(await response.json())
	};
}

class ForcedRollbackError extends Error {}

describe('grace transition atomicity', () => {
	beforeEach(resetTestServer);

	// Proves the mechanism confirmSkipGrace relies on, directly: the marker and
	// the deadline extension both take a writer, and one transaction handle
	// passed to both lands them together.
	it('writes the marker and the deadline together through one transaction handle', async () => {
		await useTestServer('grace-atomic-commit');
		const hash = storePathHashSchema.parse(repeated('k'));

		await runInDurableObject(currentServer(), (instance) => {
			const retention = new RetentionService(instance.context);

			instance.context.db.transaction((tx) => {
				retention.markCacheGraceManaged(DEFAULT_CACHE, tx);
				retention.extendGraceDeadlines(DEFAULT_CACHE, [hash], liveDeadline, tx);
			});
		});

		expect({
			graceManaged: await graceManagedMarker(DEFAULT_CACHE),
			deadlines: await graceDeadlineRows(DEFAULT_CACHE)
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

			expect(() => {
				instance.context.db.transaction((tx) => {
					retention.markCacheGraceManaged(DEFAULT_CACHE, tx);
					retention.extendGraceDeadlines(
						DEFAULT_CACHE,
						[hash],
						liveDeadline,
						tx
					);
					throw new ForcedRollbackError();
				});
			}).toThrow(ForcedRollbackError);
		});

		expect({
			graceManaged: await graceManagedMarker(DEFAULT_CACHE),
			deadlines: await graceDeadlineRows(DEFAULT_CACHE)
		}).toStrictEqual({ graceManaged: false, deadlines: [] });
	});

	// Proves the same claim for a root transition specifically: writeRoot,
	// removeRoot, and the GC expiry sweep all apply the grace transition inside
	// the same transaction as the retention delete that releases the targets,
	// mirroring the shape those methods use (delete the root and its targets,
	// then apply the transition, through one handle).
	it('rolls back a root deletion together with the grace transition it releases', async () => {
		await useTestServer('grace-atomic-root-delete');
		await addGracePolicy('', 3600);

		const cache = DEFAULT_CACHE;
		const name = rootNameSchema.parse('channel');
		const hash = storePathHashSchema.parse(repeated('m'));
		const storePath = storePathSchema.parse(`/nix/store/${repeated('m')}-x`);
		const nowIso = '2026-01-01T00:00:00.000Z';

		await runInDurableObject(currentServer(), (instance) => {
			const retention = new RetentionService(instance.context);

			instance.context.db
				.insert(schema.retentionRoots)
				.values({ cache, name, createdAt: nowIso, updatedAt: nowIso })
				.run();
			instance.context.db
				.insert(schema.retentionRootTargets)
				.values({ cache, rootName: name, storePathHash: hash, storePath })
				.run();

			expect(() => {
				instance.context.db.transaction((tx) => {
					tx.delete(schema.retentionRootTargets)
						.where(
							and(
								eq(schema.retentionRootTargets.cache, cache),
								eq(schema.retentionRootTargets.rootName, name)
							)
						)
						.run();
					tx.delete(schema.retentionRoots)
						.where(
							and(
								eq(schema.retentionRoots.cache, cache),
								eq(schema.retentionRoots.name, name)
							)
						)
						.run();
					retention.applyGraceTransition(cache, [hash], nowIso, tx);
					throw new ForcedRollbackError();
				});
			}).toThrow(ForcedRollbackError);
		});

		const survivors = await runInDurableObject(currentServer(), (instance) => ({
			root: instance.context.db
				.select({ name: schema.retentionRoots.name })
				.from(schema.retentionRoots)
				.where(eq(schema.retentionRoots.cache, cache))
				.all(),
			targets: instance.context.db
				.select({ storePathHash: schema.retentionRootTargets.storePathHash })
				.from(schema.retentionRootTargets)
				.where(eq(schema.retentionRootTargets.cache, cache))
				.all()
		}));

		expect({
			survivors,
			graceManaged: await graceManagedMarker(cache),
			deadlines: await graceDeadlineRows(cache)
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
	const dayGraceSeconds = 86_400;
	const dayAfterStart = '2026-01-02T00:00:00.000Z';

	it('extends a confirmed path to now+grace and reports the deadline', async () => {
		await useTestServer('confirm-extends');
		const { token } = await bootstrap();
		await addGracePolicy('', dayGraceSeconds);

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
		await addGracePolicy('', dayGraceSeconds);

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
			deadlines: await graceDeadlineRows(DEFAULT_CACHE)
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
		await addGracePolicy('', dayGraceSeconds);

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('c'),
			name: 'lost-r2-backing'
		});

		await pushPath(token, path);
		await env.BLOBS.delete(narObjectKey(path.narHash));
		vi.setSystemTime(new Date('2026-01-01T00:05:00.000Z'));

		const confirmed = await confirmPaths(token, [path.storePathHash]);

		expect({
			confirmed,
			deadlines: await graceDeadlineRows(DEFAULT_CACHE)
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
		await addGracePolicy('', dayGraceSeconds);

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('d'),
			name: 'healed-narinfo'
		});

		await pushPath(token, path);
		const key = narInfoObjectKey(fixtureTenant, path.storePathHash);
		await env.BLOBS.delete(key);

		const confirmed = await confirmPaths(token, [path.storePathHash]);
		const restored = await env.BLOBS.head(key);

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
			metadata: { generation: '0', narHash: path.narHash }
		});
	});

	it('is idempotent and cannot shorten an already-extended deadline on retry', async () => {
		await useTestServer('confirm-retry');
		const { token } = await bootstrap();
		await addGracePolicy('', dayGraceSeconds);

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

	it('marks the cache grace-managed with a zero grace and reports the matched policy', async () => {
		await useTestServer('confirm-zero');
		const { token } = await bootstrap();
		await addGracePolicy('', 0);

		const path = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('g'),
			name: 'zero'
		});

		await pushPath(token, path);

		const confirmed = await confirmPaths(token, [path.storePathHash]);

		expect({
			paths: confirmed.body.paths,
			graceManaged: await graceManagedMarker(DEFAULT_CACHE),
			deadlines: await graceDeadlineRows(DEFAULT_CACHE)
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

	it('leaves the cache unmanaged when no policy matches', async () => {
		await useTestServer('confirm-no-policy');
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
			graceManaged: await graceManagedMarker(DEFAULT_CACHE)
		}).toStrictEqual({
			paths: [
				{ storePathHash: path.storePathHash, confirmed: true, grace: {} }
			],
			graceManaged: false
		});
	});

	it('confirms false for an uncommitted or merely reserved path, extending nothing', async () => {
		await useTestServer('confirm-uncommitted');
		const { token } = await bootstrap();
		await addGracePolicy('', dayGraceSeconds);

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
			graceManaged: await graceManagedMarker(DEFAULT_CACHE),
			deadlines: await graceDeadlineRows(DEFAULT_CACHE)
		}).toStrictEqual({
			paths: [
				{ storePathHash: untouched.storePathHash, confirmed: false },
				{ storePathHash: reserved.storePathHash, confirmed: false }
			],
			graceManaged: false,
			deadlines: []
		});
	});

	// The committed and backed checks await shared facts, so the narinfo row
	// can move between its snapshot and the grace application. A moved row
	// must confirm false: confirming true would hand the caller a deadline the
	// path now committed does not hold.
	it('confirms false when the row moves during the shared-fact checks', async () => {
		await useTestServer('confirm-moved-row');
		const { token } = await bootstrap();
		await addGracePolicy('', dayGraceSeconds);

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
				const moveRow = (): void => {
					instance.context.db
						.update(schema.narInfos)
						.set({ generation: sql`${schema.narInfos.generation} + 1` })
						.where(
							and(
								eq(schema.narInfos.cache, DEFAULT_CACHE),
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

				return uploadsServiceFor(context).confirmPaths(DEFAULT_CACHE, [hash]);
			}
		);

		expect({
			paths: response.paths,
			deadlines: await graceDeadlineRows(DEFAULT_CACHE)
		}).toStrictEqual({
			paths: [{ storePathHash: path.storePathHash, confirmed: false }],
			deadlines: [
				{ storePathHash: path.storePathHash, retainUntil: dayAfterStart }
			]
		});
	});

	// A duplicate-heavy confirm answers every requested entry but runs the
	// work once per distinct hash: one identity-check transaction for the
	// whole request, not one per path.
	it('answers duplicate entries from one batched application', async () => {
		await useTestServer('confirm-duplicates');
		const { token } = await bootstrap();
		await addGracePolicy('', dayGraceSeconds);

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
				const response = await uploads.confirmPaths(DEFAULT_CACHE, [
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
			deadlines: await graceDeadlineRows(DEFAULT_CACHE)
		}).toStrictEqual({
			response: { paths: [confirmedEntry, confirmedEntry, confirmedEntry] },
			transactionCount: 1,
			deadlines: [
				{ storePathHash: path.storePathHash, retainUntil: dayAfterStart }
			]
		});
	});

	// The request bound is only safe if a request AT the bound does bounded
	// work: the whole batch runs through chunked identity-check transactions,
	// so the statement count scales with the chunk count, not the path count.
	it('applies a batch at the request bound through chunked transactions', async () => {
		await useTestServer('confirm-at-bound');
		await bootstrap();

		const narHash = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: repeated('a'),
			name: 'template'
		}).narHash;
		// Base-32 store-path hashes built from decimal digits, every one
		// distinct and schema-valid.
		const hashes = Array.from({ length: uploadConfirmMaxPaths }, (_, index) =>
			storePathHashSchema.parse(String(index).padStart(32, '0'))
		);

		const result = await runInDurableObject(currentServer(), (instance) => {
			for (let start = 0; start < hashes.length; start += 10) {
				instance.context.db
					.insert(schema.narInfos)
					.values(
						hashes.slice(start, start + 10).map((storePathHash) => ({
							cache: defaultCache,
							storePathHash,
							storePath: storePathSchema.parse(
								`/nix/store/${storePathHash}-seeded`
							),
							narHash,
							narSize: narBytes.byteLength,
							referencesJson: '[]',
							generation: 1,
							createdAt: '2026-01-01T00:00:00.000Z'
						}))
					)
					.run();
			}

			const transactions = vi.spyOn(instance.context.db, 'transaction');
			const facts = confirmGraceBatch(
				instance.context,
				new RetentionService(instance.context),
				DEFAULT_CACHE,
				hashes.map((storePathHash) => ({
					storePathHash,
					generation: 1,
					narHash
				})),
				86_400
			);
			const transactionCount = transactions.mock.calls.length;

			transactions.mockRestore();

			return { matched: facts.size, transactionCount };
		});

		const deadlines = await graceDeadlineRows(DEFAULT_CACHE);

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
			`/cache/${WIRE_DEFAULT_CACHE}/uploads`,
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
		const commitResponse = await authorisedFetch(
			`/cache/${WIRE_DEFAULT_CACHE}/commit`,
			confirmOnlyToken,
			{ headers: { upgrade: 'websocket' } }
		);
		// upload:commit is runtime authority over upload-specific state only; the
		// implication to upload:confirm (a refresh reaching any already-committed
		// path in the cache) is issuance-only, so a presented commit-only token
		// must not reach confirm.
		const confirmByCommitTokenResponse = await authorisedFetch(
			`/cache/${WIRE_DEFAULT_CACHE}/uploads/confirm`,
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
