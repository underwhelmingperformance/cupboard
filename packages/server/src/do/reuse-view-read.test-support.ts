import {
	narInfoGenerationSchema,
	nixSha256HashSchema,
	storedCacheSchema,
	storePathHashSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { expect } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	authorisedWorkerFetch,
	fixtureWorkerServer,
	initialiseViaWorker,
	pushPathToTenant,
	verifiablePath
} from '../test-support.ts';

export interface ReuseSelector {
	readonly kind: 'exact' | 'prefix';
	readonly pattern: string;
}

/**
Defines or replaces the fixture tenant's `reuse` view through the admin API.
*/
export async function setView(
	selectors: readonly ReuseSelector[]
): Promise<void> {
	const token = await initialiseViaWorker();
	const response = await authorisedWorkerFetch('/reuse-views/reuse', token, {
		body: JSON.stringify({ selectors }),
		headers: { 'content-type': 'application/json' },
		method: 'PUT'
	});

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
	cache: string,
	fields: { readonly storePathHash?: string; readonly name?: string } = {}
): Promise<{
	storePathHash: string;
	storePath: string;
	narHash: string;
}> {
	const token = await initialiseViaWorker();
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
	cache: string,
	storePathHash: string,
	narHash: string
): Promise<void> {
	await runInDurableObject(fixtureWorkerServer(), (instance) => {
		instance.context.db
			.insert(schema.narInfos)
			.values({
				cache: storedCacheSchema.parse(cache),
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
	cache: string,
	storePathHash: string,
	committedStorePathHash: string
): Promise<void> {
	const targetCache = storedCacheSchema.parse(cache);
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
		instance.context.db
			.insert(schema.narInfos)
			.values({
				...source,
				cache: targetCache,
				storePathHash: targetHash,
				storePath: storePathSchema.parse(
					`/nix/store/${storePathHash}-published`
				),
				generation
			})
			.run();
	});

	await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
		.insert(d1Schema.blobReference)
		.values({
			tenant: fixtureTenant,
			cache: targetCache,
			storePathHash: targetHash,
			generation,
			narHash: source.narHash
		})
		.run();
}
