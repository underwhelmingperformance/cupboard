import { sha256HexDigestSchema } from '@cupboard/nix-store/scalars';
import {
	listingGeneratorRevisionSchema,
	type NarListingFact
} from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { listingAdoptionCaptureSourceSchema } from '../blob/listing-adoption-capture.ts';
import { listingAdoptionSeedEpochSchema } from '../blob/listing-adoption-seed.ts';
import { SharedFactsUnavailableError } from '../errors.ts';

import * as schema from './d1-schema.ts';
import {
	type ListingAdoptionFactSeedResult,
	ListingAdoptionFactSeedStore
} from './listing-adoption-fact-seed.ts';
import { ListingFactStore } from './listing-facts.ts';
import {
	sharedNarDiscoveryFixture,
	sharedNarSource
} from './shared-nar-discovery.test-support.ts';

const now = isoTimestamp(new Date('2026-01-01T00:00:00.000Z'));
const digest = sha256HexDigestSchema.parse('a'.repeat(64));

function fact(index: number, isSameNar = false): NarListingFact {
	return {
		narHash: sharedNarSource(isSameNar ? 0 : index).narHash,
		generatorRevision: listingGeneratorRevisionSchema.parse(
			isSameNar ? `history-${String(index).padStart(4, '0')}` : 'history'
		),
		format: 1,
		digest,
		size: 10
	};
}

async function fixture(count = 65, isSameNar = false) {
	const { database } = await sharedNarDiscoveryFixture(0);
	const facts = Array.from({ length: count }, (_, index) =>
		fact(index + 1, isSameNar)
	);
	const migration = env.TEST_MIGRATIONS.find(
		(item) => item.name === '0068_listing_adoption_capture_contract.sql'
	);
	const trigger = migration?.queries.find((query) =>
		query.includes('CREATE TRIGGER `listing_adoption_fact_insert`')
	);
	if (trigger === undefined) {
		throw new Error('The fact capture trigger migration is missing');
	}
	await env.CUPBOARD_DB.prepare(
		'DROP TRIGGER listing_adoption_fact_insert'
	).run();
	try {
		if (count > 0) {
			await env.CUPBOARD_DB.prepare(
				`WITH RECURSIVE numbered(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM numbered WHERE value < ?)
INSERT INTO listing_fact (nar_hash,generator_revision,format,digest,size,created_at)
SELECT CASE WHEN ? THEN ? ELSE 'sha256:' || printf('%052d',value) END,
 CASE WHEN ? THEN 'history-' || printf('%04d',value) ELSE 'history' END,1,?,10,? FROM numbered`
			)
				.bind(
					count,
					isSameNar ? 1 : 0,
					sharedNarSource(0).narHash,
					isSameNar ? 1 : 0,
					digest,
					now
				)
				.run();
		}
	} finally {
		await env.CUPBOARD_DB.prepare(trigger).run();
	}
	return { database, facts, store: new ListingAdoptionFactSeedStore(database) };
}

function listingEvent(input: NarListingFact) {
	return {
		kind: 'listing',
		identity: {
			narHash: input.narHash,
			generatorRevision: input.generatorRevision
		}
	} as const;
}

async function captureSources(
	database: Awaited<ReturnType<typeof fixture>>['database']
) {
	const rows = await database
		.select({ source: schema.listingAdoptionCaptureEvent.source })
		.from(schema.listingAdoptionCaptureEvent)
		.orderBy(asc(schema.listingAdoptionCaptureEvent.id));
	return rows.map((row) =>
		listingAdoptionCaptureSourceSchema.parse(row.source)
	);
}

async function progress(
	database: Awaited<ReturnType<typeof fixture>>['database']
) {
	const rows = await database
		.select({
			afterNarHash: schema.listingAdoptionFactSeed.afterNarHash,
			afterGeneratorRevision:
				schema.listingAdoptionFactSeed.afterGeneratorRevision,
			throughNarHash: schema.listingAdoptionFactSeed.throughNarHash,
			throughGeneratorRevision:
				schema.listingAdoptionFactSeed.throughGeneratorRevision,
			scanned: schema.listingAdoptionFactSeed.scanned,
			captured: schema.listingAdoptionFactSeed.captured,
			isComplete: schema.listingAdoptionFactSeed.isComplete
		})
		.from(schema.listingAdoptionFactSeed);
	return rows.map((row) => ({
		...row,
		afterNarHash: row.afterNarHash ?? undefined,
		afterGeneratorRevision: row.afterGeneratorRevision ?? undefined,
		throughNarHash: row.throughNarHash ?? undefined,
		throughGeneratorRevision: row.throughGeneratorRevision ?? undefined
	}));
}

describe('historical listing adoption fact seed', () => {
	it('recovers a lost reply without repeating an already committed page', async () => {
		const { database, facts, store } = await fixture();
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const reply = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (statements) => {
				await original(statements);
				throw new Error('The fact seed checkpoint reply was lost');
			});
		try {
			await expect(store.advance()).rejects.toBeInstanceOf(
				SharedFactsUnavailableError
			);
		} finally {
			reply.mockRestore();
		}
		const result = await new ListingAdoptionFactSeedStore(database).advance();
		expect({
			result,
			progress: await progress(database),
			events: await captureSources(database)
		}).toStrictEqual({
			result: {
				kind: 'advanced',
				scanned: 32,
				captured: 32,
				isComplete: false
			},
			progress: [
				{
					afterNarHash: fact(64).narHash,
					afterGeneratorRevision: 'history',
					throughNarHash: fact(65).narHash,
					throughGeneratorRevision: 'history',
					scanned: 64,
					captured: 64,
					isComplete: false
				}
			],
			events: facts.slice(0, 64).map((input) => listingEvent(input))
		});
	});

	it('rolls back projections, events and counters when the checkpoint fails', async () => {
		const { database, store } = await fixture(1);
		await env.CUPBOARD_DB.prepare(
			"CREATE TRIGGER test_fact_seed_abort BEFORE UPDATE ON listing_adoption_fact_seed BEGIN SELECT RAISE(ABORT, 'checkpoint failure'); END"
		).run();
		try {
			await expect(store.advance()).rejects.toBeInstanceOf(
				SharedFactsUnavailableError
			);
		} finally {
			await env.CUPBOARD_DB.prepare('DROP TRIGGER test_fact_seed_abort').run();
		}
		expect({
			projection: await database.select().from(schema.listingAdoptionFact),
			events: await captureSources(database),
			progress: await progress(database)
		}).toStrictEqual({
			projection: [],
			events: [],
			progress: [
				{
					afterNarHash: undefined,
					afterGeneratorRevision: undefined,
					throughNarHash: fact(1).narHash,
					throughGeneratorRevision: 'history',
					scanned: 0,
					captured: 0,
					isComplete: false
				}
			]
		});
		expect(await store.advance()).toStrictEqual({
			kind: 'advanced',
			scanned: 1,
			captured: 1,
			isComplete: true
		});
	});

	it('finishes through a deleted boundary and seeks beyond a deleted cursor', async () => {
		const { database, facts, store } = await fixture();
		await store.advance();
		await database.delete(schema.listingFact).where(
			inArray(
				schema.listingFact.narHash,
				facts.slice(31).map((input) => input.narHash)
			)
		);
		expect({
			result: await store.advance(),
			progress: await progress(database),
			events: await captureSources(database)
		}).toStrictEqual({
			result: { kind: 'advanced', scanned: 0, captured: 0, isComplete: true },
			progress: [
				{
					afterNarHash: fact(65).narHash,
					afterGeneratorRevision: 'history',
					throughNarHash: fact(65).narHash,
					throughGeneratorRevision: 'history',
					scanned: 32,
					captured: 32,
					isComplete: true
				}
			],
			events: facts.slice(0, 32).map((input) => listingEvent(input))
		});
	});

	it('advances the selected page before filtering deleted facts and counts actual captures', async () => {
		const { database, facts, store } = await fixture();
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const intercept = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (statements) => {
				await database.delete(schema.listingFact).where(
					inArray(
						schema.listingFact.narHash,
						facts.slice(0, 32).map((input) => input.narHash)
					)
				);
				return original(statements);
			});
		let first: ListingAdoptionFactSeedResult;
		try {
			first = await store.advance();
		} finally {
			intercept.mockRestore();
		}
		const before = await progress(database);
		await store.advance();
		await store.advance();
		expect({
			first,
			before,
			progress: await progress(database),
			events: await captureSources(database)
		}).toStrictEqual({
			first: { kind: 'advanced', scanned: 32, captured: 0, isComplete: false },
			before: [
				{
					afterNarHash: fact(32).narHash,
					afterGeneratorRevision: 'history',
					throughNarHash: fact(65).narHash,
					throughGeneratorRevision: 'history',
					scanned: 32,
					captured: 0,
					isComplete: false
				}
			],
			progress: [
				{
					afterNarHash: fact(65).narHash,
					afterGeneratorRevision: 'history',
					throughNarHash: fact(65).narHash,
					throughGeneratorRevision: 'history',
					scanned: 65,
					captured: 33,
					isComplete: true
				}
			],
			events: facts.slice(32).map((input) => listingEvent(input))
		});
	});

	it.each(['deleted', 'replaced'])(
		'rechecks a source that was %s after selection',
		async (condition) => {
			const { database, store } = await fixture(1);
			const input = fact(1);
			const replacement = {
				...input,
				digest: sha256HexDigestSchema.parse('b'.repeat(64))
			};
			const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
			const intercept = vi
				.spyOn(env.CUPBOARD_DB, 'batch')
				.mockImplementationOnce(async (statements) => {
					await database
						.delete(schema.listingFact)
						.where(
							and(
								eq(schema.listingFact.narHash, input.narHash),
								eq(
									schema.listingFact.generatorRevision,
									input.generatorRevision
								)
							)
						);
					if (condition === 'replaced') {
						await new ListingFactStore(database).record(replacement);
					}
					return original(statements);
				});
			let result: ListingAdoptionFactSeedResult;
			try {
				result = await store.advance();
			} finally {
				intercept.mockRestore();
			}
			expect({
				result,
				projection: await database.select().from(schema.listingAdoptionFact),
				events: await captureSources(database),
				progress: await progress(database)
			}).toStrictEqual({
				result: {
					kind: 'advanced',
					scanned: 1,
					captured: condition === 'replaced' ? 1 : 0,
					isComplete: true
				},
				projection:
					condition === 'replaced'
						? [
								{
									narHash: input.narHash,
									generatorRevision: input.generatorRevision,
									digest: replacement.digest
								}
							]
						: [],
				events:
					condition === 'replaced'
						? [listingEvent(input), listingEvent(input)]
						: [],
				progress: [
					{
						afterNarHash: input.narHash,
						afterGeneratorRevision: input.generatorRevision,
						throughNarHash: input.narHash,
						throughGeneratorRevision: input.generatorRevision,
						scanned: 1,
						captured: condition === 'replaced' ? 1 : 0,
						isComplete: true
					}
				]
			});
		}
	);

	it('preserves live insertion before the cursor and beyond the frozen boundary', async () => {
		const { database, facts, store } = await fixture();
		await store.advance();
		await new ListingFactStore(database).record(fact(0));
		await new ListingFactStore(database).record(fact(99));
		await store.advance();
		await store.advance();
		expect({
			progress: await progress(database),
			events: await captureSources(database),
			projection: await database
				.select()
				.from(schema.listingAdoptionFact)
				.orderBy(
					schema.listingAdoptionFact.narHash,
					schema.listingAdoptionFact.generatorRevision
				)
		}).toStrictEqual({
			progress: [
				{
					afterNarHash: fact(65).narHash,
					afterGeneratorRevision: 'history',
					throughNarHash: fact(65).narHash,
					throughGeneratorRevision: 'history',
					scanned: 65,
					captured: 65,
					isComplete: true
				}
			],
			events: [
				...facts.slice(0, 32),
				fact(0),
				fact(99),
				...facts.slice(32)
			].map((input) => listingEvent(input)),
			projection: [fact(0), ...facts, fact(99)].map((input) => ({
				narHash: input.narHash,
				generatorRevision: input.generatorRevision,
				digest
			}))
		});
	});

	it('rejects a delayed page after another consumer advances revisions of the same NAR', async () => {
		const { database, facts, store } = await fixture(97, true);
		await store.advance();
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const intercept = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (statements) => {
				await store.advance();
				await store.advance();
				return original(statements);
			});
		let result: ListingAdoptionFactSeedResult;
		try {
			result = await store.advance();
		} finally {
			intercept.mockRestore();
		}
		expect({
			result,
			progress: await progress(database),
			events: await captureSources(database)
		}).toStrictEqual({
			result: { kind: 'stale' },
			progress: [
				{
					afterNarHash: fact(96, true).narHash,
					afterGeneratorRevision: fact(96, true).generatorRevision,
					throughNarHash: fact(97, true).narHash,
					throughGeneratorRevision: fact(97, true).generatorRevision,
					scanned: 96,
					captured: 96,
					isComplete: false
				}
			],
			events: facts.slice(0, 96).map((input) => listingEvent(input))
		});
	});

	it('rejects a delayed page for a recreated window with identical cursors', async () => {
		const { database, facts, store } = await fixture();
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const epochs: string[] = [];
		const intercept = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (statements) => {
				const before = await database
					.select()
					.from(schema.listingAdoptionFactSeed)
					.get();
				epochs.push(listingAdoptionSeedEpochSchema.parse(before?.epoch));
				await database.delete(schema.listingAdoptionFactSeed);
				await database.insert(schema.listingAdoptionFactSeed).values({
					id: 1,
					throughNarHash: fact(65).narHash,
					throughGeneratorRevision: fact(65).generatorRevision
				});
				const after = await database
					.select()
					.from(schema.listingAdoptionFactSeed)
					.get();
				epochs.push(listingAdoptionSeedEpochSchema.parse(after?.epoch));
				return original(statements);
			});
		let result: ListingAdoptionFactSeedResult;
		try {
			result = await store.advance();
		} finally {
			intercept.mockRestore();
		}
		expect({
			result,
			hasFreshEpoch: epochs[0] !== epochs[1],
			progress: await progress(database),
			events: await captureSources(database),
			projection: await database.select().from(schema.listingAdoptionFact)
		}).toStrictEqual({
			result: { kind: 'stale' },
			hasFreshEpoch: true,
			progress: [
				{
					afterNarHash: undefined,
					afterGeneratorRevision: undefined,
					throughNarHash: fact(65).narHash,
					throughGeneratorRevision: 'history',
					scanned: 0,
					captured: 0,
					isComplete: false
				}
			],
			events: [],
			projection: []
		});
		expect(await store.advance()).toStrictEqual({
			kind: 'advanced',
			scanned: 32,
			captured: 32,
			isComplete: false
		});
		expect(await captureSources(database)).toStrictEqual(
			facts.slice(0, 32).map((input) => listingEvent(input))
		);
	});

	it('fences readiness lost after selecting a page and resumes without losing facts', async () => {
		const { database, store } = await fixture(1);
		const original = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const intercept = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (statements) => {
				await database
					.update(schema.listingAdoptionCaptureState)
					.set({ isReady: false });
				return original(statements);
			});
		let result: ListingAdoptionFactSeedResult;
		try {
			result = await store.advance();
		} finally {
			intercept.mockRestore();
		}
		expect({
			result,
			progress: await progress(database),
			events: await captureSources(database),
			projection: await database.select().from(schema.listingAdoptionFact)
		}).toStrictEqual({
			result: { kind: 'stale' },
			progress: [
				{
					afterNarHash: undefined,
					afterGeneratorRevision: undefined,
					throughNarHash: fact(1).narHash,
					throughGeneratorRevision: 'history',
					scanned: 0,
					captured: 0,
					isComplete: false
				}
			],
			events: [],
			projection: []
		});
		await database
			.update(schema.listingAdoptionCaptureState)
			.set({ isReady: true });
		expect(await store.advance()).toStrictEqual({
			kind: 'advanced',
			scanned: 1,
			captured: 1,
			isComplete: true
		});
	});

	it('uses the composite primary key for a bounded page in 25,000 facts', async () => {
		const { store } = await fixture(25_000);
		await store.advance();
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
		let batchRowsRead = 0;
		const measure = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(async (queries) => {
				const results = await original(queries);
				batchRowsRead = results.reduce(
					(total, item) => total + item.meta.rows_read,
					0
				);
				return results;
			});
		let result: ListingAdoptionFactSeedResult;
		try {
			result = await new ListingAdoptionFactSeedStore(database).advance();
		} finally {
			measure.mockRestore();
		}
		const page = statements.find(
			({ query }) =>
				query.startsWith('select ') &&
				query.includes('from "listing_fact"') &&
				query.includes(' limit ')
		);
		if (page === undefined) {
			throw new Error('The fact seed page query was not recorded');
		}
		const parameters = z
			.array(z.union([z.string(), z.number()]))
			.parse(page.parameters);
		const measured = await env.CUPBOARD_DB.prepare(page.query)
			.bind(...parameters)
			.all();
		const plan = await env.CUPBOARD_DB.prepare(
			`EXPLAIN QUERY PLAN ${page.query}`
		)
			.bind(...parameters)
			.all<{ detail: string }>();
		expect({
			result,
			boundedReads: measured.meta.rows_read <= 34,
			boundedBatchReads: batchRowsRead > 0 && batchRowsRead <= 512,
			isIndexed: plan.results.some(({ detail }) =>
				detail.includes(
					'SEARCH listing_fact USING COVERING INDEX sqlite_autoindex_listing_fact_1'
				)
			),
			rows: measured.results
		}).toStrictEqual({
			result: {
				kind: 'advanced',
				scanned: 32,
				captured: 32,
				isComplete: false
			},
			boundedReads: true,
			boundedBatchReads: true,
			isIndexed: true,
			rows: Array.from({ length: 33 }, (_, index) => ({
				nar_hash: fact(index + 33).narHash,
				generator_revision: 'history'
			}))
		});
	});

	it.each([false, true])(
		'seeds fixed pages with a composite cursor (same NAR: %s)',
		async (isSameNar) => {
			const { database, facts, store } = await fixture(65, isSameNar);
			const first = await store.advance();
			const checkpoint = await progress(database);
			const second = await store.advance();
			const third = await store.advance();
			expect({
				first,
				checkpoint,
				second,
				third,
				again: await store.advance(),
				projection: await database
					.select()
					.from(schema.listingAdoptionFact)
					.orderBy(
						schema.listingAdoptionFact.narHash,
						schema.listingAdoptionFact.generatorRevision
					),
				events: await captureSources(database),
				progress: await progress(database),
				references: await database.select().from(schema.artifactReference),
				cas: await database.select().from(schema.casObject)
			}).toStrictEqual({
				first: {
					kind: 'advanced',
					scanned: 32,
					captured: 32,
					isComplete: false
				},
				checkpoint: [
					{
						afterNarHash: facts[31]?.narHash,
						afterGeneratorRevision: facts[31]?.generatorRevision,
						throughNarHash: facts[64]?.narHash,
						throughGeneratorRevision: facts[64]?.generatorRevision,
						scanned: 32,
						captured: 32,
						isComplete: false
					}
				],
				second: {
					kind: 'advanced',
					scanned: 32,
					captured: 32,
					isComplete: false
				},
				third: { kind: 'advanced', scanned: 1, captured: 1, isComplete: true },
				again: { kind: 'complete' },
				projection: facts.map((input) => ({
					narHash: input.narHash,
					generatorRevision: input.generatorRevision,
					digest
				})),
				events: facts.map((input) => ({
					kind: 'listing',
					identity: {
						narHash: input.narHash,
						generatorRevision: input.generatorRevision
					}
				})),
				progress: [
					{
						afterNarHash: facts[64]?.narHash,
						afterGeneratorRevision: facts[64]?.generatorRevision,
						throughNarHash: facts[64]?.narHash,
						throughGeneratorRevision: facts[64]?.generatorRevision,
						scanned: 65,
						captured: 65,
						isComplete: true
					}
				],
				references: [],
				cas: []
			});
		}
	);

	it('completes an empty window and relies on live capture for later facts', async () => {
		const { database, store } = await fixture(0);
		const first = await store.advance();
		const input = fact(1);
		await new ListingFactStore(database).record(input);
		expect({
			first,
			again: await store.advance(),
			progress: await progress(database),
			events: await captureSources(database),
			projection: await database.select().from(schema.listingAdoptionFact)
		}).toStrictEqual({
			first: { kind: 'complete' },
			again: { kind: 'complete' },
			progress: [
				{
					afterNarHash: undefined,
					afterGeneratorRevision: undefined,
					throughNarHash: undefined,
					throughGeneratorRevision: undefined,
					scanned: 0,
					captured: 0,
					isComplete: true
				}
			],
			events: [
				{
					kind: 'listing',
					identity: {
						narHash: input.narHash,
						generatorRevision: input.generatorRevision
					}
				}
			],
			projection: [
				{
					narHash: input.narHash,
					generatorRevision: input.generatorRevision,
					digest
				}
			]
		});
	});

	it('refuses consumer startup without suppressing live source capture', async () => {
		const { database, store } = await fixture(0);
		await database
			.update(schema.listingAdoptionCaptureState)
			.set({ isReady: false });
		await new ListingFactStore(database).record(fact(1));
		expect({
			result: await store.advance(),
			progress: await progress(database),
			events: await captureSources(database)
		}).toStrictEqual({
			result: { kind: 'unavailable' },
			progress: [],
			events: [
				{
					kind: 'listing',
					identity: {
						narHash: fact(1).narHash,
						generatorRevision: fact(1).generatorRevision
					}
				}
			]
		});
	});
});
