import { sha256HexDigestSchema } from '@cupboard/nix-store/scalars';
import {
	nixSha256HashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { artifactTaskOwnerSchema } from '@cupboard/protocol/artifact-jobs';
import { currentListingGeneratorRevision } from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CasObjectStore } from '../blob/cas-object-store.ts';
import { drainObjectDeletions } from '../blob/object-incarnation-recovery.ts';
import type { SharedListingOutputReference } from '../blob/shared-listing-outputs.ts';
import { sha256HexBytes } from '../crypto/crypto.ts';
import { buildCasCollection } from '../do/blob-reaper-service.ts';
import { jsonValueList } from '../do/json-list.ts';
import { ListingFactConflictError } from '../errors.ts';
import { casObjectKey } from '../http/http.ts';

import { CasReferenceSet, readCasReferenceSet } from './cas-reference-set.ts';
import * as schema from './d1-schema.ts';
import { ListingFactStore } from './listing-facts.ts';
import { SharedListingGenerationStore } from './shared-listing-generation.ts';
import { SharedListingJobStore } from './shared-listing-jobs.ts';
import { SharedListingOutputStore } from './shared-listing-outputs.ts';
import { SharedListingTaskStore } from './shared-listing-tasks.ts';
import { sharedNarDiscoveryFixture } from './shared-nar-discovery.test-support.ts';

const now = isoTimestamp(new Date('2026-01-01T00:00:00.000Z'));
const later = isoTimestamp(new Date('2026-01-01T00:00:30.000Z'));
const owner = artifactTaskOwnerSchema.parse(
	'00000000-0000-4000-8000-000000000001'
);

async function fixture() {
	const { database } = await sharedNarDiscoveryFixture();
	const jobs = new SharedListingJobStore(database);
	const tasks = new SharedListingTaskStore(database);
	const job = await jobs.start(currentListingGeneratorRevision, now);
	const discovery = await jobs.claim(job, owner, now);
	if (discovery.kind !== 'claimed') {
		throw new Error('Discovery ownership was not granted');
	}
	await jobs.discover(discovery.claim);
	const row = await database.select().from(schema.sharedListingTask).get();
	if (row === undefined) {
		throw new Error('The discovered task is missing');
	}
	const task = await tasks.claim(
		{ job: { id: job.id, generation: job.generation }, id: row.id, owner },
		now
	);
	if (task.kind !== 'claimed') {
		throw new Error('Task ownership was not granted');
	}
	const generation = new SharedListingGenerationStore(database);
	const computation = await generation.claim(task.claim, now);
	if (computation.kind !== 'claimed') {
		throw new Error('Computation ownership was not granted');
	}
	const bytes = new TextEncoder().encode('shared listing');
	const digest = sha256HexDigestSchema.parse(await sha256HexBytes(bytes));
	const cas = new CasObjectStore(database, env.BLOBS);
	const incarnation = await cas.promote({
		digest,
		size: bytes.byteLength,
		bytes
	});
	const fact = {
		narHash: task.claim.narHash,
		generatorRevision: currentListingGeneratorRevision,
		format: 1 as const,
		digest,
		size: bytes.byteLength
	};
	return {
		database,
		jobs,
		job,
		generation,
		claim: computation.claim,
		cas,
		bytes,
		incarnation,
		fact,
		store: new SharedListingOutputStore(database)
	};
}

function retained(reference: SharedListingOutputReference | undefined) {
	if (reference === undefined) {
		throw new Error('The output reference is missing');
	}
	return reference;
}
async function probe(
	database: Awaited<ReturnType<typeof fixture>>['database'],
	references: CasReferenceSet,
	digest: Awaited<ReturnType<typeof fixture>>['fact']['digest'],
	tenant?: ReturnType<typeof tenantIdSchema.parse>
) {
	return database.get<{ missing: number }>(
		sql`SELECT CASE WHEN ${references.unreferenced(digest, tenant)} THEN 1 ELSE 0 END AS missing`
	);
}

describe('shared listing output retention', () => {
	it('retains measured output under its logical NAR without tenant authority or quota', async () => {
		const { database, store, claim, fact, incarnation } = await fixture();
		const reference = retained(
			await store.retain(claim, fact, incarnation, now)
		);
		expect({
			reference,
			tenantReferences: await database.select().from(schema.artifactReference),
			tenantPresence: await database.select().from(schema.tenantCasBlob)
		}).toStrictEqual({
			reference: {
				narHash: fact.narHash,
				generatorRevision: fact.generatorRevision,
				epoch: reference.epoch,
				sourceIncarnation: claim.task.sourceIncarnation,
				computationGeneration: claim.generation,
				digest: fact.digest,
				size: fact.size,
				createdAt: now
			},
			tenantReferences: [],
			tenantPresence: []
		});
	});
	it('replays the same captured reference after a lost reply', async () => {
		const { database, store, claim, fact, incarnation } = await fixture();
		const first = await store.retain(claim, fact, incarnation, now);
		expect(first).toBeDefined();
		expect(
			await new SharedListingOutputStore(database).retain(
				claim,
				fact,
				incarnation,
				later
			)
		).toStrictEqual(first);
	});

	it('protects global bytes while allowing final tenant quota credit', async () => {
		const { database, store, claim, fact, incarnation } = await fixture();
		const references = new CasReferenceSet(database, 'all');
		const before = await probe(database, references, fact.digest);
		await store.retain(claim, fact, incarnation, now);
		expect({
			before,
			global: await probe(database, references, fact.digest),
			tenant: await probe(
				database,
				references,
				fact.digest,
				tenantIdSchema.parse('discovery-first')
			)
		}).toStrictEqual({
			before: { missing: 1 },
			global: { missing: 0 },
			tenant: { missing: 1 }
		});
	});

	it.each([
		'cancelled',
		'expired',
		'released',
		'source-changed',
		'unretained',
		'cas-pending',
		'cas-incarnation',
		'size',
		'identity'
	] as const)(
		'refuses a %s completion without installing a reference or clearing deletion grace',
		async (reason) => {
			const {
				database,
				jobs,
				job,
				generation,
				store,
				claim,
				fact,
				incarnation
			} = await fixture();
			await database.update(schema.casObject).set({ deleteAfter: later });
			switch (reason) {
				case 'cancelled': {
					await jobs.cancel(job, now);
					break;
				}
				case 'released': {
					await generation.release(claim, now);
					break;
				}
				case 'source-changed': {
					await database
						.update(schema.objectIncarnation)
						.set({ incarnation: 3 })
						.where(eq(schema.objectIncarnation.kind, 'nar'));
					break;
				}
				case 'unretained': {
					await database.delete(schema.blobReference);
					break;
				}
				case 'cas-pending': {
					await database
						.update(schema.objectIncarnation)
						.set({ state: 'pending' })
						.where(eq(schema.objectIncarnation.kind, 'cas'));
					break;
				}
				default: {
					break;
				}
			}
			const value =
				reason === 'identity'
					? {
							...fact,
							narHash: nixSha256HashSchema.parse(`sha256:${'1'.repeat(52)}`)
						}
					: reason === 'size'
						? { ...fact, size: fact.size + 1 }
						: fact;
			const result = await store.retain(
				claim,
				value,
				reason === 'cas-incarnation' ? incarnation + 1 : incarnation,
				reason === 'expired'
					? isoTimestamp(new Date('2026-01-01T00:01:00.000Z'))
					: now
			);
			const graceRows = await database
				.select({ at: schema.casObject.deleteAfter })
				.from(schema.casObject);
			expect({
				result,
				references: await database
					.select()
					.from(schema.sharedListingOutputReference),
				grace: graceRows.map((row) => ({ at: row.at ?? undefined }))
			}).toStrictEqual({
				result: undefined,
				references: [],
				grace: [{ at: later }]
			});
		}
	);

	it('coalesces concurrent reference creation and clears old deletion grace', async () => {
		const { database, store, claim, fact, incarnation } = await fixture();
		await database.update(schema.casObject).set({ deleteAfter: now });
		const results = await Promise.all([
			store.retain(claim, fact, incarnation, now),
			store.retain(claim, fact, incarnation, now)
		]);
		const reference = retained(results[0]);
		const graceRows = await database
			.select({ at: schema.casObject.deleteAfter })
			.from(schema.casObject);
		expect({
			results,
			references: await database
				.select()
				.from(schema.sharedListingOutputReference),
			grace: graceRows.map((row) => ({ at: row.at ?? undefined }))
		}).toStrictEqual({
			results: [reference, reference],
			references: [reference],
			grace: [{ at: undefined }]
		});
	});

	it.each(['fact', 'reference'] as const)(
		'rejects a conflicting immutable %s without changing bytes or retention',
		async (kind) => {
			const { database, store, claim, fact, incarnation } = await fixture();
			if (kind === 'fact') {
				await new ListingFactStore(database).record({
					...fact,
					size: fact.size + 1
				});
			} else {
				await store.retain(claim, fact, incarnation, now);
			}
			const before = await database
				.select()
				.from(schema.sharedListingOutputReference);
			const value = kind === 'fact' ? fact : { ...fact, size: fact.size + 1 };
			await expect(
				store.retain(claim, value, incarnation, later)
			).rejects.toBeInstanceOf(ListingFactConflictError);
			expect(
				await database.select().from(schema.sharedListingOutputReference)
			).toStrictEqual(before);
		}
	);

	it('rejects preceding fact writers after a shared reference records different bytes', async () => {
		const { database, store, claim, fact, incarnation } = await fixture();
		await store.retain(claim, fact, incarnation, now);
		await expect(
			database
				.insert(schema.listingFact)
				.values({ ...fact, size: fact.size + 1, createdAt: now })
		).rejects.toThrow();
		await new ListingFactStore(database).record(fact);
		await expect(
			database.update(schema.listingFact).set({ size: fact.size + 1 })
		).rejects.toThrow();
		expect(await new ListingFactStore(database).find(fact)).toStrictEqual(fact);
	});

	it('queues one durable parent cleanup scope and releases only after the last NAR reference', async () => {
		const { database, store, claim, fact, incarnation } = await fixture();
		const reference = retained(
			await store.retain(claim, fact, incarnation, now)
		);
		const parents = await database.select().from(schema.blobReference);
		const first = parents[0];
		if (first === undefined) {
			throw new Error('The NAR parent is missing');
		}
		await database
			.delete(schema.blobReference)
			.where(eq(schema.blobReference.tenant, first.tenant));
		expect({
			released: await store.releaseCaptured(reference),
			cleanup: await database.select().from(schema.sharedListingOutputCleanup)
		}).toStrictEqual({ released: false, cleanup: [] });
		await database.delete(schema.blobReference);
		const cleanup = await database
			.select()
			.from(schema.sharedListingOutputCleanup);
		const scope = cleanup[0];
		if (scope === undefined) {
			throw new Error('Parent retirement was not recorded');
		}
		expect({
			cleanup: cleanup.map((row) => ({
				...row,
				cursor: row.cursor ?? undefined,
				owner: row.owner ?? undefined,
				leaseExpiresAt: row.leaseExpiresAt ?? undefined
			})),
			references: await database
				.select()
				.from(schema.sharedListingOutputReference)
		}).toStrictEqual({
			cleanup: [
				{
					narHash: fact.narHash,
					epoch: scope.epoch,
					cursor: undefined,
					owner: undefined,
					leaseExpiresAt: undefined,
					nextAttemptAt: '1970-01-01T00:00:00.000Z'
				}
			],
			references: [reference]
		});
		expect({
			released: await store.releaseCaptured(reference),
			replay: await store.releaseCaptured(reference),
			global: await probe(
				database,
				new CasReferenceSet(database, 'all'),
				fact.digest
			)
		}).toStrictEqual({ released: true, replay: false, global: { missing: 1 } });
	});

	it('fences captured removal after parent recreation and a replacement output epoch', async () => {
		const { database, store, claim, fact, incarnation } = await fixture();
		const old = retained(await store.retain(claim, fact, incarnation, now));
		const parents = await database.select().from(schema.blobReference);
		await database.delete(schema.blobReference);
		const firstScope = await database
			.select()
			.from(schema.sharedListingOutputCleanup)
			.get();
		await database.insert(schema.blobReference).values(parents);
		expect(await store.releaseCaptured(old)).toBe(false);
		await database.delete(schema.blobReference);
		expect(await store.releaseCaptured(old)).toBe(true);
		await database.insert(schema.blobReference).values(parents);
		const replacement = retained(
			await store.retain(claim, fact, incarnation, later)
		);
		await database.delete(schema.blobReference);
		const nextScope = await database
			.select()
			.from(schema.sharedListingOutputCleanup)
			.get();
		expect({
			oldRelease: await store.releaseCaptured(old),
			epochChanged: old.epoch !== replacement.epoch,
			scopeChanged: firstScope?.epoch !== nextScope?.epoch,
			references: await database
				.select()
				.from(schema.sharedListingOutputReference)
		}).toStrictEqual({
			oldRelease: false,
			epochChanged: true,
			scopeChanged: true,
			references: [replacement]
		});
	});

	it.each(['arm', 'retire', 'metadata-delete', 'registry-delete'] as const)(
		'blocks a preceding collector %s while permitting the same operation after parent release',
		async (operation) => {
			const { database, store, claim, fact, incarnation } = await fixture();
			const reference = retained(
				await store.retain(claim, fact, incarnation, now)
			);
			const mutations = {
				arm: sql`UPDATE cas_object_storage SET delete_after = ${now} WHERE digest = ${fact.digest}`,
				retire: sql`UPDATE object_incarnation SET state = 'absent' WHERE kind = 'cas' AND object_id = ${fact.digest}`,
				'metadata-delete': sql`DELETE FROM cas_object_storage WHERE digest = ${fact.digest}`,
				'registry-delete': sql`DELETE FROM object_incarnation WHERE kind = 'cas' AND object_id = ${fact.digest}`
			};
			await database.run(mutations[operation]);
			const before = {
				state: await database.select().from(schema.casObject),
				registry: await database
					.select()
					.from(schema.objectIncarnation)
					.where(eq(schema.objectIncarnation.kind, 'cas'))
			};
			expect({
				state: before.state.map((row) => ({
					incarnation: row.incarnation,
					at: row.deleteAfter ?? undefined
				})),
				registry: before.registry.map((row) => ({
					incarnation: row.incarnation,
					state: row.state
				}))
			}).toStrictEqual({
				state: [{ incarnation, at: undefined }],
				registry: [{ incarnation, state: 'live' }]
			});
			await database.delete(schema.blobReference);
			await store.releaseCaptured(reference);
			await database.run(mutations[operation]);
			const after = {
				state: await database.select().from(schema.casObject),
				registry: await database
					.select()
					.from(schema.objectIncarnation)
					.where(eq(schema.objectIncarnation.kind, 'cas'))
			};
			expect(after).not.toStrictEqual(before);
		}
	);

	it('protects current collection and allows grace-based collection after parent retirement', async () => {
		const { database, store, claim, fact, incarnation } = await fixture();
		await database.update(schema.casObject).set({ deleteAfter: now });
		const reference = retained(
			await store.retain(claim, fact, incarnation, now)
		);
		const collect = async () => {
			const statements = buildCasCollection(
				database,
				jsonValueList([fact.digest]),
				later,
				new CasReferenceSet(database, 'all')
			);
			await database.batch([
				statements.retire,
				statements.queueDeletion,
				statements.remove
			]);
		};
		await collect();
		const protectedRows = await database.select().from(schema.casObject);
		await database.delete(schema.blobReference);
		await store.releaseCaptured(reference);
		const graceRows = await database
			.select({ at: schema.casObject.deleteAfter })
			.from(schema.casObject);
		const grace = graceRows.map((row) => ({ at: row.at ?? undefined }));
		await database.update(schema.casObject).set({ deleteAfter: later });
		await collect();
		expect({
			protectedRows: protectedRows.map((row) => row.digest),
			grace,
			collected: await database.select().from(schema.casObject),
			queued: await database
				.select({
					digest: schema.objectDeletion.objectId,
					incarnation: schema.objectDeletion.incarnation
				})
				.from(schema.objectDeletion)
		}).toStrictEqual({
			protectedRows: [fact.digest],
			grace: [{ at: undefined }],
			collected: [],
			queued: [
				{ digest: fact.digest, incarnation: incarnation - 1 },
				{ digest: fact.digest, incarnation }
			]
		});
	});

	it('preserves the logical reference across physical CAS repair', async () => {
		const { database, store, claim, fact, incarnation, cas, bytes } =
			await fixture();
		const reference = retained(
			await store.retain(claim, fact, incarnation, now)
		);
		await env.BLOBS.delete(casObjectKey(fact.digest, incarnation));
		const repaired = await cas.promote(
			{ digest: fact.digest, size: fact.size, bytes },
			{ restoreMissingObject: true }
		);
		await database.update(schema.objectDeletion).set({ removeAfter: now });
		const cleanup = await drainObjectDeletions(database, env.BLOBS, 'cas', 8);
		expect({
			cleanup,
			incarnation: repaired,
			references: await database
				.select()
				.from(schema.sharedListingOutputReference),
			available: await cas.reuse(fact.digest, repaired),
			oldAvailable: await cas.reuse(fact.digest, incarnation)
		}).toStrictEqual({
			cleanup: { deleted: 2, hasMoreWork: false },
			incarnation: incarnation + 1,
			references: [reference],
			available: true,
			oldAvailable: false
		});
	});

	it('preserves derived retention through a repaired NAR source without a reverse NAR reference', async () => {
		const { database, store, claim, fact, incarnation } = await fixture();
		const reference = retained(
			await store.retain(claim, fact, incarnation, now)
		);
		await database
			.update(schema.objectIncarnation)
			.set({ incarnation: 3 })
			.where(eq(schema.objectIncarnation.kind, 'nar'));
		await database.update(schema.blobState).set({ incarnation: 3 });
		expect({
			release: await store.releaseCaptured(reference),
			retained: await probe(
				database,
				new CasReferenceSet(database, 'all'),
				fact.digest
			)
		}).toStrictEqual({ release: false, retained: { missing: 0 } });
		await database.delete(schema.blobReference);
		await database.delete(schema.blobState);
		await database
			.delete(schema.objectIncarnation)
			.where(eq(schema.objectIncarnation.kind, 'nar'));
		expect({
			source: await database.select().from(schema.blobState),
			released: await store.releaseCaptured(reference)
		}).toStrictEqual({ source: [], released: true });
	});

	it('does not prepare output tables before expansion and fences a cached older reference set after expansion', async () => {
		const { database, fact } = await fixture();
		await database.insert(schema.deploymentTransition).values({
			id: 'native-artifact-storage',
			state: 'expanded',
			updatedAt: now
		});
		const migration = env.TEST_MIGRATIONS.find(
			(entry) => entry.name === '0061_shared_listing_output_retention.sql'
		);
		if (migration === undefined) {
			throw new Error('The output retention migration is missing');
		}
		const triggers = ['arm', 'delete', 'retire', 'registry_delete'].map(
			(suffix) => `DROP TRIGGER shared_listing_output_guard_${suffix}`
		);
		await env.CUPBOARD_DB.batch(
			[
				...triggers,
				'DROP TRIGGER shared_listing_output_parent_retired',
				'DROP TRIGGER shared_listing_output_fact_insert',
				'DROP TRIGGER shared_listing_output_fact_update',
				'DROP TABLE shared_listing_output_ref',
				'DROP TABLE shared_listing_output_cleanup'
			].map((query) => env.CUPBOARD_DB.prepare(query))
		);
		try {
			const references = await readCasReferenceSet(database);
			const before = await probe(database, references, fact.digest);
			await database.insert(schema.deploymentTransition).values({
				id: 'shared-listing-output-retention',
				state: 'expanded',
				updatedAt: now
			});
			expect({
				kinds: references.kinds,
				before,
				fenced: await probe(database, references, fact.digest),
				tenant: await probe(
					database,
					references,
					fact.digest,
					tenantIdSchema.parse('discovery-first')
				)
			}).toStrictEqual({
				kinds: 'artifacts',
				before: { missing: 1 },
				fenced: { missing: 0 },
				tenant: { missing: 1 }
			});
		} finally {
			await env.CUPBOARD_DB.batch(
				migration.queries.map((query) => env.CUPBOARD_DB.prepare(query))
			);
		}
		const expanded = await readCasReferenceSet(database);
		expect(expanded.kinds).toBe('all');
	});

	it('bounds digest probes and parent-removal work with thousands of listing revisions', async () => {
		const { database, fact } = await fixture();
		await database.run(sql`WITH RECURSIVE revisions(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM revisions WHERE n < 2048)
   INSERT INTO shared_listing_output_ref (nar_hash, generator_revision, epoch, source_incarnation, computation_generation, digest, size, created_at)
   SELECT ${fact.narHash}, 'nix-v1-r' || n, '00000000-0000-4000-8000-000000000001', 2, 1, ${fact.digest}, ${fact.size}, ${now} FROM revisions`);
		const references = new CasReferenceSet(database, 'all');
		const query = database
			.select({
				missing:
					sql<number>`CASE WHEN ${references.unreferenced(fact.digest)} THEN 1 ELSE 0 END`.as(
						'missing'
					)
			})
			.from(schema.casObject)
			.where(eq(schema.casObject.digest, fact.digest))
			.toSQL();
		const parameters = z
			.array(z.union([z.string(), z.number()]))
			.parse(query.params);
		const digestProbe = await env.CUPBOARD_DB.prepare(query.sql)
			.bind(...parameters)
			.all();
		const removal = await env.CUPBOARD_DB.prepare(
			'DELETE FROM blob_ref_storage WHERE nar_hash = ?'
		)
			.bind(fact.narHash)
			.run();
		expect({
			probe: digestProbe.results,
			boundedProbe: digestProbe.meta.rows_read <= 64,
			boundedRemoval: removal.meta.rows_read <= 64,
			scopes: await database
				.select({ narHash: schema.sharedListingOutputCleanup.narHash })
				.from(schema.sharedListingOutputCleanup),
			outputs: await database.get<{ count: number }>(
				sql`SELECT count(*) AS count FROM shared_listing_output_ref`
			)
		}).toStrictEqual({
			probe: [{ missing: 0 }],
			boundedProbe: true,
			boundedRemoval: true,
			scopes: [{ narHash: fact.narHash }],
			outputs: { count: 2048 }
		});
	});
});
