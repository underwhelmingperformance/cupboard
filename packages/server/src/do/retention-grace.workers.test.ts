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
	removeRoot,
	resetTestServer,
	setRoot,
	uploadMetadata,
	useTestServer
} from '../test-support.ts';

import { RetentionService } from './retention-service.ts';
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

async function addGracePolicy(
	cachePrefix: string,
	graceSeconds: number
): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		new RetentionService(instance.context).addGracePolicy({
			cachePrefix,
			graceSeconds
		});
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
			.where(eq(schema.retentionGrace.cache, cache))
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
				.where(eq(schema.caches.name, cache))
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
		await addGracePolicy('', dayGraceSeconds);

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
		await addGracePolicy('', dayGraceSeconds);

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
			const withoutPolicies = service.resolveGraceSeconds('pr-5');

			service.addGracePolicy({ cachePrefix: '', graceSeconds: 604_800 });
			service.addGracePolicy({ cachePrefix: 'pr-', graceSeconds: 3600 });

			return {
				withoutPolicies,
				prCache: service.resolveGraceSeconds('pr-5'),
				otherCache: service.resolveGraceSeconds('builds')
			};
		});

		expect(resolved).toStrictEqual({
			withoutPolicies: undefined,
			prCache: 3600,
			otherCache: 604_800
		});
	});
});
