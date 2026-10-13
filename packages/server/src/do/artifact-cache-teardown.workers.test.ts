import {
	cacheGenerationSchema,
	cachePrioritySchema
} from '@cupboard/nix-store/scalars';
import { artifactIdSchema } from '@cupboard/protocol/artifacts';
import { runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema.ts';
import { requestOriginSchema } from '../http/http.ts';
import {
	currentServer,
	defaultCache,
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
import { CacheRegistrationService } from './cache-registration-service.ts';
import type { ServerContext } from './context.ts';

const origin = requestOriginSchema.parse('https://cache.example');

async function seedArtifacts(context: ServerContext) {
	const artifact = await createArtifact(context, 'build-trace');
	await new ArtifactCasService(context).reserveInSection(id, generation);
	context.ctx.storage.sql.exec(
		"WITH RECURSIVE numbered(value) AS (SELECT 2 UNION ALL SELECT value + 1 FROM numbered WHERE value < 33) INSERT INTO artifact (id,cache_id,generation,kind,digest,publication_incarnation,state,created_at,completed_at) SELECT printf('00000000-0000-4000-8000-%012d',value), ?, ?, 'build-trace', ?, ?, 'live', ?, ? FROM numbered",
		artifact.cache.id,
		generation,
		artifact.digest,
		artifact.incarnation,
		artifact.createdAt,
		artifact.createdAt
	);
	context.ctx.storage.sql.exec(
		"INSERT INTO artifact_root (artifact_id,artifact_generation,kind) SELECT id,generation,'cache-lifetime' FROM artifact"
	);
	return artifact;
}

function localState(context: ServerContext) {
	return {
		artifacts: context.db
			.select({ id: schema.artifacts.id, state: schema.artifacts.state })
			.from(schema.artifacts)
			.orderBy(schema.artifacts.state, schema.artifacts.id)
			.all(),
		deletions: context.db
			.select({ id: schema.artifactReferenceDeletion.artifactId })
			.from(schema.artifactReferenceDeletion)
			.orderBy(schema.artifactReferenceDeletion.artifactId)
			.all(),
		teardowns: context.db
			.select({ cacheId: schema.cacheTeardowns.cacheId })
			.from(schema.cacheTeardowns)
			.all()
	};
}

describe('artifact cache teardown', () => {
	beforeEach(async () => {
		await resetTestServer();
		await withoutAlarmArming(initialise);
		await recordTransition('native-artifact-storage', 'expanded');
	});

	it('retires pending and independently rooted live artifacts in pages and preserves teardown until drains complete', () =>
		withoutAlarmArming(async () => {
			const artifact = await runInDurableObject(currentServer(), (instance) =>
				instance.context.criticalSection(() => seedArtifacts(instance.context))
			);
			await currentServer().runCacheTeardown(defaultCache(), origin);
			await currentServer().resumeCacheTeardown();
			await runInDurableObject(currentServer(), (instance) => {
				const state = localState(instance.context);
				expect({
					retired: state.artifacts.filter((row) => row.state === 'retired')
						.length,
					remaining: state.artifacts.filter((row) => row.state !== 'retired')
						.length,
					deletions: state.deletions.length,
					teardowns: state.teardowns
				}).toStrictEqual({
					retired: 16,
					remaining: 17,
					deletions: 16,
					teardowns: [{ cacheId: artifact.cache.id }]
				});
			});
			for (let pass = 0; pass < 80; pass += 1) {
				const isPending = await runInDurableObject(
					currentServer(),
					async (instance) => {
						await instance.alarm();
						return localState(instance.context).teardowns.length > 0;
					}
				);
				if (!isPending) {
					break;
				}
			}
			await runInDurableObject(currentServer(), async (instance) => {
				const shared = await reservationState(instance.context);
				expect({
					local: localState(instance.context),
					references: shared.references,
					presence: shared.presence,
					usage: shared.usage,
					roots: instance.context.db.select().from(schema.artifactRoots).all()
				}).toStrictEqual({
					local: { artifacts: [], deletions: [], teardowns: [] },
					references: [],
					presence: [],
					usage: { ...shared.usage, casBytes: 0, casBlobs: 0 },
					roots: []
				});
			});
		}));

	it.each([0, 25_000])(
		'skips %s previously retired rows when selecting a bounded page',
		(retired) =>
			withoutAlarmArming(async () => {
				const artifact = await runInDurableObject(currentServer(), (instance) =>
					instance.context.criticalSection(() =>
						seedArtifacts(instance.context)
					)
				);
				await currentServer().runCacheTeardown(defaultCache(), origin);
				await runInDurableObject(currentServer(), (instance) => {
					const context = instance.context;
					if (retired > 0) {
						context.ctx.storage.sql.exec(
							"WITH RECURSIVE numbered(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM numbered WHERE value < ?) INSERT INTO artifact (id,cache_id,generation,kind,digest,publication_incarnation,state,created_at) SELECT printf('00000000-0000-4000-7000-%012d',value), ?, ?, 'build-trace', ?, ?, 'retired', ? FROM numbered",
							retired,
							artifact.cache.id,
							generation,
							artifact.digest,
							artifact.incarnation,
							artifact.createdAt
						);
					}
					context.dbCost.recordOutstanding();
					const before = context.dbCost.rowsRead;
					expect(
						new ArtifactRetentionService(context).retireCacheInSection(
							artifact.cache
						)
					).toStrictEqual({ artifactsRetired: 16, pending: true });
					context.dbCost.recordOutstanding();
					expect(context.dbCost.rowsRead - before).toBeLessThan(200);
				});
			})
	);

	it('rolls back an entire retirement page when its outbox insert fails', () =>
		withoutAlarmArming(async () => {
			const artifact = await runInDurableObject(currentServer(), (instance) =>
				instance.context.criticalSection(() => seedArtifacts(instance.context))
			);
			await currentServer().runCacheTeardown(defaultCache(), origin);
			await runInDurableObject(currentServer(), (instance) => {
				const context = instance.context;
				const before = localState(context);
				context.ctx.storage.sql.exec(
					"CREATE TRIGGER refuse_artifact_retirement BEFORE INSERT ON artifact_reference_deletion BEGIN SELECT RAISE(ABORT, 'injected retirement failure'); END"
				);
				try {
					expect(() =>
						new ArtifactRetentionService(context).retireCacheInSection(
							artifact.cache
						)
					).toThrow('injected retirement failure');
					expect(localState(context)).toStrictEqual(before);
				} finally {
					context.ctx.storage.sql.exec(
						'DROP TRIGGER refuse_artifact_retirement'
					);
				}
			});
		}));

	it('refuses retirement for a live cache or a mismatched captured generation', () =>
		withoutAlarmArming(async () => {
			const artifact = await runInDurableObject(currentServer(), (instance) =>
				instance.context.criticalSection(() => seedArtifacts(instance.context))
			);
			await runInDurableObject(currentServer(), (instance) => {
				const context = instance.context;
				const before = localState(context);
				expect(
					new ArtifactRetentionService(context).retireCacheInSection(
						artifact.cache
					)
				).toStrictEqual({ artifactsRetired: 0, pending: true });
				expect(localState(context)).toStrictEqual(before);
			});
			await currentServer().runCacheTeardown(defaultCache(), origin);
			await runInDurableObject(currentServer(), (instance) => {
				const context = instance.context;
				const before = localState(context);
				expect(
					new ArtifactRetentionService(context).retireCacheInSection({
						...artifact.cache,
						generation: cacheGenerationSchema.parse(
							artifact.cache.generation + 1
						)
					})
				).toStrictEqual({ artifactsRetired: 0, pending: true });
				expect(localState(context)).toStrictEqual(before);
			});
		}));

	it('preserves a newly registered cache and its reference while the old identity drains', () =>
		withoutAlarmArming(async () => {
			const artifact = await runInDurableObject(currentServer(), (instance) =>
				instance.context.criticalSection(() => seedArtifacts(instance.context))
			);
			await currentServer().runCacheTeardown(defaultCache(), origin);
			await runInDurableObject(currentServer(), async (instance) => {
				const context = instance.context;
				await context.criticalSection(async () => {
					const fresh = await new CacheRegistrationService(
						context
					).createInSection(defaultCache(), {
						access: 'public',
						priority: cachePrioritySchema.parse(40)
					});
					const freshId = artifactIdSchema.parse(
						'ffffffff-ffff-4fff-8fff-ffffffffffff'
					);
					context.db
						.insert(schema.artifacts)
						.values({
							id: freshId,
							generation,
							cacheId: fresh.id,
							kind: 'build-trace',
							digest: artifact.digest,
							publicationIncarnation: artifact.incarnation,
							state: 'pending',
							createdAt: artifact.createdAt
						})
						.run();
					await new ArtifactCasService(context).reserveInSection(
						freshId,
						generation
					);
					context.db
						.update(schema.artifacts)
						.set({ state: 'live', completedAt: artifact.createdAt })
						.where(eq(schema.artifacts.id, freshId))
						.run();
					new ArtifactRetentionService(context).attachRootInSection(
						{ id: freshId, generation },
						{ kind: 'cache-lifetime' }
					);
				});
			});
			for (let pass = 0; pass < 80; pass += 1) {
				const isPending = await runInDurableObject(
					currentServer(),
					async (instance) => {
						await instance.alarm();
						return localState(instance.context).teardowns.length > 0;
					}
				);
				if (!isPending) {
					break;
				}
			}
			await runInDurableObject(currentServer(), async (instance) => {
				const shared = await reservationState(instance.context);
				expect({
					local: localState(instance.context),
					references: shared.references.map((row) => ({
						id: row.artifactId,
						generation: row.artifactGeneration
					})),
					usage: shared.usage
				}).toStrictEqual({
					local: {
						artifacts: [
							{ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', state: 'live' }
						],
						deletions: [],
						teardowns: []
					},
					references: [
						{ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', generation }
					],
					usage: { ...shared.usage, casBytes: artifact.size, casBlobs: 1 }
				});
			});
		}));
});
