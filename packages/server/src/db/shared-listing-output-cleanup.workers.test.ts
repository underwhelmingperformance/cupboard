import {
	nixSha256HashSchema,
	sha256HexDigestSchema
} from '@cupboard/nix-store/scalars';
import { artifactTaskOwnerSchema } from '@cupboard/protocol/artifact-jobs';
import { listingGeneratorRevisionSchema } from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { CasObjectStore } from '../blob/cas-object-store.ts';
import type { SharedListingOutputCleanupClaimResult } from '../blob/shared-listing-output-cleanup.ts';
import { sharedListingOutputEpochSchema } from '../blob/shared-listing-outputs.ts';
import { sha256HexBytes } from '../crypto/crypto.ts';
import { SharedFactsUnavailableError } from '../errors.ts';

import * as schema from './d1-schema.ts';
import { SharedListingOutputCleanupStore } from './shared-listing-output-cleanup.ts';
import { sharedNarDiscoveryFixture } from './shared-nar-discovery.test-support.ts';

const now = isoTimestamp(new Date('2026-01-01T00:00:00.000Z'));
const later = isoTimestamp(new Date('2026-01-01T00:00:10.000Z'));
const deadline = isoTimestamp(new Date('2026-01-01T00:00:30.000Z'));
const owner = artifactTaskOwnerSchema.parse(
	'00000000-0000-4000-8000-000000000001'
);
const otherOwner = artifactTaskOwnerSchema.parse(
	'00000000-0000-4000-8000-000000000002'
);
function claimed(result: SharedListingOutputCleanupClaimResult) {
	if (result.kind !== 'claimed') {
		throw new Error(`Expected cleanup ownership, received ${result.kind}`);
	}
	return result.claim;
}
async function fixture(count = 19) {
	const { database, sources } = await sharedNarDiscoveryFixture();
	const source = sources[0];
	if (source === undefined) {
		throw new Error('The retained NAR is missing');
	}
	const parents = await database.select().from(schema.blobReference);
	const bytes = new TextEncoder().encode('retained listing');
	const digest = sha256HexDigestSchema.parse(await sha256HexBytes(bytes));
	const cas = new CasObjectStore(database, env.BLOBS);
	const incarnation = await cas.promote({
		digest,
		size: bytes.byteLength,
		bytes
	});
	await database.update(schema.casObject).set({ deleteAfter: now });
	const references = Array.from({ length: count }, (_, index) => ({
		narHash: source.narHash,
		generatorRevision: listingGeneratorRevisionSchema.parse(
			`nix-v1-r${String(index + 1).padStart(6, '0')}`
		),
		epoch: sharedListingOutputEpochSchema.parse(crypto.randomUUID()),
		sourceIncarnation: source.sourceIncarnation,
		computationGeneration: 1,
		digest,
		size: bytes.byteLength,
		createdAt: now
	}));
	for (let offset = 0; offset < references.length; offset += 8) {
		await database
			.insert(schema.sharedListingOutputReference)
			.values(references.slice(offset, offset + 8));
	}
	const store = new SharedListingOutputCleanupStore(database);
	const retireParent = async () => {
		await database
			.delete(schema.blobReference)
			.where(eq(schema.blobReference.narHash, source.narHash));
		await database
			.update(schema.sharedListingOutputCleanup)
			.set({ nextAttemptAt: now })
			.where(eq(schema.sharedListingOutputCleanup.narHash, source.narHash));
	};
	const remaining = () =>
		database
			.select()
			.from(schema.sharedListingOutputReference)
			.orderBy(schema.sharedListingOutputReference.generatorRevision);
	return {
		database,
		narHash: source.narHash,
		parents,
		references,
		cas,
		digest,
		incarnation,
		store,
		retireParent,
		remaining
	};
}

describe('bounded shared output retirement', () => {
	it('replays a live claim and defers another owner without extending the deadline', async () => {
		const { store, narHash, retireParent } = await fixture();
		await retireParent();
		const first = claimed(await store.claim(narHash, owner, now));
		expect({
			first,
			replay: await store.claim(narHash, owner, later),
			contender: await store.claim(narHash, otherOwner, later)
		}).toStrictEqual({
			first: {
				narHash,
				epoch: first.epoch,
				cursor: undefined,
				owner,
				leaseExpiresAt: deadline
			},
			replay: { kind: 'claimed', claim: first },
			contender: { kind: 'deferred', retryAt: deadline }
		});
	});

	it('drains fixed pages with durable checkpoints and leaves CAS bytes for normal collection', async () => {
		const {
			database,
			store,
			narHash,
			retireParent,
			references,
			remaining,
			cas,
			digest,
			incarnation
		} = await fixture();
		await retireParent();
		const first = claimed(await store.claim(narHash, owner, now));
		const page = await store.drain(first, now);
		const afterFirst = await remaining();
		const replay = await store.drain(first, now);
		const next = claimed(
			await new SharedListingOutputCleanupStore(database).claim(
				narHash,
				otherOwner,
				later
			)
		);
		const second = await store.drain(next, later);
		const last = claimed(await store.claim(narHash, owner, later));
		const final = await store.drain(last, later);
		const grace = await database
			.select({ at: schema.casObject.deleteAfter })
			.from(schema.casObject);
		expect({
			page,
			afterFirst,
			replay,
			cursor: next.cursor,
			second,
			final,
			remaining: await remaining(),
			headers: await database.select().from(schema.sharedListingOutputCleanup),
			available: await cas.reuse(digest, incarnation),
			grace: grace.map((row) => ({ at: row.at ?? undefined }))
		}).toStrictEqual({
			page: { kind: 'drained', removed: 8, hasMore: true },
			afterFirst: references.slice(8),
			replay: { kind: 'unavailable' },
			cursor: references[7]?.generatorRevision,
			second: { kind: 'drained', removed: 8, hasMore: true },
			final: { kind: 'drained', removed: 3, hasMore: false },
			remaining: [],
			headers: [],
			available: true,
			grace: [{ at: undefined }]
		});
	});

	it.each([owner, otherOwner])(
		'fences expired ownership after takeover by %s',
		async (replacementOwner) => {
			const { store, narHash, retireParent } = await fixture();
			await retireParent();
			const old = claimed(await store.claim(narHash, owner, now));
			const next = claimed(
				await store.claim(narHash, replacementOwner, deadline)
			);
			expect({
				old: await store.drain(old, deadline),
				current: await store.drain(next, deadline)
			}).toStrictEqual({
				old: { kind: 'unavailable' },
				current: { kind: 'drained', removed: 8, hasMore: true }
			});
		}
	);

	it('discards an obsolete cleanup scope when the logical parent returns', async () => {
		const {
			database,
			store,
			narHash,
			retireParent,
			parents,
			references,
			remaining
		} = await fixture();
		await retireParent();
		const claim = claimed(await store.claim(narHash, owner, now));
		await database.insert(schema.blobReference).values(parents);
		expect({
			result: await store.drain(claim, now),
			references: await remaining(),
			scopes: await database.select().from(schema.sharedListingOutputCleanup)
		}).toStrictEqual({
			result: { kind: 'drained', removed: 0, hasMore: false },
			references,
			scopes: []
		});
	});

	it('cannot clear a restarted scope after parent recreation and removal', async () => {
		const {
			database,
			store,
			narHash,
			retireParent,
			parents,
			references,
			remaining
		} = await fixture();
		await retireParent();
		const old = claimed(await store.claim(narHash, owner, now));
		await database.insert(schema.blobReference).values(parents);
		await retireParent();
		const next = claimed(await store.claim(narHash, otherOwner, now));
		expect({
			epochChanged: old.epoch !== next.epoch,
			old: await store.drain(old, now),
			references: await remaining()
		}).toStrictEqual({
			epochChanged: true,
			old: { kind: 'unavailable' },
			references
		});
	});

	it('rolls back grace, references and the checkpoint if removal fails', async () => {
		const { database, store, narHash, retireParent, references, remaining } =
			await fixture();
		await retireParent();
		const claim = claimed(await store.claim(narHash, owner, now));
		const scope = await database
			.select()
			.from(schema.sharedListingOutputCleanup);
		await database.run(
			sql`CREATE TRIGGER reject_output_retirement BEFORE DELETE ON shared_listing_output_ref BEGIN SELECT RAISE(ABORT, 'injected output retirement failure'); END`
		);
		try {
			await expect(store.drain(claim, now)).rejects.toBeInstanceOf(
				SharedFactsUnavailableError
			);
			const grace = await database
				.select({ at: schema.casObject.deleteAfter })
				.from(schema.casObject);
			expect({
				references: await remaining(),
				scopes: await database.select().from(schema.sharedListingOutputCleanup),
				grace
			}).toStrictEqual({ references, scopes: scope, grace: [{ at: now }] });
		} finally {
			await database.run(sql`DROP TRIGGER reject_output_retirement`);
		}
		expect(await store.drain(claim, now)).toStrictEqual({
			kind: 'drained',
			removed: 8,
			hasMore: true
		});
	});

	it('walks a finite due wave without advancing unclaimed scopes', async () => {
		const { database, store, retireParent } = await fixture();
		await retireParent();
		const hashes = Array.from({ length: 19 }, (_, index) =>
			nixSha256HashSchema.parse(`sha256:${String(index).padStart(52, '0')}`)
		);
		for (const narHash of hashes.slice(1)) {
			await database
				.insert(schema.sharedListingOutputCleanup)
				.values({ narHash, nextAttemptAt: now });
		}
		await database.insert(schema.sharedListingOutputCleanup).values({
			narHash: nixSha256HashSchema.parse(`sha256:${'9'.repeat(52)}`),
			nextAttemptAt: later
		});
		const first = await store.due(now);
		const replay = await store.due(now);
		const second = await store.due(now, first.next);
		const third = await store.due(now, second.next);
		expect({
			first: first.parents,
			replay,
			second: second.parents,
			third
		}).toStrictEqual({
			first: hashes.slice(0, 8),
			replay: first,
			second: hashes.slice(8, 16),
			third: { parents: hashes.slice(16) }
		});
	});

	it('returns absence for an unknown cleanup scope', async () => {
		const { store, narHash } = await fixture();
		expect(await store.claim(narHash, owner, now)).toStrictEqual({
			kind: 'absent'
		});
	});

	it.each(['returned', 'restarted'] as const)(
		'rechecks a %s parent between page capture and the mutation batch',
		async (change) => {
			const {
				database,
				store,
				narHash,
				retireParent,
				parents,
				references,
				remaining
			} = await fixture();
			await retireParent();
			const claim = claimed(await store.claim(narHash, owner, now));
			const execute = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
			async function inject<T>(
				statements: D1PreparedStatement[]
			): Promise<D1Result<T>[]> {
				await database.insert(schema.blobReference).values(parents);
				if (change === 'restarted') {
					await retireParent();
				}
				return execute<T>(statements);
			}
			const batch = vi
				.spyOn(env.CUPBOARD_DB, 'batch')
				.mockImplementationOnce(inject);
			try {
				const result = await store.drain(claim, now);
				expect({ result, references: await remaining() }).toStrictEqual({
					result:
						change === 'returned'
							? { kind: 'drained', removed: 0, hasMore: false }
							: { kind: 'unavailable' },
					references
				});
			} finally {
				batch.mockRestore();
			}
		}
	);

	it('bounds retirement reads after thousands of unrelated references to the same digest', async () => {
		const { database, narHash, retireParent, digest } = await fixture(1);
		await database.run(sql`WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM rows WHERE n < 2048)
   INSERT INTO shared_listing_output_ref(nar_hash,generator_revision,epoch,source_incarnation,computation_generation,digest,size,created_at)
   SELECT 'sha256:' || printf('%052d',n), 'nix-v1-r000001', '00000000-0000-4000-8000-000000000001', 2, 1, ${digest}, 16, ${now} FROM rows`);
		await database.run(sql`WITH RECURSIVE rows(n) AS (VALUES(2) UNION ALL SELECT n+1 FROM rows WHERE n < 2048)
   INSERT INTO shared_listing_output_ref(nar_hash,generator_revision,epoch,source_incarnation,computation_generation,digest,size,created_at)
   SELECT ${narHash}, 'nix-v1-r' || printf('%06d',n), '00000000-0000-4000-8000-000000000001', 2, 1, ${digest}, 16, ${now} FROM rows`);
		const cursor = listingGeneratorRevisionSchema.parse('nix-v1-r002000');
		await database
			.delete(schema.sharedListingOutputReference)
			.where(
				sql`${schema.sharedListingOutputReference.narHash} = ${narHash} AND ${schema.sharedListingOutputReference.generatorRevision} <= ${cursor}`
			);
		await retireParent();
		await database.update(schema.sharedListingOutputCleanup).set({ cursor });
		const statements: { query: string; parameters: unknown[] }[] = [];
		const measuredStore = new SharedListingOutputCleanupStore(
			drizzle(env.CUPBOARD_DB, {
				schema,
				logger: {
					logQuery(query, parameters) {
						statements.push({ query, parameters });
					}
				}
			})
		);
		const claim = claimed(await measuredStore.claim(narHash, owner, now));
		statements.length = 0;
		const reads: number[] = [];
		const writes: number[] = [];
		const execute = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		async function measure<T>(
			batch: D1PreparedStatement[]
		): Promise<D1Result<T>[]> {
			const page = statements[0];
			if (page === undefined) {
				throw new Error('The retirement page query is missing');
			}
			const parameters = z
				.array(z.union([z.string(), z.number()]))
				.parse(page.parameters);
			const selection = await env.CUPBOARD_DB.prepare(page.query)
				.bind(...parameters)
				.all();
			reads.push(selection.meta.rows_read);
			const results = await execute<T>(batch);
			reads.push(...results.map((row) => row.meta.rows_read));
			writes.push(...results.map((row) => row.meta.rows_written));
			return results;
		}
		const batch = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementationOnce(measure);
		try {
			const result = await measuredStore.drain(claim, now);
			expect({
				result,
				boundedReads: reads.map((value) => value <= 512),
				boundedWrites: writes.map((value) => value <= 64),
				remaining: await database.get<{ count: number }>(
					sql`SELECT count(*) AS count FROM shared_listing_output_ref WHERE nar_hash = ${narHash}`
				)
			}).toStrictEqual({
				result: { kind: 'drained', removed: 8, hasMore: true },
				boundedReads: [true, true, true, true, true],
				boundedWrites: [true, true, true, true],
				remaining: { count: 40 }
			});
		} finally {
			batch.mockRestore();
		}
	});

	it('seeks due scopes past thousands of older unclaimed rows', async () => {
		const { database } = await fixture();
		await database.run(sql`WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM rows WHERE n < 4000)
   INSERT INTO shared_listing_output_cleanup(nar_hash,next_attempt_at) SELECT 'sha256:' || printf('%052d',n), ${now} FROM rows`);
		const statements: { query: string; parameters: unknown[] }[] = [];
		const store = new SharedListingOutputCleanupStore(
			drizzle(env.CUPBOARD_DB, {
				schema,
				logger: {
					logQuery(query, parameters) {
						statements.push({ query, parameters });
					}
				}
			})
		);
		const result = await store.due(now, {
			at: now,
			narHash: nixSha256HashSchema.parse(
				`sha256:${String(2999).padStart(52, '0')}`
			)
		});
		const statement = statements[0];
		if (statement === undefined) {
			throw new Error('The due scope query is missing');
		}
		const parameters = z
			.array(z.union([z.string(), z.number()]))
			.parse(statement.parameters);
		const measured = await env.CUPBOARD_DB.prepare(statement.query)
			.bind(...parameters)
			.all();
		expect({
			result,
			boundedReads: measured.meta.rows_read <= 20
		}).toStrictEqual({
			result: {
				parents: Array.from(
					{ length: 8 },
					(_, index) => `sha256:${String(3000 + index).padStart(52, '0')}`
				),
				next: { at: now, narHash: `sha256:${String(3007).padStart(52, '0')}` }
			},
			boundedReads: true
		});
	});

	it('timestamps new scopes with the D1 clock so older sweeps exclude them', async () => {
		const { database, store } = await fixture();
		const before = await store.cutoff();
		const cutoff = isoTimestamp(new Date(Date.parse(before) - 1));
		await database.delete(schema.blobReference);
		const scopes = await database
			.select()
			.from(schema.sharedListingOutputCleanup);
		const after = await store.cutoff();
		expect({
			captureTime: scopes.map(
				(row) => row.nextAttemptAt >= before && row.nextAttemptAt <= after
			),
			oldWave: await store.due(cutoff)
		}).toStrictEqual({ captureTime: [true], oldWave: { parents: [] } });
	});
});
