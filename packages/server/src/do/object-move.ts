import {
	type CacheName,
	cacheNameSchema,
	firstCacheGeneration,
	type StorePathHash,
	storePathHashSchema,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';

import { type ResolvedCache } from '../db/cache.ts';
import { StoredObjectKeyInvalidError } from '../errors.ts';
import {
	cacheObjectPrefix,
	type R2ObjectKey,
	r2ObjectKeySchema
} from '../http/http.ts';

import { maxOutgoingConnections } from './bulk.ts';
import { type ServerContext } from './context.ts';

// The segment a private cache's stored name put in front of its own name.
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
 * Of a family's stored objects, the ones that still describe a version the
 * cache holds for the path. Each family answers in its own terms, because a
 * narinfo object and an attestation list record different things about the
 * commit that produced them.
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

/**
 * A relocated object, for as long as this run may still take it back.
 */
interface MovedObject {
	readonly key: R2ObjectKey;
	readonly object: R2Object;
}

/**
 * The directory holding the objects one family's private caches wrote.
 *
 * A private cache was stored as `private/<name>`, so its objects sit under
 * `<family>/private/<name>/`. A public cache named `private` writes directly
 * under `<family>/private/`, one directory higher, so the prefix alone does not
 * say whose objects a key holds.
 */
function legacyPrefix(tenant: TenantId, family: ObjectFamily): string {
	return `${family.prefix(tenant)}${privateSegment}`;
}

/**
 * The cache whose objects a directory under the legacy prefix holds.
 *
 * The name is whatever follows `private/`, so a cache named `private` reads
 * back as `private` rather than as the segment its access added.
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
 * Moves one object to the key its cache reads today, and reports whether it
 * wrote the destination.
 *
 * The destination is authoritative once it exists: a commit made after the key
 * changed wrote it under the current key, and copying the older object over it
 * would put back what that commit replaced. So an existing destination is left
 * alone and only the older object is removed.
 *
 * The copy carries the object's metadata across, because the read checks a
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
 * Deleting a path removes its narinfo row first and leaves the object to a
 * queue entry, so a delete that lands between the decision and the copy finds
 * nothing at the current key and would leave this run's copy behind it.
 * Re-reading the rows under the critical section after the writes is how
 * `publishNarInfoObject` settles the same race, and it settles this one for the
 * same reason.
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
 * Relocates the objects a cache can still serve from one prefix and deletes the
 * rest.
 *
 * Nothing writes these keys once the family's keys have moved, so this pass
 * reads a prefix no writer is still adding to, and the local rows say what the
 * cache holds.
 *
 * An object whose path has no row, or whose recorded version a later commit
 * superseded, is one no read could serve. Relocating it would put an object at
 * a live key that the reference edge refuses and nothing collects, so it is
 * deleted here instead. Every object takes that branch when no cache claims the
 * prefix at all: a cache torn down and created again under the same name is a
 * different cache with a different identity, and these objects belong to the
 * deleted one.
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

/**
 * Moves this tenant's private-cache objects off the keys their old stored name
 * gave them.
 *
 * A cache's name no longer contains its access, and neither does a key built
 * from that name, so a private cache cannot serve the objects it already holds
 * until they have moved. The work is bounded: at most
 * {@link maxObjectsMovedPerRun} objects per invocation, after which the caller
 * leaves the local step unrecorded and the control plane wakes the object
 * again.
 *
 * The budget counts the objects a page lists, and no cursor survives the run,
 * so every listed object has to be either relocated or deleted. An object left
 * where it is would be listed again on the next wake, and the pass could never
 * finish.
 *
 * It spends no D1 statements, so the invocation's statement allowance does not
 * bound it. The cap and the connection limit do.
 */
export async function moveLegacyPrivateObjects(
	context: ServerContext,
	tenant: TenantId,
	families: readonly ObjectFamily[]
): Promise<ObjectMoveOutcome> {
	let moved = 0;
	let hasMore = false;

	for (const family of families) {
		const prefix = legacyPrefix(tenant, family);
		// A delimited listing returns each private cache's own directory, and
		// leaves the objects of a public cache named `private` in `objects`, where
		// this ignores them. Reading those directories rather than filtering a flat
		// listing means such a cache's objects never consume this run's budget.
		const directories = await context.env.BLOBS.list({
			prefix,
			delimiter: '/'
		});

		for (const directory of directories.delimitedPrefixes) {
			if (moved >= maxObjectsMovedPerRun) {
				return { moved, hasMore: true };
			}

			// The recorded metadata decides each object's fate, and a listing that
			// carries it costs no more than one that does not.
			const listed = await context.env.BLOBS.list({
				prefix: directory,
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
			hasMore ||= listed.truncated;
		}

		hasMore ||= directories.truncated;
	}

	return { moved, hasMore };
}

/**
 * Moves the objects of every cache above the first generation onto the keys
 * that carry its generation.
 *
 * A key carries a `generation/<n>/` segment from the second generation onwards,
 * so a cache that has never been deleted keeps every key it has and is not
 * listed here at all. A cache whose generation has advanced reads at new keys,
 * and would serve nothing until its objects arrive there.
 *
 * The listing is delimited, so the pass reads only the objects directly under
 * one cache's first-generation prefix and passes over the directories the later
 * generations occupy. Without that it would list the keys it has just written
 * whenever a cache is named `generation`, and a named cache's objects would
 * consume the default cache's budget.
 *
 * The default cache's first-generation prefix is the family's own, so one
 * listing page there covers that cache's objects together with one entry for
 * each named cache the tenant has. A page holds a thousand entries, so a tenant
 * would need that many named caches sorting ahead of its first default-cache
 * object before a run stopped making progress.
 *
 * The work is bounded the same way {@link moveLegacyPrivateObjects} is, and it
 * spends no D1 statement either.
 */
export async function moveObjectsToCacheIncarnation(
	context: ServerContext,
	tenant: TenantId,
	families: readonly ObjectFamily[]
): Promise<ObjectMoveOutcome> {
	let moved = 0;
	let hasMore = false;

	for (const family of families) {
		for (const [prefix, claimant] of advancedPrefixes(
			context,
			tenant,
			family
		)) {
			if (moved >= maxObjectsMovedPerRun) {
				return { moved, hasMore: true };
			}

			// The recorded metadata decides each object's fate, and a listing that
			// carries it costs no more than one that does not.
			const listed = await context.env.BLOBS.list({
				prefix,
				delimiter: '/',
				include: ['customMetadata']
			});
			const page = listed.objects.slice(0, maxObjectsMovedPerRun - moved);

			await disposeOfObjects(context, family, claimant, prefix, page);

			moved += page.length;
			hasMore ||= listed.truncated || page.length < listed.objects.length;
		}
	}

	return { moved, hasMore };
}

/**
 * Each first-generation prefix this pass empties, and the cache that still
 * claims what is under it.
 *
 * Every cache wrote to its first-generation prefix before the key carried a
 * generation, so that prefix holds whatever the last incarnation of the name
 * left there. Only the live cache of the name has rows that can still claim an
 * object. A deleted incarnation claims none, so its objects are deleted instead
 * of being moved to a key nothing reads.
 *
 * Two incarnations of one name share the first-generation prefix, so keying the
 * result by prefix visits it once.
 */
function advancedPrefixes(
	context: ServerContext,
	tenant: TenantId,
	family: ObjectFamily
): ReadonlyMap<string, ResolvedCache | undefined> {
	const claimants = new Map<string, ResolvedCache | undefined>();

	for (const cache of context.cacheRepository.aboveFirstGeneration()) {
		const live = context.cacheRepository.resolve(cache.scope);

		// A deletion advanced this name, so a cache that is live under it reads
		// under a deeper prefix than this one. A cache still on the first
		// generation would read at this very prefix, and moving an object to the
		// key it already has would delete it. Skip that prefix.
		if (live?.generation === firstCacheGeneration) {
			continue;
		}

		claimants.set(cacheObjectPrefix(family.prefix(tenant), cache.scope), live);
	}

	return claimants;
}
