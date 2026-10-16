import {
	cacheGenerationSchema,
	cacheNameSchema,
	narInfoGenerationSchema,
	sha256HexDigestSchema,
	storePathHashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { listingGeneratorRevisionSchema } from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { asc, eq, inArray, lte } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { type ListingAdoptionCaptureSource } from '../blob/listing-adoption-capture.ts';
import {
	listingAdoptionCapturedWorkSchema,
	listingAdoptionConsumerEpochSchema
} from '../blob/listing-adoption-work.ts';
import { boundedD1 } from '../do/bounded-io.ts';
import { jsonValueList } from '../do/json-list.ts';
import { withSubrequestSlice } from '../do/subrequest-slice.ts';
import { SharedFactsUnavailableError } from '../errors.ts';

import * as schema from './d1-schema.ts';
import {
	type ListingAdoptionConsumeResult,
	ListingAdoptionConsumerStore,
	type ListingAdoptionPruneResult
} from './listing-adoption-consumer.ts';
import { sharedNarSource } from './shared-nar-discovery.test-support.ts';

const now = isoTimestamp(new Date('2026-01-01T00:00:00.000Z'));
function source(index: number): ListingAdoptionCaptureSource {
	return {
		kind: 'listing',
		identity: {
			narHash: sharedNarSource(index).narHash,
			generatorRevision: listingGeneratorRevisionSchema.parse('history')
		}
	};
}
async function fixture(count = 65) {
	const database = drizzle(env.CUPBOARD_DB, { schema });
	await database.insert(schema.deploymentTransition).values([
		{ id: 'listing-adoption-capture', state: 'complete', updatedAt: now },
		{ id: 'listing-adoption-work', state: 'complete', updatedAt: now }
	]);
	if (count > 0) {
		await env.CUPBOARD_DB.prepare(
			"WITH RECURSIVE numbered(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM numbered WHERE value<?) INSERT INTO listing_adoption_capture_event (source) SELECT json_object('kind','listing','identity',json_object('narHash','sha256:'||printf('%052d',value),'generatorRevision','history')) FROM numbered"
		)
			.bind(count)
			.run();
	}
	const rows = await database
		.select()
		.from(schema.listingAdoptionCaptureEvent)
		.orderBy(asc(schema.listingAdoptionCaptureEvent.id));
	return { database, rows, store: new ListingAdoptionConsumerStore(database) };
}
async function pauseReadiness(
	database: Awaited<ReturnType<typeof fixture>>['database'],
	phase: 'capture' | 'storage'
) {
	if (phase === 'capture') {
		await database
			.update(schema.listingAdoptionCaptureState)
			.set({ isReady: false });
		return;
	}
	await database
		.update(schema.deploymentTransition)
		.set({ state: 'expanded' })
		.where(eq(schema.deploymentTransition.id, 'listing-adoption-work'));
}

async function progress(
	database: Awaited<ReturnType<typeof fixture>>['database']
) {
	return database
		.select({
			after: schema.listingAdoptionConsumer.after,
			scanned: schema.listingAdoptionConsumer.scanned,
			enrolled: schema.listingAdoptionConsumer.enrolled
		})
		.from(schema.listingAdoptionConsumer);
}
async function work(database: Awaited<ReturnType<typeof fixture>>['database']) {
	const rows = await database
		.select()
		.from(schema.listingAdoptionWork)
		.orderBy(asc(schema.listingAdoptionWork.eventId));
	return rows.map((row) => listingAdoptionCapturedWorkSchema.parse(row));
}

describe('listing adoption capture consumer', () => {
	it('fences overlapping selected pages without duplicate work or counters', async () => {
		const { database, rows, store } = await fixture();
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const delayed = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (queries) => {
				await new ListingAdoptionConsumerStore(database).advance();
				return original(queries);
			});
		let result: ListingAdoptionConsumeResult;
		try {
			result = await store.advance();
		} finally {
			delayed.mockRestore();
		}
		const stored = await work(database);
		expect({
			result,
			progress: await progress(database),
			ids: stored.map((row) => row.eventId)
		}).toStrictEqual({
			result: { kind: 'stale' },
			progress: [{ after: rows[31]?.id, scanned: 32, enrolled: 32 }],
			ids: rows.slice(0, 32).map((row) => row.id)
		});
	});
	it('refuses an old selected page after the checkpoint epoch is replaced', async () => {
		const { database, store } = await fixture(1);
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const epoch = listingAdoptionConsumerEpochSchema.parse('b'.repeat(32));
		const delayed = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (queries) => {
				await database.update(schema.listingAdoptionConsumer).set({ epoch });
				return original(queries);
			});
		let result: ListingAdoptionConsumeResult;
		try {
			result = await store.advance();
		} finally {
			delayed.mockRestore();
		}
		expect({
			result,
			progress: await progress(database),
			work: await work(database)
		}).toStrictEqual({
			result: { kind: 'stale' },
			progress: [{ after: 0, scanned: 0, enrolled: 0 }],
			work: []
		});
	});
	it('defers late captures to the next fixed page boundary', async () => {
		const { database, rows, store } = await fixture(1);
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const delayed = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (queries) => {
				await database
					.insert(schema.listingAdoptionCaptureEvent)
					.values({ source: source(2) });
				return original(queries);
			});
		let result: ListingAdoptionConsumeResult;
		try {
			result = await store.advance();
		} finally {
			delayed.mockRestore();
		}
		const first = await work(database);
		await store.advance();
		const second = await work(database);
		expect({
			result,
			first: first.map((row) => row.source),
			second: second.map((row) => row.source)
		}).toStrictEqual({
			result: {
				kind: 'advanced',
				scanned: 1,
				enrolled: 1,
				after: rows[0]?.id,
				hasMore: false
			},
			first: [source(1)],
			second: [source(1), source(2)]
		});
	});
	it('checkpoints sparse and deleted capture identities without counting gaps', async () => {
		const { database, rows, store } = await fixture(65);
		const removed = rows.slice(1, 40).map((row) => row.id);
		await database
			.delete(schema.listingAdoptionCaptureEvent)
			.where(
				inArray(schema.listingAdoptionCaptureEvent.id, jsonValueList(removed))
			);
		const result = await store.advance();
		const stored = await work(database);
		expect({
			result,
			progress: await progress(database),
			ids: stored.map((row) => row.eventId)
		}).toStrictEqual({
			result: {
				kind: 'advanced',
				scanned: 26,
				enrolled: 26,
				after: rows[64]?.id,
				hasMore: false
			},
			progress: [{ after: rows[64]?.id, scanned: 26, enrolled: 26 }],
			ids: [rows[0]?.id, ...rows.slice(40).map((row) => row.id)]
		});
	});
	it('counts only current events when a selected source disappears before copying', async () => {
		const { database, rows, store } = await fixture(1);
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const delayed = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (queries) => {
				await database.delete(schema.listingAdoptionCaptureEvent);
				return original(queries);
			});
		let result: ListingAdoptionConsumeResult;
		try {
			result = await store.advance();
		} finally {
			delayed.mockRestore();
		}
		expect({
			result,
			progress: await progress(database),
			work: await work(database)
		}).toStrictEqual({
			result: {
				kind: 'advanced',
				scanned: 1,
				enrolled: 0,
				after: rows[0]?.id,
				hasMore: false
			},
			progress: [{ after: rows[0]?.id, scanned: 1, enrolled: 0 }],
			work: []
		});
	});
	it('passes an empty retained interval through its captured upper boundary', async () => {
		const { database, rows, store } = await fixture(65);
		await database.delete(schema.listingAdoptionCaptureEvent);
		expect({
			result: await store.advance(),
			progress: await progress(database),
			work: await work(database)
		}).toStrictEqual({
			result: {
				kind: 'advanced',
				scanned: 0,
				enrolled: 0,
				after: rows[64]?.id,
				hasMore: false
			},
			progress: [{ after: rows[64]?.id, scanned: 0, enrolled: 0 }],
			work: []
		});
	});
	it.each([
		{ id: 'listing-adoption-work', table: 'listing_adoption_consumer' },
		{ id: 'listing-adoption-capture', table: 'listing_adoption_capture_state' }
	] as const)(
		'waits for $id before preparing its storage',
		async (transition) => {
			const { database, store } = await fixture(1);
			await database
				.update(schema.deploymentTransition)
				.set({ state: 'expanded' })
				.where(eq(schema.deploymentTransition.id, transition.id));
			const original = env.CUPBOARD_DB.prepare.bind(env.CUPBOARD_DB);
			const prepare = vi
				.spyOn(env.CUPBOARD_DB, 'prepare')
				.mockImplementation((query) => {
					if (query.includes('"' + transition.table + '"')) {
						throw new Error('Unexpanded storage was prepared');
					}
					return original(query);
				});
			let result: ListingAdoptionConsumeResult;
			try {
				result = await store.advance();
			} finally {
				prepare.mockRestore();
			}
			expect({
				result,
				progress: await progress(database),
				work: await work(database)
			}).toStrictEqual({
				result: { kind: 'unavailable' },
				progress: [],
				work: []
			});
		}
	);
	it.each(['capture', 'storage'] as const)(
		'fences work and progress after %s readiness is lost',
		async (phase) => {
			const { database, store } = await fixture(1);
			const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
			const delayed = vi
				.spyOn(env.CUPBOARD_DB, 'batch')
				.mockImplementationOnce(async (queries) => {
					await pauseReadiness(database, phase);
					return original(queries);
				});
			let result: ListingAdoptionConsumeResult;
			try {
				result = await store.advance();
			} finally {
				delayed.mockRestore();
			}
			expect({
				result,
				progress: await progress(database),
				work: await work(database)
			}).toStrictEqual({
				result: { kind: 'stale' },
				progress: [{ after: 0, scanned: 0, enrolled: 0 }],
				work: []
			});
		}
	);
	it.each(['before initialisation', 'after selection'] as const)(
		'refuses capture loss %s without acknowledging unread input',
		async (phase) => {
			const { database, rows, store } = await fixture(1);
			const floor = rows[0]?.id;
			if (floor === undefined) {
				throw new Error('The capture fixture is empty');
			}
			const prune = () =>
				database
					.update(schema.listingAdoptionCaptureState)
					.set({ prunedThrough: floor });
			const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
			const delayed = vi
				.spyOn(env.CUPBOARD_DB, 'batch')
				.mockImplementationOnce(async (queries) => {
					await prune();
					return original(queries);
				});
			if (phase === 'before initialisation') {
				await prune();
			}
			let result: ListingAdoptionConsumeResult;
			try {
				result = await store.advance();
			} finally {
				delayed.mockRestore();
			}
			expect({
				result,
				progress: await progress(database),
				work: await work(database)
			}).toStrictEqual({
				result:
					phase === 'before initialisation'
						? { kind: 'expired', prunedThrough: floor }
						: { kind: 'stale' },
				progress:
					phase === 'before initialisation'
						? []
						: [{ after: 0, scanned: 0, enrolled: 0 }],
				work: []
			});
		}
	);
	it('reports storage failure instead of an empty capture page', async () => {
		const { store } = await fixture(1);
		const prepare = vi
			.spyOn(env.CUPBOARD_DB, 'prepare')
			.mockImplementation(() => {
				throw new Error('D1 unavailable');
			});
		try {
			await expect(store.advance()).rejects.toBeInstanceOf(
				SharedFactsUnavailableError
			);
		} finally {
			prepare.mockRestore();
		}
	});

	it.each(['capture', 'storage'] as const)(
		'fences checkpoint initialisation after %s readiness is lost',
		async (phase) => {
			const { database, store } = await fixture(1);
			const original = env.CUPBOARD_DB.prepare.bind(env.CUPBOARD_DB);
			const restores: (() => void)[] = [];
			const prepared = vi
				.spyOn(env.CUPBOARD_DB, 'prepare')
				.mockImplementation((query) => {
					const statement = original(query);
					if (!query.startsWith('insert into "listing_adoption_consumer"')) {
						return statement;
					}
					const bind = statement.bind.bind(statement);
					const binding = vi
						.spyOn(statement, 'bind')
						.mockImplementation((...parameters) => {
							const bound = bind(...parameters);
							const run = bound.run.bind(bound);
							const running = vi
								.spyOn(bound, 'run')
								.mockImplementationOnce(async () => {
									await pauseReadiness(database, phase);
									return run();
								});
							restores.push(() => {
								running.mockRestore();
							});
							return bound;
						});
					restores.push(() => {
						binding.mockRestore();
					});
					return statement;
				});
			let result: ListingAdoptionConsumeResult;
			try {
				result = await store.advance();
			} finally {
				prepared.mockRestore();
				for (const restore of restores) {
					restore();
				}
			}
			expect({
				result,
				progress: await progress(database),
				work: await work(database)
			}).toStrictEqual({
				result: { kind: 'unavailable' },
				progress: [],
				work: []
			});
		}
	);
	it('bounds capture pages and work accounting across 25,000 unrelated records', async () => {
		const { store, rows } = await fixture(25_000);
		await store.advance();
		await env.CUPBOARD_DB.prepare(
			"WITH RECURSIVE numbered(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM numbered WHERE value<25000) INSERT INTO listing_adoption_work (id,consumer_epoch,event_id,source) SELECT printf('%032x',value),'ffffffffffffffffffffffffffffffff',value,json_object('kind','listing','identity',json_object('narHash','sha256:'||printf('%052d',value),'generatorRevision','unrelated')) FROM numbered"
		).run();
		const statements: { query: string; parameters: unknown[] }[] = [];
		const database = drizzle(env.CUPBOARD_DB, {
			schema,
			logger: {
				logQuery(query, parameters) {
					statements.push({ query, parameters });
				}
			}
		});
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		let batchReads = 0;
		let batchStatements = 0;
		const measured = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (queries) => {
				const result = await original(queries);
				batchReads = result.reduce(
					(total, row) => total + row.meta.rows_read,
					0
				);
				batchStatements = queries.length;
				return result;
			});
		let result: ListingAdoptionConsumeResult;
		try {
			result = await new ListingAdoptionConsumerStore(database).advance();
		} finally {
			measured.mockRestore();
		}
		const page = statements.find(
			({ query }) =>
				query.startsWith('select ') &&
				query.includes('from "listing_adoption_capture_event"') &&
				query.includes(' limit ')
		);
		if (page === undefined) {
			throw new Error('The capture page query was not recorded');
		}
		const parameters = z
			.array(z.union([z.string(), z.number()]))
			.parse(page.parameters);
		const selected = await env.CUPBOARD_DB.prepare(page.query)
			.bind(...parameters)
			.all<{ id: number }>();
		const plan = await env.CUPBOARD_DB.prepare(
			`EXPLAIN QUERY PLAN ${page.query}`
		)
			.bind(...parameters)
			.all<{ detail: string }>();
		expect({
			result,
			batchStatements,
			boundedBatchReads: batchReads > 0 && batchReads <= 512,
			boundedPageReads: selected.meta.rows_read <= 34,
			parametersBounded: statements.every(
				(statement) => statement.parameters.length <= 100
			),
			queryBytesBounded: statements.every(
				(statement) =>
					new TextEncoder().encode(statement.query).byteLength <= 100_000
			),
			isIndexed: plan.results.some(({ detail }) =>
				detail.includes(
					'SEARCH listing_adoption_capture_event USING INTEGER PRIMARY KEY'
				)
			),
			selected: selected.results
		}).toStrictEqual({
			result: {
				kind: 'advanced',
				scanned: 32,
				enrolled: 32,
				after: rows[63]?.id,
				hasMore: true
			},
			batchStatements: 2,
			boundedBatchReads: true,
			boundedPageReads: true,
			parametersBounded: true,
			queryBytesBounded: true,
			isIndexed: true,
			selected: rows.slice(32, 65).map(({ id }) => ({ id }))
		});
	});

	it('continues after its already enrolled prefix is pruned', async () => {
		const { database, rows, store } = await fixture();
		await store.advance();
		const through = rows[31]?.id;
		if (through === undefined) {
			throw new Error('The capture fixture has no full page');
		}
		await database
			.delete(schema.listingAdoptionCaptureEvent)
			.where(lte(schema.listingAdoptionCaptureEvent.id, through));
		await database
			.update(schema.listingAdoptionCaptureState)
			.set({ prunedThrough: through });
		const result = await store.advance();
		const stored = await work(database);
		expect({
			result,
			progress: await progress(database),
			ids: stored.map((row) => row.eventId)
		}).toStrictEqual({
			result: {
				kind: 'advanced',
				scanned: 32,
				enrolled: 32,
				after: rows[63]?.id,
				hasMore: true
			},
			progress: [{ after: rows[63]?.id, scanned: 64, enrolled: 64 }],
			ids: rows.slice(0, 64).map((row) => row.id)
		});
	});

	it('enrols fixed pages with their checkpoint and preserves progress after restart', async () => {
		const { database, rows, store } = await fixture();
		const first = await store.advance();
		const second = await new ListingAdoptionConsumerStore(database).advance();
		const third = await store.advance();
		const again = await store.advance();
		const stored = await work(database);
		expect({
			first,
			second,
			third,
			again,
			progress: await progress(database),
			work: stored.map(({ eventId, source }) => ({ eventId, source })),
			identities: new Set(stored.map((row) => row.id)).size
		}).toStrictEqual({
			first: {
				kind: 'advanced',
				scanned: 32,
				enrolled: 32,
				after: rows[31]?.id,
				hasMore: true
			},
			second: {
				kind: 'advanced',
				scanned: 32,
				enrolled: 32,
				after: rows[63]?.id,
				hasMore: true
			},
			third: {
				kind: 'advanced',
				scanned: 1,
				enrolled: 1,
				after: rows[64]?.id,
				hasMore: false
			},
			again: { kind: 'idle' },
			progress: [{ after: rows[64]?.id, scanned: 65, enrolled: 65 }],
			work: rows.map(({ id, source }) => ({ eventId: id, source })),
			identities: 65
		});
	});
	it('keeps all source payloads independently of captured event retention', async () => {
		const { database, store } = await fixture(0);
		const sources: ListingAdoptionCaptureSource[] = [
			source(1),
			{
				kind: 'parent',
				tenant: tenantIdSchema.parse('acme'),
				cache: { kind: 'named', name: cacheNameSchema.parse('private') },
				cacheGeneration: cacheGenerationSchema.parse(2),
				storePathHash: storePathHashSchema.parse('1'.repeat(32)),
				generation: narInfoGenerationSchema.parse(3),
				narHash: sharedNarSource(2).narHash
			},
			{
				kind: 'cas',
				digest: sha256HexDigestSchema.parse('a'.repeat(64)),
				incarnation: 4
			}
		];
		for (const source of sources) {
			await database
				.insert(schema.listingAdoptionCaptureEvent)
				.values({ source });
		}
		await store.advance();
		await database.delete(schema.listingAdoptionCaptureEvent);
		const stored = await work(database);
		expect({
			sources: stored.map((row) => row.source),
			cas: await database.select().from(schema.casObject),
			references: await database.select().from(schema.artifactReference)
		}).toStrictEqual({ sources, cas: [], references: [] });
	});
	it('recovers a committed reply without enrolling or counting the page twice', async () => {
		const { database, rows, store } = await fixture();
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const delayed = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (queries) => {
				await original(queries);
				throw new Error('Checkpoint reply lost');
			});
		try {
			await expect(store.advance()).rejects.toBeInstanceOf(
				SharedFactsUnavailableError
			);
		} finally {
			delayed.mockRestore();
		}
		const result = await new ListingAdoptionConsumerStore(database).advance();
		const stored = await work(database);
		expect({
			result,
			progress: await progress(database),
			ids: stored.map((row) => row.eventId)
		}).toStrictEqual({
			result: {
				kind: 'advanced',
				scanned: 32,
				enrolled: 32,
				after: rows[63]?.id,
				hasMore: true
			},
			progress: [{ after: rows[63]?.id, scanned: 64, enrolled: 64 }],
			ids: rows.slice(0, 64).map((row) => row.id)
		});
	});
	it('rolls back durable work when its checkpoint cannot commit', async () => {
		const { database, rows, store } = await fixture(1);
		await env.CUPBOARD_DB.prepare(
			"CREATE TRIGGER test_consumer_abort BEFORE UPDATE ON listing_adoption_consumer BEGIN SELECT RAISE(ABORT,'checkpoint failure'); END"
		).run();
		try {
			await expect(store.advance()).rejects.toBeInstanceOf(
				SharedFactsUnavailableError
			);
		} finally {
			await env.CUPBOARD_DB.prepare('DROP TRIGGER test_consumer_abort').run();
		}
		expect({
			work: await work(database),
			progress: await progress(database)
		}).toStrictEqual({
			work: [],
			progress: [{ after: 0, scanned: 0, enrolled: 0 }]
		});
		expect(await store.advance()).toStrictEqual({
			kind: 'advanced',
			scanned: 1,
			enrolled: 1,
			after: rows[0]?.id,
			hasMore: false
		});
	});
	it('advances an empty capture stream without inventing work', async () => {
		const { database, store } = await fixture(0);
		expect({
			result: await store.advance(),
			progress: await progress(database),
			work: await work(database)
		}).toStrictEqual({
			result: { kind: 'idle' },
			progress: [{ after: 0, scanned: 0, enrolled: 0 }],
			work: []
		});
	});
});

describe('listing adoption capture retention', () => {
	it('prunes acknowledged prefixes in bounded pages without changing durable work or counters', async () => {
		const { database, rows, store } = await fixture();
		await store.advance();
		await store.advance();
		await store.advance();
		const before = {
			work: await work(database),
			progress: await progress(database)
		};
		const first = await store.prune();
		const second = await new ListingAdoptionConsumerStore(database).prune();
		const third = await store.prune();
		const again = await store.prune();
		expect({
			first,
			second,
			third,
			again,
			events: await database.select().from(schema.listingAdoptionCaptureEvent),
			state: await database.select().from(schema.listingAdoptionCaptureState),
			work: await work(database),
			progress: await progress(database)
		}).toStrictEqual({
			first: {
				kind: 'pruned',
				removed: 32,
				through: rows[31]?.id,
				hasMore: true
			},
			second: {
				kind: 'pruned',
				removed: 32,
				through: rows[63]?.id,
				hasMore: true
			},
			third: {
				kind: 'pruned',
				removed: 1,
				through: rows[64]?.id,
				hasMore: false
			},
			again: { kind: 'idle' },
			events: [],
			state: [
				{
					id: 1,
					latest: rows[64]?.id,
					prunedThrough: rows[64]?.id,
					isReady: true
				}
			],
			...before
		});
	});
	it('preserves every unread event and continues consumption after pruning', async () => {
		const { database, rows, store } = await fixture();
		await store.advance();
		const result = await store.prune();
		const remaining = await database
			.select()
			.from(schema.listingAdoptionCaptureEvent)
			.orderBy(asc(schema.listingAdoptionCaptureEvent.id));
		const continued = await store.advance();
		const stored = await work(database);
		expect({
			result,
			remaining,
			continued,
			ids: stored.map((row) => row.eventId)
		}).toStrictEqual({
			result: {
				kind: 'pruned',
				removed: 32,
				through: rows[31]?.id,
				hasMore: false
			},
			remaining: rows.slice(32),
			continued: {
				kind: 'advanced',
				scanned: 32,
				enrolled: 32,
				after: rows[63]?.id,
				hasMore: true
			},
			ids: rows.slice(0, 64).map((row) => row.id)
		});
	});
	it.each(['epoch', 'readiness', 'floor'] as const)(
		'refuses a selected prefix after its %s changes',
		async (change) => {
			const { database, rows, store } = await fixture(2);
			await store.advance();
			const through = rows[1]?.id;
			if (through === undefined) {
				throw new Error('The retention fixture has no boundary');
			}
			const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
			const interrupted = vi
				.spyOn(env.CUPBOARD_DB, 'batch')
				.mockImplementationOnce(async (queries) => {
					switch (change) {
						case 'epoch': {
							await database.update(schema.listingAdoptionConsumer).set({
								epoch: listingAdoptionConsumerEpochSchema.parse('c'.repeat(32))
							});
							break;
						}
						case 'readiness': {
							await database
								.update(schema.listingAdoptionCaptureState)
								.set({ isReady: false });
							break;
						}
						case 'floor': {
							await database
								.update(schema.listingAdoptionCaptureState)
								.set({ prunedThrough: through });
							break;
						}
					}
					return original(queries);
				});
			let result: ListingAdoptionPruneResult;
			try {
				result = await store.prune();
			} finally {
				interrupted.mockRestore();
			}
			expect({
				result,
				events: await database
					.select()
					.from(schema.listingAdoptionCaptureEvent)
					.orderBy(asc(schema.listingAdoptionCaptureEvent.id))
			}).toStrictEqual({ result: { kind: 'stale' }, events: rows });
		}
	);
	it('recovers a lost committed pruning reply without repeating durable enrolment', async () => {
		const { database, rows, store } = await fixture();
		await store.advance();
		await store.advance();
		await store.advance();
		const before = {
			work: await work(database),
			progress: await progress(database)
		};
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const lost = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (queries) => {
				await original(queries);
				throw new Error('Pruning reply lost');
			});
		try {
			await expect(store.prune()).rejects.toBeInstanceOf(
				SharedFactsUnavailableError
			);
		} finally {
			lost.mockRestore();
		}
		expect({
			retry: await new ListingAdoptionConsumerStore(database).prune(),
			events: await database
				.select()
				.from(schema.listingAdoptionCaptureEvent)
				.orderBy(asc(schema.listingAdoptionCaptureEvent.id)),
			work: await work(database),
			progress: await progress(database)
		}).toStrictEqual({
			retry: {
				kind: 'pruned',
				removed: 32,
				through: rows[63]?.id,
				hasMore: true
			},
			events: rows.slice(64),
			...before
		});
	});
	it('commits event deletion and the retained floor atomically', async () => {
		const { database, rows, store } = await fixture(2);
		await store.advance();
		await env.CUPBOARD_DB.prepare(
			"CREATE TRIGGER reject_capture_floor BEFORE UPDATE OF pruned_through ON listing_adoption_capture_state BEGIN SELECT RAISE(ABORT, 'floor refused'); END"
		).run();
		try {
			await expect(store.prune()).rejects.toBeInstanceOf(
				SharedFactsUnavailableError
			);
		} finally {
			await env.CUPBOARD_DB.prepare('DROP TRIGGER reject_capture_floor').run();
		}
		expect({
			events: await database
				.select()
				.from(schema.listingAdoptionCaptureEvent)
				.orderBy(asc(schema.listingAdoptionCaptureEvent.id)),
			state: await database.select().from(schema.listingAdoptionCaptureState)
		}).toStrictEqual({
			events: rows,
			state: [{ id: 1, latest: rows[1]?.id, prunedThrough: 0, isReady: true }]
		});
	});
	it('preserves captures appended after its selected acknowledged boundary', async () => {
		const { database, rows, store } = await fixture(2);
		await store.advance();
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const appended = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (queries) => {
				await database
					.insert(schema.listingAdoptionCaptureEvent)
					.values({ source: source(99) });
				return original(queries);
			});
		let result: ListingAdoptionPruneResult;
		try {
			result = await store.prune();
		} finally {
			appended.mockRestore();
		}
		const events = await database
			.select()
			.from(schema.listingAdoptionCaptureEvent);
		const next = await store.advance();
		const stored = await work(database);
		expect({
			result,
			sources: events.map((event) => event.source),
			next,
			work: stored.map((item) => item.source)
		}).toStrictEqual({
			result: {
				kind: 'pruned',
				removed: 2,
				through: rows[1]?.id,
				hasMore: false
			},
			sources: [source(99)],
			next: {
				kind: 'advanced',
				scanned: 1,
				enrolled: 1,
				after: events[0]?.id,
				hasMore: false
			},
			work: [...rows.map((row) => row.source), source(99)]
		});
	});
	it('advances the retained floor across an already deleted acknowledged prefix', async () => {
		const { database, rows, store } = await fixture();
		await store.advance();
		const through = rows[31]?.id;
		if (through === undefined) {
			throw new Error('The retention fixture has no full page');
		}
		await database
			.delete(schema.listingAdoptionCaptureEvent)
			.where(lte(schema.listingAdoptionCaptureEvent.id, through));
		expect({
			result: await store.prune(),
			state: await database.select().from(schema.listingAdoptionCaptureState),
			events: await database
				.select()
				.from(schema.listingAdoptionCaptureEvent)
				.orderBy(asc(schema.listingAdoptionCaptureEvent.id))
		}).toStrictEqual({
			result: { kind: 'pruned', removed: 0, through, hasMore: false },
			state: [
				{ id: 1, latest: rows[64]?.id, prunedThrough: through, isReady: true }
			],
			events: rows.slice(32)
		});
	});
	it('allows newer consumer progress while deleting only its captured prefix', async () => {
		const { database, rows, store } = await fixture();
		await store.advance();
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const advanced = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (queries) => {
				await store.advance();
				return original(queries);
			});
		let result: ListingAdoptionPruneResult;
		try {
			result = await store.prune();
		} finally {
			advanced.mockRestore();
		}
		const stored = await work(database);
		expect({
			result,
			progress: await progress(database),
			ids: stored.map((item) => item.eventId),
			events: await database
				.select()
				.from(schema.listingAdoptionCaptureEvent)
				.orderBy(asc(schema.listingAdoptionCaptureEvent.id))
		}).toStrictEqual({
			result: {
				kind: 'pruned',
				removed: 32,
				through: rows[31]?.id,
				hasMore: false
			},
			progress: [{ after: rows[63]?.id, scanned: 64, enrolled: 64 }],
			ids: rows.slice(0, 64).map((row) => row.id),
			events: rows.slice(32)
		});
	});
	it('bounds acknowledged prefix deletion among 25,000 capture events', async () => {
		const { rows, store } = await fixture(25_000);
		await store.advance();
		const statements: {
			readonly query: string;
			readonly parameters: unknown[];
		}[] = [];
		const database = drizzle(boundedD1(env.CUPBOARD_DB), {
			schema,
			logger: {
				logQuery(query, parameters) {
					statements.push({ query, parameters });
				}
			}
		});
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		let batchReads = 0;
		let batchStatements = 0;
		let selected: D1Result<{ id: number }> | undefined;
		const measured = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (queries) => {
				const page = statements.find(
					({ query }) =>
						query.startsWith('select ') &&
						query.includes('from "listing_adoption_capture_event"') &&
						query.includes(' limit ')
				);
				if (page === undefined) {
					throw new Error('The pruning page query was not recorded');
				}
				const parameters = z
					.array(z.union([z.string(), z.number()]))
					.parse(page.parameters);
				selected = await env.CUPBOARD_DB.prepare(page.query)
					.bind(...parameters)
					.all<{ id: number }>();
				const result = await original(queries);
				batchReads = result.reduce(
					(total, row) => total + row.meta.rows_read,
					0
				);
				batchStatements = queries.length;
				return result;
			});
		let result: ListingAdoptionPruneResult;
		try {
			result = await withSubrequestSlice(
				() => new ListingAdoptionConsumerStore(database).prune(),
				{ subrequests: 14, reserve: 8 }
			);
		} finally {
			measured.mockRestore();
		}
		if (selected === undefined) {
			throw new Error('The pruning selection measurement is missing');
		}
		expect({
			result,
			batchStatements,
			boundedBatchReads: batchReads > 0 && batchReads <= 256,
			boundedPageReads: selected.meta.rows_read <= 33,
			parametersBounded: statements.every(
				(statement) => statement.parameters.length <= 100
			),
			queryBytesBounded: statements.every(
				(statement) =>
					new TextEncoder().encode(statement.query).byteLength <= 100_000
			),
			selected: selected.results
		}).toStrictEqual({
			result: {
				kind: 'pruned',
				removed: 32,
				through: rows[31]?.id,
				hasMore: false
			},
			batchStatements: 2,
			boundedBatchReads: true,
			boundedPageReads: true,
			parametersBounded: true,
			queryBytesBounded: true,
			selected: rows.slice(0, 32).map(({ id }) => ({ id }))
		});
	});
	it('does not prune before a consumer acknowledges input', async () => {
		const { database, rows, store } = await fixture(1);
		expect({
			result: await store.prune(),
			events: await database.select().from(schema.listingAdoptionCaptureEvent),
			consumers: await database.select().from(schema.listingAdoptionConsumer)
		}).toStrictEqual({ result: { kind: 'idle' }, events: rows, consumers: [] });
	});
	it.each(['capture', 'storage'] as const)(
		'waits while %s readiness is paused',
		async (phase) => {
			const { database, rows, store } = await fixture(1);
			await store.advance();
			await pauseReadiness(database, phase);
			expect({
				result: await store.prune(),
				events: await database.select().from(schema.listingAdoptionCaptureEvent)
			}).toStrictEqual({ result: { kind: 'unavailable' }, events: rows });
		}
	);
});
