// Each case uses a list longer than the parameter limit, so a statement that
// runs here is one whose parameter count does not follow the list. The binding
// refuses a statement that binds one parameter per value.
import {
	cacheNameSchema,
	nixSha256HashSchema,
	type NixSha256HashString,
	privateStoredCache,
	type StorePathHash,
	storePathHashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { currentServer, initialise, resetTestServer } from '../test-support.ts';

import { maxBoundParameters } from './bulk.ts';
import { jsonRowLists, jsonValueLists } from './json-list.ts';

const listLength = maxBoundParameters + 50;
const cache = privateStoredCache(cacheNameSchema.parse('builds'));
const tenant = tenantIdSchema.parse('fixture-tenant');
const nixBase32 = '0123456789abcdfghijklmnpqrsvwxyz';

function suffix(index: number): string {
	return (
		nixBase32.charAt(Math.floor(index / nixBase32.length)) +
		nixBase32.charAt(index % nixBase32.length)
	);
}

function syntheticStorePathHash(index: number): StorePathHash {
	return storePathHashSchema.parse(`${'0'.repeat(30)}${suffix(index)}`);
}

function syntheticNarHash(index: number): NixSha256HashString {
	return nixSha256HashSchema.parse(`sha256:${'0'.repeat(50)}${suffix(index)}`);
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : Number(left > right);
}

/**
The one list that these values produce, since they stay well within a bound
string.
*/
function onlyList<T>(lists: readonly T[]): T {
	const [list, ...rest] = lists;

	if (list === undefined || rest.length > 0) {
		throw new Error(`expected one list and received ${String(lists.length)}`);
	}

	return list;
}

const storePathHashes = Array.from({ length: listLength }, (_, index) =>
	syntheticStorePathHash(index)
);
const narHashes = Array.from({ length: listLength }, (_, index) =>
	syntheticNarHash(index)
);

describe('a list bound as one JSON parameter', () => {
	beforeEach(resetTestServer);

	it('inserts and reads back a list on Durable Object SQLite', async () => {
		await initialise();
		const server = currentServer();

		const read = await runInDurableObject(server, (instance) => {
			const inserted = onlyList(jsonValueLists(storePathHashes));

			instance.context.db
				.insert(schema.garbageCollectionFrontier)
				.select(inserted.insertSource([sql`${cache}`, inserted.element()]))
				.run();

			const selected = onlyList(jsonValueLists(storePathHashes));

			return instance.context.db
				.select({
					storePathHash: schema.garbageCollectionFrontier.storePathHash
				})
				.from(schema.garbageCollectionFrontier)
				.where(
					and(
						eq(schema.garbageCollectionFrontier.cache, cache),
						inArray(schema.garbageCollectionFrontier.storePathHash, selected)
					)
				)
				.all();
		});

		expect(
			read.map((row) => row.storePathHash).toSorted(compareText)
		).toStrictEqual([...storePathHashes].toSorted(compareText));
	});

	it('matches rows on several columns at once on Durable Object SQLite', async () => {
		await initialise();
		const server = currentServer();

		const matched = await runInDurableObject(server, (instance) => {
			const inserted = onlyList(jsonValueLists(storePathHashes));

			instance.context.db
				.insert(schema.garbageCollectionFrontier)
				.select(inserted.insertSource([sql`${cache}`, inserted.element()]))
				.run();

			const pairs = onlyList(
				jsonRowLists(
					storePathHashes.map((storePathHash) => ({ cache, storePathHash }))
				)
			);

			return instance.context.db
				.select({
					storePathHash: schema.garbageCollectionFrontier.storePathHash
				})
				.from(schema.garbageCollectionFrontier)
				.where(
					pairs.matches({
						cache: schema.garbageCollectionFrontier.cache,
						storePathHash: schema.garbageCollectionFrontier.storePathHash
					})
				)
				.all();
		});

		expect(matched).toHaveLength(listLength);
	});

	it('inserts and reads back a list on D1', async () => {
		const database = drizzle(env.CUPBOARD_DB, { schema: d1Schema });
		const inserted = onlyList(
			jsonRowLists(narHashes.map((narHash) => ({ narHash, fileSize: 1 })))
		);

		await database
			.insert(d1Schema.tenantBlob)
			.select(
				inserted.insertSource([
					sql`${tenant}`,
					inserted.column('narHash'),
					inserted.column('fileSize')
				])
			)
			.run();

		const selected = onlyList(jsonValueLists(narHashes));
		const rows = await database
			.select({ narHash: d1Schema.tenantBlob.narHash })
			.from(d1Schema.tenantBlob)
			.where(
				and(
					eq(d1Schema.tenantBlob.tenant, tenant),
					inArray(d1Schema.tenantBlob.narHash, selected)
				)
			)
			.all();

		expect(rows.map((row) => row.narHash).toSorted(compareText)).toStrictEqual(
			[...narHashes].toSorted(compareText)
		);
	});
});
