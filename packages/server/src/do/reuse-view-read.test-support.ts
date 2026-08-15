import {
	nixSha256HashSchema,
	storedCacheSchema,
	storePathHashSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { StatusCodes } from 'http-status-codes';
import { expect } from 'vitest';

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
