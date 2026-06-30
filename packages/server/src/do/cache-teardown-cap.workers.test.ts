import { type StorePathHash } from '@cupboard/nix-store/scalars';
import { cacheRemoveResponseSchema } from '@cupboard/protocol/caches';
import { type ParsedUploadPathMetadata } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { narInfoObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	authorisedFetch,
	bootstrap,
	currentServer,
	narBytes,
	narInfoDeletionRows,
	narInfoGeneration,
	pushPath,
	queueUnflushedNarInfoDeletion,
	resetTestServer,
	uploadMetadata,
	useTestServer
} from '../test-support.ts';

import { teardownEntryPrefix } from './cache-admin-service.ts';

const origin = 'https://cache.example';
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

async function narInfoObjectPresent(
	storePathHash: StorePathHash,
	cache?: string
): Promise<boolean> {
	const object = await env.BLOBS.head(
		narInfoObjectKey(fixtureTenant, storePathHash, cache)
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

		// Within the cap, the rows and their objects go in the one synchronous pass,
		// nothing is left queued, and the reported count is the full committed total.
		expect({
			status: response.status,
			removed,
			rows: await rowsRemaining(paths),
			object: await narInfoObjectPresent(first.storePathHash, 'builds'),
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

		// A cap of one path takes the over-cap branch with only three pushed: the
		// transaction removes every row at once, the first chunk retires a single
		// object, and the remainder is left queued behind the marker. The rows are
		// gone synchronously; the marker and the queued objects drain on the resume,
		// whose delivery the pool races, so only the converged state is asserted.
		await currentServer().runCacheTeardown('builds', origin, 1);

		expect(await rowsRemaining(paths)).toBe(0);

		await vi.waitFor(async () => {
			await currentServer().resumeCacheTeardown(1);
			const present = await Promise.all(
				paths.map((path) => narInfoObjectPresent(path.storePathHash, 'builds'))
			);
			expect({
				objectsLeft: present.filter(Boolean).length,
				pending: await teardownPending('builds')
			}).toStrictEqual({ objectsLeft: 0, pending: undefined });
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

		// Flushing the queue drains the stale retirement. The generation fence must
		// leave the recommit's row and object, retiring only the superseded edge.
		const response = await authorisedFetch('/gc', token, { method: 'POST' });

		expect({
			status: response.status,
			recommittedGeneration,
			generation: await narInfoGeneration(path.storePathHash),
			object: await narInfoObjectPresent(path.storePathHash),
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
