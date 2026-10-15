import { env } from 'cloudflare:workers';
import { and, eq, ne } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { SharedFactsUnavailableError } from '../errors.ts';

import * as schema from './d1-schema.ts';
import {
	sharedNarDiscoveryFixture,
	sharedNarSource
} from './shared-nar-discovery.test-support.ts';
import { SharedNarDiscovery } from './shared-nar-discovery.ts';

describe('shared NAR discovery', () => {
	it.each([undefined, sharedNarSource(0).narHash])(
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
		const { discovery, sources } = await sharedNarDiscoveryFixture(70);
		const first = await discovery.page();
		const second = await discovery.page(first.cursor);
		const last = await discovery.page(second.cursor);
		expect([first, second, last]).toStrictEqual([
			{
				sources: sources.slice(0, 32),
				cursor: sharedNarSource(31).narHash,
				isComplete: false
			},
			{
				sources: sources.slice(32, 64),
				cursor: sharedNarSource(63).narHash,
				isComplete: false
			},
			{
				sources: sources.slice(64),
				cursor: sharedNarSource(69).narHash,
				isComplete: true
			}
		]);
	});

	it('advances through bounded empty pages before a retained NAR', async () => {
		const { database, discovery } = await sharedNarDiscoveryFixture(65);
		await database
			.delete(schema.blobReference)
			.where(ne(schema.blobReference.narHash, sharedNarSource(64).narHash));
		const first = await discovery.page();
		const second = await discovery.page(first.cursor);
		const last = await discovery.page(second.cursor);
		expect([first, second, last]).toStrictEqual([
			{ sources: [], cursor: sharedNarSource(31).narHash, isComplete: false },
			{ sources: [], cursor: sharedNarSource(63).narHash, isComplete: false },
			{
				sources: [sharedNarSource(64)],
				cursor: sharedNarSource(64).narHash,
				isComplete: true
			}
		]);
	});

	it.each(['unregistered', 'pending', 'replaced', 'unreferenced'] as const)(
		'excludes a source that is %s without losing cursor progress',
		async (condition) => {
			const { database, discovery } = await sharedNarDiscoveryFixture();
			const identity = and(
				eq(schema.objectIncarnation.kind, 'nar'),
				eq(schema.objectIncarnation.objectId, sharedNarSource(0).narHash)
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
				cursor: sharedNarSource(0).narHash,
				isComplete: true
			});
		}
	);

	it('continues after the previous cursor source has been collected', async () => {
		const { database, discovery } = await sharedNarDiscoveryFixture(34);
		const first = await discovery.page();
		await database
			.delete(schema.blobState)
			.where(eq(schema.blobState.narHash, sharedNarSource(31).narHash));
		expect(await discovery.page(first.cursor)).toStrictEqual({
			sources: [sharedNarSource(32), sharedNarSource(33)],
			cursor: sharedNarSource(33).narHash,
			isComplete: true
		});
	});

	it('bounds sparse-page reads and uses the shared NAR and retention indexes', async () => {
		const { database } = await sharedNarDiscoveryFixture(128);
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
		const page = await discovery.page(sharedNarSource(31).narHash);
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
			page: {
				sources: [],
				cursor: sharedNarSource(63).narHash,
				isComplete: false
			},
			queries: 1,
			boundedReads: true,
			indexedCursor: true,
			indexedRetention: true
		});
	});

	it('reports storage failure as unavailable shared facts', async () => {
		const { discovery } = await sharedNarDiscoveryFixture();
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
