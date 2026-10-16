import {
	narInfoGenerationSchema,
	storePathHashSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema.ts';
import {
	commitPath,
	currentServer,
	deletePath,
	initialise,
	recordTransition,
	resetTestServer,
	uploadMetadata,
	verifiableNar,
	withoutAlarmArming
} from '../test-support.ts';

import {
	artifactFixtureGeneration as generation,
	artifactFixtureId as id,
	createArtifact
} from './artifact.test-support.ts';
import { ArtifactCasService } from './artifact-cas-service.ts';
import { ArtifactRetentionService } from './artifact-retention-service.ts';
import type { ServerContext } from './context.ts';

const hash = storePathHashSchema.parse('a'.repeat(32));
const publicationGeneration = narInfoGenerationSchema.parse(0);

async function seedParents(context: ServerContext) {
	const artifact = await createArtifact(context, 'build-trace');
	context.db
		.update(schema.artifacts)
		.set({ state: 'live', completedAt: artifact.createdAt })
		.where(eq(schema.artifacts.id, id))
		.run();
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
		'INSERT INTO artifact_parent (artifact_id,artifact_generation,cache_id,store_path_hash,publication_generation) SELECT id,generation,cache_id,?,? FROM artifact',
		hash,
		publicationGeneration
	);
	return {
		cache: artifact.cache,
		storePathHash: hash,
		generation: publicationGeneration
	};
}

function parentState(context: ServerContext) {
	return {
		artifacts: context.db
			.select()
			.from(schema.artifacts)
			.orderBy(schema.artifacts.id)
			.all(),
		parents: context.db
			.select()
			.from(schema.artifactParents)
			.orderBy(schema.artifactParents.artifactId)
			.all(),
		deletions: context.db
			.select()
			.from(schema.artifactReferenceDeletion)
			.orderBy(schema.artifactReferenceDeletion.artifactId)
			.all()
	};
}

describe('captured publication parent retirement', () => {
	beforeEach(async () => {
		await resetTestServer();
		await withoutAlarmArming(initialise);
		await recordTransition('native-artifact-storage', 'expanded');
		await recordTransition('native-artifact-publication', 'complete');
	});

	it('removes at most 16 captured edges and keeps independently rooted artifacts alive', () =>
		withoutAlarmArming(() =>
			runInDurableObject(currentServer(), async (instance) => {
				const context = instance.context;
				await context.criticalSection(async () => {
					const parent = await seedParents(context);
					const retention = new ArtifactRetentionService(context);
					retention.attachRootInSection(
						{ id, generation },
						{ kind: 'cache-lifetime' }
					);
					const before = parentState(context);
					const result = retention.retirePublicationParentsInSection(parent);
					const retiring = before.artifacts.slice(1, 16);
					expect({ result, state: parentState(context) }).toStrictEqual({
						result: { edgesRemoved: 16, artifactsRetired: 15, pending: true },
						state: {
							artifacts: before.artifacts.map((row, index) =>
								index > 0 && index < 16 ? { ...row, state: 'retired' } : row
							),
							parents: before.parents.slice(16),
							deletions: retiring.map((row) => ({
								artifactId: row.id,
								artifactGeneration: row.generation,
								cacheId: row.cacheId,
								digest: row.digest,
								referenceRemoved: false,
								createdAt: row.createdAt
							}))
						}
					});
					expect({
						second: retention.retirePublicationParentsInSection(parent),
						third: retention.retirePublicationParentsInSection(parent),
						repeated: retention.retirePublicationParentsInSection(parent)
					}).toStrictEqual({
						second: { edgesRemoved: 16, artifactsRetired: 16, pending: true },
						third: { edgesRemoved: 1, artifactsRetired: 1, pending: false },
						repeated: { edgesRemoved: 0, artifactsRetired: 0, pending: false }
					});
				});
			})
		));

	it('preserves parent edges from a different publication generation', () =>
		withoutAlarmArming(() =>
			runInDurableObject(currentServer(), async (instance) => {
				const context = instance.context;
				await context.criticalSection(async () => {
					const parent = await seedParents(context);
					const before = parentState(context);
					const result = new ArtifactRetentionService(
						context
					).retirePublicationParentsInSection({
						...parent,
						generation: narInfoGenerationSchema.parse(1)
					});
					expect({ result, state: parentState(context) }).toStrictEqual({
						result: { edgesRemoved: 0, artifactsRetired: 0, pending: false },
						state: before
					});
				});
			})
		));

	it('rolls back captured edge removal if retirement cannot persist its outbox', () =>
		withoutAlarmArming(() =>
			runInDurableObject(currentServer(), async (instance) => {
				const context = instance.context;
				await context.criticalSection(async () => {
					const parent = await seedParents(context);
					context.ctx.storage.sql.exec(
						"CREATE TRIGGER reject_parent_retirement BEFORE INSERT ON artifact_reference_deletion BEGIN SELECT RAISE(ABORT, 'parent retirement interrupted'); END"
					);
					const before = parentState(context);
					expect(() =>
						new ArtifactRetentionService(
							context
						).retirePublicationParentsInSection(parent)
					).toThrow('parent retirement interrupted');
					expect(parentState(context)).toStrictEqual(before);
				});
			})
		));
	it('keeps a current publication attached until its deletion is queued', () =>
		withoutAlarmArming(() =>
			runInDurableObject(currentServer(), async (instance) => {
				const context = instance.context;
				await context.criticalSection(async () => {
					const parent = await seedParents(context);
					const nar = await verifiableNar('current-artifact-parent');
					const now = isoTimestamp(new Date());
					context.db
						.insert(schema.narInfos)
						.values({
							cacheId: parent.cache.id,
							storePathHash: hash,
							storePath: storePathSchema.parse(`/nix/store/${hash}-parent`),
							narHash: nar.narHash,
							narSize: nar.narSize,
							referencesJson: '[]',
							generation: publicationGeneration,
							createdAt: now
						})
						.run();
					const before = parentState(context);
					const retention = new ArtifactRetentionService(context);
					expect({
						result: retention.retirePublicationParentsInSection(parent),
						state: parentState(context)
					}).toStrictEqual({
						result: { edgesRemoved: 0, artifactsRetired: 0, pending: true },
						state: before
					});
					context.db
						.insert(schema.narInfoDeletions)
						.values({
							cacheId: parent.cache.id,
							storePathHash: hash,
							generation: publicationGeneration,
							narHash: nar.narHash,
							createdAt: now
						})
						.run();
					expect(
						retention.retirePublicationParentsInSection(parent)
					).toStrictEqual({
						edgesRemoved: 16,
						artifactsRetired: 16,
						pending: true
					});
				});
			})
		));
	it('keeps the NAR deletion queued until all derived-parent pages retire and alarms drain the artifacts', () =>
		withoutAlarmArming(async () => {
			const token = await initialise();
			const nar = await verifiableNar('paged-parent-retirement');
			await commitPath(
				token,
				uploadMetadata({
					storePathHash: hash,
					narHash: nar.narHash,
					narSize: nar.narSize,
					fileHash: nar.fileHash,
					fileSize: nar.narBytes.byteLength
				}),
				nar
			);
			const initial = await runInDurableObject(
				currentServer(),
				async (instance) =>
					instance.context.criticalSection(async () => {
						await seedParents(instance.context);
						await new ArtifactCasService(instance.context).reserveInSection(
							id,
							generation
						);
						return parentState(instance.context);
					})
			);
			await deletePath(token, hash);
			await runInDurableObject(currentServer(), async (instance) => {
				const context = instance.context;
				const queued = context.db
					.select({
						hash: schema.narInfoDeletions.storePathHash,
						generation: schema.narInfoDeletions.generation
					})
					.from(schema.narInfoDeletions)
					.all();
				expect({ parents: parentState(context).parents, queued }).toStrictEqual(
					{
						parents: initial.parents.slice(16),
						queued: [{ hash, generation: publicationGeneration }]
					}
				);
				for (let turn = 0; turn < 40; turn += 1) {
					const pendingParent = context.db
						.select()
						.from(schema.narInfoDeletions)
						.limit(1)
						.get();
					const pendingArtifact = context.db
						.select()
						.from(schema.artifactReferenceDeletion)
						.limit(1)
						.get();
					if (pendingParent === undefined && pendingArtifact === undefined) {
						break;
					}
					await instance.alarm();
				}
				expect({
					local: parentState(context),
					queued: context.db.select().from(schema.narInfoDeletions).all()
				}).toStrictEqual({
					local: { artifacts: [], parents: [], deletions: [] },
					queued: []
				});
			});
		}));
});
