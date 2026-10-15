import {
	nixSha256HashSchema,
	sha256HexDigestSchema
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	currentListingGeneratorRevision,
	listingGeneratorRevisionSchema,
	maxArtifactBytes
} from '@cupboard/protocol/artifacts';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it, vi } from 'vitest';
import { z, ZodError } from 'zod';

import {
	ListingFactConflictError,
	SharedFactsUnavailableError
} from '../errors.ts';

import * as schema from './d1-schema.ts';
import {
	ListingFactStore,
	type StoredNarListingFact
} from './listing-facts.ts';

const fact = {
	narHash: nixSha256HashSchema.parse(`sha256:${'0'.repeat(52)}`),
	generatorRevision: currentListingGeneratorRevision,
	format: 1 as const,
	digest: sha256HexDigestSchema.parse('a'.repeat(64)),
	size: 123
};

function store() {
	return new ListingFactStore(drizzle(env.CUPBOARD_DB, { schema }));
}

describe('immutable listing facts', () => {
	it('finds stored listing facts in one indexed tuple lookup without granting read authority', async () => {
		const statements: {
			readonly query: string;
			readonly params: readonly unknown[];
		}[] = [];
		const repository = new ListingFactStore(
			drizzle(env.CUPBOARD_DB, {
				schema,
				logger: {
					logQuery(query, parameters) {
						statements.push({ query, params: parameters });
					}
				}
			})
		);
		const database = drizzle(env.CUPBOARD_DB, { schema });
		const facts = Array.from({ length: 64 }, (_, index) => ({
			...fact,
			narHash: nixSha256HashSchema.parse(
				`sha256:${String(index).padStart(52, '0')}`
			)
		}));
		for (const item of facts) {
			await repository.record(item);
		}
		await repository.record({
			...fact,
			generatorRevision: listingGeneratorRevisionSchema.parse('older')
		});
		const now = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');
		await database.insert(schema.casObject).values({
			digest: fact.digest,
			size: fact.size,
			incarnation: 1,
			storedAt: now
		});
		await database.insert(schema.objectIncarnation).values({
			kind: 'cas',
			objectId: fact.digest,
			incarnation: 1,
			state: 'live',
			updatedAt: now
		});
		statements.length = 0;
		const prepare = vi.spyOn(env.CUPBOARD_DB, 'prepare');
		let stored: readonly StoredNarListingFact[] | undefined;
		let queries: number;
		let hasTupleLookup: boolean;
		try {
			stored = await repository.findStored([...facts, ...facts]);
			queries = prepare.mock.calls.length;
			hasTupleLookup = prepare.mock.calls.every(([query]) =>
				query.includes('json_each')
			);
		} finally {
			prepare.mockRestore();
		}
		const statement = statements[0];
		if (statement === undefined) {
			throw new Error('The bulk listing query was not recorded');
		}
		const bindings = z
			.array(z.union([z.string(), z.number()]))
			.parse(statement.params);
		const plan = await env.CUPBOARD_DB.prepare(
			`EXPLAIN QUERY PLAN ${statement.query}`
		)
			.bind(...bindings)
			.all<{ detail: string }>();
		const hasFactIndex = plan.results.some((row) =>
			row.detail.includes(
				'SEARCH listing_fact USING INDEX sqlite_autoindex_listing_fact_1 (nar_hash=? AND generator_revision=?)'
			)
		);
		const [references, presence] = await database.batch([
			database.select().from(schema.artifactReference),
			database.select().from(schema.tenantCasBlob)
		]);
		expect({
			stored,
			queries,
			hasTupleLookup,
			hasFactIndex,
			references,
			presence
		}).toStrictEqual({
			stored: facts.map((item) => ({ fact: item, incarnation: 1 })),
			queries: 1,
			hasTupleLookup: true,
			hasFactIndex: true,
			references: [],
			presence: []
		});
	});

	it.each([
		'missing-registration',
		'pending',
		'absent',
		'wrong-size',
		'new-incarnation'
	] as const)(
		'does not offer a stored fact for reuse after %s',
		async (condition) => {
			const repository = store();
			await repository.record(fact);
			const database = drizzle(env.CUPBOARD_DB, { schema });
			const now = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');
			await database.insert(schema.casObject).values({
				digest: fact.digest,
				size: condition === 'wrong-size' ? fact.size + 1 : fact.size,
				incarnation: 1,
				storedAt: now
			});
			if (condition !== 'missing-registration') {
				await database.insert(schema.objectIncarnation).values({
					kind: 'cas',
					objectId: fact.digest,
					incarnation: condition === 'new-incarnation' ? 2 : 1,
					state:
						condition === 'pending' || condition === 'absent'
							? condition
							: 'live',
					updatedAt: now
				});
			}
			expect({
				stored: await repository.findStored([fact]),
				fact: await repository.find(fact)
			}).toStrictEqual({
				stored: [],
				fact
			});
		}
	);

	it('does not query shared state for an empty stored-fact lookup', async () => {
		const prepare = vi.spyOn(env.CUPBOARD_DB, 'prepare');
		try {
			const stored = await store().findStored([]);
			expect({ stored, queries: prepare.mock.calls }).toStrictEqual({
				stored: [],
				queries: []
			});
		} finally {
			prepare.mockRestore();
		}
	});

	it('reports a bounded stored-fact lookup failure without returning partial results', async () => {
		const prepare = vi
			.spyOn(env.CUPBOARD_DB, 'prepare')
			.mockImplementation(() => {
				throw new Error('shared database unavailable');
			});
		try {
			await expect(store().findStored([fact])).rejects.toBeInstanceOf(
				SharedFactsUnavailableError
			);
			expect(prepare.mock.calls.length).toBe(2);
		} finally {
			prepare.mockRestore();
		}
	});

	it('records concurrent identical facts once without creating read authority or quota references', async () => {
		const repository = store();
		const outcomes = await Promise.all([
			repository.record(fact),
			repository.record(fact)
		]);
		const database = drizzle(env.CUPBOARD_DB, { schema });
		const [references, presence, physical] = await database.batch([
			database.select().from(schema.artifactReference),
			database.select().from(schema.tenantCasBlob),
			database.select().from(schema.casObject)
		]);
		expect({
			outcomes: outcomes.toSorted(byCodeUnit),
			stored: await repository.find(fact),
			references,
			presence,
			physical
		}).toStrictEqual({
			outcomes: ['already-present', 'created'],
			stored: fact,
			references: [],
			presence: [],
			physical: []
		});
	});

	it.each([
		{ digest: sha256HexDigestSchema.parse('b'.repeat(64)) },
		{ size: fact.size + 1 }
	])('refuses a conflicting measurement: %j', async (change) => {
		const repository = store();
		await repository.record(fact);
		await expect(
			repository.record({ ...fact, ...change })
		).rejects.toBeInstanceOf(ListingFactConflictError);
		expect(await repository.find(fact)).toStrictEqual(fact);
	});

	it('keeps generator revisions and input hashes independent even when the listing bytes agree', async () => {
		const repository = store();
		const older = {
			...fact,
			generatorRevision: listingGeneratorRevisionSchema.parse('nix-v1-r0')
		};
		const other = {
			...fact,
			narHash: nixSha256HashSchema.parse(`sha256:${'1'.repeat(52)}`)
		};
		await repository.record(fact);
		await repository.record(older);
		await repository.record(other);
		const unknown = {
			...fact,
			generatorRevision: listingGeneratorRevisionSchema.parse('unknown')
		};
		const stored = await Promise.all([
			repository.find(fact),
			repository.find(older),
			repository.find(other),
			repository.find(unknown)
		]);
		expect(stored).toStrictEqual([fact, older, other, undefined]);
	});
	it.each([0, 1.5, maxArtifactBytes.listing + 1])(
		'refuses invalid byte size %s before writing a fact',
		async (size) => {
			await expect(store().record({ ...fact, size })).rejects.toBeInstanceOf(
				ZodError
			);
			expect(
				await drizzle(env.CUPBOARD_DB, { schema })
					.select()
					.from(schema.listingFact)
			).toStrictEqual([]);
		}
	);

	it('refuses a persisted measurement outside the listing budget', async () => {
		const database = drizzle(env.CUPBOARD_DB, { schema });
		await database.insert(schema.listingFact).values({
			...fact,
			size: maxArtifactBytes.listing + 1,
			createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z')
		});
		await expect(store().find(fact)).rejects.toBeInstanceOf(
			SharedFactsUnavailableError
		);
	});

	it('reports unavailable shared state after a bounded retry instead of reporting a missing fact', async () => {
		const prepare = vi
			.spyOn(env.CUPBOARD_DB, 'prepare')
			.mockImplementation(() => {
				throw new Error('shared database unavailable');
			});
		try {
			await expect(store().find(fact)).rejects.toBeInstanceOf(
				SharedFactsUnavailableError
			);
			expect(prepare.mock.calls.length).toBe(2);
		} finally {
			prepare.mockRestore();
		}
	});
});
