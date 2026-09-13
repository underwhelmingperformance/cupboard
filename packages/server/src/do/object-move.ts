import {
	type CacheName,
	cacheNameSchema,
	firstCacheGeneration,
	type StorePathHash,
	storePathHashSchema,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { cacheScopeFromRow } from '../db/cache.ts';
import { type ResolvedCache } from '../db/cache.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { StoredObjectKeyInvalidError } from '../errors.ts';
import {
	cacheObjectPrefix,
	type R2ObjectKey,
	r2ObjectKeySchema
} from '../http/http.ts';
import { afterLifecycleKey } from '../migration/lifecycle-cursor.ts';

import { maxOutgoingConnections } from './bulk.ts';
import { type ServerContext } from './context.ts';
import { hasSubrequestsFor } from './subrequest-slice.ts';

const privateSegment = 'private/';

/**
 * Moving one object costs a head of the destination and, when nothing is there,
 * a get, a put and a delete. This many objects per run leaves the listing and
 * the rest of the pass well inside the Durable Object's subrequest allowance,
 * and a tenant with more objects finishes over the wakes that follow.
 */
export const maxObjectsMovedPerRun = 100;

export interface ObjectMoveOutcome {
	readonly moved: number;
	readonly hasMore: boolean;
}

/**
 * Returns the path hashes whose stored objects match the cache's current local
 * rows. Narinfo objects and attestation lists record different metadata
 * about a commit, so each family checks its own fields.
 */
type CurrentObjects = (
	cache: ResolvedCache,
	objects: ReadonlyMap<StorePathHash, R2Object>
) => ReadonlySet<StorePathHash>;

/**
 * One family of path-keyed objects: where the family keeps everything it
 * writes, where within that one cache's object for a path belongs, and which
 * of its stored objects a cache can still serve.
 */
export interface ObjectFamily {
	readonly prefix: (tenant: TenantId) => string;
	readonly key: (
		cache: ResolvedCache,
		storePathHash: StorePathHash
	) => R2ObjectKey;
	readonly currentObjects: CurrentObjects;
}

/**
 * One stored object under a prefix a move is emptying.
 */
interface SourceObject {
	readonly key: R2ObjectKey;
	readonly storePathHash: StorePathHash;
	readonly object: R2Object;
}

interface MovedObject {
	readonly key: R2ObjectKey;
	readonly object: R2Object;
}

/**
 * The old storage prefix for one family's private-cache objects.
 *
 * A private cache used the stored name `private/<name>`, so its objects are
 * under `<family>/private/<name>/`. A public cache called `private` writes
 * directly under `<family>/private/`, one directory higher. The prefix alone
 * therefore does not identify the cache that owns an object.
 */
function legacyPrefix(tenant: TenantId, family: ObjectFamily): string {
	return `${family.prefix(tenant)}${privateSegment}`;
}

/**
 * The cache name encoded in a directory below the legacy `private/` prefix.
 */
function cacheNameOf(legacyFamilyPrefix: string, directory: string): CacheName {
	const parsed = cacheNameSchema.safeParse(
		directory.slice(legacyFamilyPrefix.length, -1)
	);

	if (!parsed.success) {
		throw new StoredObjectKeyInvalidError(directory);
	}

	return parsed.data;
}

/**
 * Reads each listed key back as the store path it was written for.
 *
 * Only this server writes these keys. A key it cannot read back is a defect in
 * this build rather than an object another writer left, so it stops the pass
 * instead of reaching the branch that deletes an object no cache claims.
 */
function sourceObjectsIn(
	prefix: string,
	listed: readonly R2Object[]
): SourceObject[] {
	return listed.map((object) => {
		const parsed = storePathHashSchema.safeParse(
			object.key.slice(prefix.length)
		);

		if (!parsed.success) {
			throw new StoredObjectKeyInvalidError(object.key);
		}

		return {
			key: r2ObjectKeySchema.parse(object.key),
			storePathHash: parsed.data,
			object
		};
	});
}

async function deleteObject(
	context: ServerContext,
	key: R2ObjectKey
): Promise<void> {
	await context.objectWrites.write([key], () => context.env.BLOBS.delete(key));
}

/**
 * Moves one object to the key its cache now reads, and reports whether it
 * wrote the destination.
 *
 * The destination is authoritative once it exists: a commit made after the key
 * changed wrote it under the current key, and copying the older object over it
 * would put back what that commit replaced. So an existing destination is left
 * alone and only the older object is removed.
 *
 * The copy preserves the object's metadata because the read checks a
 * narinfo's recorded generation and NAR hash against the reference edge and
 * would refuse an object that arrived without them.
 */
async function moveObject(
	context: ServerContext,
	source: R2ObjectKey,
	destination: R2ObjectKey
): Promise<{ readonly hasCopied: boolean }> {
	return context.objectWrites.write([source, destination], async () => {
		const existing = await context.env.BLOBS.head(destination);
		let hasCopied = false;

		if (existing === null) {
			const object = await context.env.BLOBS.get(source);

			if (object !== null) {
				await context.env.BLOBS.put(destination, object.body, {
					httpMetadata: object.httpMetadata,
					customMetadata: object.customMetadata
				});
				hasCopied = true;
			}
		}

		await context.env.BLOBS.delete(source);

		return { hasCopied };
	});
}

/**
 * Takes back a relocated object whose path stopped being current while the
 * copy was in flight.
 *
 * Deletion removes the path's narinfo row before its queued object deletion.
 * If deletion happens after this run checks the row but before it copies the
 * object, the queue can miss the new copy. Re-read the row under the critical
 * section and remove this run's copy when the row has gone.
 *
 * Only the objects this run wrote are considered. A destination that was
 * already there belongs to a later commit and is not this run's to remove.
 */
async function discardSupersededCopies(
	context: ServerContext,
	family: ObjectFamily,
	cache: ResolvedCache,
	moved: ReadonlyMap<StorePathHash, MovedObject>
): Promise<void> {
	if (moved.size === 0) {
		return;
	}

	await context.criticalSection(async () => {
		const current = family.currentObjects(
			cache,
			new Map(
				[...moved].map(([storePathHash, copy]) => [storePathHash, copy.object])
			)
		);
		const superseded = [...moved]
			.filter(([storePathHash]) => !current.has(storePathHash))
			.map(([, copy]) => copy.key);

		await mapWithConcurrency(superseded, maxOutgoingConnections, (key) =>
			deleteObject(context, key)
		);
	});
}

/**
 * Relocates current objects from a legacy prefix and deletes the rest.
 *
 * Writers no longer use this prefix. Local rows identify objects that the
 * cache can still serve. An object without a path row, or one whose recorded
 * version a later commit replaced, would not be readable at its new key.
 * Delete these objects so they do not remain outside collection. If no cache
 * claims the prefix, all of its objects belong to a deleted cache and are
 * deleted.
 */
async function disposeOfObjects(
	context: ServerContext,
	family: ObjectFamily,
	cache: ResolvedCache | undefined,
	prefix: string,
	listed: readonly R2Object[]
): Promise<void> {
	const objects = sourceObjectsIn(prefix, listed);

	if (cache === undefined) {
		await mapWithConcurrency(objects, maxOutgoingConnections, (entry) =>
			deleteObject(context, entry.key)
		);

		return;
	}

	const current = family.currentObjects(
		cache,
		new Map(objects.map((entry) => [entry.storePathHash, entry.object]))
	);
	const moved = await mapWithConcurrency(
		objects,
		maxOutgoingConnections,
		async (entry) => {
			if (!current.has(entry.storePathHash)) {
				await deleteObject(context, entry.key);

				return;
			}

			const key = family.key(cache, entry.storePathHash);
			const { hasCopied } = await moveObject(context, entry.key, key);

			return hasCopied
				? ([entry.storePathHash, { key, object: entry.object }] as const)
				: undefined;
		}
	);

	await discardSupersededCopies(
		context,
		family,
		cache,
		new Map(moved.filter((copy) => copy !== undefined))
	);
}

const legacyProgressKey = 'migration/legacy-private-objects/v2';
const legacyProgressSchema = z.object({
	family: z.number().int().nonnegative(),
	outerCursor: z.string().optional(),
	afterDirectory: z.string(),
	activeDirectory: z.string().optional(),
	listingCursor: z.string().optional()
});

/**
 * Moves private-cache objects off their legacy keys. The outer cursor also
 * advances past objects owned by a public cache named `private`, which stay
 * at those keys. Each wake bounds both directory inspection and object moves.
 */
export async function moveLegacyPrivateObjects(
	context: ServerContext,
	tenant: TenantId,
	families: readonly ObjectFamily[]
): Promise<ObjectMoveOutcome> {
	const saved = await context.ctx.storage.get(legacyProgressKey);
	let progress: z.infer<typeof legacyProgressSchema> =
		saved === undefined
			? { family: 0, afterDirectory: '' }
			: legacyProgressSchema.parse(saved);
	let moved = 0;
	let inspected = 0;
	for (const [familyIndex, family] of families.entries()) {
		if (familyIndex < progress.family) {
			continue;
		}
		if (!hasSubrequestsFor(2 + 5 * (maxObjectsMovedPerRun - moved))) {
			return { moved, hasMore: true };
		}
		const prefix = legacyPrefix(tenant, family);
		const directories = await context.env.BLOBS.list({
			prefix,
			delimiter: '/',
			cursor: progress.outerCursor
		});
		const pendingDirectories = directories.delimitedPrefixes.filter(
			(directory) => directory > progress.afterDirectory
		);
		for (const directory of pendingDirectories) {
			if (
				inspected >= maxPrefixesInspectedPerRun ||
				moved >= maxObjectsMovedPerRun ||
				!hasSubrequestsFor(1 + 5 * (maxObjectsMovedPerRun - moved))
			) {
				return { moved, hasMore: true };
			}
			const listed = await context.env.BLOBS.list({
				prefix: directory,
				cursor:
					progress.activeDirectory === directory
						? progress.listingCursor
						: undefined,
				limit: maxObjectsMovedPerRun - moved,
				include: ['customMetadata']
			});
			await disposeOfObjects(
				context,
				family,
				context.cacheRepository.resolve({
					kind: 'named',
					name: cacheNameOf(prefix, directory)
				}),
				directory,
				listed.objects
			);
			moved += listed.objects.length;
			inspected += 1;
			if (listed.truncated) {
				await context.ctx.storage.put(legacyProgressKey, {
					...progress,
					family: familyIndex,
					activeDirectory: directory,
					listingCursor: listed.cursor
				});
				return { moved, hasMore: true };
			}
			progress = {
				family: familyIndex,
				outerCursor: progress.outerCursor,
				afterDirectory: directory
			};
			await context.ctx.storage.put(legacyProgressKey, progress);
		}
		if (directories.truncated) {
			await context.ctx.storage.put(legacyProgressKey, {
				family: familyIndex,
				outerCursor: directories.cursor,
				afterDirectory: ''
			});
			return { moved, hasMore: true };
		}
		progress = { family: familyIndex + 1, afterDirectory: '' };
		await context.ctx.storage.put(legacyProgressKey, progress);
	}
	return { moved, hasMore: false };
}

export const maxPrefixesInspectedPerRun = 36;
const incarnationProgressKey = 'migration/incarnation-objects/v2';
const incarnationProgressSchema = z.object({
	family: z.number().int().nonnegative(),
	afterKey: z.string(),
	listingCursor: z.string().optional()
});

/**
 * Moves first-generation objects to the current cache incarnation, or deletes
 * them when no live cache claims them. Scope and listing cursors survive each
 * wake, including pages which contain no objects to move.
 *
 * A first-generation cache still reads its original keys and must not be moved.
 * Delimited listings exclude the generation directories beneath those keys.
 */
export async function moveObjectsToCacheIncarnation(
	context: ServerContext,
	tenant: TenantId,
	families: readonly ObjectFamily[]
): Promise<ObjectMoveOutcome> {
	const saved = await context.ctx.storage.get(incarnationProgressKey);
	let progress: z.infer<typeof incarnationProgressSchema> =
		saved === undefined
			? { family: 0, afterKey: '' }
			: incarnationProgressSchema.parse(saved);
	let moved = 0;
	let inspected = 0;

	for (const [familyIndex, family] of families.entries()) {
		if (familyIndex < progress.family) {
			continue;
		}
		const scopes = await context.d1
			.select()
			.from(d1Schema.cacheLifecycle)
			.where(
				and(
					eq(d1Schema.cacheLifecycle.tenant, tenant),
					afterLifecycleKey(progress.afterKey)
				)
			)
			.orderBy(
				d1Schema.cacheLifecycle.cacheKind,
				d1Schema.cacheLifecycle.cacheName
			)
			.limit(maxPrefixesInspectedPerRun - inspected)
			.all();
		for (const row of scopes) {
			if (
				moved >= maxObjectsMovedPerRun ||
				!hasSubrequestsFor(1 + 5 * (maxObjectsMovedPerRun - moved))
			) {
				return { moved, hasMore: true };
			}
			const scope = cacheScopeFromRow({
				kind: row.cacheKind,
				name: row.cacheName
			});
			let claimant = context.cacheRepository.resolve(scope);
			if (
				claimant !== undefined &&
				row.deletedAt === null &&
				claimant.generation < row.generation
			) {
				context.cacheRepository.stampGeneration(claimant, row.generation);
				claimant = context.cacheRepository.resolve(scope);
			}
			if (
				row.generation > firstCacheGeneration &&
				claimant?.generation !== firstCacheGeneration
			) {
				const prefix = cacheObjectPrefix(family.prefix(tenant), scope);
				const listed = await context.env.BLOBS.list({
					prefix,
					cursor: progress.listingCursor,
					delimiter: '/',
					limit: maxObjectsMovedPerRun - moved,
					include: ['customMetadata']
				});
				await disposeOfObjects(
					context,
					family,
					row.deletedAt === null ? claimant : undefined,
					prefix,
					listed.objects
				);
				moved += listed.objects.length;
				if (listed.truncated) {
					await context.ctx.storage.put(incarnationProgressKey, {
						...progress,
						family: familyIndex,
						listingCursor: listed.cursor
					});
					return { moved, hasMore: true };
				}
			}
			inspected += 1;
			progress = {
				family: familyIndex,
				afterKey: scope.kind === 'default' ? 'default' : `named:${scope.name}`
			};
			await context.ctx.storage.put(incarnationProgressKey, progress);
		}
		if (inspected >= maxPrefixesInspectedPerRun) {
			return { moved, hasMore: true };
		}
		progress = { family: familyIndex + 1, afterKey: '' };
		await context.ctx.storage.put(incarnationProgressKey, progress);
	}
	return { moved, hasMore: false };
}

export async function resetObjectMoves(context: ServerContext): Promise<void> {
	await context.ctx.storage.delete([incarnationProgressKey, legacyProgressKey]);
}
