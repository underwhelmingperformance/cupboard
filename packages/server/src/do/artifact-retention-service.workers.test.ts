import {
	narInfoGenerationSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { artifactGenerationSchema } from '@cupboard/protocol/artifacts';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../db/schema.ts';
import {
	commitPath,
	currentServer,
	defaultCache,
	deletePath,
	initialise,
	narInfoGeneration,
	recordTransition,
	resetTestServer,
	uploadMetadata,
	verifiableNar,
	withoutAlarmArming
} from '../test-support.ts';

import {
	artifactFixtureGeneration as generation,
	artifactFixtureId as id,
	createArtifact,
	reservationState
} from './artifact.test-support.ts';
import { ArtifactCasService } from './artifact-cas-service.ts';
import {
	type ArtifactPublicationParent,
	ArtifactRetentionService
} from './artifact-retention-service.ts';
import type { ServerContext } from './context.ts';

const version = { id, generation };

async function publishParent(
	token: string,
	character: string
): Promise<ArtifactPublicationParent> {
	const storePathHash = storePathHashSchema.parse(character.repeat(32));
	const nar = await verifiableNar(`artifact-parent-${character}`);
	await commitPath(
		token,
		uploadMetadata({
			storePathHash,
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		}),
		nar
	);
	const cache = await runInDurableObject(currentServer(), (instance) =>
		instance.context.cacheRepository.require(defaultCache())
	);
	return {
		cache,
		storePathHash,
		generation: narInfoGenerationSchema.parse(
			await narInfoGeneration(storePathHash)
		)
	};
}

async function publishArtifact(
	context: ServerContext,
	kind: 'listing' | 'build-log' | 'build-trace' = 'listing'
) {
	const artifact = await createArtifact(context, kind);
	await new ArtifactCasService(context).reserveInSection(id, generation);
	context.db
		.update(schema.artifacts)
		.set({ state: 'live', completedAt: artifact.createdAt })
		.where(eq(schema.artifacts.id, id))
		.run();
	return artifact;
}

function retentionState(context: ServerContext) {
	return {
		artifacts: context.db.select().from(schema.artifacts).all(),
		parents: context.db.select().from(schema.artifactParents).all(),
		roots: context.db.select().from(schema.artifactRoots).all(),
		deletions: context.db.select().from(schema.artifactReferenceDeletion).all()
	};
}

describe('directed artifact retention', () => {
	let token: string;
	beforeEach(async () => {
		await resetTestServer();
		token = await withoutAlarmArming(initialise);
		await recordTransition('native-artifact-storage', 'expanded');
		await recordTransition('native-artifact-publication', 'complete');
	});

	it('retains an artifact through either current parent without preventing parent deletion', () =>
		withoutAlarmArming(async () => {
			const first = await publishParent(token, 'a');
			const second = await publishParent(token, 'b');
			await runInDurableObject(currentServer(), async (instance) => {
				const context = instance.context;
				await context.criticalSection(async () => {
					await publishArtifact(context);
					const retention = new ArtifactRetentionService(context);
					expect({
						first: await retention.attachParentInSection(version, first),
						second: await retention.attachParentInSection(version, second),
						repeated: await retention.attachParentInSection(version, second),
						retained: retention.retainedInSection(version),
						retired: retention.retireUnretainedInSection(version)
					}).toStrictEqual({
						first: 'attached',
						second: 'attached',
						repeated: 'already-present',
						retained: true,
						retired: false
					});
				});
			});
			await deletePath(token, first.storePathHash);
			await runInDurableObject(currentServer(), (instance) => {
				const retention = new ArtifactRetentionService(instance.context);
				expect({
					retained: retention.retainedInSection(version),
					retired: retention.retireUnretainedInSection(version),
					narinfos: instance.context.db
						.select({ hash: schema.narInfos.storePathHash })
						.from(schema.narInfos)
						.all()
				}).toStrictEqual({
					retained: true,
					retired: false,
					narinfos: [{ hash: second.storePathHash }]
				});
			});
			await deletePath(token, second.storePathHash);
			await runInDurableObject(currentServer(), (instance) => {
				const context = instance.context;
				const retention = new ArtifactRetentionService(context);
				const before = retentionState(context);
				const isRetired = retention.retireUnretainedInSection(version);
				expect({
					retired: isRetired,
					state: retentionState(context),
					narinfos: context.db.select().from(schema.narInfos).all()
				}).toStrictEqual({
					retired: false,
					state: {
						...before,
						artifacts: before.artifacts.map((row) => ({
							...row,
							state: 'retired'
						})),
						deletions: before.artifacts.map((row) => ({
							artifactId: row.id,
							artifactGeneration: row.generation,
							cacheId: row.cacheId,
							digest: row.digest,
							referenceRemoved: false,
							createdAt: isoTimestamp(new Date())
						}))
					},
					narinfos: []
				});
			});
		}));

	it('keeps a trace through an independent cache-lifetime root after its parent disappears', () =>
		withoutAlarmArming(async () => {
			const parent = await publishParent(token, 'a');
			await runInDurableObject(currentServer(), async (instance) => {
				const context = instance.context;
				await context.criticalSection(async () => {
					await publishArtifact(context, 'build-trace');
					const retention = new ArtifactRetentionService(context);
					await retention.attachParentInSection(version, parent);
					expect({
						added: retention.attachRootInSection(version, {
							kind: 'cache-lifetime'
						}),
						repeated: retention.attachRootInSection(version, {
							kind: 'cache-lifetime'
						})
					}).toStrictEqual({ added: 'attached', repeated: 'already-present' });
				});
			});
			await deletePath(token, parent.storePathHash);
			await runInDurableObject(currentServer(), (instance) => {
				const retention = new ArtifactRetentionService(instance.context);
				expect({
					retained: retention.retainedInSection(version),
					retired: retention.retireUnretainedInSection(version)
				}).toStrictEqual({ retained: true, retired: false });
				const isRemoved = retention.removeRootInSection(
					version,
					'cache-lifetime'
				);
				expect({
					removed: isRemoved,
					retained: retention.retainedInSection(version),
					retired: retention.retireUnretainedInSection(version)
				}).toStrictEqual({ removed: true, retained: false, retired: true });
			});
		}));

	it('expires a log despite its current parent and an expiry root with a later deadline', () =>
		withoutAlarmArming(async () => {
			const parent = await publishParent(token, 'a');
			await runInDurableObject(currentServer(), async (instance) => {
				const context = instance.context;
				await context.criticalSection(async () => {
					await publishArtifact(context, 'build-log');
					const retention = new ArtifactRetentionService(context);
					await retention.attachParentInSection(version, parent);
					retention.attachRootInSection(version, {
						kind: 'expiry',
						expiresAt: isoTimestamp(new Date('2026-03-01T00:00:00.000Z'))
					});
					vi.setSystemTime(new Date('2026-02-01T00:00:00.000Z'));
					expect({
						retained: retention.retainedInSection(version),
						retired: retention.retireUnretainedInSection(version)
					}).toStrictEqual({ retained: false, retired: true });
				});
			});
		}));

	it.each(['artifact-generation', 'publication-generation'] as const)(
		'refuses a stale %s parent association',
		(stale) =>
			withoutAlarmArming(async () => {
				const parent = await publishParent(token, 'a');
				await runInDurableObject(currentServer(), async (instance) => {
					const context = instance.context;
					await context.criticalSection(async () => {
						await publishArtifact(context);
						const captured =
							stale === 'artifact-generation'
								? { id, generation: artifactGenerationSchema.parse(2) }
								: version;
						const publication =
							stale === 'publication-generation'
								? {
										...parent,
										generation: narInfoGenerationSchema.parse(
											parent.generation + 1
										)
									}
								: parent;
						const before = retentionState(context);
						const outcome = await new ArtifactRetentionService(
							context
						).attachParentInSection(captured, publication);
						expect({ outcome, state: retentionState(context) }).toStrictEqual({
							outcome: 'unavailable',
							state: before
						});
					});
				});
			})
	);

	it('rolls back local retirement when the durable reference-deletion record cannot be written', () =>
		withoutAlarmArming(() =>
			runInDurableObject(currentServer(), async (instance) => {
				const context = instance.context;
				await context.criticalSection(async () => {
					await publishArtifact(context);
					context.ctx.storage.sql.exec(
						"CREATE TRIGGER reject_artifact_outbox BEFORE INSERT ON artifact_reference_deletion BEGIN SELECT RAISE(ABORT, 'artifact outbox failed'); END"
					);
					const before = retentionState(context);
					expect(() =>
						new ArtifactRetentionService(context).retireUnretainedInSection(
							version
						)
					).toThrow('artifact outbox failed');
					expect(retentionState(context)).toStrictEqual(before);
				});
			})
		));
	it('retires the final parent through NAR deletion and drains the artifact through an alarm', () =>
		withoutAlarmArming(async () => {
			const parent = await publishParent(token, 'a');
			const initial = await runInDurableObject(
				currentServer(),
				async (instance) =>
					instance.context.criticalSection(async () => {
						await publishArtifact(instance.context);
						await new ArtifactRetentionService(
							instance.context
						).attachParentInSection(version, parent);
						return retentionState(instance.context);
					})
			);
			await deletePath(token, parent.storePathHash);
			await runInDurableObject(currentServer(), async (instance) => {
				const context = instance.context;
				expect(retentionState(context)).toStrictEqual({
					...initial,
					artifacts: initial.artifacts.map((row) => ({
						...row,
						state: 'retired'
					})),
					parents: [],
					deletions: initial.artifacts.map((row) => ({
						artifactId: row.id,
						artifactGeneration: row.generation,
						cacheId: row.cacheId,
						digest: row.digest,
						referenceRemoved: false,
						createdAt: isoTimestamp(new Date())
					}))
				});
				const beforeDrain = await reservationState(context);
				for (let turn = 0; turn < 20; turn += 1) {
					if (
						context.db
							.select()
							.from(schema.artifactReferenceDeletion)
							.limit(1)
							.get() === undefined
					) {
						break;
					}
					await instance.alarm();
				}
				expect({
					local: retentionState(context),
					shared: await reservationState(context)
				}).toStrictEqual({
					local: { artifacts: [], parents: [], roots: [], deletions: [] },
					shared: {
						...beforeDrain,
						usage: { ...beforeDrain.usage, casBytes: 0, casBlobs: 0 },
						presence: [],
						references: []
					}
				});
			});
		}));
});
