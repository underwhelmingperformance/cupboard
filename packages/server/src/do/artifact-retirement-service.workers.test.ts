import { storePathBasenameSchema } from '@cupboard/nix-store/scalars';
import { artifactGenerationSchema } from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { eq, ne, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../db/schema.ts';
import {
	currentServer,
	initialise,
	recordTransition,
	resetTestServer,
	withoutAlarmArming
} from '../test-support.ts';

import {
	artifactFixtureGeneration as generation,
	artifactFixtureId as id,
	createArtifact,
	reservationState
} from './artifact.test-support.ts';
import { ArtifactCasService } from './artifact-cas-service.ts';
import { ArtifactRetentionService } from './artifact-retention-service.ts';
import { ArtifactRetirementService } from './artifact-retirement-service.ts';
import type { ServerContext } from './context.ts';
import { withSubrequestSlice } from './subrequest-slice.ts';

const version = { id, generation };

async function retireArtifact(context: ServerContext) {
	const artifact = await createArtifact(context);
	await new ArtifactCasService(context).reserveInSection(id, generation);
	context.db
		.update(schema.artifacts)
		.set({ state: 'live', completedAt: artifact.createdAt })
		.where(eq(schema.artifacts.id, id))
		.run();
	new ArtifactRetentionService(context).retireUnretainedInSection(version);
	return artifact;
}

async function drainState(context: ServerContext) {
	return {
		...(await reservationState(context)),
		artifacts: context.db.select().from(schema.artifacts).all(),
		parents: context.db
			.select()
			.from(schema.artifactParents)
			.where(eq(schema.artifactParents.artifactId, id))
			.orderBy(schema.artifactParents.storePathHash)
			.all(),
		deletions: context.db.select().from(schema.artifactReferenceDeletion).all(),
		logs: context.db.select().from(schema.buildLogs).all()
	};
}

describe('bounded artifact retirement', () => {
	beforeEach(async () => {
		await resetTestServer();
		await withoutAlarmArming(initialise);
		await recordTransition('native-artifact-storage', 'expanded');
	});

	it('removes the reference and credits quota before acknowledging the captured retirement', () =>
		withoutAlarmArming(() =>
			runInDurableObject(currentServer(), async (instance) => {
				const context = instance.context;
				await context.criticalSection(async () => {
					await retireArtifact(context);
					const before = await drainState(context);
					const service = new ArtifactRetirementService(context);
					const result = await service.drainInSection();
					expect({ result, state: await drainState(context) }).toStrictEqual({
						result: {
							referencesRemoved: 1,
							entriesCompleted: 1,
							rowsRemoved: 2,
							pending: false
						},
						state: {
							...before,
							usage: { ...before.usage, casBytes: 0, casBlobs: 0 },
							presence: [],
							references: [],
							artifacts: [],
							deletions: []
						}
					});
					expect(await service.drainInSection()).toStrictEqual({
						referencesRemoved: 0,
						entriesCompleted: 0,
						rowsRemoved: 0,
						pending: false
					});
				});
			})
		));

	it.each([0, 25_000])(
		'bounds cleanup pages beside %s unrelated edges and persists reference completion',
		(unrelated) =>
			withoutAlarmArming(() =>
				runInDurableObject(currentServer(), async (instance) => {
					const context = instance.context;
					await context.criticalSection(async () => {
						const artifact = await retireArtifact(context);
						context.ctx.storage.sql.exec(
							"WITH RECURSIVE numbered(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM numbered WHERE value < 33) INSERT INTO artifact_parent (artifact_id,artifact_generation,cache_id,store_path_hash,publication_generation) SELECT ?, ?, ?, printf('%032d', value), value FROM numbered",
							id,
							generation,
							artifact.cache.id
						);
						if (unrelated > 0) {
							context.ctx.storage.sql.exec(
								"WITH RECURSIVE numbered(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM numbered WHERE value < ?) INSERT INTO artifact_parent (artifact_id,artifact_generation,cache_id,store_path_hash,publication_generation) SELECT printf('%08x-0000-4000-8000-000000000000',value), ?, ?, printf('%032d', value), value FROM numbered",
								unrelated,
								generation,
								artifact.cache.id
							);
						}
						const before = await drainState(context);
						const remove = vi.spyOn(
							ArtifactCasService.prototype,
							'removeCapturedInSection'
						);
						try {
							const service = new ArtifactRetirementService(context);
							const first = await service.drainInSection();
							expect({
								result: first,
								state: await drainState(context)
							}).toStrictEqual({
								result: {
									referencesRemoved: 1,
									entriesCompleted: 0,
									rowsRemoved: 16,
									pending: true
								},
								state: {
									...before,
									usage: { ...before.usage, casBytes: 0, casBlobs: 0 },
									references: [],
									presence: [],
									parents: before.parents.slice(16),
									deletions: before.deletions.map((row) => ({
										...row,
										referenceRemoved: true
									}))
								}
							});
							const second = await service.drainInSection();
							const final = await service.drainInSection();
							const remaining = context.db
								.select({ count: sql<number>`count(*)` })
								.from(schema.artifactParents)
								.where(ne(schema.artifactParents.artifactId, id))
								.get();
							expect({
								second,
								final,
								sharedRemovals: remove.mock.calls.length,
								unrelated: remaining,
								state: await drainState(context)
							}).toStrictEqual({
								second: {
									referencesRemoved: 0,
									entriesCompleted: 0,
									rowsRemoved: 16,
									pending: true
								},
								final: {
									referencesRemoved: 0,
									entriesCompleted: 1,
									rowsRemoved: 3,
									pending: false
								},
								sharedRemovals: 1,
								unrelated: { count: unrelated },
								state: {
									...before,
									usage: { ...before.usage, casBytes: 0, casBlobs: 0 },
									presence: [],
									references: [],
									parents: [],
									artifacts: [],
									deletions: []
								}
							});
						} finally {
							remove.mockRestore();
						}
					});
				})
			)
	);

	it('preserves a newer artifact generation, auxiliary metadata and shared charge', () =>
		withoutAlarmArming(() =>
			runInDurableObject(currentServer(), async (instance) => {
				const context = instance.context;
				await context.criticalSection(async () => {
					const artifact = await retireArtifact(context);
					const newer = artifactGenerationSchema.parse(2);
					context.db
						.update(schema.artifacts)
						.set({
							generation: newer,
							state: 'pending',
							kind: 'build-log',
							expiresAt: isoTimestamp(new Date('2026-02-01T00:00:00.000Z'))
						})
						.where(eq(schema.artifacts.id, id))
						.run();
					await new ArtifactCasService(context).reserveInSection(id, newer);
					context.db
						.update(schema.artifacts)
						.set({ state: 'live' })
						.where(eq(schema.artifacts.id, id))
						.run();
					context.db
						.insert(schema.buildLogs)
						.values({
							artifactId: id,
							cacheId: artifact.cache.id,
							derivation: storePathBasenameSchema.parse(
								`${'a'.repeat(32)}-app.drv`
							),
							sourceKind: 'local-stored',
							sourceDescription: '/nix/store',
							capturedAt: artifact.createdAt,
							completeness: 'complete',
							outcome: 'success'
						})
						.run();
					const before = await drainState(context);
					const result = await new ArtifactRetirementService(
						context
					).drainInSection();
					expect({ result, state: await drainState(context) }).toStrictEqual({
						result: {
							referencesRemoved: 1,
							entriesCompleted: 1,
							rowsRemoved: 1,
							pending: false
						},
						state: {
							...before,
							references: before.references.filter(
								(row) => row.artifactGeneration === newer
							),
							deletions: []
						}
					});
				});
			})
		));

	it('retries local cleanup without repeating shared deletion after an interrupted cleanup', () =>
		withoutAlarmArming(() =>
			runInDurableObject(currentServer(), async (instance) => {
				const context = instance.context;
				await context.criticalSection(async () => {
					await retireArtifact(context);
					context.ctx.storage.sql.exec(
						"CREATE TRIGGER stop_artifact_cleanup BEFORE DELETE ON artifact BEGIN SELECT RAISE(ABORT, 'cleanup interrupted'); END"
					);
					const remove = vi.spyOn(
						ArtifactCasService.prototype,
						'removeCapturedInSection'
					);
					try {
						const service = new ArtifactRetirementService(context);
						await expect(service.drainInSection()).rejects.toThrow(
							'cleanup interrupted'
						);
						context.ctx.storage.sql.exec('DROP TRIGGER stop_artifact_cleanup');
						const result = await service.drainInSection();
						expect({
							result,
							sharedRemovals: remove.mock.calls.length
						}).toStrictEqual({
							result: {
								referencesRemoved: 0,
								entriesCompleted: 1,
								rowsRemoved: 2,
								pending: false
							},
							sharedRemovals: 1
						});
					} finally {
						remove.mockRestore();
					}
				});
			})
		));

	it('preserves the retirement outbox when the dispatch cannot afford shared removal', () =>
		withoutAlarmArming(() =>
			runInDurableObject(currentServer(), async (instance) => {
				const context = instance.context;
				await context.criticalSection(async () => {
					await retireArtifact(context);
					const before = await drainState(context);
					const result = await withSubrequestSlice(
						() => new ArtifactRetirementService(context).drainInSection(),
						{ subrequests: 8, reserve: 1 }
					);
					expect({ result, state: await drainState(context) }).toStrictEqual({
						result: {
							referencesRemoved: 0,
							entriesCompleted: 0,
							rowsRemoved: 0,
							pending: true
						},
						state: before
					});
				});
			})
		));
});
