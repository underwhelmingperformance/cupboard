import {
	cacheNameSchema,
	type CacheScope,
	narInfoGenerationSchema,
	nixSha256HashSchema,
	storePathHashSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { legacyCacheKey } from '../db/cache.ts';
import { secondCacheGeneration } from '../db/cache-generation.ts';
import * as schema from '../db/schema.ts';
import { StoredObjectKeyInvalidError } from '../errors.ts';
import {
	bootstrap,
	currentServer,
	resolvedCache,
	useTestServer
} from '../test-support.ts';

import { listGenerationMetadataKey } from './attestations-service.ts';

// One narinfo body per seeded object, so a moved object can be told from a
// destination that was already there.
const legacyBody = 'legacy-narinfo';
const currentBody = 'current-narinfo';
const storePathHash = '0123456789abcdfghijklmnpqrsvwxyz';
const narHash = `sha256:${storePathHash.repeat(2).slice(0, 52)}`;
const cacheName = 'builds';
const privateCache: CacheScope = {
	kind: 'named',
	name: cacheNameSchema.parse(cacheName)
};
const advancedName = 'advanced';
const advancedCache: CacheScope = {
	kind: 'named',
	name: cacheNameSchema.parse(advancedName)
};

/**
 * The metadata a narinfo object records about the commit that produced it. A
 * narinfo object without all four entries records no version at all, so the
 * read refuses it and so does the move.
 */
function narInfoMetadata(generation: number): Record<string, string> {
	return {
		generation: String(generation),
		narHash,
		narUrl: `nar/${narHash}.nar.zst`,
		signatureGeneration: '0'
	};
}

function listMetadata(generation: number): Record<string, string> {
	return { [listGenerationMetadataKey]: String(generation) };
}

async function seed(
	key: string,
	body: string,
	metadata: Record<string, string>
): Promise<void> {
	await env.BLOBS.put(key, body, { customMetadata: metadata });
}

/**
 * Removes the keys a case is about before it seeds them.
 *
 * R2 is one bucket the pool does not roll back between tests, and every server
 * these cases start is configured with the same tenant, so they address the
 * same keys. An object an earlier case left at a destination would make the
 * move keep that object rather than the one under test.
 */
async function clear(...keys: readonly string[]): Promise<void> {
	await Promise.all(keys.map((key) => env.BLOBS.delete(key)));
}

async function objectAt(
	key: string
): Promise<{ body: string; generation: string | undefined } | undefined> {
	const object = await env.BLOBS.get(key);

	if (object === null) {
		return undefined;
	}

	return {
		body: await object.text(),
		generation: object.customMetadata?.generation
	};
}

/**
 * An attestation list records its narinfo generation under its own metadata
 * entry, so a list object is read back differently from a narinfo object.
 */
async function listAt(
	key: string
): Promise<{ body: string; generation: string | undefined } | undefined> {
	const object = await env.BLOBS.get(key);

	if (object === null) {
		return undefined;
	}

	return {
		body: await object.text(),
		generation: object.customMetadata?.[listGenerationMetadataKey]
	};
}

function wake(): Promise<unknown> {
	return runInDurableObject(currentServer(), (instance) =>
		instance.reportLocalStep()
	);
}

/**
 * The tenant this server was configured with. Object keys are built from that
 * tenant id, which differs from the name the harness addresses the server by.
 */
async function configuredTenant(): Promise<string> {
	const tenant = await runInDurableObject(currentServer(), (instance) =>
		instance.context.tenant()
	);

	if (tenant === undefined) {
		throw new Error('the harness server has no configured tenant');
	}

	return tenant;
}

/**
 * Brings up a server holding one private cache named `builds`.
 */
async function useServerWithPrivateCache(name: string): Promise<string> {
	await useTestServer(name);
	await bootstrap({ caches: [{ scope: privateCache, access: 'private' }] });

	return configuredTenant();
}

/**
 * Records a committed version of the path in one cache, as a commit would. The
 * dual write keeps the legacy key beside the identity for as long as both
 * spellings are read.
 */
async function commitPath(
	generation: number,
	scope: CacheScope = privateCache
): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		const cache = resolvedCache(instance.context, scope);

		instance.context.db
			.insert(schema.narInfos)
			.values({
				cache: legacyCacheKey(cache.scope, cache.access),
				cacheId: cache.id,
				storePathHash: storePathHashSchema.parse(storePathHash),
				storePath: storePathSchema.parse(`/nix/store/${storePathHash}-seeded`),
				narHash: nixSha256HashSchema.parse(narHash),
				narSize: 10,
				referencesJson: '[]',
				sigsJson: '[]',
				generation: narInfoGenerationSchema.parse(generation),
				createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z')
			})
			.run();
	});
}

describe('legacy private object move', () => {
	it('moves an object the cache still serves', async () => {
		const tenant = await useServerWithPrivateCache('legacy-move');
		const source = `t/${tenant}/narinfo/private/${cacheName}/${storePathHash}`;
		const destination = `t/${tenant}/narinfo/${cacheName}/${storePathHash}`;
		await clear(source, destination);
		await seed(source, legacyBody, narInfoMetadata(3));
		await commitPath(3);

		await wake();

		expect({
			source: await objectAt(source),
			destination: await objectAt(destination)
		}).toStrictEqual({
			source: undefined,
			destination: { body: legacyBody, generation: '3' }
		});
	});

	// The path was deleted between the read flip and this run. Deleting a path
	// removes its row first, so the row is the whole answer: no read can reach
	// this object, and relocating it would put an object at a live key that the
	// reference edge refuses and nothing collects.
	it('deletes an object whose path the cache no longer holds', async () => {
		const tenant = await useServerWithPrivateCache('legacy-move-deleted-path');
		const source = `t/${tenant}/narinfo/private/${cacheName}/${storePathHash}`;
		const destination = `t/${tenant}/narinfo/${cacheName}/${storePathHash}`;
		await clear(source, destination);
		await seed(source, legacyBody, narInfoMetadata(3));

		await wake();

		expect({
			source: await objectAt(source),
			destination: await objectAt(destination)
		}).toStrictEqual({ source: undefined, destination: undefined });
	});

	/**
	 * The row exists and records a later version than the object does, so the
	 * object's presence in a live cache is not enough to relocate it.
	 *
	 * This is the state a cache torn down and created again under the same name
	 * leaves behind. The new cache is a different identity, and `generation_seq`
	 * is never reset, so every version it commits is numbered above the ones its
	 * predecessor left. Relocating one of those onto the new cache's live key
	 * would manufacture exactly the object the reference edge exists to refuse.
	 * A predicate that asked only whether the path has a row would do it.
	 */
	it('deletes an object whose version a later commit superseded', async () => {
		const tenant = await useServerWithPrivateCache('legacy-move-superseded');
		const source = `t/${tenant}/narinfo/private/${cacheName}/${storePathHash}`;
		const destination = `t/${tenant}/narinfo/${cacheName}/${storePathHash}`;
		await clear(source, destination);
		await seed(source, legacyBody, narInfoMetadata(3));
		await commitPath(7);

		await wake();

		expect({
			source: await objectAt(source),
			destination: await objectAt(destination)
		}).toStrictEqual({ source: undefined, destination: undefined });
	});

	// Nothing reads these objects any more: the cache that wrote them is gone,
	// and a cache created again under the same name would be a different one.
	it('deletes every object of a cache the registry no longer has', async () => {
		await useTestServer('legacy-move-torn-down');
		await bootstrap();
		const tenant = await configuredTenant();
		const source = `t/${tenant}/narinfo/private/${cacheName}/${storePathHash}`;
		const destination = `t/${tenant}/narinfo/${cacheName}/${storePathHash}`;
		await clear(source, destination);
		await seed(source, legacyBody, narInfoMetadata(3));

		await wake();

		expect({
			source: await objectAt(source),
			destination: await objectAt(destination)
		}).toStrictEqual({ source: undefined, destination: undefined });
	});

	// A commit since the cutover wrote the destination. Copying the older object
	// over it would put back what that commit replaced.
	it('keeps a destination a later commit already wrote', async () => {
		const tenant = await useServerWithPrivateCache(
			'legacy-move-destination-wins'
		);
		const source = `t/${tenant}/narinfo/private/${cacheName}/${storePathHash}`;
		const destination = `t/${tenant}/narinfo/${cacheName}/${storePathHash}`;
		await clear(source, destination);
		await seed(source, legacyBody, narInfoMetadata(3));
		await seed(destination, currentBody, narInfoMetadata(3));
		await commitPath(3);

		await wake();

		expect({
			source: await objectAt(source),
			destination: await objectAt(destination)
		}).toStrictEqual({
			source: undefined,
			destination: { body: currentBody, generation: '3' }
		});
	});

	// A public cache may be called `private`, and its objects sit directly under
	// the same prefix. Moving one would put it where a cache of another name
	// reads.
	it('leaves a public cache named private where it is', async () => {
		await useTestServer('legacy-move-public-private');
		await bootstrap();
		const tenant = await configuredTenant();
		const key = `t/${tenant}/narinfo/private/${storePathHash}`;
		await clear(key);
		await seed(key, currentBody, narInfoMetadata(3));

		await wake();

		expect(await objectAt(key)).toStrictEqual({
			body: currentBody,
			generation: '3'
		});
	});

	it('moves an attestation list of the generation the path holds', async () => {
		const tenant = await useServerWithPrivateCache('legacy-move-attestations');
		const source = `t/${tenant}/attestations/private/${cacheName}/${storePathHash}`;
		const destination = `t/${tenant}/attestations/${cacheName}/${storePathHash}`;
		await clear(source, destination);
		await seed(source, legacyBody, listMetadata(3));
		await commitPath(3);

		await wake();

		expect({
			source: await listAt(source),
			destination: await listAt(destination)
		}).toStrictEqual({
			source: undefined,
			destination: { body: legacyBody, generation: '3' }
		});
	});

	// A list object records a generation and no NAR hash, so the generation
	// alone says whether the commit that produced it is the one the path holds.
	it('deletes an attestation list of a superseded generation', async () => {
		const tenant = await useServerWithPrivateCache('legacy-move-stale-list');
		const source = `t/${tenant}/attestations/private/${cacheName}/${storePathHash}`;
		const destination = `t/${tenant}/attestations/${cacheName}/${storePathHash}`;
		await clear(source, destination);
		await seed(source, legacyBody, listMetadata(3));
		await commitPath(7);

		await wake();

		expect({
			source: await listAt(source),
			destination: await listAt(destination)
		}).toStrictEqual({ source: undefined, destination: undefined });
	});

	// Only this server writes these keys, so one it cannot read back is a defect
	// in this build. Deleting is what the move does with an object no cache
	// claims, and a key it failed to understand must not reach that branch.
	it('refuses a key that does not name a store path', async () => {
		const tenant = await useServerWithPrivateCache('legacy-move-bad-key');
		const key = `t/${tenant}/narinfo/private/${cacheName}/not-a-store-path`;
		await clear(key);
		await seed(key, legacyBody, narInfoMetadata(3));

		await expect(wake()).rejects.toThrow(StoredObjectKeyInvalidError);

		await clear(key);
	});
});

/**
 * Brings up a server holding one public cache named `builds`, with its
 * identity row stamped at the second generation, and returns its tenant.
 *
 * Stamping the identity row is what a registration does after `cache_lifecycle`
 * returns the generation the deletion left. Everything the move reads comes
 * from that row.
 */
async function useServerWithAdvancedCache(name: string): Promise<string> {
	await useTestServer(name);
	await bootstrap({ caches: [{ scope: advancedCache }] });
	await runInDurableObject(currentServer(), (instance) => {
		instance.context.db
			.update(schema.cacheIdentities)
			.set({ generation: secondCacheGeneration })
			.where(
				eq(
					schema.cacheIdentities.id,
					resolvedCache(instance.context, advancedCache).id
				)
			)
			.run();
	});

	return configuredTenant();
}

describe('cache incarnation object move', () => {
	it('moves an object to the key its cache generation gives it', async () => {
		const tenant = await useServerWithAdvancedCache('incarnation-move');
		const source = `t/${tenant}/narinfo/${advancedName}/${storePathHash}`;
		const destination = `t/${tenant}/narinfo/generation/2/${advancedName}/${storePathHash}`;
		await clear(source, destination);
		await seed(source, legacyBody, narInfoMetadata(3));
		await commitPath(3, advancedCache);

		await wake();

		expect({
			source: await objectAt(source),
			destination: await objectAt(destination)
		}).toStrictEqual({
			source: undefined,
			destination: { body: legacyBody, generation: '3' }
		});
	});

	// No row in this cache claims the object, which is what an object of an
	// earlier incarnation of the name looks like once that incarnation's rows
	// have gone. Relocating it would put an object at a live key that no read can
	// serve and nothing collects.
	it('deletes an object no row in the cache claims', async () => {
		const tenant = await useServerWithAdvancedCache('incarnation-move-gone');
		const source = `t/${tenant}/narinfo/${advancedName}/${storePathHash}`;
		const destination = `t/${tenant}/narinfo/generation/2/${advancedName}/${storePathHash}`;
		await clear(source, destination);
		await seed(source, legacyBody, narInfoMetadata(3));

		await wake();

		expect({
			source: await objectAt(source),
			destination: await objectAt(destination)
		}).toStrictEqual({ source: undefined, destination: undefined });
	});
});
