import {
	cacheGenerationSchema,
	narInfoGenerationSchema,
	nixSha256HashSchema,
	storePathHashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { and, eq, ne } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { SharedFactsUnavailableError } from '../errors.ts';

import * as schema from './d1-schema.ts';
import {
	SharedNarDiscovery,
	type SharedNarSource
} from './shared-nar-discovery.ts';

const now = isoTimestamp(new Date('2026-01-01T00:00:00.000Z'));
const tenants = ['discovery-first', 'discovery-second'].map((id) =>
	tenantIdSchema.parse(id)
);

function source(index: number): SharedNarSource {
	return {
		narHash: nixSha256HashSchema.parse(
			`sha256:${String(index).padStart(52, '0')}`
		),
		sourceIncarnation: 2,
		narSize: 200,
		fileSize: 100
	};
}

async function fixture(count = 1) {
	const database = drizzle(env.CUPBOARD_DB, { schema });
	await database.insert(schema.tenant).values(
		tenants.map((id) => ({
			id,
			status: 'active' as const,
			ownerIssuer: 'https://issuer.example',
			ownerSubject: 'subject',
			ownerAudience: 'cupboard',
			configVersion: 1,
			createdAt: now
		}))
	);
	const sources = Array.from({ length: count }, (_, index) => source(index));
	for (const [index, item] of sources.entries()) {
		await database.batch([
			database.insert(schema.blobState).values({
				narHash: item.narHash,
				fileHash: item.narHash,
				fileSize: item.fileSize,
				narSize: item.narSize,
				compression: 'zstd',
				incarnation: item.sourceIncarnation,
				verifiedAt: now
			}),
			database.insert(schema.objectIncarnation).values({
				kind: 'nar',
				objectId: item.narHash,
				incarnation: item.sourceIncarnation,
				state: 'live',
				updatedAt: now
			}),
			database.insert(schema.blobReference).values(
				tenants.map((tenant) => ({
					tenant,
					cacheKind: 'default' as const,
					cacheGeneration: cacheGenerationSchema.parse(1),
					storePathHash: storePathHashSchema.parse(
						String(index).padStart(32, '0')
					),
					generation: narInfoGenerationSchema.parse(1),
					narHash: item.narHash
				}))
			)
		]);
	}
	return { database, sources, discovery: new SharedNarDiscovery(database) };
}

describe('shared NAR discovery', () => {
	it.each([undefined, source(0).narHash])(
		'completes an empty scan after %s',
		async (cursor) => {
			const discovery = new SharedNarDiscovery(
				drizzle(env.CUPBOARD_DB, { schema })
			);
			expect(await discovery.page(cursor)).toStrictEqual({
				sources: [],
				cursor,
				isComplete: true
			});
		}
	);

	it('pages each shared NAR once across multiple tenant references', async () => {
		const { discovery, sources } = await fixture(70);
		const first = await discovery.page();
		const second = await discovery.page(first.cursor);
		const last = await discovery.page(second.cursor);
		expect([first, second, last]).toStrictEqual([
			{
				sources: sources.slice(0, 32),
				cursor: source(31).narHash,
				isComplete: false
			},
			{
				sources: sources.slice(32, 64),
				cursor: source(63).narHash,
				isComplete: false
			},
			{
				sources: sources.slice(64),
				cursor: source(69).narHash,
				isComplete: true
			}
		]);
	});

	it('advances through bounded empty pages before a retained NAR', async () => {
		const { database, discovery } = await fixture(65);
		await database
			.delete(schema.blobReference)
			.where(ne(schema.blobReference.narHash, source(64).narHash));
		const first = await discovery.page();
		const second = await discovery.page(first.cursor);
		const last = await discovery.page(second.cursor);
		expect([first, second, last]).toStrictEqual([
			{ sources: [], cursor: source(31).narHash, isComplete: false },
			{ sources: [], cursor: source(63).narHash, isComplete: false },
			{ sources: [source(64)], cursor: source(64).narHash, isComplete: true }
		]);
	});

	it.each(['unregistered', 'pending', 'replaced', 'unreferenced'] as const)(
		'excludes a source that is %s without losing cursor progress',
		async (condition) => {
			const { database, discovery } = await fixture();
			const identity = and(
				eq(schema.objectIncarnation.kind, 'nar'),
				eq(schema.objectIncarnation.objectId, source(0).narHash)
			);
			switch (condition) {
				case 'unregistered': {
					await database.delete(schema.objectIncarnation).where(identity);
					break;
				}
				case 'pending': {
					await database
						.update(schema.objectIncarnation)
						.set({ state: 'pending' })
						.where(identity);
					break;
				}
				case 'replaced': {
					await database
						.update(schema.objectIncarnation)
						.set({ incarnation: 3 })
						.where(identity);
					break;
				}
				case 'unreferenced': {
					await database.delete(schema.blobReference);
					break;
				}
			}
			expect(await discovery.page()).toStrictEqual({
				sources: [],
				cursor: source(0).narHash,
				isComplete: true
			});
		}
	);

	it('continues after the previous cursor source has been collected', async () => {
		const { database, discovery } = await fixture(34);
		const first = await discovery.page();
		await database
			.delete(schema.blobState)
			.where(eq(schema.blobState.narHash, source(31).narHash));
		expect(await discovery.page(first.cursor)).toStrictEqual({
			sources: [source(32), source(33)],
			cursor: source(33).narHash,
			isComplete: true
		});
	});

	it('bounds sparse-page reads and uses the shared NAR and retention indexes', async () => {
		const { database } = await fixture(128);
		await database.delete(schema.blobReference);
		const statements: { query: string; parameters: unknown[] }[] = [];
		const discovery = new SharedNarDiscovery(
			drizzle(env.CUPBOARD_DB, {
				schema,
				logger: {
					logQuery(query, parameters) {
						statements.push({ query, parameters });
					}
				}
			})
		);
		const page = await discovery.page(source(31).narHash);
		const statement = statements[0];
		if (statement === undefined) {
			throw new Error('The shared discovery query was not recorded');
		}
		const parameters = z
			.array(z.union([z.string(), z.number()]))
			.parse(statement.parameters);
		const measured = await env.CUPBOARD_DB.prepare(statement.query)
			.bind(...parameters)
			.all();
		const plan = await env.CUPBOARD_DB.prepare(
			`EXPLAIN QUERY PLAN ${statement.query}`
		)
			.bind(...parameters)
			.all<{ detail: string }>();
		expect({
			page,
			queries: statements.length,
			boundedReads: measured.meta.rows_read <= 132,
			indexedCursor: plan.results.some(({ detail }) =>
				detail.includes(
					'SEARCH blob_state USING INDEX sqlite_autoindex_blob_state_1 (nar_hash>?)'
				)
			),
			indexedRetention: plan.results.some(({ detail }) =>
				detail.includes('blob_ref_nar_hash_idx (nar_hash=?)')
			)
		}).toStrictEqual({
			page: { sources: [], cursor: source(63).narHash, isComplete: false },
			queries: 1,
			boundedReads: true,
			indexedCursor: true,
			indexedRetention: true
		});
	});

	it('reports storage failure as unavailable shared facts', async () => {
		const { discovery } = await fixture();
		const prepare = vi
			.spyOn(env.CUPBOARD_DB, 'prepare')
			.mockImplementation(() => {
				throw new Error('D1 unavailable');
			});
		try {
			await expect(discovery.page()).rejects.toBeInstanceOf(
				SharedFactsUnavailableError
			);
		} finally {
			prepare.mockRestore();
		}
	});
});
