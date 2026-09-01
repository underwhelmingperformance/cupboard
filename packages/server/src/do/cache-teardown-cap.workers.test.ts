import {
	type CacheScope,
	nixSha256HashSchema,
	type StorePathHash
} from '@cupboard/nix-store/scalars';
import { cacheRemoveResponseSchema } from '@cupboard/protocol/caches';
import { type UploadPathMetadata } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import { cacheIdentityCondition } from '../db/cache.ts';
import * as schema from '../db/schema.ts';
import {
	attestationListObjectKey,
	narInfoObjectKey,
	requestOriginSchema
} from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	authorisedFetch,
	blobReferenceRows,
	bootstrap,
	currentNarObjectKey,
	currentServer,
	defaultCache,
	driveToCompletion,
	namedCache,
	narBytes,
	narInfoDeletionRows,
	narInfoGeneration,
	pushPath,
	queueUnflushedNarInfoDeletion,
	readFetch,
	resetTestServer,
	tenantBlobRows,
	tenantUsageRow,
	uploadMetadata,
	useTestServer,
	verifiableNar
} from '../test-support.ts';

import { teardownEntryPrefix } from './cache-admin-service.ts';
import { maxTeardownPresenceChunk } from './deletion-queue-service.ts';

const buildsCache = namedCache('builds');
const otherCache = namedCache('other');
const origin = requestOriginSchema.parse('https://cache.example');
const repeated = (character: string): string => character.repeat(32);

function buildMetadata(character: string): UploadPathMetadata {
	return uploadMetadata({
		fileSize: narBytes.byteLength,
		storePathHash: repeated(character),
		name: `path-${character}`
	});
}

async function teardownPending(cache: CacheScope): Promise<unknown> {
	return runInDurableObject(currentServer(), (instance, state) => {
		const row = instance.context.db
			.select({ id: schema.caches.id })
			.from(schema.caches)
			.where(
				cacheIdentityCondition(schema.caches.kind, schema.caches.name, cache)
			)
			.get();

		if (row === undefined) {
			return;
		}

		return state.storage.get(`${teardownEntryPrefix}${String(row.id)}`);
	});
}

async function isNarInfoObjectPresent(
	storePathHash: StorePathHash,
	cache: CacheScope = defaultCache()
): Promise<boolean> {
	const object = await env.BLOBS.head(
		narInfoObjectKey(fixtureTenant, storePathHash, cache)
	);

	return object !== null;
}

async function rowsRemaining(
	paths: readonly UploadPathMetadata[]
): Promise<number> {
	const generations = await Promise.all(
		paths.map((path) => narInfoGeneration(path.storePathHash))
	);

	return generations.filter((generation) => generation !== undefined).length;
}

describe('cache teardown', () => {
	beforeEach(resetTestServer);

	it('removes narinfo rows before cache deletion returns and drains narinfo objects later', async () => {
		await useTestServer('teardown-drain');
		const { token } = await bootstrap({
			caches: [{ scope: buildsCache }, { scope: otherCache }]
		});
		const first = buildMetadata('a');
		const paths = [first, buildMetadata('b'), buildMetadata('c')];

		for (const metadata of paths) {
			await pushPath(token, metadata, buildsCache);
		}

		// Observe the object and marker immediately after runCacheTeardown
		// returns, within the same Durable Object invocation. Workerd can deliver
		// the due alarm once the invocation ends, and its teardown pass would
		// remove both before a later observation. Use the instance's R2 binding
		// because workerd refuses I/O through a binding from another worker
		// instance.
		const onReturn = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const cache = instance.context.cacheRepository.require(buildsCache);
				await instance.runCacheTeardown(buildsCache, origin);

				const object = await instance.context.env.BLOBS.head(
					narInfoObjectKey(fixtureTenant, first.storePathHash, buildsCache)
				);

				return {
					object: object !== null,
					pending: await state.storage.get(
						`${teardownEntryPrefix}${String(cache.id)}`
					)
				};
			}
		);
		// The teardown drain never restores a narinfo row, so alarm delivery
		// cannot change this count.
		const rowsOnReturn = await rowsRemaining(paths);

		await driveToCompletion(
			() => currentServer().resumeCacheTeardown(),
			async () => (await teardownPending(buildsCache)) === undefined,
			paths.length + 1
		);

		expect({
			onReturn,
			rowsOnReturn,
			object: await isNarInfoObjectPresent(first.storePathHash, buildsCache),
			pending: await teardownPending(buildsCache)
		}).toStrictEqual({
			onReturn: { object: true, pending: origin },
			rowsOnReturn: 0,
			object: false,
			pending: undefined
		});
	});

	it('arms the marker and drains an over-cap teardown across resumes', async () => {
		await useTestServer('teardown-resume');
		const { token } = await bootstrap({
			caches: [{ scope: buildsCache }, { scope: otherCache }]
		});
		const paths = [buildMetadata('a'), buildMetadata('b'), buildMetadata('c')];

		for (const metadata of paths) {
			await pushPath(token, metadata, buildsCache);
		}

		await currentServer().runCacheTeardown(buildsCache, origin);

		expect(await rowsRemaining(paths)).toBe(0);

		await driveToCompletion(
			() => currentServer().resumeCacheTeardown(1),
			async () => (await teardownPending(buildsCache)) === undefined,
			paths.length + 1
		);

		const present = await Promise.all(
			paths.map((path) =>
				isNarInfoObjectPresent(path.storePathHash, buildsCache)
			)
		);

		expect({
			objectsLeft: present.filter(Boolean).length,
			pending: await teardownPending(buildsCache)
		}).toStrictEqual({ objectsLeft: 0, pending: undefined });
	});

	it('refuses reads as soon as an over-cap teardown returns, then drains the edges', async () => {
		await useTestServer('teardown-edges');
		const { token } = await bootstrap({
			caches: [{ scope: buildsCache }, { scope: otherCache }]
		});
		const first = buildMetadata('a');
		const paths = [first, buildMetadata('b'), buildMetadata('c')];

		for (const metadata of paths) {
			await pushPath(token, metadata, buildsCache);
		}

		// The three paths share one NAR, so one read covers the cache.
		const narPath = `/cache/builds/${await currentNarObjectKey(
			nixSha256HashSchema.parse(first.narHash)
		)}`;
		const beforeTeardown = await readFetch(narPath);

		// Count the surviving edges in the same Durable Object invocation as the
		// deletion. Once the invocation ends, workerd can deliver the due alarm.
		// Its teardown pass could retire the edges before a later count. The
		// subsequent read returns 404 because the deletion revoked the generation.
		const undrainedEdges = await runInDurableObject(
			currentServer(),
			async (instance) => {
				await instance.runCacheTeardown(buildsCache, origin);

				return blobReferenceRows();
			}
		);
		const afterTeardown = await readFetch(narPath);

		await driveToCompletion(
			() => currentServer().resumeCacheTeardown(1),
			async () => (await teardownPending(buildsCache)) === undefined,
			paths.length + 1
		);

		expect({
			beforeTeardown: beforeTeardown.status,
			afterTeardown: afterTeardown.status,
			undrained: undrainedEdges.length,
			edges: await blobReferenceRows()
		}).toStrictEqual({
			beforeTeardown: StatusCodes.OK,
			afterTeardown: StatusCodes.NOT_FOUND,
			undrained: paths.length,
			edges: []
		});
	});

	it('retires a chunk-spanning teardown with correct accounting', async () => {
		await useTestServer('teardown-batch');
		const { token } = await bootstrap({
			caches: [{ scope: buildsCache }, { scope: otherCache }]
		});

		// One more path than the widest presence batch makes the delete cross the
		// parameter boundary without making the fixture perform unnecessary uploads.
		// Each path must carry a distinct narHash so the IN list does not collapse
		// to a single value; verifiableNar produces self-consistent compressed bytes
		// whose decompressed content actually hashes to the declared narHash.
		const pathCount = maxTeardownPresenceChunk + 1;
		const alphabet = '0123456789abcdfghijklmnpqrsvwxyz';
		const nars = await Promise.all(
			Array.from({ length: pathCount }, (_, index) =>
				verifiableNar(String(index))
			)
		);
		const paths = nars.map((nar, index) => {
			const suffix =
				alphabet.charAt(Math.floor(index / 32)) + alphabet.charAt(index % 32);

			return uploadMetadata({
				fileSize: nar.narBytes.byteLength,
				storePathHash: `${'0'.repeat(30)}${suffix}`,
				name: `path-${suffix}`,
				narHash: nar.narHash,
				fileHash: nar.fileHash,
				narSize: nar.narSize
			});
		});

		const pathsWithNars = paths.map((p, index) => [p, nars[index]] as const);

		const pushConcurrency = 8;
		for (
			let start = 0;
			start < pathsWithNars.length;
			start += pushConcurrency
		) {
			await Promise.all(
				pathsWithNars
					.slice(start, start + pushConcurrency)
					.map(([metadata, nar]) => pushPath(token, metadata, buildsCache, nar))
			);
		}

		const response = await authorisedFetch('/caches/builds?force=true', token, {
			method: 'DELETE'
		});
		const removed = cacheRemoveResponseSchema.parse(await response.json());

		await driveToCompletion(
			() => currentServer().resumeCacheTeardown(),
			async () => (await teardownPending(buildsCache)) === undefined,
			4
		);

		const usage = await tenantUsageRow();

		expect({
			status: response.status,
			removed,
			rows: await rowsRemaining(paths),
			queued: await narInfoDeletionRows(),
			edges: await blobReferenceRows(),
			presence: await tenantBlobRows(),
			usage: {
				bytes: usage?.bytes,
				narinfos: usage?.narinfos,
				blobs: usage?.blobs
			}
		}).toStrictEqual({
			status: StatusCodes.OK,
			removed: {
				scope: buildsCache,
				removed: true,
				storePathsRemoved: pathCount
			},
			rows: 0,
			queued: [],
			edges: [],
			presence: [],
			usage: { bytes: 0, narinfos: 0, blobs: 0 }
		});
	}, 120_000);

	it('clears only the generations a chunk actually retired', async () => {
		await useTestServer('teardown-generations');
		const { token } = await bootstrap({
			caches: [{ scope: buildsCache }, { scope: otherCache }]
		});
		const path = buildMetadata('a');

		// A delete whose queued cleanup never flushed, then a recommit: the queue
		// holds two generations of the one path. A cap of one splits them across
		// drain chunks, so the first chunk's clear must remove only the generation
		// it retired; wiping the path's other row would drop the second
		// generation's edge retirement and credits on the floor.
		await pushPath(token, path, buildsCache);
		await queueUnflushedNarInfoDeletion({
			storePathHash: path.storePathHash,
			cache: buildsCache
		});
		await pushPath(token, path, buildsCache);

		await currentServer().runCacheTeardown(buildsCache, origin);

		await driveToCompletion(
			() => currentServer().resumeCacheTeardown(1),
			async () => (await teardownPending(buildsCache)) === undefined,
			3
		);

		const usage = await tenantUsageRow();

		expect({
			queued: await narInfoDeletionRows(),
			edges: await blobReferenceRows(),
			presence: await tenantBlobRows(),
			pending: await teardownPending(buildsCache),
			object: await isNarInfoObjectPresent(path.storePathHash, buildsCache),
			usage: {
				bytes: usage?.bytes,
				narinfos: usage?.narinfos,
				blobs: usage?.blobs
			}
		}).toStrictEqual({
			queued: [],
			edges: [],
			presence: [],
			pending: undefined,
			object: false,
			usage: { bytes: 0, narinfos: 0, blobs: 0 }
		});
	});

	it('spares presence a sibling cache still references', async () => {
		await useTestServer('teardown-shared');
		const { token } = await bootstrap({
			caches: [{ scope: buildsCache }, { scope: otherCache }]
		});
		const torn = buildMetadata('a');
		const kept = buildMetadata('b');

		await pushPath(token, torn, buildsCache);
		await pushPath(token, kept, otherCache);

		const response = await authorisedFetch('/caches/builds?force=true', token, {
			method: 'DELETE'
		});
		const removed = cacheRemoveResponseSchema.parse(await response.json());

		await driveToCompletion(
			() => currentServer().resumeCacheTeardown(),
			async () => (await teardownPending(buildsCache)) === undefined,
			3
		);

		const usage = await tenantUsageRow();
		const presence = await tenantBlobRows();
		const edges = await blobReferenceRows();

		expect({
			status: response.status,
			removed,
			presence: presence.map((row) => row.fileSize),
			edges: edges.map((row) => ({
				cache: row.cache,
				storePathHash: row.storePathHash
			})),
			usage: {
				bytes: usage?.bytes,
				narinfos: usage?.narinfos,
				blobs: usage?.blobs
			}
		}).toStrictEqual({
			status: StatusCodes.OK,
			removed: { scope: buildsCache, removed: true, storePathsRemoved: 1 },
			presence: [narBytes.byteLength],
			edges: [{ cache: otherCache, storePathHash: kept.storePathHash }],
			usage: { bytes: narBytes.byteLength, narinfos: 1, blobs: 1 }
		});
	});

	it('removes a stale attestation list object on a replayed retirement', async () => {
		await useTestServer('teardown-attestation-list');
		const { token } = await bootstrap({
			caches: [{ scope: buildsCache }, { scope: otherCache }]
		});
		const path = buildMetadata('a');

		await pushPath(token, path, buildsCache);

		// The residue of a teardown chunk that crashed after removing the path's
		// attestation references but before re-rendering its list object. The
		// replayed retirement finds no reference rows, and must still remove the
		// object and stop it advertising deleted bundles.
		const listKey = attestationListObjectKey(
			fixtureTenant,
			path.storePathHash,
			buildsCache
		);

		await env.BLOBS.put(listKey, JSON.stringify({ attestations: [] }));

		const response = await authorisedFetch('/caches/builds?force=true', token, {
			method: 'DELETE'
		});

		await driveToCompletion(
			() => currentServer().resumeCacheTeardown(),
			async () => (await teardownPending(buildsCache)) === undefined,
			3
		);

		expect({
			status: response.status,
			listObject: (await env.BLOBS.head(listKey)) !== null
		}).toStrictEqual({
			status: StatusCodes.OK,
			listObject: false
		});
	});

	it('keeps a path recommitted above a queued retirement generation', async () => {
		await useTestServer('teardown-fence');
		const { token } = await bootstrap({
			caches: [{ scope: buildsCache }, { scope: otherCache }]
		});
		const path = buildMetadata('a');

		await pushPath(token, path);

		// Model the state a teardown leaves for one path: its row is gone and its
		// retirement is queued at the committed generation. The recommit then lands a
		// fresh row at a higher generation while that retirement is still queued.
		await queueUnflushedNarInfoDeletion({ storePathHash: path.storePathHash });
		await pushPath(token, path);

		const recommittedGeneration = await narInfoGeneration(path.storePathHash);

		const response = await authorisedFetch('/gc', token, { method: 'POST' });

		expect({
			status: response.status,
			recommittedGeneration,
			generation: await narInfoGeneration(path.storePathHash),
			object: await isNarInfoObjectPresent(path.storePathHash),
			queued: await narInfoDeletionRows()
		}).toStrictEqual({
			status: StatusCodes.OK,
			recommittedGeneration: 1,
			generation: 1,
			object: true,
			queued: []
		});
	});
});
