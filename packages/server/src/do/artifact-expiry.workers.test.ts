import { artifactGenerationSchema } from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
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
import type { ServerContext } from './context.ts';
import { MaintenanceEligibilityService } from './maintenance-eligibility-service.ts';

const version = { id, generation };

async function publish(
	context: ServerContext,
	kind: 'build-log' | 'build-trace',
	state: 'pending' | 'live' = 'live'
) {
	const artifact = await createArtifact(context, kind);
	await new ArtifactCasService(context).reserveInSection(id, generation);
	const expiresAt = isoTimestamp(new Date(Date.now() + 60_000));
	context.db
		.update(schema.artifacts)
		.set({
			state,
			completedAt: state === 'live' ? artifact.createdAt : undefined,
			expiresAt: kind === 'build-log' ? expiresAt : undefined
		})
		.where(eq(schema.artifacts.id, id))
		.run();
	return { ...artifact, expiresAt };
}

function localState(context: ServerContext) {
	return {
		artifacts: context.db
			.select()
			.from(schema.artifacts)
			.orderBy(schema.artifacts.id)
			.all(),
		roots: context.db
			.select()
			.from(schema.artifactRoots)
			.orderBy(schema.artifactRoots.artifactId, schema.artifactRoots.kind)
			.all()
			.map((row) => ({ ...row, expiresAt: row.expiresAt ?? undefined })),
		deletions: context.db
			.select()
			.from(schema.artifactReferenceDeletion)
			.orderBy(schema.artifactReferenceDeletion.artifactId)
			.all()
	};
}

describe('bounded artifact expiry', () => {
	beforeEach(async () => {
		await resetTestServer();
		await withoutAlarmArming(initialise);
		await recordTransition('native-artifact-storage', 'expanded');
		await recordTransition('native-artifact-publication', 'complete');
	});

	it.each(['pending', 'live'] as const)(
		'retires a %s log at its own deadline despite an independent cache-lifetime root',
		(state) =>
			withoutAlarmArming(() =>
				runInDurableObject(currentServer(), async (instance) => {
					const context = instance.context;
					await context.criticalSection(async () => {
						const artifact = await publish(context, 'build-log', state);
						const retention = new ArtifactRetentionService(context);
						retention.attachRootInSection(version, { kind: 'cache-lifetime' });
						const before = localState(context);
						expect({
							deadline: retention.nextExpiryAt(),
							sweep: retention.expireInSection()
						}).toStrictEqual({
							deadline: artifact.expiresAt,
							sweep: { rootsRemoved: 0, artifactsRetired: 0, pending: false }
						});
						vi.setSystemTime(new Date(artifact.expiresAt));
						expect({
							sweep: retention.expireInSection(),
							state: localState(context),
							deadline: retention.nextExpiryAt()
						}).toStrictEqual({
							sweep: { rootsRemoved: 0, artifactsRetired: 1, pending: false },
							state: {
								...before,
								artifacts: before.artifacts.map((row) => ({
									...row,
									state: 'retired'
								})),
								deletions: [
									{
										artifactId: id,
										artifactGeneration: generation,
										cacheId: artifact.cache.id,
										digest: artifact.digest,
										referenceRemoved: false,
										createdAt: artifact.expiresAt
									}
								]
							},
							deadline: undefined
						});
					});
				})
			)
	);

	it('selects the earliest artifact or root deadline', () =>
		withoutAlarmArming(() =>
			runInDurableObject(currentServer(), async (instance) => {
				const context = instance.context;
				await context.criticalSection(async () => {
					const artifact = await publish(context, 'build-log');
					const retention = new ArtifactRetentionService(context);
					const rootAt = isoTimestamp(new Date(Date.now() + 120_000));
					retention.attachRootInSection(version, {
						kind: 'expiry',
						expiresAt: rootAt
					});
					const earliestArtifact = retention.nextExpiryAt();
					const laterArtifactAt = isoTimestamp(new Date(Date.now() + 180_000));
					context.db
						.update(schema.artifacts)
						.set({ expiresAt: laterArtifactAt })
						.where(eq(schema.artifacts.id, id))
						.run();
					const earliestRoot = retention.nextExpiryAt();
					expect({ earliestArtifact, earliestRoot }).toStrictEqual({
						earliestArtifact: artifact.expiresAt,
						earliestRoot: rootAt
					});
				});
			})
		));

	it.each([false, true])(
		'removes an expired trace root while preserving another valid root (%s)',
		(hasOtherRoot) =>
			withoutAlarmArming(() =>
				runInDurableObject(currentServer(), async (instance) => {
					const context = instance.context;
					await context.criticalSection(async () => {
						const artifact = await publish(context, 'build-trace');
						const retention = new ArtifactRetentionService(context);
						retention.attachRootInSection(version, {
							kind: 'expiry',
							expiresAt: artifact.expiresAt
						});
						if (hasOtherRoot) {
							retention.attachRootInSection(version, {
								kind: 'cache-lifetime'
							});
						}
						vi.setSystemTime(new Date(artifact.expiresAt));
						expect({
							sweep: retention.expireInSection(),
							retained: retention.retainedInSection(version),
							roots: localState(context).roots,
							deadline: retention.nextExpiryAt()
						}).toStrictEqual({
							sweep: {
								rootsRemoved: 1,
								artifactsRetired: hasOtherRoot ? 0 : 1,
								pending: false
							},
							retained: hasOtherRoot,
							roots: hasOtherRoot
								? [
										{
											artifactId: id,
											artifactGeneration: generation,
											kind: 'cache-lifetime',
											expiresAt: undefined
										}
									]
								: [],
							deadline: undefined
						});
					});
				})
			)
	);

	it.each([0, 25_000])(
		'bounds expired log selection beside %s retired artifacts',
		(retired) =>
			withoutAlarmArming(() =>
				runInDurableObject(currentServer(), async (instance) => {
					const context = instance.context;
					await context.criticalSection(async () => {
						const artifact = await publish(context, 'build-log');
						context.ctx.storage.sql.exec(
							"WITH RECURSIVE numbered(value) AS (SELECT 2 UNION ALL SELECT value+1 FROM numbered WHERE value < 33) INSERT INTO artifact (id,cache_id,generation,kind,digest,publication_incarnation,state,expires_at,created_at,completed_at) SELECT printf('00000000-0000-4000-8000-%012d',value), ?, ?, 'build-log', ?, ?, 'live', ?, ?, ? FROM numbered",
							artifact.cache.id,
							generation,
							artifact.digest,
							artifact.incarnation,
							artifact.expiresAt,
							artifact.createdAt,
							artifact.createdAt
						);
						if (retired > 0) {
							context.ctx.storage.sql.exec(
								"WITH RECURSIVE numbered(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM numbered WHERE value < ?) INSERT INTO artifact (id,cache_id,generation,kind,digest,publication_incarnation,state,expires_at,created_at) SELECT printf('00000000-0000-4000-8001-%012d',value), ?, ?, 'build-log', ?, ?, 'retired', ?, ? FROM numbered",
								retired,
								artifact.cache.id,
								generation,
								artifact.digest,
								artifact.incarnation,
								artifact.createdAt,
								artifact.createdAt
							);
						}
						vi.setSystemTime(new Date(artifact.expiresAt));
						context.dbCost.recordOutstanding();
						const before = context.dbCost.rowsRead;
						const retention = new ArtifactRetentionService(context);
						expect(retention.expireInSection()).toStrictEqual({
							rootsRemoved: 0,
							artifactsRetired: 8,
							pending: true
						});
						context.dbCost.recordOutstanding();
						expect(context.dbCost.rowsRead - before).toBeLessThan(100);
						expect([
							retention.expireInSection(),
							retention.expireInSection(),
							retention.expireInSection(),
							retention.expireInSection()
						]).toStrictEqual([
							{ rootsRemoved: 0, artifactsRetired: 8, pending: true },
							{ rootsRemoved: 0, artifactsRetired: 8, pending: true },
							{ rootsRemoved: 0, artifactsRetired: 8, pending: true },
							{ rootsRemoved: 0, artifactsRetired: 1, pending: false }
						]);
					});
				})
			)
	);

	it.each([0, 25_000])(
		'bounds expired root selection beside %s permanent trace roots',
		(permanent) =>
			withoutAlarmArming(() =>
				runInDurableObject(currentServer(), async (instance) => {
					const context = instance.context;
					await context.criticalSection(async () => {
						const artifact = await publish(context, 'build-trace');
						context.ctx.storage.sql.exec(
							"WITH RECURSIVE numbered(value) AS (SELECT 2 UNION ALL SELECT value+1 FROM numbered WHERE value < 33) INSERT INTO artifact (id,cache_id,generation,kind,digest,publication_incarnation,state,created_at,completed_at) SELECT printf('00000000-0000-4000-8000-%012d',value), ?, ?, 'build-trace', ?, ?, 'live', ?, ? FROM numbered",
							artifact.cache.id,
							generation,
							artifact.digest,
							artifact.incarnation,
							artifact.createdAt,
							artifact.createdAt
						);
						context.ctx.storage.sql.exec(
							"INSERT INTO artifact_root (artifact_id,artifact_generation,kind,expires_at) SELECT id,generation,'expiry',? FROM artifact",
							artifact.expiresAt
						);
						if (permanent > 0) {
							context.ctx.storage.sql.exec(
								"WITH RECURSIVE numbered(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM numbered WHERE value < ?) INSERT INTO artifact (id,cache_id,generation,kind,digest,publication_incarnation,state,created_at,completed_at) SELECT printf('00000000-0000-4000-8001-%012d',value), ?, ?, 'build-trace', ?, ?, 'live', ?, ? FROM numbered",
								permanent,
								artifact.cache.id,
								generation,
								artifact.digest,
								artifact.incarnation,
								artifact.createdAt,
								artifact.createdAt
							);
							context.ctx.storage.sql.exec(
								"INSERT INTO artifact_root (artifact_id,artifact_generation,kind) SELECT id,generation,'cache-lifetime' FROM artifact WHERE id LIKE '00000000-0000-4000-8001-%'"
							);
						}
						vi.setSystemTime(new Date(artifact.expiresAt));
						context.dbCost.recordOutstanding();
						const before = context.dbCost.rowsRead;
						const retention = new ArtifactRetentionService(context);
						expect(retention.expireInSection()).toStrictEqual({
							rootsRemoved: 8,
							artifactsRetired: 8,
							pending: true
						});
						context.dbCost.recordOutstanding();
						expect(context.dbCost.rowsRead - before).toBeLessThan(200);
						expect([
							retention.expireInSection(),
							retention.expireInSection(),
							retention.expireInSection(),
							retention.expireInSection()
						]).toStrictEqual([
							{ rootsRemoved: 8, artifactsRetired: 8, pending: true },
							{ rootsRemoved: 8, artifactsRetired: 8, pending: true },
							{ rootsRemoved: 8, artifactsRetired: 8, pending: true },
							{ rootsRemoved: 1, artifactsRetired: 1, pending: false }
						]);
					});
				})
			)
	);

	it('removes a stale expired root without retiring the current artifact generation', () =>
		withoutAlarmArming(() =>
			runInDurableObject(currentServer(), async (instance) => {
				const context = instance.context;
				await context.criticalSection(async () => {
					const artifact = await publish(context, 'build-trace');
					const retention = new ArtifactRetentionService(context);
					retention.attachRootInSection(version, {
						kind: 'expiry',
						expiresAt: artifact.expiresAt
					});
					const nextGeneration = artifactGenerationSchema.parse(2);
					context.db
						.update(schema.artifacts)
						.set({ generation: nextGeneration })
						.where(eq(schema.artifacts.id, id))
						.run();
					retention.attachRootInSection(
						{ id, generation: nextGeneration },
						{ kind: 'cache-lifetime' }
					);
					const before = localState(context);
					vi.setSystemTime(new Date(artifact.expiresAt));
					expect({
						sweep: retention.expireInSection(),
						state: localState(context),
						retained: retention.retainedInSection({
							id,
							generation: nextGeneration
						})
					}).toStrictEqual({
						sweep: { rootsRemoved: 1, artifactsRetired: 0, pending: false },
						state: {
							...before,
							roots: before.roots.filter((root) => root.kind !== 'expiry')
						},
						retained: true
					});
				});
			})
		));

	it('rolls back expiry-root removal if retirement cannot persist its outbox', () =>
		withoutAlarmArming(() =>
			runInDurableObject(currentServer(), async (instance) => {
				const context = instance.context;
				await context.criticalSection(async () => {
					const artifact = await publish(context, 'build-trace');
					const retention = new ArtifactRetentionService(context);
					retention.attachRootInSection(version, {
						kind: 'expiry',
						expiresAt: artifact.expiresAt
					});
					vi.setSystemTime(new Date(artifact.expiresAt));
					const before = localState(context);
					context.ctx.storage.sql.exec(
						"CREATE TRIGGER refuse_expiry_retirement BEFORE INSERT ON artifact_reference_deletion BEGIN SELECT RAISE(ABORT, 'injected expiry failure'); END"
					);
					try {
						expect(() => retention.expireInSection()).toThrow(
							'injected expiry failure'
						);
						expect(localState(context)).toStrictEqual(before);
					} finally {
						context.ctx.storage.sql.exec(
							'DROP TRIGGER refuse_expiry_retirement'
						);
					}
				});
			})
		));

	it.each(['build-log', 'build-trace'] as const)(
		'projects the %s deadline and drains expiry through real alarm passes',
		(kind) =>
			withoutAlarmArming(async () => {
				const artifact = await runInDurableObject(
					currentServer(),
					async (instance) => {
						const context = instance.context;
						return context.criticalSection(async () => {
							const artifact = await publish(context, kind);
							const retention = new ArtifactRetentionService(context);
							retention.attachRootInSection(
								version,
								kind === 'build-log'
									? { kind: 'cache-lifetime' }
									: { kind: 'expiry', expiresAt: artifact.expiresAt }
							);
							await new MaintenanceEligibilityService(context).reconcile();
							const wake = await context.d1
								.select()
								.from(d1Schema.tenantMaintenanceEligibility)
								.where(
									eq(
										d1Schema.tenantMaintenanceEligibility.tenant,
										context.requireTenant()
									)
								)
								.get();
							expect(wake).toStrictEqual({
								tenant: context.requireTenant(),
								nextWakeAt: artifact.expiresAt,
								reconciledAt: artifact.createdAt
							});
							return artifact;
						});
					}
				);
				vi.setSystemTime(new Date(artifact.expiresAt));
				for (let pass = 0; pass < 40; pass += 1) {
					const isPending = await runInDurableObject(
						currentServer(),
						async (instance) => {
							await instance.alarm();
							return localState(instance.context).artifacts.length > 0;
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
						usage: shared.usage
					}).toStrictEqual({
						local: { artifacts: [], roots: [], deletions: [] },
						references: [],
						presence: [],
						usage: { ...shared.usage, casBytes: 0, casBlobs: 0 }
					});
				});
			})
	);
});
