import {
	type CacheName,
	cacheNameSchema,
	type StorePathHash,
	storePathHashSchema,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';

import { type ResolvedCache } from '../db/cache.ts';
import { LegacyObjectKeyInvalidError } from '../errors.ts';
import { type R2ObjectKey, r2ObjectKeySchema } from '../http/http.ts';

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
 * One family of path-keyed objects a private cache wrote under its old stored
 * name.
 */
export interface LegacyObjectFamily {
	/**
	 * The key segment that names the family, such as `narinfo`.
	 */
	readonly segment: string;
	readonly currentObjects: CurrentObjects;
}

/**
 * One stored object under a private cache's old directory.
 */
interface LegacyObject {
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
function legacyPrefix(tenant: TenantId, family: LegacyObjectFamily): string {
	return `t/${tenant}/${family.segment}/${privateSegment}`;
}

/**
 * Where an object under one private cache's old directory belongs once its
 * access is no longer part of its name.
 *
 * The old directory is the family's own directory plus `private/`, so taking
 * that segment off the front of the key leaves the key the cache's scope alone
 * gives it. A cache named `private` keeps its name in the result, because only
 * the segment the access added comes off.
 */
function movedKey(legacyFamilyPrefix: string, key: string): R2ObjectKey {
	const family = legacyFamilyPrefix.slice(0, -privateSegment.length);

	return r2ObjectKeySchema.parse(
		`${family}${key.slice(legacyFamilyPrefix.length)}`
	);
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
		throw new LegacyObjectKeyInvalidError(directory);
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
function legacyObjectsIn(
	directory: string,
	listed: readonly R2Object[]
): LegacyObject[] {
	return listed.map((object) => {
		const parsed = storePathHashSchema.safeParse(
			object.key.slice(directory.length)
		);

		if (!parsed.success) {
			throw new LegacyObjectKeyInvalidError(object.key);
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
 * Moves one object to the key its cache's scope alone gives it, and reports
 * whether it wrote the destination.
 *
 * The destination is authoritative once it exists: a commit since the cutover
 * wrote it under the current key, and copying the older object over it would
 * put back what that commit replaced. So an existing destination is left alone
 * and only the older object is removed.
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
	family: LegacyObjectFamily,
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
 * Relocates the objects a cache can still serve and deletes the rest.
 *
 * Nothing writes a legacy key after the cutover, because every key is built
 * from a cache's scope and a scope carries no access. So this decides about a
 * settled directory rather than racing a writer for it, and the local rows are
 * the current answer to what the cache holds.
 *
 * An object whose path has no row, or whose recorded version a later commit
 * superseded, is one no read could serve. Relocating it would put an object at
 * a live key that the reference edge refuses and nothing collects, so it is
 * deleted here instead. Every object of a cache the registry no longer has
 * takes the same branch: a cache torn down and created again under the same
 * name is a different cache with a different identity, and these objects belong
 * to the one that went.
 */
async function disposeOfDirectory(
	context: ServerContext,
	family: LegacyObjectFamily,
	legacyFamilyPrefix: string,
	directory: string,
	listed: readonly R2Object[]
): Promise<void> {
	const objects = legacyObjectsIn(directory, listed);
	const cache = context.cacheRepository.resolve({
		kind: 'named',
		name: cacheNameOf(legacyFamilyPrefix, directory)
	});

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

			const key = movedKey(legacyFamilyPrefix, entry.key);
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
 * Taking the access out of a cache's name took it out of the keys built from
 * that name, so a private cache does not serve what it already holds until its
 * objects have moved. The work is bounded: at most
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
	families: readonly LegacyObjectFamily[]
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

			await disposeOfDirectory(
				context,
				family,
				prefix,
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
