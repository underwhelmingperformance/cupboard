import {
	type StorePathHash,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { inArray } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema.ts';
import { causedBy, StatementParameterLimitError } from '../errors.ts';
import { currentServer, initialise, resetTestServer } from '../test-support.ts';

import { maxBoundParameters } from './bulk.ts';

const nixBase32 = '0123456789abcdfghijklmnpqrsvwxyz';

function syntheticStorePathHash(index: number): StorePathHash {
	const suffix =
		nixBase32.charAt(Math.floor(index / nixBase32.length)) +
		nixBase32.charAt(index % nixBase32.length);

	return storePathHashSchema.parse(`${'0'.repeat(30)}${suffix}`);
}

type RawOutcome = number | 'no row' | 'refused' | 'threw a non-error';

// A statement that binds one value per row and counts the rows, so the count
// it returns is the number of parameters it bound.
function countingStatement(parameters: number): {
	readonly query: string;
	readonly values: number[];
} {
	const values = Array.from({ length: parameters }, (_, index) => index);

	return {
		query: `SELECT count(*) AS n FROM (VALUES ${values.map(() => '(?)').join(', ')})`,
		values
	};
}

function rawStorageCount(sql: SqlStorage, parameters: number): RawOutcome {
	const { query, values } = countingStatement(parameters);

	try {
		const [row] = sql.exec<{ n: number }>(query, ...values).toArray();

		return row === undefined ? 'no row' : row.n;
	} catch (error) {
		return error instanceof Error ? 'refused' : 'threw a non-error';
	}
}

async function rawD1Count(parameters: number): Promise<RawOutcome> {
	const { query, values } = countingStatement(parameters);

	try {
		const { results } = await env.CUPBOARD_DB.prepare(query)
			.bind(...values)
			.all<{ n: number }>();

		const [row] = results;

		return row === undefined ? 'no row' : row.n;
	} catch (error) {
		return error instanceof Error ? 'refused' : 'threw a non-error';
	}
}

describe('Durable Object storage binding', () => {
	beforeEach(resetTestServer);

	it('refuses a statement that binds more parameters than the platform accepts', async () => {
		await initialise();
		const server = currentServer();

		const hashes = Array.from({ length: maxBoundParameters + 1 }, (_, index) =>
			syntheticStorePathHash(index)
		);

		const refused = await runInDurableObject(server, (instance) => {
			try {
				instance.context.db
					.select({ storePathHash: schema.narInfos.storePathHash })
					.from(schema.narInfos)
					.where(inArray(schema.narInfos.storePathHash, hashes))
					.all();

				return;
			} catch (error) {
				const refusal = causedBy(error, StatementParameterLimitError);

				return refusal === undefined
					? error
					: { parameters: refusal.parameters, limit: refusal.limit };
			}
		});

		expect(refused).toStrictEqual({
			parameters: maxBoundParameters + 1,
			limit: maxBoundParameters
		});
	});

	// The wrapper's limit is only worth enforcing while it matches the runtime's.
	// Bypass both wrappers and check that the runtime accepts 100 parameters and
	// refuses 101, so a toolchain that stops enforcing the limit fails here.
	it('agrees with the limit the local runtime enforces on both bindings', async () => {
		await initialise();
		const server = currentServer();

		const storage = await runInDurableObject(server, (_instance, state) => ({
			atLimit: rawStorageCount(state.storage.sql, maxBoundParameters),
			overLimit: rawStorageCount(state.storage.sql, maxBoundParameters + 1)
		}));
		const d1 = {
			atLimit: await rawD1Count(maxBoundParameters),
			overLimit: await rawD1Count(maxBoundParameters + 1)
		};

		expect({ storage, d1 }).toStrictEqual({
			storage: { atLimit: maxBoundParameters, overLimit: 'refused' },
			d1: { atLimit: maxBoundParameters, overLimit: 'refused' }
		});
	});
});
