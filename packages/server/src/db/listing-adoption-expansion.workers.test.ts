import {
	cacheGenerationSchema,
	cacheNameSchema,
	type CacheScope,
	narInfoGenerationSchema,
	sha256HexDigestSchema,
	storePathHashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import {
	listingGeneratorRevisionSchema,
	type NarListingFact
} from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { type ListingAdoptionCaptureSource } from '../blob/listing-adoption-capture.ts';
import {
	type ListingAdoptionExpansionWindow,
	listingAdoptionExpansionWindowSchema
} from '../blob/listing-adoption-expansion.ts';
import { listingAdoptionParentIdSchema } from '../blob/listing-adoption-parents.ts';
import { jsonValueList } from '../do/json-list.ts';
import { SharedFactsUnavailableError } from '../errors.ts';

import { cacheIdentityColumns } from './cache.ts';
import * as schema from './d1-schema.ts';
import { ListingAdoptionExpansionDiscovery } from './listing-adoption-expansion.ts';
import { ListingAdoptionParentStore } from './listing-adoption-parents.ts';
import { ListingFactStore } from './listing-facts.ts';
import {
	sharedNarDiscoveryFixture,
	sharedNarSource
} from './shared-nar-discovery.test-support.ts';

const now = isoTimestamp(new Date('2026-01-01T00:00:00.000Z'));
const tenant = tenantIdSchema.parse('discovery-first');
const narHash = sharedNarSource(1).narHash;
const digest = sha256HexDigestSchema.parse('a'.repeat(64));
function fact(index: number): NarListingFact {
	return {
		narHash,
		generatorRevision: listingGeneratorRevisionSchema.parse(
			`history-${String(index).padStart(4, '0')}`
		),
		digest,
		format: 1,
		size: 10
	};
}
function identity(index: number) {
	return { narHash, generatorRevision: fact(index).generatorRevision };
}

async function fixture(count = 65, kind: CacheScope['kind'] = 'default') {
	const { database } = await sharedNarDiscoveryFixture(0);
	await database.insert(schema.deploymentTransition).values([
		{ id: 'listing-adoption-capture', state: 'complete', updatedAt: now },
		{ id: 'listing-adoption-parents', state: 'complete', updatedAt: now }
	]);
	const cache: CacheScope =
		kind === 'default'
			? { kind }
			: { kind, name: cacheNameSchema.parse('private') };
	await database.insert(schema.cacheLifecycle).values({
		tenant,
		...cacheIdentityColumns(cache),
		generation: cacheGenerationSchema.parse(1),
		access: 'private',
		updatedAt: now
	});
	const paths = Array.from({ length: count }, (_, index) =>
		storePathHashSchema.parse(String(index + 1).padStart(32, '0'))
	);
	for (const path of paths) {
		await database.insert(schema.blobReference).values({
			tenant,
			...cacheIdentityColumns(cache),
			cacheGeneration: cacheGenerationSchema.parse(1),
			storePathHash: path,
			generation: narInfoGenerationSchema.parse(3),
			narHash
		});
	}
	const parentStore = new ListingAdoptionParentStore(database);
	for (let index = 0; index < paths.length; index += 32) {
		await parentStore.refresh({
			tenant,
			cache,
			storePathHashes: paths.slice(index, index + 32)
		});
	}
	const factStore = new ListingFactStore(database);
	for (let index = 1; index <= count; index++) {
		await factStore.record(fact(index));
	}
	await database.insert(schema.objectIncarnation).values({
		kind: 'cas',
		objectId: digest,
		incarnation: 2,
		state: 'live',
		updatedAt: now
	});
	await database
		.insert(schema.casObject)
		.values({ digest, size: 10, incarnation: 2, storedAt: now });
	const firstPath =
		paths[0] ?? storePathHashSchema.parse('1'.padStart(32, '0'));
	const parent: ListingAdoptionCaptureSource = {
		kind: 'parent',
		tenant,
		cache,
		cacheGeneration: cacheGenerationSchema.parse(1),
		storePathHash: firstPath,
		generation: narInfoGenerationSchema.parse(3),
		narHash
	};
	const sources = {
		parent,
		listing: {
			kind: 'listing',
			identity: { narHash, generatorRevision: fact(1).generatorRevision }
		},
		cas: { kind: 'cas', digest, incarnation: 2 }
	} as const;
	return {
		database,
		cache,
		paths,
		sources,
		reader: new ListingAdoptionExpansionDiscovery(database)
	};
}
async function open(
	reader: ListingAdoptionExpansionDiscovery,
	source: ListingAdoptionCaptureSource
): Promise<ListingAdoptionExpansionWindow> {
	const result = await reader.open(source);
	if (result.kind !== 'window') {
		throw new Error(`The expansion window is ${result.kind}`);
	}
	return result.window;
}

describe('listing adoption expansion discovery', () => {
	it('continues a listing window after its cursor and upper-bound parent are deleted', async () => {
		const { database, sources, reader } = await fixture();
		const first = await reader.page(await open(reader, sources.listing));
		if (first.kind !== 'page' || first.page.kind !== 'listing') {
			throw new Error('The listing page is unavailable');
		}
		const window = first.page.window;
		const parents = await database
			.select({ id: schema.listingAdoptionParent.id })
			.from(schema.listingAdoptionParent)
			.orderBy(asc(schema.listingAdoptionParent.id));
		const cursor = window.after;
		if (cursor === undefined) {
			throw new Error('The listing page cursor is missing');
		}
		await database
			.delete(schema.listingAdoptionParent)
			.where(
				inArray(
					schema.listingAdoptionParent.id,
					jsonValueList([cursor, window.through])
				)
			);
		const result = await reader.page(window);
		if (result.kind !== 'page' || result.page.kind !== 'listing') {
			throw new Error('The resumed listing page is unavailable');
		}
		expect({
			scanned: result.page.scanned,
			isComplete: result.page.isComplete,
			ids: result.page.targets.map((target) => target.parent.id),
			window: result.page.window
		}).toStrictEqual({
			scanned: 32,
			isComplete: true,
			ids: parents.slice(32, 64).map((parent) => parent.id),
			window: { ...window, after: window.through }
		});
	});
	it('preserves a CAS composite window across NARs and deleted boundaries', async () => {
		const { database, sources, reader } = await fixture(33);
		const nextNar = sharedNarSource(2).narHash;
		const nextFacts = [
			{ ...fact(1), narHash: nextNar },
			{ ...fact(2), narHash: nextNar }
		];
		for (const input of nextFacts) {
			await new ListingFactStore(database).record(input);
		}
		const first = await reader.page(await open(reader, sources.cas));
		if (first.kind !== 'page' || first.page.kind !== 'cas') {
			throw new Error('The CAS page is unavailable');
		}
		const window = first.page.window;
		const cursorRevision = fact(32).generatorRevision;
		const boundaryRevision = fact(2).generatorRevision;
		await database
			.delete(schema.listingFact)
			.where(
				and(
					eq(schema.listingFact.narHash, narHash),
					eq(schema.listingFact.generatorRevision, cursorRevision)
				)
			);
		await database
			.delete(schema.listingFact)
			.where(
				and(
					eq(schema.listingFact.narHash, nextNar),
					eq(schema.listingFact.generatorRevision, boundaryRevision)
				)
			);
		const result = await reader.page(window);
		expect(result).toStrictEqual({
			kind: 'page',
			page: {
				kind: 'cas',
				window: {
					...window,
					after: {
						narHash: nextNar,
						generatorRevision: fact(2).generatorRevision
					}
				},
				identities: [
					identity(33),
					{ narHash: nextNar, generatorRevision: fact(1).generatorRevision }
				],
				scanned: 2,
				isComplete: true
			}
		});
	});
	it('refreshes the actual parent before choosing the NAR and revision window', async () => {
		const { database, sources, reader, cache, paths } = await fixture(1);
		const replacement = { ...fact(2), narHash: sharedNarSource(2).narHash };
		await new ListingFactStore(database).record(replacement);
		await database.insert(schema.blobReference).values({
			tenant,
			...cacheIdentityColumns(cache),
			cacheGeneration: cacheGenerationSchema.parse(1),
			storePathHash:
				paths[0] ?? storePathHashSchema.parse('1'.padStart(32, '0')),
			generation: narInfoGenerationSchema.parse(4),
			narHash: replacement.narHash
		});
		const window = await open(reader, sources.parent);
		if (window.kind !== 'parent') {
			throw new Error('The parent window is unavailable');
		}
		const result = await reader.page(window);
		expect({
			narHash: window.parent.narHash,
			generation: window.parent.generation,
			result
		}).toStrictEqual({
			narHash: replacement.narHash,
			generation: 4,
			result: {
				kind: 'page',
				page: {
					kind: 'parent',
					window: { ...window, after: replacement.generatorRevision },
					targets: [
						{
							parent: window.parent,
							identity: {
								narHash: replacement.narHash,
								generatorRevision: replacement.generatorRevision
							}
						}
					],
					scanned: 1,
					isComplete: true
				}
			}
		});
	});
	it('rejects a changed parent even when its projection identifier is reused', async () => {
		const { database, sources, reader } = await fixture(1);
		const window = await open(reader, sources.parent);
		await database
			.update(schema.listingAdoptionParent)
			.set({ generation: narInfoGenerationSchema.parse(4) });
		expect(await reader.page(window)).toStrictEqual({ kind: 'obsolete' });
	});
	it('rejects a listing window after its immutable fact is removed', async () => {
		const { database, sources, reader } = await fixture(1);
		const window = await open(reader, sources.listing);
		await database.delete(schema.listingFact);
		expect(await reader.page(window)).toStrictEqual({ kind: 'obsolete' });
	});
	it.each([
		'missing object',
		'pending registry',
		'different object incarnation',
		'different registry incarnation',
		'repaired incarnation'
	] as const)('rejects an old CAS window with %s', async (condition) => {
		const { database, sources, reader } = await fixture(1);
		const window = await open(reader, sources.cas);
		switch (condition) {
			case 'missing object': {
				await database.delete(schema.casObject);
				break;
			}
			case 'pending registry': {
				await database
					.update(schema.objectIncarnation)
					.set({ state: 'pending' });
				break;
			}
			case 'different object incarnation': {
				await database.update(schema.casObject).set({ incarnation: 3 });
				break;
			}
			case 'different registry incarnation': {
				await database.update(schema.objectIncarnation).set({ incarnation: 3 });
				break;
			}
			case 'repaired incarnation': {
				await database.update(schema.casObject).set({ incarnation: 3 });
				await database.update(schema.objectIncarnation).set({ incarnation: 3 });
				break;
			}
		}

		expect({
			page: await reader.page(window),
			reopen: await reader.open(sources.cas)
		}).toStrictEqual({ page: { kind: 'obsolete' }, reopen: { kind: 'empty' } });
	});
	it.each(['parent', 'listing', 'cas'] as const)(
		'pauses %s discovery when capture readiness is lost',
		async (kind) => {
			const { database, sources, reader } = await fixture(1);
			const window = await open(reader, sources[kind]);
			await database
				.update(schema.listingAdoptionCaptureState)
				.set({ isReady: false });
			expect({
				page: await reader.page(window),
				reopen: await reader.open(sources[kind])
			}).toStrictEqual({
				page: { kind: 'unavailable' },
				reopen: { kind: 'unavailable' }
			});
		}
	);
	it('keeps CAS discovery independent of unexpanded parent storage', async () => {
		const { database, sources, reader } = await fixture(1);
		await database
			.delete(schema.deploymentTransition)
			.where(eq(schema.deploymentTransition.id, 'listing-adoption-parents'));
		const original = env.CUPBOARD_DB.prepare.bind(env.CUPBOARD_DB);
		const access = vi
			.spyOn(env.CUPBOARD_DB, 'prepare')
			.mockImplementation((query) => {
				if (query.includes('"listing_adoption_parent"')) {
					throw new Error('Unexpanded parent storage was prepared');
				}
				return original(query);
			});
		try {
			expect({
				parent: await reader.open(sources.parent),
				listing: await reader.open(sources.listing),
				cas: await reader.open(sources.cas)
			}).toStrictEqual({
				parent: { kind: 'unavailable' },
				listing: { kind: 'unavailable' },
				cas: {
					kind: 'window',
					window: { kind: 'cas', digest, incarnation: 2, through: identity(1) }
				}
			});
		} finally {
			access.mockRestore();
		}
	});
	it('waits for capture storage before preparing it', async () => {
		const { database, sources, reader } = await fixture(1);
		await database
			.delete(schema.deploymentTransition)
			.where(eq(schema.deploymentTransition.id, 'listing-adoption-capture'));
		const original = env.CUPBOARD_DB.prepare.bind(env.CUPBOARD_DB);
		const access = vi
			.spyOn(env.CUPBOARD_DB, 'prepare')
			.mockImplementation((query) => {
				if (query.includes('"listing_adoption_capture_state"')) {
					throw new Error('Unexpanded capture storage was prepared');
				}
				return original(query);
			});
		try {
			expect(await reader.open(sources.cas)).toStrictEqual({
				kind: 'unavailable'
			});
		} finally {
			access.mockRestore();
		}
	});
	it('uses no NAR or listing payload I/O for source fan-out', async () => {
		const { sources, reader } = await fixture(1);
		const get = vi
			.spyOn(env.BLOBS, 'get')
			.mockRejectedValue(new Error('Unexpected payload read'));
		const head = vi
			.spyOn(env.BLOBS, 'head')
			.mockRejectedValue(new Error('Unexpected object access'));
		try {
			for (const source of Object.values(sources)) {
				await reader.page(await open(reader, source));
			}
			expect({ get: get.mock.calls, head: head.mock.calls }).toStrictEqual({
				get: [],
				head: []
			});
		} finally {
			get.mockRestore();
			head.mockRestore();
		}
	});
	it('reports storage errors without treating them as an empty expansion', async () => {
		const { sources, reader } = await fixture(1);
		const access = vi
			.spyOn(env.CUPBOARD_DB, 'prepare')
			.mockImplementation(() => {
				throw new Error('D1 unavailable');
			});
		try {
			await expect(reader.open(sources.listing)).rejects.toBeInstanceOf(
				SharedFactsUnavailableError
			);
		} finally {
			access.mockRestore();
		}
	});
	it.each(['parent', 'listing', 'cas'] as const)(
		'rejects a %s cursor beyond its boundary',
		async (kind) => {
			const { sources, reader } = await fixture(1);
			const window = await open(reader, sources[kind]);
			const invalid =
				window.kind === 'parent'
					? { ...window, after: 'b', through: 'a' }
					: window.kind === 'listing'
						? { ...window, after: '1'.repeat(32), through: '0'.repeat(32) }
						: {
								...window,
								after: { narHash, generatorRevision: 'b' },
								through: { narHash, generatorRevision: 'a' }
							};
			const result = listingAdoptionExpansionWindowSchema.safeParse(invalid);
			expect(
				result.success
					? { kind: 'accepted' }
					: {
							kind: 'invalid',
							paths: result.error.issues.map((issue) => issue.path)
						}
			).toStrictEqual({ kind: 'invalid', paths: [['after']] });
		}
	);

	it.each([
		{ kind: 'parent', stage: 'boundary' },
		{ kind: 'parent', stage: 'page' },
		{ kind: 'cas', stage: 'boundary' },
		{ kind: 'cas', stage: 'page' }
	] as const)(
		'reports malformed persisted $kind $stage data as a storage error',
		async ({ kind, stage }) => {
			const { database, sources, reader } = await fixture(1);
			await database.insert(schema.listingFact).values({
				...fact(1),
				generatorRevision:
					stage === 'boundary' ? sql`'zz invalid'` : sql`'bad revision'`,
				createdAt: now
			});
			if (stage === 'boundary') {
				await expect(reader.open(sources[kind])).rejects.toBeInstanceOf(
					SharedFactsUnavailableError
				);
				return;
			}
			const window = await open(reader, sources[kind]);
			await expect(reader.page(window)).rejects.toBeInstanceOf(
				SharedFactsUnavailableError
			);
		}
	);

	it.each(['parent', 'listing', 'cas'] as const)(
		'resumes a SQL JSON %s window in another discovery instance',
		async (kind) => {
			const { database, sources, reader } = await fixture();
			const first = await reader.page(await open(reader, sources[kind]));
			if (first.kind !== 'page') {
				throw new Error('The first expansion page is unavailable');
			}
			const encoded = JSON.stringify(first.page.window);
			const stored = await env.CUPBOARD_DB.prepare('SELECT json(?) AS document')
				.bind(encoded)
				.first<string>('document');
			const window = listingAdoptionExpansionWindowSchema.parse(
				JSON.parse(z.string().parse(stored))
			);
			const restarted = await new ListingAdoptionExpansionDiscovery(
				database
			).page(window);
			const next = await reader.page(first.page.window);
			expect(restarted).toStrictEqual(next);
		}
	);

	it.each(['parent', 'listing', 'cas'] as const)(
		'keeps late %s candidates outside the captured window',
		async (kind) => {
			const { database, sources, reader, cache } = await fixture(1);
			const firstId = listingAdoptionParentIdSchema.parse('1'.repeat(32));
			await database.update(schema.listingAdoptionParent).set({ id: firstId });
			const window = await open(reader, sources[kind]);
			if (kind === 'listing') {
				await database.insert(schema.listingAdoptionParent).values({
					id: listingAdoptionParentIdSchema.parse('2'.repeat(32)),
					tenant,
					...cacheIdentityColumns(cache),
					cacheGeneration: cacheGenerationSchema.parse(1),
					storePathHash: storePathHashSchema.parse('2'.repeat(32)),
					generation: narInfoGenerationSchema.parse(3),
					narHash,
					updatedAt: now
				});
			}
			if (kind !== 'listing') {
				await new ListingFactStore(database).record(fact(2));
				await new ListingFactStore(database).record({
					...fact(1),
					narHash: sharedNarSource(2).narHash
				});
			}
			const result = await reader.page(window);
			if (result.kind !== 'page') {
				throw new Error('The captured fan-out page is unavailable');
			}
			const identities =
				result.page.kind === 'cas'
					? result.page.identities
					: result.page.targets.map((target) => target.identity);
			expect({
				kind: result.page.kind,
				scanned: result.page.scanned,
				isComplete: result.page.isComplete,
				identities,
				after: result.page.window.after,
				through: result.page.window.through
			}).toStrictEqual({
				kind,
				scanned: 1,
				isComplete: true,
				identities: [identity(1)],
				after: window.through,
				through: window.through
			});
		}
	);

	it.each(['parent', 'listing', 'cas'] as const)(
		'bounds a full %s page across 25,000 candidates',
		async (kind) => {
			const { sources } = await fixture(17);
			await env.CUPBOARD_DB.prepare(
				"WITH RECURSIVE numbered(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM numbered WHERE value<25000) INSERT INTO listing_fact (nar_hash,generator_revision,format,digest,size,created_at) SELECT ?,'history-scale-'||printf('%05d',value),1,?,10,? FROM numbered"
			)
				.bind(narHash, digest, now)
				.run();
			await env.CUPBOARD_DB.prepare(
				"WITH RECURSIVE numbered(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM numbered WHERE value<25000) INSERT INTO listing_adoption_parent (id,tenant,cache_kind,cache_generation,store_path_hash,generation,nar_hash,updated_at) SELECT printf('%032x',value),?,'default',1,printf('%032d',value+1000),3,?,? FROM numbered"
			)
				.bind(tenant, narHash, now)
				.run();
			const statements: { query: string; parameters: unknown[] }[] = [];
			const database = drizzle(env.CUPBOARD_DB, {
				schema,
				logger: {
					logQuery(query, parameters) {
						statements.push({ query, parameters });
					}
				}
			});
			const reader = new ListingAdoptionExpansionDiscovery(database);
			const initial = await open(reader, sources[kind]);
			const first = await reader.page(initial);
			if (first.kind !== 'page') {
				throw new Error('The initial fan-out page is unavailable');
			}
			statements.length = 0;
			const result = await reader.page(first.page.window);
			if (result.kind !== 'page') {
				throw new Error('The next fan-out page is unavailable');
			}
			let reads = 0;
			for (const statement of statements) {
				const parameters = z
					.array(z.union([z.string(), z.number()]))
					.parse(statement.parameters);
				const measured = await env.CUPBOARD_DB.prepare(statement.query)
					.bind(...parameters)
					.all();
				reads += measured.meta.rows_read;
			}
			const selected = statements.find((statement) =>
				statement.query.includes(' order by ')
			);
			if (selected === undefined) {
				throw new Error('The bounded fan-out query was not recorded');
			}
			const parameters = z
				.array(z.union([z.string(), z.number()]))
				.parse(selected.parameters);
			const plan = await env.CUPBOARD_DB.prepare(
				`EXPLAIN QUERY PLAN ${selected.query}`
			)
				.bind(...parameters)
				.all<{ detail: string }>();
			const index =
				kind === 'parent'
					? 'sqlite_autoindex_listing_fact_1'
					: kind === 'listing'
						? 'listing_adoption_parent_nar_id_idx'
						: 'listing_adoption_fact_digest_identity_idx';
			const identities =
				result.page.kind === 'cas'
					? result.page.identities
					: result.page.targets.map((target) => target.identity);
			expect({
				kind: result.page.kind,
				scanned: result.page.scanned,
				isComplete: result.page.isComplete,
				nars: identities.map((identity) => identity.narHash),
				boundedReads: reads > 0 && reads <= 128,
				parametersBounded: statements.every(
					(statement) => statement.parameters.length <= 100
				),
				sqlBytesBounded: statements.every(
					(statement) =>
						new TextEncoder().encode(statement.query).byteLength <= 100_000
				),
				isIndexed: plan.results.some(
					({ detail }) => detail.includes('SEARCH ') && detail.includes(index)
				)
			}).toStrictEqual({
				kind,
				scanned: 32,
				isComplete: false,
				nars: Array.from({ length: 32 }, () => narHash),
				boundedReads: true,
				parametersBounded: true,
				sqlBytesBounded: true,
				isIndexed: true
			});
		}
	);

	it.each(['default', 'named'] as const)(
		'pages listing parents in a fixed %s window',
		async (kind) => {
			const { database, sources, reader } = await fixture(65, kind);
			const parents = await database
				.select({ id: schema.listingAdoptionParent.id })
				.from(schema.listingAdoptionParent)
				.orderBy(asc(schema.listingAdoptionParent.id));
			const initial = await open(reader, sources.listing);
			const pages = [];
			let window = initial;
			for (let turn = 0; turn < 3; turn++) {
				const result = await reader.page(window);
				if (result.kind !== 'page' || result.page.kind !== 'listing') {
					throw new Error('The listing expansion page is unavailable');
				}
				pages.push({
					scanned: result.page.scanned,
					isComplete: result.page.isComplete,
					ids: result.page.targets.map((target) => target.parent.id),
					identities: result.page.targets.map((target) => target.identity)
				});
				window = result.page.window;
			}
			expect({
				pages,
				after: window.after,
				through: window.through
			}).toStrictEqual({
				pages: [0, 32, 64].map((offset) => ({
					scanned: offset === 64 ? 1 : 32,
					isComplete: offset === 64,
					ids: parents.slice(offset, offset + 32).map((parent) => parent.id),
					identities: parents
						.slice(offset, offset + 32)
						.map(() => sources.listing.identity)
				})),
				after: parents[64]?.id,
				through: parents[64]?.id
			});
		}
	);
	it.each(['default', 'named'] as const)(
		'refreshes a %s parent and pages its listing revisions',
		async (kind) => {
			const { database, sources, reader } = await fixture(65, kind);
			await database.delete(schema.listingAdoptionParent);
			let window = await open(reader, sources.parent);
			const revisions = [];
			for (let turn = 0; turn < 3; turn++) {
				const result = await reader.page(window);
				if (result.kind !== 'page' || result.page.kind !== 'parent') {
					throw new Error('The parent expansion page is unavailable');
				}
				revisions.push(
					result.page.targets.map((target) => target.identity.generatorRevision)
				);
				window = result.page.window;
			}
			expect({
				revisions,
				after: window.after,
				through: window.through
			}).toStrictEqual({
				revisions: [0, 32, 64].map((offset) =>
					Array.from(
						{ length: offset === 64 ? 1 : 32 },
						(_, index) => fact(offset + index + 1).generatorRevision
					)
				),
				after: fact(65).generatorRevision,
				through: fact(65).generatorRevision
			});
		}
	);
	it('pages repaired CAS facts without enumerating their parents', async () => {
		const { sources, reader } = await fixture();
		let window = await open(reader, sources.cas);
		const pages = [];
		for (let turn = 0; turn < 3; turn++) {
			const result = await reader.page(window);
			if (result.kind !== 'page' || result.page.kind !== 'cas') {
				throw new Error('The CAS expansion page is unavailable');
			}
			pages.push(result.page.identities);
			window = result.page.window;
		}
		expect({
			pages,
			after: window.after,
			through: window.through
		}).toStrictEqual({
			pages: [0, 32, 64].map((offset) =>
				Array.from({ length: offset === 64 ? 1 : 32 }, (_, index) =>
					identity(offset + index + 1)
				)
			),
			after: identity(65),
			through: identity(65)
		});
	});
	it.each(['parent', 'listing', 'cas'] as const)(
		'completes an empty %s expansion without inventing targets',
		async (kind) => {
			const { sources, reader } = await fixture(0);
			expect(await reader.open(sources[kind])).toStrictEqual({ kind: 'empty' });
		}
	);
});
