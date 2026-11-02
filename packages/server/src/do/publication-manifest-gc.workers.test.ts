import { rootLogger } from '@cupboard/logger';
import { authorizationDetailsSchema } from '@cupboard/protocol/grants';
import { createPublicationRequestId } from '@cupboard/protocol/publication-manifests';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { narObjectKey } from '../http/http.ts';
import { runMaintenanceBatch } from '../routing/scheduled.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	authorisedWorkerFetch,
	clearAbandonedAlarms,
	currentServer,
	fixtureWorkerServer,
	initialise,
	initialiseViaWorker,
	namedCache,
	putWorkerTestCache,
	resetTestServer,
	resolvedCache,
	syntheticNarHash,
	syntheticStorePathHash,
	testControlEnv,
	underOneUnitOfWork,
	withoutAlarmArming
} from '../test-support.ts';

import {
	collectTenant,
	insertNarInfo,
	insertRoot
} from './garbage-collection.test-support.ts';
import { phaseStepSize } from './garbage-collection-service.ts';
import { PublicationManifestAvailabilityStore } from './publication-manifest-availability-store.ts';
import { PublicationManifestCaptureService } from './publication-manifest-capture.ts';
import { PublicationManifestCleanup } from './publication-manifest-cleanup.ts';
import { PublicationManifestEnsureService } from './publication-manifest-ensure.ts';
import { ProductionPublicationManifestPublisher } from './publication-manifest-production.ts';
import { PublicationManifestRepository } from './publication-manifest-repository.ts';
import { committedPath } from './reuse-view-read.test-support.ts';
import { currentRowBudgetMeter } from './row-budget.ts';

const hash = syntheticStorePathHash;
const now = isoTimestamp(new Date('2026-11-01T00:00:00.000Z'));
const expired = '2020-01-01T00:00:00.000Z';
const future = '2099-01-01T00:00:00.000Z';

function unexpectedPublication(): Promise<never> {
	return Promise.reject(new Error('Unexpected ordinary publication'));
}

function association(
	sql: SqlStorage,
	owner: number,
	id: string,
	digest = id
): void {
	sql.exec(
		'INSERT INTO publication_manifest SELECT ?,1,1 WHERE NOT EXISTS (SELECT 1 FROM publication_manifest WHERE digest = ?)',
		digest,
		digest
	);
	sql.exec(
		`INSERT INTO result_publication
		(cache_id,cache_generation,result_hash,result_path,result_generation,result_nar_hash,digest,materialisation_id,origin,complete)
		SELECT n.cache_id,c.generation,n.store_path_hash,n.store_path,n.generation,n.nar_hash,?,?,'build-selection',1
		FROM narinfo n JOIN cache_identity c ON c.id = n.cache_id WHERE n.store_path_hash = ?`,
		digest,
		id,
		hash(owner)
	);
}

function edge(
	sql: SqlStorage,
	owner: number,
	member: number,
	id: string
): void {
	sql.exec(
		`INSERT INTO result_publication_member
		(cache_id,cache_generation,result_hash,result_generation,materialisation_id,member_hash,member_path,member_nar_hash,member_generation)
		SELECT o.cache_id,c.generation,o.store_path_hash,o.generation,?,n.store_path_hash,n.store_path,n.nar_hash,n.generation
		FROM narinfo o JOIN cache_identity c ON c.id = o.cache_id JOIN narinfo n ON n.cache_id = o.cache_id
		WHERE o.store_path_hash = ? AND n.store_path_hash = ?`,
		id,
		hash(owner),
		hash(member)
	);
}

function operation(
	sql: SqlStorage,
	id: string,
	digest: string | undefined,
	deadline = expired,
	state = 'pending'
): void {
	sql.exec(
		`INSERT INTO publication_manifest_operation
		(id,request_id,kind,cache_id,cache_generation,canonical_json,result_identity_json,origin,expected_count,state,expires_at)
		SELECT ?,?,'capture',id,generation,'{}','{}','build-selection',1,?,? FROM cache_identity WHERE kind = 'default'`,
		id,
		id,
		state,
		deadline
	);
	if (digest !== undefined) {
		sql.exec(
			'UPDATE publication_manifest_operation SET candidate_digest = ? WHERE id = ?',
			digest,
			id
		);
	}
}

function portable(sql: SqlStorage, digest: string, count: number): void {
	sql.exec(
		'INSERT OR IGNORE INTO publication_manifest VALUES (?,1,?)',
		digest,
		count
	);
	for (let index = 0; index < count; index += 1) {
		sql.exec(
			'INSERT INTO publication_manifest_member VALUES (?,?,?,?,?)',
			digest,
			index,
			`/nix/store/${hash(index)}-app`,
			hash(index),
			'nar'
		);
	}
}

async function hasMoreAfterCleanupStep(): Promise<boolean> {
	return runInDurableObject(currentServer(), (instance) =>
		underOneUnitOfWork(() =>
			new PublicationManifestCleanup(instance.context.db).collect(
				now,
				phaseStepSize
			)
		)
	);
}

async function fixture(count: number): Promise<void> {
	await initialise();
	await runInDurableObject(currentServer(), (instance) => {
		for (let index = 0; index < count; index += 1) {
			insertNarInfo(instance.context, hash(index), index);
		}
		insertRoot(instance.context, { name: 'root', target: hash(0) });
	});
}

async function live(): Promise<number[]> {
	return runInDurableObject(currentServer(), (instance) => {
		const rows = instance.context.db
			.select()
			.from(schema.narInfos)
			.where(eq(schema.narInfos.cacheId, resolvedCache(instance.context).id))
			.all();
		return Array.from({ length: 400 }, (_, index) => index).filter((index) =>
			rows.some((row) => row.storePathHash === hash(index))
		);
	});
}

async function scanStep(): Promise<void> {
	await runInDurableObject(currentServer(), (instance) =>
		underOneUnitOfWork(() => instance.runGarbageCollection())
	);
}

async function associationScan(): Promise<
	typeof schema.garbageCollectionScans.$inferSelect | undefined
> {
	return runInDurableObject(currentServer(), (instance) =>
		instance.context.db.select().from(schema.garbageCollectionScans).get()
	);
}

async function startAtAssociation(): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		const cache = resolvedCache(instance.context);
		instance.context.db
			.insert(schema.garbageCollectionMarks)
			.values({ cacheId: cache.id, storePathHash: hash(0) })
			.run();
		instance.context.db
			.insert(schema.garbageCollectionScans)
			.values({
				cacheId: cache.id,
				phase: 'mark',
				markStorePathHash: hash(0),
				markEdgePhase: 'association',
				allowEmptyCollection: true
			})
			.run();
	});
}

describe('publication manifest GC traversal', () => {
	beforeEach(resetTestServer);
	afterEach(clearAbandonedAlarms);

	it('automatically collects zero-grace private cold work after alarm-driven availability failure without foreground follow-up', async () => {
		const server = fixtureWorkerServer();
		const source = namedCache('hold-release-source');
		const destination = namedCache('hold-release-destination');
		const pending = await withoutAlarmArming(async () => {
			const token = await initialiseViaWorker();
			await putWorkerTestCache(token, destination);
			const configured = await authorisedWorkerFetch(
				`/caches/${destination.name}`,
				token,
				{
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ kind: 'set-grace', graceSeconds: 0 })
				}
			);
			expect(configured.status).toBe(200);
			for (const [index, name] of ['result', 'child'].entries()) {
				const fields = {
					storePathHash: String(index + 1).padStart(32, '0'),
					name
				};
				await committedPath(`hold-release-${name}`, source, fields);
				await committedPath(`hold-release-${name}`, destination, fields);
			}
			return runInDurableObject(server, async (instance) => {
				const context = instance.context;
				const from = context.cacheRepository.require(source);
				const to = context.cacheRepository.require(destination);
				const rows = context.db
					.select()
					.from(schema.narInfos)
					.where(eq(schema.narInfos.cacheId, from.id))
					.orderBy(schema.narInfos.storePathHash)
					.all();
				const result = rows[0];
				if (result === undefined) {
					throw new Error('Missing result');
				}
				const grants = authorizationDetailsSchema.parse([
					{ type: 'cupboard_cache', cache: source, actions: ['upload:commit'] },
					{
						type: 'cupboard_cache',
						cache: destination,
						actions: ['upload:commit']
					}
				]);
				const capture = new PublicationManifestCaptureService(context);
				const intake = await capture.captureBegin(source, grants, {
					result: {
						storePath: result.storePath,
						narHash: result.narHash,
						generation: result.generation
					},
					expectedCacheGeneration: from.generation,
					requestId: createPublicationRequestId(),
					origin: 'build-selection',
					memberCount: 2
				});
				if (intake.kind !== 'staging') {
					throw new Error('Expected capture');
				}
				await capture.capturePage(source, grants, {
					operationId: intake.operationId,
					page: 0,
					members: rows.map(({ storePath, narHash, generation }) => ({
						storePath,
						narHash,
						generation
					}))
				});
				let sealed = await capture.captureSeal(source, grants, {
					operationId: intake.operationId
				});
				for (let page = 0; page < 12 && sealed.kind !== 'captured'; page += 1) {
					sealed = await capture.captureSeal(source, grants, {
						operationId: intake.operationId
					});
				}
				if (sealed.kind !== 'captured') {
					throw new Error('Capture did not converge');
				}
				// Real healthy destination admission/proofs; ordinary publication must not be needed.
				const ensure = new PublicationManifestEnsureService(
					context,
					new ProductionPublicationManifestPublisher(context, {
						admit: unexpectedPublication,
						publish: unexpectedPublication
					})
				);
				const request = {
					requestId: createPublicationRequestId(),
					source: sealed.publication,
					expectedDestinationGeneration: to.generation
				};
				const started = await ensure.ensure(destination, grants, request);
				if (started.kind !== 'pending') {
					throw new Error('Expected cold ensure');
				}
				for (let step = 0; step < 3; step += 1) {
					expect(
						await ensure.continue(destination, grants, {
							operationId: started.operationId
						})
					).toEqual(started);
				}
				const operation = context.db
					.select()
					.from(schema.publicationManifestOperations)
					.where(
						eq(schema.publicationManifestOperations.id, started.operationId)
					)
					.get();
				if (operation === undefined) {
					throw new Error('Missing pending operation');
				}
				expect(operation).toMatchObject({ state: 'pending', cursor: 2 });
				const holds = context.db
					.select()
					.from(schema.publicationManifestWorkHolds)
					.where(
						eq(
							schema.publicationManifestWorkHolds.operationId,
							started.operationId
						)
					)
					.all();
				expect(holds).toHaveLength(2);
				expect(
					context.db
						.select()
						.from(schema.resultPublications)
						.where(eq(schema.resultPublications.cacheId, to.id))
						.all()
				).toEqual([]);
				expect(
					context.db
						.select()
						.from(schema.retentionRoots)
						.where(eq(schema.retentionRoots.cacheId, to.id))
						.all()
				).toEqual([]);
				expect(
					context.db
						.select()
						.from(schema.retentionGrace)
						.where(eq(schema.retentionGrace.cacheId, to.id))
						.all()
				).toEqual([]);
				const usage = await context.d1
					.select()
					.from(d1Schema.tenantUsage)
					.where(eq(d1Schema.tenantUsage.tenant, fixtureTenant))
					.get();
				if (usage === undefined) {
					throw new Error('Missing initial tenant usage');
				}
				return { operation, holds, cacheId: to.id, usage };
			});
		}, server);
		await withoutAlarmArming(async () => {
			for (let pass = 0; pass < 12; pass += 1) {
				await server.runGarbageCollection();
			}
			await runInDurableObject(server, (instance) => {
				const database = instance.context.db;
				expect(
					database
						.select()
						.from(schema.narInfos)
						.where(eq(schema.narInfos.cacheId, pending.cacheId))
						.all()
				).toHaveLength(2);
				const inputs = database
					.select()
					.from(schema.garbageCollectionInputs)
					.where(eq(schema.garbageCollectionInputs.cacheId, pending.cacheId))
					.get();
				expect(inputs?.inputsChanged).toBe(false);
				expect(typeof inputs?.scanCompletedAt).toBe('string');
				expect(
					database
						.select()
						.from(schema.publicationManifestOperations)
						.where(
							eq(schema.publicationManifestOperations.id, pending.operation.id)
						)
						.get()
				).toEqual(pending.operation);
				expect(
					database
						.select()
						.from(schema.publicationManifestWorkHolds)
						.where(
							eq(
								schema.publicationManifestWorkHolds.operationId,
								pending.operation.id
							)
						)
						.all()
				).toEqual(pending.holds);
				expect(
					database.select().from(schema.garbageCollectionScans).all()
				).toEqual([]);
			});
			await runInDurableObject(server, async (instance) => {
				const context = instance.context;
				const held = pending.holds[1];
				if (held === undefined) {
					throw new Error('Missing held member');
				}
				const row = context.db
					.select()
					.from(schema.narInfos)
					.where(
						and(
							eq(schema.narInfos.cacheId, pending.cacheId),
							eq(schema.narInfos.storePathHash, held.storePathHash)
						)
					)
					.get();
				if (row === undefined) {
					throw new Error('Missing held member');
				}
				// Interrupt a genuine demotion after its durable fence and remote deletion,
				// before acknowledgement. The alarm must recover and drain it itself.
				const intent = new PublicationManifestAvailabilityStore(
					context.db
				).begin(
					{
						...row,
						cacheGeneration:
							context.cacheRepository.require(destination).generation
					},
					'demote'
				);
				expect(intent).toBeDefined();
				const blob = await context.d1
					.select()
					.from(d1Schema.blobState)
					.where(eq(d1Schema.blobState.narHash, row.narHash))
					.get();
				if (blob === undefined) {
					throw new Error('Missing backing blob');
				}
				await context.env.BLOBS.delete(
					narObjectKey(row.narHash, blob.incarnation)
				);
			});
		}, server);
		// No alarm fence, explicit scan request, or foreground ensure after demotion.
		for (let pass = 0; pass < 12; pass += 1) {
			await runInDurableObject(server, (instance) => instance.alarm());
		}
		await runInDurableObject(server, (instance) => {
			const database = instance.context.db;
			expect(
				database
					.select()
					.from(schema.publicationManifestOperations)
					.where(
						eq(schema.publicationManifestOperations.id, pending.operation.id)
					)
					.get()
			).toEqual({
				...pending.operation,
				state: 'failed',
				failureJson: '{"kind":"failed","reason":"generation-conflict"}'
			});
			expect(
				database
					.select()
					.from(schema.publicationManifestAvailabilityIntents)
					.all()
			).toEqual([]);
			expect(
				database
					.select()
					.from(schema.garbageCollectionInputs)
					.where(eq(schema.garbageCollectionInputs.cacheId, pending.cacheId))
					.get()?.inputsChanged
			).toBe(true);
			expect(
				database
					.select()
					.from(schema.publicationManifestWorkHolds)
					.where(
						eq(
							schema.publicationManifestWorkHolds.operationId,
							pending.operation.id
						)
					)
					.all()
			).toEqual(pending.holds);
		});
		// The real tenant maintenance selector must discover the dirty cache, not
		// wait for receipt expiry or an unrelated mutation to request another scan.
		await runMaintenanceBatch(rootLogger(), { ...env, ...testControlEnv });
		for (let pass = 0; pass < 12; pass += 1) {
			await runInDurableObject(server, (instance) => instance.alarm());
		}
		await runInDurableObject(server, async (instance) => {
			const context = instance.context;
			expect(
				context.db
					.select()
					.from(schema.narInfos)
					.where(eq(schema.narInfos.cacheId, pending.cacheId))
					.all()
			).toEqual([]);
			expect(
				context.db
					.select()
					.from(schema.publicationManifestWorkHolds)
					.where(
						eq(
							schema.publicationManifestWorkHolds.operationId,
							pending.operation.id
						)
					)
					.all()
			).toEqual([]);
			expect(
				context.db
					.select()
					.from(schema.resultPublications)
					.where(eq(schema.resultPublications.cacheId, pending.cacheId))
					.all()
			).toEqual([]);
			expect(
				context.db
					.select()
					.from(schema.publicationManifestOperations)
					.where(
						eq(schema.publicationManifestOperations.id, pending.operation.id)
					)
					.get()
			).toEqual({
				...pending.operation,
				state: 'failed',
				failureJson: '{"kind":"failed","reason":"generation-conflict"}'
			});
			const references = await context.d1
				.select()
				.from(d1Schema.blobReference)
				.where(eq(d1Schema.blobReference.tenant, fixtureTenant))
				.all();
			expect(
				references.filter(
					(reference) => reference.cacheName === destination.name
				)
			).toEqual([]);
			const usage = await context.d1
				.select()
				.from(d1Schema.tenantUsage)
				.where(eq(d1Schema.tenantUsage.tenant, fixtureTenant))
				.get();
			const retained = await context.d1
				.select()
				.from(d1Schema.tenantBlob)
				.where(eq(d1Schema.tenantBlob.tenant, fixtureTenant))
				.all();
			const updatedAt: unknown = expect.any(String);
			expect(usage).toStrictEqual({
				...pending.usage,
				bytes: retained.reduce((bytes, blob) => bytes + blob.fileSize, 0),
				narinfos: references.length,
				blobs: new Set(references.map((reference) => reference.narHash)).size,
				updatedAt
			});
			expect(
				context.db
					.select()
					.from(schema.garbageCollectionInputs)
					.where(eq(schema.garbageCollectionInputs.cacheId, pending.cacheId))
					.get()
			).toMatchObject({ inputsChanged: false });
		});
	});

	it('revisits an already-marked owner finalised during collection and retains incomplete surviving members', async () => {
		await withoutAlarmArming(async () => {
			await fixture(5);
			await startAtAssociation();
			await runInDurableObject(currentServer(), (instance, state) => {
				instance.context.db
					.update(schema.garbageCollectionScans)
					.set({ phase: 'collect', markStorePathHash: sql`null` })
					.run();
				edge(state.storage.sql, 0, 1, 'winner');
				edge(state.storage.sql, 0, 2, 'winner');
				association(state.storage.sql, 0, 'winner');
				// Losing private candidates never become edges.
				edge(state.storage.sql, 0, 3, 'private');
				instance.context.db
					.update(schema.narInfos)
					.set({
						narHash: syntheticNarHash(4)
					})
					.where(eq(schema.narInfos.storePathHash, hash(2)))
					.run();
				expect(() => {
					new PublicationManifestRepository(instance.context).requireAvailable(
						resolvedCache(instance.context)
					);
				}).toThrow();
				underOneUnitOfWork(() =>
					new PublicationManifestAvailabilityStore(instance.context.db).drain()
				);
				expect(
					instance.context.db.select().from(schema.resultPublications).get()
						?.complete
				).toBe(false);
				expect(
					instance.context.db
						.select()
						.from(schema.garbageCollectionFrontier)
						.all()
						.map((row) => row.storePathHash)
				).toContain(hash(0));
			});
			await collectTenant();
			expect(await live()).toEqual([0, 1]);
		});
	});

	it('resumes association pages independently after restart and restarts on pointer replacement', async () => {
		await withoutAlarmArming(async () => {
			await fixture(phaseStepSize + 4);
			await runInDurableObject(currentServer(), (_instance, state) => {
				for (let member = 2; member <= phaseStepSize + 2; member += 1) {
					edge(state.storage.sql, 0, member, 'old');
				}
				association(state.storage.sql, 0, 'old');
			});
			await startAtAssociation();
			await scanStep();
			const first = await associationScan();
			if (first === undefined) {
				throw new Error('expected persisted scan');
			}
			expect(first).toMatchObject({
				markEdgePhase: 'association',
				associationMaterialisationId: 'old',
				associationMemberCursor: `/nix/store/${hash(phaseStepSize + 1)}-app`,
				referenceCursor: -1
			});
			// Fresh invocation reads only persisted state, not an in-memory cursor.
			await scanStep();
			const resumed = await associationScan();
			expect(resumed?.markStorePathHash).toBeNull();
			await runInDurableObject(currentServer(), (instance, state) => {
				// Resume an interrupted old page after a pointer swap. New members
				// sort before the saved old cursor and must not be skipped.
				instance.context.db
					.update(schema.garbageCollectionScans)
					.set({
						markStorePathHash: hash(0),
						markEdgePhase: 'association',
						associationMaterialisationId: 'old',
						associationMemberCursor: first.associationMemberCursor,
						associationCacheGeneration: first.associationCacheGeneration,
						associationResultGeneration: first.associationResultGeneration
					})
					.run();
				edge(state.storage.sql, 0, 1, 'new');
				edge(state.storage.sql, 0, phaseStepSize + 2, 'new');
				state.storage.sql.exec(
					"UPDATE result_publication SET materialisation_id = 'new'"
				);
			});
			await collectTenant();
			expect(await live()).toContain(1);
			expect(await live()).toContain(phaseStepSize + 2);
			expect(await live()).not.toContain(phaseStepSize + 3);
		});
	});

	it('bounds a stale association page independently of a 100000-member proof', async () => {
		await withoutAlarmArming(async () => {
			await fixture(1);
			const costs = [];
			for (const count of [phaseStepSize + 1, 100_000]) {
				await runInDurableObject(currentServer(), (_instance, state) => {
					state.storage.sql.exec('DELETE FROM garbage_collection_scan');
					state.storage.sql.exec('DELETE FROM garbage_collection_tenant_run');
					state.storage.sql.exec('DELETE FROM garbage_collection_mark');
					state.storage.sql.exec('DELETE FROM garbage_collection_frontier');
					state.storage.sql.exec('DELETE FROM result_publication_member');
					if (count === phaseStepSize + 1) {
						association(state.storage.sql, 0, 'selected');
					}
					state.storage.sql.exec(
						`WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n < ?)
                        INSERT INTO result_publication_member (cache_id,cache_generation,result_hash,result_generation,materialisation_id,member_hash,member_path,member_nar_hash,member_generation)
                        SELECT a.cache_id,a.cache_generation,a.result_hash,a.result_generation,a.materialisation_id,
                            printf('%032d',n),printf('/nix/store/%032d-app',n),'stale',999
                        FROM sequence,result_publication a`,
						count
					);
				});
				await startAtAssociation();
				costs.push(
					await runInDurableObject(currentServer(), (instance) =>
						underOneUnitOfWork(async () => {
							await instance.runGarbageCollection();
							const meter = currentRowBudgetMeter();
							if (meter === undefined) {
								throw new Error('missing cost meter');
							}
							meter.recordOutstanding();
							return {
								rowsRead: meter.rowsRead,
								rowsWritten: meter.rowsWritten
							};
						})
					)
				);
				expect(await associationScan()).toMatchObject({
					markEdgePhase: 'association',
					associationMaterialisationId: 'selected',
					associationMemberCursor:
						'/nix/store/00000000000000000000000000000128-app'
				});
			}
			expect(costs[0]).toEqual(costs[1]);
			expect(costs[1]?.rowsRead).toBeLessThan(3000);
		});
	});

	it.each(['association_cache_generation', 'association_result_generation'])(
		'restarts a persisted association cursor when %s changes',
		async (column) => {
			await withoutAlarmArming(async () => {
				await fixture(3);
				await runInDurableObject(currentServer(), (_instance, state) => {
					association(state.storage.sql, 0, 'selected');
					edge(state.storage.sql, 0, 1, 'selected');
					edge(state.storage.sql, 0, 2, 'selected');
				});
				await startAtAssociation();
				await runInDurableObject(currentServer(), (_instance, state) => {
					state.storage.sql.exec(
						`UPDATE garbage_collection_scan SET
                        association_materialisation_id = 'selected', association_member_cursor = ?,
                        association_cache_generation = (SELECT cache_generation FROM result_publication),
                        association_result_generation = (SELECT result_generation FROM result_publication)`,
						`/nix/store/${hash(2)}-app`
					);
					state.storage.sql.exec(
						`UPDATE garbage_collection_scan SET ${column} = 999`
					);
				});
				await scanStep();
				await runInDurableObject(currentServer(), (instance) => {
					const frontier = instance.context.db
						.select()
						.from(schema.garbageCollectionFrontier)
						.all();
					expect(frontier.map((row) => row.storePathHash)).toEqual([
						hash(1),
						hash(2)
					]);
				});
			});
		}
	);

	it('does not follow a live cross-cache member with otherwise identical path/NAR/generation', async () => {
		await withoutAlarmArming(async () => {
			await fixture(3);
			await runInDurableObject(currentServer(), (_instance, state) => {
				association(state.storage.sql, 0, 'selected');
				edge(state.storage.sql, 0, 1, 'selected');
				state.storage.sql.exec(
					`INSERT INTO cache_identity(kind,name,access,priority,generation,created_at)
                    VALUES ('named','other','public',40,1,?)`,
					expired
				);
				state.storage.sql
					.exec(`INSERT INTO narinfo(cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,generation,created_at)
                    SELECT c.id,n.store_path_hash,n.store_path,n.nar_hash,n.nar_size,n.references_json,n.generation,n.created_at
                    FROM narinfo n, cache_identity c WHERE c.name = 'other'`);
				state.storage.sql.exec(
					`UPDATE result_publication_member SET cache_id = (SELECT id FROM cache_identity WHERE name = 'other')`
				);
			});
			await collectTenant();
			expect(await live()).toEqual([0]);
		});
	});

	it.each([
		'cache_id',
		'cache_generation',
		'result_hash',
		'result_generation',
		'member_generation',
		'member_path',
		'member_nar_hash'
	])(
		'filters exact selected member %s even when the low-level row is stale',
		async (column) => {
			await withoutAlarmArming(async () => {
				await fixture(3);
				await runInDurableObject(currentServer(), (_instance, state) => {
					association(state.storage.sql, 0, 'selected');
					edge(state.storage.sql, 0, 1, 'selected');
					const isNumeric =
						column.endsWith('generation') || column === 'cache_id';
					state.storage.sql.exec(
						`UPDATE result_publication_member SET ${column} = ?`,
						isNumeric ? 999 : 'wrong'
					);
				});
				await collectTenant();
				expect(await live()).toEqual([0]);
			});
		}
	);

	it.each([
		'cache_generation',
		'result_generation',
		'result_path',
		'result_nar_hash'
	])('filters exact owner %s', async (column) => {
		await withoutAlarmArming(async () => {
			await fixture(2);
			await runInDurableObject(currentServer(), (_instance, state) => {
				association(state.storage.sql, 0, 'selected');
				edge(state.storage.sql, 0, 1, 'selected');
				state.storage.sql.exec(
					`UPDATE result_publication SET ${column} = ?`,
					column.endsWith('generation') ? 999 : 'wrong'
				);
			});
			await collectTenant();
			expect(await live()).toEqual([0]);
		});
	});

	it('traverses runtime and association edges transitively but does not root non-root cycles or metadata', async () => {
		await withoutAlarmArming(async () => {
			await fixture(7);
			await runInDurableObject(currentServer(), (_instance, state) => {
				state.storage.sql.exec(
					'UPDATE narinfo SET references_json = ? WHERE store_path_hash = ?',
					JSON.stringify([`${hash(1)}-app`]),
					hash(0)
				);
				association(state.storage.sql, 1, 'reachable');
				edge(state.storage.sql, 1, 2, 'reachable');
				association(state.storage.sql, 2, 'cycle');
				edge(state.storage.sql, 2, 1, 'cycle');
				association(state.storage.sql, 3, 'unrooted');
				edge(state.storage.sql, 3, 4, 'unrooted');
				association(state.storage.sql, 4, 'unrooted-cycle');
				edge(state.storage.sql, 4, 3, 'unrooted-cycle');
				edge(state.storage.sql, 0, 5, 'private');
				portable(state.storage.sql, 'orphan-portable', 7);
			});
			await collectTenant();
			expect(await live()).toEqual([0, 1, 2]);
			await runInDurableObject(currentServer(), (instance) => {
				expect(
					instance.context.db
						.select()
						.from(schema.publicationManifestRetirements)
						.all()
				).toHaveLength(0);
			});
		});
	});

	it('keeps runtime and association cursors independently durable across a phase interruption', async () => {
		await withoutAlarmArming(async () => {
			await fixture(phaseStepSize + 3);
			await runInDurableObject(currentServer(), (_instance, state) => {
				state.storage.sql.exec(
					'UPDATE narinfo SET references_json = ? WHERE store_path_hash = ?',
					JSON.stringify(
						Array.from(
							{ length: phaseStepSize + 1 },
							(_, index) => `${hash(index + 1)}-app`
						)
					),
					hash(0)
				);
				association(state.storage.sql, 0, 'selected');
				edge(state.storage.sql, 0, phaseStepSize + 2, 'selected');
			});
			await startAtAssociation();
			await runInDurableObject(currentServer(), (instance) =>
				instance.context.db
					.update(schema.garbageCollectionScans)
					.set({ markEdgePhase: 'references' })
					.run()
			);
			await scanStep();
			expect(await associationScan()).toMatchObject({
				markEdgePhase: 'references',
				referenceCursor: phaseStepSize - 1,
				associationMemberCursor: ''
			});
			await scanStep();
			expect(await associationScan()).toMatchObject({
				markEdgePhase: 'association',
				referenceCursor: phaseStepSize - 1,
				associationMemberCursor: ''
			});
			await collectTenant();
			expect(await live()).toHaveLength(phaseStepSize + 3);
		});
	});
});

describe('publication manifest bounded metadata cleanup', () => {
	beforeEach(resetTestServer);
	afterEach(clearAbandonedAlarms);

	it.each(['generation', 'soft-delete', 'physical-delete'] as const)(
		'discovers lifecycle-only %s work and retires stale pointers without losing current incomplete selections or accepted work',
		async (mutation) => {
			await withoutAlarmArming(async () => {
				await fixture(3);
				const healthy = await runInDurableObject(
					currentServer(),
					(instance, state) => {
						portable(state.storage.sql, 'stale', 2);
						association(state.storage.sql, 0, 'stale');
						edge(state.storage.sql, 0, 1, 'stale');
						operation(state.storage.sql, 'stale-pending', 'stale', future);
						operation(
							state.storage.sql,
							'stale-terminal',
							'stale',
							future,
							'complete'
						);
						const oldAssociation = instance.context.db
							.select()
							.from(schema.resultPublications)
							.get();
						const oldMember = instance.context.db
							.select()
							.from(schema.resultPublicationMembers)
							.get();
						const oldOperation = instance.context.db
							.select()
							.from(schema.publicationManifestOperations)
							.get();
						if (
							oldAssociation === undefined ||
							oldMember === undefined ||
							oldOperation === undefined
						) {
							throw new Error('Missing stale fixture');
						}
						if (mutation === 'generation') {
							state.storage.sql.exec(
								'UPDATE cache_identity SET generation = generation + 1'
							);
						} else if (mutation === 'soft-delete') {
							state.storage.sql.exec(
								"UPDATE cache_identity SET deleted_at = '2026-01-01T00:00:00.000Z'"
							);
						} else {
							state.storage.sql.exec('DELETE FROM cache_identity');
						}
						if (mutation !== 'generation') {
							state.storage.sql.exec(
								"INSERT INTO cache_identity(kind,name,access,priority,generation,created_at) VALUES ('named','healthy','public',40,1,'2026-01-01T00:00:00.000Z')"
							);
							state.storage.sql.exec(
								`INSERT INTO narinfo(cache_id,store_path_hash,store_path,nar_hash,nar_size,references_json,generation,created_at)
						 SELECT c.id,n.store_path_hash,n.store_path,n.nar_hash,n.nar_size,n.references_json,n.generation,n.created_at FROM narinfo n JOIN cache_identity c ON c.name='healthy' WHERE n.cache_id=?`,
								oldAssociation.cacheId
							);
						}
						const current = instance.context.db
							.select()
							.from(schema.cacheIdentities)
							.where(isNull(schema.cacheIdentities.deletedAt))
							.get();
						if (current === undefined) {
							throw new Error('Missing accepted identity');
						}
						const scope = {
							cacheId: current.id,
							cacheGeneration: current.generation
						};
						portable(state.storage.sql, 'healthy', 2);
						const currentAssociation = {
							...oldAssociation,
							...scope,
							digest: 'healthy',
							materialisationId: 'healthy',
							complete: false
						};
						const member = {
							...oldMember,
							...scope,
							materialisationId: 'healthy'
						};
						const acceptedOperation = {
							...oldOperation,
							...scope,
							id: 'healthy',
							requestId: 'healthy',
							candidateDigest: 'healthy'
						};
						instance.context.db
							.insert(schema.resultPublications)
							.values(currentAssociation)
							.run();
						instance.context.db
							.insert(schema.resultPublicationMembers)
							.values(member)
							.run();
						instance.context.db
							.insert(schema.publicationManifestOperations)
							.values(acceptedOperation)
							.run();
						expect(
							new PublicationManifestCleanup(instance.context.db).hasWork(now)
						).toBe(true);
						return {
							association: currentAssociation,
							member,
							operation: acceptedOperation,
							portable: instance.context.db
								.select()
								.from(schema.publicationManifestMembers)
								.where(eq(schema.publicationManifestMembers.digest, 'healthy'))
								.all()
						};
					}
				);
				for (let page = 0; page < 10; page += 1) {
					if (!(await hasMoreAfterCleanupStep())) {
						break;
					}
				}
				await runInDurableObject(currentServer(), (instance) => {
					expect(
						instance.context.db.select().from(schema.resultPublications).all()
					).toEqual([healthy.association]);
					expect(
						instance.context.db
							.select()
							.from(schema.resultPublicationMembers)
							.all()
					).toEqual([healthy.member]);
					expect(
						instance.context.db
							.select()
							.from(schema.publicationManifestOperations)
							.where(eq(schema.publicationManifestOperations.id, 'healthy'))
							.get()
					).toEqual(healthy.operation);
					expect(
						instance.context.db
							.select()
							.from(schema.publicationManifestOperations)
							.all()
							.filter(({ id }) => id !== 'healthy')
							.map(({ id, state, failureJson }) => ({
								id,
								state,
								failureJson: failureJson ?? undefined
							}))
					).toEqual([
						{
							id: 'stale-pending',
							state: 'failed',
							failureJson: '{"kind":"failed","reason":"scope-changed"}'
						},
						{ id: 'stale-terminal', state: 'complete', failureJson: undefined }
					]);
					expect(
						instance.context.db
							.select()
							.from(schema.publicationManifestMembers)
							.all()
					).toEqual(healthy.portable);
					instance.context.db.run(
						sql`UPDATE publication_manifest_operation SET expires_at=${expired} WHERE id IN ('stale-pending','stale-terminal')`
					);
				});
				for (let page = 0; page < 10; page += 1) {
					if (!(await hasMoreAfterCleanupStep())) {
						break;
					}
				}
				await runInDurableObject(currentServer(), (instance) => {
					expect(
						new PublicationManifestCleanup(instance.context.db).hasWork(now)
					).toBe(false);
				});
				await runInDurableObject(currentServer(), (instance) => {
					expect(
						instance.context.db
							.select()
							.from(schema.publicationManifestOperations)
							.all()
					).toEqual([healthy.operation]);
					expect(
						instance.context.db.select().from(schema.resultPublications).all()
					).toEqual([healthy.association]);
					expect(
						instance.context.db
							.select()
							.from(schema.publicationManifestMembers)
							.all()
					).toEqual(healthy.portable);
				});
			});
		}
	);

	it('expires receipts and pages in bounded steps, independently preserves selected proofs, and later retires the association', async () => {
		await withoutAlarmArming(async () => {
			await fixture(2);
			await runInDurableObject(currentServer(), (_instance, state) => {
				portable(state.storage.sql, 'receipt', phaseStepSize + 1);
				association(state.storage.sql, 0, 'receipt');
				edge(state.storage.sql, 0, 1, 'receipt');
				operation(state.storage.sql, 'receipt', 'receipt', expired, 'complete');
				for (let page = 0; page <= phaseStepSize; page += 1) {
					state.storage.sql.exec(
						"INSERT INTO publication_manifest_operation_page VALUES (?,?,'digest','[]')",
						'receipt',
						page
					);
				}
			});
			expect(await hasMoreAfterCleanupStep()).toBe(true);
			await runInDurableObject(currentServer(), (instance) => {
				expect(
					instance.context.db
						.select()
						.from(schema.publicationManifestOperationPages)
						.all()
				).toHaveLength(1);
				expect(
					instance.context.db
						.select()
						.from(schema.publicationManifestOperations)
						.all()
				).toHaveLength(1);
			});
			expect(await hasMoreAfterCleanupStep()).toBe(false);
			await runInDurableObject(currentServer(), (instance) => {
				expect(
					instance.context.db
						.select()
						.from(schema.publicationManifestOperations)
						.all()
				).toHaveLength(0);
				expect(
					instance.context.db
						.select()
						.from(schema.resultPublicationMembers)
						.all()
				).toHaveLength(1);
				expect(
					instance.context.db
						.select()
						.from(schema.publicationManifestMembers)
						.all()
				).toHaveLength(phaseStepSize + 1);
				instance.context.db.delete(schema.resultPublications).run();
			});
			expect(await hasMoreAfterCleanupStep()).toBe(true);
			await runInDurableObject(currentServer(), (instance) => {
				expect(
					instance.context.db
						.select()
						.from(schema.publicationManifestMembers)
						.all()
				).toHaveLength(1);
				expect(
					instance.context.db.select().from(schema.publicationManifests).all()
				).toHaveLength(1);
			});
			expect(await hasMoreAfterCleanupStep()).toBe(false);
			await runInDurableObject(currentServer(), (instance) => {
				expect(
					instance.context.db.select().from(schema.publicationManifests).all()
				).toHaveLength(0);
				expect(
					instance.context.db
						.select()
						.from(schema.publicationManifestRetirements)
						.all()
				).toHaveLength(0);
			});
		});
	});

	it.each(['pending', 'failed', 'expired'])(
		'retires %s operation candidates in bounded pages after their replay deadline',
		async (state) => {
			await withoutAlarmArming(async () => {
				await fixture(phaseStepSize + 2);
				await runInDurableObject(currentServer(), (_instance, durable) => {
					for (let member = 1; member <= phaseStepSize + 1; member += 1) {
						edge(durable.storage.sql, 0, member, 'orphan');
					}
					operation(durable.storage.sql, 'orphan', undefined, expired, state);
				});
				expect(await hasMoreAfterCleanupStep()).toBe(true);
				await runInDurableObject(currentServer(), (instance) => {
					expect(
						instance.context.db
							.select()
							.from(schema.resultPublicationMembers)
							.all()
					).toHaveLength(1);
				});
				expect(await hasMoreAfterCleanupStep()).toBe(false);
				await runInDurableObject(currentServer(), (instance) => {
					expect(
						instance.context.db
							.select()
							.from(schema.resultPublicationMembers)
							.all()
					).toHaveLength(0);
				});
			});
		}
	);

	it('protects shared portable content by pending candidateDigest then independently retires it on expiry', async () => {
		await withoutAlarmArming(async () => {
			await fixture(3);
			await runInDurableObject(currentServer(), (_instance, state) => {
				portable(state.storage.sql, 'shared', 3);
				operation(state.storage.sql, 'pending', 'shared', future);
				operation(state.storage.sql, 'failed', 'shared', expired, 'failed');
				edge(state.storage.sql, 0, 1, 'pending');
				edge(state.storage.sql, 0, 2, 'failed');
			});
			expect(await hasMoreAfterCleanupStep()).toBe(false);
			await runInDurableObject(currentServer(), (instance) => {
				expect(
					instance.context.db
						.select()
						.from(schema.publicationManifestMembers)
						.all()
				).toHaveLength(3);
				expect(
					instance.context.db
						.select()
						.from(schema.resultPublicationMembers)
						.all()
						.map((row) => row.materialisationId)
				).toEqual(['pending']);
				instance.context.db
					.update(schema.publicationManifestOperations)
					.set({ expiresAt: isoTimestamp(new Date(expired)) })
					.run();
			});
			expect(await hasMoreAfterCleanupStep()).toBe(false);
			await runInDurableObject(currentServer(), (instance) => {
				expect(
					instance.context.db.select().from(schema.publicationManifests).all()
				).toHaveLength(0);
			});
		});
	});

	it('protects incomplete selections sharing a digest while deleting old pointer proofs', async () => {
		await withoutAlarmArming(async () => {
			await fixture(3);
			await runInDurableObject(currentServer(), (_instance, state) => {
				portable(state.storage.sql, 'shared', 3);
				association(state.storage.sql, 0, 'old', 'shared');
				edge(state.storage.sql, 0, 1, 'old');
				edge(state.storage.sql, 0, 2, 'new');
				state.storage.sql.exec(
					"UPDATE result_publication SET materialisation_id = 'new', complete = 0"
				);
			});
			expect(await hasMoreAfterCleanupStep()).toBe(false);
			await runInDurableObject(currentServer(), (instance) => {
				expect(
					instance.context.db
						.select()
						.from(schema.resultPublicationMembers)
						.all()
						.map((row) => row.materialisationId)
				).toEqual(['new']);
				expect(
					instance.context.db
						.select()
						.from(schema.publicationManifestMembers)
						.all()
				).toHaveLength(3);
			});
		});
	});

	it.each(['candidate', 'portable'])(
		'bounds %s retirement row cost independently of a 100000-member range',
		async (kind) => {
			await withoutAlarmArming(async () => {
				await fixture(1);
				const costs = [];
				for (const count of [phaseStepSize + 1, 100_000]) {
					await runInDurableObject(currentServer(), (_instance, state) => {
						state.storage.sql.exec('DELETE FROM result_publication_member');
						state.storage.sql.exec(
							'DELETE FROM publication_manifest_retirement'
						);
						state.storage.sql.exec('DELETE FROM publication_manifest_member');
						state.storage.sql.exec('DELETE FROM publication_manifest');
						operation(
							state.storage.sql,
							'retire',
							kind === 'portable' ? 'retire' : undefined
						);
						if (kind === 'portable') {
							state.storage.sql.exec(
								'INSERT INTO publication_manifest VALUES (?,1,?)',
								'retire',
								count
							);
							state.storage.sql.exec(
								`WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n < ?)
                            INSERT INTO publication_manifest_member
                            SELECT 'retire',n-1,printf('/nix/store/%032d-app',n),printf('%032d',n),'nar' FROM sequence`,
								count
							);
							return;
						}
						state.storage.sql.exec(
							`WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n < ?)
                        INSERT INTO result_publication_member (cache_id,cache_generation,result_hash,result_generation,materialisation_id,member_hash,member_path,member_nar_hash,member_generation)
                        SELECT c.id,c.generation,'owner',1,'retire',printf('%032d',n),printf('/nix/store/%032d-app',n),'nar',1
                        FROM sequence,cache_identity c WHERE c.kind = 'default'`,
							count
						);
					});
					costs.push(
						await runInDurableObject(currentServer(), (instance) =>
							underOneUnitOfWork(() => {
								const hasMore = new PublicationManifestCleanup(
									instance.context.db
								).collect(now, phaseStepSize);
								const meter = currentRowBudgetMeter();
								if (meter === undefined) {
									throw new Error('missing cost meter');
								}
								meter.recordOutstanding();
								return {
									hasMore,
									rowsRead: meter.rowsRead,
									rowsWritten: meter.rowsWritten
								};
							})
						)
					);
				}
				expect(costs[0]).toEqual(costs[1]);
				expect(costs[1]).toMatchObject({ hasMore: true });
				expect(costs[1]?.rowsRead).toBeLessThan(6000);
				expect(costs[1]?.rowsWritten).toBeLessThan(1000);
			});
		}
	);

	it('feeds exact remaining metadata work into the existing GC continuation', async () => {
		await withoutAlarmArming(async () => {
			await fixture(2);
			await runInDurableObject(currentServer(), (_instance, state) => {
				portable(state.storage.sql, 'orphan', phaseStepSize + 1);
				operation(state.storage.sql, 'orphan', 'orphan');
			});
			await scanStep();
			await runInDurableObject(currentServer(), (instance) => {
				expect(
					instance.context.db
						.select()
						.from(schema.publicationManifestRetirements)
						.all()
				).toHaveLength(1);
			});
			await collectTenant();
			await runInDurableObject(currentServer(), (instance) => {
				expect(
					instance.context.db
						.select()
						.from(schema.publicationManifestRetirements)
						.all()
				).toHaveLength(0);
			});
		});
	});
});
