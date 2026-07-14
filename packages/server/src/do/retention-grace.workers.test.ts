import {
	DEFAULT_CACHE,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../db/schema.ts';
import {
	authorisedFetch,
	bootstrap,
	currentServer,
	deletePath,
	narBytes,
	narInfoGeneration,
	pushPath,
	resetTestServer,
	uploadMetadata,
	useTestServer
} from '../test-support.ts';

import { gcContinuationKey } from './server.ts';

const repeated = (character: string): string => character.repeat(32);

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
				cache,
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
			.where(eq(schema.caches.name, cache))
			.run();
	});
}

async function graceDeadlines(cache: string): Promise<readonly string[]> {
	return runInDurableObject(currentServer(), (instance) =>
		instance.context.db
			.select({ storePathHash: schema.retentionGrace.storePathHash })
			.from(schema.retentionGrace)
			.where(eq(schema.retentionGrace.cache, cache))
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
					state.storage.get<number>(gcContinuationKey)
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
				.where(eq(schema.caches.name, 'builds'))
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
