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

import { legacyCacheKey } from '../db/cache.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { narInfoDeletions } from '../db/schema.ts';
import { SubrequestTimeoutError } from '../errors.ts';
import { internalOrigin, narInfoObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	asOneInvocation,
	authorisedFetch,
	commitPath,
	currentServer,
	defaultCache,
	flakyD1,
	initialise,
	namedCache,
	narInfoDeletionRows,
	resetTestServer,
	resolvedCache,
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
import { ServerContext } from './context.ts';
import {
	DeletionQueueService,
	maxFencedRetireRows,
	type TornDownNarInfo
} from './deletion-queue-service.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';

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

function buildDeletionQueue(context: ServerContext): DeletionQueueService {
	const narInfoObjects = new NarInfoObjectsService(context);
	const attestationCas = new AttestationCasService(context);
	const attestations = new AttestationsService(
		context,
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

		// Each row binds six parameters. Keep the insert below the driver's
		// bound-parameter limit.
		for (const batch of chunk(entries, 16)) {
			database
				.insert(narInfoDeletions)
				.values(
					batch.map((entry) => ({
						cache: legacyCacheKey(cache.scope, cache.access),
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
							cache: legacyCacheKey(
								defaultResolved.scope,
								defaultResolved.access
							),
							cacheId: defaultResolved.id,
							storePathHash: hash,
							narHash,
							createdAt
						},
						{
							cache: legacyCacheKey(
								buildsResolved.scope,
								buildsResolved.access
							),
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

	// The reference edge is what authorises a read of the path, and the read
	// takes the published object at face value, so an object must never outlive
	// its edge. Failing the edge retirement leaves the two in the other order:
	// the object gone while D1 still names the path, which a read answers with
	// 404 either way.
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
