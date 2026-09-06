import {
	type CacheAccessMode,
	cacheGenerationSchema,
	type CacheScope,
	narInfoGenerationSchema,
	nixSha256HashSchema,
	storePathHashSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { type ReuseViewSelectorInput } from '@cupboard/protocol/reuse-views';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { expect } from 'vitest';

import * as schema from '../db/schema.ts';
import { cacheMigrationColumns } from '../migration/cache-access.ts';
import * as migrationSchema from '../migration/cache-access-schema.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	authorisedWorkerFetch,
	fixtureWorkerServer,
	initialiseViaWorker,
	pushPathToTenant,
	putWorkerTestCache,
	verifiablePath
} from '../test-support.ts';

/**
 * Defines or replaces one of the fixture tenant's views through the admin API.
 */
export async function setView(
	selectors: readonly ReuseViewSelectorInput[],
	name = 'reuse',
	access: CacheAccessMode = 'public'
): Promise<void> {
	const token = await initialiseViaWorker();
	const response = await authorisedWorkerFetch(
		`/reuse-views/${encodeURIComponent(name)}`,
		token,
		{
			body: JSON.stringify({ access, selectors }),
			headers: { 'content-type': 'application/json' },
			method: 'PUT'
		}
	);

	expect(response.status).toBe(StatusCodes.OK);
}

/**
The tenant-relative read path of a reuse-view narinfo lookup.
*/
export function lookupPath(storePathHash: string, view = 'reuse'): string {
	return `/reuse/${view}/${storePathHash}.narinfo`;
}

/**
 * Commits a verifiable path into a named cache of the fixture tenant through
 * the Worker, so the row lands in the Durable Object the read path serves
 * from.
 */
export async function committedPath(
	seed: string,
	cache: CacheScope,
	fields: {
		readonly storePathHash?: string;
		readonly name?: string;
		readonly access?: CacheAccessMode;
	} = {}
): Promise<{
	storePathHash: string;
	storePath: string;
	narHash: string;
}> {
	const token = await initialiseViaWorker();
	await putWorkerTestCache(token, cache, fields.access ?? 'public');

	const { metadata, nar } = await verifiablePath(seed, fields);
	await pushPathToTenant(fixtureTenant, token, metadata, nar, cache);

	return {
		storePathHash: metadata.storePathHash,
		storePath: metadata.storePath,
		narHash: metadata.narHash
	};
}

/**
 * Inserts a narinfo row with no committed D1 edge behind it, indistinguishable
 * in the local table from a generation an in-flight commit has reserved.
 */
export async function insertUnbackedRow(
	cache: CacheScope,
	storePathHash: string,
	narHash: string
): Promise<void> {
	await putWorkerTestCache(await initialiseViaWorker(), cache, 'public');

	await runInDurableObject(fixtureWorkerServer(), (instance) => {
		const resolved = instance.context.cacheRepository.require(cache);

		instance.context.db
			.insert(schema.narInfos)
			.values({
				cacheId: resolved.id,
				storePathHash: storePathHashSchema.parse(storePathHash),
				storePath: storePathSchema.parse(`/nix/store/${storePathHash}-first`),
				narHash: nixSha256HashSchema.parse(narHash),
				narSize: 10,
				referencesJson: '[]',
				sigsJson: '[]',
				createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z')
			})
			.run();
	});
}

/**
 * Inserts a narinfo row for `storePathHash` in `cache` and a matching D1 blob
 * reference. Both records refer to the NAR for `committedStorePathHash`, so
 * lookup tests can distinguish selector filtering from missing backing data.
 */
export async function insertBackedRow(
	cache: CacheScope,
	storePathHash: string,
	committedStorePathHash: string,
	access: CacheAccessMode = 'public'
): Promise<void> {
	await putWorkerTestCache(await initialiseViaWorker(), cache, access);

	const targetHash = storePathHashSchema.parse(storePathHash);
	const generation = narInfoGenerationSchema.parse(1);
	const source = await runInDurableObject(fixtureWorkerServer(), (instance) =>
		instance.context.db
			.select()
			.from(schema.narInfos)
			.where(
				eq(
					schema.narInfos.storePathHash,
					storePathHashSchema.parse(committedStorePathHash)
				)
			)
			.get()
	);

	if (source === undefined) {
		throw new Error('the committed path has no narinfo row to copy');
	}

	await runInDurableObject(fixtureWorkerServer(), (instance) => {
		const targetCache = instance.context.cacheRepository.resolveOrCreate(
			cache,
			access
		);

		instance.context.db
			.insert(schema.narInfos)
			.values({
				...source,
				cacheId: targetCache.id,
				storePathHash: targetHash,
				storePath: storePathSchema.parse(
					`/nix/store/${storePathHash}-published`
				),
				generation
			})
			.run();
	});

	await drizzleD1(env.CUPBOARD_DB, { schema: migrationSchema })
		.insert(migrationSchema.blobReferences)
		.values({
			tenant: fixtureTenant,
			...cacheMigrationColumns(cache, access),
			storePathHash: targetHash,
			generation,
			narHash: source.narHash,
			cacheGeneration: cacheGenerationSchema.parse(1)
		})
		.run();
}
