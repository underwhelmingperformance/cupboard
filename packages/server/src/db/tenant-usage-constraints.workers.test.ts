import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { describe, expect, it } from 'vitest';

import * as d1Schema from './d1-schema.ts';

const updatedAt = '2026-01-01T00:00:00.000Z';

describe('tenant_usage non-negative constraints', () => {
	it.each([
		{ name: 'bytes', values: { tenant: 'neg-bytes', bytes: -1, updatedAt } },
		{
			name: 'narinfos',
			values: { tenant: 'neg-narinfos', narinfos: -1, updatedAt }
		},
		{ name: 'blobs', values: { tenant: 'neg-blobs', blobs: -1, updatedAt } },
		{
			name: 'cas_bytes',
			values: { tenant: 'neg-cas-bytes', casBytes: -1, updatedAt }
		},
		{
			name: 'cas_blobs',
			values: { tenant: 'neg-cas-blobs', casBlobs: -1, updatedAt }
		}
	])('rejects a negative $name count, writing no row', async ({ values }) => {
		const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });

		const error = await database
			.insert(d1Schema.tenantUsage)
			.values(values)
			.run()
			.then(
				() => 'inserted',
				(error: unknown) => error
			);

		const rows = await database
			.select()
			.from(d1Schema.tenantUsage)
			.where(eq(d1Schema.tenantUsage.tenant, values.tenant))
			.all();

		expect({
			rejected: error instanceof Error,
			rows
		}).toStrictEqual({
			rejected: true,
			rows: []
		});
	});
});
