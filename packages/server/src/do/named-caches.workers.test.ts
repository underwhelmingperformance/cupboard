import {
	cacheNameSchema,
	selectorForCache,
	storedCacheSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { gcResponseSchema } from '@cupboard/protocol/retention';
import {
	type StatsResponse,
	statsResponseSchema,
	type UsageResponse,
	usageResponseSchema
} from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import { narInfos } from '../db/schema.ts';
import {
	internalOrigin,
	narInfoObjectKey,
	narObjectKey
} from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	adminGrants,
	authorisedFetch,
	blobStateCount,
	bootstrap,
	cacheWriteGrants,
	CommitSocketError,
	commitUpload,
	commitUploadRejection,
	currentServer,
	expectSingleUploadDecision,
	issueServerSignedToken,
	narBytes,
	narHash,
	negotiateUploads,
	pushPath,
	putNarBytes,
	resetTestServer,
	syntheticNarHash,
	syntheticStorePathHash,
	testServerFor,
	uploadMetadata,
	useTestServer
} from '../test-support.ts';

import { chunk } from './bulk.ts';
import { maxNarInfoDeletionsFlushedPerRun } from './deletion-queue-service.ts';
import { maxPathsSweptPerRun } from './garbage-collection-service.ts';
import { gcContinuationKey } from './server.ts';

const buildsCache = cacheNameSchema.parse('builds');

function expectCommitSocketError(
	error: unknown
): asserts error is CommitSocketError {
	expect(error).toBeInstanceOf(CommitSocketError);
}

async function putRoot(
	token: string,
	cache: string,
	name: string,
	storePath: string
): Promise<void> {
	const response = await authorisedFetch(
		`/cache/${selectorForCache(storedCacheSchema.parse(cache))}/roots/${name}`,
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
	cache: string
): Promise<StatsResponse> {
	const response = await authorisedFetch(
		`/cache/${selectorForCache(storedCacheSchema.parse(cache))}/stats`,
		token
	);

	expect(response.status).toBe(StatusCodes.OK);
	return statsResponseSchema.parse(await response.json());
}

async function usageForTenant(token: string): Promise<UsageResponse> {
	const response = await authorisedFetch('/usage', token);

	expect(response.status).toBe(StatusCodes.OK);
	return usageResponseSchema.parse(await response.json());
}

async function seedCollectablePaths(
	cache: string,
	count: number
): Promise<void> {
	const storedCache = storedCacheSchema.parse(cache);
	const createdAt = new Date().toISOString();
	const rows = Array.from({ length: count }, (_unused, index) => {
		const storePathHash = syntheticStorePathHash(index);

		return {
			cache: storedCache,
			storePathHash,
			storePath: storePathSchema.parse(
				`/nix/store/${storePathHash}-overflow-${String(index)}`
			),
			narHash: syntheticNarHash(index),
			narSize: narBytes.byteLength,
			referencesJson: '[]',
			sigsJson: '[]',
			generation: 1,
			createdAt
		};
	});

	await runInDurableObject(currentServer(), (_instance, state) => {
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
		const init = await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		await pushPath(init.token, metadata);
		await pushPath(init.token, metadata, 'builds');

		const narinfoCaches = await runInDurableObject(
			testServerFor('named-cache-share'),
			(_instance, state) =>
				drizzle(state.storage, { schema: { narInfos } })
					.select({ cache: narInfos.cache })
					.from(narInfos)
					.orderBy(narInfos.cache)
					.all()
					.map((row) => row.cache)
		);
		const rows = { narinfoCaches, blobCount: await blobStateCount() };
		const defaultStats = await statsForCache(init.token, '');
		const buildsStats = await statsForCache(init.token, 'builds');
		const usage = await usageForTenant(init.token);
		const defaultObject = await env.BLOBS.head(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash)
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
			narinfoCaches: ['', 'builds'],
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
		const init = await bootstrap();
		const kept = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'a'.repeat(32),
			name: 'kept'
		});
		const swept = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'b'.repeat(32),
			name: 'swept'
		});

		await pushPath(init.token, kept);
		await pushPath(init.token, swept);
		await pushPath(init.token, swept, 'builds');

		// The default cache retains `kept`, so `swept` is collectable there; the
		// builds cache retains `swept`, so the shared NAR stays referenced.
		await putRoot(init.token, '', 'channel', kept.storePath);
		await putRoot(init.token, 'builds', 'channel', swept.storePath);

		const gc = await authorisedFetch('/gc', init.token, { method: 'POST' });
		expect(gc.status).toBe(StatusCodes.OK);

		const sweptDefault = await env.BLOBS.head(
			narInfoObjectKey(fixtureTenant, swept.storePathHash)
		);
		const keptDefault = await env.BLOBS.head(
			narInfoObjectKey(fixtureTenant, kept.storePathHash)
		);
		const sweptBuilds = await env.BLOBS.head(
			narInfoObjectKey(fixtureTenant, swept.storePathHash, buildsCache)
		);
		const sharedNar = await env.BLOBS.head(narObjectKey(narHash));

		expect({
			sweptFromDefault: sweptDefault === null,
			keptInDefault: keptDefault !== null,
			keptInBuilds: sweptBuilds !== null,
			sharedNarSurvives: sharedNar !== null
		}).toStrictEqual({
			sweptFromDefault: true,
			keptInDefault: true,
			keptInBuilds: true,
			sharedNarSurvives: true
		});
	});

	it('resumes an overflowing cache sweep without collecting another cache', async () => {
		await useTestServer('named-cache-gc-continuation');
		const init = await bootstrap();
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

		await pushPath(init.token, keptInA, 'a');
		await pushPath(init.token, keptInB, 'b');
		await pushPath(init.token, collectableInB, 'b');
		await putRoot(init.token, 'a', 'channel', keptInA.storePath);
		await putRoot(init.token, 'b', 'channel', keptInB.storePath);
		await seedCollectablePaths('a', maxPathsSweptPerRun + 1);

		const observed = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
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

				for (let pass = 0; pass < 10; pass += 1) {
					if ((await state.storage.get(gcContinuationKey)) === undefined) {
						break;
					}

					await instance.alarm();
				}
				await state.storage.deleteAlarm();

				const database = drizzle(state.storage, { schema: { narInfos } });
				const cacheRows = database
					.select({ cache: narInfos.cache })
					.from(narInfos)
					.all();
				const bCache = cacheNameSchema.parse('b');
				const isBCollectablePresent =
					database
						.select({ storePathHash: narInfos.storePathHash })
						.from(narInfos)
						.where(
							and(
								eq(narInfos.cache, bCache),
								eq(narInfos.storePathHash, collectableInB.storePathHash)
							)
						)
						.get() !== undefined;

				return {
					firstPass,
					afterContinuation: {
						continuation: await state.storage.get(gcContinuationKey),
						cacheCounts: {
							a: cacheRows.filter((row) => row.cache === 'a').length,
							b: cacheRows.filter((row) => row.cache === 'b').length
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
					pathsSwept: maxPathsSweptPerRun,
					narInfosDeleted: maxNarInfoDeletionsFlushedPerRun,
					orphanStagingDeleted: 0
				},
				continuation: [
					{
						scope: 'cache',
						cache: 'a',
						sweepLimit: maxPathsSweptPerRun
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
		await bootstrap();
		const admin = await issueServerSignedToken(adminGrants(), 'owner');
		// Activation gates on servability, so the target must be committed first.
		await pushPath(
			admin,
			uploadMetadata({
				fileSize: narBytes.byteLength,
				storePathHash: 'a'.repeat(32),
				name: 'x'
			}),
			'builds'
		);
		const writeToken = await issueServerSignedToken(
			cacheWriteGrants(['channel'], 'builds'),
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

	it('authenticates before judging an invalid cache name', async () => {
		await useTestServer('named-cache-invalid');

		// The contract authenticates ahead of input validation, so a request
		// without a valid token learns nothing about the path's validity.
		const unauthenticated = await authorisedFetch(
			'/cache/Bad_NAME!/stats',
			'any-token'
		);
		const malformed = await authorisedFetch(
			'/cache/Bad_NAME!/stats',
			await issueServerSignedToken(adminGrants())
		);

		expect({
			unauthenticated: unauthenticated.status,
			malformed: malformed.status
		}).toStrictEqual({
			unauthenticated: StatusCodes.UNAUTHORIZED,
			malformed: StatusCodes.BAD_REQUEST
		});
	});

	it('refuses to commit an upload under a different cache than negotiated', async () => {
		const init = await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const decision = expectSingleUploadDecision(
			await negotiateUploads(init.token, [metadata], 'builds'),
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
			'builds'
		);
		const defaultStats = await statsForCache(init.token, '');
		const buildsStats = await statsForCache(init.token, 'builds');

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
