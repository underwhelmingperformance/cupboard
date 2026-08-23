import {
	cacheNameSchema,
	storedCacheSchema,
	type StorePathHash
} from '@cupboard/nix-store/scalars';
import { cacheRemoveResponseSchema } from '@cupboard/protocol/caches';
import { type ParsedUploadPathMetadata } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

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
	currentServer,
	driveToCompletion,
	narBytes,
	narInfoDeletionRows,
	narInfoGeneration,
	pushPath,
	queueUnflushedNarInfoDeletion,
	resetTestServer,
	tenantBlobRows,
	tenantUsageRow,
	uploadMetadata,
	useTestServer,
	verifiableNar
} from '../test-support.ts';

import { teardownEntryPrefix } from './cache-admin-service.ts';

const buildsCache = cacheNameSchema.parse('builds');
const origin = requestOriginSchema.parse('https://cache.example');
const repeated = (character: string): string => character.repeat(32);

function buildMetadata(character: string): ParsedUploadPathMetadata {
	return uploadMetadata({
		fileSize: narBytes.byteLength,
		storePathHash: repeated(character),
		name: `path-${character}`
	});
}

async function teardownPending(cache: string): Promise<unknown> {
	return runInDurableObject(currentServer(), (_instance, state) =>
		state.storage.get(`${teardownEntryPrefix}${cache}`)
	);
}

async function isNarInfoObjectPresent(
	storePathHash: StorePathHash,
	cache?: string
): Promise<boolean> {
	const object = await env.BLOBS.head(
		narInfoObjectKey(
			fixtureTenant,
			storePathHash,
			cache === undefined ? undefined : storedCacheSchema.parse(cache)
		)
	);

	return object !== null;
}

async function rowsRemaining(
	paths: readonly ParsedUploadPathMetadata[]
): Promise<number> {
	const generations = await Promise.all(
		paths.map((path) => narInfoGeneration(path.storePathHash))
	);

	return generations.filter((generation) => generation !== undefined).length;
}

describe('cache teardown', () => {
	beforeEach(resetTestServer);

	it('empties a forced cache at once for a cache within the cap', async () => {
		await useTestServer('teardown-drain');
		const { token } = await bootstrap();
		const first = buildMetadata('a');
		const paths = [first, buildMetadata('b'), buildMetadata('c')];

		for (const metadata of paths) {
			await pushPath(token, metadata, 'builds');
		}

		const response = await authorisedFetch('/caches/builds?force=true', token, {
			method: 'DELETE'
		});
		const removed = cacheRemoveResponseSchema.parse(await response.json());

		expect({
			status: response.status,
			removed,
			rows: await rowsRemaining(paths),
			object: await isNarInfoObjectPresent(first.storePathHash, 'builds'),
			pending: await teardownPending('builds')
		}).toStrictEqual({
			status: StatusCodes.OK,
			removed: { name: 'builds', removed: true, storePathsRemoved: 3 },
			rows: 0,
			object: false,
			pending: undefined
		});
	});

	it('arms the marker and drains an over-cap teardown across resumes', async () => {
		await useTestServer('teardown-resume');
		const { token } = await bootstrap();
		const paths = [buildMetadata('a'), buildMetadata('b'), buildMetadata('c')];

		for (const metadata of paths) {
			await pushPath(token, metadata, 'builds');
		}

		await currentServer().runCacheTeardown(buildsCache, origin, 1);

		expect(await rowsRemaining(paths)).toBe(0);

		await driveToCompletion(
			() => currentServer().resumeCacheTeardown(1),
			async () => (await teardownPending('builds')) === undefined,
			paths.length
		);

		const present = await Promise.all(
			paths.map((path) => isNarInfoObjectPresent(path.storePathHash, 'builds'))
		);

		expect({
			objectsLeft: present.filter(Boolean).length,
			pending: await teardownPending('builds')
		}).toStrictEqual({ objectsLeft: 0, pending: undefined });
	});

	it('retires a chunk-spanning teardown with correct accounting', async () => {
		await useTestServer('teardown-batch');
		const { token } = await bootstrap();

		// Enough paths that the presence delete spans several parameter sub-chunks.
		// Each path must carry a distinct narHash so the IN list does not collapse
		// to a single value; verifiableNar produces self-consistent compressed bytes
		// whose decompressed content actually hashes to the declared narHash.
		const alphabet = '0123456789abcdfghijklmnpqrsvwxyz';
		const nars = await Promise.all(
			Array.from({ length: 95 }, (_, index) => verifiableNar(String(index)))
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
					.map(([metadata, nar]) => pushPath(token, metadata, 'builds', nar))
			);
		}

		const response = await authorisedFetch('/caches/builds?force=true', token, {
			method: 'DELETE'
		});
		const removed = cacheRemoveResponseSchema.parse(await response.json());
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
			removed: { name: 'builds', removed: true, storePathsRemoved: 95 },
			rows: 0,
			queued: [],
			edges: [],
			presence: [],
			usage: { bytes: 0, narinfos: 0, blobs: 0 }
		});
	}, 120_000);

	it('clears only the generations a chunk actually retired', async () => {
		await useTestServer('teardown-generations');
		const { token } = await bootstrap();
		const path = buildMetadata('a');

		// A delete whose queued cleanup never flushed, then a recommit: the queue
		// holds two generations of the one path. A cap of one splits them across
		// drain chunks, so the first chunk's clear must remove only the generation
		// it retired; wiping the path's other row would drop the second
		// generation's edge retirement and credits on the floor.
		await pushPath(token, path, 'builds');
		await queueUnflushedNarInfoDeletion({
			storePathHash: path.storePathHash,
			cache: 'builds'
		});
		await pushPath(token, path, 'builds');

		await currentServer().runCacheTeardown(buildsCache, origin, 1);

		await driveToCompletion(
			() => currentServer().resumeCacheTeardown(1),
			async () => (await teardownPending('builds')) === undefined,
			2
		);

		const usage = await tenantUsageRow();

		expect({
			queued: await narInfoDeletionRows(),
			edges: await blobReferenceRows(),
			presence: await tenantBlobRows(),
			pending: await teardownPending('builds'),
			object: await isNarInfoObjectPresent(path.storePathHash, 'builds'),
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
		const { token } = await bootstrap();
		const torn = buildMetadata('a');
		const kept = buildMetadata('b');

		await pushPath(token, torn, 'builds');
		await pushPath(token, kept, 'other');

		const response = await authorisedFetch('/caches/builds?force=true', token, {
			method: 'DELETE'
		});
		const removed = cacheRemoveResponseSchema.parse(await response.json());
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
			removed: { name: 'builds', removed: true, storePathsRemoved: 1 },
			presence: [narBytes.byteLength],
			edges: [{ cache: 'other', storePathHash: kept.storePathHash }],
			usage: { bytes: narBytes.byteLength, narinfos: 1, blobs: 1 }
		});
	});

	it('removes a stale attestation list object on a replayed retirement', async () => {
		await useTestServer('teardown-attestation-list');
		const { token } = await bootstrap();
		const path = buildMetadata('a');

		await pushPath(token, path, 'builds');

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
		const { token } = await bootstrap();
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
