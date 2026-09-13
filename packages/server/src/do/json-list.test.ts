import {
	type StorePathHash,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { describe, expect, it } from 'vitest';

import { cacheIdSchema } from '../db/cache.ts';
import * as schema from '../db/schema.ts';
import { BoundValueLengthError } from '../errors.ts';

import { jsonRowLists, jsonValueLists } from './json-list.ts';

const throwStub = (): never => {
	throw new Error('storage stub: not executed');
};

const database = drizzle({ exec: throwStub } as never, { schema });
const cache = cacheIdSchema.parse(1);
const nixBase32 = '0123456789abcdfghijklmnpqrsvwxyz';

function nixBase32Hash(index: number): string {
	let remaining = index;
	let hash = '';

	for (let position = 0; position < 32; position += 1) {
		hash = nixBase32.charAt(remaining % nixBase32.length) + hash;
		remaining = Math.floor(remaining / nixBase32.length);
	}

	return hash;
}

function storePathHashes(count: number): StorePathHash[] {
	return Array.from({ length: count }, (_, index) =>
		storePathHashSchema.parse(nixBase32Hash(index))
	);
}

/**
The one list that a short set of values produces, which every case here uses.
*/
function onlyList<T>(lists: readonly T[]): T {
	const [list, ...rest] = lists;

	if (list === undefined || rest.length > 0) {
		throw new Error(`expected one list and received ${String(lists.length)}`);
	}

	return list;
}

function selectByHashes(count: number) {
	const list = onlyList(jsonValueLists(storePathHashes(count)));

	return database
		.select({ storePathHash: schema.narInfos.storePathHash })
		.from(schema.narInfos)
		.where(
			and(
				eq(schema.narInfos.cacheId, cache),
				inArray(schema.narInfos.storePathHash, list)
			)
		)
		.toSQL();
}

describe('a list bound as one JSON parameter', () => {
	it('expands the list in SQL rather than binding its values', () => {
		const { sql: text, params } = selectByHashes(3);

		expect(text).toContain(
			'"narinfo"."store_path_hash" in (select value from json_each(?))'
		);
		expect(params).toStrictEqual([cache, JSON.stringify(storePathHashes(3))]);
	});

	it('binds the same number of parameters for a long list as for a short one', () => {
		expect(selectByHashes(10_000).params).toHaveLength(
			selectByHashes(1).params.length
		);
	});

	it('compares several columns against one parameter', () => {
		const list = onlyList(
			jsonRowLists(
				storePathHashes(2).map((storePathHash) => ({
					storePathHash,
					generation: 1
				}))
			)
		);
		const { sql: text, params } = database
			.select({ storePathHash: schema.narInfos.storePathHash })
			.from(schema.narInfos)
			.where(
				list.matches({
					storePathHash: schema.narInfos.storePathHash,
					generation: schema.narInfos.generation
				})
			)
			.toSQL();

		expect(text).toContain(
			'("narinfo"."store_path_hash", "narinfo"."generation") in (select json_extract(value, ?), json_extract(value, ?) from json_each(?))'
		);
		expect(params).toStrictEqual([
			'$.storePathHash',
			'$.generation',
			JSON.stringify(list.rows)
		]);
	});

	it('selects the inserted rows from the list and keeps its own where clause', () => {
		const list = onlyList(jsonValueLists(storePathHashes(2)));
		const { sql: text } = database
			.insert(schema.garbageCollectionFrontier)
			.select(list.insertSource([sql`${cache}`, list.element()]))
			.onConflictDoNothing()
			.toSQL();

		expect(text).toContain(
			'select ?, value from json_each(?) where true on conflict do nothing'
		);
	});

	it('splits a list whose values serialise beyond a bound string', () => {
		// Each value serialises to 35 bytes, so 100,000 of them exceed the
		// 2,000,000 a bound string carries and the list is split.
		const values = Array.from({ length: 100_000 }, (_, index) =>
			nixBase32Hash(index)
		);
		const lists = jsonValueLists(values);

		expect(lists.map((list) => list.values.length)).toStrictEqual([
			50_000, 50_000
		]);
		expect(lists.flatMap((list) => [...list.values])).toStrictEqual(values);
	});

	it('refuses one value that no split can make fit', () => {
		expect(() => jsonValueLists(['x'.repeat(2_000_001)])).toThrow(
			BoundValueLengthError
		);
	});

	it('produces no list for no values', () => {
		expect(jsonValueLists([])).toStrictEqual([]);
	});
});
