import {
	type CacheScope,
	narInfoGenerationSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { gcResponseSchema } from '@cupboard/protocol/retention';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import {
	type StatsResponseInput,
	statsResponseSchema,
	type UsageResponseInput,
	usageResponseSchema
} from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import { narInfos } from '../db/schema.ts';
import { internalOrigin, narInfoObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	adminGrants,
	authorisedFetch,
	blobStateCount,
	bootstrap,
	cacheScopedPath,
	cacheWriteGrants,
	CommitSocketError,
	commitUpload,
	commitUploadRejection,
	currentNarObjectKey,
	currentServer,
	defaultCache,
	driveToCompletion,
	expectSingleUploadDecision,
	issueServerSignedToken,
	namedCache,
	narBytes,
	narHash,
	negotiateUploads,
	pushPath,
	putNarBytes,
	resetTestServer,
	resolvedCache,
	syntheticNarHash,
	syntheticStorePathHash,
	testServerFor,
	uploadMetadata,
	useTestServer
} from '../test-support.ts';

import { chunk } from './bulk.ts';
import { maxNarInfoDeletionsFlushedPerRun } from './deletion-queue-service.ts';
import { maxPathsCollectedPerRun } from './garbage-collection-service.ts';
import { gcContinuationKey } from './server.ts';

const buildsCache = namedCache('builds');

function expectCommitSocketError(
	error: unknown
): asserts error is CommitSocketError {
	expect(error).toBeInstanceOf(CommitSocketError);
}

async function putRoot(
	token: string,
	cache: CacheScope,
	name: string,
	storePath: string
): Promise<void> {
	const response = await authorisedFetch(
		cacheScopedPath(cache, `/roots/${name}`),
		token,
		{
			body: JSON.stringify({ targets: [storePath] }),
			headers: { 'content-type': 'application/json' },
			method: 'PUT'
		}
	);

	expect(response.status).toBe(StatusCodes.OK);
}

async function statsForCache(
	token: string,
	cache: CacheScope
): Promise<StatsResponseInput> {
	const response = await authorisedFetch(
		cacheScopedPath(cache, '/stats'),
		token
	);

	expect(response.status).toBe(StatusCodes.OK);
	return statsResponseSchema.parse(await response.json());
}

async function usageForTenant(token: string): Promise<UsageResponseInput> {
	const response = await authorisedFetch('/usage', token);

	expect(response.status).toBe(StatusCodes.OK);
	return usageResponseSchema.parse(await response.json());
}

async function seedCollectablePaths(
	cache: CacheScope,
	count: number
): Promise<void> {
	const createdAt = isoTimestamp(new Date());

	await runInDurableObject(currentServer(), (instance, state) => {
		const resolved = resolvedCache(instance.context, cache);
		const rows = Array.from({ length: count }, (_unused, index) => {
			const storePathHash = syntheticStorePathHash(index);

			return {
				cacheId: resolved.id,
				storePathHash,
				storePath: storePathSchema.parse(
					`/nix/store/${storePathHash}-overflow-${String(index)}`
				),
				narHash: syntheticNarHash(index),
				narSize: narBytes.byteLength,
				referencesJson: '[]',
				sigsJson: '[]',
				generation: narInfoGenerationSchema.parse(1),
				createdAt
			};
		});
		const database = drizzle(state.storage, { schema: { narInfos } });

		for (const batch of chunk(rows, 8)) {
			database.insert(narInfos).values(batch).run();
		}
	});
}

describe('named caches', () => {
	beforeEach(resetTestServer);

	it('materialises one path in two caches with a single shared blob', async () => {
		await useTestServer('named-cache-share');
		const init = await bootstrap({ caches: [{ scope: buildsCache }] });
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		await pushPath(init.token, metadata);
		await pushPath(init.token, metadata, buildsCache);

		const narinfoCaches = await runInDurableObject(
			testServerFor('named-cache-share'),
			(instance, state) =>
				drizzle(state.storage, { schema: { narInfos } })
					.select({ cacheId: narInfos.cacheId })
					.from(narInfos)
					.all()
					.map((row) =>
						instance.context.cacheRepository.scopeForId(row.cacheId)
					)
		);
		const rows = { narinfoCaches, blobCount: await blobStateCount() };
		const defaultStats = await statsForCache(init.token, defaultCache());
		const buildsStats = await statsForCache(init.token, buildsCache);
		const usage = await usageForTenant(init.token);
		const defaultObject = await env.BLOBS.head(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash, {
				kind: 'default'
			})
		);
		const buildsObject = await env.BLOBS.head(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash, buildsCache)
		);

		expect({
			narinfoCaches: rows.narinfoCaches,
			blobCount: rows.blobCount,
			defaultStats,
			buildsStats,
			usage,
			defaultObjectExists: defaultObject !== null,
			buildsObjectExists: buildsObject !== null
		}).toStrictEqual({
			narinfoCaches: [defaultCache(), buildsCache],
			blobCount: 1,
			defaultStats: {
				storePaths: 1,
				narBlobs: 1,
				narFileSize: narBytes.byteLength,
				casObjects: 0,
				casFileSize: 0,
				pendingUploads: 0,
				totalFileSize: narBytes.byteLength
			},
			buildsStats: {
				storePaths: 1,
				narBlobs: 1,
				narFileSize: narBytes.byteLength,
				casObjects: 0,
				casFileSize: 0,
				pendingUploads: 0,
				totalFileSize: narBytes.byteLength
			},
			usage: {
				narBlobs: 1,
				narFileSize: narBytes.byteLength,
				casObjects: 0,
				casFileSize: 0,
				totalFileSize: narBytes.byteLength
			},
			defaultObjectExists: true,
			buildsObjectExists: true
		});
	});

	it('collects each cache independently while a shared NAR survives', async () => {
		await useTestServer('named-cache-gc');
		const init = await bootstrap({ caches: [{ scope: buildsCache }] });
		const kept = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'a'.repeat(32),
			name: 'kept'
		});
		const collected = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'b'.repeat(32),
			name: 'collected'
		});

		await pushPath(init.token, kept);
		await pushPath(init.token, collected);
		await pushPath(init.token, collected, buildsCache);

		// The default cache retains only `kept`, so the other path is unreachable
		// there; the builds cache retains it, so the shared NAR stays referenced.
		await putRoot(init.token, defaultCache(), 'channel', kept.storePath);
		await putRoot(init.token, buildsCache, 'channel', collected.storePath);

		const gc = await authorisedFetch('/gc', init.token, { method: 'POST' });
		expect(gc.status).toBe(StatusCodes.OK);

		const collectedDefault = await env.BLOBS.head(
			narInfoObjectKey(fixtureTenant, collected.storePathHash, {
				kind: 'default'
			})
		);
		const keptDefault = await env.BLOBS.head(
			narInfoObjectKey(fixtureTenant, kept.storePathHash, { kind: 'default' })
		);
		const collectedBuilds = await env.BLOBS.head(
			narInfoObjectKey(fixtureTenant, collected.storePathHash, buildsCache)
		);
		const sharedNar = await env.BLOBS.head(await currentNarObjectKey(narHash));

		expect({
			collectedFromDefault: collectedDefault === null,
			keptInDefault: keptDefault !== null,
			keptInBuilds: collectedBuilds !== null,
			sharedNarSurvives: sharedNar !== null
		}).toStrictEqual({
			collectedFromDefault: true,
			keptInDefault: true,
			keptInBuilds: true,
			sharedNarSurvives: true
		});
	});

	it('resumes an overflowing cache run without collecting another cache', async () => {
		await useTestServer('named-cache-gc-continuation');
		const aCache = namedCache('a');
		const bCache = namedCache('b');
		const init = await bootstrap({
			caches: [{ scope: aCache }, { scope: bCache }]
		});
		const keptInA = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'a'.repeat(32),
			name: 'kept-a'
		});
		const keptInB = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'b'.repeat(32),
			name: 'kept-b'
		});
		const collectableInB = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'c'.repeat(32),
			name: 'collectable-b'
		});

		await pushPath(init.token, keptInA, aCache);
		await pushPath(init.token, keptInB, bCache);
		await pushPath(init.token, collectableInB, bCache);
		await putRoot(init.token, aCache, 'channel', keptInA.storePath);
		await putRoot(init.token, bCache, 'channel', keptInB.storePath);
		await seedCollectablePaths(aCache, maxPathsCollectedPerRun + 1);

		const observed = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const resolvedA = resolvedCache(instance.context, aCache);
				const resolvedB = resolvedCache(instance.context, bCache);
				const response = await instance.fetch(
					new Request(new URL('/cache/a/gc', internalOrigin), {
						method: 'POST',
						headers: { authorization: `Bearer ${init.token}` }
					})
				);
				const firstPass = {
					status: response.status,
					body: gcResponseSchema.parse(await response.json()),
					continuation: await state.storage.get(gcContinuationKey)
				};

				await driveToCompletion(
					() => instance.alarm(),
					async () =>
						(await state.storage.get(gcContinuationKey)) === undefined,
					30
				);
				await state.storage.deleteAlarm();

				const database = drizzle(state.storage, { schema: { narInfos } });
				const cacheRows = database
					.select({ cacheId: narInfos.cacheId })
					.from(narInfos)
					.all();
				const isBCollectablePresent =
					database
						.select({ storePathHash: narInfos.storePathHash })
						.from(narInfos)
						.where(
							and(
								eq(narInfos.cacheId, resolvedB.id),
								eq(narInfos.storePathHash, collectableInB.storePathHash)
							)
						)
						.get() !== undefined;

				return {
					firstPass,
					afterContinuation: {
						continuation: await state.storage.get(gcContinuationKey),
						cacheCounts: {
							a: cacheRows.filter((row) => row.cacheId === resolvedA.id).length,
							b: cacheRows.filter((row) => row.cacheId === resolvedB.id).length
						},
						isBCollectablePresent
					}
				};
			}
		);

		expect(observed).toStrictEqual({
			firstPass: {
				status: StatusCodes.OK,
				body: {
					ok: true,
					pendingUploadsDeleted: 0,
					pendingAttestationsDeleted: 0,
					rootsExpired: 0,
					pathsCollected: maxPathsCollectedPerRun,
					narInfosDeleted: maxNarInfoDeletionsFlushedPerRun,
					orphanStagingDeleted: 0
				},
				continuation: [
					{
						scope: 'cache',
						cache: aCache,
						collectLimit: maxPathsCollectedPerRun
					}
				]
			},
			afterContinuation: {
				continuation: undefined,
				cacheCounts: {
					a: 1,
					b: 2
				},
				isBCollectablePresent: true
			}
		});
	}, 30_000);

	it('mirrors the per-route scope under a cache prefix', async () => {
		await useTestServer('named-cache-scope');
		await bootstrap({ caches: [{ scope: buildsCache }] });
		const admin = await issueServerSignedToken(adminGrants(), 'owner');
		// Activation gates on servability, so the target must be committed first.
		await pushPath(
			admin,
			uploadMetadata({
				fileSize: narBytes.byteLength,
				storePathHash: 'a'.repeat(32),
				name: 'x'
			}),
			buildsCache
		);
		const writeToken = await issueServerSignedToken(
			cacheWriteGrants(['channel'], buildsCache),
			'ci'
		);

		const rootPut = await authorisedFetch(
			'/cache/builds/roots/channel',
			writeToken,
			{
				body: JSON.stringify({ targets: [`/nix/store/${'a'.repeat(32)}-x`] }),
				headers: { 'content-type': 'application/json' },
				method: 'PUT'
			}
		);
		const rootList = await authorisedFetch('/cache/builds/roots', writeToken);
		const statsResponse = await authorisedFetch(
			'/cache/builds/stats',
			writeToken
		);
		const gc = await authorisedFetch('/cache/builds/gc', writeToken, {
			method: 'POST'
		});

		expect({
			write: rootPut.status,
			list: rootList.status,
			stats: statsResponse.status,
			gc: gc.status
		}).toStrictEqual({
			write: StatusCodes.OK,
			list: StatusCodes.FORBIDDEN,
			stats: StatusCodes.FORBIDDEN,
			gc: StatusCodes.FORBIDDEN
		});
	});

	// Routing resolves the cache before any route runs, so a path segment that is
	// not a cache name is refused whatever the caller presents. The refusal
	// reveals only the published cache-name grammar, never whether a cache
	// exists, and it matches what the Worker already answers for a read.
	it.each([
		{ name: 'no valid token', token: () => Promise.resolve('any-token') },
		{
			name: 'an admin token',
			token: () => issueServerSignedToken(adminGrants())
		}
	])('refuses an invalid cache name with $name', async ({ token }) => {
		await useTestServer('named-cache-invalid');

		const response = await authorisedFetch(
			'/cache/Bad_NAME!/stats',
			await token()
		);

		expect(response.status).toBe(StatusCodes.BAD_REQUEST);
	});

	it('refuses to commit an upload under a different cache than negotiated', async () => {
		const init = await bootstrap({ caches: [{ scope: buildsCache }] });
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const decision = expectSingleUploadDecision(
			await negotiateUploads(init.token, [metadata], buildsCache),
			metadata
		);

		// Commit through the default cache: the pending row is bound to `builds`.
		const crossCommitError = await commitUploadRejection(
			init.token,
			decision.uploadId
		);

		// The same upload still completes through the cache it was negotiated under.
		await putNarBytes(decision.r2Key);
		const committed = await commitUpload(
			init.token,
			decision.uploadId,
			buildsCache
		);
		const defaultStats = await statsForCache(init.token, defaultCache());
		const buildsStats = await statsForCache(init.token, buildsCache);

		expectCommitSocketError(crossCommitError);
		expect({
			crossCommit: {
				name: crossCommitError.name,
				status: crossCommitError.status
			},
			committed: committed.status,
			defaultPaths: defaultStats.storePaths,
			buildsPaths: buildsStats.storePaths
		}).toStrictEqual({
			crossCommit: {
				name: 'CommitSocketError',
				status: StatusCodes.BAD_REQUEST
			},
			committed: 'committed',
			defaultPaths: 0,
			buildsPaths: 1
		});
	});
});
