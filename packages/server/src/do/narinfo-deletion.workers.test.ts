import {
	DEFAULT_CACHE,
	nixSha256HashSchema,
	type NixSha256HashString,
	type StorePathHash,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { narInfoDeletions } from '../db/schema.ts';
import { SubrequestTimeoutError } from '../errors.ts';
import { narInfoObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	authorisedFetch,
	currentServer,
	initialise,
	narInfoDeletionRows,
	resetTestServer,
	syntheticNarHash,
	syntheticStorePathHash,
	testBase,
	testServerFor,
	useTestServer
} from '../test-support.ts';

import { AttestationCasService } from './attestation-cas-service.ts';
import { AttestationsService } from './attestations-service.ts';
import { chunk } from './bulk.ts';
import { type ServerContext } from './context.ts';
import {
	DeletionQueueService,
	maxFencedRetireRows,
	type TornDownNarInfo
} from './deletion-queue-service.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';

const selectDeletions = 'SELECT cache, store_path_hash FROM narinfo_deletion';

// A distinct queued teardown deletion per index, in ascending store-path-hash
// order.
function syntheticEntries(count: number): TornDownNarInfo[] {
	return Array.from({ length: count }, (_unused, index) => ({
		storePathHash: syntheticStorePathHash(index),
		generation: 1,
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
	const createdAt = testBase.toISOString();

	await runInDurableObject(currentServer(), (_instance, state) => {
		const database = drizzle(state.storage, { schema: { narInfoDeletions } });

		// Each row binds five parameters, so the insert is chunked under the
		// driver's bound-parameter limit.
		for (const batch of chunk(entries, 18)) {
			database
				.insert(narInfoDeletions)
				.values(
					batch.map((entry) => ({
						cache: DEFAULT_CACHE,
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
	cache: string;
	storePathHash: StorePathHash;
	narHash: NixSha256HashString;
	generation: number;
}[] {
	return entries
		.map((entry) => ({
			cache: DEFAULT_CACHE,
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
		const createdAt = '2026-01-01T00:00:00.000Z';

		await runInDurableObject(
			testServerFor('narinfo-deletion-caches'),
			(_instance, state) => {
				drizzle(state.storage, { schema: { narInfoDeletions } })
					.insert(narInfoDeletions)
					.values([
						{ cache: '', storePathHash: hash, narHash, createdAt },
						{ cache: 'builds', storePathHash: hash, narHash, createdAt }
					])
					.run();
			}
		);

		await env.BLOBS.put(
			narInfoObjectKey(fixtureTenant, hash),
			'default narinfo'
		);
		await env.BLOBS.put(
			narInfoObjectKey(fixtureTenant, hash, 'builds'),
			'builds narinfo'
		);

		const response = await authorisedFetch('/gc', token, { method: 'POST' });
		expect(response.status).toBe(StatusCodes.OK);

		const remaining = await runInDurableObject(
			testServerFor('narinfo-deletion-caches'),
			(_instance, state) => state.storage.sql.exec(selectDeletions).toArray()
		);

		const defaultObject = await env.BLOBS.head(
			narInfoObjectKey(fixtureTenant, hash)
		);
		const namedObject = await env.BLOBS.head(
			narInfoObjectKey(fixtureTenant, hash, 'builds')
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
				const retired = await instance.context.criticalSection(() =>
					queue.flushQueuedNarInfoDeletions(undefined, flushLimit)
				);

				return { retired, hasMore: queue.hasQueuedNarInfoDeletions() };
			}
		);
		const remainingAfterFirst = await narInfoDeletionRows();

		const secondPass = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const queue = buildDeletionQueue(instance.context);
				const retired = await instance.context.criticalSection(() =>
					queue.flushQueuedNarInfoDeletions(undefined, flushLimit)
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
					await instance.context.criticalSection(() =>
						queue.retireTornDownNarInfos(DEFAULT_CACHE, entries)
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
});
