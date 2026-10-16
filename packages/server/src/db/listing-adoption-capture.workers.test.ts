import {
	cacheGenerationSchema,
	cacheNameSchema,
	narInfoGenerationSchema,
	sha256HexDigestSchema,
	storePathHashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import {
	currentListingGeneratorRevision,
	type NarListingFact
} from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it } from 'vitest';

import { listingAdoptionCaptureSourceSchema } from '../blob/listing-adoption-capture.ts';

import * as schema from './d1-schema.ts';
import { ListingFactStore } from './listing-facts.ts';
import {
	sharedNarDiscoveryFixture,
	sharedNarSource
} from './shared-nar-discovery.test-support.ts';

const now = isoTimestamp(new Date('2026-01-01T00:00:00.000Z'));
const tenant = tenantIdSchema.parse('discovery-first');
const digest = sha256HexDigestSchema.parse('a'.repeat(64));

function fact(index = 0): NarListingFact {
	return {
		narHash: sharedNarSource(index).narHash,
		generatorRevision: currentListingGeneratorRevision,
		format: 1,
		digest,
		size: 10
	};
}

function parent(index = 0): typeof schema.blobReference.$inferInsert {
	return {
		tenant,
		cacheKind: 'default',
		cacheGeneration: cacheGenerationSchema.parse(1),
		storePathHash: storePathHashSchema.parse(String(index).padStart(32, '0')),
		generation: narInfoGenerationSchema.parse(0),
		narHash: sharedNarSource(0).narHash
	};
}

async function sources() {
	const database = drizzle(env.CUPBOARD_DB, { schema });
	const rows = await database
		.select({ source: schema.listingAdoptionCaptureEvent.source })
		.from(schema.listingAdoptionCaptureEvent)
		.orderBy(schema.listingAdoptionCaptureEvent.id);
	return rows.map((row) =>
		listingAdoptionCaptureSourceSchema.parse(row.source)
	);
}

describe('listing adoption capture', () => {
	it('captures each later parent with its cache and publication generation', async () => {
		const { database } = await sharedNarDiscoveryFixture(0);
		const first = parent();
		const second = {
			...parent(1),
			cacheKind: 'named' as const,
			cacheName: cacheNameSchema.parse('private'),
			cacheGeneration: cacheGenerationSchema.parse(2),
			generation: narInfoGenerationSchema.parse(3)
		};
		await database.insert(schema.blobReference).values([first, second]);
		expect(await sources()).toStrictEqual([
			{
				kind: 'parent',
				narHash: first.narHash,
				tenant,
				cache: { kind: 'default' },
				cacheGeneration: 1,
				storePathHash: first.storePathHash,
				generation: 0
			},
			{
				kind: 'parent',
				narHash: second.narHash,
				tenant,
				cache: { kind: 'named', name: 'private' },
				cacheGeneration: 2,
				storePathHash: second.storePathHash,
				generation: 3
			}
		]);
	});

	it('captures a new immutable fact once and indexes its digest without retaining bytes', async () => {
		const { database } = await sharedNarDiscoveryFixture(0);
		const store = new ListingFactStore(database);
		const input = fact();
		const first = await store.record(input);
		const repeated = await store.record(input);
		expect({
			first,
			repeated,
			events: await sources(),
			index: await database.select().from(schema.listingAdoptionFact),
			cas: await database.select().from(schema.casObject),
			references: await database.select().from(schema.artifactReference)
		}).toStrictEqual({
			first: 'created',
			repeated: 'already-present',
			events: [
				{
					kind: 'listing',
					identity: {
						narHash: input.narHash,
						generatorRevision: input.generatorRevision
					}
				}
			],
			index: [
				{
					narHash: input.narHash,
					generatorRevision: input.generatorRevision,
					digest
				}
			],
			cas: [],
			references: []
		});
	});

	it('captures visibility and identity changes without repeating unchanged parents', async () => {
		const { database } = await sharedNarDiscoveryFixture(0);
		const input = parent();
		await database
			.insert(schema.blobReference)
			.values({ ...input, readable: false });
		expect(await sources()).toStrictEqual([]);
		await database.update(schema.blobReference).set({ readable: true });
		await database.update(schema.blobReference).set({ readable: true });
		await database
			.update(schema.blobReference)
			.set({ generation: narInfoGenerationSchema.parse(1) });
		await database
			.update(schema.blobReference)
			.set({ cacheGeneration: cacheGenerationSchema.parse(2) });
		await database
			.update(schema.blobReference)
			.set({ narHash: sharedNarSource(1).narHash });
		await database.update(schema.blobReference).set({ readable: false });
		await database.delete(schema.blobReference);
		const captured = {
			kind: 'parent',
			narHash: input.narHash,
			tenant,
			cache: { kind: 'default' },
			cacheGeneration: 1,
			storePathHash: input.storePathHash,
			generation: 0
		};
		expect(await sources()).toStrictEqual([
			captured,
			{ ...captured, generation: 1 },
			{ ...captured, generation: 1, cacheGeneration: 2 },
			{
				...captured,
				generation: 1,
				cacheGeneration: 2,
				narHash: sharedNarSource(1).narHash
			}
		]);
	});

	it.each(['metadata-first', 'registration-first'])(
		'captures one CAS availability event across many matching facts (%s)',
		async (order) => {
			const { database } = await sharedNarDiscoveryFixture(0);
			const facts = Array.from({ length: 100 }, (_, index) => fact(index));
			for (const input of facts) {
				await new ListingFactStore(database).record(input);
			}
			const metadata = database
				.insert(schema.casObject)
				.values({ digest, incarnation: 2, size: 10, storedAt: now });
			const registration = database.insert(schema.objectIncarnation).values({
				kind: 'cas',
				objectId: digest,
				incarnation: 2,
				state: 'live',
				updatedAt: now
			});
			if (order === 'metadata-first') {
				await database.batch([metadata, registration]);
			} else {
				await database.batch([registration, metadata]);
			}
			await database.update(schema.casObject).set({ deleteAfter: now });
			await database.update(schema.objectIncarnation).set({ updatedAt: now });
			expect(await sources()).toStrictEqual([
				...facts.map((input) => ({
					kind: 'listing',
					identity: {
						narHash: input.narHash,
						generatorRevision: input.generatorRevision
					}
				})),
				{ kind: 'cas', digest, incarnation: 2 }
			]);
		}
	);

	it('recaptures repaired bytes for an existing fact only after matching live registration', async () => {
		const { database } = await sharedNarDiscoveryFixture(0);
		const input = fact();
		await new ListingFactStore(database).record(input);
		await database
			.insert(schema.casObject)
			.values({ digest, incarnation: 1, size: 10, storedAt: now });
		await database.insert(schema.objectIncarnation).values({
			kind: 'cas',
			objectId: digest,
			incarnation: 1,
			state: 'live',
			updatedAt: now
		});
		const first = await sources();
		await database.update(schema.objectIncarnation).set({ state: 'absent' });
		await database
			.update(schema.objectIncarnation)
			.set({ state: 'pending', incarnation: 2 });
		await database.update(schema.casObject).set({ incarnation: 2 });
		expect(await sources()).toStrictEqual(first);
		await database.update(schema.objectIncarnation).set({ state: 'live' });
		await database.update(schema.objectIncarnation).set({ state: 'live' });
		expect(await sources()).toStrictEqual([
			{
				kind: 'listing',
				identity: {
					narHash: input.narHash,
					generatorRevision: input.generatorRevision
				}
			},
			{ kind: 'cas', digest, incarnation: 1 },
			{ kind: 'cas', digest, incarnation: 2 }
		]);
	});

	it('ignores unrelated CAS objects and removes deleted facts from the reverse projection', async () => {
		const { database } = await sharedNarDiscoveryFixture(0);
		await new ListingFactStore(database).record(fact());
		await database.delete(schema.listingFact);
		const before = await sources();
		await database
			.insert(schema.casObject)
			.values({ digest, incarnation: 1, size: 10, storedAt: now });
		await database.insert(schema.objectIncarnation).values({
			kind: 'cas',
			objectId: digest,
			incarnation: 1,
			state: 'live',
			updatedAt: now
		});
		expect({
			events: await sources(),
			projection: await database.select().from(schema.listingAdoptionFact)
		}).toStrictEqual({ events: before, projection: [] });
	});

	it('keeps source capture and its clock active before consumer readiness', async () => {
		const { database } = await sharedNarDiscoveryFixture(0);
		await database
			.update(schema.listingAdoptionCaptureState)
			.set({ isReady: false });
		await database.insert(schema.blobReference).values(parent());
		await new ListingFactStore(database).record(fact());
		expect({
			events: await sources(),
			projection: await database.select().from(schema.listingAdoptionFact)
		}).toStrictEqual({
			events: [
				{
					kind: 'parent',
					narHash: fact().narHash,
					tenant,
					cache: { kind: 'default' },
					cacheGeneration: 1,
					storePathHash: parent().storePathHash,
					generation: 0
				},
				{
					kind: 'listing',
					identity: {
						narHash: fact().narHash,
						generatorRevision: currentListingGeneratorRevision
					}
				}
			],
			projection: [
				{
					narHash: fact().narHash,
					generatorRevision: currentListingGeneratorRevision,
					digest
				}
			]
		});
		const before = await sources();
		await database
			.update(schema.listingAdoptionCaptureState)
			.set({ isReady: true });
		await new ListingFactStore(database).record(fact(1));
		const events = await database
			.select()
			.from(schema.listingAdoptionCaptureEvent);
		const state = await database
			.select()
			.from(schema.listingAdoptionCaptureState);
		expect({ events: await sources(), state }).toStrictEqual({
			events: [
				...before,
				{
					kind: 'listing',
					identity: {
						narHash: fact(1).narHash,
						generatorRevision: currentListingGeneratorRevision
					}
				}
			],
			state: [
				{ id: 1, latest: events.at(-1)?.id, prunedThrough: 0, isReady: true }
			]
		});
	});

	it('rolls capture and reverse indexing back with the source transaction', async () => {
		const { database } = await sharedNarDiscoveryFixture(0);
		const existing = await database
			.select()
			.from(schema.tenant)
			.where(eq(schema.tenant.id, tenant))
			.get();
		if (existing === undefined) {
			throw new Error('The rollback fixture tenant is missing');
		}
		const writes = [
			database.insert(schema.listingFact).values({ ...fact(), createdAt: now }),
			database.insert(schema.blobReference).values(parent()),
			database.insert(schema.tenant).values(existing)
		] as const;
		await expect(database.batch(writes)).rejects.toThrow();
		expect({
			events: await sources(),
			projection: await database.select().from(schema.listingAdoptionFact),
			parents: await database.select().from(schema.blobReference),
			facts: await database.select().from(schema.listingFact),
			state: await database.select().from(schema.listingAdoptionCaptureState)
		}).toStrictEqual({
			events: [],
			projection: [],
			parents: [],
			facts: [],
			state: [{ id: 1, latest: 0, prunedThrough: 0, isReady: true }]
		});
	});
});
