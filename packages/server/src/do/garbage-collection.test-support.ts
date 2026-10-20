import {
	type CacheScope,
	rootNameSchema,
	type StorePathHash,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';

import * as schema from '../db/schema.ts';
import {
	currentServer,
	defaultCache,
	driveToCompletion,
	resolvedCache,
	syntheticNarHash,
	underOneUnitOfWork
} from '../test-support.ts';

import { type ServerContext } from './context.ts';
import {
	type CollectionInputState,
	GarbageCollectionInputs
} from './garbage-collection-inputs.ts';
import { gcContinuationKey } from './server.ts';

export const pastInstant = '2020-01-01T00:00:00.000Z';
export const futureInstant = '2099-01-01T00:00:00.000Z';

// Enough passes for the small fixtures of these suites to finish a scan, even
// one unit of work at a time.
const maxDrivenPasses = 32;

export function storePathString(storePathHash: StorePathHash): StorePathString {
	return storePathSchema.parse(`/nix/store/${storePathHash}-app`);
}

export function inputState(
	context: ServerContext,
	scope: CacheScope = defaultCache()
): CollectionInputState | undefined {
	return new GarbageCollectionInputs(context).state(
		resolvedCache(context, scope)
	);
}

export function insertNarInfo(
	context: ServerContext,
	storePathHash: StorePathHash,
	index: number,
	scope: CacheScope = defaultCache()
): void {
	context.db
		.insert(schema.narInfos)
		.values({
			cacheId: resolvedCache(context, scope).id,
			storePathHash,
			storePath: storePathString(storePathHash),
			narHash: syntheticNarHash(index),
			narSize: 1,
			referencesJson: '[]',
			createdAt: isoTimestamp(new Date(pastInstant))
		})
		.run();
}

export function insertRoot(
	context: ServerContext,
	root: {
		readonly name: string;
		readonly expiresAt?: string;
		readonly target: StorePathHash;
		readonly scope?: CacheScope;
	}
): void {
	const cacheId = resolvedCache(context, root.scope).id;
	const rootName = rootNameSchema.parse(root.name);
	const createdAt = isoTimestamp(new Date(pastInstant));

	context.db
		.insert(schema.retentionRoots)
		.values({
			cacheId,
			name: rootName,
			...(root.expiresAt !== undefined && {
				expiresAt: isoTimestamp(new Date(root.expiresAt))
			}),
			createdAt,
			updatedAt: createdAt
		})
		.run();
	context.db
		.insert(schema.retentionRootTargets)
		.values({
			cacheId,
			rootName,
			storePathHash: root.target,
			storePath: storePathString(root.target)
		})
		.run();
}

/**
The store paths and root names of one cache, with its collection inputs.
*/
export function collectionState(
	context: ServerContext,
	scope: CacheScope = defaultCache()
): unknown {
	const cacheId = resolvedCache(context, scope).id;

	return {
		narInfos: context.db
			.select({ storePathHash: schema.narInfos.storePathHash })
			.from(schema.narInfos)
			.where(eq(schema.narInfos.cacheId, cacheId))
			.orderBy(schema.narInfos.storePathHash)
			.all()
			.map((row) => row.storePathHash),
		roots: context.db
			.select({ name: schema.retentionRoots.name })
			.from(schema.retentionRoots)
			.where(eq(schema.retentionRoots.cacheId, cacheId))
			.all()
			.map((row) => row.name),
		inputs: inputState(context, scope)
	};
}

async function scanPhase(
	scope: CacheScope = defaultCache()
): Promise<string | undefined> {
	return runInDurableObject(
		currentServer(),
		(instance) =>
			instance.context.db
				.select({ phase: schema.garbageCollectionScans.phase })
				.from(schema.garbageCollectionScans)
				.where(
					eq(
						schema.garbageCollectionScans.cacheId,
						resolvedCache(instance.context, scope).id
					)
				)
				.get()?.phase
	);
}

/**
Runs one unit of collection work and drops the continuation that it arms,
so a stray alarm delivery cannot advance the scan under another budget.
*/
export async function collectOneUnitOfWork(): Promise<void> {
	await runInDurableObject(currentServer(), async (instance, state) => {
		await underOneUnitOfWork(() => instance.runGarbageCollection());
		await state.storage.delete(gcContinuationKey);
		await state.storage.deleteAlarm();
	});
}

/**
Runs passes until the scan of a cache reaches a phase, or until it
completes when `phase` is undefined.
*/
export async function driveScanTo(
	pass: () => Promise<void>,
	phase: string | undefined,
	scope: CacheScope = defaultCache()
): Promise<void> {
	await driveToCompletion(
		pass,
		async () => (await scanPhase(scope)) === phase,
		maxDrivenPasses
	);
}

/**
Runs cron collection passes until the tenant-wide continuation is gone.
Callers fence alarm arming, so each pass runs where the test calls it.
*/
export async function collectTenant(): Promise<void> {
	await currentServer().runGarbageCollection();
	await driveToCompletion(
		() => currentServer().runGarbageCollection(),
		() =>
			runInDurableObject(
				currentServer(),
				async (_instance, state) =>
					(await state.storage.get(gcContinuationKey)) === undefined
			),
		maxDrivenPasses
	);
}

export async function useMinScanInterval(seconds: number): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		instance.context.env = {
			...instance.context.env,
			CUPBOARD_GC_MIN_SCAN_INTERVAL_SECONDS: String(seconds)
		};
	});
}
