import {
	type StorePathHash,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { runInDurableObject } from 'cloudflare:test';
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
});
